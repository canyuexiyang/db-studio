/**
 * 数据网格视图模型（PRD §6.3.2 虚拟滚动 / §6.3.3 排序 / §9.2 网格快捷键）
 *
 * 定位：**纯逻辑，零 UI 依赖、零 DOM**。所有输入是数字与数组，所有输出是可直接
 * 送给渲染层的数据。这样虚拟滚动、选择、键盘导航、排序三态都能被单测守住，
 * 而不必先搭起 React 才能验证 —— 网格是本项目最核心的模块，逻辑必须先可测。
 *
 * 刻意不放进来的东西：
 *  - 单元格取值：由 core-ipc-codec 的 ColumnarReader 负责（只解可视区）
 *  - 能否编辑：由 core-mutation 的 isEditable(table) 决定，**渲染层必须调用它**，
 *    不要在本模块里自行判断有无主键（B5 红线）
 */

// ---------- 行高 ----------

export const ROW_HEIGHTS = {
  compact: 24,
  standard: 28,
  loose: 32,
} as const;

export type RowHeightMode = keyof typeof ROW_HEIGHTS;

export const ROW_HEIGHT_MODES: readonly RowHeightMode[] = ['compact', 'standard', 'loose'];

export function rowHeightPx(mode: RowHeightMode): number {
  return ROW_HEIGHTS[mode] ?? ROW_HEIGHTS.standard;
}

// ---------- 纵向虚拟滚动 ----------

/** PRD §6.3.2：仅渲染可视区 + 上下各 10 行缓冲 */
export const DEFAULT_OVERSCAN_ROWS = 10;

export interface VisibleRangeInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}

export interface VisibleRange {
  /** 需要渲染的首行（含缓冲区，已裁剪到 [0,rowCount)） */
  start: number;
  /** 需要渲染的末行（不含） */
  end: number;
  /** 首行距内容顶部的像素偏移，渲染层直接 translateY 这个量 */
  offsetTop: number;
  /** 内容总高度 */
  totalHeight: number;
  /** 首个完整可见行的下标（不含缓冲区），用于"当前视口第一行"语义 */
  firstVisibleIndex: number;
  /** 最后一个完整可见行的下标（含），rowCount=0 时为 -1 */
  lastVisibleIndex: number;
}

/**
 * 计算可视区行范围。
 *
 * 边界：rowCount=0 / viewportHeight=0 / rowHeight<=0 都返回空区间而不抛异常 ——
 * 网格在"还没数据""容器还没布局完"时会真实遇到这些状态。
 */
export function computeVisibleRange(input: VisibleRangeInput): VisibleRange {
  const rowCount = Math.max(0, Math.floor(input.rowCount));
  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN_ROWS));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : ROW_HEIGHTS.standard;
  const totalHeight = rowCount * rowHeight;
  const scrollTop = Math.max(0, input.scrollTop);

  if (rowCount === 0 || viewportHeight === 0) {
    return {
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight,
      firstVisibleIndex: 0,
      lastVisibleIndex: -1,
    };
  }

  const firstVisibleIndex = Math.min(rowCount - 1, Math.floor(scrollTop / rowHeight));
  const lastVisibleIndex = Math.min(
    rowCount - 1,
    Math.max(firstVisibleIndex, Math.ceil((scrollTop + viewportHeight) / rowHeight) - 1),
  );

  const start = Math.max(0, firstVisibleIndex - overscan);
  const end = Math.min(rowCount, lastVisibleIndex + 1 + overscan);

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight,
    firstVisibleIndex,
    lastVisibleIndex,
  };
}

/** 把某一行滚动进视口。已完全可见时返回 null（调用方不必 setState） */
export function computeScrollToReveal(
  row: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number | null {
  if (rowHeight <= 0 || viewportHeight <= 0) return null;
  const top = row * rowHeight;
  const bottom = top + rowHeight;
  const viewTop = Math.max(0, scrollTop);
  const viewBottom = viewTop + viewportHeight;

  if (top >= viewTop && bottom <= viewBottom) return null;
  if (top < viewTop) return top;
  return Math.max(0, bottom - viewportHeight);
}

// ---------- 横向列布局 ----------

export interface ColumnLayout {
  /** 每列宽度（px） */
  widths: number[];
  /** 冻结列数（吸左，Q3 建议需要）。默认 0 */
  frozenCount?: number;
}

export interface ColumnOffsets {
  /** 每列左边界（长度 = widths.length + 1，末元素为总宽） */
  offsets: number[];
  totalWidth: number;
}

export function buildColumnOffsets(layout: ColumnLayout): ColumnOffsets {
  const offsets: number[] = [0];
  let acc = 0;
  for (const w of layout.widths) {
    acc += Math.max(0, w);
    offsets.push(acc);
  }
  return { offsets, totalWidth: acc };
}

export interface VisibleColumnRange {
  /** 需要渲染的普通列首列（不含冻结列） */
  start: number;
  end: number;
  /** 冻结列始终渲染：[0, frozenEnd) */
  frozenEnd: number;
  /** 普通列整体水平偏移（渲染层 translateX） */
  offsetLeft: number;
}

/**
 * 计算需要渲染的列范围。冻结列不参与裁剪（永远渲染），
 * 且滚动到最左时冻结列不该被普通列盖住 —— offsetLeft 由调用方用于定位。
 */
export function computeVisibleColumns(
  layout: ColumnLayout,
  offsets: ColumnOffsets,
  scrollLeft: number,
  viewportWidth: number,
  overscan = 2,
): VisibleColumnRange {
  const colCount = layout.widths.length;
  const frozenEnd = Math.min(colCount, Math.max(0, Math.floor(layout.frozenCount ?? 0)));
  if (colCount === 0 || viewportWidth <= 0) {
    return { start: frozenEnd, end: frozenEnd, frozenEnd, offsetLeft: 0 };
  }

  // ⚠️ offsets 是 { offsets, totalWidth } 对象，列边界在 offsets.offsets 里。
  // 拿对象当下标访问会恒得到 undefined，范围会静默退化 —— 别写错。
  const bounds = offsets.offsets;
  const left = Math.max(0, scrollLeft);
  const right = left + viewportWidth;

  let start = frozenEnd;
  while (start < colCount && bounds[start + 1] <= left) start++;
  let end = start;
  while (end < colCount && bounds[end] < right) end++;

  start = Math.max(frozenEnd, start - overscan);
  end = Math.min(colCount, end + overscan);

  return { start, end, frozenEnd, offsetLeft: bounds[start] };
}

// ---------- 单元格与范围 ----------

export interface CellPos {
  row: number;
  col: number;
}

export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function clampCell(pos: CellPos, rowCount: number, colCount: number): CellPos {
  return {
    row: Math.min(Math.max(0, pos.row), Math.max(0, rowCount - 1)),
    col: Math.min(Math.max(0, pos.col), Math.max(0, colCount - 1)),
  };
}

/** 归一化：保证 r0<=r1、c0<=c1 */
export function normalizeRange(r: CellRange): CellRange {
  return {
    r0: Math.min(r.r0, r.r1),
    c0: Math.min(r.c0, r.c1),
    r1: Math.max(r.r0, r.r1),
    c1: Math.max(r.c0, r.c1),
  };
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  const n = normalizeRange(range);
  return row >= n.r0 && row <= n.r1 && col >= n.c0 && col <= n.c1;
}

export function rangeCellCount(range: CellRange): number {
  const n = normalizeRange(range);
  return (n.r1 - n.r0 + 1) * (n.c1 - n.c0 + 1);
}

export function rangeRowCount(range: CellRange): number {
  const n = normalizeRange(range);
  return n.r1 - n.r0 + 1;
}

/** 选中区域的规范表示：从左上到右下的行列表，便于逐行取值 */
export function rangeRows(range: CellRange): { row: number; c0: number; c1: number }[] {
  const n = normalizeRange(range);
  const out: { row: number; c0: number; c1: number }[] = [];
  for (let r = n.r0; r <= n.r1; r++) out.push({ row: r, c0: n.c0, c1: n.c1 });
  return out;
}

// ---------- 选择模型 ----------

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/**
 * V11 递进选区（DataGrip「Expand Selection」）的档位。
 *
 * 0 = 未在阶梯上（普通单格/拖选状态）
 * 1 = 整列（当前焦点所在列的所有行）
 * 2 = 整行（当前焦点所在行的所有列）
 * 3 = 整个网格
 *
 * ⚠️ 档位顺序刻意是「列 → 行 → 全表」而不是直觉上的「格 → 行 → 列 → 全表」：
 *    这与 DataGrip 的实际手感一致，且网格的第一诉求通常是「这一列的统计」
 *    （A8 聚合条最常见的用法），把列放第一档能让 ⌥↑ 一次就到最常用的态。
 */
export type ExpandLevel = 0 | 1 | 2 | 3;

/** 档位上限（⌥↑ 到 3 后不再增长） */
export const EXPAND_LEVEL_MAX: ExpandLevel = 3;

export interface NavModifiers {
  /** Cmd 键：跨到行首/行末/列首/列末 */
  cmd?: boolean;
  /** Shift 键：扩展选区（保留 anchor，移动 focus） */
  shift?: boolean;
  /** Cmd+Shift 之外的多选追加：Cmd+点击 */
  additive?: boolean;
}

export interface SelectionSnapshot {
  focus: CellPos;
  anchor: CellPos;
  ranges: CellRange[];
  selectedRows: number[];
}

/**
 * 网格选择模型。
 *
 * 三类选择并存（与 PRD §6.3.5 / §9.2 一致）：
 *  1. **单元格矩形选区** ranges —— 点击/Shift+方向/Cmd+A
 *  2. **焦点单元格** focus —— 键盘当前位置，也是编辑起点（始终存在）
 *  3. **整行选择** selectedRows —— `Space` 逐行勾选，用于删除/导出
 *
 * 边界：rowCount/colCount 为 0 时 focus 固定 (0,0)，所有操作退化为空选区而不抛异常。
 */
export class SelectionModel {
  private _rowCount: number;
  private _colCount: number;
  private _focus: CellPos = { row: 0, col: 0 };
  private _anchor: CellPos = { row: 0, col: 0 };
  private _ranges: CellRange[] = [];
  private _rows = new Set<number>();
  /**
   * V11 递进选区的当前档位（0 = 未在阶梯上）。
   * 只由 expandSelection 读写，selectCell/selectAll/removeRows 等动作会把它清零 ——
   * 否则「点了别的格子再按 ⌥↑」会从上一轮的档位继续爬，行为不可预期。
   */
  private _expandLevel: ExpandLevel = 0;

  constructor(rowCount: number, colCount: number) {
    this._rowCount = Math.max(0, Math.floor(rowCount));
    this._colCount = Math.max(0, Math.floor(colCount));
    this._focus = { row: 0, col: 0 };
    this._anchor = { row: 0, col: 0 };
    if (this._rowCount > 0 && this._colCount > 0) {
      this._ranges = [{ r0: 0, c0: 0, r1: 0, c1: 0 }];
    }
  }

  get rowCount(): number {
    return this._rowCount;
  }

  get colCount(): number {
    return this._colCount;
  }

  get focus(): CellPos {
    return { ...this._focus };
  }

  get anchor(): CellPos {
    return { ...this._anchor };
  }

  /** 当前主选区（追加多选时为最后一块） */
  get primaryRange(): CellRange | null {
    return this._ranges.length > 0 ? normalizeRange(this._ranges[this._ranges.length - 1]) : null;
  }

  get ranges(): CellRange[] {
    return this._ranges.map((r) => normalizeRange(r));
  }

  get selectedRows(): number[] {
    return [...this._rows].sort((a, b) => a - b);
  }

  /** 结果集尺寸变化时（重新查询/加载更多）重建，保留仍合法的焦点 */
  resize(rowCount: number, colCount: number): void {
    this._rowCount = Math.max(0, Math.floor(rowCount));
    this._colCount = Math.max(0, Math.floor(colCount));
    this._focus = clampCell(this._focus, this._rowCount, this._colCount);
    this._anchor = clampCell(this._anchor, this._rowCount, this._colCount);
    this._rows = new Set([...this._rows].filter((r) => r < this._rowCount));
    this._ranges = this._ranges
      .map((r) =>
        normalizeRange({
          r0: Math.min(r.r0, this._rowCount - 1),
          c0: Math.min(r.c0, this._colCount - 1),
          r1: Math.min(r.r1, this._rowCount - 1),
          c1: Math.min(r.c1, this._colCount - 1),
        }),
      )
      .filter((r) => r.r0 >= 0 && r.c0 >= 0);
  }

  /** 单击：重置为单格；Cmd+点击则追加一块新选区 */
  selectCell(pos: CellPos, mods: NavModifiers = {}): void {
    if (this._rowCount === 0 || this._colCount === 0) return;
    const p = clampCell(pos, this._rowCount, this._colCount);
    this._focus = p;
    this._anchor = p;
    // V11：任何显式的选区动作都退出「递进选区」阶梯，否则 ⌥↑ 会从上一轮的
    // level 继续爬（用户点了别的格子还以为是新起点，行为不可预期）
    this._expandLevel = 0;
    if (mods.additive) {
      this._ranges.push({ r0: p.row, c0: p.col, r1: p.row, c1: p.col });
    } else {
      this._ranges = [{ r0: p.row, c0: p.col, r1: p.row, c1: p.col }];
    }
  }

  /**
   * 只移动键盘焦点（anchor 同步），不碰矩形选区与行勾选 ——
   * 行号列点击后把焦点落到该行首列，让 Space / 方向键 / Enter 有落点，
   * 但行勾选是这时真正的选择，不能被 selectCell 的「重置选区」语义清掉。
   */
  setFocus(pos: CellPos): void {
    if (this._rowCount === 0 || this._colCount === 0) return;
    const p = clampCell(pos, this._rowCount, this._colCount);
    this._focus = p;
    this._anchor = p;
    // V11：焦点被显式挪走（行号列点选等）= 新起点，档位归零
    this._expandLevel = 0;
  }

  /** 方向键移动。Shift 扩展（anchor 不动），否则收焦为单格 */
  navigate(dir: NavDirection, mods: NavModifiers = {}): CellPos {
    if (this._rowCount === 0 || this._colCount === 0) return this._focus;

    let { row, col } = this._focus;
    if (mods.cmd) {
      // Cmd+方向：跨到边界（§9.2：行首/行末/列首/列末）
      if (dir === 'left') col = 0;
      else if (dir === 'right') col = this._colCount - 1;
      else if (dir === 'up') row = 0;
      else row = this._rowCount - 1;
    } else {
      if (dir === 'up') row -= 1;
      else if (dir === 'down') row += 1;
      else if (dir === 'left') col -= 1;
      else col += 1;
    }

    const next = clampCell({ row, col }, this._rowCount, this._colCount);
    this._focus = next;
    // V11：方向键导航打断递进阶梯（下一次 ⌥↑ 重新从「当前列」起步）
    this._expandLevel = 0;
    if (mods.shift) {
      const range = normalizeRange({
        r0: this._anchor.row,
        c0: this._anchor.col,
        r1: next.row,
        c1: next.col,
      });
      this._ranges = [range];
    } else {
      this._anchor = next;
      this._ranges = [{ r0: next.row, c0: next.col, r1: next.row, c1: next.col }];
    }
    return { ...next };
  }

  /**
   * 拖选 / Shift+点击：从 anchor 扩展到某格。
   *
   * `additive`（V3）：⌘ 拖时已有的选区块全部保留，只把【最后一块】替换为
   * 从当前 anchor 拉出的矩形 —— 与 Excel/DBeaver 的「⌘ 拖追加选区块」一致。
   * 非 additive 时整表选区被替换（既有语义不变）。
   *
   * 拖拽热路径：只做数值运算，不分配字符串/对象 —— 每帧都会调。
   */
  extendTo(pos: CellPos, mods: NavModifiers = {}): void {
    if (this._rowCount === 0 || this._colCount === 0) return;
    const p = clampCell(pos, this._rowCount, this._colCount);
    this._focus = p;
    // ⚠️ 内部按 anchor→当前 顺序存放（不归一），getter `ranges` 才做 normalizeRange ——
    // 既有契约如此，消费者依赖它自行判定方向；这里擅自归一会让 rangeContains 等
    // 走偏，且破坏既有单测（extendTo 反方向拖选保留 r0/c0=anchor）。
    const range = {
      r0: this._anchor.row,
      c0: this._anchor.col,
      r1: p.row,
      c1: p.col,
    };
    if (mods.additive && this._ranges.length > 0) {
      this._ranges[this._ranges.length - 1] = range;
    } else {
      this._ranges = [range];
    }
    // V11：拖选建立了新的矩形选区，递进阶梯归零（下一次 ⌥↑ 从「当前列」起步）
    this._expandLevel = 0;
  }

  /** 当前递进选区档位（V11）。只读，供 UI 显示/断言用 */
  get expandLevel(): ExpandLevel {
    return this._expandLevel;
  }

  /**
   * V11 递进选区（DataGrip「Expand Selection」，⌥↑ / ⌥↓）。
   *
   * grow=true（⌥↑）：当前列 → 当前行 → 整个网格；grow=false（⌥↓）反向收缩，
   * 收到 0 档时退回「焦点单格」。
   *
   * 两条语义约束：
   *  - **focus 不随档位移动**：递进的意图是「围绕当前格扩大范围」，把 focus
   *    推到网格右下角会让后续 ⌥↓ 收缩到一个无关的位置（selectAll 推 focus
   *    是因为 ⌘A 的语义就是"重置到全表"）。
   *  - **行勾选清空**：与 selectAll 同理 —— selectionStats/复制都是「行勾选优先」，
   *    不清掉的话 ⌥↑ 到全表后 ⌘C 会悄悄退化成复制旧的行勾选。
   *
   * 返回变化后的档位（调用方不必再读 getter，也可用于判断"到顶了"）。
   */
  expandSelection(grow: boolean): ExpandLevel {
    if (this._rowCount === 0 || this._colCount === 0) {
      this._expandLevel = 0;
      return 0;
    }
    const cur = this._expandLevel;
    const next: ExpandLevel = grow
      ? (Math.min(EXPAND_LEVEL_MAX, cur + 1) as ExpandLevel)
      : (Math.max(0, cur - 1) as ExpandLevel);
    this._expandLevel = next;
    this._rows.clear();

    const { row, col } = this._focus;
    if (next === 1) {
      this._ranges = [{ r0: 0, c0: col, r1: this._rowCount - 1, c1: col }];
    } else if (next === 2) {
      this._ranges = [{ r0: row, c0: 0, r1: row, c1: this._colCount - 1 }];
    } else if (next === 3) {
      this._ranges = [{ r0: 0, c0: 0, r1: this._rowCount - 1, c1: this._colCount - 1 }];
    } else {
      this._ranges = [{ r0: row, c0: col, r1: row, c1: col }];
    }
    return next;
  }

  selectAll(): void {
    if (this._rowCount === 0 || this._colCount === 0) {
      this._ranges = [];
      this._rows.clear();
      this._expandLevel = 0;
      return;
    }
    // ⌘A 语义 = 全选（单元格矩形）。行勾选一并清空：否则 ⌘C 的行选优先级
    // 会让「全选后复制」悄悄退化成复制旧的行勾选，行为不可预期。
    this._rows.clear();
    // V11：⌘A 后档位直接对齐到「整个网格」，⌥↓ 从 3 档往下收才有正确起点
    this._expandLevel = EXPAND_LEVEL_MAX;
    this._anchor = { row: 0, col: 0 };
    this._focus = { row: this._rowCount - 1, col: this._colCount - 1 };
    this._ranges = [
      { r0: 0, c0: 0, r1: this._rowCount - 1, c1: this._colCount - 1 },
    ];
  }

  /** Space：整行勾选/取消（§9.2）。返回切换后的状态 */
  toggleRow(row: number): boolean {
    if (row < 0 || row >= this._rowCount) return false;
    this._expandLevel = 0; // V11：行勾选是另一种选择模式，退出递进阶梯
    if (this._rows.has(row)) {
      this._rows.delete(row);
      return false;
    }
    this._rows.add(row);
    return true;
  }

  /**
   * 行号列单击：选中单行（替换此前行勾选）。与 Space 的逐行勾选不同，
   * 这是「点选」语义 —— 空白处再点别的行，旧的选中不该残留。
   * 返回该行是否处于选中态（恒 true，便于调用方对齐 toggleRow 的用法）。
   */
  selectRowOnly(row: number): boolean {
    if (row < 0 || row >= this._rowCount) return false;
    this._rows = new Set([row]);
    this._expandLevel = 0; // V11：同上
    return true;
  }

  /**
   * 行号列 Shift+点击 / 拖选：选中 [from, to] 整段行（替换此前行勾选）。
   * 端点顺序无所谓（内部归一化）；越界端点钳到 [0, rowCount)。
   */
  selectRowRange(from: number, to: number): void {
    if (this._rowCount === 0) {
      this._rows = new Set();
      return;
    }
    this._expandLevel = 0; // V11：同上
    const a = Math.min(Math.max(0, from), this._rowCount - 1);
    const b = Math.min(Math.max(0, to), this._rowCount - 1);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const rows = new Set<number>();
    for (let r = lo; r <= hi; r++) rows.add(r);
    this._rows = rows;
  }

  /** 右键落在已选行上时保持多选不塌缩：判断用 */
  hasRowSelected(row: number): boolean {
    return this._rows.has(row);
  }

  clearRows(): void {
    this._rows.clear();
  }

  /** 清空矩形选区（保留焦点与行勾选）。行号列点选时清掉遗留的单元格选区 —— 否则构造函数的初始 1×1 选区会混进行数统计 */
  clearRanges(): void {
    this._ranges = [];
  }

  /** 删除行后行号会整体上移：把选区与行选择一并修正 */
  removeRows(rows: number[]): void {
    const sorted = [...new Set(rows)].filter((r) => r >= 0 && r < this._rowCount).sort((a, b) => a - b);
    if (sorted.length === 0) return;

    const shift = (r: number): number => {
      let removed = 0;
      for (const d of sorted) if (d < r) removed++;
      return r - removed;
    };

    this._rowCount -= sorted.length;
    this._focus = { row: clampCell({ row: shift(this._focus.row), col: this._focus.col }, this._rowCount, this._colCount).row, col: this._focus.col };
    this._anchor = { row: clampCell({ row: shift(this._anchor.row), col: this._anchor.col }, this._rowCount, this._colCount).row, col: this._anchor.col };
    this._ranges = this._ranges
      .map((r) => ({ r0: shift(r.r0), c0: r.c0, r1: shift(r.r1), c1: r.c1 }))
      .filter((r) => r.r1 >= r.r0);
    this._rows = new Set([...this._rows].filter((r) => !sorted.includes(r)).map(shift));
  }

  isSelected(row: number, col: number): boolean {
    return this._ranges.some((r) => rangeContains(r, row, col));
  }

  isRowSelected(row: number): boolean {
    return this._rows.has(row);
  }

  isFocus(row: number, col: number): boolean {
    return this._focus.row === row && this._focus.col === col;
  }

  snapshot(): SelectionSnapshot {
    return {
      focus: this.focus,
      anchor: this.anchor,
      ranges: this.ranges,
      selectedRows: this.selectedRows,
    };
  }
}

// ---------- 选中统计（F5 状态栏口径，覆盖矩形选区 + 行勾选两类） ----------

/**
 * 选中统计：行数 = 矩形选区行区间 ∪ 行勾选 的并集行数；
 * 格数 = 矩形选区格数 + 不与任何选区重叠的勾选行 × colCount。
 *
 * 用户主动触发（状态栏回报），允许分配；区间数与勾选数都有界（勾选来自
 * Set 快照，选区来自 ranges 快照），不需要分块。
 */
export function selectionStats(
  ranges: readonly CellRange[],
  selectedRows: readonly number[],
  colCount: number,
): { rows: number; cells: number } {
  // 收集行区间：选区归一化 + 每个勾选行视作单行区间
  const rangeIntervals: [number, number][] = [];
  for (const r of ranges) {
    const n = normalizeRange(r);
    if (n.r1 >= n.r0) rangeIntervals.push([n.r0, n.r1]);
  }
  const intervals: [number, number][] = rangeIntervals.slice();
  for (const row of selectedRows) intervals.push([row, row]);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // 合并重叠区间得并集行数
  let rows = 0;
  let curEnd = -1;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      rows += e - s + 1;
      curEnd = e;
    } else if (e > curEnd) {
      rows += e - curEnd;
      curEnd = e;
    }
  }

  // 格数：选区照常按矩形乘积；勾选行若没被任何矩形选区盖住，按整行 colCount 计
  let cells = 0;
  for (const r of ranges) cells += rangeCellCount(r);
  for (const row of selectedRows) {
    const covered = rangeIntervals.some(([s, e]) => row >= s && row <= e);
    if (!covered) cells += colCount;
  }
  return { rows, cells };
}

// ---------- 排序三态（§6.3.3） ----------

export type SortDirection = 'ASC' | 'DESC';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/** 三态循环：无 → ASC → DESC → 无 */
export function nextSortDirection(current: SortDirection | null | undefined): SortDirection | null {
  if (current == null) return 'ASC';
  if (current === 'ASC') return 'DESC';
  return null;
}

/**
 * 点击列头应用排序。
 * - 普通点击：单列排序（三态循环），清空其它列
 * - Shift+点击：追加/循环该列，保留其它列（多列排序，列头显示 ①②③）
 */
export function applySort(
  sorts: SortSpec[],
  column: string,
  additive = false,
): SortSpec[] {
  if (!column) return sorts;
  const current = sorts.find((s) => s.column === column)?.direction ?? null;
  const next = nextSortDirection(current);

  if (!additive) {
    return next == null ? [] : [{ column, direction: next }];
  }

  const others = sorts.filter((s) => s.column !== column);
  return next == null ? others : [...others, { column, direction: next }];
}

/** 列头角标序号（1 起）；未参与排序返回 null */
export function sortPriority(sorts: SortSpec[], column: string): number | null {
  const i = sorts.findIndex((s) => s.column === column);
  return i === -1 ? null : i + 1;
}

/**
 * 列头右键菜单的显式排序：把指定列设为唯一排序列、方向由菜单直接给定
 * （三态循环 applySort 满足不了「当前无序，菜单点降序」这类显式诉求）。
 */
export function applySortDirection(sorts: SortSpec[], column: string, direction: SortDirection): SortSpec[] {
  if (!column) return sorts;
  return [{ column, direction }];
}

/** 转成驱动层的 ORDER BY（服务端排序，不是前端排序 —— R10 副作用决定了必须如此） */
export function toOrderBy(sorts: SortSpec[]): { column: string; direction: SortDirection }[] {
  return sorts.map((s) => ({ column: s.column, direction: s.direction }));
}

// ---------- 加载更多（§6.3.1） ----------

export const DEFAULT_PAGE_SIZE = 3000;

export interface LoadState {
  /** 已加载行数 */
  loaded: number;
  /** 估算总行数（InnoDB 近似值，UI 必须标注"约"） */
  estimated: number | null;
  /** 是否还有更多（估算大于已加载才认为有） */
  hasMore: boolean;
  /** 底部状态文案 */
  label: string;
}

export function loadState(loaded: number, estimated: number | null): LoadState {
  const n = Math.max(0, Math.floor(loaded));
  const est = estimated == null || !Number.isFinite(estimated) ? null : Math.max(0, Math.floor(estimated));
  const hasMore = est == null ? true : n < est;
  const fmt = (v: number) => v.toLocaleString('en-US');
  const label = est == null ? `已加载 ${fmt(n)} 行` : `已加载 ${fmt(n)} / 约 ${fmt(est)} 行（估算）`;
  return { loaded: n, estimated: est, hasMore, label };
}

/** 超过该行数时，打开表前提示"建议先筛选"（§6.3.1） */
export const LARGE_TABLE_THRESHOLD = 100_000;

export function shouldWarnLargeTable(estimated: number | null): boolean {
  return estimated != null && Number.isFinite(estimated) && estimated > LARGE_TABLE_THRESHOLD;
}

// ---------- A1 结果集内查找（⌘F） ----------

export interface FindMatch {
  row: number;
  col: number;
}

export interface FindOptions {
  /** 只搜这些列（原始列索引）；null/缺省 = 全部列 */
  columnIndexes?: readonly number[] | null;
  /** 默认 false（大小写不敏感的包含匹配） */
  caseSensitive?: boolean;
}

/**
 * 单格匹配：大小写不敏感的包含匹配。
 *
 * NULL/undefined 永不命中；数字/布尔按 String() 转换后参与匹配 ——
 * 与网格展示口径一致（用户看到什么就搜什么）。
 */
export function cellMatches(value: unknown, query: string, caseSensitive = false): boolean {
  if (value === null || value === undefined) return false;
  const text = typeof value === 'string' ? value : String(value);
  if (caseSensitive) return text.includes(query);
  // 空串查询按"无操作"处理由调用方保证；这里 toLowerCase 一次即可（分块调用，量有界）
  return text.toLowerCase().includes(query.toLowerCase());
}

/**
 * 在一块已解码的行里找出全部匹配（A1 分块扫描的单块处理）。
 *
 * 调用契约：调用方（DataGrid）用 `source.decodeRange` 逐块解行，每块 ≤2000 行、
 * 块间 setTimeout 让出主线程，再把块与**块首行号**传进来 —— 本函数绝不一次性
 * 接收全量数据，也不关心结果集总行数。startRow 用于把块内下标还原成全局行号。
 */
export function findMatches(
  rows: readonly unknown[][],
  startRow: number,
  query: string,
  options?: FindOptions,
): FindMatch[] {
  if (!query) return [];
  const caseSensitive = options?.caseSensitive ?? false;
  const colFilter = options?.columnIndexes ?? null;
  const matches: FindMatch[] = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    if (colFilter) {
      for (const c of colFilter) {
        if (c >= 0 && c < row.length && cellMatches(row[c], query, caseSensitive)) {
          matches.push({ row: startRow + r, col: c });
        }
      }
    } else {
      for (let c = 0; c < row.length; c++) {
        if (cellMatches(row[c], query, caseSensitive)) {
          matches.push({ row: startRow + r, col: c });
        }
      }
    }
  }
  return matches;
}

// ---------- A7 双击自适应列宽 ----------

/** 列宽下限（拖拽与自适应共用） */
export const COLUMN_WIDTH_MIN = 40;
/** 自适应列宽上限：超宽 TEXT 列不该撑爆视口 */
export const COLUMN_WIDTH_MAX = 600;

/**
 * 按字符宽度启发式估算列宽（A7 双击自适应的纯函数核心）。
 *
 * 启发式：半角字符记 1 单位，CJK/全角记 1.6 单位（实测 11px SF Mono 下
 * 汉字约占 1.6 个半角宽）；每单位 ≈ charWidth px，加上左右 padding 与
 * 排序角标余量。只量**可视区已解码行**（调用方保证 ≤200 行样本），
 * 不为看不见的数据付宽度。
 */
export function estimateColumnWidth(
  samples: readonly string[],
  header: string,
  opts?: { charWidth?: number; padding?: number; minWidth?: number; maxWidth?: number },
): number {
  const charWidth = opts?.charWidth ?? 7;
  const padding = opts?.padding ?? 24;
  const minWidth = opts?.minWidth ?? COLUMN_WIDTH_MIN;
  const maxWidth = opts?.maxWidth ?? COLUMN_WIDTH_MAX;

  const textUnits = (s: string): number => {
    let units = 0;
    for (const ch of s) units += ch.charCodeAt(0) > 0xff ? 1.6 : 1;
    return units;
  };

  let maxUnits = textUnits(header);
  for (const s of samples) {
    if (s == null) continue;
    const u = textUnits(s);
    if (u > maxUnits) maxUnits = u;
  }
  // 6% 余量：启发式量不准长尾巴（等宽字体下数字宽度差异小，比例余量足够）
  return Math.min(maxWidth, Math.max(minWidth, Math.ceil(maxUnits * charWidth * 1.06 + padding)));
}

// ---------- A8 选中区聚合统计 ----------

export interface SelectionAggregate {
  /** 参与统计的数字个数（非数字/NULL 已跳过） */
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

/**
 * 选中区聚合（A8）。非数字（字符串/NULL/undefined）与非有限数（NaN/±Infinity）
 * 一律跳过；没有可统计数字时返回 null（UI 不显示一条空统计）。
 *
 * 只做 O(n) 单遍，不排序 —— min/max 顺手维护，avg 由 sum/count 推出。
 */
export function aggregateSelection(values: readonly unknown[]): SelectionAggregate | null {
  let count = 0;
  let sum = 0;
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (count === 0) {
      min = v;
      max = v;
    } else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    sum += v;
    count++;
  }
  if (count === 0) return null;
  return { count, sum, avg: sum / count, min, max };
}

// ---------- V12 结果集转置（Transpose） ----------

/**
 * 转置视图里「一屏最多渲染多少个字段」。
 *
 * 转置后**网格的行 = 表的字段**，列数（= 数据行数）通常远多于字段数，
 * 所以纵向不需要虚拟滚动（几十行 DOM 而已）；超过这个上限时 UI 应提示
 * 「列数过多，转置不可用」而不是渲染几千行 DOM。
 */
export const TRANSPOSE_MAX_FIELDS = 200;

/**
 * 转置态下横向（= 数据行方向）需要解码/渲染的区间。
 *
 * 🔴 红线：转置**只作用于已加载数据的可视区**，永远不 `decodeAll()`。
 * 这里只算区间，解码由渲染层调 `source.decodeRange(start, end)` 完成。
 *
 * 复用 computeVisibleRange 的同一套线性公式，只是把「行高」换成「列宽」、
 * 「行数」换成「数据行数」—— 不另写一份实现，避免两处公式漂移。
 */
export function computeTransposedVisibleRows(input: {
  /** 横向滚动量（px） */
  scrollLeft: number;
  /** 可视区宽度（px） */
  viewportWidth: number;
  /** 每个数据行在转置视图里占的列宽（px） */
  rowWidth: number;
  /** 已加载的数据行数 */
  rowCount: number;
  /** 左右各多渲染几列（默认 2） */
  overscan?: number;
}): { start: number; end: number; offsetLeft: number; totalWidth: number } {
  const r = computeVisibleRange({
    scrollTop: input.scrollLeft,
    viewportHeight: input.viewportWidth,
    rowHeight: input.rowWidth,
    rowCount: input.rowCount,
    overscan: input.overscan ?? 2,
  });
  return { start: r.start, end: r.end, offsetLeft: r.offsetTop, totalWidth: r.totalHeight };
}

/** 该结果集能否转置（字段数超上限时拒绝，理由给用户看） */
export function canTranspose(fieldCount: number): { ok: boolean; reason: string | null } {
  const n = Math.max(0, Math.floor(fieldCount));
  if (n === 0) return { ok: false, reason: '结果集没有列，无法转置' };
  if (n > TRANSPOSE_MAX_FIELDS) {
    return { ok: false, reason: `共 ${n} 列，超过转置上限 ${TRANSPOSE_MAX_FIELDS} 列` };
  }
  return { ok: true, reason: null };
}

/**
 * 转置态下的单元格坐标换算（纯算术，滚动路径可用）。
 *
 * 转置视图坐标 (vRow, vCol) → 原数据坐标 (row = vCol, col = vRow)。
 * 刻意做成两个方向的独立函数而不是一个带 flag 的函数：调用点的可读性
 * 比省两行代码重要，且这里是热路径，不该有分支。
 */
export function transposedToOriginal(vRow: number, vCol: number): CellPos {
  return { row: vCol, col: vRow };
}

export function originalToTransposed(row: number, col: number): CellPos {
  return { row: col, col: row };
}

// ---------- V13 批量编辑条（Apply / Discard） ----------

/**
 * 批量编辑的目标：哪一列 × 哪些行。
 *
 * 判定口径（与 A17 复制、V2 删除同源，避免三处各写一套）：
 *  - **行号勾选优先**：用户点了行号就是明确要改那几整行的某一列；
 *  - 其次矩形选区：要求选区**跨 ≥2 行且只覆盖 1 列**（多列选区语义模糊，
 *    一个值填进不同列几乎必然是误操作，直接不给批量条）；
 *  - 都没有 → 不出现批量条。
 */
export function batchEditTarget(
  selectedRows: readonly number[],
  ranges: readonly CellRange[],
  focusCol: number,
  rowCount: number,
): { column: number; rows: number[] } | null {
  // 行号勾选 × 焦点列
  if (selectedRows.length >= 2) {
    const rows = selectedRows.filter((r) => r >= 0 && r < rowCount).sort((a, b) => a - b);
    if (rows.length >= 2) return { column: focusCol, rows };
  }

  // 矩形选区：取最近一块，必须是「多行 × 单列」
  if (ranges.length > 0) {
    const n = normalizeRange(ranges[ranges.length - 1]);
    const rowSpan = n.r1 - n.r0 + 1;
    const colSpan = n.c1 - n.c0 + 1;
    if (rowSpan >= 2 && colSpan === 1) {
      const rows: number[] = [];
      const hi = Math.min(n.r1, rowCount - 1);
      for (let r = Math.max(0, n.r0); r <= hi; r++) rows.push(r);
      if (rows.length >= 2) return { column: n.c0, rows };
    }
  }

  return null;
}

/**
 * 批量 Apply 的产出：逐行逐列的脏单元格计划。
 *
 * 🔴 **不引入新的写路径**：这里只产出「该把哪些格子标脏」，
 * 落库仍走既有 core-mutation + 保存预演（头号红线）。
 *
 * valueKind 透传（V10）：批量条同样支持「填一个 SQL 表达式应用到全部选中行」
 * —— 「把 created_at 全改成 NOW()」正是这条功能的原始动机。
 */
export function planBatchEdit(input: {
  column: number;
  rows: readonly number[];
  value: string | null;
  valueKind?: 'literal' | 'sql-expr';
}): { row: number; col: number; value: string | null; valueKind: 'literal' | 'sql-expr' }[] {
  const kind = input.valueKind ?? 'literal';
  return input.rows.map((row) => ({ row, col: input.column, value: input.value, valueKind: kind }));
}

// ---------- A15 网格视图持久化（列宽/显隐/换行的表级记忆） ----------

export interface GridViewState {
  /** 每列覆盖宽度（按列名；缺省列用代码默认宽） */
  widths: Record<string, number>;
  /** 隐藏列名列表 */
  hidden: string[];
  /** 单元格换行开关（A18） */
  wrap: boolean;
  /**
   * V8：冻结的**可见列**数（0/缺省 = 不冻结）。
   *
   * 口径是「可见列序号」而不是原始列下标 —— 冻结是视觉概念（钉在左边的是
   * 用户看得见的前 N 列），隐藏列变化时冻结数不需要跟着换算。
   *
   * 可选：旧快照与只关心列宽/显隐的调用方不必提供；restoreGridView 读回时
   * 永远补齐成数字（缺省 0），所以**读侧不需要再防一层 undefined**。
   */
  frozenCount?: number;
}

/** V8：冻结列数上限（防呆：全冻结等于没有横向滚动，失去意义） */
export const FROZEN_COUNT_MAX = 8;

export const GRID_VIEW_STORAGE_PREFIX = 'dbstudio.grid.view.v1:';

/** 存储键：`dbstudio.grid.view.v1:<connId>:<database>:<table>` */
export function gridViewStorageKey(memoryKey: string): string {
  return GRID_VIEW_STORAGE_PREFIX + memoryKey;
}

/**
 * 序列化网格视图状态（A15）。写入前先规范化（宽度 clamp、hidden 去重），
 * 保证 localStorage 里永远是合法数据 —— 读取端可以少防一层。
 */
export function serializeGridView(state: GridViewState): string {
  const widths: Record<string, number> = {};
  for (const [name, w] of Object.entries(state.widths ?? {})) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof w !== 'number' || !Number.isFinite(w)) continue;
    widths[name] = Math.min(2000, Math.max(COLUMN_WIDTH_MIN, Math.floor(w)));
  }
  const hidden: string[] = [];
  if (Array.isArray(state.hidden)) {
    for (const h of state.hidden) {
      if (typeof h === 'string' && h.length > 0 && !hidden.includes(h)) hidden.push(h);
    }
  }
  return JSON.stringify({
    widths,
    hidden,
    wrap: state.wrap === true,
    frozenCount: clampFrozenCount(state.frozenCount),
  });
}

/**
 * V8：把「冻结数」钳到合法区间。
 *
 * visibleCount - 1 是上限的另一个约束：至少留 1 列可横向滚动，
 * 否则「冻结全部列」= 网格失去滚动能力，冻结本身也就没有意义了。
 * 非数字 / 负数 / NaN 一律退化为 0（不冻结）。
 */
export function clampFrozenCount(n: unknown, visibleCount?: number): number {
  const raw = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const hardMax = visibleCount === undefined ? FROZEN_COUNT_MAX : Math.max(0, Math.min(FROZEN_COUNT_MAX, visibleCount - 1));
  return Math.min(hardMax, Math.floor(raw));
}

/**
 * V8：「冻结到此列」的落点换算。
 *
 * 输入是**原始列下标**（列头右键菜单拿到的 originalIndex），输出是可见列数 ——
 * 隐藏列（A5）不占冻结位，所以要用「该列之前的可见列个数 + 1」。
 * 该列自身被隐藏 → 返回 0（不该出现这种情况，防御性退化）。
 */
export function frozenCountForColumn(
  visibleOriginalIndexes: readonly number[],
  originalIndex: number,
): number {
  const pos = visibleOriginalIndexes.indexOf(originalIndex);
  if (pos < 0) return 0;
  return clampFrozenCount(pos + 1);
}

/**
 * 从 localStorage 读回网格视图状态（A15）。
 *
 * 损坏数据**降级不抛异常**：JSON 解析失败返回 null；单字段类型错则丢弃该字段
 * （用默认值补齐），其余字段照常恢复 —— 半份有效数据也比全部丢失好。
 */
export function restoreGridView(raw: string | null | undefined): GridViewState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const widths: Record<string, number> = {};
  if (typeof obj.widths === 'object' && obj.widths !== null) {
    for (const [name, w] of Object.entries(obj.widths as Record<string, unknown>)) {
      if (typeof name === 'string' && name.length > 0 && typeof w === 'number' && Number.isFinite(w)) {
        widths[name] = Math.min(2000, Math.max(COLUMN_WIDTH_MIN, Math.floor(w)));
      }
    }
  }

  const hidden: string[] = [];
  if (Array.isArray(obj.hidden)) {
    for (const h of obj.hidden) {
      if (typeof h === 'string' && h.length > 0 && !hidden.includes(h)) hidden.push(h);
    }
  }

  // V8：frozenCount 是后加字段 —— 旧快照没有它，缺省 0（不冻结），不视为损坏
  return { widths, hidden, wrap: obj.wrap === true, frozenCount: clampFrozenCount(obj.frozenCount) };
}
