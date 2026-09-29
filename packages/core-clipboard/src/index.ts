/**
 * 网格剪贴板（PRD §6.3.6「网格与 Excel 互通」D2）
 *
 * 两件事：
 *  1. **复制**：选中区域 → TSV / CSV / JSON / INSERT / UPDATE 文本
 *  2. **粘贴**：剪贴板文本（Excel 的 TSV、Numbers/Excel 的 HTML table）→ 列对齐 + 类型校验 + 脏单元格计划
 *
 * 三条硬要求（都在这里落地，UI 只需执行结果）：
 *  - 列数超出剩余列 → **丢弃并提示**，绝不自动新增列
 *  - 超出行尾 → 追加新行，受 `maxRows` 上限保护（默认 1000）
 *  - 逐格类型校验：不合法的格子标红并给出原因，**不进入脏单元格**
 *
 * 值的处理分两条路，别混：
 *  - **粘贴进网格**：文本 → 脏单元格 → core-mutation 的 `?` 占位绑定（防注入）；
 *  - **复制为 SQL（INSERT/UPDATE）**：是**文本导出**，产物不回灌执行，必须带真实值
 *    才有用（DataGrip / TablePlus 口径）。标识符仍走 `quoteIdentifier`（红线 5），
 *    值字面量由 `sqlLiteral` 统一转义；BIGINT 原文（字符串形态）带引号导出，
 *    MySQL 端隐式转换回精确整数，不经过 Float64 —— 保真红线（红线 6）不破。
 */

import type { ColumnMeta, TableMeta } from '@dbstudio/core-schema-cache';
import { quoteIdentifier, quoteQualified } from '@dbstudio/core-sql-ident';

// ---------- 值 → 文本（复制侧） ----------

export type CellValue = null | undefined | string | number | boolean | Date | Uint8Array;

/** 单元格展示文本：NULL 与空串必须可区分（PRD §6.3.4） */
export function cellToDisplay(v: CellValue): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) return `(二进制 ${v.byteLength} B)`;
  return String(v);
}

/**
 * 值 → SQL 字面量（复制为 INSERT/UPDATE 用）。
 *
 * 规则：
 *  - NULL → `NULL`（与空串严格区分）
 *  - number → 原样（NaN/±Infinity 不是合法字面量，导出 NULL 并如实退化）
 *  - boolean → 1/0（MySQL 无独立布尔字面量）
 *  - string → 单引号包裹；转义 `'` `\` 换行 CR NUL Ctrl-Z。**不判断内容是否像数字**：
 *    BIGINT 原文以字符串形态到达（保精度），带引号导出后在 MySQL 端隐式转回精确值；
 *    反过来把「看起来像数字」的字符串不加引号才危险（注入面 + 非数字直接语法错）。
 *  - Date → 'YYYY-MM-DD HH:MM:SS.mmm'（与 cellToDisplay 同为 toISOString 口径）
 *  - Uint8Array → `X'hex'`（空二进制用 `_binary''` —— X'' 在 MySQL 是语法错误）
 */
export function sqlLiteral(v: CellValue): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return `'${iso.slice(0, 10)} ${iso.slice(11, 23)}'`;
  }
  if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) {
    if (v.byteLength === 0) return `_binary''`;
    let hex = '';
    for (const b of v) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  const s = String(v);
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\x1a/g, '\\Z');
  return `'${escaped}'`;
}

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'update';

export const COPY_FORMATS: readonly CopyFormat[] = ['tsv', 'csv', 'json', 'markdown', 'insert', 'update'];

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'TSV（可直接粘进 Excel）',
  csv: 'CSV',
  json: 'JSON 数组',
  markdown: 'Markdown 表格',
  insert: 'INSERT 语句',
  update: 'UPDATE 语句',
};

/** CSV/TSV 字段转义：含分隔符、引号、换行时加引号，内部引号翻倍 */
function escapeDelimited(s: string, delimiter: string): string {
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface CopyOptions {
  format: CopyFormat;
  /** 列名（顺序与每行数据一致） */
  columns: string[];
  /** 每行数据。行长度不足时按 NULL 补齐 */
  rows: CellValue[][];
  /** INSERT/UPDATE 需要 */
  database?: string;
  table?: string;
  /** UPDATE 的定位列（主键/唯一键） */
  locateColumns?: string[];
  /**
   * TSV/CSV 是否在首行输出列名表头。**默认 false**（2026-09-29 用户反馈）。
   *
   * 为什么默认关：复制的用途绝大多数是「把这几格的值带走」（粘进聊天窗、
   * 粘进另一张表、喂给脚本），带上列名会让粘贴结果整体错位一行 ——
   * 用户得手工删掉首行，比不给更麻烦。对齐 DataGrip 的 ⌘C 语义
   * （Copy → 值；Copy with Headers → 才是带表头的独立动作）。
   *
   * ⚠️ 只对 tsv/csv 生效。markdown **永远带表头**（少了表头与分隔行就不是
   * 合法 Markdown 表格，粘出去是散的文本）；json/insert/update 的列名是
   * 结构的一部分，无法省略。
   *
   * 与粘贴（⌘V）的往返关系：planPasteFromText 按纯值解析，本来就不认表头行，
   * 所以「复制 → 粘贴回网格」在默认口径下反而**更**正确（旧行为会把列名当成
   * 第一行数据粘进去，是一处真实的往返不一致）。
   */
  includeHeader?: boolean;
}

/**
 * Markdown 单元格转义：竖线转义 `\|`、换行转 `<br>`。
 *
 * 与 core-export 的 toMarkdownTable（E1）行为一致但【各自独立实现、互不 import】——
 * core-clipboard 不依赖 core-export（避免把导出链路拖进渲染层依赖图）。
 * 改转义规则必须两处同步（见 core-export 注释）。
 */
function markdownEscapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

/** 供 UI 直接判断某格式能否构造语句（INSERT/UPDATE 需要表名限定） */
export function formatNeedsTableContext(f: CopyFormat): boolean {
  return f === 'insert' || f === 'update';
}

export function serializeCopy(o: CopyOptions): string {
  const cols = o.columns ?? [];
  const rows = o.rows ?? [];
  const norm = rows.map((r) => {
    const out: CellValue[] = new Array(cols.length);
    for (let i = 0; i < cols.length; i++) out[i] = i < r.length ? r[i] : null;
    return out;
  });

  switch (o.format) {
    case 'tsv':
    case 'csv': {
      const d = o.format === 'tsv' ? '\t' : ',';
      /**
       * 默认不带表头（见 CopyOptions.includeHeader 的取舍说明）。
       * 首行直接是数据 —— 复制出去粘进 Excel/聊天窗就是纯值。
       */
      const lines: string[] = [];
      if (o.includeHeader === true) {
        lines.push(cols.map((c) => escapeDelimited(c, d)).join(d));
      }
      for (const r of norm) lines.push(r.map((v) => escapeDelimited(cellToDisplay(v), d)).join(d));
      return lines.join('\n');
    }
    case 'json': {
      const objs = norm.map((r) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((c, i) => {
          const v = r[i];
          obj[c] = v instanceof Date ? v.toISOString() : (v ?? null);
        });
        return obj;
      });
      return JSON.stringify(objs, null, 2);
    }
    case 'markdown': {
      // 与 core-export 的 toMarkdownTable（E1）同一套规则：表头 + `| --- |` 分隔行 + 值行，
      // 竖线转义 \|、换行转 <br>。差异：二进制显示为长度摘要（toMarkdownTable 的
      // String(Uint8Array) 会产出逗号数字垃圾，这里沿用 cellToDisplay 的摘要语义）。
      const lines = [`| ${cols.map((c) => markdownEscapeCell(c)).join(' | ')} |`];
      lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
      for (const r of norm) {
        const parts = r.map((v) => {
          if (v === null || v === undefined) return '\\N';
          if (v instanceof Date) return markdownEscapeCell(v.toISOString());
          return markdownEscapeCell(cellToDisplay(v));
        });
        lines.push(`| ${parts.join(' | ')} |`);
      }
      return lines.join('\n');
    }
    case 'insert': {
      // INSERT/UPDATE 是带限定名的语句：缺表名时返回空串而不是抛
      // IdentifierError —— 网格复制在拿不到表上下文时静默降级为不可复制
      if (!o.table) return '';
      const qualified = quoteQualified(o.database ? [o.database, o.table] : [o.table]);
      const colList = cols.map(quoteIdentifier).join(', ');
      const stmts = norm.map((r) => `INSERT INTO ${qualified} (${colList}) VALUES (${r.map(sqlLiteral).join(', ')});`);
      return stmts.join('\n');
    }
    case 'update': {
      if (!o.table) return ''; // 同 insert：缺表名不抛错，返回空串
      const qualified = quoteQualified(o.database ? [o.database, o.table] : [o.table]);
      const locate = o.locateColumns ?? [];
      const locateSet = new Set(locate);
      const setCols = cols.filter((c) => !locateSet.has(c));
      if (locate.length === 0 || setCols.length === 0) return '';
      // 定位列必须出现在本次复制范围内，否则该行构造不出 WHERE —— 整批拒绝
      //（宁可不产出，也不产出「WHERE 少一半」的半截 UPDATE 误导用户）
      const locateIdx = locate.map((c) => cols.indexOf(c));
      if (locateIdx.some((i) => i < 0)) return '';
      const stmts = norm.map((r) => {
        const set = setCols
          .map((c) => `${quoteIdentifier(c)} = ${sqlLiteral(r[cols.indexOf(c)])}`)
          .join(', ');
        const where = locateIdx
          .map((i, k) => `${quoteIdentifier(locate[k])} = ${sqlLiteral(r[i])}`)
          .join(' AND ');
        return `UPDATE ${qualified} SET ${set} WHERE ${where};`;
      });
      return stmts.join('\n');
    }
  }
}

// ---------- 选中区 → 行（⌘C 复制的数据源，A17） ----------

/**
 * ⌘C 单次复制的单元格上限。防失控：超大选区（⌘A 十万行）全量解码会
 * 卡住渲染进程 —— 超出部分截断并在结果里如实标记。
 */
export const COPY_CELL_LIMIT = 20_000;

/** core-grid-view SelectionModel.ranges 的形状（刻意不用 import，保持本包无交叉依赖） */
export interface SelectionRangeLike {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface SelectionRowsInput {
  /** 选区快照（通常直接传 SelectionModel.ranges） */
  ranges: readonly SelectionRangeLike[];
  /** 无选区时退化为复制这一行 */
  focusRow: number;
  /**
   * 行号列勾选的行（升序）。非空时**优先于 ranges/focusRow** ——
   * 用户点了行号就是明确要「复制这几整行」，不该被残留的单元格选区劫持。
   */
  selectedRows?: readonly number[];
  /** 网格边界：钳制快照里的越界值（快照可能早于 resize） */
  rowCount: number;
  colCount: number;
  /**
   * 参与复制的列（原始下标、升序，通常 = 可见列）。隐藏列不该进剪贴板 ——
   * 用户看不见的数据复制出去会误导。
   */
  columnIndexes: readonly number[];
  /** 逐格取值（渲染层传 source.value，用户触发允许逐格解码） */
  valueAt: (row: number, col: number) => unknown;
}

export interface SelectionRowsResult {
  rows: CellValue[][];
  /** 实际复制的列（columnIndexes ∩ 选区列区间，升序），与 rows 每行对齐 */
  columnIndexes: number[];
  cells: number;
  /** 超上限被截断 */
  truncated: boolean;
}

/**
 * 把选中区解码为行列数据，供 serializeCopy 消费。
 *
 * 语义：多重选区（Cmd+点击叠加出多个 range）取**最近一次框选** ——
 * TSV/JSON/Markdown 都是矩形语义，跨块拼接会产出无法回贴的表格；
 * 这与 Excel「复制最后一块」的直觉一致。无选区时退化为复制聚焦行的
 * 全部参与列。
 */
export function rowsFromSelection(input: SelectionRowsInput, limit = COPY_CELL_LIMIT): SelectionRowsResult {
  const empty: SelectionRowsResult = { rows: [], columnIndexes: [], cells: 0, truncated: false };
  if (input.columnIndexes.length === 0) return empty;

  const cap = limit > 0 ? limit : Infinity;
  const allCols = input.columnIndexes;

  // 无选区 → 聚焦行 × 全部参与列
  let row0: number;
  let row1: number;
  let cols: number[];
  let rowSet: number[] | null = null;

  if (input.selectedRows && input.selectedRows.length > 0) {
    // 行勾选优先（见字段注释）：整行 × 全部参与列
    const seen = new Set<number>();
    const picked: number[] = [];
    for (const r of input.selectedRows) {
      const row = Math.floor(r);
      if (row >= 0 && row < input.rowCount && !seen.has(row)) {
        seen.add(row);
        picked.push(row);
      }
    }
    picked.sort((a, b) => a - b);
    if (picked.length === 0) return empty;
    rowSet = picked;
    cols = allCols.slice();
    row0 = picked[0];
    row1 = picked[picked.length - 1];
  } else if (input.ranges.length > 0) {
    const last = input.ranges[input.ranges.length - 1];
    const c0 = Math.min(last.c0, last.c1);
    const c1 = Math.min(Math.max(last.c0, last.c1), input.colCount - 1);
    cols = allCols.filter((c) => c >= c0 && c <= c1);
    if (cols.length === 0) return empty;
    row0 = Math.max(0, Math.min(last.r0, last.r1));
    row1 = Math.min(Math.max(last.r0, last.r1), input.rowCount - 1);
    if (row0 > row1) return empty;
  } else {
    if (input.rowCount <= 0) return empty; // 空网格没有聚焦行可复制
    cols = allCols.slice();
    row0 = Math.min(Math.max(input.focusRow, 0), Math.max(0, input.rowCount - 1));
    row1 = row0;
  }

  const rows: CellValue[][] = [];
  let cells = 0;
  let truncated = false;
  const emit = (r: number): boolean => {
    const row: CellValue[] = [];
    for (const c of cols) {
      if (cells >= cap) {
        truncated = true;
        return false;
      }
      row.push(input.valueAt(r, c) as CellValue);
      cells++;
    }
    rows.push(row);
    return true;
  };

  if (rowSet) {
    for (const r of rowSet) {
      if (!emit(r)) break;
    }
  } else {
    for (let r = row0; r <= row1; r++) {
      if (!emit(r)) break;
    }
  }
  return { rows, columnIndexes: cols, cells, truncated };
}

// ---------- 文本 → 表格（粘贴侧） ----------

/** 剪贴板可能来自 Excel / Numbers / 网页表格 / 纯文本编辑器 */
export type ClipboardSource = 'tsv' | 'csv' | 'html' | 'unknown';

export interface ParsedTable {
  /** 识别出的源格式 */
  source: ClipboardSource;
  /** 二维文本。每行长度以最宽行为准，不足处补空串 */
  rows: string[][];
  rowCount: number;
  colCount: number;
}

/**
 * 解析剪贴板文本。
 *
 * 优先级：HTML table > TSV > CSV。Excel/Numbers 同时提供 HTML 与 TSV，
 * HTML 能正确表达"单元格内含制表符/换行"，优先用它更稳。
 */
export function parseClipboard(text: string): ParsedTable {
  const html = tryParseHtmlTable(text);
  if (html) return html;

  const trimmed = (text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 末尾换行是复制时的常态，不产生空行
  const body = trimmed.replace(/\n+$/, '');
  if (!body) return { source: 'unknown', rows: [], rowCount: 0, colCount: 0 };

  const lines = body.split('\n');
  const tabScore = medianCount(lines, '\t');
  const commaScore = medianCount(lines, ',');

  // 判定顺序：有制表符 → 一定是 TSV；否则有逗号、或任一行以引号开头（CSV 转义特征）→ CSV。
  // ⚠️ 单行且既无逗号也无制表符的 CSV（如 `"a""b"`）只能靠"行首引号"识别出来，
  //    少了这一条会退化成 TSV，引号不会被还原。
  const quoted = lines.some((l) => l.startsWith('"'));
  const asCsv = tabScore === 0 && (commaScore > 0 || quoted);

  const rows = splitRows(body, asCsv);
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map((r) => {
    const out = r.slice();
    while (out.length < colCount) out.push('');
    return out;
  });

  return { source: asCsv ? 'csv' : 'tsv', rows: padded, rowCount: padded.length, colCount };
}

function medianCount(lines: string[], ch: string): number {
  const counts = lines.filter((l) => l.length > 0).map((l) => l.split(ch).length - 1);
  if (counts.length === 0) return 0;
  counts.sort((a, b) => a - b);
  return counts[Math.floor(counts.length / 2)];
}

/** CSV 需要按引号解析；TSV 直接切 */
function splitRows(body: string, asCsv: boolean): string[][] {
  if (!asCsv) return body.split('\n').map((l) => l.split('\t'));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < body.length) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

const TD_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

function tryParseHtmlTable(text: string): ParsedTable | null {
  if (!text || !/<t[dh]\b/i.test(text)) return null;
  const rows: string[][] = [];
  let m: RegExpExecArray | null;
  TR_RE.lastIndex = 0;
  while ((m = TR_RE.exec(text)) !== null) {
    const cells: string[] = [];
    let c: RegExpExecArray | null;
    TD_RE.lastIndex = 0;
    while ((c = TD_RE.exec(m[1])) !== null) cells.push(decodeHtmlEntities(c[1]));
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;

  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const padded = rows.map((r) => {
    const out = r.slice();
    while (out.length < colCount) out.push('');
    return out;
  });
  return { source: 'html', rows: padded, rowCount: padded.length, colCount };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
}

// ---------- 类型校验 ----------

export interface CellIssue {
  row: number;
  col: number;
  column: string;
  raw: string;
  reason: string;
}

/** 提取基础类型名：varchar(64) → varchar */
export function baseType(dataType: string): string {
  return (dataType ?? '').replace(/\(.*\)$/, '').trim().toLowerCase();
}

export function isNumericType(dataType: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)$/.test(baseType(dataType));
}

export function isIntegerType(dataType: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(baseType(dataType));
}

export function isTemporalType(dataType: string): boolean {
  return /^(date|datetime|timestamp|time|year)$/.test(baseType(dataType));
}

/** ENUM/SET 的候选值：enum('a','b') → ['a','b'] */
export function enumValues(dataType: string): string[] {
  const m = /^enum\((.*)\)$/i.exec((dataType ?? '').trim());
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

/** varchar(64) 的长度上限；无长度声明返回 null */
export function charMaxLength(dataType: string): number | null {
  const m = /\(([^)]+)\)/.exec(dataType ?? '');
  if (!m) return null;
  const n = Number(m[1].split(',')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

/**
 * 逐格类型校验。
 *
 * 设计取舍：**这里只判定"能不能写"，不负责把字符串转成强类型值** ——
 * 转录交给 core-mutation 的 normalizeValue，避免两处各转一次产生不一致。
 */
export function validateCellText(raw: string, col: ColumnMeta): string | null {
  const text = raw ?? '';
  const type = baseType(col.dataType);

  // 约定：字面量 NULL 表示写 NULL（Excel 里没法表达真正的 NULL）
  const isNullLiteral = text.trim().toUpperCase() === 'NULL' || text.trim() === '\\N';

  if (text === '') {
    if (isNullLiteral) return null;
    return col.nullable ? null : `列 ${col.name} 不允许为 NULL（NOT NULL），但值为空`;
  }
  if (isNullLiteral) {
    return col.nullable ? null : `列 ${col.name} 不允许为 NULL（NOT NULL）`;
  }

  if (isNumericType(col.dataType)) {
    if (!/^-?\d+(\.\d+)?$/.test(text.trim())) {
      return `列 ${col.name} 是 ${type}，但值 "${text}" 不是合法数值`;
    }
    if (isIntegerType(col.dataType) && /\./.test(text.trim())) {
      return `列 ${col.name} 是整数类型 ${type}，不接受小数 "${text}"`;
    }
    return null;
  }

  if (isTemporalType(col.dataType)) {
    // 允许 NOW()/CURRENT_TIMESTAMP 这类服务端函数
    if (/^(NOW\(\)|CURRENT_TIMESTAMP(?:\(\))?)$/i.test(text.trim())) return null;
    const m = DATETIME_RE.exec(text.trim());
    if (!m) return `列 ${col.name} 是 ${type}，但值 "${text}" 不是合法日期时间`;
    const [, y, mo, d, h, mi, s] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) {
      return `列 ${col.name} 的日期 "${text}" 不存在（如 2026-02-30）`;
    }
    return null;
  }

  if (type === 'enum') {
    const vals = enumValues(col.dataType);
    if (vals.length > 0 && !vals.includes(text)) {
      return `列 ${col.name} 是 ENUM，可选值：${vals.join(' / ')}`;
    }
    return null;
  }

  if (/^(char|varchar|text|tinytext|mediumtext|longtext)$/.test(type)) {
    const max = charMaxLength(col.dataType);
    // 字符数而非字节数：UI 提示按用户直觉走，服务端才是字节边界
    if (max != null && [...text].length > max) {
      return `列 ${col.name} 超长：${[...text].length} > ${max} 字符`;
    }
  }

  return null;
}

// ---------- 粘贴计划 ----------

/** 单次粘贴的行数上限（PRD §6.3.6） */
export const DEFAULT_MAX_PASTE_ROWS = 1000;

export interface PasteTarget {
  /** 起始单元格：粘贴从这一格开始按列对齐 */
  startRow: number;
  startCol: number;
  /** 当前已加载的行数（超出部分追加新行） */
  loadedRows: number;
  /** 列元数据，顺序 = 网格列顺序 */
  columns: ColumnMeta[];
  /** 表是否可编辑（无主键/唯一键 → false）。只读时整个粘贴被拒 */
  editable: boolean;
}

export interface PasteCell {
  /** 目标行（>= loadedRows 的行是追加的新行） */
  row: number;
  col: number;
  column: string;
  /** 写入值：NULL 字面量为 null，其余为原文字符串（由 mutation 归一化） */
  value: string | null;
  /** 是否为追加的新行 */
  isNewRow: boolean;
  /** 校验不通过的原因；存在则该格不写入 */
  invalid?: string;
}

export interface PastePlan {
  /** 目标单元格（已过滤掉被丢弃的列） */
  cells: PasteCell[];
  /** 被丢弃的列数与提示（粘贴列数超出剩余列） */
  droppedColumns: number;
  dropNotice: string | null;
  /** 追加的新行数 */
  appendedRows: number;
  /** 校验不通过的格子 */
  issues: CellIssue[];
  /** 是否整体被拒（只读表 / 空剪贴板 / 超过上限） */
  rejected: string | null;
  /** 汇总文案，供粘贴预览浮层直接展示 */
  summary: string;
  /** 实际写入的行数与列数（不含被丢弃的列） */
  rows: number;
  cols: number;
}

/**
 * 计算粘贴计划。
 *
 * 只读（无唯一键）时**整体拒绝** —— 这是 B5 红线，不是"跳过某一格"。
 * 渲染层拿到 plan 后：展示 summary → 标红 issues → 把有效 cells 标为脏单元格，
 * 由 core-mutation 统一走 SQL 预演，粘贴本身不自动提交。
 */
export function buildPastePlan(
  parsed: ParsedTable,
  target: PasteTarget,
  maxRows = DEFAULT_MAX_PASTE_ROWS,
): PastePlan {
  const empty: PastePlan = {
    cells: [],
    droppedColumns: 0,
    dropNotice: null,
    appendedRows: 0,
    issues: [],
    rejected: null,
    summary: '',
    rows: 0,
    cols: 0,
  };

  if (!target.editable) {
    return {
      ...empty,
      rejected: '该表无主键/唯一键，无法安全定位行，网格为只读，不支持粘贴',
      summary: '该表无主键/唯一键，无法安全定位行，网格为只读，不支持粘贴',
    };
  }

  if (parsed.rowCount === 0 || parsed.colCount === 0) {
    return { ...empty, rejected: '剪贴板为空', summary: '剪贴板为空' };
  }

  const colCount = target.columns.length;
  if (colCount === 0) {
    return { ...empty, rejected: '表格没有列', summary: '表格没有列' };
  }
  // 起始列越界要如实报错，不能悄悄夹到最后一列 —— 静默改位置会让用户粘错列
  if (target.startCol < 0 || target.startCol >= colCount) {
    return { ...empty, rejected: '起始列超出表格列范围', summary: '起始列超出表格列范围' };
  }
  const startCol = target.startCol;
  const remaining = colCount - startCol;

  // 列对齐：超出剩余列数的部分丢弃，绝不自动新增列
  const droppedColumns = Math.max(0, parsed.colCount - remaining);
  const usableCols = Math.min(parsed.colCount, remaining);

  if (parsed.rowCount > maxRows) {
    return {
      ...empty,
      rejected: `单次粘贴上限 ${maxRows} 行，本次 ${parsed.rowCount} 行`,
      summary: `单次粘贴上限 ${maxRows} 行，本次 ${parsed.rowCount} 行`,
    };
  }

  const loadedRows = Math.max(0, target.loadedRows);
  const startRow = Math.max(0, target.startRow);
  // 起始行远在已加载区域之外 → 中间会出现无法定位的行洞，直接拒绝
  if (startRow > loadedRows) {
    return {
      ...empty,
      rejected: `起始行 ${startRow} 超出已加载的 ${loadedRows} 行，无法定位目标行`,
      summary: `起始行 ${startRow} 超出已加载的 ${loadedRows} 行，无法定位目标行`,
    };
  }

  const cells: PasteCell[] = [];
  const issues: CellIssue[] = [];
  let appendedRows = 0;
  const newRowSet = new Set<number>();

  for (let r = 0; r < parsed.rowCount; r++) {
    const targetRow = startRow + r;
    const isNewRow = targetRow >= loadedRows;
    if (isNewRow) {
      newRowSet.add(targetRow);
      appendedRows++;
    }
    for (let c = 0; c < usableCols; c++) {
      const colIndex = startCol + c;
      const meta = target.columns[colIndex];
      if (!meta) continue;

      const raw = parsed.rows[r][c] ?? '';
      const isNull = raw.trim().toUpperCase() === 'NULL' || raw.trim() === '\\N';
      const value = isNull ? null : raw;

      const reason = validateCellText(raw, meta);
      if (reason) {
        issues.push({ row: targetRow, col: colIndex, column: meta.name, raw, reason });
        continue;
      }
      cells.push({ row: targetRow, col: colIndex, column: meta.name, value, isNewRow });
    }
  }

  const targetCols = usableCols;
  const dropNotice =
    droppedColumns > 0
      ? `粘贴内容有 ${parsed.colCount} 列，超出当前位置起可用的 ${remaining} 列，多余的 ${droppedColumns} 列已丢弃（不会自动新增列）`
      : null;

  const okCount = cells.length;
  const parts = [`将写入 ${parsed.rowCount} 行 × ${targetCols} 列`];
  if (appendedRows > 0) parts.push(`其中 ${appendedRows} 行为新追加`);
  if (issues.length > 0) parts.push(`${issues.length} 处类型不匹配已标出`);
  if (droppedColumns > 0) parts.push(`${droppedColumns} 列被丢弃`);

  return {
    cells,
    droppedColumns,
    dropNotice,
    appendedRows,
    issues,
    rejected: null,
    summary: `${parts.join('，')}（共 ${okCount} 个单元格）`,
    rows: parsed.rowCount,
    cols: targetCols,
  };
}

/** 汇总一行：解析 + 计划，UI 里最常见的调用方式 */
export function planPasteFromText(text: string, target: PasteTarget, maxRows = DEFAULT_MAX_PASTE_ROWS): PastePlan {
  return buildPastePlan(parseClipboard(text), target, maxRows);
}

// ---------- 与 core-mutation 的桥接 ----------

/**
 * 把粘贴计划转成 mutation 的输入。
 *
 * 新增行走 INSERT（主键留空由服务端生成）；已有行走 UPDATE。
 * 只传校验通过的单元格 —— issues 里的格子根本不会进入写语句。
 */
export interface PasteMutationInput {
  /** 已有行的改动：按行分组 */
  updates: { rowId: string; edits: { column: string; oldValue: unknown; newValue: unknown; invalid?: { reason: string } }[] }[];
  /** 追加的新行：按行分组（列 → 值） */
  inserts: { tempId: string; values: Record<string, unknown> }[];
}

export function toMutationInput(plan: PastePlan): PasteMutationInput {
  const updates: PasteMutationInput['updates'] = [];
  const inserts: PasteMutationInput['inserts'] = [];
  const newRows = new Map<number, Record<string, unknown>>();

  for (const cell of plan.cells) {
    if (cell.isNewRow) {
      const bucket = newRows.get(cell.row) ?? {};
      bucket[cell.column] = cell.value;
      newRows.set(cell.row, bucket);
    } else {
      const bucket = updates.find((u) => u.rowId === String(cell.row));
      const edit = { column: cell.column, oldValue: undefined as unknown, newValue: cell.value as unknown };
      if (bucket) bucket.edits.push(edit);
      else updates.push({ rowId: String(cell.row), edits: [edit] });
    }
  }

  for (const [row, values] of [...newRows.entries()].sort((a, b) => a[0] - b[0])) {
    inserts.push({ tempId: `paste-${row}`, values });
  }

  return { updates, inserts };
}

/** 供 UI 展示"这个表能不能粘贴" —— 必须走编辑性判定，不要自己判有无主键 */
export function canPaste(table: TableMeta, hasPrimaryKey: (t: TableMeta) => boolean): boolean {
  return hasPrimaryKey(table);
}
