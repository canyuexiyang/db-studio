/**
 * P0-1：导出用的网格快照（选区 / 当前已加载 / 可见列）。
 *
 * 为什么单独一层：导出弹窗的「选区」「当前已加载」两个范围是**快照语义**
 * （导眼前这份结果，不再查库）。快照必须由网格产出，但产出的口径与边界
 * 全部是纯数据变换 —— 放这里才能被单测钉住，DataGrid 只负责把「读一格」
 * 与选区状态接进来。
 *
 * 🔴 **计数是即时的，行是懒物化的**。
 *    导出弹窗一打开就要知道「选区 N 行 / 已加载 M 行」才能决定选项可用性，
 *    但把 M 行全部解出来是纯浪费 —— 网格默认一页 3000 行，点过几次「加载更多」
 *    就是几万行（demo 表就是 5 万行），而用户可能只是想导「全部匹配」。
 *    所以这里交出的是 `readRows(scope)`：只有在用户点下「导出」且范围确实是
 *    快照时才调用一次。开弹窗的开销恒定 O(1)。
 *
 * 🔴 「选区」不等于「聚焦的格子」。SelectionModel 一有数据就带一个
 *    `{0,0,0,0}` 的默认 range（见 core-grid-view 构造函数），所以「有 range」
 *    不能当成「用户选了东西」——否则导出弹窗里的「选区」永远可用、且永远是
 *    「1 行」，用户没做过任何选择却被告知导出了选区。这里的判据：
 *      ① 行号勾选（`selectedRows`）非空 → 就是那几行；
 *      ② 否则取最近一次框选；**单格（r0===r1 且 c0===c1）不算选区**；
 *      ③ 都没有 → 空（导出弹窗据此禁用「选区」并给原因）。
 *    与 ⌘C 的复制口径故意不同：复制退化为「聚焦行」很自然（用户按 ⌘C 时
 *    光标就在那儿），而导出是一次会产生文件的动作，不能猜。
 *
 * 🔴 行是**整行**（列数 = 网格列数）：导出弹窗的列裁剪由 exportScope 统一做
 *    （`pickColumns` 连行一起裁）。这里如果只给选区覆盖的那几列，表头与数据
 *    就会错位 —— 属于数据损坏，不是格式差异。
 */

import type { CellValue } from '@dbstudio/core-ipc-codec';

/** 与 core-grid-view 的 CellRange 同形（只取本模块需要的字段） */
export interface SnapshotRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** 快照的两种行范围（与 exportScope 的 ExportScopeId 子集一一对应） */
export type SnapshotScope = 'selection' | 'loaded';

/**
 * 网格交给导出流程的一只「快照源」。
 *
 * 它不是数据本身，而是**取数能力** —— 行在很多情况下根本不会被读（用户选了
 * 「全部匹配」重查），所以不能在打开弹窗时就物化。
 */
export interface GridSnapshotSource {
  /** 全列定义（网格列序），供 exportScope 做列裁剪与表头 */
  columns: { name: string; dataType?: string }[];
  /** 可见列名（显示顺序，隐藏列不在其中） */
  visibleColumns: string[];
  /** 显式选中的行数（0 = 没有选区） */
  selectedRowCount: number;
  /** 当前已加载的行数 */
  loadedRowCount: number;
  /** 物化指定范围的行（整行，列序 = columns）。用户在导出时才调用一次 */
  readRows(scope: SnapshotScope): CellValue[][];
}

/**
 * 选出「用户显式表达过」的行下标（升序、去重、已按 rowCount 钳制）。
 *
 * 见文件头的口径说明：单格光标不算选区。
 */
export function exportSelectionRowIndexes(
  sel: { ranges: readonly SnapshotRange[]; selectedRows: readonly number[] },
  rowCount: number,
): number[] {
  const total = Math.max(0, Math.floor(rowCount));
  if (total === 0) return [];

  // ① 行号勾选优先（点了行号就是明确要那几整行）
  if (sel.selectedRows.length > 0) {
    const seen = new Set<number>();
    for (const raw of sel.selectedRows) {
      const r = Math.floor(raw);
      if (r >= 0 && r < total) seen.add(r);
    }
    return [...seen].sort((a, b) => a - b);
  }

  // ② 最近一次框选（多重选区叠加时取最后一块 —— 与复制/删除同口径）
  const last = sel.ranges[sel.ranges.length - 1];
  if (!last) return [];
  const c0 = Math.min(last.c0, last.c1);
  const c1 = Math.max(last.c0, last.c1);
  const r0 = Math.max(0, Math.min(Math.floor(Math.min(last.r0, last.r1)), total - 1));
  const r1 = Math.max(0, Math.min(Math.floor(Math.max(last.r0, last.r1)), total - 1));
  // ③ 单格 = 光标，不是选区（网格一有数据就有它）
  if (r0 === r1 && c0 === c1) return [];
  if (r0 > r1) return [];

  const out: number[] = [];
  for (let r = r0; r <= r1; r++) out.push(r);
  return out;
}

export interface BuildGridSnapshotInput {
  rowCount: number;
  columnCount: number;
  /** 网格列定义（顺序 = 行数组的列序） */
  columns: readonly { name: string; dataType?: string }[];
  /** 可见列名（显示顺序） */
  visibleColumns: readonly string[];
  ranges: readonly SnapshotRange[];
  selectedRows: readonly number[];
  /** 逐格取值（渲染层传 source.value —— 含脏单元格的展示值） */
  valueAt: (row: number, col: number) => CellValue;
}

/**
 * 产出一只快照源：计数立刻可读，行等 `readRows` 被调用才解。
 *
 * 读行是**全量物化**（用户的显式动作，允许分配）；一次调用只读一个范围。
 */
export function buildGridSnapshotSource(input: BuildGridSnapshotInput): GridSnapshotSource {
  const total = Math.max(0, Math.floor(input.rowCount));
  const cols = Math.max(0, Math.floor(input.columnCount));

  const readRow = (r: number): CellValue[] => {
    const row: CellValue[] = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = input.valueAt(r, c);
    return row;
  };

  // 选区下标在构造时算（O(range)，不涉及逐格解码），计数才能立刻给出
  const selectedIndexes = exportSelectionRowIndexes(input, total);

  return {
    columns: input.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
    visibleColumns: [...input.visibleColumns],
    selectedRowCount: selectedIndexes.length,
    loadedRowCount: total,
    readRows(scope: SnapshotScope): CellValue[][] {
      if (scope === 'selection') return selectedIndexes.map(readRow);
      const out: CellValue[][] = [];
      for (let r = 0; r < total; r++) out.push(readRow(r));
      return out;
    },
  };
}
