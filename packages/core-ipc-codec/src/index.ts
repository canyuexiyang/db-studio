/**
 * 列式 IPC 编解码（TECH-REVIEW §2.2 / Spike S5 修正后的正确论证）
 *
 * 为什么要列式 —— 理由必须是下面这几条，不是"省体积"：
 *  - S5 实测：PRD 规模（LIMIT 3000）下，列式【体积并不更小】（0.477 vs 0.443MB），
 *    【编码反而比 JSON 慢 3~5 倍】（4.15 vs 0.70ms）。
 *  - 真正的价值是：① **只解可视区** —— 解码耗时恒定（~0.029ms），与结果集大小无关；
 *    而 JSON 全量解析 50 万行要 338ms，会直接吃掉"首行渲染 ≤500ms"的预算。
 *    ② 渲染端内存有界（TypedArray，不是几十万个 JS 对象）。
 *    ③ 大结果集可扩展。
 *
 * 因此本模块的核心 API 是 `decodeCell` / `decodeRowRange`（按需解码），
 * 而不是 `decodeAll`。decodeAll 只在导出等必须全量的场景使用。
 */

// ---------- 类型码 ----------

export const TypeCode = {
  /** 整列全为 NULL：不占数据 buffer */
  NULL: 0,
  /** Float64：整型、浮点、DECIMAL 转数值后的场景 */
  F64: 1,
  /** 布尔 */
  BOOL: 2,
  /** UTF-8 字符串（含 BIGINT 原文、DATETIME(6) 原文、JSON 原文） */
  STR: 3,
  /** 二进制（BLOB） */
  BIN: 4,
  /** 日期：存 epoch 毫秒（Float64） */
  DATE: 5,
} as const;

export type TypeCodeValue = (typeof TypeCode)[keyof typeof TypeCode];

export function typeCodeName(code: number): string {
  const entry = Object.entries(TypeCode).find(([, v]) => v === code);
  return entry ? entry[0] : `UNKNOWN(${code})`;
}

export interface ColumnDescriptor {
  name: string;
  typeCode: number;
  /**
   * V15：列的来源表名（JOIN 结果里标记这一列来自哪张表）。
   *
   * 可选且默认 undefined —— 聚合列/常量列/表达式列没有来源表。
   * 编码侧只做透传（`{...f}`），不参与任何 buffer 布局，
   * 所以加了它不会破坏既有载荷的二进制兼容性。
   */
  sourceTable?: string | null;
}

/**
 * 列式载荷。buffers 按列顺序展开，每列占用数量由 bufferCounts 决定：
 *  - NULL: 0 个
 *  - F64 / BOOL / DATE: [nullMask(Uint8), values]
 *  - STR / BIN: [nullMask(Uint8), offsets(Uint32, rowCount+1), bytes(Uint8)]
 */
export interface ColumnarPayload {
  rowCount: number;
  columns: ColumnDescriptor[];
  buffers: ArrayBuffer[];
  bufferCounts: number[];
}

export type CellValue = null | number | boolean | string | Uint8Array | Date;

// ---------- 编码 ----------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function isBinary(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v));
}

/** 判定一列的类型码：扫描全列，取"能容纳所有值"的最窄类型 */
export function inferTypeCode(values: unknown[]): number {
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') seen |= 1;
    else if (typeof v === 'boolean') seen |= 2;
    else if (typeof v === 'string') seen |= 4;
    else if (v instanceof Date) seen |= 8;
    else if (isBinary(v)) seen |= 16;
    else seen |= 4; // 兜底当字符串（String(v)）
  }

  if (seen === 0) return TypeCode.NULL;
  // 单一类型
  if (seen === 1) return TypeCode.F64;
  if (seen === 2) return TypeCode.BOOL;
  if (seen === 4) return TypeCode.STR;
  if (seen === 8) return TypeCode.DATE;
  if (seen === 16) return TypeCode.BIN;
  // 混合：数字+布尔 → F64；其余混合一律降级为字符串（保真优先）
  if ((seen & ~3) === 0) return TypeCode.F64;
  return TypeCode.STR;
}

function pushBuffer(out: ArrayBuffer[], counts: number[], view: ArrayBufferView): void {
  // 只 transfer 视图背后那一段，避免把整个池子拷过去。
  // slice 返回 ArrayBufferLike（可能是 SharedArrayBuffer），这里显式收窄 ——
  // 我们的视图一律建在普通 ArrayBuffer 上，SharedArrayBuffer 不会出现。
  const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  out.push(buf as ArrayBuffer);
  counts[counts.length - 1] += 1;
}

/**
 * mysql2 字段类型码 → 我们该用什么语义呈现。
 *
 * ⚠️ 真库实测（2026-09-21，e2e 冒烟暴露）：R10 开了
 * `supportBigNumbers + bigNumberStrings` 后，mysql2 会把 **LONGLONG 列的
 * 所有值都以字符串返回**，连普通 INT 也是 "1" 而不是 1。
 * 这是"不丢 BIGINT 精度"的必然代价 —— 驱动无法在字符串化之前区分
 * 该列是否是真正的 BIGINT（协议只给字段类型码，不给列定义）。
 *
 * 后果：网格拿到的原始值几乎全是字符串。因此
 *  ① 排序必须服务端执行（PRD §6.3.3 本就如此要求，这不是巧合）；
 *  ② 需要数值语义的列，必须由**调用方**按列定义的 dataType 显式指定
 *     （见 encodeColumnar 的 columnTypes 参数），本模块不猜。
 */
export const MYSQL_FIELD_TYPE = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

/**
 * 按列定义的 dataType（如 "bigint unsigned" / "decimal(12,2)"）判断数值语义。
 * 这是【唯一可靠】的判据 —— 别拿运行时值的 typeof 猜。
 */
export function isNumericDataType(dataType: string): boolean {
  const base = String(dataType ?? '')
    .replace(/\(.*\)\s*(unsigned)?/i, '')
    .replace(/\s+unsigned/i, '')
    .trim()
    .toLowerCase();
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)$/.test(base);
}

/** 字符串值能否无损转成数值（BIGINT 超 2^53 时不该转，会丢精度） */
export function safeToNumber(v: string): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // 原文很长或含非规范写法时，转回字符串不一致 → 说明转数值会丢信息
  if (String(n) !== v) return null;
  return n;
}

/**
 * 把 rowsAsArray 的二维结果编码成列式载荷。
 *
 * @param rows 二维数组（mysql2 rowsAsArray:true）
 * @param fields 列名（顺序与 rows[i] 对齐）
 * @param columnTypes 可选：每列的列定义 dataType 或强制类型码。
 *   传入 "bigint unsigned" 之类的 dataType 时，数值列会被还原为 F64（若能无损转换）；
 *   不传则按运行时 JS 类型推断（在 R10 下几乎全是字符串 → STR）。
 *   ⚠️ 想让网格拿到真正的数值列，必须传这个参数。
 */
export function encodeColumnar(
  rows: unknown[][],
  fields: ColumnDescriptor[] | string[],
  columnTypes?: (string | undefined)[],
): ColumnarPayload {
  const rowCount = rows.length;
  const columns: ColumnDescriptor[] = fields.map((f) =>
    typeof f === 'string' ? { name: f, typeCode: TypeCode.NULL } : { ...f, typeCode: TypeCode.NULL },
  );
  const buffers: ArrayBuffer[] = [];
  const bufferCounts: number[] = [];

  for (let c = 0; c < columns.length; c++) {
    bufferCounts.push(0);
    const col: unknown[] = new Array(rowCount);
    for (let r = 0; r < rowCount; r++) col[r] = rows[r]?.[c] ?? null;

    // 列定义为数值类型时，把 R10 字符串化的数值还原成真正的数值。
    // 但 BIGINT 超 2^53 的字符串（如 9007199254740993）必须保持字符串，
    // 转 Float64 会静默丢精度 —— 这正是 R10 存在的理由，别在这里毁掉它。
    const declared = columnTypes?.[c];
    if (declared && isNumericDataType(declared)) {
      col.forEach((v, i) => {
        if (typeof v === 'string' && v.trim() !== '') {
          const n = safeToNumber(v);
          if (n !== null) col[i] = n;
        }
      });
    }

    const typeCode = inferTypeCode(col);
    columns[c].typeCode = typeCode;

    if (typeCode === TypeCode.NULL) continue;

    // nullMask：1 表示该行为 NULL（与空字符串严格区分，PRD §6.3.4）
    const nullMask = new Uint8Array(rowCount);
    for (let r = 0; r < rowCount; r++) {
      nullMask[r] = col[r] === null || col[r] === undefined ? 1 : 0;
    }
    pushBuffer(buffers, bufferCounts, nullMask);

    switch (typeCode) {
      case TypeCode.F64:
      case TypeCode.DATE: {
        const vals = new Float64Array(rowCount);
        for (let r = 0; r < rowCount; r++) {
          const v = col[r];
          if (v === null || v === undefined) continue;
          vals[r] = typeCode === TypeCode.DATE ? (v as Date).getTime() : Number(v);
        }
        pushBuffer(buffers, bufferCounts, vals);
        break;
      }
      case TypeCode.BOOL: {
        const vals = new Uint8Array(rowCount);
        for (let r = 0; r < rowCount; r++) vals[r] = col[r] ? 1 : 0;
        pushBuffer(buffers, bufferCounts, vals);
        break;
      }
      case TypeCode.STR: {
        const offsets = new Uint32Array(rowCount + 1);
        const parts: Uint8Array[] = [];
        let off = 0;
        for (let r = 0; r < rowCount; r++) {
          offsets[r] = off;
          const v = col[r];
          if (v === null || v === undefined) continue;
          const bytes = encoder.encode(typeof v === 'string' ? v : String(v));
          parts.push(bytes);
          off += bytes.length;
          if (off > 0xffffffff) throw new Error('字符串列超过 4GB，无法用 Uint32 offset 表达');
        }
        offsets[rowCount] = off;

        const blob = new Uint8Array(off);
        let p = 0;
        for (const b of parts) {
          blob.set(b, p);
          p += b.length;
        }
        pushBuffer(buffers, bufferCounts, offsets);
        pushBuffer(buffers, bufferCounts, blob);
        break;
      }
      case TypeCode.BIN: {
        const offsets = new Uint32Array(rowCount + 1);
        const parts: Uint8Array[] = [];
        let off = 0;
        for (let r = 0; r < rowCount; r++) {
          offsets[r] = off;
          const v = col[r];
          if (v === null || v === undefined) continue;
          const bytes = isBinary(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : encoder.encode(String(v));
          parts.push(bytes);
          off += bytes.length;
          if (off > 0xffffffff) throw new Error('二进制列超过 4GB，无法用 Uint32 offset 表达');
        }
        offsets[rowCount] = off;

        const blob = new Uint8Array(off);
        let p = 0;
        for (const b of parts) {
          blob.set(b, p);
          p += b.length;
        }
        pushBuffer(buffers, bufferCounts, offsets);
        pushBuffer(buffers, bufferCounts, blob);
        break;
      }
    }
  }

  return { rowCount, columns, buffers, bufferCounts };
}

/** payload 的总字节数（诊断用） */
export function columnarByteLength(p: ColumnarPayload): number {
  return p.buffers.reduce((sum, b) => sum + b.byteLength, 0);
}

// ---------- 解码（核心：只解可视区） ----------

export interface DecodeStats {
  /** 已解码的单元格数 —— 用于验证"没有偷偷全量解码" */
  cellsDecoded: number;
  /** 创建的视图数 */
  viewsCreated: number;
}

/**
 * 列式读取器。持有 payload 但不展开它 —— 只在被调用时才解对应单元格。
 * 视图按列懒创建并缓存，因此滚动时的边际成本接近零。
 */
export class ColumnarReader {
  private readonly views = new Map<number, { nullMask?: Uint8Array; values?: Float64Array | Uint8Array; offsets?: Uint32Array; bytes?: Uint8Array }>();
  readonly stats: DecodeStats = { cellsDecoded: 0, viewsCreated: 0 };

  constructor(readonly payload: ColumnarPayload) {}

  get rowCount(): number {
    return this.payload.rowCount;
  }

  get columnCount(): number {
    return this.payload.columns.length;
  }

  columnName(c: number): string {
    return this.payload.columns[c]?.name ?? '';
  }

  typeCode(c: number): number {
    return this.payload.columns[c]?.typeCode ?? TypeCode.NULL;
  }

  private bufferIndexOfColumn(c: number): number {
    let idx = 0;
    for (let i = 0; i < c; i++) idx += this.payload.bufferCounts[i];
    return idx;
  }

  private viewsFor(c: number) {
    const cached = this.views.get(c);
    if (cached) return cached;

    const base = this.bufferIndexOfColumn(c);
    const typeCode = this.typeCode(c);
    const v: NonNullable<ReturnType<typeof this.views.get>> = {};

    if (typeCode !== TypeCode.NULL) {
      v.nullMask = new Uint8Array(this.payload.buffers[base]);
      this.stats.viewsCreated++;
    }
    if (typeCode === TypeCode.F64 || typeCode === TypeCode.DATE) {
      v.values = new Float64Array(this.payload.buffers[base + 1]);
      this.stats.viewsCreated++;
    } else if (typeCode === TypeCode.BOOL) {
      v.values = new Uint8Array(this.payload.buffers[base + 1]);
      this.stats.viewsCreated++;
    } else if (typeCode === TypeCode.STR || typeCode === TypeCode.BIN) {
      v.offsets = new Uint32Array(this.payload.buffers[base + 1]);
      v.bytes = new Uint8Array(this.payload.buffers[base + 2]);
      this.stats.viewsCreated += 2;
    }

    this.views.set(c, v);
    return v;
  }

  /** 该行该列是否为 NULL（不解码值，成本 O(1)） */
  isNull(r: number, c: number): boolean {
    if (r < 0 || r >= this.payload.rowCount) return true;
    const v = this.viewsFor(c);
    if (!v.nullMask) return true;
    return v.nullMask[r] === 1;
  }

  /** 解一个单元格 */
  decodeCell(r: number, c: number): CellValue {
    if (r < 0 || r >= this.payload.rowCount) return null;
    const v = this.viewsFor(c);
    if (v.nullMask && v.nullMask[r] === 1) {
      this.stats.cellsDecoded++;
      return null;
    }
    this.stats.cellsDecoded++;

    const typeCode = this.typeCode(c);
    switch (typeCode) {
      case TypeCode.NULL:
        return null;
      case TypeCode.F64:
        return (v.values as Float64Array)[r];
      case TypeCode.DATE:
        return new Date((v.values as Float64Array)[r]);
      case TypeCode.BOOL:
        return (v.values as Uint8Array)[r] === 1;
      case TypeCode.STR: {
        const off = v.offsets![r];
        const end = v.offsets![r + 1];
        return decoder.decode(v.bytes!.subarray(off, end));
      }
      case TypeCode.BIN: {
        const off = v.offsets![r];
        const end = v.offsets![r + 1];
        // 返回拷贝：避免调用方写坏共享内存
        return v.bytes!.slice(off, end);
      }
      default:
        return null;
    }
  }

  /** 解一行的若干列（默认全列） */
  decodeRow(r: number, cols?: number[]): CellValue[] {
    const targets = cols ?? Array.from({ length: this.columnCount }, (_, i) => i);
    return targets.map((c) => this.decodeCell(r, c));
  }

  /**
   * 解可视区：这是网格滚动时唯一该调用的方法。
   * 耗时与 start/end 的跨度成正比，与 rowCount 无关。
   */
  decodeRowRange(start: number, end: number, cols?: number[]): CellValue[][] {
    const from = Math.max(0, start);
    const to = Math.min(this.payload.rowCount, end);
    const out: CellValue[][] = new Array(Math.max(0, to - from));
    for (let r = from; r < to; r++) out[r - from] = this.decodeRow(r, cols);
    return out;
  }

  /** 导出等必须全量的场景才用它 */
  decodeAll(cols?: number[]): CellValue[][] {
    return this.decodeRowRange(0, this.payload.rowCount, cols);
  }
}

/**
 * 从列式载荷还原为二维数组（导出/写入器用）。
 * 注意：这会物化整个结果集，网格渲染路径不要调用。
 */
export function materialize(p: ColumnarPayload, cols?: number[]): CellValue[][] {
  return new ColumnarReader(p).decodeAll(cols);
}
