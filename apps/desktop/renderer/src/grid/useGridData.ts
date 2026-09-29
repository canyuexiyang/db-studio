/**
 * 网格数据源：列式载荷 + 脏单元格叠加层。
 *
 * 关键设计：**只解可视区**。滚动时调 `reader.decodeRowRange()`，
 * 而不是把整个结果集物化 —— 这是列式 IPC 的立身之本（S5 实测：
 * 3千→10万行，首屏解码 0.092→0.149ms 恒定；全量物化 46.7ms）。
 *
 * 本文件后半段的纯函数（V14/V15/V19/V22）刻意不依赖 React —— 它们要能被单测
 * 直接覆盖，渲染层只负责把结果拼进 className / 文案。
 */

import { useMemo, useRef } from 'react';
import {
  ColumnarReader,
  TypeCode,
  typeCodeName,
  type ColumnarPayload,
  type ColumnDescriptor,
  type CellValue,
} from '@dbstudio/core-ipc-codec';
import { loadState, shouldWarnLargeTable, LARGE_TABLE_THRESHOLD, DEFAULT_PAGE_SIZE } from '@dbstudio/core-grid-view';

export interface DirtyCell {
  value: string | null;
  invalid?: string;
  /**
   * V10：`sql-expr` 表示 value 是一段 SQL 表达式（NOW() / amount * 2），
   * 保存时原样嵌进 SET/VALUES 而不走 ? 参数绑定。缺省 = 字面量。
   *
   * 🔴 这个标记必须随脏单元格一路带到 core-mutation —— 它是「值该不该转义」
   *    的唯一依据，丢了就会把 `NOW()` 写成字符串 `'NOW()'`（功能静默失效）。
   */
  valueKind?: 'literal' | 'sql-expr';
}

/** 脏单元格键：`row:col` */
export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export class GridDataSource {
  readonly reader: ColumnarReader;
  private readonly dirty = new Map<string, DirtyCell>();
  private rowOffset = 0;

  constructor(payload: ColumnarPayload) {
    this.reader = new ColumnarReader(payload);
  }

  get rowCount(): number {
    return this.reader.rowCount;
  }

  get columnCount(): number {
    return this.reader.columnCount;
  }

  columnName(c: number): string {
    return this.reader.columnName(c);
  }

  /** 追加新行时的偏移（粘贴追加行后 rowCount 需要包含它们） */
  get extraRows(): number {
    return this.rowOffset;
  }

  setExtraRows(n: number): void {
    this.rowOffset = Math.max(0, Math.floor(n));
  }

  get totalRows(): number {
    return this.reader.rowCount + this.rowOffset;
  }

  /** 原始值（不含脏标记覆盖） */
  raw(row: number, col: number): CellValue {
    if (row >= this.reader.rowCount) return null;
    return this.reader.decodeCell(row, col);
  }

  /** 展示值：脏单元格优先 */
  value(row: number, col: number): CellValue {
    const d = this.dirty.get(cellKey(row, col));
    if (d) return d.value;
    return this.raw(row, col);
  }

  isDirty(row: number, col: number): boolean {
    return this.dirty.has(cellKey(row, col));
  }

  invalidReason(row: number, col: number): string | undefined {
    return this.dirty.get(cellKey(row, col))?.invalid;
  }

  setDirty(row: number, col: number, value: string | null, invalid?: string, valueKind?: 'literal' | 'sql-expr'): void {
    const cell: DirtyCell = invalid ? { value, invalid } : { value };
    // V10：只在确实是表达式时写 valueKind，字面量保持字段缺省（既有调用方零改动）
    if (valueKind === 'sql-expr') cell.valueKind = 'sql-expr';
    this.dirty.set(cellKey(row, col), cell);
  }

  /** V10：读取某格的值形态（缺省 literal） */
  valueKindOf(row: number, col: number): 'literal' | 'sql-expr' {
    return this.dirty.get(cellKey(row, col))?.valueKind ?? 'literal';
  }

  clearCell(row: number, col: number): void {
    this.dirty.delete(cellKey(row, col));
  }

  clearAll(): void {
    this.dirty.clear();
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** 脏单元格列表，供保存预演与构造 mutation */
  dirtyCells(): { row: number; col: number; column: string; value: string | null; invalid?: string; valueKind?: 'literal' | 'sql-expr' }[] {
    const out: { row: number; col: number; column: string; value: string | null; invalid?: string; valueKind?: 'literal' | 'sql-expr' }[] = [];
    for (const [k, v] of this.dirty) {
      const [r, c] = k.split(':').map(Number);
      const cell: { row: number; col: number; column: string; value: string | null; invalid?: string; valueKind?: 'literal' | 'sql-expr' } =
        { row: r, col: c, column: this.columnName(c), value: v.value, invalid: v.invalid };
      if (v.valueKind === 'sql-expr') cell.valueKind = 'sql-expr';
      out.push(cell);
    }
    return out.sort((a, b) => a.row - b.row || a.col - b.col);
  }

  /** 解可视区 —— 滚动时唯一该调用的方法 */
  decodeRange(start: number, end: number): CellValue[][] {
    const to = Math.min(end, this.reader.rowCount);
    if (to <= start) return [];
    return this.reader.decodeRowRange(start, to);
  }
}

/** 创建一次，payload 变化时重建 */
export function useGridDataSource(payload: ColumnarPayload | null): GridDataSource | null {
  const ref = useRef<GridDataSource | null>(null);
  return useMemo(() => {
    if (!payload) return null;
    ref.current = new GridDataSource(payload);
    return ref.current;
  }, [payload]);
}

// ---------- V14：列头「显示数据类型」开关（localStorage） ----------

/**
 * 存储键（版本号进键名，将来改语义可直接换键而不是迁移旧值）。
 *
 * 🔴 读写与 `prefs/preferences.ts` 同口径：**全部 try/catch 静默降级**。
 *    隐私模式 / 配额满 / 无 window（单测 node 环境）都只影响"下次启动的默认值"，
 *    不值得为它打断用户。
 */
export const SHOW_COLUMN_TYPES_KEY = 'dbstudio.grid.showColumnTypes.v1';

/** 读开关。**默认关** —— 类型文本会挤占列名空间，用户要才开 */
export function loadShowColumnTypes(): boolean {
  try {
    return window.localStorage.getItem(SHOW_COLUMN_TYPES_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写开关；写失败静默（只影响下次启动） */
export function saveShowColumnTypes(on: boolean): void {
  try {
    window.localStorage.setItem(SHOW_COLUMN_TYPES_KEY, on ? '1' : '0');
  } catch {
    // 静默降级
  }
}

/**
 * V14：列头要显示的类型文本。
 *
 * 取值优先级：
 *  ① 宿主给的 `dataType`（表标签来自 TableMeta.columns，形如 `varchar(255)`）；
 *  ② 没有则退回列式载荷的 `typeCode`（查询结果列只有类型码，没有 MySQL 精确类型）。
 * 两处都拿不到 → **null**（渲染层据此整个不渲染类型节点 —— 红线：不许显示 undefined）。
 */
export function columnTypeText(
  dataType: string | undefined | null,
  typeCode: number | null | undefined,
): string | null {
  if (typeof dataType === 'string' && dataType.trim() !== '') return dataType;
  return typeCodeLabel(typeCode);
}

/**
 * typeCode → 类型名。
 *
 * 名字直接取 core-ipc-codec 已有的 `typeCodeName`（0=NULL 1=F64 2=BOOL 3=STR
 * 4=BIN 5=DATE），**不另写一份映射** —— 两处并存必然漂移。
 *
 * 两种「拿不到」都返回 null（渲染层因此不显示，而不是显示 `UNKNOWN(7)` / `NULL`）：
 *  - 码不在表内：typeCodeName 会回 `UNKNOWN(<code>)`，那是诊断串不是给用户看的类型名；
 *  - typeCode = NULL(0)：载荷里它既表示「整列 NULL」也表示「没有类型信息」
 *    （主进程构造查询结果描述符时统一传 0），无脑显示会把每一列都贴上 NULL 标签。
 */
export function typeCodeLabel(code: number | null | undefined): string | null {
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  if (code === TypeCode.NULL) return null;
  const name = typeCodeName(code);
  return name.startsWith('UNKNOWN(') ? null : name;
}

// ---------- V15：JOIN 结果列的来源表名 ----------

/**
 * 归一化来源表名。null / undefined / 空串 / 纯空白一律归一为 null ——
 * 渲染层只判 null 一种空，不用在 JSX 里写三重判断（漏一处就会渲染出
 * 「来源表：undefined」这种比没有更糟的文案）。
 */
export function sourceTableOf(descriptor: ColumnDescriptor | null | undefined): string | null {
  const t = descriptor?.sourceTable;
  if (typeof t !== 'string') return null;
  const s = t.trim();
  return s === '' ? null : s;
}

/**
 * 把「列式载荷的列描述符」对齐到渲染层的列数组。
 *
 * 下标对齐是常态（两个宿主都是按 payload.columns 顺序建 GridColumn）；
 * 名字对不上（宿主按 schema 建列、或过滤/重排过）时按列名回找一次；
 * 仍然找不到 → null（降级：不显示类型也不显示来源表，绝不猜）。
 *
 * 只在列数级别跑（≤ 几百列）且被 useMemo 缓存，不在滚动热路径上。
 */
export function matchColumnDescriptor(
  names: readonly { name: string }[],
  payloadColumns: readonly ColumnDescriptor[],
  index: number,
): ColumnDescriptor | null {
  const want = names[index]?.name;
  if (want === undefined) return null;
  const direct = payloadColumns[index];
  if (direct && direct.name === want) return direct;
  for (let i = 0; i < payloadColumns.length; i++) {
    const d = payloadColumns[i];
    if (d && d.name === want) return d;
  }
  return null;
}

// ---------- V19：分组行条纹的取值 ----------

/**
 * 取整列的展示值（走 `source.value`，含脏单元格叠加层）。
 *
 * 🔴 只在「换分组列 / 换数据源 / 行数变化」时调用一次（调用方 useMemo），
 *    **绝不能放进滚动热路径** —— 它是 O(rowCount) 的全列解码。
 *    条纹表由 groupStripe.buildGroupStripes 预计算成 Uint8Array 后，
 *    行渲染就只剩一次下标读取（见 DataGrid 的 stripeClassAt 调用）。
 */
export function columnValues(source: GridDataSource, col: number): unknown[] {
  const n = source.totalRows;
  const out: unknown[] = new Array(n);
  for (let r = 0; r < n; r++) out[r] = source.value(r, col);
  return out;
}

// ---------- V22：加载更多 / 大表警告 ----------

export interface LoadMoreInput {
  /** 已加载行数 */
  loaded: number;
  /** 估算总行数（InnoDB 近似值）；null = 宿主没给 */
  estimated: number | null;
  /** 结果集被截断（宿主按 limit 截断 / 驱动层 truncated） */
  truncated?: boolean;
  /** 本次加载的行上限，缺省 DEFAULT_PAGE_SIZE（core-grid-view） */
  limit?: number;
}

export interface LoadMoreState {
  /** 提示条是否出现（有更多 或 命中大表警告二者之一） */
  visible: boolean;
  /** 是否还有更多（决定「加载更多」按钮是否渲染） */
  hasMore: boolean;
  /** 主文案：已加载 N 行，可能还有更多 */
  loadedText: string;
  /** 估算文案（null = 宿主没给估算值，不显示） */
  estimateText: string | null;
  /** 大表警告文案（null = 未命中阈值） */
  warnText: string | null;
}

function fmtRows(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * V22：底部提示条的全部文案与可见性。
 *
 * 数字口径完全交给 core-grid-view 的 `loadState` / `shouldWarnLargeTable`
 * （此前渲染层零引用，判定只有一处，不在这里重写一遍）。
 *
 * 「还有更多」的判定：
 *  - `truncated` 为真（宿主明确说截断了）→ 有；
 *  - 有估算值 → 已加载 < 估算（loadState.hasMore）；
 *  - 没有估算值 → 已加载 ≥ limit（默认 3000）：这一页是满的，只能假定还有。
 *    🔴 有估算值时**不能**用 limit 判，否则正好 3000 行的小表会永远提示"还有更多"。
 */
export function loadMoreState(input: LoadMoreInput): LoadMoreState {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const ls = loadState(input.loaded, input.estimated);
  const hasMore =
    input.truncated === true || (ls.estimated == null ? ls.loaded >= limit : ls.hasMore);
  const warn = shouldWarnLargeTable(ls.estimated);

  return {
    visible: hasMore || warn,
    hasMore,
    loadedText: `已加载 ${fmtRows(ls.loaded)} 行，可能还有更多`,
    estimateText: ls.estimated == null ? null : `约 ${fmtRows(ls.estimated)} 行（InnoDB 估算）`,
    warnText:
      warn && ls.estimated != null
        ? `该表约 ${fmtRows(ls.estimated)} 行，超过 ${fmtRows(LARGE_TABLE_THRESHOLD)} 行：加载更多会拉全表，可能很慢，建议先筛选`
        : null,
  };
}
