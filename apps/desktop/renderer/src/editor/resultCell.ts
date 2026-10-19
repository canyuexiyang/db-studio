/**
 * T33（editor 侧）：SQL 结果网格「查看完整值」的纯逻辑。
 *
 * 背景：SQL 的 ResultGrid 此前**完全没给** `onInspectCell`（`SqlEditorPanel` 的
 * ResultGrid），于是通用网格菜单里「查看完整值」点了什么也不会发生 ——
 * 表网格有弹窗不代表 SQL 结果也有。
 *
 * 这里把两件可测的事下沉成纯函数：
 *  1. **取值**：值一律来自 `source.raw(row, col)`（列式载荷解码出来的原始值，
 *     BLOB 是 Uint8Array、BIGINT 不丢精度），**绝不**走网格里截断过的展示串 ——
 *     这是「内容与原字节一致」的唯一保证。
 *  2. **回调装配**：`buildResultInspectHandler` 的返回类型里 `onInspectCell` 是
 *     **必填**（不是可选）—— 谁漏传了，编译期就红，而不是运行时「点了没反应」。
 */

import type { TableMeta } from '@dbstudio/core-schema-cache';

/**
 * 结果网格数据源的最小形状。
 *
 * 刻意只声明用到的四个成员：`grid/GridDataSource` 天然满足它（结构类型），
 * 单测里也能用几十行的假实现替身，不必拉起 React / CodeMirror。
 */
export interface ResultCellSourceLike {
  readonly columnCount: number;
  readonly rowCount: number;
  columnName(col: number): string;
  /** 原始值（未经脏标记覆盖、未经截断） */
  raw(row: number, col: number): unknown;
}

export interface ResultCellRef {
  row: number;
  col: number;
  /** 列名（值查看器标题要用） */
  column: string;
  /** 原始值 —— 与数据库返回的字节同源 */
  value: unknown;
}

/**
 * 取一个待检视的单元格。
 *
 * 越界一律返回 null（而不是返回 undefined 值让弹窗显示「NULL」）——
 * 网格在结果被替换的一瞬间可能报出旧的行列号，那时「不弹」比「弹个错的」好。
 */
export function readResultCell(
  source: ResultCellSourceLike,
  row: number,
  col: number,
): ResultCellRef | null {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || col < 0) return null;
  if (row >= source.rowCount || col >= source.columnCount) return null;
  return { row, col, column: source.columnName(col), value: source.raw(row, col) };
}

/**
 * 结果网格的检视回调。
 *
 * 🔴 只有 `onInspectCell`，**没有** `onCellActivated`：DataGrid 的
 *    `onCellActivated` 是在**每一次左键点击**时触发的（DataGrid.tsx:1421），
 *    把它接到「弹窗」上，点任何一格都会弹窗 —— 那是比「点了没反应」更糟的体验。
 *    「查看完整值」这条菜单分支在 DataGrid 里本身就优先走 onInspectCell。
 */
export interface ResultInspectHandlers {
  onInspectCell: (row: number, col: number) => void;
}

export function buildResultInspectHandler(
  source: ResultCellSourceLike,
  open: (cell: ResultCellRef) => void,
): ResultInspectHandlers {
  return {
    onInspectCell: (row, col) => {
      const cell = readResultCell(source, row, col);
      // 越界静默返回：菜单是能点的，但那一刻的结果已经不在了 —— 不弹错的内容
      if (cell === null) return;
      open(cell);
    },
  };
}

/** 一行结果按「列名 → 原始值字符串」摊平后的形态（T39 行定位用） */
export interface ResultRowValue {
  column: string;
  value: string | null;
}

/**
 * T39：读一行结果的原始值，供「打开源表 → 定位到这一行」使用。
 *
 * 三条纪律：
 *  1. 值走 `source.raw()`，**不用**网格里截断过的展示串（定位列被截断就会匹到错行）；
 *  2. 二进制（`Uint8Array`）**不猜**：返回 null，让宿主判定「无法等值定位」；
 *  3. 越界返回 null（结果可能刚被替换，此刻宁可不定位，也不要定位到错行）。
 */
export function readResultRow(source: ResultCellSourceLike, row: number): ResultRowValue[] | null {
  if (!Number.isInteger(row) || row < 0 || row >= source.rowCount) return null;
  const out: ResultRowValue[] = [];
  for (let col = 0; col < source.columnCount; col++) {
    const v = source.raw(row, col);
    out.push({
      column: source.columnName(col),
      value: v === null || v === undefined ? null : v instanceof Uint8Array ? null : String(v),
    });
  }
  return out;
}

// ---------- 值查看器的「表上下文」 ----------
export interface ResultSourceTable {
  database: string | null;
  table: string;
}

/**
 * 给 `detail/CellValueModal` 的 `table` 参数。
 *
 * 🔴 只在**主进程判定为单表 SELECT**（结果带 source）时才给；JOIN / 聚合 /
 *    非 SELECT 一律 null —— 不猜来源表，也就不会在弹窗标题里谎报一个表名。
 *
 * 🔴 `columns` 刻意是空数组：值查看器只用它反查列类型做二进制兜底，
 *    而这个来源表是**查询结果的源表**，不是结果的列集合 —— 拿结果列去冒充
 *    表结构等于伪造元数据（nullable / 主键这些我们根本不知道）。
 *    二进制识别走值本身的形态（Uint8Array），不受影响。
 */
export function resultDisplayTable(source: ResultSourceTable | null | undefined): TableMeta | null {
  if (!source || typeof source.table !== 'string' || source.table === '') return null;
  return {
    name: source.table,
    kind: 'table',
    comment: null,
    estimatedRows: null,
    engine: null,
    collation: null,
    columns: [],
  };
}

/** 值查看器的 `database` 参数：单表结果用来源库，否则用当前查询库 */
export function resultDisplayDatabase(
  source: ResultSourceTable | null | undefined,
  fallback: string | null | undefined,
): string | null {
  const db = source?.database;
  if (typeof db === 'string' && db !== '') return db;
  return typeof fallback === 'string' && fallback !== '' ? fallback : null;
}
