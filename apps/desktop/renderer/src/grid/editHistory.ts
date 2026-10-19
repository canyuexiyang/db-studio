/**
 * T38：**当前会话未保存改动的 undo/redo 栈**（纯逻辑，不依赖 React / DOM）。
 *
 * ## 为什么不做在网格内部
 *
 * 改动的来源不止一处：单元格编辑、批量编辑条、复制行、新增空白行、设为 NULL、
 * 粘贴、⌥0 清除本格……它们最终都落在 `GridDataSource.dirty` 上。
 * 如果每个入口各自维护撤销栈，必然出现「某些改动撤不回来」——
 * 而那正是这个缺陷最初的样子（只有编辑态 Esc 与本格清除）。
 *
 * 所以：**栈按「一次用户动作」记录一组单元格的前后状态**，入口只负责在动作
 * 结束后 `push` 一条，撤销/重做由栈统一回放。
 *
 * ## 语义边界（写在最前面，避免后来人误会）
 *
 *  - 只覆盖**当前会话**的未保存改动。**不做持久历史**（重启不恢复），
 *    也不跨标签（每张表一个栈）。
 *  - **保存成功后整栈清空**：那些值已经是库里的数据，撤销它没有语义 ——
 *    要改回来就得再改一次，而不是「撤销掉已经写进库的 UPDATE」。
 *  - `before === null` 表示该格在本次动作前**是干净的**（不是 NULL 值）。
 *    撤销时对应 `clearCell`，而不是 `setDirty(null)` —— 这两者对预览与
 *    「脏计数」完全不同（后者会留下一个待提交的 NULL）。
 */

export type CellValueKind = 'literal' | 'sql-expr';

/** 某格在某一刻的待提交状态 */
export interface CellState {
  row: number;
  col: number;
  value: string | null;
  valueKind: CellValueKind;
}

/** 一次改动：before = null 表示动作前该格干净 */
export interface CellChange {
  row: number;
  col: number;
  before: CellState | null;
  after: CellState | null;
}

export interface EditEntry {
  /** 给 UI 用的动作名（撤销/重做按钮的 title） */
  label: string;
  changes: CellChange[];
  /**
   * 整行层面的变化（新增空白行 / 复制行）。
   *
   * 为什么单独放：`setExtraRows()` 改的是**行数**，不是某几格的值。
   * 只回放 changes 会让「撤销新增行」留下一个空壳行（脏格清干净了，
   * 行还在网格里），用户看到的是「撤销没生效」。
   */
  rowDelta?: { before: number; after: number };
  /** 空白行标记的变化（`markBlankRow` 是 Set，撤销要能撤掉） */
  blankMarks?: { row: number; before: boolean; after: boolean }[];
}

/** 撤销/重做时要回放的行级副作用（与单元格状态分开返回，避免调用方漏处理） */
export interface EntryMeta {
  extraRows: number | null;
  /** 该行是否应被标记为「空白行」 */
  blank: { row: number; marked: boolean }[];
}

/** 回放行级副作用：extraRows 非 null 时调用 setExtraRows；blank 逐条 mark/unmark */
export function applyMetaTo(
  entry: EditEntry,
  direction: 'undo' | 'redo',
  source: {
    setExtraRows?: (n: number) => void;
    markBlankRow?: (row: number) => void;
    unmarkBlankRow?: (row: number) => void;
  },
): void {
  const meta = metaFor(entry, direction);
  if (meta.extraRows != null) source.setExtraRows?.(meta.extraRows);
  for (const b of meta.blank) {
    if (b.marked) source.markBlankRow?.(b.row);
    else source.unmarkBlankRow?.(b.row);
  }
}

export function metaFor(entry: EditEntry, direction: 'undo' | 'redo'): EntryMeta {
  const extraRows = entry.rowDelta
    ? direction === 'undo'
      ? entry.rowDelta.before
      : entry.rowDelta.after
    : null;
  const blank = (entry.blankMarks ?? []).map((b) => ({
    row: b.row,
    marked: direction === 'undo' ? b.before : b.after,
  }));
  return { extraRows, blank };
}

/** 栈深度上限：防「改一万格」把内存吃掉；超限丢最老的（不是丢掉最新的） */
export const HISTORY_LIMIT = 100;

export class EditHistory {
  private undoStack: EditEntry[] = [];
  private redoStack: EditEntry[] = [];

  /** 记录一次用户动作；新动作必须让 redo 失效（否则会出现分叉历史） */
  push(entry: EditEntry): void {
    // 纯行级动作（新增行）没有单元格改动，但 rowDelta 有意义 —— 不能因此丢掉
    const hasRowEffect = !!entry.rowDelta || (entry.blankMarks?.length ?? 0) > 0;
    if (entry.changes.length === 0 && !hasRowEffect) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 下一次撤销/重做要说明的动作名（按钮 title 用） */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** 撤销一步：返回**要回放的状态**（调用方据此 clearCell / setDirty） */
  undo(): EditEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }

  redo(): EditEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  /** 保存成功 / 重载 discard / 换表 → 清空两栈 */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

/**
 * 撤销时要应用的**目标状态**：before 为 null 的格子必须被**清干净**。
 *
 * 单独给出方向（而不是让调用方自己 `entry.changes.map(c => c.before)`），
 * 是因为「撤销用 before、重做用 after」写错时方向相反却不会被类型系统拦住。
 */
export function statesFor(entry: EditEntry, direction: 'undo' | 'redo'): CellState[] {
  const out: CellState[] = [];
  for (const c of entry.changes) {
    const target = direction === 'undo' ? c.before : c.after;
    if (target) out.push(target);
  }
  return out;
}

/** 撤销/重做时**需要清回干净**的格子（target 为 null 的那些） */
export function clearsFor(entry: EditEntry, direction: 'undo' | 'redo'): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (const c of entry.changes) {
    const target = direction === 'undo' ? c.before : c.after;
    if (!target) out.push({ row: c.row, col: c.col });
  }
  return out;
}
