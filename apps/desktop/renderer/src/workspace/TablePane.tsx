/**
 * 表标签面板（P0-4）—— 每个 table tab 一个持久 DOM 节点。
 *
 * 🔴 为什么是「全部挂载 + CSS 隐藏」而不是「只渲染激活 tab」：
 *    `GridDataSource` 持有脏单元格叠加层，DataGrid 持有 scrollTop / 选择模型 /
 *    正在编辑的单元格。卸载即全部丢失 —— 而「切回标签保留脏标记与滚动位置」
 *    正是 P0-4 的验收核心。
 *
 *    DOM 隐藏（`.ws-tab-pane.hidden`）让这些状态天然留存，代价极低：
 *    隐藏时 clientHeight = 0 → computeVisibleRange 算出的区间为空 → 渲染 0 行。
 *    所以非激活 pane 只剩一份 payload 引用 + 脏单元格 Map（R8 内存有界）。
 */

import { useCallback, useMemo, useState } from 'react';
import { DataGrid, type GridColumn, type GridForeignKey } from '../grid/DataGrid';
import type { GridDataSource } from '../grid/useGridData';
import { FilterBar } from '../grid/FilterBar';
import { HeaderFilterContext, type HeaderFilterBridge, type ColumnFilterMode } from '../grid/headerFilterBridge';
import { columnFilterCapability, removeConditionFromModel } from '../grid/filterBarModel';
import { blankFilter, type FilterModel } from '@dbstudio/core-filter';
import { openTableSqlPreview } from '../filter/preview';
import {
  locateColumns as mutationLocateColumns,
  locateStrategy,
  type LocateStrategy,
} from '@dbstudio/core-mutation';
import { resolveEditability } from './editability';
import { GridStateBlock } from '../grid/GridStateBlock';
import { needsStateBlock, resolveGridState } from '../grid/gridStates';
import type { RowHeightMode, SortDirection, SortSpec } from '@dbstudio/core-grid-view';
import type { TableTabState } from './useWorkspaceTabs';

/** 网格回调在 App 层实现（那里才有 table/database 上下文与 save 预演流程） */
export interface TablePaneHandlers {
  onSortChange: (tabId: string, cur: SortSpec[], column: string, additive: boolean, direction?: SortDirection | null) => void;
  /**
   * V10：valueKind = 'sql-expr' 时 value 是一段 SQL 表达式（NOW() 等），
   * App 侧要把它随脏单元格带到 core-mutation（原样嵌入而不转义）。
   */
  onCellEdited: (tabId: string, source: GridDataSource, row: number, col: number, value: string | null, valueKind?: 'literal' | 'sql-expr') => void;
  onSave: (tabId: string, source: GridDataSource) => void;
  onCellActivated: (tabId: string, row: number, col: number) => void;
  /**
   * 缺陷 5：右键「查看完整值」/ 双击长文本或 BLOB 单元格 → 弹出 CellValueModal。
   *
   * 🔴 宿主必须传 table（该 tab 的 TableMeta）—— 弹窗靠它反查列类型来判定
   *    二进制（resolveBinary），也用于文件名。value 传**原始值**（source.raw），
   *    不是脏叠加值：用户要核对的是库里到底存了什么。
   */
  onInspectCell?: (tabId: string, row: number, col: number, value: unknown) => void;
  /**
   * A2：本格脏改动被清除（⌥0 幂等清除 / 右键「清除本格改动」）。
   * App 侧刷新 dirtyCount 角标（source.clearCell 已由网格执行）。
   */
  onCellCleared?: (tabId: string, source: GridDataSource, row: number, col: number) => void;
  /**
   * A4：⌘D / 右键「插入复制行」（row = 被复制行）。App 侧用 core-mutation 的
   * buildDuplicateRowPlan 构造追加脏行（source.setExtraRows + setDirty），
   * 落库仍走既有保存预演；未接线时功能静默降级。
   */
  onDuplicateRow?: (tabId: string, source: GridDataSource, row: number) => void;
  /**
   * T19（报告 §5 D16）：新增**空白行**（工具栏 / 数据菜单 / 行号右键）。
   * App 侧用 core-mutation 的 `buildBlankRowPlan` 逐列判定「服务端生成 / 用默认值 /
   * 写 NULL / 必须填」，并把这一行登记为「必须插入」；落库仍走既有保存预演。
   */
  onAddBlankRow?: (tabId: string, source: GridDataSource) => void;
  /**
   * A22：单元格右键快速筛选。App 侧把它并进该 tab 的 FilterModel 并按既有
   * loadTable({ filter }) 链路重拉（WHERE 值仍走 ? 占位参数）。
   * value = null 表示本格是 NULL（映射为 isNull 条件）。
   */
  onQuickFilter: (tabId: string, column: string, value: string | null, op: 'eq' | 'ne' | 'contains') => void;
  /**
   * T24/T26：条件条与列头快筛**共用**的写入通道（删单条件 / 清空 / 快筛应用都走它）。
   *
   * 🔴 真值只有一处：这里只把「新模型」交给宿主，由它写 `tab.filter` 并重查。
   *    条件条自己**不持有**任何筛选状态 —— 否则「改了草稿又取消」之后，
   *    条上会留着一个从未生效的条件（这正是旧实现「取消变成空按钮」的成因）。
   *
   * note = 给用户看的一句说明（去重 / 截断 / 忽略空片段…），由宿主 toast ——
   * 「绝不静默少给」要在界面上说出来，不能只写在返回值里。
   */
  onFilterChange: (tabId: string, next: FilterModel, note?: string) => void;
  /**
   * T24：「在完整筛选器中编辑」—— 宿主打开既有筛选构建器并预选该列。
   * 未接 = 该入口在浮层里禁用并写明原因（不许出现点了没反应的按钮）。
   */
  onOpenFilterBuilder?: (tabId: string, column: string) => void;
  /**
   * V1：⌘V 粘贴多行。anchor = 网格焦点单元格（从这格按列对齐）。App 侧读剪贴板 →
   * planPasteFromText → 脏单元格；不可编辑表在此给明确提示（不允许静默失效）。
   */
  onPaste: (tabId: string, source: GridDataSource, anchor: { row: number; col: number }) => void;
  /**
   * V2：⌘⌫ 删除选中行。rows = 待删行号（去重升序）。App 侧用 core-mutation 的
   * deletes 构造 DELETE 语句走保存预演；无主键表/只读连接在此给明确原因。
   */
  onDeleteRows: (tabId: string, source: GridDataSource, rows: number[]) => void;
  /**
   * F5：选中统计回报，App 状态栏显示「选中 N 行 / M 格」。
   * 仅激活 tab 回报（见下方 onSelectionSummary={active ? … : undefined}），
   * 多个常挂 pane 同时回报会互相覆盖。
   */
  onSelectionSummary?: (tabId: string, summary: { rows: number; cells: number } | null) => void;
  /**
   * V9：点击外键值 → 跳转到引用表的那一行（App 侧新开/复用 tab + 按引用列定位）。
   * 走既有 locateStrategy 链路，App 侧负责「引用行不存在」的明确提示。
   */
  onFollowForeignKey?: (tabId: string, fk: GridForeignKey, row: number, value: string | null) => void;
  /**
   * V9：外键候选值查询（App 侧走 backend，主进程 LIMIT 钳制）。
   * 返回 null = 不可用（宿主未接 / 引用表拿不到），下拉会显示原因并保留手输。
   */
  onLookupForeignKeyValues?: (
    tabId: string,
    fk: GridForeignKey,
    keyword: string | null,
  ) => Promise<{ items: { value: unknown; label: string }[]; truncated: boolean } | null>;
  /**
   * V13：批量编辑 Apply —— 把「一列 × 多行」一次性标脏。
   * 🔴 不引入新写路径：标脏后仍走既有 core-mutation + SavePreviewModal。
   */
  onBatchEdit?: (
    tabId: string,
    source: GridDataSource,
    cells: { row: number; col: number; value: string | null; valueKind: 'literal' | 'sql-expr' }[],
  ) => void;
  /** V13：批量编辑 Discard —— 清掉这批格子的脏标记 */
  onBatchDiscard?: (tabId: string, source: GridDataSource, cells: { row: number; col: number }[]) => void;
}

export interface TablePaneProps {
  tab: TableTabState;
  active: boolean;
  source: GridDataSource | null;
  rowHeightMode: RowHeightMode;
  handlers: TablePaneHandlers;
  /** A5：可见列变化回调（可选，宿主未接时静默降级） */
  onVisibleColumnsChange?: (names: string[]) => void;
  /**
   * V9：本表外键（App 层按需拉取；缺省/空 = 不画跳转链接）。
   * 🔴 拉取放在 App 而不是这里：TablePane 每个 tab 常挂 DOM，
   *    各自 useEffect 拉外键会在恢复会话时并发打十几次 information_schema。
   */
  foreignKeys?: GridForeignKey[];
  /** V9/V13：连接级只读（批量条与表达式模式要禁用并给原因） */
  readOnly?: boolean;

  // ---- V22 截断与「加载更多」 ----
  /** V22：本次结果集被行上限截断（App 取自最近一次 loadTable 的返回值） */
  truncated?: boolean;
  /**
   * V22：估算总行数（A14 的 information_schema 近似值）。
   * null / 缺省 = 未知 —— 只有激活 tab 会去算，非激活 pane 拿不到就是拿不到。
   */
  estimatedRows?: number | null;
  /** V22：本次加载的行上限（与 App 请求时的 limit 同源） */
  rowLimit?: number;
  /**
   * V22：点击「加载更多」（App 重拉并把 limit 加一页）。
   *
   * 🔴 签名带 tabId 而不是「宿主编好的无参闭包」：App 侧对全部 pane 共用
   *    一份稳定引用，传 tabId 可避免每次渲染给每个 pane 各分配一个新函数
   *    （pane 常挂 DOM，重渲染次数不少）。
   */
  onLoadMore?: (tabId: string) => void | Promise<void>;

  // ---- V19 分组着色 ----
  /** V19：按哪一列的值做分组条纹；null / 缺省 = 关闭（默认关闭） */
  groupStripeColumn?: string | null;
  /** V19：切换分组着色列（null = 取消）。未接 = 列头菜单项禁用，功能保持关闭 */
  onToggleGroupStripe?: (tabId: string, col: string | null) => void;

  // ---- T26 草稿 ----
  /**
   * T26：筛选弹窗里的草稿（**弹窗没开时必须传 null**）。
   * 条件条拿它和 `tab.filter` 逐条对比，标出「改了但还没应用」的条目 ——
   * 不传就是「没有草稿」，条上不会出现任何草稿标记。
   */
  filterDraft?: FilterModel | null;

  // ---- T47 六态 ----
  /**
   * T47：该 tab 的连接当前是否不可用（未连接 / 断线重连 / 已断开 / 握手失败）。
   *
   * 缺省 undefined = **不知道**，按「可用」处理 —— 首次连接状态还没回来时
   * 就把网格说成「已断开」会制造一次假告警。
   */
  disconnected?: boolean;
  /** T47：失败态的重试入口（App 侧重新执行当前查询条件） */
  onReload?: (tabId: string) => void | Promise<void>;

  // ---- T38 撤销/重做 ----
  /** 该 tab 的未保存改动是否可以撤销 / 重做（栈在 App 侧，按 tab 一个） */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: (tabId: string) => void;
  onRedo?: (tabId: string) => void;
}

export function TablePane({
  tab,
  active,
  source,
  rowHeightMode,
  handlers,
  onVisibleColumnsChange,
  foreignKeys,
  readOnly,
  truncated,
  estimatedRows,
  rowLimit,
  onLoadMore,
  groupStripeColumn,
  onToggleGroupStripe,
  filterDraft = null,
  disconnected,
  onReload,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: TablePaneProps) {
  const table = tab.table;

  // ---- 可编辑性：B5 红线，只有 isEditable() 说了算，本组件不自己判主键 ----
  const strategy: LocateStrategy = useMemo(() => locateStrategy(table), [table]);
  /**
   * 🔴 T14：可编辑性判定下沉到 `resolveEditability()`（与本页状态栏同一口径）。
   * 它把「有定位键」（结构性）与「当前可写」（再叠加连接只读）分成两项 ——
   * 只读连接下的表不能再显示成「可编辑」。
   */
  const edit = useMemo(() => resolveEditability(table, !!readOnly), [table, readOnly]);
  const writable = edit.writable;

  // A20：UPDATE 复制的定位列 —— 判定只在 core-mutation 一处（与保存预演同源）
  const locateColumnNames = useMemo(() => mutationLocateColumns(table).map((c) => c.name), [table]);

  const columns = useMemo<GridColumn[]>(
    () =>
      table.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        width: c.name === 'id' ? 90 : 150,
        isPrimaryKey: c.isPrimaryKey,
        // C4：列注释进表头 tooltip（名称 · 类型 · 注释）
        comment: c.comment ?? undefined,
      })),
    [table],
  );

  const filterPreview = useMemo(() => openTableSqlPreview(tab.filter), [tab.filter]);

  // ---- T26：条件条 / T24：列头快筛 ----
  /**
   * 列头快筛浮层的受控开关。
   *
   * 状态放在这里而不是 FilterBar：入口是**列头右键菜单**（经 context 上抛列名），
   * 而浮层要渲染在网格上方那条 bar 里 —— 两者分居 DataGrid 内外，
   * 只有本组件同时够得着。
   */
  const [quickFilter, setQuickFilter] = useState<{ column: string; mode: ColumnFilterMode } | null>(null);

  /**
   * T24：列头右键菜单的入口桥。
   *
   * 走 context 而不是让 DataGrid 透传 prop —— DataGrid 不在本次改动范围内。
   * 能力判定用本组件的列元数据（数值列没有「包含」、BLOB 不能 IN），
   * 于是列头菜单里的禁用态与浮层里的选项**同源**，不会对不上。
   */
  const headerFilterBridge = useMemo<HeaderFilterBridge>(
    () => ({
      capability: (column) => {
        const meta = table.columns.find((c) => c.name === column);
        const cap = columnFilterCapability(meta);
        return {
          canSingle: cap.operators.length > 0,
          canIn: cap.canIn,
          reason: cap.operators.length === 0 ? `列「${column}」不在这张表的元数据里，无法筛选` : cap.inReason,
        };
      },
      openColumnFilter: (column, mode) => setQuickFilter({ column, mode }),
    }),
    [table],
  );

  /** 删一条条件：改模型 → 宿主重查（不是只藏起徽标） */
  const handleRemoveCondition = useCallback(
    (condId: string) => {
      const r = removeConditionFromModel(tab.filter ?? blankFilter(), condId);
      if (!r.removed) return;
      handlers.onFilterChange(tab.id, r.model, `已删除条件：${r.removed.column}`);
    },
    [handlers, tab.filter, tab.id],
  );

  const handleClearFilter = useCallback(() => {
    // 清空 = 真的没有条件：不能落一条占位行（那会在条件条上显示「未填完」）
    handlers.onFilterChange(tab.id, blankFilter(), '已清空全部筛选条件');
  }, [handlers, tab.id]);

  /** 快筛应用：FilterBar 已把「追加后的完整模型」算好，这里只负责交给宿主 */
  const handleApplyQuickModel = useCallback(
    (next: FilterModel, note: string) => {
      handlers.onFilterChange(tab.id, next, note);
      setQuickFilter(null);
    },
    [handlers, tab.id],
  );

  const handleOpenBuilder = useCallback(
    (column: string) => handlers.onOpenFilterBuilder?.(tab.id, column),
    [handlers, tab.id],
  );

  // A21：列头左键三态 / 右键菜单显式方向（direction 由 DataGrid 透传，null = 清空）
  const handleSort = useCallback(
    (column: string, additive: boolean, direction?: SortDirection | null) =>
      handlers.onSortChange(tab.id, tab.sorts, column, additive, direction),
    [handlers, tab.id, tab.sorts],
  );

  const handleEdit = useCallback(
    (row: number, col: number, value: string | null, valueKind?: 'literal' | 'sql-expr') => {
      if (!source) return;
      handlers.onCellEdited(tab.id, source, row, col, value, valueKind);
    },
    [handlers, source, tab.id],
  );

  // V13：批量编辑 Apply/Discard（App 侧标脏 + 刷角标，落库仍走保存预演）
  const handleBatchEdit = useCallback(
    (cells: { row: number; col: number; value: string | null; valueKind: 'literal' | 'sql-expr' }[]) => {
      if (!source) return;
      handlers.onBatchEdit?.(tab.id, source, cells);
    },
    [handlers, source, tab.id],
  );

  const handleBatchDiscard = useCallback(
    (cells: { row: number; col: number }[]) => {
      if (!source) return;
      handlers.onBatchDiscard?.(tab.id, source, cells);
    },
    [handlers, source, tab.id],
  );

  // V9：外键跳转与候选值（App 侧有连接/库上下文与 backend）
  /**
   * T47：六态判定下沉到 `resolveGridState()`（纯函数，单测钉住优先级）。
   * 只有 ready 才把整块区域交回网格；其余五态各自渲染独立占位块，
   * 不再共用一块空白。
   */
  const gridState = resolveGridState({
    disconnected: disconnected === true,
    loading: tab.loading,
    error: tab.loadError ?? null,
    hasPayload: !!tab.payload,
    rowCount: tab.payload?.rowCount ?? 0,
  });
  const showStateBlock = needsStateBlock(gridState);
  const handleReload = useCallback(() => {
    void onReload?.(tab.id);
  }, [onReload, tab.id]);
  const handleUndo = useCallback(() => onUndo?.(tab.id), [onUndo, tab.id]);
  const handleRedo = useCallback(() => onRedo?.(tab.id), [onRedo, tab.id]);
  const handleFollowFk = useCallback(
    (fk: GridForeignKey, row: number, value: string | null) => {
      handlers.onFollowForeignKey?.(tab.id, fk, row, value);
    },
    [handlers, tab.id],
  );

  const handleLookupFk = useCallback(
    (fk: GridForeignKey, keyword: string | null) => handlers.onLookupForeignKeyValues?.(tab.id, fk, keyword) ?? Promise.resolve(null),
    [handlers, tab.id],
  );

  const handleSave = useCallback(() => {
    if (!source) return;
    handlers.onSave(tab.id, source);
  }, [handlers, source, tab.id]);

  const handleActivate = useCallback(
    (row: number, col: number) => handlers.onCellActivated(tab.id, row, col),
    [handlers, tab.id],
  );

  // 缺陷 5：查看完整值 → 弹窗（值取原始值，与详情面板搬迁前口径一致）
  const handleInspect = useCallback(
    (row: number, col: number) => {
      if (!source) return;
      handlers.onInspectCell?.(tab.id, row, col, source.raw(row, col));
    },
    [handlers, source, tab.id],
  );

  // F5：选中统计回报。只激活 tab 回报 —— 所有 pane 常挂 DOM，全回报会互相覆盖
  const handleSelectionSummary = useCallback(
    (summary: { rows: number; cells: number } | null) => {
      handlers.onSelectionSummary?.(tab.id, summary);
    },
    [handlers, tab.id],
  );

  // A2：清除本格改动（网格已执行 source.clearCell，这里只让宿主刷新角标）
  const handleCellCleared = useCallback(
    (row: number, col: number) => {
      if (!source) return;
      handlers.onCellCleared?.(tab.id, source, row, col);
    },
    [handlers, source, tab.id],
  );

  // A4：⌘D / 右键「插入复制行」上抛（App 侧用 buildDuplicateRowPlan 构造脏行）
  const handleDuplicateRow = useCallback(
    (row: number) => {
      if (!source) return;
      handlers.onDuplicateRow?.(tab.id, source, row);
    },
    [handlers, source, tab.id],
  );

  // T19：新增空白行上抛（App 侧用 buildBlankRowPlan 逐列判定）
  const handleAddBlankRow = useCallback(() => {
    if (!source) return;
    handlers.onAddBlankRow?.(tab.id, source);
  }, [handlers, source, tab.id]);

  // A22：右键快速筛选（App 并进 FilterModel 后走既有重拉）
  const handleQuickFilter = useCallback(
    (column: string, value: string | null, op: 'eq' | 'ne' | 'contains') => {
      handlers.onQuickFilter(tab.id, column, value, op);
    },
    [handlers, tab.id],
  );

  // V1：⌘V 粘贴多行（App 侧读剪贴板 + planPasteFromText + 脏标记）
  const handlePaste = useCallback(
    (anchor: { row: number; col: number }) => {
      if (!source) return;
      handlers.onPaste(tab.id, source, anchor);
    },
    [handlers, source, tab.id],
  );

  // V2：⌘⌫ 删除选中行（App 侧用 buildMutationPlan 的 deletes 走保存预演）
  const handleDeleteRows = useCallback(
    (rows: number[]) => {
      if (!source) return;
      handlers.onDeleteRows(tab.id, source, rows);
    },
    [handlers, source, tab.id],
  );

  // V22：加载更多。onLoadMore 未接时传 undefined —— 网格侧「没传就不画按钮」，
  // 画一个点了没反应的按钮比不画更糟。
  const handleLoadMore = useCallback(() => onLoadMore?.(tab.id), [onLoadMore, tab.id]);

  // V19：分组着色切换（网格的列头菜单只抛列名 / null，tabId 由这里补上）
  const handleToggleGroupStripe = useCallback(
    (col: string | null) => onToggleGroupStripe?.(tab.id, col),
    [onToggleGroupStripe, tab.id],
  );

  // 复制 / 粘贴 / 删除行：App 层统一实现（需要 columns + table 上下文）
  return (
    /**
     * T24：桥的 Provider 直接挂在 pane 根上（同一次渲染里 useMemo 已算好）。
     * HeaderContextMenu 在 DataGrid 里按 context 取 —— 没有这个 Provider 的
     * 宿主（比如别的组件直接渲染 DataGrid）自动落到「禁用 + 原因」。
     */
    <HeaderFilterContext.Provider value={headerFilterBridge}>
    <div
      className={`ws-tab-pane${active ? '' : ' hidden'}`}
      data-testid={`pane-${tab.tableName}`}
      data-tab-id={tab.id}
    >
      {/*
        T26：条件条。
        🔴 渲染条件刻意保持「有已生效条件才出现」—— 无筛选时不凭空多一条 bar，
           （scripts/e2e-ui.mjs 断言快速筛选后 .filter-bar 恰好一个）。
        快筛浮层打开时也要渲染：浮层就挂在这条 bar 里。
      */}
      {filterPreview.where || quickFilter ? (
        <FilterBar
          // 真值只有 tab.filter 一处
          applied={tab.filter}
          draft={filterDraft}
          loading={tab.loading}
          previewLabel={filterPreview.label}
          columns={table.columns}
          onRemoveCondition={handleRemoveCondition}
          onClearAll={handleClearFilter}
          onApplyModel={handleApplyQuickModel}
          // 未接线的宿主 → 浮层里该按钮禁用并说明
          onOpenBuilder={handlers.onOpenFilterBuilder ? handleOpenBuilder : null}
          quick={quickFilter}
          onCloseQuick={() => setQuickFilter(null)}
        />
      ) : null}

      {!writable ? (
        <div className="readonly-banner" data-testid="readonly-banner" data-reason={edit.reason}>
          {edit.message}
        </div>
      ) : null}

      {showStateBlock ? (
        <GridStateBlock state={gridState} onRetry={onReload ? handleReload : null} />
      ) : null}

      {showStateBlock ? null : source && columns.length > 0 ? (
        <DataGrid
          source={source}
          columns={columns}
          rowHeightMode={rowHeightMode}
          editable={writable}
          editWarning={strategy === 'unique' ? '可空唯一键定位，存在歧义风险' : null}
          sorts={tab.sorts}
          onSortChange={handleSort}
          onSave={handleSave}
          onPaste={handlePaste}
          onDeleteRows={handleDeleteRows}
          onCellEdited={handleEdit}
          onCellActivated={handleActivate}
          onInspectCell={handlers.onInspectCell ? handleInspect : undefined}
          onCellCleared={handleCellCleared}
          onDuplicateRow={handleDuplicateRow}
          // T19：新增空白行（工具栏 / 数据菜单 / 行号右键共用这一个入口）
          onAddBlankRow={handlers.onAddBlankRow ? handleAddBlankRow : undefined}
          // T38：撤销/重做（栈在 App，网格只做按钮与快捷键）
          onUndo={onUndo ? handleUndo : undefined}
          onRedo={onRedo ? handleRedo : undefined}
          canUndo={canUndo}
          canRedo={canRedo}
          // A17：INSERT/UPDATE 复制格式的限定名上下文
          database={tab.database}
          tableName={tab.tableName}
          // A20：UPDATE 复制的定位列（主键/唯一键，core-mutation 判定）
          locateColumns={locateColumnNames}
          // A22：右键快速筛选
          onQuickFilter={handleQuickFilter}
          // V9：外键导航与候选值下拉
          foreignKeys={foreignKeys}
          onFollowForeignKey={handlers.onFollowForeignKey ? handleFollowFk : undefined}
          onLookupForeignKeyValues={handlers.onLookupForeignKeyValues ? handleLookupFk : undefined}
          // V13：批量编辑条（Apply 只标脏，落库仍走既有保存预演）
          onBatchEdit={handlers.onBatchEdit ? handleBatchEdit : undefined}
          onBatchDiscard={handlers.onBatchDiscard ? handleBatchDiscard : undefined}
          readOnly={readOnly}
          // A15：列宽/显隐/换行的表级记忆键（connId:database:table）
          memoryKey={`${tab.connId}:${tab.database}:${tab.tableName}`}
          onVisibleColumnsChange={onVisibleColumnsChange}
          onSelectionSummary={active ? handleSelectionSummary : undefined}
          // V22：截断提示条。三个数据任一缺失都不影响渲染（网格侧逐项降级），
          // 但 rowLimit 必须与 App 实际请求的 limit 同源，否则「是否还有更多」会算错
          truncated={truncated}
          estimatedRows={estimatedRows}
          rowLimit={rowLimit}
          onLoadMore={onLoadMore ? handleLoadMore : undefined}
          // V19：分组条纹（默认关闭；未接 onToggleGroupStripe 时列头菜单项禁用）
          groupStripeColumn={groupStripeColumn ?? null}
          onToggleGroupStripe={onToggleGroupStripe ? handleToggleGroupStripe : undefined}
        />
      ) : null}
    </div>
    </HeaderFilterContext.Provider>
  );
}

/**
 * T24 的 Provider 包裹（同文件底部组件，避免 TablePane 主体再缩进一层）。
 *
 * 设计取舍见 `headerFilterBridge.ts`：DataGrid / HeaderContextMenu 不在
 * 本次改动范围，桥走 context 穿透 —— 没挂 Provider 时（例如别的宿主直接渲染
 * DataGrid）菜单项自动落到「禁用 + 原因」，不会静默失效。
 */

