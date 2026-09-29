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

import { useCallback, useMemo } from 'react';
import { DataGrid, type GridColumn, type GridForeignKey } from '../grid/DataGrid';
import type { GridDataSource } from '../grid/useGridData';
import { openTableSqlPreview } from '../filter/preview';
import {
  isEditable,
  locateColumns as mutationLocateColumns,
  locateStrategy,
  type LocateStrategy,
} from '@dbstudio/core-mutation';
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
   * A2：本格脏改动被清除（⌘0 幂等清除 / 右键「清除本格改动」）。
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
   * A22：单元格右键快速筛选。App 侧把它并进该 tab 的 FilterModel 并按既有
   * loadTable({ filter }) 链路重拉（WHERE 值仍走 ? 占位参数）。
   * value = null 表示本格是 NULL（映射为 isNull 条件）。
   */
  onQuickFilter: (tabId: string, column: string, value: string | null, op: 'eq' | 'ne' | 'contains') => void;
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
}: TablePaneProps) {
  const table = tab.table;

  // ---- 可编辑性：B5 红线，只有 isEditable() 说了算，本组件不自己判主键 ----
  const strategy: LocateStrategy = useMemo(() => locateStrategy(table), [table]);
  const editable = useMemo(() => isEditable(table), [table]);

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
    <div
      className={`ws-tab-pane${active ? '' : ' hidden'}`}
      data-testid={`pane-${tab.tableName}`}
      data-tab-id={tab.id}
    >
      {filterPreview.where ? (
        <div className="filter-bar">
          <span className="preview" title={filterPreview.label}>
            {filterPreview.label}
          </span>
        </div>
      ) : null}

      {!editable ? (
        <div className="readonly-banner">
          该表无主键/唯一键，无法安全定位行，请使用 SQL 编辑。网格已置为只读。
        </div>
      ) : null}

      {tab.loading ? <div className="banner">加载中…</div> : null}

      {source && columns.length > 0 ? (
        <DataGrid
          source={source}
          columns={columns}
          rowHeightMode={rowHeightMode}
          editable={editable}
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
  );
}
