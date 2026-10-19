/**
 * 数据网格 —— 全产品最核心的组件。
 *
 * 三条来自实测/评审的硬约束，改这个文件时不要违反：
 *
 *  1. **只解可视区**：滚动时调 `decodeRange`，绝不 `decodeAll` / `materialize`。
 *  2. **行 DOM 池化**：S1 探针用固定 DOM 池做到 120.5 FPS。React 里用绝对定位的
 *     行 + `key=行号`，只渲染可视区 + 缓冲，不创建滚动路径上的新对象。
 *  3. **能否编辑必须问 `isEditable()`**：无主键/唯一键的表网格只读（B5 红线）。
 *     本组件不自己判有无主键 —— 判断逻辑在 core-mutation，只有一处。
 *
 * 本轮新增（2026-09-26 网格 A，条目编号见竞品迭代清单）：
 *  - A1  ⌘F 结果集内查找：分块扫描（每块 ≤2000 行，块间 setTimeout 让出主线程）
 *  - A5  顶部细工具栏 + 列显示/隐藏选择器（隐藏列不渲染，回调仍传原始列索引）
 *  - A7  列宽拖拽 + 双击自适应（只量可视区 ≤200 行样本）
 *  - A8  选中区聚合统计（解码上限 2 万格）
 *  - A15 列宽/显隐/换行按 memoryKey 持久化（localStorage）
 *  - A16 跳转到行
 *  - A18 换行显示开关（行高保持固定 —— 虚拟滚动约束，见 CSS 注释）
 *  - C4  列注释进入表头 title
 *  - F5  选中统计回调 onSelectionSummary
 *
 * 网格 B 追加（编辑态，2026-09-26）：
 *  - A2  ⌥0 设 NULL：再按一次 = 清除本格脏改动（幂等语义，见 setCellNull 注释）
 *  - A3  单元格右键菜单（grid/CellContextMenu.tsx）
 *  - A4  ⌘D 插入复制行：经 onDuplicateRow 上抛，App 侧用 core-mutation 构造脏行
 *  - A17 ⌘C 复制改为组件内处理：选中区（无选区退化聚焦行），默认 TSV，
 *        其余格式从右键菜单选；复制上限 2 万格（COPY_CELL_LIMIT）
 *
 * 网格 C 追加（行号 gutter，2026-09-27，竞品清单 A19-A22）：
 *  - A19 行号列：sticky 左侧钉住（宽表横滚不脱锚），点击选中整行、
 *        Cmd+点击多选、Shift+点击/拖动范围选；行勾选优先于矩形选区参与复制
 *  - A20 复制为 INSERT/UPDATE 带真实值（core-clipboard sqlLiteral）；
 *        UPDATE 需宿主传 locateColumns（主键/唯一键），查询结果无定位列则禁用
 *  - A21 列头右键菜单：显式升/降序、复制列名、自适应列宽、隐藏此列（补全 A5）
 *  - A22 单元格右键快速筛选（等于/不等于/包含/为 NULL），走既有 FilterModel 链路
 *
 * 网格 D 追加（V14/V15/V19/V22，2026-09-29）：
 *  - V14 列头显示数据类型（**默认关**，开关在列头右键菜单，状态存 localStorage）
 *  - V15 JOIN 结果列头的来源表名 tooltip（原生 title + 自定义 hover 浮层各一份）
 *  - V19 按列分组行条纹（纯逻辑复用 groupStripe.ts，行渲染只做 O(1) 查表）
 *  - V22 「加载更多」/ 大表警告提示条（数字口径全在 core-grid-view）
 *
 * 性能纪律边界：查找/聚合/自适应/复制都是**用户主动触发**，允许分配，但必须分块
 * 让出主线程；滚动路径上依旧零分配（匹配高亮用数字编码 key，不拼字符串；
 * 分组条纹用模块级常量查表，不拼字符串）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SelectionModel,
  computeVisibleRange,
  rowHeightPx,
  selectionStats,
  findMatches,
  estimateColumnWidth,
  aggregateSelection,
  serializeGridView,
  restoreGridView,
  gridViewStorageKey,
  clampFrozenCount,
  frozenCountForColumn,
  batchEditTarget,
  planBatchEdit,
  canTranspose,
  COLUMN_WIDTH_MIN,
  type RowHeightMode,
  type SortDirection,
  type SortSpec,
  type CellPos,
  type FindMatch,
  type SelectionAggregate,
} from '@dbstudio/core-grid-view';
import { validateSqlExpression } from '@dbstudio/core-mutation';
import {
  rowsFromSelection,
  serializeCopy,
  cellToDisplay,
  buildInList,
  IN_LIST_LIMIT,
  type CopyFormat,
} from '@dbstudio/core-clipboard';
import { IconSearch, IconColumns, IconWrap, IconJumpDown, IconX, IconCopy, IconFreeze, IconTranspose, IconFn, IconLink, IconBatchEdit, IconPlus, IconClock, IconUndo, IconRedo } from '../ui/icons';
// T11/T50：键位展示串的唯一来源（本文件的 ⇧⌘E / ⌘0 副本已按裁定改掉）
import { displayOf } from '../../../src/shared/action-catalog.js';
import { CellContextMenu, type CellContextMenuState } from './CellContextMenu';
import { HeaderContextMenu, type HeaderContextMenuState } from './HeaderContextMenu';
import { TransposedView } from './TransposedView';
import { ForeignKeyPicker } from './ForeignKeyPicker';
import { buildGroupStripes, stripeClassAt, type GroupStripeClass } from './groupStripe';
import { isImeComposing } from '../ui/imeGuard';
import {
  columnValues,
  columnTypeText,
  loadMoreState,
  loadShowColumnTypes,
  matchColumnDescriptor,
  saveShowColumnTypes,
  sourceTableOf,
  type GridDataSource,
} from './useGridData';
import { ValueEditorPopover } from './editors/ValueEditorPopover';
import { EnumCellEditor } from './editors/EnumCellEditor';
import {
  acceptsEmptyString,
  canDiscardCell,
  canEditValue,
  canUseDefault,
  describeDefaultAction,
  resolveColumnTypeInfo,
  resolveValueEdit,
  type CellEditContext,
  type CellValueAction,
  type ColumnTypeInfo,
  type MenuItemState,
} from './editors/valueEditorModel';

/**
 * T11/T50：表达式模式的键位展示串从动作目录取。
 * 手写副本必然漂移 —— 本文件先前到处写着 ⇧⌘E，已被 T11 裁定让位给「导出数据」。
 *
 * （「设为 NULL」的 ⌥0 展示串挂在 CellContextMenu 里，用同一条目录数据。）
 */
const EXPR_MODE_KEY = displayOf('grid-expr-mode') ?? '⌘E';

/**
 * T36：拿不到类型信息时的兜底 —— 模块级常量（每次渲染新建会让 useMemo 全失效）。
 */
const UNKNOWN_COLUMN_INFO: ColumnTypeInfo = { kind: 'unknown', base: '', enumValues: null };

/** T25：菜单还没打开时的占位状态（禁用 + 空原因） */
const DISABLED_STATE: MenuItemState = { enabled: false, reason: '' };


export interface GridColumn {
  name: string;
  /** 用于右键/详情面板展示。**MySQL COLUMN_TYPE 原文**（ENUM 形如 `enum('a','b')`） */
  dataType: string;
  width: number;
  isPrimaryKey?: boolean;
  /** C4：列注释，进入表头 tooltip（名称 · 类型 · 注释） */
  comment?: string;
  /**
   * T25：数据库默认值（information_schema 的 COLUMN_DEFAULT 原文）。**可选**。
   * - `undefined` = 宿主未透传（**未知**）→ 不因"可能没有默认值"而禁用；
   * - `null` = 已确认没有 DEFAULT 子句 → 「使用默认值」禁用并给原因。
   */
  defaultValue?: string | null;
  /**
   * T36：ENUM/SET 的合法值（DDL 顺序）。**可选** —— 不给时从 `dataType` 串解析
   *（`enum('a','b')`）；两处都拿不到 → ENUM 入口禁用并给原因（红线 6：不造假下拉）。
   */
  enumValues?: string[] | null;
  /**
   * T25/T36：列是否可空。**可选** —— 未知时「设为 NULL」保持可用，由数据库执行时判定。
   */
  nullable?: boolean | null;
}

/**
 * V9：外键列的导航信息（由宿主从 backend 取，缺省 = 该表没有外键）。
 *
 * 只放渲染层需要的最小字段：跳转要「引用库表 + 引用列」，下拉要「展示列」。
 * 🔴 网格**不自行判断**某列能不能跳（契约 2）：宿主没给 fk 就不画链接。
 */
export interface GridForeignKey {
  /** 本表列名（复合外键的首列；网格按列名单格导航） */
  column: string;
  referencedDatabase: string;
  referencedTable: string;
  /** 引用列（= 目标表的定位列） */
  referencedColumn: string;
  /** 展示列（下拉的 label）；null = 用引用列本身 */
  displayColumn: string | null;
}

export interface DataGridProps {
  source: GridDataSource;
  columns: GridColumn[];
  rowHeightMode?: RowHeightMode;
  editable: boolean;
  /** 可编辑但存在歧义（可空唯一键）时的提示 */
  editWarning?: string | null;
  sorts: SortSpec[];
  /**
   * additive = Shift+点击多列循环；direction 由列头右键菜单给显式方向
   * （null = 清除该列排序）。三态循环语义仍在普通点击路径上。
   */
  onSortChange: (column: string, additive: boolean, direction?: SortDirection | null) => void;
  /** A21：列头是否可排序（查询结果网格排序是 no-op，传 false 隐藏菜单排序项） */
  sortable?: boolean;
  onSave: () => void;
  /**
   * V1：⌘V 从剪贴板粘贴多行。anchor = **当前焦点单元格**（粘贴从这一格按列对齐，
   * 与 Excel/DataGrip 一致）。宿主给空函数 → ⌘V 静默失效（V1 断层的成因）。
   * ⚠️ 网格自身不做可编辑判定，只读表/只读结果的宿主应在回调里给明确提示，
   * 不允许静默 no-op（否则用户按键无反应，正是本次要修的缺陷）。
   */
  onPaste: (anchor: { row: number; col: number }) => void;
  /**
   * V2：⌘⌫ 删除选中行。参数是**待删除的行号数组**（去重升序，来自行号勾选或
   * 当前矩形选区覆盖的行）。宿主用 core-mutation 的 deletes 走保存预演，
   * 无条件给空函数 → 快捷键静默失效（V1/V2 断层的成因）。
   */
  onDeleteRows: (rows: number[]) => void;
  /**
   * ⚠️ col 是**原始列索引**（columns 全量数组的下标），不是可见列下标 ——
   * 隐藏列（A5）不渲染但仍占数据位，宿主按原始索引取列名才不会错位。
   *
   * V10：valueKind = 'sql-expr' 时 value 是一段 SQL 表达式（NOW() 等），
   * 宿主要把它带进 core-mutation（原样嵌入而不转义）。缺省 = 字面量。
   */
  onCellEdited: (row: number, col: number, value: string | null, valueKind?: 'literal' | 'sql-expr') => void;
  onCellActivated?: (row: number, col: number) => void;
  /**
   * 缺陷 5：右键「查看完整值」→ 宿主弹出 CellValueModal。
   *
   * 🔴 此前这个动作只是调 onCellActivated（把值送进右侧详情面板的「单元格完整值」块）。
   *    那块被换成「表结构语句」之后，若还走 onCellActivated，用户点「查看完整值」
   *    将**什么也不会发生** —— 一个点了没反应的菜单项比没有这个菜单项更糟。
   *    所以另开一条回调：宿主接了才画菜单项，没接就退化为原来的 onCellActivated。
   */
  onInspectCell?: (row: number, col: number) => void;
  /**
   * A2：本格脏改动被清除（⌥0 幂等清除 / 右键「清除本格改动」）后回调，
   * 宿主用它刷新 dirtyCount 角标。设 NULL 本身走 onCellEdited(row, col, null)。
   */
  onCellCleared?: (row: number, col: number) => void;
  /**
   * A4：⌘D / 右键「插入复制行」上抛（row = 被复制行）。App 侧用
   * core-mutation 的 buildDuplicateRowPlan 构造脏行（集成说明见最终报告）。
   * 未接线或只读网格时 ⌘D 静默无效。
   */
  onDuplicateRow?: (row: number) => void;
  /**
   * T19（报告 §5 D16）：新增**空白行**上抛（工具栏 / 行号右键 / 数据菜单共用）。
   *
   * 与 onDuplicateRow 的差别：不需要任何行值 —— 复制行是"抄一行"，新增行是"给一张空表
   * 补一行"，两者在**空表**上只有后者成立（没有行可抄）。
   */
  onAddBlankRow?: () => void;
  /**
   * T38：未保存改动的撤销/重做。
   *
   * 栈在宿主侧（一张表一个），网格只负责把 ⌘Z / ⇧⌘Z 与工具栏按钮转过去。
   * `canUndo/canRedo` 只影响按钮可用状态 —— **快捷键不受它影响**，
   * 因为栈的深度在点击那一刻才确定（宿主 rerender 存在一帧延迟）。
   */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** A17：INSERT/UPDATE 复制格式的限定名上下文（TablePane 透传 tab.database/tableName） */
  database?: string;
  tableName?: string;
  /**
   * A20：UPDATE 复制的定位列（主键/唯一键，宿主用 core-mutation 的 locateColumns
   * 算出 —— 判定只有一处，网格不自判）。缺省 = UPDATE 格式禁用。
   */
  locateColumns?: string[];
  /**
   * A22：单元格右键快速筛选（TablePane → App → 既有 FilterModel/重拉链路）。
   * value = null 表示本格是 NULL（App 映射为 isNull 条件）。未接线时菜单不出现该组。
   */
  onQuickFilter?: (column: string, value: string | null, op: 'eq' | 'ne' | 'contains') => void;
  /**
   * V13：批量编辑条的 Apply。宿主用它把「一列 × 多行」一次性标脏 ——
   * 🔴 不引入新写路径：标脏后仍走既有 core-mutation + SavePreviewModal 逐条预演。
   * 缺省时批量条不出现（查询结果网格等只读场景）。
   */
  onBatchEdit?: (
    cells: { row: number; col: number; value: string | null; valueKind: 'literal' | 'sql-expr' }[],
  ) => void;
  /** V13：批量条 Discard —— 清掉这批格子的脏标记（宿主刷角标） */
  onBatchDiscard?: (cells: { row: number; col: number }[]) => void;
  /** V9：宿主是否只读（连接级只读时批量条/表达式模式要禁用并给原因） */
  readOnly?: boolean;
  /** A15：视图记忆键（`connId:database:table`），缺省则不持久化（静默降级） */
  memoryKey?: string;
  /** A5：可见列变化回调（可选，宿主未接时静默降级） */
  onVisibleColumnsChange?: (names: string[]) => void;
  /** F5：选中统计回报（null = 无选择）；App 状态栏显示「选中 N 行 / M 格」 */
  onSelectionSummary?: (summary: { rows: number; cells: number } | null) => void;
  /**
   * 遗留宿主钩子（可选）：⌘C 已改为网格内部复制选中区（A17），不再依赖宿主。
   * 复制成功后回调一次，宿主只想 toast/统计时用。
   */
  onCopy?: () => void;
  /**
   * V9：本表的外键清单（宿主从 backend 取，缺省 = 没有外键）。
   * 给了才画「跳转」链接与编辑下拉 —— 网格不自行判断某列能否跳（契约 2）。
   */
  foreignKeys?: GridForeignKey[];
  /**
   * V9：点击外键值 → 跳转到引用表的那一行。
   * 宿主负责「新开 tab + 按引用列定位」（走既有 locateStrategy 链路）。
   * value = null 表示本格是 NULL（没有可跳转的目标，网格不画链接）。
   */
  onFollowForeignKey?: (fk: GridForeignKey, row: number, value: string | null) => void;
  /**
   * V9：编辑外键列时拉候选值。返回 null 表示不可用（宿主未接线/引用表拿不到）。
   * 🔴 必须带 limit（宿主侧已钳制），不做全表扫描。
   */
  onLookupForeignKeyValues?: (
    fk: GridForeignKey,
    keyword: string | null,
  ) => Promise<{ items: { value: unknown; label: string }[]; truncated: boolean } | null>;

  // ---- 网格 D（V14 / V15 / V19 / V22）----

  /**
   * V22：结果集被截断（宿主按 limit 截断 / 驱动层 truncated 标记）。
   * 与 estimatedRows / rowLimit 三条一起决定底部提示条；全缺省 = 不显示提示条。
   */
  truncated?: boolean;
  /** V22：估算总行数（InnoDB 近似值，如 SHOW TABLE STATUS 的 TABLE_ROWS）；null/缺省 = 未知 */
  estimatedRows?: number | null;
  /** V22：本次加载的行上限（判定「行数达到 limit」）；缺省用 core-grid-view 的 DEFAULT_PAGE_SIZE */
  rowLimit?: number;
  /**
   * V22：点击「加载更多」（宿主重拉并放宽 limit）。可返回 Promise —— 期间按钮
   * disabled 并显示「加载中…」，防重复点击。
   * **没传 → 按钮不渲染**（提示条只在大表警告命中时出现，绝不画一个点了没反应的按钮）。
   */
  onLoadMore?: () => void | Promise<void>;
  /**
   * V19：按哪一列的值做分组行条纹（连续同值行交替着色）；null / 缺省 = 关闭。
   * 状态由宿主持有（列头右键菜单的切换经 onToggleGroupStripe 上抛）。
   */
  groupStripeColumn?: string | null;
  /**
   * V19：切换分组着色列 —— 传列名 = 按该列着色，传 null = 取消（菜单再点一次）。
   * **没传 → 菜单项禁用、功能保持关闭**（不静默 no-op，也不给网格内部兜底状态，
   * 避免宿主状态与网格状态两处真相）。
   */
  onToggleGroupStripe?: (col: string | null) => void;
}

const OVERSCAN = 10;
/** A1：分块扫描的块大小 —— 每块解码 ≤2000 行后让出主线程 */
const FIND_CHUNK_ROWS = 2000;
/** A7：自适应列宽只量可视区起 ≤200 行样本 */
const AUTOFIT_SAMPLE_ROWS = 200;
/** A8：聚合统计的解码上限（超出显示「仅统计前 2 万格」） */
const AGGREGATE_CELL_LIMIT = 20_000;
/** A7：手动拖拽的宽度上限（自适应上限由 estimateColumnWidth 控制，600） */
const DRAG_WIDTH_MAX = 2000;
/** A19：行号列宽（100 万行 7 位数 + 千分位余量；不随列宽记忆，恒定） */
export const GUTTER_WIDTH = 52;

/**
 * V19：行 className 的条纹后缀查表。
 *
 * 🔴 为什么是「模块级常量 + 下标」而不是 `stripeClassAt(...)` 之后再拼字符串：
 *    行 className 的拼装在滚动热路径上（每秒上千次），`${' ' + cls}` 每渲染一行
 *    就产生一个新字符串。这里把「类名 → 带前导空格的后缀」预存成常量对象，
 *    渲染时只做一次属性读取 —— 零分配、O(1)，与既有 matchSet 数字编码同纪律。
 */
const STRIPE_SUFFIX: Record<GroupStripeClass, string> = {
  '': '',
  'grp-a': ' grp-a',
  'grp-b': ' grp-b',
};

/** V19：分组着色关闭时的取值数组（共享空数组，避免每次渲染新建） */
const NO_VALUES: readonly unknown[] = [];

/**
 * V19：行 className 的分组条纹后缀（带前导空格；关闭时为 ''）。
 *
 * 后缀必须自带空格：className 是手工拼的，漏一个空格会得到 `grid-rowgrp-a`
 * 这种静默失效的类名（浏览器不报错，样式就是不生效，属于最难查的一类）。
 * 单独抽成函数是为了让这条拼装规则进得了单测。
 */
export function rowStripeSuffix(stripes: Uint8Array, rowIndex: number): string {
  return STRIPE_SUFFIX[stripeClassAt(stripes, rowIndex)];
}

/** A8 统计值显示：整数带千分位，小数最多 6 位（avg 常见小数） */
function formatAggValue(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function DataGrid(props: DataGridProps) {
  const {
    source,
    columns,
    rowHeightMode = 'standard',
    editable,
    editWarning,
    sorts,
    onSortChange,
    onSave,
    onPaste,
    onDeleteRows,
    onCellEdited,
    onCellActivated,
    onInspectCell,
    onCellCleared,
    onDuplicateRow,
    onAddBlankRow,
    onUndo,
    onRedo,
    canUndo = false,
    canRedo = false,
    database,
    tableName,
    locateColumns,
    onQuickFilter,
    onBatchEdit,
    onBatchDiscard,
    foreignKeys,
    onFollowForeignKey,
    onLookupForeignKeyValues,
    readOnly = false,
    sortable = true,
    memoryKey,
    onVisibleColumnsChange,
    onSelectionSummary,
    onCopy,
    // 网格 D
    truncated,
    estimatedRows = null,
    rowLimit,
    onLoadMore,
    groupStripeColumn = null,
    onToggleGroupStripe,
  } = props;

  const rowHeight = rowHeightPx(rowHeightMode);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const rowCount = source.totalRows;
  const colCount = columns.length;

  // 选择模型：结果集尺寸变化时 resize，保留仍合法的焦点
  const selectionRef = useRef<SelectionModel | null>(null);
  if (!selectionRef.current) selectionRef.current = new SelectionModel(rowCount, colCount);
  const selection = selectionRef.current;
  const [selVersion, setSelVersion] = useState(0);
  const bumpSelection = useCallback(() => setSelVersion((v) => v + 1), []);

  useEffect(() => {
    selection.resize(rowCount, colCount);
    bumpSelection();
  }, [selection, rowCount, colCount, bumpSelection]);

  // 视口高度：见下方 V12 转置说明（effect 必须在 transposed 声明之后，依赖数组会立即求值）

  const range = useMemo(
    () => computeVisibleRange({ scrollTop, viewportHeight, rowHeight, rowCount, overscan: OVERSCAN }),
    [scrollTop, viewportHeight, rowHeight, rowCount],
  );

  // 只解可视区（约束 1）
  const rows = useMemo(
    () => source.decodeRange(range.start, range.end),
    // selVersion 参与依赖：脏单元格变化后要重解
    [source, range.start, range.end, selVersion],
  );

  const [editing, setEditing] = useState<CellPos | null>(null);
  /**
   * 🔴 `editing` 的同步镜像 —— 用来拦住**同一次编辑被提交两次**。
   *
   * 现场：Enter 提交 → `commitEditValue` 里 `setEditing(null)` 之后又去
   * `viewport.focus()`，输入框随即 blur，而 `onBlur` 那个闭包里的 `editing`
   * 还是**上一帧的值**（React 批处理，state 尚未生效）→ 又提交一次。
   * 表现（真机 e2e 抓到）：一次编辑进两次撤销栈 —— 用户按一次 ⌘Z 脏格还在，
   * 得按两次；重做同理。两次 `onCellEdited` 还会把「动作前状态」覆盖成
   * 「已经是草稿的值」，撤销语义直接失效。
   * 所以：判定与清空都以这个 ref 为准（state 只负责渲染）。
   */
  const editingRef = useRef<CellPos | null>(null);
  const [editValue, setEditValue] = useState('');
  /**
   * V10：单元格编辑的 SQL 表达式模式（DataGrip 2026.2 同款）。
   * 开启后编辑框里的文本按「SQL 表达式」提交（NOW() / amount * 2 原样嵌入），
   * 关闭则是普通字面量。⌘E 在编辑态切换；单元格右键菜单也能进入。
   */
  const [editExprMode, setEditExprMode] = useState(false);
  /** V10：表达式模式下的即时校验结果（null = 合法；否则展示原因并阻止提交） */
  const [editExprError, setEditExprError] = useState<string | null>(null);
  /**
   * V9：外键候选值下拉的锚点（null = 关闭）。
   * 只在**编辑态**出现 —— 浏览时画链接图标，编辑时才给候选值，
   * 否则每次滚动都要为「可能有外键」的列准备浮层，是纯浪费。
   */
  const [fkPicker, setFkPicker] = useState<{ x: number; y: number; width: number } | null>(null);
  /** V9：编辑框引用 —— 选完候选值后把焦点还回输入框（否则后续按键落空） */
  const editorInputRef = useRef<HTMLInputElement | null>(null);

  // ---- A15：视图记忆（列宽 / 显隐 / 换行）----
  // memoryKey 与 tab 实例一一对应（TablePane 常挂 DOM），不支持热切换 ——
  // 若未来出现同一实例换 key，应改为 key 变化时重建组件。
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [wrap, setWrap] = useState(false);
  // ---- V8：冻结列（可见列前 N 列左钉）----
  // 口径是「可见列序号」而非原始下标：冻结是视觉概念，隐藏列变化时不必换算。
  const [frozenCount, setFrozenCount] = useState(0);
  // ---- V12：转置视图开关 ----
  const [transposed, setTransposed] = useState(false);

  /**
   * 视口高度：ResizeObserver 拿真实高度，避免首帧渲染 0 行。
   *
   * 🔴 依赖里必须有 `transposed`（V12 踩到的真 bug）：
   *    转置态下 DataGrid **不渲染** `.grid-viewport`（换成 TransposedView），
   *    但组件实例并不卸载（state 要留着）。于是：
   *      ① 进转置 → viewport 节点被移除，旧 observer 收到 clientHeight=0
   *         → viewportHeight 被写成 0；
   *      ② 退转置 → 新的 viewport 节点挂上来，但 `[]` 依赖的 effect 不会再跑，
   *         **没有任何 observer 在观察它** → viewportHeight 永远停在 0
   *         → computeVisibleRange 返回空区间 → 网格渲染 0 行（一片空白）。
   *    把 transposed 放进依赖，退转置时会重新 observe 新节点并立刻量一次高度。
   *
   *    放在 `transposed` 声明之后：useEffect 的依赖数组在声明处即求值，
   *    写在前面会引用未初始化的绑定（TDZ）。
   */
  useEffect(() => {
    if (transposed) return; // 转置态没有 viewport 可观察
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [transposed]);

  useEffect(() => {
    if (!memoryKey) return;
    const restored = restoreGridView(window.localStorage.getItem(gridViewStorageKey(memoryKey)));
    if (restored) {
      setWidths(restored.widths);
      setHidden(restored.hidden);
      setWrap(restored.wrap);
      // V8：frozenCount 在 GridViewState 里是可选字段（旧快照没有），读回时兜 0
      setFrozenCount(restored.frozenCount ?? 0);
    }
  }, [memoryKey]);

  useEffect(() => {
    if (!memoryKey) return;
    try {
      window.localStorage.setItem(
        gridViewStorageKey(memoryKey),
        serializeGridView({ widths, hidden, wrap, frozenCount }),
      );
    } catch {
      // 隐私模式等写不进去：静默降级为不记忆，不影响本会话功能
    }
  }, [memoryKey, widths, hidden, wrap, frozenCount]);

  // ---- A5：可见列映射 ----
  // 数据层（source.value / onCellEdited）永远按**原始列索引**工作；隐藏列不渲染
  // 但仍占数据位。这里把原始下标跟着列一起带出来，渲染与回调都不用再查一次。
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleColumns = useMemo(
    () => columns.map((col, originalIndex) => ({ col, originalIndex })).filter((v) => !hiddenSet.has(v.col.name)),
    [columns, hiddenSet],
  );

  // 可见列变化回报宿主（回调用 ref 包一层：宿主传内联函数也不会引发重复通知）
  const visibleCbRef = useRef(onVisibleColumnsChange);
  useEffect(() => {
    visibleCbRef.current = onVisibleColumnsChange;
  }, [onVisibleColumnsChange]);
  useEffect(() => {
    visibleCbRef.current?.(visibleColumns.map((v) => v.col.name));
  }, [visibleColumns]);

  /** 生效列宽：用户拖拽/自适应覆盖值优先，否则用代码默认宽 */
  const widthOf = useCallback((c: GridColumn) => widths[c.name] ?? c.width, [widths]);

  // ---- V8：冻结列布局 ----
  /**
   * 冻结段 = 可见列的前 N 列，用**逐列 sticky left** 实现（不拆 DOM 分段）。
   *
   * 为什么敢逐列 sticky：冻结数被 `clampFrozenCount` 钳在 ≤8，
   * left 偏移只有这 ≤8 个值要算（frozenLefts），不是 O(n²)；
   * 且 DOM 顺序与不冻结时**完全一致** —— flex 布局、React key 复用、
   * 拖选按 data-col 命中都不用改结构，只多一个 class 与一个 left。
   *
   * 🔴 冻结列必须**实色底**（红线 11）：--dirty-bg / --sel-bg / --row-hover
   *    都是半透明的，直接当 background 会透出横滚经过的数据列，看起来像
   *    两层数据叠在一起。做法沿用 .gd-rowno 已验证的方案：
   *    background-color = 不透明基色，半透明高亮走 background-image 叠加
   *    （两层都在元素自身合成）。样式见 styles.css 的 .gd-frozen 段。
   */
  const effectiveFrozen = clampFrozenCount(frozenCount, visibleColumns.length);

  /** 每个冻结列的 sticky left（= 行号列宽 + 它左边所有冻结列宽） */
  const frozenLefts = useMemo(() => {
    const out: number[] = [];
    let acc = GUTTER_WIDTH;
    for (let i = 0; i < effectiveFrozen; i++) {
      out.push(acc);
      const c = visibleColumns[i]?.col;
      if (c) acc += widthOf(c);
    }
    return out;
  }, [effectiveFrozen, visibleColumns, widthOf]);

  /** 冻结块总宽（命中测试与 revealCell 都要用它算「被遮挡区」） */
  const frozenWidth = useMemo(() => {
    if (effectiveFrozen === 0) return 0;
    const last = effectiveFrozen - 1;
    const c = visibleColumns[last]?.col;
    return frozenLefts[last] + (c ? widthOf(c) : 0) - GUTTER_WIDTH;
  }, [effectiveFrozen, frozenLefts, visibleColumns, widthOf]);

  /** V8：列头右键「冻结到此列」/「取消冻结」 */
  const freezeUpTo = useCallback(
    (originalIndex: number) => {
      const indexes = visibleColumns.map((v) => v.originalIndex);
      const next = frozenCountForColumn(indexes, originalIndex);
      // 点已经冻结的最后一列 = 取消冻结（Excel/DataGrip 的 toggle 手感）
      setFrozenCount(next === effectiveFrozen && next > 0 ? 0 : next);
    },
    [visibleColumns, effectiveFrozen],
  );

  const toggleColumn = useCallback(
    (name: string) => {
      setHidden((prev) => {
        if (prev.includes(name)) return prev.filter((n) => n !== name);
        // 至少保留 1 列：全隐藏后网格失去任何参照，也不可恢复（菜单本身在列表里）
        if (columns.length - prev.length <= 1) return prev;
        return [...prev, name];
      });
    },
    [columns.length],
  );

  // ---- V14：列头「显示数据类型」开关 ----
  /**
   * 初始值直接读 localStorage（默认关）；变化后写回。
   *
   * 🔴 与 A15 视图记忆同口径：读写都在 try/catch 里静默降级（实现在 useGridData），
   *    且**不挂在 memoryKey 上** —— 这是全局偏好（所有表/所有结果集一致），
   *    不是某张表的视图记忆，混进 GridViewState 会让"换张表偏好就变了"。
   */
  const [showColumnTypes, setShowColumnTypes] = useState(loadShowColumnTypes);
  useEffect(() => {
    saveShowColumnTypes(showColumnTypes);
  }, [showColumnTypes]);
  const toggleShowColumnTypes = useCallback(() => setShowColumnTypes((v) => !v), []);

  // ---- V14/V15：列头的类型文本与来源表名 ----
  /**
   * 两个信息都来自**列式载荷的列描述符**（payload.columns），不是 GridColumn：
   *  - 类型：查询结果列的 dataType 常常是空的（载荷只有 typeCode）；
   *  - 来源表：只有载荷里有（主进程从 mysql2 的 orgTable 透传下来）。
   *
   * 按原始列索引对齐一次并缓存，列头渲染只做下标读取。
   */
  const headerMeta = useMemo(() => {
    const payloadColumns = source.reader.payload.columns;
    return columns.map((c, i) => {
      const d = matchColumnDescriptor(columns, payloadColumns, i);
      return {
        typeText: columnTypeText(c.dataType, d?.typeCode),
        sourceTable: sourceTableOf(d),
      };
    });
  }, [source, columns]);

  // ---- V19：分组行条纹（预计算一次，行渲染 O(1) 查表）----
  const stripeColIndex = useMemo(() => {
    if (!groupStripeColumn) return -1;
    return columns.findIndex((c) => c.name === groupStripeColumn);
  }, [columns, groupStripeColumn]);

  /**
   * 取值数组：换分组列 / 换数据源 / 行数变化才重算。
   *
   * 🔴 刻意**不**把 selVersion 放进依赖：source 是同一个实例（脏改动不换 identity），
   *    而每次点击单元格都会 bumpSelection —— 若跟着重算，10 万行的表每点一格就要
   *    全列解码一次（几十毫秒的卡顿）。代价是编辑后条纹等到重新查询才刷新，
   *    而条纹只是"看分组边界"的视觉辅助，不参与任何数据语义，可以接受。
   */
  const stripeValues = useMemo(
    () => (stripeColIndex >= 0 ? columnValues(source, stripeColIndex) : NO_VALUES),
    [source, stripeColIndex, rowCount],
  );
  /** 1 字节/行的条纹表；关闭时长度 0（stripeClassAt 越界自然返回 ''） */
  const stripes = useMemo(() => buildGroupStripes(stripeValues), [stripeValues]);

  /** V19：菜单切换上抛给宿主（未接线时不会被调用 —— 菜单项是禁用的） */
  const toggleGroupStripe = useCallback(
    (name: string) => {
      onToggleGroupStripe?.(groupStripeColumn === name ? null : name);
    },
    [onToggleGroupStripe, groupStripeColumn],
  );

  // ---- V22：加载更多 / 大表警告 ----
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useMemo(
    () => loadMoreState({ loaded: rowCount, estimated: estimatedRows, truncated, limit: rowLimit }),
    [rowCount, estimatedRows, truncated, rowLimit],
  );

  /**
   * V22：点击「加载更多」。
   *
   * 🔴 防重复点击靠 loadingMore 这道闸门（onLoadMore 是异步重拉，期间再点会并发
   *    两次查询、回来两份数据，用户看到行数乱跳）。用 `Promise.resolve()` 包一层，
   *    同步宿主（返回 void）也能走同一条 finally 复原路径。
   */
  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore) return;
    setLoadingMore(true);
    void Promise.resolve()
      .then(onLoadMore)
      .finally(() => setLoadingMore(false));
  }, [onLoadMore, loadingMore]);

  // ---- A7：列宽拖拽 + 双击自适应 ----
  const beginResize = useCallback((e: React.PointerEvent, name: string, startWidth: number) => {
    // preventDefault 阻止拖拽时选中表头文本；stopPropagation 不让这次按下触发排序
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(DRAG_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, startWidth + (ev.clientX - startX)));
      setWidths((prev) => ({ ...prev, [name]: w }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const autoFitColumn = useCallback(
    (name: string, originalIndex: number) => {
      // 只量可视区起 ≤200 行样本：不为看不见的数据付宽度（用户主动触发，允许分配）
      const start = range.firstVisibleIndex;
      const end = Math.min(rowCount, start + AUTOFIT_SAMPLE_ROWS);
      const chunk = source.decodeRange(start, end);
      const samples = chunk.map((rowVals) => {
        const v = rowVals[originalIndex];
        return v === null || v === undefined ? 'NULL' : String(v);
      });
      setWidths((prev) => ({ ...prev, [name]: estimateColumnWidth(samples, name) }));
    },
    [source, range.firstVisibleIndex, rowCount],
  );

  // ---- A1：结果集内查找 ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<FindMatch[]>([]);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const [searchScanning, setSearchScanning] = useState(false);
  const [searchScannedRows, setSearchScannedRows] = useState(0);
  const searchTimerRef = useRef<number | null>(null);
  /** 已导航过的匹配 key 去重：列宽等无关依赖变化时不反复跳转 */
  const lastNavRef = useRef('');

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => {
    // 关闭即清高亮（matches 清空 → matchSet 清空）；query 保留，重开 ⌘F 可继续
    setSearchOpen(false);
    setSearchMatches([]);
  }, []);

  // 组件卸载时兜底清理定时器（扫描 effect 的 cleanup 已覆盖 query 变化场景）
  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    };
  }, []);

  // 分块扫描：每块 ≤2000 行、setTimeout(0) 让出主线程 —— 绝不一次性 decodeAll（约束 1）
  useEffect(() => {
    if (!searchOpen || searchQuery === '' || rowCount === 0) {
      setSearchMatches([]);
      setSearchScanning(false);
      return;
    }
    let cancelled = false;
    const acc: FindMatch[] = [];
    setSearchMatches([]);
    setSearchScanning(true);
    setSearchScannedRows(0);
    setSearchCurrent(0);
    lastNavRef.current = '';
    const colIdxs = visibleColumns.map((v) => v.originalIndex);

    let pos = 0;
    const step = () => {
      if (cancelled) return;
      const end = Math.min(pos + FIND_CHUNK_ROWS, rowCount);
      const chunk = source.decodeRange(pos, end);
      const found = findMatches(chunk, pos, searchQuery, { columnIndexes: colIdxs });
      if (found.length > 0) {
        acc.push(...found);
        setSearchMatches(acc.slice()); // 拷贝触发渲染：扫描中即有部分结果可用
      }
      pos = end;
      setSearchScannedRows(pos);
      if (pos < rowCount) {
        searchTimerRef.current = window.setTimeout(step, 0);
      } else {
        setSearchScanning(false);
        searchTimerRef.current = null;
      }
    };
    step();

    return () => {
      cancelled = true;
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [searchOpen, searchQuery, rowCount, source, visibleColumns]);

  const nextMatch = useCallback(
    () => setSearchCurrent((i) => (searchMatches.length ? (i + 1) % searchMatches.length : 0)),
    [searchMatches.length],
  );
  const prevMatch = useCallback(
    () => setSearchCurrent((i) => (searchMatches.length ? (i - 1 + searchMatches.length) % searchMatches.length : 0)),
    [searchMatches.length],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        closeSearch();
        viewportRef.current?.focus();
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Enter') {
        if (e.shiftKey) prevMatch();
        else nextMatch();
        e.preventDefault();
      }
    },
    [closeSearch, nextMatch, prevMatch],
  );

  const revealRow = useCallback(
    (row: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const top = row * rowHeight;
      const bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [rowHeight],
  );

  /** 纵向 revealRow + 横向列 reveal（查找命中可能藏在视口右侧之外的列里） */
  const revealCell = useCallback(
    (row: number, originalCol: number) => {
      revealRow(row);
      const el = viewportRef.current;
      if (!el) return;
      const pos = visibleColumns.findIndex((v) => v.originalIndex === originalCol);
      if (pos === -1) return;

      /**
       * V8：冻结列永远钉在左侧，不需要（也不能）靠滚动 reveal —— 直接返回。
       * 滚动列则要避开「行号列 + 冻结块」的遮挡区：可见区左边界是
       * frozenBlockW，命中列必须落在 [frozenBlockW, clientWidth - colW] 内。
       */
      if (pos < effectiveFrozen) return;

      let left = GUTTER_WIDTH;
      for (let i = 0; i < pos; i++) left += widthOf(visibleColumns[i].col);
      const colW = widthOf(visibleColumns[pos].col);
      const right = left + colW;
      const frozenBlockW = GUTTER_WIDTH + frozenWidth;
      // 命中列左边缘被冻结块盖住 → 滚到它正好贴在冻结块右侧
      if (left - el.scrollLeft < frozenBlockW) el.scrollLeft = left - frozenBlockW;
      // 命中列右边缘超出视口 → 滚到它正好贴右
      else if (right - el.scrollLeft > el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [revealRow, visibleColumns, widthOf, effectiveFrozen, frozenWidth],
  );

  // 当前匹配：聚焦 + 滚动 + 高亮（lastNavRef 去重，避免列宽等无关依赖变化时反复跳）
  const currentMatch = searchMatches[searchCurrent] ?? null;
  const currentMatchKey = currentMatch ? `${currentMatch.row}:${currentMatch.col}@${searchCurrent}` : '';
  useEffect(() => {
    if (!searchOpen || !currentMatch) return;
    if (lastNavRef.current === currentMatchKey) return;
    lastNavRef.current = currentMatchKey;
    selection.selectCell({ row: currentMatch.row, col: currentMatch.col });
    bumpSelection();
    revealCell(currentMatch.row, currentMatch.col);
  }, [searchOpen, currentMatch, currentMatchKey, selection, bumpSelection, revealCell]);

  // 匹配高亮集合：数字编码 row*stride+col（原始列数做步长），滚动热路径零字符串分配
  const colStride = columns.length || 1;
  const matchSet = useMemo(() => {
    const s = new Set<number>();
    for (const m of searchMatches) s.add(m.row * colStride + m.col);
    return s;
  }, [searchMatches, colStride]);
  const currentMatchCode = currentMatch ? currentMatch.row * colStride + currentMatch.col : -1;

  // ---- A8：选中区聚合统计（选择变化时计算，用户主动触发允许分配） ----
  const [aggregate, setAggregate] = useState<{ agg: SelectionAggregate; truncated: boolean } | null>(null);
  useEffect(() => {
    const ranges = selection.ranges; // range 快照 API
    if (ranges.length === 0) {
      setAggregate(null);
      return;
    }
    const values: number[] = [];
    let truncated = false;
    outer: for (const r of ranges) {
      for (let row = r.r0; row <= r.r1; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
          if (values.length >= AGGREGATE_CELL_LIMIT) {
            truncated = true;
            break outer;
          }
          // 隐藏列不参与统计（用户看不见的数不该出现在总数里）
          const colName = columns[col]?.name;
          if (colName === undefined || hiddenSet.has(colName)) continue;
          const v = source.value(row, col);
          if (typeof v === 'number') values.push(v);
        }
      }
    }
    const agg = aggregateSelection(values);
    setAggregate(agg ? { agg, truncated } : null);
  }, [selVersion, selection, source, columns, hiddenSet]);

  // ---- F5：选中统计回报（ref 包回调，只随 summary 值变化触发） ----
  const summaryCbRef = useRef(onSelectionSummary);
  useEffect(() => {
    summaryCbRef.current = onSelectionSummary;
  }, [onSelectionSummary]);
  const selectionSummary = useMemo<{ rows: number; cells: number } | null>(() => {
    // A19：统计口径覆盖行号勾选 —— 并集行数，格数 = 选区格数 + 未覆盖勾选行 × 列数
    const rs = selection.ranges;
    const rowSel = selection.selectedRows;
    if (rs.length === 0 && rowSel.length === 0) return null;
    return selectionStats(rs, rowSel, columns.length);
  }, [selection, selVersion, columns.length]);
  useEffect(() => {
    summaryCbRef.current?.(selectionSummary);
  }, [selectionSummary]);

  // ---- V9：外键映射（列名 → 外键信息）----
  // 宿主没传 foreignKeys（或该表没外键）时 map 为空 → 不画链接、不给下拉。
  // 🔴 网格不自行判断某列能否跳转（契约 2）：判定权在宿主（它才有引用表的元数据）。
  const fkByColumn = useMemo(() => {
    const m = new Map<string, GridForeignKey>();
    for (const fk of foreignKeys ?? []) m.set(fk.column, fk);
    return m;
  }, [foreignKeys]);

  // ---- V13：批量编辑条（选中多行同一列 → Apply/Discard）----
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchValue, setBatchValue] = useState('');
  const [batchExprMode, setBatchExprMode] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  /**
   * 当前选区能否批量编辑：可编辑 + 宿主接了 onBatchEdit + 命中「一列 × 多行」。
   * 判定完全走 core-grid-view 的 batchEditTarget（与复制/删除同一口径）。
   */
  const batchTarget = useMemo(
    () =>
      editable && onBatchEdit
        ? batchEditTarget(selection.selectedRows, selection.ranges, selection.focus.col, rowCount)
        : null,
    // selVersion 参与：选区变化才重算
    [editable, onBatchEdit, selection, selVersion, rowCount],
  );

  const batchColumn = batchTarget ? columns[batchTarget.column] : null;

  const openBatch = useCallback(() => {
    if (!batchTarget) return;
    setBatchValue('');
    setBatchExprMode(false);
    setBatchError(null);
    setBatchOpen(true);
  }, [batchTarget]);

  const closeBatch = useCallback(() => {
    setBatchOpen(false);
    setBatchError(null);
    viewportRef.current?.focus();
  }, []);

  /**
   * V13 Apply：把「一列 × 多行」一次性标脏。
   *
   * 🔴 不引入新写路径 —— 只调 onBatchEdit 让宿主标脏，落库仍走既有
   * core-mutation + SavePreviewModal 逐条预演（头号红线）。
   * 表达式模式下先过与单元格编辑同一套 validateSqlExpression（fail-closed）。
   */
  const applyBatch = useCallback(() => {
    if (!batchTarget || !onBatchEdit) return;
    const value = batchValue;
    if (batchExprMode) {
      const reason = validateSqlExpression(value).reason ?? (value.trim() === '' ? 'SQL 表达式不能为空' : null);
      if (reason) {
        setBatchError(reason);
        return;
      }
    }
    const cells = planBatchEdit({
      column: batchTarget.column,
      rows: batchTarget.rows,
      // 与单元格编辑同一套 NULL 约定：输入 NULL / \N = 置空，空串就是空串
      value: batchExprMode
        ? value.trim()
        : value.trim().toUpperCase() === 'NULL' || value.trim() === '\\N'
          ? null
          : value,
      valueKind: batchExprMode ? 'sql-expr' : 'literal',
    });
    onBatchEdit(cells);
    closeBatch();
  }, [batchTarget, batchValue, batchExprMode, onBatchEdit, closeBatch]);

  /** V13 Discard：清掉这批格子的脏标记 */
  const discardBatch = useCallback(() => {
    if (!batchTarget || !onBatchDiscard) {
      closeBatch();
      return;
    }
    onBatchDiscard(batchTarget.rows.map((row) => ({ row, col: batchTarget.column })));
    closeBatch();
  }, [batchTarget, onBatchDiscard, closeBatch]);

  // 选区变了就不再显示旧的批量条（否则「选了别的列，条上还写着上一列」）
  useEffect(() => {
    if (batchOpen && !batchTarget) setBatchOpen(false);
  }, [batchOpen, batchTarget]);

  // ---- A16：跳转到行 ----
  const [jumpValue, setJumpValue] = useState('');
  const submitJump = useCallback(() => {
    const n = Number.parseInt(jumpValue, 10);
    setJumpValue('');
    if (!Number.isFinite(n) || rowCount === 0) return;
    const row = Math.min(Math.max(n - 1, 0), rowCount - 1);
    const el = viewportRef.current;
    if (el) el.scrollTop = row * rowHeight; // (n-1) * rowHeight，clamp 后直接置 scrollTop
    // 焦点单元格设到该行首列（首列 = 第一个可见列的原始索引）
    const firstCol = visibleColumns[0]?.originalIndex ?? 0;
    selection.selectCell({ row, col: firstCol });
    bumpSelection();
    viewportRef.current?.focus();
  }, [jumpValue, rowCount, rowHeight, selection, bumpSelection, visibleColumns]);

  // ---- A2/A17/A4：设 NULL · 选中区复制 · 复制行（网格 B） ----

  /**
   * ⌥0 的幂等语义：
   *  - 当前展示值不是 NULL → 走既有 onCellEdited(row, col, null)：进脏叠加层，
   *    由宿主按既有链路构造 UPDATE/INSERT，保存预演链路完全不变；
   *  - 当前展示值已是 NULL → 清除本格脏改动回到原始值。即「再按一次 ⌥0 =
   *    撤销设 NULL」；原始值本就是 NULL 且无脏改动时是空操作（菜单项在该态禁用）。
   * 只读网格忽略（B5：可编辑判定只有 isEditable 一处，宿主传入的 editable 即其结论）。
   */
  const setCellNull = useCallback(
    (row: number, col: number) => {
      if (!editable) return;
      const cur = source.value(row, col);
      if (cur === null || cur === undefined) {
        source.clearCell(row, col);
        onCellCleared?.(row, col);
      } else {
        onCellEdited(row, col, null);
      }
      bumpSelection();
    },
    [editable, source, onCellEdited, onCellCleared, bumpSelection],
  );

  /**
   * T25：「撤销本格」= 清掉本格的待提交改动，回到库中原值。
   * 与 ⌥0 的幂等清除同义；只读网格也允许（撤销只是丢弃本地改动，不产生写）。
   */
  const clearCellDirty = useCallback(
    (row: number, col: number) => {
      source.clearCell(row, col);
      onCellCleared?.(row, col);
      bumpSelection();
    },
    [source, onCellCleared, bumpSelection],
  );

  /**
   * V2：算出「⌘⌫ 该删哪些行」并上抛。
   *
   * 口径优先级与复制一致（行勾选 > 矩形选区 > 聚焦行）—— 用户点了行号就是
   * 明确要删那几整行；只调了单个格子时应删它所在行（Excel/DataGrip 习惯）。
   * 用户主动触发，允许分配（不在滚动热路径上）。
   */
  const deleteSelectedRows = useCallback(() => {
    const set = new Set<number>(selection.selectedRows);
    if (set.size === 0) {
      for (const r of selection.ranges) {
        for (let i = r.r0; i <= r.r1; i++) set.add(i);
      }
    }
    if (set.size === 0) set.add(selection.focus.row);
    const rows = [...set].filter((r) => r >= 0 && r < rowCount).sort((a, b) => a - b);
    if (rows.length === 0) return;
    onDeleteRows(rows);
  }, [selection, rowCount, onDeleteRows]);

  /**
   * A17/A19：复制选中区（用户触发，允许逐格解码）。优先级：
   * **行号列勾选的行 > 矩形选区（取最近一块）> 聚焦行** —— 用户点了行号
   * 就是明确要复制那几整行。单次上限 COPY_CELL_LIMIT（2 万格）防 ⌘A
   * 十万行全量解码卡死渲染进程。
   * INSERT/UPDATE 格式需要 database/tableName 限定名，缺省返回空串 = 不可复制。
   *
   * @param includeHeader TSV/CSV 是否在首行输出列名。**默认 false**（2026-09-29
   *        用户反馈：复制只要值）。⌘C 走默认（纯值），右键菜单另给「含列名」两项。
   */
  const copySelection = useCallback(
    (format: CopyFormat, includeHeader = false): boolean => {
      const res = rowsFromSelection({
        ranges: selection.ranges,
        focusRow: selection.focus.row,
        selectedRows: selection.selectedRows,
        rowCount,
        colCount: columns.length,
        columnIndexes: visibleColumns.map((v) => v.originalIndex),
        valueAt: (r, c) => source.value(r, c),
      });
      if (res.rows.length === 0) return false;
      const names = res.columnIndexes.map((i) => columns[i]?.name ?? `列${i + 1}`);
      const text = serializeCopy({
        format,
        columns: names,
        rows: res.rows,
        database,
        table: tableName,
        locateColumns,
        includeHeader,
      });
      if (!text) return false;
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      return true;
    },
    [selection, source, columns, visibleColumns, rowCount, database, tableName, locateColumns],
  );

  // ---- A5：列选择器下拉（点面板外关闭） ----
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (colMenuAnchorRef.current && !colMenuAnchorRef.current.contains(e.target as Node)) {
        setColMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [colMenuOpen]);

  const focus = selection.focus;

  /**
   * V10：表达式模式的即时校验。
   *
   * 用 core-mutation 的 validateSqlExpression（与保存链路同一个函数）——
   * 两处口径必须一致，否则「编辑时说不合法、保存时却通过了」这类分裂
   * 会让用户对安全层失去信任。
   */
  const validateExpr = useCallback((raw: string): string | null => {
    if (raw.trim() === '') return 'SQL 表达式不能为空';
    return validateSqlExpression(raw).reason;
  }, []);

  /**
   * V10：切换表达式模式。
   *
   * 🔴 只在**编辑态**可切（⌘E / 右键菜单）：模式是「这一次输入的解释方式」，
   * 不是单元格的持久属性 —— 挂在焦点格上会让用户切走再切回时状态莫名变化。
   * 切到表达式模式时：清掉 NULL 字面量的解释（表达式里 NULL 就是 SQL 的 NULL，
   * 不该被当成「设为空值」的输入约定），并立刻校验一次当前文本。
   */
  const toggleExprMode = useCallback(() => {
    if (!editing) return;
    setEditExprMode((prev) => {
      const next = !prev;
      setEditExprError(next ? validateExpr(editValue) : null);
      return next;
    });
  }, [editing, editValue, validateExpr]);

  /**
   * 提交本次编辑。返回 true = 已提交（编辑态关闭），false = 被拦下（留在编辑态）。
   *
   * 🔴 为什么必须返回布尔值而不是让调用方读 editExprError：
   *    键盘处理是同一个事件闭包，setState 之后闭包里的 editExprError
   *    还是旧值 —— 用「陈旧状态」决定是否移动焦点，会在第一次提交失败后
   *    把焦点错误地推走（真机上表现为「表达式写错还跳了格」）。
   */
  /**
   * 提交一个值（不含校验）—— 编辑器/下拉/右键动作共用这一条出口。
   * 返回值语义与 commitEdit 一致（true = 已提交并关闭编辑态）。
   */
  const commitEditValue = useCallback(
    (value: string | null, valueKind: 'literal' | 'sql-expr'): boolean => {
      // 防重入：同一格的一次编辑只能落一次（见 editingRef 的说明）
      if (!editing || editingRef.current === null) return false;
      editingRef.current = null;
      onCellEdited(editing.row, editing.col, value, valueKind);
      setEditing(null);
      setEditExprMode(false);
      setEditExprError(null);
      bumpSelection();
      // 焦点回到视口：否则编辑器卸载后焦点落回 body，后续方向键/⌘C 全失效
      viewportRef.current?.focus();
      return true;
    },
    [editing, onCellEdited, bumpSelection],
  );

  const commitEdit = useCallback((): boolean => {
    if (!editing) return false;
    const raw = editValue;

    // V10：表达式模式先过结构校验，不合法就**不提交**（fail-closed）——
    // 与保存链路的 validateSqlExpression 同一函数，两层口径一致
    if (editExprMode) {
      const reason = validateExpr(raw);
      if (reason) {
        setEditExprError(reason);
        return false; // 留在编辑态，让用户改（Esc 才是放弃）
      }
      return commitEditValue(raw.trim(), 'sql-expr');
    }

    const isNullLiteral = raw.trim().toUpperCase() === 'NULL' || raw.trim() === '\\N';
    return commitEditValue(isNullLiteral ? null : raw, 'literal');
  }, [editing, editValue, editExprMode, validateExpr, commitEditValue]);

  /** 退出编辑态的统一收尾（Esc / 切换单元格都要清表达式模式，避免状态泄漏到下一格） */
  const cancelEdit = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
    setEditExprMode(false);
    setEditExprError(null);
    setFkPicker(null);
  }, []);

  /**
   * V9：打开外键候选值下拉。
   *
   * 锚点取自触发元素（fx 按钮 / 单元格本身）的视口矩形 —— 不用鼠标坐标，
   * 因为键盘路径（⌥Enter）没有鼠标事件。
   * 表达式模式下不给候选值：候选值是「填一个合法的字面量」，
   * 与「写一段 SQL 表达式」是两种互斥的输入意图，同时开只会让人困惑。
   */
  const openFkPicker = useCallback(
    (anchorEl: HTMLElement | null) => {
      if (!editing || editExprMode) return;
      const colName = columns[editing.col]?.name;
      const fk = colName ? fkByColumn.get(colName) : undefined;
      if (!fk || !onLookupForeignKeyValues) return;
      const r = anchorEl?.getBoundingClientRect();
      setFkPicker({
        x: r ? r.left : 40,
        y: r ? r.bottom + 2 : 80,
        width: r ? r.width : 180,
      });
    },
    [editing, editExprMode, columns, fkByColumn, onLookupForeignKeyValues],
  );

  /** V9：候选值查询（宿主负责真库/降级；这里只做转接，不自己打库） */
  const lookupFkValues = useCallback(
    async (fk: GridForeignKey, keyword: string | null) => {
      if (!onLookupForeignKeyValues) return null;
      return onLookupForeignKeyValues(fk, keyword);
    },
    [onLookupForeignKeyValues],
  );

  const beginEdit = useCallback(
    (pos: CellPos, exprMode = false) => {
      if (!editable) return;
      const cur = source.value(pos.row, pos.col);
      // 已是脏的表达式格：回填表达式原文并直接进表达式模式（改表达式不用重切）
      const kind = source.valueKindOf(pos.row, pos.col);
      const useExpr = exprMode || kind === 'sql-expr';
      setEditValue(cur === null || cur === undefined ? '' : String(cur));
      setEditExprMode(useExpr);
      setEditExprError(null);
      // ref 先同步，state 只负责渲染（提交判据一律看 ref）
      editingRef.current = pos;
      setEditing(pos);
    },
    [editable, source],
  );

  // ---- 键盘（§9.2：全 Cmd，不用 Ctrl） ----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // T13：输入法组合期一律放行 —— 组合中的 Enter 是确认候选词，
      // 不该 commitEdit()、也不该把 Esc 当成「放弃编辑」。
      if (isImeComposing(e)) return;
      const meta = e.metaKey || e.ctrlKey;
      const dir =
        e.key === 'ArrowUp' ? 'up'
        : e.key === 'ArrowDown' ? 'down'
        : e.key === 'ArrowLeft' ? 'left'
        : e.key === 'ArrowRight' ? 'right'
        : null;

      if (editing) {
        if (e.key === 'Escape') {
          cancelEdit(); // 撤销本格改动（含表达式模式）
          viewportRef.current?.focus();
          e.preventDefault();
        } else if (meta && !e.shiftKey && e.key.toLowerCase() === 'e') {
          // V10：切换 SQL 表达式模式。
          // 🔴 T11/T12：原为 ⇧⌘E，与原生菜单「导出数据…」同键 —— macOS 菜单
          //    accelerator 先于页面 keydown，⇧⌘E 实际永远只导出、切不到表达式模式。
          //    改 ⌘E（仅编辑态，不与全局冲突，见 action-catalog.ts）。
          toggleExprMode();
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Enter') {
          // commitEdit 返回 false = 表达式不合法被拦下，留在编辑态、不移动焦点
          if (commitEdit()) {
            selection.navigate('down', {});
            bumpSelection();
          }
          e.preventDefault();
        } else if (e.key === 'Tab') {
          if (commitEdit()) {
            selection.navigate(e.shiftKey ? 'left' : 'right', {});
            bumpSelection();
          }
          e.preventDefault();
        }
        return;
      }

      /**
       * V11：⌥↑ / ⌥↓ 递进选区（DataGrip「Expand Selection」）。
       *
       * 🔴 必须在 `dir` 分支**之前**判定：否则 ⌥↑ 会先被当成普通上移，
       *    焦点跑掉一档再扩选区，手感与 DataGrip 完全不同。
       * ⌥ + ←/→ 不参与（横向递进没有对应的自然语义，留给未来）。
       */
      if (e.altKey && !meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        selection.expandSelection(e.key === 'ArrowUp');
        bumpSelection();
        e.preventDefault();
        return;
      }

      if (dir) {
        selection.navigate(dir, { cmd: meta && !e.shiftKey, shift: e.shiftKey });
        revealRow(selection.focus.row);
        bumpSelection();
        e.preventDefault();
        return;
      }

      if (meta && e.key.toLowerCase() === 'f') {
        // A1：⌘F 打开查找条（焦点不在输入框时才走到这里，不会抢输入框按键）
        openSearch();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && searchOpen) {
        closeSearch();
        e.preventDefault();
        return;
      }
      /**
       * A2：设 NULL / 幂等清除。
       * 🔴 T11/T12：原为 ⌘0，与原生菜单「重置字体」同键 —— 菜单层先拦截，
       *    网格这个键实际按不动。改 ⌥0（编辑中不会走到这里 —— editing 分支已提前返回）。
       *
       * 🔴 必须认 `e.code === 'Digit0'`：macOS 按住 Option 时 `e.key` 是**组合字符**
       *    （US 布局下 Option+0 = 'º'），只判 `e.key === '0'` 会永远收不到。
       *    保留 `e.key === '0'` 作非常规布局/其它平台的兜底。
       */
      if (e.altKey && !meta && (e.code === 'Digit0' || e.key === '0')) {
        setCellNull(selection.focus.row, selection.focus.col);
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'a') {
        selection.selectAll();
        bumpSelection();
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'c') {
        // A17：网格内部复制选中区（默认 TSV，其余格式在右键菜单选），
        // 不再依赖宿主 onCopy —— 那个可选钩子只在复制成功后作通知用。
        if (copySelection('tsv')) onCopy?.();
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'v') {
        // V1：粘贴从当前焦点格开始按列对齐（宿主负责可编辑判定与提示）
        onPaste({ row: selection.focus.row, col: selection.focus.col });
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 's') {
        onSave();
        e.preventDefault();
        return;
      }
      if (meta && e.key === 'Backspace') {
        // V2：⌘⌫ 删除选中行（选区/行勾选口径见 deleteSelectedRows）
        deleteSelectedRows();
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'd') {
        // A4：插入复制行 —— 只准备脏单元格（core-mutation 的 buildDuplicateRowPlan
        // 在宿主侧执行），落库仍走既有保存预演；未接线或只读时静默无效。
        if (editable && onDuplicateRow) onDuplicateRow(selection.focus.row);
        e.preventDefault();
        return;
      }
      /**
       * T19：⌥⌘N 新增空白行。
       * 🔴 必须判 `e.code === 'KeyN'` 只用来确认是「N 键」，键位本身走 catalog 的
       *    `Alt+CmdOrCtrl+N`；这里先做**哨兵校验**：meta + alt 同时按下才认，
       *    否则会把 ⌘N（新建查询）也吞掉。
       */
      if (meta && e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) {
        if (editable && onAddBlankRow) onAddBlankRow();
        e.preventDefault();
        return;
      }
      /**
       * T38：⌘Z 撤销、⇧⌘Z 重做**未保存改动**。
       *
       * 只在网格焦点下生效，且**编辑态提前 return**（上面已有 guard）——
       * 否则会把输入框里的文本撤销劫持成网格撤销，用户改一个字就丢一整批改动。
       */
      if (meta && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) onRedo?.();
        else onUndo?.();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        beginEdit(selection.focus);
        e.preventDefault();
        return;
      }
      if (e.key === ' ') {
        selection.toggleRow(selection.focus.row);
        selection.navigate('down', {});
        revealRow(selection.focus.row);
        bumpSelection();
        e.preventDefault();
      }
    },
    [
      editing,
      commitEdit,
      cancelEdit,
      toggleExprMode,
      selection,
      bumpSelection,
      onCopy,
      onPaste,
      onSave,
      deleteSelectedRows,
      beginEdit,
      openSearch,
      closeSearch,
      searchOpen,
      revealRow,
      setCellNull,
      copySelection,
      onUndo,
      onRedo,
      onDuplicateRow,
      onAddBlankRow,
    ],
  );

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  }, []);

  const onCellMouseDown = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      if (e.button !== 0) return; // 右键走 onCellContextMenu
      // A19：普通左键点击回到「单元格模式」—— 清掉行号勾选，⌘C 才不会
      // 沿用旧的行选择把整行复制出去；Cmd+点击追加块时不掀桌子。
      if (!e.metaKey && !e.ctrlKey) selection.clearRows();
      selection.selectCell({ row, col }, { additive: e.metaKey });
      bumpSelection();
      onCellActivated?.(row, col);
      viewportRef.current?.focus();

      /**
       * V3：鼠标拖选矩形选区（SelectionModel.extendTo 此前渲染层零调用）。
       *
       * 语义与既有选区一致：普通拖选替换选区，⌘ 拖追加选区块（additive）。
       *
       * 🔴 两条纪律：
       *  1. **滚动路径零对象分配** —— 指针移动只做数值运算，命中行/列时直接调
       *     extendTo（内部只写数字），不拼字符串、不建中间数组。
       *  2. 拖动期间**不写 React state**（bumpSelection 每帧调会把 60~120Hz 的
       *     指针事件变成等量重渲染）—— 拖拽中直接操作 DOM 类（见下方 paintDragRange），
       *     松手时才 bump 一次把真实选区落进 React。
       */
      const additive = e.metaKey || e.ctrlKey;
      let lastRow = row;
      let lastCol = col;
      const vp = viewportRef.current;

      /** 拖拽中把矩形选区刷成 CSS 类（零 React 重渲染；仅操作可视行 DOM） */
      const paintDragRange = (c0: number, c1: number) => {
        if (!vp) return;
        const loC = Math.min(c0, c1);
        const hiC = Math.max(c0, c1);
        const body = vp.querySelectorAll<HTMLElement>('.grid-row .grid-cell[data-col]');
        for (const el of body) {
          const origCol = Number(el.dataset.col);
          const on = origCol >= loC && origCol <= hiC;
          el.classList.toggle('gd-drag', on);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (!vp) return;
        const rect = vp.getBoundingClientRect();
        const y = Math.min(Math.max(ev.clientY - rect.top, 0), vp.clientHeight - 1) + vp.scrollTop;
        const r = Math.min(Math.max(0, Math.floor(y / rowHeight)), rowCount - 1);

        /**
         * 横向命中（V8 冻结列改造）：指针位置要分三段解释。
         *
         * 🔴 冻结列是 sticky 的 —— 它的**视觉位置不随 scrollLeft 变化**，
         *    所以「内容坐标」在这块区域里是错的：用 cx + scrollLeft 去命中
         *    冻结列，会在横向滚动后选到完全不同的列（真机才能抓到的错位）。
         *
         *  ① cx < GUTTER_WIDTH                     → 行号列（不参与选区，保持上一列）
         *  ② cx < GUTTER_WIDTH + frozenWidth       → 冻结块，按**客户端坐标**累加
         *  ③ 其余                                   → 滚动区，按内容坐标累加；
         *     且把内容坐标钳到「冻结块右缘」之后 —— 滚到冻结块底下的那些列
         *     视觉上被盖住了，命中它们会让选区跳到看不见的地方。
         *
         * 全程只有数值运算与既有数组下标访问，不新建对象（红线 8）。
         */
        const cx = Math.min(Math.max(ev.clientX - rect.left, 0), vp.clientWidth - 1);
        let c = lastCol;
        if (cx >= GUTTER_WIDTH) {
          const frozenBlockRight = GUTTER_WIDTH + frozenWidth;
          if (effectiveFrozen > 0 && cx < frozenBlockRight) {
            // ② 冻结块：客户端坐标
            let acc = GUTTER_WIDTH;
            c = visibleColumns[effectiveFrozen - 1].originalIndex;
            for (let i = 0; i < effectiveFrozen; i++) {
              const w = widthOf(visibleColumns[i].col);
              if (cx < acc + w) {
                c = visibleColumns[i].originalIndex;
                break;
              }
              acc += w;
            }
          } else {
            // ③ 滚动区：内容坐标，且不越过冻结块右缘
            const minX = frozenBlockRight + vp.scrollLeft;
            const x = Math.max(cx + vp.scrollLeft, minX);
            let acc = GUTTER_WIDTH;
            c = columns.length - 1;
            for (let i = effectiveFrozen; i < visibleColumns.length; i++) {
              const w = widthOf(visibleColumns[i].col);
              if (x < acc + w) {
                c = visibleColumns[i].originalIndex;
                break;
              }
              acc += w;
            }
          }
        }
        if (r === lastRow && c === lastCol) return;
        lastRow = r;
        lastCol = c;
        selection.extendTo({ row: r, col: c }, { additive });
        revealRow(r);
        paintDragRange(lastCol, col); // 起点列 → 当前列
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (vp) {
          for (const el of vp.querySelectorAll<HTMLElement>('.gd-drag')) el.classList.remove('gd-drag');
        }
        bumpSelection(); // 拖拽结束才把最终选区提交给 React
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    // V8：effectiveFrozen / frozenWidth 参与横向命中，必须进依赖
    [selection, bumpSelection, onCellActivated, rowHeight, rowCount, columns.length, visibleColumns, widthOf, revealRow, effectiveFrozen, frozenWidth],
  );

  const onCellDoubleClick = useCallback(
    (row: number, col: number) => beginEdit({ row, col }),
    [beginEdit],
  );

  // ---- A19：行号列（gutter）—— 点选 / Cmd 多选 / Shift 范围选 / 拖选 ----

  /** Shift/拖选的锚点行（plain 点击时更新；Shift 无锚点时退化为单行点选） */
  const rowAnchorRef = useRef<number | null>(null);

  /** 行号点击后焦点落到该行首列（Space/方向键/Enter 的落点）；不碰选区 */
  const focusRowStart = useCallback(
    (row: number) => {
      const firstCol = visibleColumns[0]?.originalIndex ?? 0;
      selection.setFocus({ row, col: firstCol });
    },
    [selection, visibleColumns],
  );

  /** 右键菜单「快速筛选」的值口径：NULL → null（App 映射 isNull），其余展示文本 */
  const displayValueOf = useCallback(
    (row: number, col: number): string | null => {
      const v = source.value(row, col);
      return v === null || v === undefined ? null : cellToDisplay(v);
    },
    [source],
  );

  const onGutterMouseDown = useCallback(
    (e: React.MouseEvent, row: number) => {
      e.preventDefault(); // 行号文本不可选中
      if (e.button !== 0) return; // 右键走 onGutterContextMenu
      if (e.shiftKey && rowAnchorRef.current !== null) {
        selection.clearRanges();
        selection.selectRowRange(rowAnchorRef.current, row);
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd 追加语义：不动已有单元格选区
        selection.toggleRow(row);
        rowAnchorRef.current = row;
      } else {
        // 点选 = 进入「行选模式」：清掉遗留的单元格选区（含构造函数的初始 1×1），
        // 否则它会混进选中统计/聚合条 —— 行选模式下那是噪音
        selection.clearRanges();
        selection.selectRowOnly(row);
        rowAnchorRef.current = row;
      }
      focusRowStart(row);
      bumpSelection();
      viewportRef.current?.focus();

      // 拖选：按住行号纵向滑动 = 范围选（与列宽拖拽同款 window 监听模式）
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const anchor = row;
        let last = row;
        const vp = viewportRef.current;
        const onMove = (ev: PointerEvent) => {
          if (!vp) return;
          const rect = vp.getBoundingClientRect();
          const y = Math.min(Math.max(ev.clientY - rect.top, 0), vp.clientHeight - 1) + vp.scrollTop;
          const r = Math.min(Math.max(0, Math.floor(y / rowHeight)), rowCount - 1);
          if (r !== last) {
            last = r;
            selection.selectRowRange(anchor, r);
            focusRowStart(r);
            bumpSelection();
          }
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }
    },
    [selection, bumpSelection, focusRowStart, rowHeight, rowCount],
  );

  const onGutterContextMenu = useCallback(
    (e: React.MouseEvent, row: number) => {
      e.preventDefault();
      // 右键落在已选行上 → 保持多选（Excel/DBeaver 惯例）；否则收拢为单行
      if (!selection.hasRowSelected(row)) {
        selection.clearRanges();
        selection.selectRowOnly(row);
        rowAnchorRef.current = row;
        focusRowStart(row);
      }
      bumpSelection();
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        row,
        col: 0,
        column: '',
        cellValue: displayValueOf(row, 0),
        rows: selection.selectedRows,
      });
      viewportRef.current?.focus();
    },
    [selection, bumpSelection, focusRowStart, displayValueOf],
  );

  // ---- A3：单元格右键菜单 ----
  const [ctxMenu, setCtxMenu] = useState<CellContextMenuState | null>(null);

  // ---- T25/T36/T37：单元格值编辑浮层 ----
  /**
   * 浮层目标格 + 锚点坐标。
   *
   * 与 `editing`（格内单行输入）刻意分开：浮层是**另一种编辑形态**
   *（长文本换行 / ENUM 下拉 / 日期时间控件），两者互斥 —— 开浮层就退格内编辑，
   * 否则同一格会出现两个输入框互相抢焦点。
   */
  const [valueEditor, setValueEditor] = useState<{
    row: number;
    col: number;
    x: number;
    y: number;
  } | null>(null);

  /** 每列的类型信息（ENUM/日期判定只算一次，列数组变化才重算） */
  const columnInfos = useMemo<ColumnTypeInfo[]>(
    () => columns.map((c) => resolveColumnTypeInfo(c)),
    [columns],
  );

  /**
   * T36/T37：正在编辑的那一格的类型 —— 决定格内是 ENUM 下拉、日期控件入口，
   * 还是普通文本输入框。
   */
  const editingInfo: ColumnTypeInfo | null = editing
    ? columnInfos[editing.col] ?? UNKNOWN_COLUMN_INFO
    : null;
  /** T36：ENUM 列且**拿得到定义值**才给下拉（拿不到就退回文本，绝不假造选项） */
  const editingIsEnum =
    editingInfo?.kind === 'enum' && (editingInfo.enumValues?.length ?? 0) > 0;
  /** T36：ENUM 下拉要区分「当前值是 NULL」与「当前值是空串成员」 */
  const editingCurrentIsNull = !!editing && source.value(editing.row, editing.col) == null;
  /** T37：日期/日期时间/时间列 → 格内多一个"辅助控件"入口 */
  const editingIsDateTime =
    !!editingInfo &&
    (editingInfo.kind === 'datetime' ||
      editingInfo.kind === 'date' ||
      editingInfo.kind === 'time');

  /** 构造某格的编辑上下文（T25 四个动作的判定输入） */
  const contextOf = useCallback(
    (row: number, col: number, column: string): CellEditContext => {
      const c = columns[col];
      const info = columnInfos[col] ?? UNKNOWN_COLUMN_INFO;
      return {
        editable,
        readOnly,
        isInsertRow: row >= source.rowCount,
        column,
        dataType: c?.dataType ?? '',
        cellDirty: source.isDirty(row, col),
        enumValues: info.enumValues,
        nullable: c?.nullable ?? null,
        defaultValue: c?.defaultValue,
      };
    },
    [columns, columnInfos, editable, readOnly, source, selVersion],
  );

  /** T25：四个动作的统一出口（'edit' 由调用方自己开浮层，这里不处理） */
  const applyValueEdit = useCallback(
    (row: number, col: number, action: CellValueAction, ctx: CellEditContext) => {
      const plan = resolveValueEdit(action, ctx);
      if (!plan) return; // 上下文不允许 —— 菜单项本就该是 disabled，这里是第二道防线
      if (plan.kind === 'commit') onCellEdited(row, col, plan.value, plan.valueKind);
      else if (plan.kind === 'discard') clearCellDirty(row, col);
    },
    [onCellEdited, clearCellDirty],
  );

  /** T25/T36/T37：打开某格的值编辑浮层（会退出格内编辑态） */
  const openValueEditor = useCallback(
    (row: number, col: number, x: number, y: number) => {
      cancelEdit();
      setValueEditor({ row, col, x, y });
    },
    [cancelEdit],
  );

  const closeValueEditor = useCallback(() => {
    setValueEditor(null);
    viewportRef.current?.focus();
  }, []);

  /**
   * T25：右键那一格的编辑上下文（四个动作共用一个上下文）。
   *
   * 🔴 与 `rowDirtyCellsForMenu` 同一条纪律：**菜单打开时算一次**，
   *    这样「撤销本格」的 disabled 状态与菜单里其它项读的是同一份快照
   *    （否则「刚编辑完右键」可能出现「按钮可点但点下去没变化」）。
   */
  const ctxEditContext = useMemo<CellEditContext | null>(
    () => (ctxMenu ? contextOf(ctxMenu.row, ctxMenu.col, ctxMenu.column) : null),
    [ctxMenu, contextOf],
  );

  /**
   * T20：菜单打开时，「选中行」上**真实存在**的脏格。
   *
   * 它同时是两件事的输入：
   *  - `canDiscardRows`（没有脏格就不该出现「撤销选中行的改动」—— 出现了就是假 UI）；
   *  - 行级撤销的实际作用对象（只撤销选中行的脏格，别的行原样保留）。
   *
   * 依赖 `selVersion` 是为了让「先撤销再右键」拿到新鲜结果 —— `ctxMenu` 只在打开时变，
   * 光靠它不足以反映中途的脏格变化。
   */
  const rowDirtyCellsForMenu = useMemo(() => {
    if (!ctxMenu) return [] as { row: number; col: number }[];
    const rows = new Set(ctxMenu.rows);
    return source.dirtyCells().filter((c) => rows.has(c.row)).map((c) => ({ row: c.row, col: c.col }));
  }, [ctxMenu, source, selVersion]);

  /**
   * T23：单列 IN 清单 —— 在**菜单打开时**就把它算出来，不是等用户点了再算。
   *
   * 两个理由：
   *  1. 菜单项文案要如实报「几个值 / 有没有截断」—— 用户得在**动手前**知道
   *     这次复制不完整，而不是粘进 SQL 之后才发现少了值；
   *  2. 单列语义必须在菜单层锁死：行号右键（`column === ''`）没有「哪一列」可言，
   *     一律不给这一项 —— 这是报告 §5 D20「明确选区与整行」的直接落实。
   */
  const inListForMenu = useMemo(() => {
    if (!ctxMenu || !ctxMenu.column) return null;
    const i = columns.findIndex((c) => c.name === ctxMenu.column);
    if (i < 0) return null;
    const rows = ctxMenu.rows.length > 0 ? ctxMenu.rows : [ctxMenu.row];
    const res = rowsFromSelection({
      ranges: [],
      focusRow: rows[0],
      selectedRows: rows,
      rowCount,
      colCount: columns.length,
      columnIndexes: [i],
      valueAt: (r, c) => source.value(r, c),
    });
    const values = res.rows.map((r) => r[0]);
    const built = buildInList({ column: ctxMenu.column, values });
    return built.ok ? { col: ctxMenu.column, built } : null;
  }, [ctxMenu, columns, rowCount, source]);

  /** 菜单动作统一收尾：关菜单 + 焦点回视口（规格：动作执行后焦点回视口） */
  const closeCtxAndFocus = useCallback(() => {
    setCtxMenu(null);
    viewportRef.current?.focus();
  }, []);

  /** A21 列头菜单同款收尾 */
  const closeHeadAndFocus = useCallback(() => {
    setHeadMenu(null);
    viewportRef.current?.focus();
  }, []);

  const onCellContextMenu = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      // 右键同时选中该单元格（与树右键行为一致）；不触发 onCellActivated ——
      // 「查看完整值」是菜单里的显式动作，右键本身不该弹详情面板。
      // 注意这里不清行号勾选：右键落在行选区内复制整行 INSERT 是高频路径。
      e.preventDefault();
      selection.selectCell({ row, col });
      bumpSelection();
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        row,
        col,
        column: columns[col]?.name ?? '',
        cellValue: displayValueOf(row, col),
        rows: selection.selectedRows,
      });
      viewportRef.current?.focus();
    },
    [selection, bumpSelection, columns, displayValueOf],
  );

  // ---- A21：列头右键菜单 ----
  const [headMenu, setHeadMenu] = useState<HeaderContextMenuState | null>(null);
  const onHeaderContextMenu = useCallback(
    (e: React.MouseEvent, name: string, originalIndex: number) => {
      e.preventDefault();
      setHeadMenu({ x: e.clientX, y: e.clientY, name, originalIndex });
    },
    [],
  );

  /**
   * V8：列头菜单要的「本列是第几个可见列」。
   * 用可见列序号而不是原始下标 —— 冻结钉住的是**视觉上**左边那几列，
   * 隐藏列不占位（与 frozenCountForColumn 同一口径）。
   */
  const headMenuVisiblePos = useMemo(() => {
    if (!headMenu) return 0;
    return visibleColumns.findIndex((v) => v.originalIndex === headMenu.originalIndex) + 1;
  }, [headMenu, visibleColumns]);

  /**
   * A20：复制整行为 SQL。与 copySelection（选区语义）刻意分开 ——
   * INSERT/UPDATE 永远是**整行语义**（全部可见列）：右键单个单元格直接
   * 「复制为 INSERT」产出 `INSERT INTO t (单列)` 是误导，行勾选优先，
   * 无勾选时取右键所在行。
   */
  const copyRowsAs = useCallback(
    (row: number, format: 'insert' | 'update'): boolean => {
      const rows = selection.selectedRows.length > 0 ? selection.selectedRows : [row];
      const res = rowsFromSelection({
        ranges: [],
        focusRow: rows[0],
        selectedRows: rows,
        rowCount,
        colCount: columns.length,
        columnIndexes: visibleColumns.map((v) => v.originalIndex),
        valueAt: (r, c) => source.value(r, c),
      });
      if (res.rows.length === 0) return false;
      const names = res.columnIndexes.map((i) => columns[i]?.name ?? `列${i + 1}`);
      const text = serializeCopy({
        format,
        columns: names,
        rows: res.rows,
        database,
        table: tableName,
        locateColumns,
      });
      if (!text) return false;
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      return true;
    },
    [selection, source, columns, visibleColumns, rowCount, database, tableName, locateColumns],
  );

  const sortMark = useCallback(
    (name: string) => {
      const i = sorts.findIndex((s) => s.column === name);
      if (i === -1) return null;
      const dir = sorts[i].direction === 'ASC' ? '↑' : '↓';
      const num = sorts.length > 1 ? ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'][i] ?? String(i + 1) : '';
      return `${dir}${num}`;
    },
    [sorts],
  );

  const loadedRowsText = rowCount.toLocaleString('en-US');

  /** V12：转置可用性判定（字段数超上限时按钮禁用并给原因） */
  const transposeGate = useMemo(() => canTranspose(visibleColumns.length), [visibleColumns.length]);

  // ---- V12：转置视图（独立只读组件，不共享纵向虚拟滚动）----
  if (transposed) {
    return (
      <div className="grid">
        {editWarning ? <div className="banner">{editWarning}</div> : null}
        <TransposedView
          source={source}
          columns={columns}
          visibleOriginalIndexes={visibleColumns.map((v) => v.originalIndex)}
          rowHeight={rowHeight}
          onClose={() => setTransposed(false)}
          onCopied={onCopy}
          database={database}
          tableName={tableName}
        />
      </div>
    );
  }

  return (
    <div className="grid">
      {editWarning ? <div className="banner">{editWarning}</div> : null}

      {/* A5：网格顶部细工具栏（不属于滚动区；viewport 顶部让位见 data-grid.css） */}
      <div className="gd-toolbar">
        {/**
         * T19（报告 §5 D16）：新增空白行。
         *
         * 放在工具栏**最前**并加分隔线：它是「我要往这张表里加一条」的第一直觉入口，
         * 且**空表也成立** —— 复制行（⌘D）在空表上没有源行可抄，只有它能用。
         * 禁用时给出原因，不做「能点但没反应」。
         */}
        <button
          type="button"
          className="gd-tool-btn"
          data-testid="btn-add-row"
          title={
            !editable
              ? '该表只读（无主键/唯一键，或连接只读），不能新增行'
              : !onAddBlankRow
                ? '新增空白行（宿主未接线）'
                : `新增空白行（${displayOf('grid-add-row')}）—— 只标脏，落库走保存预演`
          }
          disabled={!editable || !onAddBlankRow}
          onClick={() => onAddBlankRow?.()}
        >
          <IconPlus size={13} />
        </button>
        <div className="gd-tool-sep" />

        {/**
         * T38：撤销 / 重做**未保存改动**。
         *
         * 只在宿主接了回调时渲染（没接就不画按钮，不做「点了没反应」的假 UI）；
         * 栈空时禁用并说明原因。⌘Z / ⇧⌘Z 与这里等价。
         */}
        {onUndo || onRedo ? (
          <>
            <button
              type="button"
              className="gd-tool-btn"
              data-testid="btn-undo"
              disabled={!canUndo}
              title={canUndo ? '撤销上一次未保存改动（⌘Z）' : '没有可撤销的未保存改动'}
              onClick={() => onUndo?.()}
            >
              <IconUndo size={13} />
            </button>
            <button
              type="button"
              className="gd-tool-btn"
              data-testid="btn-redo"
              disabled={!canRedo}
              title={canRedo ? '重做（⇧⌘Z）' : '没有可重做的改动'}
              onClick={() => onRedo?.()}
            >
              <IconRedo size={13} />
            </button>
            <div className="gd-tool-sep" />
          </>
        ) : null}

        <button type="button" className="gd-tool-btn" title="在结果集中查找（⌘F）" onClick={openSearch}>
          <IconSearch size={13} />
        </button>

        {/* A17：网格内复制入口（工具栏按钮复制选中区为 TSV，⌘C 等价） */}
        <button type="button" className="gd-tool-btn" title="复制选中区为 TSV（⌘C；单次上限 2 万格）" onClick={() => copySelection('tsv')}>
          <IconCopy size={13} />
        </button>

        <div className="gd-tool-anchor" ref={colMenuAnchorRef}>
          <button
            type="button"
            className={`gd-tool-btn${hidden.length > 0 ? ' gd-on' : ''}`}
            title="列显示/隐藏"
            onClick={() => setColMenuOpen((v) => !v)}
          >
            <IconColumns size={13} />
          </button>
          {colMenuOpen ? (
            <div className="gd-col-menu">
              <div className="gd-col-menu-head">
                显示列（{visibleColumns.length}/{columns.length}）
              </div>
              {columns.map((c) => (
                <label key={c.name} className="gd-col-menu-item" title={c.comment ?? undefined}>
                  <input
                    type="checkbox"
                    checked={!hiddenSet.has(c.name)}
                    onChange={() => toggleColumn(c.name)}
                  />
                  <span className="gd-col-menu-name">{c.name}</span>
                  <span className="gd-col-menu-type">{c.dataType}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className={`gd-tool-btn${wrap ? ' gd-on' : ''}`}
          title={wrap ? '换行显示：开（行高固定，超过 2 行截断）' : '换行显示：关'}
          onClick={() => setWrap((v) => !v)}
        >
          <IconWrap size={13} />
        </button>

        {/* V8：冻结列（钉住第 1 个可见列；右键列头可「冻结到此列」精确控制） */}
        <button
          type="button"
          className={`gd-tool-btn${effectiveFrozen > 0 ? ' gd-on' : ''}`}
          data-testid="btn-freeze"
          title={
            effectiveFrozen > 0
              ? `已冻结前 ${effectiveFrozen} 列（点击取消；列头右键「冻结到此列」可调数量）`
              : '冻结第 1 列（列头右键「冻结到此列」可冻结更多）'
          }
          disabled={visibleColumns.length < 2}
          onClick={() => setFrozenCount((v) => (clampFrozenCount(v, visibleColumns.length) > 0 ? 0 : 1))}
        >
          <IconFreeze size={13} />
        </button>

        {/* V12：转置视图（宽表竖着看；只读查看模式） */}
        <button
          type="button"
          className="gd-tool-btn"
          data-testid="btn-transpose"
          title={transposeGate.ok ? '转置视图：一行 = 一个字段（只读查看）' : transposeGate.reason ?? '转置不可用'}
          disabled={!transposeGate.ok}
          onClick={() => setTransposed(true)}
        >
          <IconTranspose size={13} />
        </button>

        {/* V13：批量编辑条入口（选中「一列 × 多行」才可点） */}
        <button
          type="button"
          className={`gd-tool-btn${batchOpen ? ' gd-on' : ''}`}
          data-testid="btn-batch-edit"
          title={
            !editable
              ? '该表只读，不支持批量编辑'
              : batchTarget
                ? `批量编辑「${batchColumn?.name ?? ''}」的 ${batchTarget.rows.length} 行`
                : '先选中同一列的多行（行号勾选或纵向拖选）'
          }
          disabled={!batchTarget}
          onClick={() => (batchOpen ? closeBatch() : openBatch())}
        >
          <IconBatchEdit size={13} />
        </button>

        <span className="gd-tool-sep" />

        {/* A16：紧凑跳转行输入 */}
        <span className="gd-jump-wrap" title="输入行号后回车跳转">
          <IconJumpDown size={12} />
          <input
            className="gd-jump"
            type="text"
            placeholder="跳转到行"
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') {
                submitJump();
                e.preventDefault();
              }
            }}
          />
        </span>

        {/* V8：冻结状态回显（宽表下用户需要知道「左边钉住的是哪几列」） */}
        {effectiveFrozen > 0 ? (
          <span className="gd-frozen-badge" data-testid="frozen-badge" title={`已冻结前 ${effectiveFrozen} 个可见列`}>
            <IconFreeze size={11} />
            冻结 {effectiveFrozen} 列
          </span>
        ) : null}

        <span className="gd-tool-spacer" />
      </div>

      {/* V13：批量编辑条（工具栏下方；输入框在 viewport 外，按键不冒泡进网格） */}
      {batchOpen && batchTarget ? (
        <div className="gd-batch-bar" data-testid="batch-bar">
          <span className="gd-batch-label">
            批量编辑 <strong>{batchColumn?.name ?? ''}</strong> · {batchTarget.rows.length} 行
          </span>
          <button
            type="button"
            className={`gd-batch-kind${batchExprMode ? ' gd-on' : ''}`}
            data-testid="batch-expr-toggle"
            title="SQL 表达式模式：填入的值原样嵌进 UPDATE（如 NOW()、amount * 2），不做字符串转义"
            onClick={() => {
              setBatchExprMode((v) => !v);
              setBatchError(null);
            }}
          >
            <IconFn size={11} />
            fx
          </button>
          <input
            className="gd-batch-input"
            type="text"
            autoFocus
            data-testid="batch-input"
            placeholder={batchExprMode ? 'SQL 表达式，如 NOW() / amount * 2' : `填入 ${batchColumn?.name ?? ''} 的新值（NULL = 置空）`}
            value={batchValue}
            onChange={(e) => {
              setBatchValue(e.target.value);
              setBatchError(null);
            }}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') {
                applyBatch();
                e.preventDefault();
              } else if (e.key === 'Escape') {
                closeBatch();
                e.preventDefault();
              }
            }}
          />
          {batchError ? (
            <span className="gd-batch-error" data-testid="batch-error">{batchError}</span>
          ) : null}
          <button type="button" className="gd-batch-btn primary" data-testid="batch-apply" onClick={applyBatch}>
            应用
          </button>
          <button type="button" className="gd-batch-btn" data-testid="batch-discard" onClick={discardBatch}>
            放弃
          </button>
          <button type="button" className="gd-tool-btn" title="关闭（Esc）" onClick={closeBatch}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}

      {/* A1：查找条（grid 顶部浮层；在 viewport 外，输入框按键不会冒泡进网格键盘处理） */}
      {searchOpen ? (
        <div className="gd-search">
          <IconSearch size={12} />
          <input
            className="gd-search-input"
            type="text"
            placeholder="在结果集中查找…"
            value={searchQuery}
            autoFocus
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span className="gd-search-count">
            {!searchQuery
              ? `仅搜索已加载的 ${loadedRowsText} 行`
              : searchScanning
                ? `扫描中 ${searchScannedRows.toLocaleString('en-US')}/${loadedRowsText}`
                : searchMatches.length === 0
                  ? `无匹配 · 仅搜索已加载的 ${loadedRowsText} 行`
                  : `${searchCurrent + 1}/${searchMatches.length} · 仅搜索已加载的 ${loadedRowsText} 行`}
          </span>
          <button
            type="button"
            className="gd-tool-btn"
            title="上一个（Shift+Enter）"
            onClick={prevMatch}
            disabled={searchMatches.length === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="gd-tool-btn"
            title="下一个（Enter）"
            onClick={nextMatch}
            disabled={searchMatches.length === 0}
          >
            ↓
          </button>
          <button type="button" className="gd-tool-btn" title="关闭（Esc）" onClick={closeSearch}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}

      {/* V10：表达式校验报错。
          🔴 必须挂在 grid 根部而不是单元格内 —— .grid-cell 是 overflow:hidden，
          内联报错会被裁掉只剩半行字（用户看到「有红字但读不全」比没提示更糟）。 */}
      {editExprError ? (
        <div className="gd-expr-hint" role="alert" data-testid="expr-error">
          {editExprError}
        </div>
      ) : null}

      {/* A8：选中区聚合浮动条（左下角，不遮右/下滚动条） */}
      {aggregate ? (
        <div className="gd-aggregate" role="status">
          <span className="gd-agg-item">求和 {formatAggValue(aggregate.agg.sum)}</span>
          <span className="gd-agg-item">平均 {formatAggValue(aggregate.agg.avg)}</span>
          <span className="gd-agg-item">最小 {formatAggValue(aggregate.agg.min)}</span>
          <span className="gd-agg-item">最大 {formatAggValue(aggregate.agg.max)}</span>
          <span className="gd-agg-item gd-agg-dim">{aggregate.agg.count} 个数字</span>
          {aggregate.truncated ? <span className="gd-agg-item gd-agg-warn">仅统计前 2 万格</span> : null}
        </div>
      ) : null}

      <div
        className="grid-viewport"
        ref={viewportRef}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="grid-canvas" style={{ height: rowCount * rowHeight }}>
          <div className="grid-header">
            {/* A19：行号列头。sticky 左钉（样式见 .gd-rowno），无排序/显隐职责 */}
            <div
              className="grid-header-cell gd-rowno gd-rowno-head"
              style={{ width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px` }}
              title="行号（点击选中整行，Cmd 多选，Shift 范围选）"
            >
              #
            </div>
            {visibleColumns.map(({ col: c, originalIndex }, vi) => {
              const mark = sortMark(c.name);
              const w = widthOf(c);
              // V8：前 N 个可见列 sticky 左钉（left 由 frozenLefts 预算好，滚动路径零计算）
              const isFrozen = vi < effectiveFrozen;
              const fk = fkByColumn.get(c.name);
              // V14：开关关闭时整段类型文本不渲染（默认关 —— 类型挤占列名空间）
              const typeText = showColumnTypes ? headerMeta[originalIndex].typeText : null;
              // V15：来源表名（JOIN 结果里这一列属于哪张表）；null = 不显示任何 tooltip
              const srcTable = headerMeta[originalIndex].sourceTable;
              return (
                <div
                  key={c.name}
                  className={`grid-header-cell gd-header-cell${isFrozen ? ' gd-frozen' : ''}${
                    isFrozen && vi === effectiveFrozen - 1 ? ' gd-frozen-last' : ''
                  }${srcTable ? ' gd-has-src' : ''}`}
                  style={{
                    width: w,
                    flex: `0 0 ${w}px`,
                    ...(isFrozen ? { left: frozenLefts[vi] } : null),
                  }}
                  // C4：名称 · 类型 · 注释；V9 追加外键引用说明；V15 追加来源表
                  title={`${c.name} · ${c.dataType}${c.comment ? ` · ${c.comment}` : ''}${
                    fk ? `\n外键 → ${fk.referencedDatabase}.${fk.referencedTable}.${fk.referencedColumn}` : ''
                  }${srcTable ? `\n来源表：${srcTable}` : ''}`}
                  onClick={(e) => onSortChange(c.name, e.shiftKey)}
                  onContextMenu={(e) => onHeaderContextMenu(e, c.name, originalIndex)}
                >
                  <span>{c.name}</span>
                  {c.isPrimaryKey ? <span className="pk-badge" title="主键">PK</span> : null}
                  {fk ? (
                    <span className="fk-badge" title={`外键 → ${fk.referencedTable}.${fk.referencedColumn}`}>
                      FK
                    </span>
                  ) : null}
                  {typeText ? <span className="type" data-testid="header-type">{typeText}</span> : null}
                  {mark ? <span className="sort-mark">{mark}</span> : null}
                  {/*
                    V15：自定义来源表 tooltip。原生 title 有一秒延迟且样式不可控，
                    这里补一个 hover 即出的浮层（显示/隐藏全交给 CSS 的 :hover，
                    不引 state —— 不然每次 hover 都要重渲染整个列头）。
                    单表查询也照样显示：用户看得到「来源表：users」才会信任列头。
                  */}
                  {srcTable ? (
                    <span className="gd-src-tip" role="tooltip" data-testid="src-tip">
                      来源表：{srcTable}
                    </span>
                  ) : null}
                  {/* A7：右边缘 4px 热区 —— 拖拽调宽，双击自适应 */}
                  <div
                    className="gd-col-resize"
                    title="拖拽调宽 · 双击自适应"
                    onPointerDown={(e) => beginResize(e, c.name, w)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autoFitColumn(c.name, originalIndex);
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="grid-rows" style={{ transform: `translateY(${range.offsetTop}px)` }}>
            {/* 行数据取自 source（脏单元格叠加层生效），rows 只用来确定区间长度 */}
            {rows.map((_rowValues, i) => {
              const rowIndex = range.start + i;
              const selectedRow = selection.isRowSelected(rowIndex);
              return (
                <div
                  key={rowIndex}
                  /* V19：STRIPE_SUFFIX 查表（O(1)、零分配）；关闭时表长 0 → 空后缀。
                     🔴 斑马纹仍按全局行号算（rowIndex % 2），条纹是**另一条**维度，
                        不改动既有 .alt —— 虚拟滚动下用 nth-child 会错位。 */
                  className={`grid-row${selectedRow ? ' selected' : ''}${rowIndex % 2 === 1 ? ' alt' : ''}${
                    rowStripeSuffix(stripes, rowIndex)
                  }`}
                  style={{ top: rowIndex * rowHeight - range.offsetTop, height: rowHeight }}
                >
                  {/* A19：行号列。sticky 左钉、实色底（盖住横滚的单元格）；
                      不参与复制/选区 —— columnIndexes 始终是原始数据列下标 */}
                  <div
                    className="grid-cell gd-rowno"
                    style={{ width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px` }}
                    onMouseDown={(e) => onGutterMouseDown(e, rowIndex)}
                    onContextMenu={(e) => onGutterContextMenu(e, rowIndex)}
                  >
                    {rowIndex + 1}
                  </div>
                  {visibleColumns.map(({ col: c, originalIndex }, vi) => {
                    const isEditing = editing?.row === rowIndex && editing?.col === originalIndex;
                    const v = source.value(rowIndex, originalIndex);
                    const dirty = source.isDirty(rowIndex, originalIndex);
                    const invalid = source.invalidReason(rowIndex, originalIndex);
                    const isFocus = focus.row === rowIndex && focus.col === originalIndex;
                    const isNull = v === null || v === undefined;
                    // A1 匹配高亮：数字编码，热路径零字符串分配
                    const matchCode = rowIndex * colStride + originalIndex;
                    const isMatch = matchSet.size > 0 && matchSet.has(matchCode);
                    const isCurMatch = matchCode === currentMatchCode;
                    // V8：冻结列（sticky + 实色底）
                    const isFrozen = vi < effectiveFrozen;
                    // V9：外键列且本格非 NULL 才画链接（NULL 没有可跳转的目标）
                    const fk = fkByColumn.get(c.name);
                    const canFollow = !!fk && !!onFollowForeignKey && !isNull;
                    // V10：本格是表达式脏值 → 用 fx 原文展示（区别于字面量的橙色脏底）
                    const isExprDirty = dirty && source.valueKindOf(rowIndex, originalIndex) === 'sql-expr';

                    const cls = [
                      'grid-cell',
                      isNull ? 'null' : '',
                      typeof v === 'number' ? 'numeric' : '',
                      dirty ? 'dirty' : '',
                      isExprDirty ? 'gd-expr' : '',
                      invalid ? 'invalid' : '',
                      isFocus ? 'focus' : '',
                      isMatch ? 'gd-cell-match' : '',
                      isCurMatch ? 'gd-cell-match-current' : '',
                      wrap ? 'gd-cell-wrap' : '',
                      isFrozen ? 'gd-frozen' : '',
                      // V8：冻结块的最后一列画右缘分隔线（用户要看清「钉住的到哪为止」）
                      isFrozen && vi === effectiveFrozen - 1 ? 'gd-frozen-last' : '',
                      canFollow ? 'gd-fk' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');

                    const title = isExprDirty
                      ? `SQL 表达式：${String(v)}`
                      : invalid ?? (isNull ? 'NULL' : String(v));
                    const text = isNull ? 'NULL' : String(v);

                    return (
                      <div
                        key={c.name}
                        className={cls}
                        style={{
                          width: widthOf(c),
                          flex: `0 0 ${widthOf(c)}px`,
                          ...(isFrozen ? { left: frozenLefts[vi] } : null),
                        }}
                        title={title}
                        /* V3：拖选按原始列索引命中（不用 offsetLeft 遍历） */
                        data-col={originalIndex}
                        onMouseDown={(e) => onCellMouseDown(e, rowIndex, originalIndex)}
                        onDoubleClick={() => onCellDoubleClick(rowIndex, originalIndex)}
                        onContextMenu={(e) => onCellContextMenu(e, rowIndex, originalIndex)}
                      >
                        {isEditing ? (
                          <div className="gd-editor-wrap">
                            {/* V10：编辑态左侧的 fx 徽标（表达式模式的视觉锚点） */}
                            <button
                              type="button"
                              className={`gd-expr-toggle${editExprMode ? ' gd-on' : ''}`}
                              data-testid="expr-toggle"
                              title={
                                editExprMode
                                  ? `SQL 表达式模式：开（${EXPR_MODE_KEY} 切回字面量）`
                                  : `切到 SQL 表达式模式（${EXPR_MODE_KEY}）：NOW() 等原样嵌进 UPDATE`
                              }
                              /**
                               * 🔴 必须 stopPropagation，只 preventDefault 不够（真机 e2e 抓到）：
                               * 这两个按钮嵌在 .grid-cell 里，mousedown 会冒泡到单元格的
                               * onCellMouseDown → 那里**显式**调 viewport.focus() 抢焦点 →
                               * 输入框 blur → commitEdit() → 编辑器当场卸载。
                               * preventDefault 只挡浏览器默认焦点行为，挡不住显式 focus()。
                               * 现象是「点 fx 编辑器就消失了」—— 用户根本切不进表达式模式。
                               */
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExprMode();
                              }}
                            >
                              <IconFn size={10} />
                            </button>
                            {/*
                              T36：ENUM 列在格内直接给"只含定义值"的下拉 ——
                              取值集合来自数据库 DDL，用户选不出非法枚举。
                              拿不到定义值（editingIsEnum=false）时退回下面的普通输入框。
                            */}
                            {editingIsEnum ? (
                              <EnumCellEditor
                                values={editingInfo!.enumValues ?? []}
                                /**
                                 * 🔴 当前值是 NULL 就传 null（不是 ''）——
                                 *    空串是 ENUM 的**定义成员**，与 NULL 不是一个意思。
                                 */
                                value={editingCurrentIsNull ? null : editValue}
                                nullable={columns[editing!.col]?.nullable ?? null}
                                onChange={(v) => void commitEditValue(v, 'literal')}
                              />
                            ) : (
                              <input
                                ref={isEditing ? editorInputRef : undefined}
                                className={`grid-cell-editor${editExprMode ? ' gd-expr-input' : ''}`}
                                data-testid="cell-editor"
                                autoFocus
                                value={editValue}
                                placeholder={editExprMode ? 'SQL 表达式' : undefined}
                                onChange={(e) => {
                                  setEditValue(e.target.value);
                                  if (editExprError) setEditExprError(null);
                              }}
                              onBlur={() => {
                                // 表达式模式且非法 → 不提交也不关（点外面不能悄悄丢掉报错）；
                                // 合法则照常提交。字面量模式保持既有 blur 提交语义。
                                if (editExprMode && validateExpr(editValue)) return;
                                // V9：下拉打开时点选候选值会先触发 input blur —— 此时不提交，
                                // 交给候选值的 onPick（否则下拉还没填值就把旧值提交了）
                                if (fkPicker) return;
                                commitEdit();
                              }}
                            />
                            )}
                            {/* V9：外键列的候选值下拉入口（表达式模式下隐藏，两种输入意图互斥） */}
                            {fk && onLookupForeignKeyValues && !editExprMode ? (
                              <button
                                type="button"
                                className="gd-fk-toggle"
                                data-testid="fk-toggle"
                                title={`从 ${fk.referencedTable}.${fk.referencedColumn} 选一个值`}
                                // 同 fx 按钮：stopPropagation 是必需的，preventDefault 挡不住
                                // 单元格 onCellMouseDown 里的显式 viewport.focus()
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openFkPicker(e.currentTarget);
                                }}
                              >
                                <IconLink size={10} />
                              </button>
                            ) : null}
                            {/*
                              T37：日期时间列的辅助控件入口。
                              点它开浮层（日期/时间控件 + 原始文本），格内文本**不消失** ——
                              浮层只是辅助，不是"另一种模式"。
                            */}
                            {editingIsDateTime ? (
                              <button
                                type="button"
                                className="gd-dt-toggle"
                                data-testid="ce-cell-dt-toggle"
                                title="打开日期时间辅助控件（原始文本仍可编辑）"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const r = e.currentTarget.getBoundingClientRect();
                                  openValueEditor(rowIndex, originalIndex, r.left, r.bottom + 2);
                                }}
                              >
                                <IconClock size={10} />
                              </button>
                            ) : null}
                          </div>
                        ) : canFollow ? (
                          /* V9：外键值 = 可点击链接（Cmd+点击或右键「跳转到引用行」） */
                          <span
                            className={wrap ? 'gd-wrap gd-fk-value' : 'gd-fk-value'}
                            title={`外键 → ${fk!.referencedTable}.${fk!.referencedColumn}（右键跳转）`}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              onFollowForeignKey!(fk!, rowIndex, text);
                            }}
                          >
                            <IconLink size={10} />
                            {text}
                          </span>
                        ) : (
                          <span className={wrap ? 'gd-wrap' : undefined}>{text}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/*
        V22：底部「加载更多」提示条。
        🔴 位置刻意放在 .grid-viewport **外面**：滚区内加节点会顶掉虚拟滚动的
        canvas 高度换算（grid-canvas 的高度 = rowCount * rowHeight 是硬约束）。
        放在滚动区下方既不影响可视区计算，也永远是"视线最后一行"的位置。
      */}
      {loadMore.visible ? (
        <div className="gd-load-bar" role="status" data-testid="load-more-bar">
          <span className="gd-load-text">{loadMore.loadedText}</span>
          {loadMore.estimateText ? <span className="gd-load-dim">{loadMore.estimateText}</span> : null}
          {loadMore.warnText ? (
            <span className="gd-load-warn" data-testid="large-table-warn">
              {loadMore.warnText}
            </span>
          ) : null}
          {/* 宿主没接 onLoadMore → 不画按钮（画了点了没反应比不画更糟） */}
          {onLoadMore && loadMore.hasMore ? (
            <button
              type="button"
              className="gd-load-btn"
              data-testid="btn-load-more"
              disabled={loadingMore}
              title={loadingMore ? '正在加载，请勿重复点击' : '再拉一批（放宽 limit 后重查）'}
              onClick={handleLoadMore}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* V9：外键候选值下拉（编辑态 + 外键列才出现；fixed 浮层避开 viewport 裁切） */}
      {fkPicker && editing && fkByColumn.get(columns[editing.col]?.name ?? '') ? (
        <ForeignKeyPicker
          fk={fkByColumn.get(columns[editing.col]?.name ?? '')!}
          anchor={fkPicker}
          lookup={lookupFkValues}
          onPick={(value) => {
            // 填进编辑框但**不立刻提交** —— 用户可能还要改，Enter/失焦才落脏标记
            setEditValue(value ?? '');
            setFkPicker(null);
            editorInputRef.current?.focus();
          }}
          onClose={() => {
            setFkPicker(null);
            editorInputRef.current?.focus();
          }}
        />
      ) : null}

      {/* A3/A19/A20/A22 + V9/V10/V13：单元格/行右键菜单（fixed 定位浮层，挂在 grid 根上跟随主题） */}
      {ctxMenu && ctxMenu.row < rowCount && ctxMenu.col < columns.length ? (
        <CellContextMenu
          menu={ctxMenu}
          hasSelection={selection.ranges.length > 0 || selection.selectedRows.length > 0}
          canSetNull={
            editable &&
            // 「已是原始 NULL」时禁用：设 NULL 是空操作（有脏改动时仍可用 —— ⌥0 的幂等清除）
            !(source.raw(ctxMenu.row, ctxMenu.col) === null && !source.isDirty(ctxMenu.row, ctxMenu.col))
          }
          cellDirty={source.isDirty(ctxMenu.row, ctxMenu.col)}
          canDuplicate={editable && !!onDuplicateRow}
          canAddBlankRow={editable && !!onAddBlankRow}
          canInsert={!!tableName}
          canUpdate={!!tableName && (locateColumns?.length ?? 0) > 0}
          canQuickFilter={!!onQuickFilter && !!ctxMenu.column}
          // V9：外键列且本格非 NULL 才给跳转（判定在 fkByColumn，网格不自判能否跳）
          followLabel={
            ctxMenu.column && ctxMenu.cellValue !== null && onFollowForeignKey && fkByColumn.has(ctxMenu.column)
              ? `→ ${fkByColumn.get(ctxMenu.column)!.referencedTable}.${fkByColumn.get(ctxMenu.column)!.referencedColumn}`
              : null
          }
          canExprEdit={editable && !readOnly && !!ctxMenu.column}
          batchLabel={
            batchTarget && batchColumn
              ? `批量编辑「${batchColumn.name}」（${batchTarget.rows.length} 行）`
              : null
          }
          /**
           * T33（报告 §5 R16）：宿主两条回调一个都没接时不画「查看完整值」。
           * 判定在这里做一次，菜单只负责渲染 —— 与 canInsert/canUpdate 同款纪律。
           */
          canViewFullValue={!!onInspectCell || !!onCellActivated}
          /**
           * T25：四个动作的状态。全部来自 `editors/valueEditorModel` 的纯函数，
           * 组件里不重写一遍判定（避免出现"菜单说能用、点了却没反应"的分裂）。
           */
          editValueState={ctxEditContext ? canEditValue(ctxEditContext) : DISABLED_STATE}
          setEmptyState={ctxEditContext ? acceptsEmptyString(ctxEditContext) : DISABLED_STATE}
          useDefaultState={ctxEditContext ? canUseDefault(ctxEditContext) : DISABLED_STATE}
          useDefaultHint={ctxEditContext ? describeDefaultAction(ctxEditContext) : ''}
          discardCellState={ctxEditContext ? canDiscardCell(ctxEditContext) : DISABLED_STATE}
          setNullDisabledReason={
            readOnly
              ? '该连接已标记为只读：写语句会被主进程 AST 守卫拦截'
              : !editable
                ? '该表无主键/唯一键，无法安全定位行，网格为只读'
                : undefined
          }
          columnDataType={ctxMenu ? (columns[ctxMenu.col]?.dataType ?? '') : ''}
          onClose={() => setCtxMenu(null)}
          onEditValue={() => {
            if (ctxMenu) openValueEditor(ctxMenu.row, ctxMenu.col, ctxMenu.x, ctxMenu.y);
            setCtxMenu(null);
          }}
          onSetEmptyString={() => {
            if (ctxEditContext) applyValueEdit(ctxMenu.row, ctxMenu.col, 'empty-string', ctxEditContext);
            closeCtxAndFocus();
          }}
          onUseDefault={() => {
            if (ctxEditContext) applyValueEdit(ctxMenu.row, ctxMenu.col, 'default', ctxEditContext);
            closeCtxAndFocus();
          }}
          onDiscardCell={() => {
            if (ctxEditContext) applyValueEdit(ctxMenu.row, ctxMenu.col, 'discard', ctxEditContext);
            closeCtxAndFocus();
          }}
          onCopyCell={() => {
            const v = source.value(ctxMenu.row, ctxMenu.col);
            void navigator.clipboard?.writeText(cellToDisplay(v)).catch(() => undefined);
            closeCtxAndFocus();
          }}
          onCopySelection={(format, includeHeader) => {
            copySelection(format, includeHeader);
            closeCtxAndFocus();
          }}
          onCopyRows={(format) => {
            copyRowsAs(ctxMenu.row, format);
            closeCtxAndFocus();
          }}
          /**
           * T23：单列 IN 清单。文案把「几个值 / 有没有被上限截断 / 有没有 NULL」
           * 全部摆在按钮上 —— 这三件事都会让粘出来的 SQL **结果变窄**，
           * 用户必须在动手前就看到，而不是执行完发现少了几行。
           */
          singleColumnInLabel={
            inListForMenu
              ? `${inListForMenu.col} → IN 清单（${inListForMenu.built.used} 个值` +
                `${inListForMenu.built.nullCount > 0 ? ' + NULL' : ''}` +
                `${inListForMenu.built.truncated ? `，已截断到 ${IN_LIST_LIMIT}` : ''}）`
              : null
          }
          onCopyInList={() => {
            const plan = inListForMenu;
            if (plan) void navigator.clipboard?.writeText(plan.built.condition).catch(() => undefined);
            closeCtxAndFocus();
          }}
          onQuickFilter={(op) => {
            onQuickFilter?.(ctxMenu.column, ctxMenu.cellValue, op);
            closeCtxAndFocus();
          }}
          onFollowForeignKey={() => {
            const fk = fkByColumn.get(ctxMenu.column);
            if (fk && onFollowForeignKey) {
              onFollowForeignKey(fk, ctxMenu.row, ctxMenu.cellValue);
            }
            closeCtxAndFocus();
          }}
          onExprEdit={() => {
            // V10：从右键菜单直接进表达式模式（⌘E 是编辑态内的切换）
            beginEdit({ row: ctxMenu.row, col: ctxMenu.col }, true);
            setCtxMenu(null);
          }}
          onBatchEdit={() => {
            openBatch();
            closeCtxAndFocus();
          }}
          onSetNull={() => {
            setCellNull(ctxMenu.row, ctxMenu.col);
            closeCtxAndFocus();
          }}
          onDuplicateRow={() => {
            if (editable && onDuplicateRow) onDuplicateRow(ctxMenu.row);
            closeCtxAndFocus();
          }}
          onAddBlankRow={() => {
            // T19：行号右键 / 单元格右键都能新增 —— 与工具栏、⌥⌘N 是同一条实现
            if (editable && onAddBlankRow) onAddBlankRow();
            closeCtxAndFocus();
          }}
          /**
           * T20：行级动作 —— 作用对象是**菜单打开时的行选快照**（`ctxMenu.rows`），
           * 不是「右键落点那一行」。用户在行号上拖选了 5 行再右键，
           * 期待的就是对这 5 行动手；拿落点那一行去删会少删 4 行。
           */
          canDeleteRows={editable && !readOnly && ctxMenu.rows.length > 0}
          canDiscardRows={rowDirtyCellsForMenu.length > 0}
          deleteRowsLabel={ctxMenu.rows.length > 1 ? `删除选中 ${ctxMenu.rows.length} 行` : '删除这一行'}
          deleteDisabledReason={
            ctxMenu.rows.length === 0
              ? '没有选中任何行'
              : readOnly
                ? '该连接已标记为只读：写语句会被主进程 AST 守卫拦截'
                : !editable
                  ? '该表无主键/唯一键（或未选中数据行），无法安全定位要删除的行'
                  : ''
          }
          onDeleteRows={() => {
            const rows = ctxMenu.rows;
            if (!editable || readOnly || rows.length === 0) return;
            onDeleteRows(rows);
            closeCtxAndFocus();
          }}
          onDiscardRows={() => {
            onBatchDiscard?.(rowDirtyCellsForMenu);
            closeCtxAndFocus();
          }}
          /**
           * T33（报告 §5 R16）：菜单项在无回调时已被隐藏，这里仍保持两条分支
           * 的**优先级**不变（弹窗优先，退化到激活单元格），保证有回调时行为与从前一致。
           */
          onViewFullValue={() => {
            if (onInspectCell) onInspectCell(ctxMenu.row, ctxMenu.col);
            else onCellActivated?.(ctxMenu.row, ctxMenu.col);
            closeCtxAndFocus();
          }}
        />
      ) : null}

      {/*
        T25/T36/T37：单元格值编辑浮层（fixed 浮层挂在 grid 根上，避开 viewport 裁切）。
        🔴 只在**有回调**时才画：宿主没接 onCellEdited 的话，这个浮层按下去
           只会改变本地草稿、永远落不到脏格 —— 那就是假 UI。
      */}
      {valueEditor && valueEditor.row < rowCount && valueEditor.col < columns.length ? (
        (() => {
          const t = valueEditor;
          const col = columns[t.col];
          const info = columnInfos[t.col] ?? UNKNOWN_COLUMN_INFO;
          const ctx = contextOf(t.row, t.col, col?.name ?? '');
          const current = source.value(t.row, t.col);
          const initial = current === null || current === undefined ? null : String(current);
          return (
            <ValueEditorPopover
              column={col?.name ?? ''}
              dataType={col?.dataType ?? ''}
              info={info}
              initialValue={initial}
              isInsertRow={t.row >= source.rowCount}
              emptyState={acceptsEmptyString(ctx)}
              canSetNull={editable && !readOnly}
              useDefaultState={canUseDefault(ctx)}
              useDefaultHint={describeDefaultAction(ctx)}
              originalValue={source.raw(t.row, t.col)}
              onCommit={(v, kind) => {
                onCellEdited(t.row, t.col, v, kind);
                closeValueEditor();
              }}
              onDiscard={() => {
                clearCellDirty(t.row, t.col);
                closeValueEditor();
              }}
              onClose={closeValueEditor}
              anchor={{ x: t.x, y: t.y }}
            />
          );
        })()
      ) : null}

      {/* A21：列头右键菜单（V8 追加「冻结到此列」） */}
      {headMenu ? (
        <HeaderContextMenu
          menu={headMenu}
          canSort={sortable}
          hasSort={sorts.length > 0}
          canHide={visibleColumns.length > 1}
          frozenCount={effectiveFrozen}
          visiblePos={headMenuVisiblePos}
          onClose={() => setHeadMenu(null)}
          onSort={(dir) => {
            onSortChange(headMenu.name, false, dir);
            closeHeadAndFocus();
          }}
          onCopyName={() => {
            void navigator.clipboard?.writeText(headMenu.name).catch(() => undefined);
            closeHeadAndFocus();
          }}
          onFreeze={() => {
            freezeUpTo(headMenu.originalIndex);
            closeHeadAndFocus();
          }}
          onAutoFit={() => {
            autoFitColumn(headMenu.name, headMenu.originalIndex);
            closeHeadAndFocus();
          }}
          onHide={() => {
            toggleColumn(headMenu.name);
            closeHeadAndFocus();
          }}
          // V14：网格内自己持久化（localStorage），不上抛给宿主。
          // 🔴 刻意**不关菜单**：这是个开关，用户要看到 ✓ 的变化才知道生效了
          //    （关掉菜单反而像"点了没反应"）。其它条目是动作，执行完就该关。
          showColumnTypes={showColumnTypes}
          onToggleShowTypes={toggleShowColumnTypes}
          // V19：切到别的列 = 直接换列；再点本列 = 取消（传 null）
          groupStripeColumn={groupStripeColumn}
          onToggleGroupStripe={
            onToggleGroupStripe
              ? () => {
                  toggleGroupStripe(headMenu.name);
                  closeHeadAndFocus();
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
