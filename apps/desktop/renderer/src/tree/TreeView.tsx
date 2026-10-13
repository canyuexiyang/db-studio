/**
 * 库表树（PRD §6.2）
 *
 * 渲染的是 `flattenTree` 产出的扁平数组 —— 不递归、不在渲染时算可见性。
 * 节点上万时这是唯一能撑住的形态。
 *
 * 交互语义（对齐 Navicat / TablePlus 的成熟惯例，2026-09-26 定稿）：
 *  - 【单击】任何节点都选中；分组/库/对象类别节点顺带切换展开；
 *    未连接的连接节点单击即发起连接（"反应最快"的产品立基点）。
 *  - 【双击】对象节点打开表；已连接的连接节点切换展开；其余节点不响应
 *    （单击已经切换过展开，双击再切换会出现"展开又收起"的抖动）。
 *  - 【三角】只切换展开，冒泡必须拦掉，否则和行单击各切换一次 = 净零。
 *  - 【行内按钮】连接/断开（插头）、编辑、删除、收藏星标 —— hover 才显形。
 *  - 【右键】树侧能力（查看定义/复制 DDL/INSERT 模板/收藏）由本组件构造，
 *    经 onNodeContextMenu 的第 4 参 `extra.treeItems` 交给宿主菜单合并；
 *    宿主没接 onNodeContextMenu 时自绘降级菜单，功能不灭。
 *  - 【键盘】F2 = 重命名表（onRenameRequest）、Delete/Backspace = 删除表
 *    （onDeleteRequest，宿主自带危险确认）；prop 未传时按键无操作。
 *  - 【拖拽】表对象行可拖出（C7）：dataTransfer 带结构化表元数据 + text/plain 限定名。
 *
 * 🔴 状态标记一律用 CSS 圆点（.tree-state::before），不许用 emoji/字符符号。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  flattenTree,
  searchTree,
  filterFlatByQuery,
  toggleExpanded,
  expandAncestors,
  selectionIntentOf,
  nextSelection,
  selectAllTables,
  type TreeNode,
} from '@dbstudio/core-tree-view';
import type { ObjectKind, TableMeta } from '@dbstudio/core-schema-cache';
import type { ConnectionConfig, ConnectionState } from '@dbstudio/core-connection';
import { quoteQualified, insertTemplate } from '@dbstudio/core-sql-ident';
import { pickBackend } from '../backend';
import {
  loadFavorites,
  isFavorite,
  toggleFavorite,
  FAVORITES_MAX,
} from './favorites';
import { TreeContextMenu, type TreeContextMenuState, type ContextMenuItem } from './TreeContextMenu';
import {
  IconPlus, IconGear, IconX, IconPlug, IconPower, IconDatabase, IconTable, IconEye,
  IconBraces, IconFn, IconStar, IconStarFilled, IconZap, IconClock, IconFileCode, IconCopy, IconFolder, IconCheck,
} from '../ui/icons';


export interface TreeViewProps {
  roots: TreeNode[];
  expanded: Set<string>;
  onExpandedChange: (next: Set<string>) => void;
  activeKey: string | null;
  onOpenObject: (node: TreeNode) => void;
  /** 任意节点的单击选中（连接树导航的最小动作） */
  onSelectNode?: (node: TreeNode) => void;
  columnIndex?: Record<string, string[]>;
  /** 连接 id → 运行时状态。用于在节点上显示连接中/失败 */
  connStates?: Record<string, { state: string; lastError: string | null }>;
  /** 切换连接握手：live=true 表示当前已连接（调它 = 断开），否则 = 连接 */
  onToggleConnection?: (cfg: ConnectionConfig, live: boolean) => void;
  onEditConnection?: (cfg: ConnectionConfig) => void;
  onDeleteConnection?: (cfg: ConnectionConfig) => void;
  /** 数据库节点「新建表」：打开表设计器（§6.5.4） */
  onNewTable?: (database: string) => void;
  /** 搜索按字段名命中（Q2）时打开对应表 —— 列命中在树里没有节点，由这里跳转 */
  onOpenTableRef?: (database: string, tableName: string) => void;
  /**
   * 右键节点：出该级别的操作菜单（x/y 为视口坐标）。右键同时选中该节点。
   * 第 4 参 extra.treeItems 是树侧自管菜单项（C2/C3/C5），宿主合并进自己的菜单；
   * 未传 onNodeContextMenu 时树侧自绘降级菜单。
   */
  onNodeContextMenu?: (node: TreeNode, x: number, y: number, extra?: TreeExtraMenuItems) => void;
  /** 右键树空白区：新建连接入口 */
  onBackgroundContextMenu?: (x: number, y: number) => void;
  /** C2 查看对象定义：宿主实现（schemaGetObjectDdl → 回填查询编辑器）。未传时菜单项不显示 */
  onShowDefinition?: (req: ShowDefinitionRequest) => void;
  /** C3/C5 轻量反馈通道（toast）。未传时动作照常执行，只是无提示 */
  onToast?: (msg: string) => void;
  /** C6 F2：表节点重命名（宿主转表设计器编辑态）。未传时按键无操作 */
  onRenameRequest?: (req: TreeTableActionRequest) => void;
  /** C6 Delete/Backspace：删除表（宿主转 onTableDestructive，自带危险确认）。未传时按键无操作 */
  onDeleteRequest?: (req: TreeTableActionRequest) => void;
  /**
   * v0.6.0：多选变化的回调（集合为「当前选中的对象节点 key」）。
   *
   * 为什么回调的是集合而不是让宿主读 TreeView 内部状态：
   * 批量删除的执行在宿主侧（要弹危险确认、走 mutationApply），
   * 让宿主反向读组件内部 state 会把两层耦合在一起。
   * 未传时树仍可多选，只是宿主拿不到集合（功能不灭，也不该由树自己删表）。
   */
  onSelectionChange?: (keys: Set<string>) => void;
}

/** C2：查看对象定义请求（kind 与 core-schema-cache 的 ObjectKind 对齐） */
export interface ShowDefinitionRequest {
  connId: string;
  database: string;
  name: string;
  kind: 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';
}

/** C6：F2/Delete 请求载荷（表节点专有） */
export interface TreeTableActionRequest {
  connId: string;
  database: string;
  table: TableMeta;
}

/** 右键菜单第 4 参：树侧自管菜单项，宿主按序合并进自己的菜单 */
export interface TreeExtraMenuItems {
  treeItems: ContextMenuItem[];
}

/** 对象类别 → 图标（对象节点）：trigger/event 为 C1 新增（IconZap 闪电 / IconClock 时钟） */
const KIND_ICONS: Record<ObjectKind, (p: { size?: number }) => React.ReactNode> = {
  table: IconTable,
  view: IconEye,
  procedure: IconBraces,
  function: IconFn,
  trigger: IconZap,
  event: IconClock,
};

/** 连接是否处于"活"状态（活着 = 单击只选中；死着 = 单击拉起握手） */
function isLiveState(s: string | undefined): boolean {
  return s === 'connected' || s === 'busy' || s === 'connecting';
}

/** 从对象节点 key（`obj:<connId>:<db>:<table>`）解析 connId（与 App 的 parseTreeKeyContext 同口径） */
function connIdOfObjectKey(key: string): string {
  const parts = key.split(':');
  return parts[0] === 'obj' && parts.length >= 3 ? parts[1] : '';
}

/** 收藏 key = 对象节点 key 去掉 `obj:` 前缀（与 ⌘K PaletteItem.id 同构） */
function favKeyOfObjectKey(key: string): string {
  return key.startsWith('obj:') ? key.slice('obj:'.length) : key;
}

export function TreeView({
  roots,
  expanded,
  onExpandedChange,
  activeKey,
  onOpenObject,
  onSelectNode,
  columnIndex,
  connStates,
  onToggleConnection,
  onEditConnection,
  onDeleteConnection,
  onNewTable,
  onOpenTableRef,
  onNodeContextMenu,
  onBackgroundContextMenu,
  onShowDefinition,
  onToast,
  onRenameRequest,
  onDeleteRequest,
  onSelectionChange,
}: TreeViewProps) {
  const [query, setQuery] = useState('');
  // C5 收藏：状态收在组件内部，mount 时读，切换时整表重渲染
  const [favs, setFavs] = useState<string[]>(() => loadFavorites());
  // 宿主未接 onNodeContextMenu 时的降级自绘菜单（仅对象节点有树侧菜单项）
  const [ownMenu, setOwnMenu] = useState<TreeContextMenuState | null>(null);
  /**
   * v0.6.0：多选集合（对象节点 key）+ ⇧ 区间锚点。
   *
   * 刻意**只收对象节点**：容器节点（分组/库/类别）多选没有对应的批量动作，
   * 把它们塞进集合只会让"已选 N 项"这个数字含义不明。
   */
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const flat = useMemo(() => flattenTree(roots, expanded), [roots, expanded]);

  const hits = useMemo(
    () => (query.trim() ? searchTree(roots, query, { columnIndex, limit: 200 }) : []),
    [roots, query, columnIndex],
  );

  // 列命中（Q2）：树里没有对应节点，不参与 filterFlatByQuery，单独渲染成结果行
  const colHits = useMemo(() => hits.filter((h) => h.matchedBy === 'column'), [hits]);

  const visible = useMemo(
    () => (query.trim() ? filterFlatByQuery(flat, hits) : flat),
    [flat, query, hits],
  );

  const onToggle = useCallback(
    (key: string) => onExpandedChange(toggleExpanded(expanded, key)),
    [expanded, onExpandedChange],
  );

  // 回车跳转：展开祖先链并打开第一个命中（§6.2.2）
  const onSearchEnter = useCallback(() => {
    const first = hits[0];
    if (!first) return;
    // 列命中：树里没有这个节点，直接打开命中的表
    if (first.matchedBy === 'column') {
      if (first.database && first.tableName) onOpenTableRef?.(first.database, first.tableName);
      return;
    }
    onExpandedChange(expandAncestors(expanded, roots, first.key));
    const node = findByKey(roots, first.key);
    if (node?.kind === 'object') onOpenObject(node);
  }, [hits, expanded, roots, onExpandedChange, onOpenObject, onOpenTableRef]);

  const stateOf = useCallback(
    (cfg: ConnectionConfig | undefined) => connStates?.[cfg?.id ?? '']?.state,
    [connStates],
  );

  // ---------- C5 收藏 ----------

  const toggleFav = useCallback(
    (key: string, label: string) => {
      // 上限前置检查：模块内 toggleFavorite 也硬卡一道，这里负责给出提示
      if (!isFavorite(favs, key) && favs.length >= FAVORITES_MAX) {
        onToast?.(`收藏已达上限（${FAVORITES_MAX}），请先取消部分收藏`);
        return;
      }
      const next = toggleFavorite(key);
      setFavs(next);
      onToast?.(isFavorite(next, key) ? `已收藏 ${label}` : `已取消收藏 ${label}`);
    },
    [favs, onToast],
  );

  // ---------- C3 复制 DDL / 生成 INSERT 模板（自包含：直连 pickBackend + 剪贴板） ----------

  const copyDdl = useCallback(
    async (connId: string, database: string, name: string) => {
      try {
        const r = await pickBackend().schemaGetObjectDdl({ connId, database, name, kind: 'table' });
        void navigator.clipboard?.writeText(r.ddl).catch(() => undefined);
        onToast?.(`已复制 ${database}.${name} 的建表语句`);
      } catch (e) {
        onToast?.(`复制 DDL 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [onToast],
  );

  const copyInsertTemplate = useCallback(
    (database: string, table: TableMeta) => {
      try {
        // insertTemplate（core-sql-ident，C3 配套）：只拼标识符（列名走 quoteIdentifier），
        // 值一律 ? 占位 —— 红线 5 的延伸；非法标识符抛 IdentifierError，走 catch 提示
        const sql = insertTemplate(database, table.name, table.columns);
        if (!sql) {
          onToast?.('该表没有列信息，无法生成 INSERT 模板');
          return;
        }
        void navigator.clipboard?.writeText(sql).catch(() => undefined);
        onToast?.(`已复制 INSERT 模板（${database}.${table.name}）`);
      } catch (e) {
        onToast?.(`生成 INSERT 模板失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [onToast],
  );

  // ---------- 树侧右键菜单项（C2/C3/C5）：构造在本组件，合并交给宿主 ----------

  const buildTreeMenuItems = useCallback(
    (n: TreeNode): ContextMenuItem[] => {
      if (n.kind !== 'object' || !n.table || !n.database) return [];
      const connId = connIdOfObjectKey(n.key);
      const db = n.database;
      const t = n.table;
      const items: ContextMenuItem[] = [];

      // C2 查看定义：prop 未传时不显示（宿主没接 = 静默降级）
      if (onShowDefinition && connId) {
        items.push({
          key: 'tree-def',
          label: t.kind === 'table' ? '查看建表语句' : '查看定义',
          icon: <IconFileCode size={12} />,
          // 第一项带分隔线，与宿主菜单的既有项隔开
          separatorBefore: true,
          onSelect: () => onShowDefinition({ connId, database: db, name: t.name, kind: t.kind }),
        });
      }

      if (t.kind === 'table' && connId) {
        // C3 复制 DDL：走 schemaGetObjectDdl（demo 后端返回占位文本，流程同样可走）
        items.push({
          key: 'tree-copy-ddl',
          label: '复制 DDL',
          icon: <IconCopy size={12} />,
          onSelect: () => void copyDdl(connId, db, t.name),
        });
        // C3 生成 INSERT 模板：纯前端拼装（core-sql-ident），不依赖后端
        items.push({
          key: 'tree-insert-tpl',
          label: '生成 INSERT 模板',
          icon: <IconBraces size={12} />,
          onSelect: () => copyInsertTemplate(db, t),
        });
        // C5 收藏
        const favKey = favKeyOfObjectKey(n.key);
        const faved = isFavorite(favs, favKey);
        items.push({
          key: 'tree-fav',
          label: faved ? '取消收藏' : '收藏',
          icon: faved ? <IconStarFilled size={12} /> : <IconStar size={12} />,
          separatorBefore: true,
          onSelect: () => toggleFav(favKey, t.name),
        });
      }
      return items;
    },
    [favs, onShowDefinition, copyDdl, copyInsertTemplate, toggleFav],
  );

  /**
   * v0.6.0：分组节点（表/视图类别）右键的「全选本组」。
   *
   * 只对 `objectKind === 'table'` 给：批量删除的语义是"删表"，
   * 视图/过程/函数没有同一个批量动作，给了就是给一个点不动的菜单项。
   *
   * 只收**本组子节点**里kind==='table' 的 key，不去扫整棵树。
   */
  const buildGroupMenuItems = useCallback(
    (n: TreeNode): ContextMenuItem[] => {
   if (n.kind !== 'kind' || n.objectKind !== 'table') return [];
      const tableKeys = (n.children ?? [])
        .filter((c) => c.kind === 'object' && c.table?.kind === 'table')
      .map((c) => c.key);
    if (tableKeys.length === 0) return [];
      return [
     {
     key: 'tree-select-group',
          label: `全选本组（${tableKeys.length} 张表）`,
     icon: <IconCheck size={12} />,
          separatorBefore: true,
          onSelect: () => {
            const next = selectAllTables(tableKeys);
      setSelection(next);
       onSelectionChange?.(next);
         // 锚点落在本组第一张表：紧接着 ⇧ 点别处能接着取区间
    anchorRef.current = tableKeys[0];
          },
        },
      ];
    },
    [onSelectionChange],
  );

/** 单击：选中一切；容器节点顺带展开；未连接的连接节点发起握手 */
  const onRowClick = useCallback(
(f: { node: TreeNode; hasChildren: boolean }, e: React.MouseEvent) => {
      const n = f.node;

      /**
       * v0.6.0：多选。根因是原来这里拿不到 event，读不到 ⌘/⇧。
       *
       * ⚠️ 只有**对象节点**进选区：容器节点（连接/分组/库/类别）没有批量动作，
       * 让它们可多选只会让「已选 N 项」这个数字变得无法解释。
       */
      if (n.kind === 'object') {
        const visibleKeys = visible.map((x) => x.node.key);
        const next = nextSelection(
          visibleKeys,
          selection,
          anchorRef.current,
          n.key,
          selectionIntentOf(e),
        );
        anchorRef.current = next.anchorKey;
        setSelection(next.selected);
        onSelectionChange?.(next.selected);
        onSelectNode?.(n);
        return;
      }

      // 点容器节点 = 离开多选语境（跟 Finder 一致），否则"已选 3 项"会顽固残留
      if (selection.size > 0) {
        setSelection(new Set());
        anchorRef.current = null;
        onSelectionChange?.(new Set());
      }

      onSelectNode?.(n);
      if (n.kind === 'connection' && n.connection) {
        if (!isLiveState(stateOf(n.connection))) onToggleConnection?.(n.connection, false);
      return;
      }
      // 容器节点（分组/库/对象类别）：单击即展开/收起
      if (f.hasChildren && (n.kind === 'group' || n.kind === 'database' || n.kind === 'kind')) {
        onToggle(n.key);
      }
    },
    [onSelectNode, onToggle, onToggleConnection, stateOf, visible, selection, onSelectionChange],
  );

  const onDoubleClick = useCallback(
    (f: { node: TreeNode; hasChildren: boolean }) => {
      const n = f.node;
      if (n.kind === 'object') {
        onOpenObject(n);
        return;
      }
      if (n.kind === 'connection' && n.connection) {
        if (isLiveState(stateOf(n.connection))) {
          // 已连接：双击 = 展开看库（断开走行内电源按钮，避免误触掉线）
          if (f.hasChildren) onToggle(n.key);
          else onToggleConnection?.(n.connection, true);
        } else {
          onToggleConnection?.(n.connection, false);
        }
      }
      // 分组/库/类别：单击已切换过展开，双击不再响应（防"展开又收起"抖动）
    },
    [onOpenObject, onToggle, onToggleConnection, stateOf],
  );

  // ---------- C6 键盘：F2 重命名 / Delete·Backspace 删除（均限表节点，prop 未传则无操作） ----------

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'F2' && e.key !== 'Delete' && e.key !== 'Backspace') return;
      // 搜索框/输入类元素里的按键不属于树导航
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!activeKey) return;
      const node = findByKey(roots, activeKey);
      if (node?.kind !== 'object' || !node.table || !node.database) return;
      if (node.table.kind !== 'table') return;
      const connId = connIdOfObjectKey(node.key);
      if (!connId) return;
      if (e.key === 'F2') {
        if (!onRenameRequest) return;
        e.preventDefault();
        onRenameRequest({ connId, database: node.database, table: node.table });
      } else {
        if (!onDeleteRequest) return;
        e.preventDefault();
        onDeleteRequest({ connId, database: node.database, table: node.table });
      }
    },
    [roots, activeKey, onRenameRequest, onDeleteRequest],
  );

  return (
    <div
      className="tree"
      tabIndex={0}
      onKeyDown={onTreeKeyDown}
      onContextMenu={(e) => {
        // 空白区（非树行）右键 → 新建连接。树行自己会 stopPropagation
        if (e.target === e.currentTarget) {
          e.preventDefault();
          onBackgroundContextMenu?.(e.clientX, e.clientY);
        }
      }}
    >
      <input
        className="tree-search"
        placeholder="搜索表 / 视图（支持拼音首字母）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearchEnter();
          if (e.key === 'Escape') setQuery('');
        }}
      />

      {visible.map((f) => {
        const n = f.node;
        const st = n.connection ? connStates?.[n.connection.id] : undefined;
        const live = isLiveState(st?.state);
        const title =
          n.kind === 'connection'
            ? st
              ? `${stateLabel(st.state)}${st.lastError ? ' — ' + st.lastError : ''}${live ? '（双击展开库；电源按钮断开）' : '（单击连接）'}`
              : '单击连接'
            : n.label;
        // v0.6.0：kind 分组节点（表/视图/存储过程/函数/触发器/事件）此前漏了图标，
        // 导致分组行只有文字没有类别标识。KIND_ICONS 六项本就是齐的，纯接线漏了。
        const KindIcon =
          n.kind === 'object' && n.table
            ? KIND_ICONS[n.table.kind]
            : n.kind === 'kind' && n.objectKind
              ? KIND_ICONS[n.objectKind]
              : n.kind === 'database'
                ? IconDatabase
                : n.kind === 'group'
                  ? IconFolder
                  : null;
        // C5/C7 只服务表对象：星标按钮与拖拽都只挂在表行上
        const isTableObj = n.kind === 'object' && n.table?.kind === 'table';
        const favKey = n.kind === 'object' ? favKeyOfObjectKey(n.key) : '';
        const faved = isTableObj && isFavorite(favs, favKey);
        // C7 拖出载荷在 dragstart 一次性构造（冷路径，允许分配）
        const onDragStart = isTableObj
          ? (e: React.DragEvent<HTMLDivElement>) => {
              if (!n.database || !n.table) return;
              const connId = connIdOfObjectKey(n.key);
              if (!connId) return;
              // 结构化载荷：编辑器侧优先读它（含列定义，可直接生成 INSERT）
              e.dataTransfer.setData(
                'application/x-dbstudio-table',
                JSON.stringify({ connId, database: n.database, table: n.table }),
              );
              // 纯文本兜底：转义后的全限定名；非法标识符（quoteQualified 抛错）退化为原始点号名
              let qualified = `${n.database}.${n.table.name}`;
              try {
                qualified = quoteQualified([n.database, n.table.name]);
              } catch {
                // 保真让位于可用性：拖拽是 UX 通道，不是 SQL 执行通道
              }
              e.dataTransfer.setData('text/plain', qualified);
              e.dataTransfer.effectAllowed = 'copy';
            }
          : undefined;

        return (
          <div
            key={n.key}
            className={`tree-row${activeKey === n.key ? ' active' : ''}${selection.has(n.key) ? ' selected' : ''}`}
            style={{ paddingLeft: 6 + f.depth * 14 }}
            data-testid={n.kind === 'connection' ? `tree-conn-${n.connection?.name ?? ''}` : undefined}
            /**
             * v0.6.0：稳定的定位钩子。
             *
             * 为什么加：e2e 之前只能靠样式反推节点类型（"有 badge 的是库"），
             * 结果分组节点也带 badge（显示连接数），断言就指错了对象。
             * 这类"靠观感猜语义"的选择器天生脆弱 —— 样式一改就断，而且断得莫名其妙。
             * 节点 kind 与层级是**语义**，就该由组件显式暴露。
             */
 data-node-kind={n.kind}
      data-node-depth={f.depth}
            draggable={isTableObj}
            onDragStart={onDragStart}
            onClick={(e) => onRowClick(f, e)}
            onDoubleClick={() => onDoubleClick(f)}
            onContextMenu={(e) => {
              // Navicat 语义：右键 = 选中 + 弹出该级别菜单（阻止系统菜单）
              e.preventDefault();
              e.stopPropagation();
onSelectNode?.(n);
        // v0.6.0：对象节点给 C2/C3/C5，分组节点给「全选本组」
    const treeItems = [...buildTreeMenuItems(n), ...buildGroupMenuItems(n)];
              if (onNodeContextMenu) {
                // 宿主菜单为主：树侧项经第 4 参交由宿主合并
                onNodeContextMenu(n, e.clientX, e.clientY, treeItems.length > 0 ? { treeItems } : undefined);
              } else if (treeItems.length > 0) {
                // 降级：宿主没接菜单时自绘，C2/C3/C5 功能不灭
                setOwnMenu({ x: e.clientX, y: e.clientY, title: n.label, items: treeItems });
              }
            }}
          >
            <span
              className="tree-caret"
              onClick={(e) => {
                e.stopPropagation();
                if (f.hasChildren) onToggle(n.key);
              }}
              title={f.hasChildren ? (f.expanded ? '收起' : '展开') : ''}
            >
              {f.hasChildren ? (f.expanded ? '▾' : '▸') : ''}
            </span>

            {/* 节点图标：连接用插头/电源，库与对象按类别取 */}
            {n.kind === 'connection' ? (
              live ? <IconPower size={12} /> : <IconPlug size={12} />
            ) : KindIcon ? (
              <KindIcon size={12} />
            ) : null}

            <span className={`tree-label${n.danger ? ' tree-danger' : ''}`} title={title}>
              {n.danger ? <span className="danger-dot" title="生产环境（危险操作需三层确认）" /> : null}
              {n.label}
            </span>

            {/* C5 收藏星标：hover 显形，已收藏常显实心（样式 .tree-fav） */}
            {isTableObj ? (
              <button
                className={`tree-fav${faved ? ' on' : ''}`}
                aria-label={faved ? '取消收藏' : '收藏'}
                title={faved ? '取消收藏' : '收藏表'}
                data-testid={`btn-fav-${n.table?.name ?? ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFav(favKey, n.label);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {faved ? <IconStarFilled size={11} /> : <IconStar size={11} />}
              </button>
            ) : null}

            {n.kind === 'connection' ? (
              <span className="tree-acts">
                {onToggleConnection ? (
                  <button
                    className="tree-act"
                    title={live ? '断开连接' : '连接'}
                    data-testid={`btn-toggle-conn-${n.connection?.name ?? ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleConnection(n.connection!, live);
                    }}
                  >
                    {live ? <IconPower size={11} /> : <IconPlug size={11} />}
                  </button>
                ) : null}
                {onEditConnection ? (
                  <button
                    className="tree-act"
                    title="编辑连接"
                    data-testid={`btn-edit-conn-${n.connection?.name ?? ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditConnection(n.connection!);
                    }}
                  >
                    <IconGear size={11} />
                  </button>
                ) : null}
                {onDeleteConnection ? (
                  <button
                    className="tree-act"
                    title="删除连接"
                    data-testid={`btn-del-conn-${n.connection?.name ?? ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConnection(n.connection!);
                    }}
                  >
                    <IconX size={11} />
                  </button>
                ) : null}
              </span>
            ) : null}

            {n.kind === 'database' && onNewTable && n.database ? (
              <span className="tree-acts">
                <button
                  className="tree-act"
                  title={`在 ${n.database} 中新建表`}
                  data-testid={`btn-new-table-${n.database}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewTable(n.database!);
                  }}
                >
                  <IconPlus size={10} />
                  表
                </button>
              </span>
            ) : null}

            {n.badge != null && n.badge > 0 ? <span className="tree-badge">{n.badge}</span> : null}

            {st ? (
              <span className={`tree-state state-${st.state}`} title={st.lastError ?? stateLabel(st.state)} />
            ) : null}
          </div>
        );
      })}

      {/* Q2 列命中：`包含该字段的表`，点击直接打开（搜索结果语义，单击即可） */}
      {query.trim()
        ? colHits.slice(0, 50).map((h) => (
            <div
              key={h.key}
              className="tree-row tree-col-hit"
              style={{ paddingLeft: 6 }}
              title={`点击打开 ${h.path}.${h.tableName}`}
              onClick={() => {
                if (h.database && h.tableName) onOpenTableRef?.(h.database, h.tableName);
              }}
            >
              <span className="tree-caret" />
              <IconTable size={12} />
              <span className="tree-label">{h.label}</span>
              <span className="tree-badge">字段</span>
              <span className="tree-state">{h.path}</span>
            </div>
          ))
        : null}

      {query.trim() && visible.length === 0 && colHits.length === 0 ? (
        <div style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>没有匹配的对象</div>
      ) : null}

      {/* 宿主未接 onNodeContextMenu 时的降级自绘菜单 */}
      {ownMenu ? <TreeContextMenu menu={ownMenu} onClose={() => setOwnMenu(null)} /> : null}
    </div>
  );
}

function stateLabel(s: string): string {
  const map: Record<ConnectionState, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    busy: '执行中',
    disconnected: '断线重连中',
    failed: '连接失败',
    closed: '已断开',
  };
  return map[s as ConnectionState] ?? s;
}

function findByKey(roots: TreeNode[], key: string): TreeNode | null {
  for (const n of roots) {
    if (n.key === key) return n;
    const hit = findByKey(n.children ?? [], key);
    if (hit) return hit;
  }
  return null;
}
