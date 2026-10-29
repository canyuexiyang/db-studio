/**
 * 应用外壳：三栏布局 + 多标签工作区 + 网格 + 保存预演 + 命令面板。
 *
 * 数据来源由 `backend.ts` 提供：
 *  - Electron 环境 → 真 IPC（window.dbStudio）
 *  - 纯浏览器 dev → demo 数据
 * 组件侧不感知差异，这是这一层能并行推进的前提。
 *
 * 四条硬约束（改这个文件时别违反）：
 *  1. 能否编辑必须问 `isEditable()` —— 无主键/唯一键的表网格只读（B5 红线）
 *  2. 保存必须先预演，没有"直接保存"路径
 *  3. 排序只改状态，真正的排序由服务端执行
 *  4. 每个 tab 有独立的数据源（GridDataSource），切 tab 不销毁 —— P0-4 的核心
 */

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, memo } from 'react';
import { GridDataSource } from './grid/useGridData';
import { SavePreviewModal } from './grid/SavePreviewModal';
import { ColumnarReader, type CellValue } from '@dbstudio/core-ipc-codec';
import { buildRowProbeSql } from './grid/conflictProbe';
import type { ConflictView, ProbeOutcome } from './grid/SaveConflictModal';
import { TreeView } from './tree/TreeView';
import { CommandPalette } from './palette/CommandPalette';
import { DetailPanel } from './detail/DetailPanel';
import { CellValueModal, type CellSelection } from './detail/CellValueModal';
import { FilterBuilder } from './filter/FilterBuilder';
import { pickBackend, hasIpc, type Backend } from './backend';
// P1-8：创建副本的命名（重名递增）—— 纯函数，单测钉住
import { duplicateConnectionName } from './connection/duplicate';
import {
  buildConnectionBundle,
  serializeConnectionBundle,
  parseConnectionBundle,
  planConnectionImport,
} from './connection/connectionBundle';
import { useWorkspaceTabs, type TableTabState, type WorkspaceTab } from './workspace/useWorkspaceTabs';
import { WorkspaceTabsBar } from './workspace/WorkspaceTabsBar';
import { TablePane, type TablePaneHandlers } from './workspace/TablePane';
import type { GridForeignKey } from './grid/DataGrid';
// P0-1：导出快照的类型（快照本体由网格产出，App 只做搬运）
import type { GridSnapshotSource } from './grid/exportSnapshot';
// V20：列快速定位浮层。开关（⌘F12）由 App 挂 window，组件自身不碰 window
import { ColumnQuickFinder } from './grid/ColumnQuickFinder';
// V7 目标库选择：组件很小，静态引入（避免弹窗加载间隙布局塌陷，不进 lazy）
import { ScriptDbPicker } from './transfer/ScriptDbPicker';
// T27：expandAncestors 用于「标签右键 → 在树中定位」（组节点 key 含成员 id 集合，拼不出来，必须走真实树）
import { buildTree, buildColumnIndex, expandAncestors, emptyMemory, saveExpansion, restoreExpansion, type TreeNode } from '@dbstudio/core-tree-view';
import {
  emptyFilter,
  blankFilter,
  stripPlaceholderConditions,
  filterableColumns,
  toOpenTableFilter,
  effectiveConditionCount,
  filterByCellValue,
  nextId,
  type FilterCondition,
  type FilterModel,
} from '@dbstudio/core-filter';
import {
  buildMutationPlan,
  buildBlankRowPlan,
  buildDuplicateRowPlan,
  isEditable,
  locateColumns,
  locateStrategy,
  validateSqlExpression,
  type EditWithLocate,
  type ChangeSummary,
} from '@dbstudio/core-mutation';
import { applySort, applySortDirection, type RowHeightMode, type SortDirection, type SortSpec } from '@dbstudio/core-grid-view';
import { planPasteFromText } from '@dbstudio/core-clipboard';
import { quoteQualified } from '@dbstudio/core-sql-ident';
// ⚠️ core-sql-guard（node-sql-parser ~500KB gzip）不能同步进首屏：
//    classifyDanger 走动态 import，第一次执行危险语句时才加载（异步路径无感）
import type { ConnectionConfig } from '@dbstudio/core-connection';
import type { ConnectionEditorProps } from './connection/ConnectionEditor';
import type { TableMeta, DatabaseMeta } from '@dbstudio/core-schema-cache';
import type { PaletteItem, CommandDef } from '@dbstudio/core-command-palette';
import { BUILTIN_COMMANDS } from '@dbstudio/core-command-palette';
import type { HistoryEntry, Snippet } from '@dbstudio/core-history';
import {
  IconPlus, IconSearch, IconTerminal, IconSave, IconFilter,
  IconExport, IconImport, IconDesign, IconCopy, IconPaste, IconRefresh,
  IconPlug, IconPower, IconGear, IconX as IconXSmall, IconTable, IconFileCode,
} from './ui/icons';
import { TreeContextMenu, type TreeContextMenuState, type ContextMenuItem } from './tree/TreeContextMenu';
import { resolveEditability } from './workspace/editability';
// T46：身份条与工具栏密度 / T47：行数口径（两者都是纯函数，单测钉住）
import { isCollapsed, resolveIdentity, saveButton, toolbarDensity } from './workspace/identity';
import { rowCountBasis } from './grid/gridStates';
// P0-5：生产库删行/无 WHERE UPDATE 的第三层（输表名）判定 —— 纯函数，单测钉住
import { previewRequiresText } from './grid/previewGuard';
// P1-11：Toast 分级（ok/warn/error）+ 成功自动消失
import { inferToastTone, toastAutoDismissMs, toastClass, type ToastTone } from './ui/toastTone';
// P1-14：⌘K「最近使用」排序的数据来源（与表视图记忆同 key 体系）
import { loadRecentTables, recordTableUsed, saveRecentTables, tableMemoryKey } from './workspace/recentTables';
// T38：未保存改动的撤销栈（纯逻辑，单测在 grid/editHistory.test.ts）
import { EditHistory, applyMetaTo, clearsFor, statesFor, type CellChange, type EditEntry } from './grid/editHistory';
// T43：表视图记忆（排序 + 筛选，按 连接:库:表）
import { loadTableView, saveTableView } from './workspace/tableViewMemory';
// R1 集成：应用壳（F1 菜单/F2 缩放/F4 会话恢复/F7 空态/D1 断线横幅）
import { EmptyState } from './workspace/EmptyState';
import { ObjectBrowser } from './workspace/ObjectBrowser';
// 0.7.3：库生命周期（建库/删库）与对象 DDL 的唯一构造处 + 复用首屏 .modal 壳的对话框
import { CreateDatabaseModal } from './database/DdlDialogs';
import { NamePromptModal } from './database/DdlDialogs';
import {
  MAINTENANCE_LABELS,
  OBJECT_KIND_TEXT,
  buildCopyTableSql,
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildMaintenanceSql,
  buildObjectTemplate,
  buildRenameTableSql,
  defaultCollationOf,
  toCreateOrReplaceView,
  validateNewName,
  type MaintenanceAction,
  type ObjectCreateKind,
} from './database/ddlTemplates';
import { CopyTableModal } from './database/DdlDialogs';
import {
  addEmptyGroup,
  childGroupPath,
  groupDisplayName,
  isInGroup,
  loadEmptyGroups,
  normalizeGroupPath,
  removeEmptyGroupSubtree,
  renameEmptyGroups,
  renameGroupPatch,
  saveEmptyGroups,
} from './workspace/connectionGroups';
import { ConnStateBanner } from './workspace/ConnStateBanner';
import { nextZoom, loadFontZoom, saveFontZoom, applyFontZoom } from './workspace/fontZoom';
import { snippetActionOf, snippetCommandId, snippetOriginLabel, findSnippetByAction } from './workspace/snippetCommand';
import { serializeSession, loadSessionSnapshot, saveSessionSnapshot, clearSessionSnapshot } from './workspace/sessionSnapshot';
// R1 集成：树 UX（C5 收藏加权 ⌘K / C2 查看定义）
import { loadFavorites } from './tree/favorites';
import type { ShowDefinitionRequest } from './tree/TreeView';
import { isImeComposing } from './ui/imeGuard';
/**
 * 从树节点 key 解析查询上下文（连接 + 库）。
 * `db:<connId>:<db>` / `kind:<connId>:<db>:<kind>` / `obj:<connId>:<db>:<table>`
 * 三种前缀的第 2 段都是 connId、第 3 段都是库名 —— 与 onOpenObject 的反查口径一致。
 */
function parseTreeKeyContext(key: string): { connId: string; database: string | null } | null {
  const parts = key.split(':');
  if ((parts[0] === 'db' || parts[0] === 'kind' || parts[0] === 'obj') && parts.length >= 3) {
    return { connId: parts[1], database: parts[2] };
  }
  if (parts[0] === 'conn' && parts.length >= 2) return { connId: parts[1], database: null };
  return null;
}

/**
 * 按 key 在树里反查节点（深度优先）。
 *
 * v0.6.0：中间面板的对象清单点一项时要拿到完整 TreeNode 才能打开表。
 * 树可能上千节点，但这只在**用户点击**时跑一次（冷路径），不参与渲染。
 */
function findTreeNode(roots: TreeNode[], key: string): TreeNode | null {
  for (const n of roots) {
    if (n.key === key) return n;
    const hit = findTreeNode(n.children ?? [], key);
    if (hit) return hit;
  }
  return null;
}

/**
 * 🔴 SQL 编辑器必须走 `lazy()` —— 这是 E1/E2 的落地点。
 *
 * 直接 `import SqlEditorPanel from './editor/SqlEditorPanel'` 会让 CodeMirror
 * （782KB 未压缩）进首屏 bundle，直接破 S2 的「首屏 ≤1.5MB」硬约束。
 * 走 lazy 之后首屏只多一个 chunk 地址表（≤5KB，E2 预算）。
 */
const SqlEditorPanel = lazy(() => import('./editor/SqlEditorPanel').then((m) => ({ default: m.SqlEditorPanel })));
// 预热器单独成文件且不引 CodeMirror：它要在【首屏】被调用，
// 如果它自己引了编辑器，预热就等于把 377KB 拖进首屏（违反 E2）
import { warmupEditorChunk } from './editor/warmup';

/**
 * 连接编辑器同样走 `lazy()`。
 *
 * 不是因为它有多大，而是因为**绝大多数会话用户根本不会打开它** ——
 * 每天打开的是"连库 → 看表 → 改数据"，改连接配置是低频动作。
 * 让它常驻首屏 bundle 等于让所有人替少数场景付费。
 */
const ConnectionEditor = lazy(() =>
  import('./connection/ConnectionEditor').then((m) => ({ default: m.ConnectionEditor })),
);

/**
 * 导入/导出 UI 走 lazy()：不是热路径，且向导里有较大的表格渲染逻辑，
 * 没必要让所有会话的首屏为它买单。
 */
const ExportModal = lazy(() =>
  import('./transfer/ExportModal').then((m) => ({ default: m.ExportModal })),
);
const ImportWizard = lazy(() =>
  import('./transfer/ImportWizard').then((m) => ({ default: m.ImportWizard })),
);
const SqlScriptModal = lazy(() =>
  import('./transfer/SqlScriptModal').then((m) => ({ default: m.SqlScriptModal })),
);

/**
 * 表设计器同样 lazy：低频（每次建表/改结构才打开），且表格编辑逻辑不轻。
 */
const TableDesigner = lazy(() =>
  import('./designer/TableDesigner').then((m) => ({ default: m.TableDesigner })),
);

/**
 * 危险确认弹窗很小，但同样走 lazy —— 热路径（网格/编辑器）不该为它付首屏字节。
 * 真正调用它的只有 onRunSql 与设计器保存，都是低频动作。
 */
const DangerConfirmModal = lazy(() =>
  import('./danger/DangerConfirmModal').then((m) => ({ default: m.DangerConfirmModal })),
);
import type { DangerConfirmRequest } from './danger/DangerConfirmModal';

/**
 * T01 / R01：重载前未提交改动守卫。
 * 与 DangerConfirmModal 同策略 lazy —— 只有「带着脏格去排序/筛选/刷新」才出现，
 * 绝不能为它付首屏字节；外壳样式复用 .modal-mask/.modal，首屏已就位（红线 9）。
 */
const DirtyReloadModal = lazy(() =>
  import('./grid/DirtyReloadModal').then((m) => ({ default: m.DirtyReloadModal })),
);
import type { DirtyGuardDecision } from './grid/DirtyReloadModal';

/**
 * T09 / R15：提交冲突处理弹窗。同样 lazy —— 只在真的撞上并发冲突时才出现。
 */
const SaveConflictModal = lazy(() =>
  import('./grid/SaveConflictModal').then((m) => ({ default: m.SaveConflictModal })),
);

/**
 * V5 偏好设置面板同样 lazy：macOS ⌘, 是低频动作，绝大多数会话用不到。
 * 外壳样式（.prefs-*）已在 styles.css 首屏就位（红线 9）。
 */
const PreferencesPanel = lazy(() =>
  import('./prefs/PreferencesPanel').then((m) => ({ default: m.PreferencesPanel })),
);
import {
  loadPreferences,
  patchPreferences,
  type Preferences,
} from './prefs/preferences';

const backend: Backend = pickBackend();

const CONN_STATE_LABELS: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  busy: '执行中…',
  disconnected: '断线重连中',
  failed: '连接失败',
  closed: '已断开',
};

function connStateLabel(s: { state: string; lastError: string | null } | undefined): string {
  if (!s) return '未知';
  const label = CONN_STATE_LABELS[s.state] ?? s.state;
  // 失败态必须把原因露出来 —— 否则用户只能对着"连接失败"干瞪眼
  return s.state === 'failed' && s.lastError ? `${label}（${s.lastError}）` : label;
}

// ---------- D1 树展开记忆（持久化到 localStorage） ----------
const TREE_MEMORY_KEY = 'dbstudio.treeExpansion.v1';

// ---------- P1-2 深色模式三态（跟随系统/浅/深） ----------
const THEME_KEY = 'dbstudio.theme';
type ThemeMode = 'system' | 'light' | 'dark';

function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function loadTreeMemory() {
  try {
    const raw = localStorage.getItem(TREE_MEMORY_KEY);
    return raw ? (JSON.parse(raw) as ReturnType<typeof emptyMemory>) : null;
  } catch {
    return null; // 隐私模式/损坏数据 → 静默降级为首帧默认展开
  }
}

function persistTreeMemory(memory: ReturnType<typeof saveExpansion>) {
  try {
    localStorage.setItem(TREE_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // 写不进去就算了：记忆只是体验增强，不值得为它打扰用户
  }
}

/** 找到包含指定连接的【最外层】分组节点的 key（保存连接后自动展开用） */
function findGroupKeyOfConnection(roots: TreeNode[], connId: string): string | null {
  const contains = (nodes: TreeNode[]): boolean =>
    nodes.some(
      (n) =>
        n.key === `conn:${connId}` ||
        (n.kind === 'group' && contains(n.children ?? [])),
    );
  for (const n of roots) {
    if (n.kind === 'group' && contains(n.children ?? [])) return n.key;
  }
  return null;
}

/** 历史条目 → 面板候选。标题取 SQL 首行，sql 原文挂在自定义字段供回填 */
export interface HistoryPaletteItem extends PaletteItem {
  sql: string;
  /** V6：数值 id（删单条/星标用；demo 下也自增） */
  histId: number | null;
  /** V6：是否星标 */
  starred: boolean;
}

function historyEntryToItem(e: HistoryEntry): HistoryPaletteItem {
  const firstLine = (e.sql.trim().split('\n')[0] ?? '').trim();
  const when = new Date(e.executedAt);
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return {
    id: `hist:${e.id ?? `${e.executedAt}:${firstLine}`}`,
    title: firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || '(空语句)',
    subtitle: `${e.database ?? '—'} · ${e.rowCount} 行 · ${e.durationMs}ms · ${hhmm}`,
    badge: e.starred ? '历史·星标' : e.success ? '历史' : '历史·失败',
    sql: e.sql,
    histId: e.id ?? null,
    starred: e.starred,
  };
}

function snippetToCommand(s: Snippet, connName?: string): CommandDef {
  return {
    // T04/R06：id/action 带 (connectionId, database, name) 完整身份 —— 只带 name
    // 会让两个库里的同名片段在命令面板里互相顶替（应用时命中列表第一个）。
    id: snippetCommandId(s),
    action: snippetActionOf(s),
    title: s.name,
    subtitle: snippetOriginLabel(s, connName),
    badge: '片段',
    keywords: ['snippet', '片段', s.name, s.database].filter(Boolean),
  };
}

// ---------- 三栏布局：侧栏 / 详情面板宽度可拖拽（持久化到 localStorage） ----------
const LAYOUT_KEY = 'dbstudio.layout.v1';
interface LayoutState {
  sidebarW: number;
  detailW: number;
}
const SIDEBAR_W = { min: 180, max: 520, def: 240 };
const DETAIL_W = { min: 220, max: 600, def: 280 };
const clampW = (w: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(w)));

function readLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { sidebarW: SIDEBAR_W.def, detailW: DETAIL_W.def };
    const p = JSON.parse(raw) as Partial<LayoutState>;
    return {
      sidebarW: clampW(Number(p.sidebarW) || SIDEBAR_W.def, SIDEBAR_W.min, SIDEBAR_W.max),
      detailW: clampW(Number(p.detailW) || DETAIL_W.def, DETAIL_W.min, DETAIL_W.max),
    };
  } catch {
    return { sidebarW: SIDEBAR_W.def, detailW: DETAIL_W.def };
  }
}

/**
 * 面板分隔条：按住左右拖调整相邻面板宽度。
 *
 * 实现口径：pointer capture 拖拽（不监听 window，指针出窗也拿得到 move）；
 * 增量式回报 dx，由 App 决定加到哪一侧 —— 组件不感知布局语义。
 * 拖拽期间给 body 挂 .resizing：全局禁选中 + col-resize 光标，防止文本被刮蓝。
 */
const PanelResizer = memo(function PanelResizer({
  title,
  onDrag,
  onDragEnd,
}: {
  title: string;
  onDrag: (dx: number) => void;
  onDragEnd: () => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      if (dx !== 0) onDrag(dx);
    },
    [onDrag],
  );

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      // lostpointercapture 事件里 capture 可能已经不在了：有才释放，避免 NOOP 之外的异常
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.classList.remove('resizing');
      onDragEnd();
    },
    [onDragEnd],
  );

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onLostPointerCapture={finish}
    />
  );
});

/**
 * promptEveryTime 连接的密码输入弹窗。
 * 明文只在内存里活到这次 connConnect 调用（红线 3：绝不落盘/不进状态树持久位置）。
 */
function PasswordPromptModal({
  cfg,
  onCancel,
  onSubmit,
}: {
  cfg: ConnectionConfig;
  onCancel: () => void;
  onSubmit: (password: string) => void;
}) {
  const [pwd, setPwd] = useState('');
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal password-modal" onClick={(e) => e.stopPropagation()}>
        <header>输入密码 — {cfg.name}</header>
        <div className="body">
          <label className="ce-field" data-field="connect-password">
            <span className="ce-label">密码</span>
            <div className="ce-input">
              <input
                type="password"
                value={pwd}
                autoFocus
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pwd) onSubmit(pwd);
                  if (e.key === 'Escape') onCancel();
                }}
                placeholder="该连接要求每次手动输入密码"
              />
            </div>
          </label>
        </div>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={!pwd} onClick={() => onSubmit(pwd)}>
            连接
          </button>
        </footer>
      </div>
    </div>
  );
}

export function App() {
  // ---- 连接与树 ----
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [schemas, setSchemas] = useState<Record<string, DatabaseMeta[]>>({});
  const [connStates, setConnStates] = useState<Record<string, { state: string; lastError: string | null }>>({});
  /** onConnectNode 的守卫要同步读最新状态，不经 state 闭包（setState 异步） */
  const connStatesRef = useRef(connStates);
  connStatesRef.current = connStates;
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * 0.7.3（P2-29）：空分组路径清单。
   *
   * 分组是**派生**的（连接的 `group` 字段），所以"没有连接的分组"本不存在 ——
   * 用户点「新建分组」后它会立刻消失。这份清单被 buildTree 并进树里，
   * 只存路径、不碰连接与凭据。声明在这里（而不是靠近用途）是因为 treeRoots 要用它。
   */
  const [emptyGroups, setEmptyGroups] = useState<string[]>(() => loadEmptyGroups());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /**
   * 0.7.1（真机反馈 3）：中间对象清单的**作用域锚点**。
   *
   * 为什么不直接用 `activeKey`：单击清单里的表会把选中项指到那张表
   * （`obj:...`），而 `scopeFromActiveKey('obj:...')` 返回 null —— 清单会从
   * "本库的表"瞬间跳成"全部连接的对象"。用户点一下行，列表内容全变，很难受。
   *
   * 所以拆成两份状态：
   *   `activeKey`    = 当前选中项（树与清单共用，右侧详情/树高亮都看它）
   *   `obScopeKey`   = 清单作用域（**只有树上选库/类别/连接时才更新**，obj 选择不动）
   * 初始都是 null（= 全部连接概览），行为与拆分前一致。
   */
  const [obScopeKey, setObScopeKey] = useState<string | null>(null);
  /**
   * v0.6.0：树上被多选的对象节点 key（由 TreeView 经 onSelectionChange 回传）。
   *
   * 状态放在宿主而不是树内部：批量删除要在这里弹危险确认、走 mutationApply，
   * 树组件不该、也不需要知道删除这件事。
   */
  const [treeSelection, setTreeSelection] = useState<Set<string>>(() => new Set());

  // ---- 多标签工作区（P0-4）：表/查询混排，切换保留状态 ----
  const ws = useWorkspaceTabs();
  /** 当前激活的 table tab（激活的是 query tab 时为 null） */
  const openTab: TableTabState | null = ws.active?.kind === 'table' ? ws.active : null;
  const activeTab = ws.active;

  /**
   * 🔴 每个 table tab 一个 GridDataSource，且**只在 payload 变化时重建**。
   *
   * 这是「切回标签保留脏标记」的载体：GridDataSource 持有脏单元格 Map，
   * 只要 tab 不被关闭，Map 就不重建 —— DataGrid 的 scrollTop 与选择模型
   * 同理（它们活在未被卸载的 DOM 里）。
   */
  const sourcesRef = useRef(new Map<string, { payload: unknown; source: GridDataSource }>());
  const sources = useMemo(() => {
    const next = new Map<string, GridDataSource>();
    for (const t of ws.tabs) {
      if (t.kind !== 'table' || !t.payload) continue;
      const cached = sourcesRef.current.get(t.id);
      if (cached && cached.payload === t.payload) {
        next.set(t.id, cached.source);
      } else {
        const ds = new GridDataSource(t.payload);
        sourcesRef.current.set(t.id, { payload: t.payload, source: ds });
        next.set(t.id, ds);
      }
    }
    // 清理已关闭 tab 的引用（payload 随之可回收 —— R8 内存有界）
    const live = new Set(ws.tabs.map((t) => t.id));
    for (const id of [...sourcesRef.current.keys()]) {
      if (!live.has(id)) sourcesRef.current.delete(id);
    }
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.tabs]);

  const [rowHeightMode, setRowHeightMode] = useState<RowHeightMode>('standard');
  const [preview, setPreview] = useState<{
    tabId: string;
    source: GridDataSource;
    statements: {
      sql: string;
      params: unknown[];
      description?: string;
      hasSqlExpr?: boolean;
      /** T08：逐行 DML 必须恰好影响 1 行；DDL/批量用 'any' */
      expect?: 'one' | 'any';
      kind?: 'insert' | 'update' | 'delete';
      /** T09：行身份 + 定位键（冲突后按它回查库中现值做对比） */
      rowId?: string | null;
      locateColumns?: string[];
      locateValues?: unknown[];
      /** T09：该语句涉及的列「原值 / 待提交值」 */
      pending?: { column: string; original: unknown; next: unknown }[];
      /** T21：该语句的「旧值→新值」摘要（对象/行定位/字段/改前改后） */
      summary?: ChangeSummary;
    }[];
    rejected: { row: number; column: string; reason: string }[];
  } | null>(null);
  /**
   * T09/R15：提交冲突状态。
   *
   * 与 preview 分开：preview 关了之后冲突弹窗才出现（提交已发出、结果已回）。
   * 草稿在此状态下**不清**，由用户决定核对还是放弃。
   */
  const [saveConflict, setSaveConflict] = useState<{
    tabId: string;
    connId: string;
    database: string;
    source: GridDataSource;
    conflicts: ConflictView[];
    totalStatements: number;
    pendingCount: number;
  } | null>(null);
  /**
   * T01 / R01：重载守卫的弹窗状态 + promise 桥。
   *
   * 为什么用 ref 存 resolve：守卫发生在 `loadTable` 内部（唯一数据拉取通道），
   * 而弹窗是 React 渲染 —— 只有把 resolve 挂到 ref，异步的 loadTable 才能
   * 「await 用户点哪个按钮」。同一时刻最多一个守卫（重载是串行的）。
   */
  const [dirtyGuard, setDirtyGuard] = useState<{ tabId: string; title: string; count: number } | null>(null);
  const dirtyGuardResolveRef = useRef<((d: DirtyGuardDecision) => void) | null>(null);
  /**
   * 乐观写入的回滚闭包。
   *
   * 排序 / 快速筛选 / 加载更多 都是「先 patch 状态、再由 effect 触发重拉」，
   * 取消重载时必须把这次的乐观写入撤回，否则列头箭头变了、数据却没重排
   * ——那是一个比原来的丢数据更难察觉的假状态。
   */
  const dirtyGuardRollbackRef = useRef<{ tabId: string; run: () => void } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * P1-11：Toast 三态。
   *
   * 原来只有一个 string，成功/失败共用同一块常驻橙色底 —— 用户看不出
   * 「刚才那下成了还是炸了」。现在带 tone：ok 自动消失、error 常驻但可关，
   * tone 由文案推断（`inferToastTone`），调用点保持 `setToast(text)` 写法不变；
   * 需要精确语义时传第二个参数覆盖。
   */
  const [toast, setToastState] = useState<{ text: string; tone: ToastTone } | null>(null);
  const setToast = useCallback((text: string, tone?: ToastTone) => {
    setToastState({ text, tone: tone ?? inferToastTone(text) });
  }, []);
  const dismissToast = useCallback(() => setToastState(null), []);
  /** ok 类到点自动消失；warn/error 常驻（错误信息是排查现场的唯一线索） */
  useEffect(() => {
    if (!toast) return;
    const ms = toastAutoDismissMs(toast.tone);
    if (ms === null) return;
    const timer = window.setTimeout(() => {
      // 只清自己这条：期间可能有新 toast 顶上来，不能误清
      setToastState((cur) => (cur === toast ? null : cur));
    }, ms);
    return () => window.clearTimeout(timer);
  }, [toast]);
  /** F5：激活 tab 网格的选中统计（状态栏显示「选中 N 行 / M 格」） */
  const [selectionSummary, setSelectionSummary] = useState<{ rows: number; cells: number } | null>(null);

  // ---- 深色模式三态（P1-2）----
  // 启动首帧的主题由 public/theme-boot.js 在 CSS 之前同步设置（无闪烁），
  // 这里接管运行时切换：system 模式监听系统变化，浅/深显式覆盖 data-theme。
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readThemeMode);
  const setThemeMode = useCallback((m: ThemeMode) => {
    setThemeModeState(m);
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      // 同树记忆：写不进去只影响下次启动的默认值
    }
  }, []);
  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(themeMode) + 1) % order.length];
    setThemeMode(next);
    setToast(`主题：${{ system: '跟随系统', light: '浅色', dark: '深色' }[next]}`);
  }, [themeMode, setThemeMode]);

  // ---- F2 字体缩放（原生菜单 ⌘=/⌘-/⌘0 与命令面板共用）----
  // zoom 直接作用于 document.body，不需要 React 重渲染；但偏好面板要显示当前档位，
  // 所以额外用一份 state 镜像（只在面板可见时才有意义，不进热路径）。
  const [fontZoom, setFontZoom] = useState<number>(() => loadFontZoom() ?? 1);
  const zoomStep = useCallback((dir: 'in' | 'out' | 'reset') => {
    const next = nextZoom(loadFontZoom() ?? 1, dir);
    applyFontZoom(next);
    saveFontZoom(next);
    setFontZoom(next);
  }, []);
  // 启动时恢复上次的缩放档位
  useEffect(() => {
    const z = loadFontZoom();
    if (z && z !== 1) applyFontZoom(z);
    setFontZoom(z ?? 1);
  }, []);

  // ---- V5 偏好设置（⌘,）----
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const patchPrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((cur) => patchPreferences(cur, patch));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = themeMode === 'dark' || (themeMode === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (themeMode !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themeMode]);

  // ---- 查询历史与片段（P1-3，IPC 已就绪）----
  // 历史不在这里预取：@ 模式的 historySource 按关键词拉（historySearch 真搜库）。
  // 片段要拼进命令集，所以面板打开时拉一次。
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  /**
   * 编辑器注入句柄登记表：查询标签 id → setDoc 函数。
   * SqlEditorPanel 挂载后登记、卸载时注销（CodeMirror 实例归它私有，App 层够不着）。
   */
  const injectorsRef = useRef(new Map<string, (sql: string) => void>());
  const registerInjector = useCallback((key: string, fn: ((sql: string) => void) | null) => {
    if (fn) injectorsRef.current.set(key, fn);
    else injectorsRef.current.delete(key);
  }, []);

  /**
   * T12 / I04：⌘S 在查询标签下的去向 —— 向该标签投递「保存为片段」信号。
   *
   * 只装一个 `{ tabId, n }`：同一时刻只可能有一个激活查询标签，用 Map 是过度设计。
   * `n` 递增保证连按 ⌘S 每次都能开窗（数值相等时 React 不重渲染，面板也不会重开门）。
   */
  const [snippetReq, setSnippetReq] = useState<{ tabId: string; n: number } | null>(null);
  /**
   * 重渲染触发器。
   *
   * 🔴 为什么需要它：`GridDataSource` 的脏单元格 Map 是【可变对象】，
   *    React 无从感知 —— 编辑完不 bump 一次，网格上的脏标记不会出现。
   *    这是 intentionally-unread state：只写不读，唯一作用就是触发重渲染。
   */
  const [, touch] = useState(0);
  const rerender = useCallback(() => touch((v) => v + 1), []);

  // ---- 连接编辑器（§6.1）----
  /**
   * 编辑器打开态：`'closed'` 关闭 / `'new'` 新建 / 对象 = 预填已有连接。
   *
   * 🔴 用判别联合而不是「config + duplicateOf 两个 state」：副本标记必须与预填的
   *    配置**同生同灭**。分成两个 state 时，任何一条早退路径忘了清标记，下一次
   *    「编辑连接」就会静默变成「保存副本」—— 用户看到的是"原连接丢了"。
   *    `duplicateOf` 非空 = P1-8 创建副本（保存走新建 + 密文由主进程从源连接复制）。
   */
  type EditorState =
    | 'closed'
    | 'new'
    | { config: ConnectionConfig; duplicateOf: string | null };
  const [editorState, setEditorState] = useState<EditorState>('closed');

  // ---- promptEveryTime 连接的密码弹窗（§6.1.1：每次手动输入密码） ----
  const [pwdPrompt, setPwdPrompt] = useState<ConnectionConfig | null>(null);

  // ---- 树右键菜单（Navicat 式各级别操作） ----
  const [ctxMenu, setCtxMenu] = useState<TreeContextMenuState | null>(null);

  // ---- 三栏布局宽度（可拖拽，持久化） ----
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const persistLayout = useCallback(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutRef.current));
    } catch {
      // 写不进去只影响下次启动的默认宽度，不值得打扰用户
    }
  }, []);

  // ---- 导出/导入弹窗（§6.6 / D3） ----
  // 泛化为显式目标：工具栏按钮用当前表 tab，树右键可直接对任意表导出/导入。
  // B7：sql 非空时导出「查询结果（自定义 SQL）」，table 可为 null（无表元数据上下文）。
  const [exportTarget, setExportTarget] = useState<{
    connId: string;
    database: string;
    table: TableMeta | null;
    sql?: string | null;
    columns?: { name: string; dataType: string }[] | null;
    /**
     * P0-1：导出时点已经落定的网格快照（目前只有「查询结果导出」从编辑器面板
     * 直接带过来）。表导出不在这里存 —— 那些入口拿不到网格，快照在渲染弹窗时
     * 从注册表按标签现取（见 exportSnapshotFor），避免在 5 个入口各写一遍。
     */
    snapshot?: GridSnapshotSource | null;
  } | null>(null);
  /**
   * P0-1：网格快照注册表（tabId → 读快照）。
   *
   * 网格只在**用户点导出那一刻**才被要求物化快照 —— 逐次上报会在拖选时
   * 每帧解码整张表。注册表用 ref：它不参与渲染，只被导出入口读一次。
   */
  const exportSnapshotGetters = useRef(new Map<string, () => GridSnapshotSource>());
  const registerExportSnapshot = useCallback((tabId: string, get: (() => GridSnapshotSource) | null) => {
    if (get) exportSnapshotGetters.current.set(tabId, get);
    else exportSnapshotGetters.current.delete(tabId);
  }, []);
  /**
   * P0-1：这次导出对应的网格快照。
   *
   * 三种来源，优先级从高到低：
   *  ① exportTarget.snapshot —— 查询结果导出，面板在点击那一刻就取了；
   *  ② 与导出目标同身份的**表标签**（连接 + 库 + 表名三者都对）→ 现取；
   *  ③ 都没有 → null（树右键导出一张没打开的表），弹窗据此禁用快照选项。
   * 🔴 这里绝不用「当前激活标签」兜底：导出的可能是树里右键的另一张表，
   *    拿激活标签的行会导错数据 —— 那是最坏的失败形态（看起来成功）。
   */
  const exportSnapshot = useMemo<GridSnapshotSource | null>(() => {
    if (!exportTarget) return null;
    if (exportTarget.snapshot) return exportTarget.snapshot;
    const tab = ws.tabs.find(
      (t): t is TableTabState =>
        t.kind === 'table' &&
        t.connId === exportTarget.connId &&
        t.database === exportTarget.database &&
        !!exportTarget.table &&
        t.tableName === exportTarget.table.name,
    );
    if (!tab) return null;
    const get = exportSnapshotGetters.current.get(tab.id);
    return get ? get() : null;
  }, [exportTarget, ws.tabs]);
  const [importTarget, setImportTarget] = useState<{ connId: string; database: string; table: TableMeta } | null>(null);
  /** 运行 SQL 脚本（库/表级别）：connId + 目标库上下文 */
  const [scriptTarget, setScriptTarget] = useState<{ connId: string; database: string } | null>(null);
  /**
   * V7：连接级入口的「目标库选择」前置。
   * 连接可能挂多个库（库/表级入口天然带库上下文，连接级没有）——
   * 先让用户挑库，再进入既有脚本流程，避免脚本跑到错误的库上。
   */
  const [scriptDbPick, setScriptDbPick] = useState<{
    connId: string;
    connName: string;
    databases: string[];
  } | null>(null);

  // ---- 表设计器（§6.5） ----
  const [designer, setDesigner] = useState<{
    mode: 'new' | 'edit';
    database: string;
    table: TableMeta | null;
    /** 树右键打开时显式带上连接（否则按库反查/当前 tab 兜底） */
    connId?: string;
  } | null>(null);

  // ---- 危险操作确认（P0-3，§8.5） ----
  const [dangerRequest, setDangerRequest] = useState<DangerConfirmRequest | null>(null);
  const dangerResolveRef = useRef<((v: boolean) => void) | null>(null);

  // ---- 右侧详情面板（§6.7） ----
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [cell, setCell] = useState<CellSelection | null>(null);
  /**
   * 缺陷 5：单元格完整值弹窗（原详情面板第三块搬过来的能力）。
   * null = 关闭。table/database 一并存下来 —— 弹窗要按列类型判定二进制、
   * 拼保存文件名，而这些在关闭前都不该随「用户又点了别的表」而变化。
   *
   * T31/T32 新增两个字段：
   *  - pending：脏格的待提交值（openInspectCell 时刻的快照；无脏格 = undefined）
   *  - editable：表可写时才给「编辑」入口（SQL 结果网格不传）
   */
  const [cellModal, setCellModal] = useState<
    (CellSelection & {
      /** 弹窗来自哪个 tab（onCommitDraft 要按它写脏格） */
      tabId: string;
      table: TableMeta | null;
      database: string | null;
      pending?: { value: string | null; provided: boolean };
      editable?: boolean;
    }) | null
  >(null);

  // ---- 筛选器（§6.3.3） ----
  /**
   * 🔴 弹窗编辑的是 **草稿**（`filterDraft`），不是已应用的筛选。
   *
   * 旧写法把 FilterBuilder 的 onChange 直接接 `setFilterModel`，而「已应用」的
   * 真值是 `tab.filter`（loadTable 会写回）。后果有两处，都不是理论问题：
   *   ① 加了条件再点「取消」→ 草稿留在了全局态里 → 工具栏「筛选 (2)」、
   *      状态栏「筛选：2 条」照显示，而数据根本没筛；下次点「应用」还会把
   *      用户以为已丢弃的条件用上。**「取消」变成了空按钮。**
   *   ② 全局镜像**切表不同步** → 从 A 表切到 B 表，徽标仍显示 A 表的条件数。
   * 现在：徽标/导出/状态栏一律从 `openTab.filter` 派生（唯一真值），
   *       草稿只在弹窗生命周期内存在，取消即丢弃。
   */
  const [filterDraft, setFilterDraft] = useState<FilterModel | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  /** 编辑器用的连接上下文：当前打开的 tab 所属连接，否则第一个连接 */
  const sqlConnId = activeTab?.connId ?? connections[0]?.id ?? null;
  const sqlDatabases = useMemo(() => (sqlConnId ? (schemas[sqlConnId] ?? []) : []), [schemas, sqlConnId]);
  const readOnlyConn = useMemo(
    () => connections.find((c) => c.id === sqlConnId)?.readOnly ?? false,
    [connections, sqlConnId],
  );

  const readOnlyConns = useMemo(
    () => Object.fromEntries(connections.map((c) => [c.id, c.readOnly === true])),
    [connections],
  );

  /**
   * P1-14：最近打开过的表（`connId:db:table` → epoch ms）。
   *
   * 命令面板的排序早就支持 lastUsedAt 半衰期加权，但条目从不带这个字段 ——
   * 能力建了却空转。这里持有镜像；真正的写入在 openTableTabInner 成功路径。
   */
  const [recentTables, setRecentTables] = useState<Record<string, number>>(() => loadRecentTables());

  /** 打开面板时拉一次片段（demo 后端返回空数组，UI 照常工作） */
  useEffect(() => {
    if (!paletteOpen) return;
    let alive = true;
    void (async () => {
      try {
        const snips = await backend.snippetList();
        if (alive) setSnippets(snips);
      } catch {
        // 片段库读不到不该挡住面板 —— 留空即可
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen]);

  /**
   * 全局危险确认入口。
   *
   * 🔴 P0-4（审计）：**目标连接必须显式传入**，不再从 `activeTab` 猜。
   *
   * 原来的判定是 `activeTab?.connId ?? connections[0]?.id` —— 用的是「当前激活标签」，
   * 与「这次要操作哪个连接」毫无关系。现状没爆只因为 6 个调用点都显式传了
   * `requireText`；任何一个新调用点漏传，就会「对生产库不要求输表名」。
   * 改成必填形参后，漏传是**编译错误**而不是运行时事故。
   *
   * 两条升第三层（手动输入表名/库名）的路径：
   *  1. req.requireText 已有值（DROP DATABASE / 设计器删列 / 无 WHERE 的 DELETE）
   *  2. **本次目标连接**是生产环境（红色标签，colorTag === 'red'）
   */
  const confirmDanger = useCallback(
    (targetConnId: string | null, req: DangerConfirmRequest): Promise<boolean> => {
      const isProduction =
        !!targetConnId && connections.find((c) => c.id === targetConnId)?.colorTag === 'red';
      const finalReq: DangerConfirmRequest = isProduction
        ? { ...req, requireText: req.requireText ?? req.title.match(/表\s+(\S+)/)?.[1] ?? null }
        : req;
      return new Promise((resolve) => {
        dangerResolveRef.current = resolve;
        setDangerRequest(finalReq);
      });
    },
    [connections],
  );

  const onDangerResolve = useCallback((confirmed: boolean) => {
    dangerResolveRef.current?.(confirmed);
    dangerResolveRef.current = null;
    setDangerRequest(null);
  }, []);

  // ---------- 首屏之后的空闲时间：预热编辑器 chunk（E3） ----------
  useEffect(() => {
    warmupEditorChunk();
  }, []);

  // ---------- 启动：拉连接列表 ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await backend.connList();
        if (!alive) return;
        setConnections(r.connections);
        setConnStates(r.states);
        setSchemas(r.schemas);
      } catch (e) {
        if (alive) setBootError(String(e instanceof Error ? e.message : e));
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 🔴 订阅主进程的连接状态推送（2026-09-29 缺陷 1 的接线补全）。
   *
   * 此前 App 只在启动时 `connList()` 读一次 connStates，之后**再也不更新** ——
   * 只有 ConnStateBanner 自己订阅了推送。后果是：连接空闲 10 分钟被主进程
   * 自动断开（idle → closed）后，App 的 connStates 仍停在 `connected`：
   *   · 状态栏显示「已连接」（假象）；
   *   · `ensureConnection` 读到 `connected` 直接返回 'ready' → 跳过重连 →
   *     loadTable 照样撞上「连接当前状态 closed」→ 表格空白且无法编辑。
   *
   * 这条订阅是缺陷 1 修复能生效的前提：状态必须先在渲染层同步，
   * ensureConnection 才能识别出「该重连了」。
   *
   * 幂等：推送只带 {id, state, lastError}，按 id 覆盖即可；重复推送同一状态
   * 也只是写回同值（React 会跳过无变化渲染）。demo 后端的 onConnState 是空订阅，
   * 浏览器 dev 下这段天然不触发，不需要额外分支。
   */
  useEffect(() => {
    const unsub = backend.onConnState((ev) => {
      if (!ev || typeof ev.id !== 'string') return;
      const state = typeof ev.state === 'string' ? ev.state : '';
      if (!state) return;
      const lastError = typeof ev.lastError === 'string' ? ev.lastError : null;
      setConnStates((prev) => ({ ...prev, [ev.id]: { state, lastError } }));
    });
    return unsub;
  }, []);

  /**
   * v0.6.0：订阅 schema 后台刷新结果。
   *
   * 有了它，「刷新失效」的第三处根因（磁盘快照喂完就return、再不回源）才真正闭环：
   * 快照先让树秒出，后台回源拿到新结构后从这条推送回来，schemas 随之更新。
   *
   * ⚠️ 与 connStates 同一条纪律：推送是**唯一**让 schemas 跟上真库的路，
   * 不能只在启动读一次 —— 否则后台刷新的结果没人接，等于没做。
   */
  useEffect(() => {
    const unsub = backend.onSchema((ev) => {
      if (!ev || typeof ev.id !== 'string' || !Array.isArray(ev.databases)) return;
      setSchemas((prev) => {
        const next = ev.databases as DatabaseMeta[];
        // 引用相同就不写回，避免无谓的重渲染（树上千节点，重建代价不小）
        if (prev[ev.id] === next) return prev;
        return { ...prev, [ev.id]: next };
      });
    });
    return unsub;
  }, []);

  // ---------- 树 ----------
  const treeRoots: TreeNode[] = useMemo(() => {
    if (connections.length === 0) return [];
    // 0.7.3：extraGroups 让"空分组"也能出现在树里（分组是派生的，没连接就不存在）
    return buildTree({ connections, schemas, extraGroups: emptyGroups });
  }, [connections, schemas, emptyGroups]);

  // Q2：字段名 → 含该字段的表。搜索框输入字段名时反查表（内存 Map，schema 变化才重建）
  const columnIndex = useMemo(() => buildColumnIndex(schemas), [schemas]);

  /**
   * 缺陷 3：详情面板的数据来源 —— **优先左树当前选中的表节点**，无选中时回退激活标签。
   *
   * 此前 DetailPanel 只吃 `openTab?.table`（激活的表标签），意味着「在树里单击一张表」
   * 不会更新右侧详情，必须双击把表打开成标签才行。用户反馈的正是这一点。
   *
   * 单击选中（onSelectNode → setActiveKey）本就携带了 object 节点的 TableMeta，
   * 这里按 activeKey 在 treeRoots 里定位到节点，把 {table, database, connId} 交给详情面板。
   * 找对象节点用递归（树最深 4 层，且只在 activeKey/schemas 变化时重算，不在热路径）。
   */
  const detailContext = useMemo<{ table: TableMeta; database: string; connId: string | null } | null>(() => {
    if (!activeKey || treeRoots.length === 0) return null;
    let found: { table: TableMeta; database: string; connId: string | null } | null = null;
    const walk = (nodes: TreeNode[]): boolean => {
      for (const n of nodes) {
        if (n.key === activeKey && n.kind === 'object' && n.table && n.database) {
          // obj:<connId>:<db>:<table> → 连接 id 取第 2 段（与 onOpenObject 同口径）
          found = { table: n.table, database: n.database, connId: n.key.split(':')[1] ?? null };
          return true;
        }
        if (n.children && walk(n.children)) return true;
      }
      return false;
    };
    walk(treeRoots);
    return found;
  }, [activeKey, treeRoots]);

  /** 详情面板最终展示的表：树选中优先，其次激活的表标签 */
  const detailTable = detailContext?.table ?? openTab?.table ?? null;
  const detailDatabase = detailContext?.database ?? openTab?.database ?? null;
  const detailConnId = detailContext?.connId ?? openTab?.connId ?? null;

  // D1：首帧不再用 defaultExpanded，改为【恢复持久化的展开记忆】
  //（记忆缺失/版本不符时 restoreExpansion 自己会退回 defaultExpanded）。
  // 没有这条持久化，用户每次启动都要重新展开到上次的库 —— 树上千节点时是灾难。
  const [expandedInitialized, setExpandedInitialized] = useState(false);
  useEffect(() => {
    if (expandedInitialized || treeRoots.length === 0) return;
    setExpanded(restoreExpansion(loadTreeMemory(), treeRoots, connections.map((c) => c.id)));
    setExpandedInitialized(true);
  }, [treeRoots, expandedInitialized, connections]);

  // 展开变化 → 落盘。只存 db:/kind: 层的 key（分组/连接层由 restoreExpansion
  // 永远展开），所以这个写入很小且不随连接数膨胀。
  useEffect(() => {
    if (!expandedInitialized) return;
    const connIds = connections.map((c) => c.id);
    persistTreeMemory(saveExpansion(loadTreeMemory() ?? emptyMemory(), expanded, connIds));
  }, [expanded, expandedInitialized, connections]);

  // ---------- 打开表（多 tab 版） ----------

  /**
   * V22：单表一次拉取的行上限。
   *
   * 原来是 loadTable 里的字面量 3000，这里提成常量 —— 「加载更多」要把它按页
   * 递增，网格的 rowLimit 也必须是同一个数（两处不一致会让底部提示条把
   * 「是否还有更多」算错，出现"点了加载更多却拉回原来那点行"）。
   */
  const TABLE_PAGE_LIMIT = 3000;

  /**
   * V22：每个 tab 当前的行上限（首屏 = TABLE_PAGE_LIMIT，加载更多后按页递增）。
   *
   * 🔴 为什么用 state 而不是 ref：rowLimit 要作为 prop 进网格参与渲染。
   *    但 loadTable 内部读的是它的 ref 镜像 —— 见下方「本次 limit 显式传」的说明。
   */
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({});
  const rowLimitsRef = useRef(rowLimits);
  rowLimitsRef.current = rowLimits;

  /**
   * @param opts.keepSort 是否保留当前排序状态。
   *
   * 🔴 这条参数修掉了一个真实 bug：换表时清排序，但排序触发的重拉必须保留，
   *    否则表头箭头消失、三态循环走不完（详见 git 历史）。
   *
   * 多 tab 语义：loadTable 作用于【目标 tab】（tabId 必传）——
   * 即使该 tab 非激活也能后台刷新（数据写到它自己的 pane 上）。
   *
   * 🔴 ctx（connId/database/tableName/table）必须由调用方显式传入，不能在
   *    函数里 `ws.getTable(tabId)` 取：`setTabs` 是异步调度，【首次打开】时
   *    tabsRef 里还没有这个 tab，getTable 返回 null → 本函数静默 return →
   *    首开表 pane 永远空白、第二次双击才好（真机抓到的时序 bug）。
   *    调用方手上都有这些上下文，传进来零成本。
   *    keepSort 时的 sorts 同理：排序重拉拿不到新 tab，必须把 next sorts 传下来。
   */
  /**
   * T01 / R01：重载前未提交改动守卫 —— 弹三选一并 await 用户决定。
   *
   * 放在 loadTable 之前：守卫要长在 loadTable 内部（唯一数据拉取通道），
   * 这样排序/筛选/刷新/加载更多/外键跳转以及**将来新增**的入口都自动被覆盖，
   * 不必逐个改调用点（逐个守卫是漏一处的经典来源）。
   */
  const requestDirtyDecision = useCallback(
    (tabId: string, count: number) =>
      new Promise<DirtyGuardDecision>((resolve) => {
        dirtyGuardResolveRef.current = resolve;
        setDirtyGuard({ tabId, title: ws.getTable(tabId)?.title ?? tabId, count });
      }),
    [ws],
  );

  const onDirtyGuardResolve = useCallback((d: DirtyGuardDecision) => {
    const resolve = dirtyGuardResolveRef.current;
    dirtyGuardResolveRef.current = null;
    setDirtyGuard(null);
    if (d === 'cancel') {
      // 取消：把这次入口做的乐观写入撤回（列头箭头 / 筛选徽标 / 行上限）
      dirtyGuardRollbackRef.current?.run();
      dirtyGuardRollbackRef.current = null;
    } else if (d === 'discard') {
      // 明确放弃 → 乐观写入保留（用户本来就要排序/筛选），无需求回滚
      dirtyGuardRollbackRef.current = null;
    }
    // d === 'save'：回滚闭包**继续挂着** —— 预演被取消时要靠它还原列头/筛选
    resolve?.(d);
  }, []);

  /** onRequestSave 的 ref 桥：它定义在 loadTable 之后，直接引用会踩 TDZ */
  const onRequestSaveRef = useRef<((tabId: string, source: GridDataSource) => void) | null>(null);

  const loadTable = useCallback(
    async (
      tabId: string,
      ctx: { connId: string; database: string; tableName: string; table: TableMeta },
      opts: { keepSort?: boolean; sorts?: SortSpec[]; filter?: FilterModel | null; limit?: number } = {},
    ) => {
      /**
       * 🔴 查询前必须确保会话可用（2026-09-29 真机缺陷：表格空白、"无法编辑"）。
       *
       * 完整现象链条：连接空闲 10 分钟被 core-connection 的 idle 定时器自动断开
       * → runtime 进入 `closed` → 此时**表结构照常显示**（schemaGetTable 走内存/
       * 磁盘快照，不需要活会话），但 queryOpenTable 在 runQuery 的 beginQueryTracked
       * 处被拒（`连接当前状态 closed，无法执行查询`）→ 网格只剩列头、一行数据都没有
       * → 用户报的「表格查询结果无法直接编辑、编辑按钮点不动」，实质是「压根没有
       * 格子可以编辑」。编辑链路本身没坏（isEditable / beginEdit 均正常）。
       *
       * 为什么修在 loadTable 而不是各个入口：它是**唯一**的数据拉取通道 ——
       * 首开表 / 会话恢复 / 排序 / 筛选 / 右键快速筛选 / 刷新 / 加载更多 /
       * 外键跳转全部经它。此前只有 openTableTab 做了 ensureConnection，
       * 漏掉的恰好是「用户已经在看表、连接却悄悄断了」的高频路径。
       *
       * 经 ref 桥接而不是直接写进依赖：ensureConnection 定义在本函数之后
       * （useCallback 的依赖数组在声明处即求值 → 直接引用会 TDZ 抛错），
       * 而它内部只读 ref 与 setState，是稳定引用，桥接不会造成语义漂移。
       */
      /**
       * 🔴 T01 / R01：重载前未提交改动守卫。
       *
       * 重载会重建 GridDataSource（`useGridDataSource` 按 payload 缓存），
       * 而脏单元格 Map 以「行下标:列下标」为键 —— 换 payload 就等于把用户的
       * 未提交输入连根抹掉，且此前**没有任何提示**（真机复现：输入后点列头排序，
       * 脏格 1→0、输入消失）。
       *
       * 放在 ensureConnection 之前：没必要为了一个会被用户取消的重载先去连库。
       * 三条出口 —— 先保存（走既有预演链路，确认成功后由 onConfirmSave 重拉）/
       * 明确放弃（清脏标记后照常重载）/ 取消（本次不重载，调用方回滚乐观写入）。
       */
      const guardSource = sourcesRef.current.get(tabId)?.source;
      if (guardSource && guardSource.dirtyCount > 0) {
        const decision = await requestDirtyDecision(tabId, guardSource.dirtyCount);
        if (decision === 'cancel') return null;
        if (decision === 'save') {
          onRequestSaveRef.current?.(tabId, guardSource);
          return null;
        }
        // discard：清掉脏标记（含状态栏/标签角标），再按调用方意图继续重载
        guardSource.clearAll();
        // T38：草稿已被用户明确放弃 → 撤销栈跟着失效（否则 ⌘Z 会「复活」被丢弃的改动）
        editHistoryRef.current.get(tabId)?.clear();
        ws.patchTable(tabId, { dirtyCount: 0 });
        rerender();
      }

      const ensure = await ensureConnectionRef.current?.(ctx.connId);
      if (ensure === 'need-password') {
        // 没有存储密码 → 弹密码框；输完由 pendingAfterConnectRef 重放本次拉取
        const cfg = connectionsRef.current.find((c) => c.id === ctx.connId);
        if (cfg) setPwdPrompt(cfg);
        pendingAfterConnectRef.current = () => void loadTableRef.current?.(tabId, ctx, opts);
        setToast('该连接要求手动输入密码，输入后将重新载入表格数据');
        return null;
      }
      if (ensure === 'failed') {
        // 失败原因已由 onConnectNode toast（带原始错误）。这里只把 loading 收掉，
        // 否则标签会永久停在「加载中…」—— 一个转不停的假状态比错误提示更糟。
        ws.patchTable(tabId, { loading: false, loadError: '连接不可用，无法加载数据（原因见连接提示）' });
        return null;
      }

      ws.patchTable(tabId, { loading: true });
      try {
        /**
         * 🔴 参数顺序是 `[...whereParams, ...limitParams]` —— 反了报的错
         *    完全指向别处（`syntax error near ''30''`，把值喂给了 LIMIT）。
         *    这个顺序由 core-driver-mysql 的 buildOpenTableSql 保证，
         *    这里只负责把筛选参数交给它，不自己拼 SQL。
         */
        const sortsForQuery = opts.keepSort ? (opts.sorts ?? []) : [];
        const f = opts.filter === undefined ? null : opts.filter;
        const built = f ? toOpenTableFilter(f) : null;
        const out = await backend.queryOpenTable({
          connId: ctx.connId,
          database: ctx.database,
          table: ctx.tableName,
          /**
           * V22：显式 limit 优先（「加载更多」传新页），否则用该 tab 已翻到的
           * 上限 —— 这样刷新/重排序也保持在用户翻过的量级上，不会莫名其妙缩回一页。
           */
          limit: opts.limit ?? rowLimitsRef.current[tabId] ?? TABLE_PAGE_LIMIT,
          orderBy: sortsForQuery,
          where: built?.where ?? null,
          whereParams: built?.params ?? [],
        });
        ws.patchTable(tabId, {
          table: ctx.table,
          payload: out.payload,
          queryMs: out.elapsedMs,
          truncated: out.truncated,
          sorts: sortsForQuery,
          filter: f,
          loading: false,
          // T47：成功即清错 —— 否则「重试成功」后仍挂着上一次的红块
          loadError: null,
        });
        /**
         * T43：把这次真正生效的排序/筛选记成这张表的视图记忆。
         * 只记「怎么看」，不记数据；空视图（无排序无筛选）会顺手清掉旧记忆。
         * 落盘前剔掉「连列都没选」的占位条件 —— 那是编辑器空行，
         * 存进去下次打开就变成条件条上一条永远「未填完」的假条件。
         */
        saveTableView(ctx.connId, ctx.database, ctx.tableName, {
          sorts: sortsForQuery,
          filter: stripPlaceholderConditions(f),
        });
        /**
         * V9：把行数返回给调用方。
         * 🔴 不能靠调用方去读 sources/ws —— 那两处都要等 React 重渲染才更新，
         *    `await loadTable()` 之后立刻读会拿到旧值（外键跳转就会把
         *    「刚打开的表」误判成 0 行 → 误报"引用行不存在"）。
         */
        return out.rowCount;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setToast(`打开表失败：${msg}`);
        // T47：错误同时落进 tab 状态 —— 空白区要能说出「查挂了」而不是只说零行
        ws.patchTable(tabId, { loading: false, loadError: msg });
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws],
  );

  /**
   * loadTable / ensureConnection / connections 的 ref 桥（缺陷 1 修复所需）。
   *
   * 三者的定义顺序是 loadTable → ensureConnection → onConnectNode，而 loadTable
   * 需要调 ensureConnection —— 直接引用会在 useCallback 依赖求值时踩 TDZ。
   * ref 桥让 loadTable 在**调用时**才取最新实现，声明顺序无关紧要。
   */
  const loadTableRef = useRef<typeof loadTable | null>(null);
  loadTableRef.current = loadTable;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  /** ensureConnection 的 ref 桥（赋值在 ensureConnection 定义之后，见下方） */
  const ensureConnectionRef = useRef<((connId: string) => Promise<'ready' | 'failed' | 'need-password'>) | null>(null);

  /**
   * V22：底部提示条的「加载更多」—— 把该 tab 的行上限加一页后重拉。
   *
   * 返回 Promise：DataGrid 在 Promise 落定前把按钮置 disabled 并显示「加载中…」，
   * 这道闸门是防重复点击的关键（重拉期间连点会并发好几次 LIMIT 6000 的查询）。
   *
   * 🔴 本次的 limit 必须显式传：setRowLimits 是异步调度，紧接着的 loadTable
   *    从 rowLimitsRef 读到的还是上一页的值。
   */
  const loadMoreRows = useCallback(
    async (tabId: string) => {
      const t = ws.getTable(tabId);
      if (!t) return;
      const next = (rowLimits[tabId] ?? TABLE_PAGE_LIMIT) + TABLE_PAGE_LIMIT;
      // T01：行上限也是乐观写入，取消重载时要退回上一页的量级
      if ((sourcesRef.current.get(tabId)?.source.dirtyCount ?? 0) > 0) {
        const prevLimit = rowLimits[tabId] ?? TABLE_PAGE_LIMIT;
        dirtyGuardRollbackRef.current = {
          tabId,
          run: () => setRowLimits((prev) => ({ ...prev, [tabId]: prevLimit })),
        };
      }
      setRowLimits((prev) => ({ ...prev, [tabId]: next }));
      // keepSort + 沿用当前筛选：加载更多是同一批数据的延伸，换条件就不再是"更多"
      await loadTable(
        tabId,
        { connId: t.connId, database: t.database, tableName: t.tableName, table: t.table },
        { keepSort: true, sorts: t.sorts, filter: t.filter, limit: next },
      );
    },
    [ws, rowLimits, loadTable],
  );

  /**
   * T46/T47：「刷新数据」的宿主实现 —— 重跑当前条件（排序 + 筛选）重新拉这一页。
   *
   * 🔴 与「刷新结构」（`onRefreshSchemas`）**是两件事**，命名必须分开：
   *    前者只重查数据、保留 tab 与草稿判定（脏格照旧走 T01 守卫），
   *    后者重建整棵树的表结构快照。报告 §8.2 明确要求拆开叫法。
   */
  const reloadTableData = useCallback(
    async (tabId: string) => {
      const t = ws.getTable(tabId);
      if (!t) return;
      await loadTable(
        tabId,
        { connId: t.connId, database: t.database, tableName: t.tableName, table: t.table },
        { keepSort: true, sorts: t.sorts, filter: t.filter },
      );
    },
    [ws, loadTable],
  );

  // ---- V19 分组着色：状态归宿主（网格不自持，避免两处真相） ----  /** tabId → 分组着色列名；缺省 = 关闭（默认关闭） */
  const [groupStripeByTab, setGroupStripeByTab] = useState<Record<string, string>>({});

  const toggleGroupStripe = useCallback((tabId: string, col: string | null) => {
    setGroupStripeByTab((prev) => {
      if (col === null) {
        if (!(tabId in prev)) return prev; // 已经是关闭态，避免无意义的重渲染
        const rest = { ...prev };
        delete rest[tabId];
        return rest;
      }
      return { ...prev, [tabId]: col };
    });
  }, []);

  // ---- V20 列列表快速定位浮层 ----
  const [finderOpen, setFinderOpen] = useState(false);

  /**
   * 打开列快速定位。
   *
   * 🔴 没有表标签时给中文 toast 而不是静默：快捷键按下去毫无反应是最难自查的
   *    一类问题（用户会以为是键盘坏了）。
   */
  const openColumnFinder = useCallback(() => {
    if (!openTab) {
      setToast('没有打开的表标签，先在左树里双击一张表');
      return;
    }
    setFinderOpen(true);
  }, [openTab]);

  /**
   * 建立真实握手（含 SSH 隧道）。可带本次明文密码（promptEveryTime 场景）。
   *
   * 🔴 失败提示必须**带上原始错误**。隧道失败与数据库认证失败长得很像
   *    （都是"连不上"），但排查方向完全不同 —— 把原文吞掉等于让用户瞎猜。
   *
   * 成功后自动展开该连接节点（conn:<id>）—— 用户单击连接的本意就是看库，
   * 连上了还要再手动展开一次是纯摩擦（2026-09-26 真机反馈）。
   */
  const onConnectNode = useCallback(async (cfg: ConnectionConfig, password?: string | null): Promise<boolean> => {
    if (!cfg) return false;
    // 连接中不接受重复触发（双击会连发 click + dblclick 两次握手意图）
    if (connStatesRef.current[cfg.id]?.state === 'connecting') return false;
    setConnStates((s) => ({ ...s, [cfg.id]: { state: 'connecting', lastError: null } }));
    try {
      const r = await backend.connConnect(cfg.id, password ?? undefined);
      setConnStates((s) => ({ ...s, [cfg.id]: { state: r.state, lastError: null } }));
      setToast(`已连接 ${cfg.name}：${r.serverVersion ?? ''}（${r.elapsedMs}ms）`);
      const dbs = await backend.schemaGet(cfg.id);
      setSchemas((prev) => ({ ...prev, [cfg.id]: dbs }));
      setExpanded((prev) => {
        const key = `conn:${cfg.id}`;
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnStates((s) => ({ ...s, [cfg.id]: { state: 'failed', lastError: msg } }));
      setToast(`连接失败：${msg}`);
      return false;
    }
  }, []);

  /**
   * 确保会话可用（Navicat 语义：看到了库表就应该能直接用）。
   *
   * 🔴 树与查询可能基于【磁盘快照】工作 —— connList 会带回快照 schema，
   * 用户能展开库、看到表、右键新建查询，但会话并未真正建立；此时执行/开表
   * 会撞上「连接未建立」。这里按需自动握手，而不是把错误甩给用户。
   * promptEveryTime 连接没有存储密码，自动握手做不到 —— 弹密码框，
   * 输完通过 pendingAfterConnectRef 继续刚才被打断的动作。
   */
  const ensureConnection = useCallback(
    async (connId: string): Promise<'ready' | 'failed' | 'need-password'> => {
      const state = () => connStatesRef.current[connId]?.state;
      const st = state();
      if (st === 'connected' || st === 'busy') return 'ready';
      if (st === 'connecting') {
        // 别的握手正在进行：等它落定（最多 ~15s），不并发二次握手
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const s = state();
          if (s === 'connected' || s === 'busy') return 'ready';
          if (s !== 'connecting') break;
        }
        return 'failed';
      }
      const cfg = connections.find((c) => c.id === connId);
      if (!cfg) {
        setToast('连接不存在或已被删除');
        return 'failed';
      }
      if (cfg.promptEveryTime) return 'need-password';
      return (await onConnectNode(cfg)) ? 'ready' : 'failed';
    },
    [connections, onConnectNode],
  );

  // 把 ensureConnection 灌进 ref 桥（loadTable 通过它在调用时取最新实现）
  ensureConnectionRef.current = ensureConnection;

  /** promptEveryTime 连接输完密码后要继续的动作（执行 SQL / 打开表） */
  const pendingAfterConnectRef = useRef<(() => void) | null>(null);

  /** 树/命令面板打开表：复用既有 tab 或新开（假定会话已可用） */
  const openTableTabInner = useCallback(
    async (
      connId: string,
      database: string,
      tableName: string,
      /**
       * T39：从查询结果「打开源表」时的**行定位**输入。
       *
       * `values` = 结果行里各列的原始字符串（列名 → 值）。这里**只认**该表的
       * 主键/唯一键列（`locateColumns()` 是唯一判定处）；交集为空时**不做定位**
       * —— 报告 §10 I18 明确要求「无可靠行定位键时不猜行身份」。
       */
      locate?: { column: string; value: string | null }[],
      /**
       * P2-18e：会话恢复专用钩子 —— 建好标签后回报 id，且**不抢焦点**。
       * 恢复时一次建 N 张表，谁最后加载完谁抢焦点，会把用户关窗时看的那张挤掉。
       */
      restore?: { onCreated?: (id: string) => void },
    ) => {
      try {
        const bundle = await backend.schemaGetTable(connId, database, tableName);
        // 🔴 needsLoad 由 openTable 自己算（setTabs 是异步调度，此刻读
        //    tabsRef 拿不到刚建的 tab —— 首开必空白的根因）
        const { id, needsLoad } = ws.openTable(connId, database, bundle.table, {
          activate: !restore,
        });
        restore?.onCreated?.(id);

        /**
         * P1-14：记录「这张表刚被打开」。
         *
         * 🔴 先读盘再写回（不用 setState 的 updater 里写 localStorage）：
         *    React 严格模式下 updater 会被调用两次，副作用写两遍虽然幂等，
         *    但把副作用留在 updater 里是坏习惯，且以后改非幂等操作会立刻出事。
         *    这是冷路径（一次用户点击），多读一次盘无成本。
         */
        {
          const rk = tableMemoryKey(connId, database, tableName);
          const nextRecent = recordTableUsed(loadRecentTables(), rk, Date.now());
          saveRecentTables(nextRecent);
          setRecentTables(nextRecent);
        }

        let filter: FilterModel | null = null;
        let locateNote = '';
        if (locate && locate.length > 0) {
          const keyCols = locateColumns(bundle.table).map((c) => c.name);
          const hits = locate.filter((v) => keyCols.includes(v.column));
          if (keyCols.length === 0) {
            locateNote = '该表没有主键/唯一键，无法定位到具体行（表格已按无条件下打开）';
          } else if (hits.length === 0) {
            locateNote = `结果里没有 ${keyCols.join(' / ')} 这些定位列，未做行定位（不猜行身份）`;
          } else if (hits.some((h) => h.value === null)) {
            // NULL 不能进 `=` 比较（SQL 里 NULL = NULL 恒为假）—— 如实说明，不静默丢条件
            locateNote = '定位列在结果里是 NULL，无法用等值定位该行（表格已按无条件下打开）';
          } else {
            filter = {
              groups: [
                {
                  id: 'g-locate',
                  logic: 'AND',
                  conditions: hits.map((h, i) => ({
                    id: `c-locate-${i}`,
                    column: h.column,
                    operator: 'eq' as const,
                    value: h.value as string,
                  })),
                },
              ],
            };
            locateNote = `已按 ${hits.map((h) => h.column).join(' + ')} 定位到该行`;
          }
        }

        // 复用已有 tab 且已加载，但这次带定位条件 → 仍要按条件重查一次
        if (needsLoad || filter) {
          /**
           * T43：首次打开时恢复这张表的**视图记忆**（排序 + 筛选）。
           * 键是 conn:db:table —— 两连接同名库表不会互相污染。
           * 恢复的筛选会在条件条（T26）里列出来，用户能看见「为什么只有几行」。
           * 本次带定位条件（filter != null）时**以定位为准**，不叠加旧筛选
           * （叠加会让「打开源表定位那一行」定位不到）。
           */
          const memory = needsLoad ? loadTableView(connId, database, tableName) : null;
          // 旧存档可能带着占位条件（历史版本存进去的），恢复前先剔掉：
          // 否则条件条一打开就挂一条「未填完」，用户以为表被筛了。
          const useFilter = filter ?? stripPlaceholderConditions(memory?.filter ?? null);
          const useSorts = memory && memory.sorts.length > 0 ? memory.sorts : null;
          void loadTable(
            id,
            { connId, database, tableName, table: bundle.table },
            {
              ...(useFilter ? { filter: useFilter } : {}),
              ...(useSorts ? { keepSort: true, sorts: useSorts } : {}),
            },
          );
        }
        if (locateNote) setToast(locateNote);
        return { ok: true as const, note: locateNote };
      } catch (e) {
        setToast(`打开表失败：${e instanceof Error ? e.message : String(e)}`);
        return { ok: false as const, note: '' };
      }
    },
    [ws, loadTable],
  );

  /** 开表入口：表列表可能来自磁盘快照 —— 先确保会话可用（自动握手）再开 */
  const openTableTab = useCallback(
    (
      connId: string,
      database: string,
      tableName: string,
      /** T39：从查询结果打开源表时带上的行定位值（列名 → 原值） */
      locate?: { column: string; value: string | null }[],
    ) => {
      void (async () => {
        const ensure = await ensureConnection(connId);
        if (ensure === 'ready') {
          await openTableTabInner(connId, database, tableName, locate);
          return;
        }
        if (ensure === 'need-password') {
          const cfg = connections.find((c) => c.id === connId);
          if (cfg) setPwdPrompt(cfg);
          pendingAfterConnectRef.current = () => void openTableTabInner(connId, database, tableName, locate);
          setToast('该连接要求手动输入密码，输入后将继续打开表');
        }
        // failed：握手失败的真实原因已由连接路径 toast
      })();
    },
    [ensureConnection, openTableTabInner, connections],
  );

  // ---- F4 会话恢复：重启后还原上次的工作区 ----
  // query 标签带 SQL 原文直接重建；table 标签只存三元组，走 openTableTabInner 重拉
  //（内部自带握手与静默失败 —— 快照里的表可能已被删）。
  const restoredRef = useRef(false);
  /** P2-18e：恢复中的「目标标签下标 + 各标签新 id」，全部就绪后激活一次 */
  const restoreActivateRef = useRef<{ idx: number; ids: (string | null)[] } | null>(null);
  useEffect(() => {
    if (restoredRef.current || booting) return;
    restoredRef.current = true;

    /**
     * V23 多窗口：本窗口是「带初始标签打开」的（菜单/命令面板「在新窗口打开」）。
     *
     * 🔴 有初始标签时**跳过会话恢复** —— 否则每开一个对照窗口，
     *    都会把上次工作区的所有标签再复制一遍，"对照两张表"立刻变成十几个标签。
     *    会话恢复是「重启应用」的语义，任务窗口是「现在就给我看这张表」的语义，
     *    两者不该叠在一起。也不覆盖快照：关掉活动窗口后下次启动仍恢复原工作区。
     */
    const initial = window.dbStudioInitialTab ?? null;
    if (initial) {
      void openTableTabInner(initial.connId, initial.database, initial.table);
      return;
    }

    /**
     * 🔴 恢复前先核一遍连接还在不在 —— 快照是**上次退出时**的，连接可能已经被删了
     *    （或换过机器 / 换过 userData）。恢复出一个指向不存在连接的标签，
     *    状态栏会显示「连接：未知」（`connStates` 里没有它），而执行按钮只判
     *    `!connId` 所以照样可点 —— 一点就 NOT_CONNECTED。**比不恢复更糟**：
     *    用户看到的是"能点但必然失败"，还看不出原因。宁可少恢复一个标签。
     *
     *    实测现场：真机 e2e 互相污染时，localStorage 里留下 `dbstudio.session.v1`，
     *    下一次冷启动恢复出 connId 已失效的 query 标签 → 状态栏「连接：未知」。
     *    过滤放在纯逻辑层 `restorePlan`（可单测），不藏在这个 effect 里。
     */
    const alive = (connId: string) => connections.some((c) => c.id === connId);
    const snapshot = loadSessionSnapshot(alive);
    if (!snapshot) return;
    /**
     * P2-18e：恢复后要落回**关闭前正在看**的那个标签。
     *
     * 存的是下标（tab id 每次启动都重新生成）。这里把"恢复顺序 → 新 tab id"
     * 收集起来，table 标签是异步建的（要拉 schema），所以由下面的 effect
     * 等到全部就绪后统一激活一次 —— 期间 table 标签不抢焦点（activate:false）。
     *
     * 🔴 必须**串行**重建（`for` + `await`），不能 forEach 里 `void` 并发：
     *    table 标签要等 schemaGetTable 回来才真正 `ws.openTable`，而 query 标签
     *    是同步建的 —— 并发时 query 会先落位，恢复出来的标签顺序就与快照**相反**
     *    （实测：快照 [表, 查询] → 恢复成 [查询, 表]）。
     *    那不只是一次视觉漂移：下标语义整个错位，`activeIndex` 会指向另一个标签，
     *    「落回关闭前的标签」这件事就悄悄失效了。串行的代价是启动时多几次
     *    本地 schema 往返（≤20 个标签），换来顺序与快照严格一致。
     */
    const restoredIds: (string | null)[] = new Array(snapshot.tabs.length).fill(null);
    restoreActivateRef.current = { idx: snapshot.activeIndex, ids: restoredIds };
    void (async () => {
      for (let i = 0; i < snapshot.tabs.length; i++) {
        const t = snapshot.tabs[i];
        if (t.kind === 'query') {
          restoredIds[i] = ws.newQuery(t.connId ?? connections[0]?.id ?? null, t.database, t.initialSql);
        } else {
          await openTableTabInner(t.connId, t.database, t.tableName, undefined, {
            onCreated: (id) => {
              restoredIds[i] = id;
            },
          });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting]);

  /**
   * P2-18e：恢复的标签全部建好后，把焦点还给「关闭前那个」。
   *
   * 只做一次（做完清 ref）—— 否则用户点别的标签会被它反复拽回去。
   * 目标标签若建失败（表被删 / 拉 schema 报错）就停在当前页，不再强扭。
   */
  useEffect(() => {
    const pending = restoreActivateRef.current;
    if (!pending) return;
    if (pending.ids.some((id) => id === null)) return; // 还有 table 标签在建
    restoreActivateRef.current = null;
    const target = pending.ids[pending.idx] ?? pending.ids.find((x): x is string => x !== null) ?? null;
    if (target) ws.activate(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.tabs]);

  // tabs 变化 debounce 落盘；全部关干净时清快照（避免下次恢复出陈旧标签）
  //
  // 🔴 V23：任务窗口（带初始标签打开）**不写快照** —— 它只有一两张对照表，
  //    写下去会把用户真正的工作区快照覆盖成"这一张表"。多窗口共用同一份
  //    userData，快照只有一份，所以写入权必须留给主窗口。
  useEffect(() => {
    if (window.dbStudioInitialTab) return;
    const timer = setTimeout(() => {
      if (ws.tabs.length === 0) {
        clearSessionSnapshot();
        return;
      }
      saveSessionSnapshot(serializeSession(ws.tabs, ws.activeId));
    }, 800);
    return () => clearTimeout(timer);
  }, [ws.tabs, ws.activeId]);

  /**
   * P1-16：浏览对象视图开关。
   *
   * 关 → 中间面板显示激活标签的内容（默认）；开 → 中间面板显示对象清单，
   * 标签页整体让位（DOM 不卸载，编辑器实例/滚动位置都留着）。
   * 默认关：绝大多数操作都在标签里，清单是"找人/找表"时才需要的另一种视角。
   */
  const [browseMode, setBrowseMode] = useState(false);

  const onOpenObject = useCallback(
    (node: TreeNode) => {
      setActiveKey(node.key);
      if (node.kind !== 'object' || !node.table || !node.database) return;
      // 从 key 反查连接 id：obj:<connId>:<db>:<table>
      const connId = node.key.split(':')[1];
      if (!connId) return;
      // P1-16：从浏览视图打开表 → 自动切回标签视图，否则"双击没反应"（开着看不见）
      setBrowseMode(false);
      openTableTab(connId, node.database, node.table.name);
    },
    [openTableTab],
  );

  /** 列命中打开表：连接不确定（同名库表可能跨连接），用当前上下文优先解析 */
  const onOpenTableRef = useCallback(
    (database: string, tableName: string) => {
      const connId =
        activeTab?.connId ??
        connections.find((c) => (schemas[c.id] ?? []).some((d) => d.name === database))?.id ??
        connections[0]?.id;
      if (!connId) {
        setToast(`找不到 ${database} 所属的连接`);
        return;
      }
      openTableTab(connId, database, tableName);
    },
    [activeTab, connections, schemas, openTableTab],
  );

  /** 新建查询 tab：连接上下文跟随当前激活 tab，其次左树选中的库（Navicat 习惯），否则第一个连接 */
  const newQueryTab = useCallback(() => {
    const sel = activeKey ? parseTreeKeyContext(activeKey) : null;
    const connId = activeTab?.connId ?? sel?.connId ?? connections[0]?.id ?? null;
    const database =
      openTab?.database ?? (sel && sel.connId === connId ? sel.database : null) ?? null;
    ws.newQuery(connId, database);
  }, [ws, activeTab, openTab, activeKey, connections]);

  /** ⌘T 工具栏按钮同款入口 */
  const openSql = useCallback(() => {
    const q = ws.tabs.find((t) => t.kind === 'query');
    if (q) ws.activate(q.id);
    else newQueryTab();
  }, [ws, newQueryTab]);

  /**
   * 把 SQL 写进查询编辑器（P1-3 历史回填 / 片段插入的唯一入口）。
   *
   * 落点优先级：激活的查询标签 → 已有的查询标签（激活并写入）→ 新建查询标签。
   * 🔴 竞态：新建的 tab 里 CodeMirror 还在懒加载，注入句柄尚未登记 ——
   *    挂 pendingRef，等 registerInjector 发生时立即补写。
   */
  const pendingInjectRef = useRef<{ tabId: string; sql: string } | null>(null);
  const fillSqlToEditor = useCallback(
    (sql: string) => {
      const queryTabs = ws.tabs.filter((t) => t.kind === 'query');
      const target =
        queryTabs.find((t) => t.id === ws.activeId) ?? queryTabs[queryTabs.length - 1] ?? null;
      if (!target) {
        pendingInjectRef.current = null;
        ws.newQuery(sqlConnId, openTab?.database ?? null, sql);
        return;
      }
      ws.activate(target.id);
      const fn = injectorsRef.current.get(target.id);
      if (fn) fn(sql);
      else pendingInjectRef.current = { tabId: target.id, sql };
    },
    [ws, sqlConnId, openTab],
  );

  // 登记一旦发生，先补写 pending 的注入，再正常登记
  const registerInjectorWithPending = useCallback(
    (key: string, fn: ((sql: string) => void) | null) => {
      registerInjector(key, fn);
      const pending = pendingInjectRef.current;
      if (fn && pending && pending.tabId === key) {
        pendingInjectRef.current = null;
        fn(pending.sql);
      }
    },
    [registerInjector],
  );

  // ---- C2 查看对象定义：SHOW CREATE 原文填进查询标签（只读参考用） ----
  const onShowDefinition = useCallback(
    async (req: ShowDefinitionRequest) => {
      try {
        const r = await backend.schemaGetObjectDdl(req);
        fillSqlToEditor(r.ddl);
        setToast(`已载入 ${req.database}.${req.name} 的定义`);
      } catch (e) {
        setToast(`查看定义失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [fillSqlToEditor],
  );

  /** @ 历史模式的异步数据源：有关键词走 historySearch（真搜库），否则列最近 */
  const historySource = useCallback(
    async (keyword: string): Promise<PaletteItem[]> => {
      const entries = keyword.trim()
        ? await backend.historySearch(keyword.trim(), 50)
        : await backend.historyList(sqlConnId, 50);
      return entries.map(historyEntryToItem);
    },
    [sqlConnId],
  );

  /** V6：历史刷新信号 —— 删/星标后自增，迫使 ⌘K @ 模式重拉列表 */
  const [historyReload, setHistoryReload] = useState(0);

  /**
   * V6：⌘K @ 模式删单条历史。
   * 面板不关（用户可能连续删多条）；删完刷新列表并回报条数。
   */
  const onDeleteHistory = useCallback(
    async (item: PaletteItem) => {
      const id = (item as HistoryPaletteItem).histId;
      if (id == null) {
        setToast('这条历史没有可删除的 id');
        return;
      }
      try {
        const ok = await backend.historyDelete(id);
        setHistoryReload((v) => v + 1);
        setToast(ok ? '已删除这条历史' : '未找到该历史（可能已被清理）');
      } catch (e) {
        setToast(`删除历史失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [],
  );

  /** V6：⌘K @ 模式星标/取消星标 */
  const onToggleHistoryStar = useCallback(
    async (item: PaletteItem, starred: boolean) => {
      const id = (item as HistoryPaletteItem).histId;
      if (id == null) {
        setToast('这条历史没有可星标的 id');
        return;
      }
      try {
        const ok = await backend.historyStar(id, starred);
        setHistoryReload((v) => v + 1);
        setToast(ok ? (starred ? '已星标（不会被自动裁剪）' : '已取消星标') : '未找到该历史');
      } catch (e) {
        setToast(`星标失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [],
  );

  /** 关闭前拦截：table tab 有脏数据 → 确认（PRD §8.5） */
  const beforeCloseTab = useCallback((t: WorkspaceTab): boolean => {
    if (t.kind === 'table' && t.dirtyCount > 0) {
      return window.confirm(
        `标签「${t.title}」有 ${t.dirtyCount} 个未保存的改动。\n关闭将丢弃这些改动，确定关闭吗？`,
      );
    }
    return true;
  }, []);

  const requestCloseTab = useCallback(
    (id: string) => {
      const t = ws.tabs.find((x) => x.id === id);
      if (t && beforeCloseTab(t)) ws.closeTab(id);
    },
    [ws, beforeCloseTab],
  );

  // ---- 排序（服务端执行）：改目标 tab 的 sorts 后重拉该 tab ----
  // direction 由列头右键菜单给（A21）：'ASC'/'DESC' = 显式单列，null = 清空全部；
  // 不传 = 列头左键的三态循环（既有语义）。
  const pendingSortRef = useRef<{ tabId: string; sorts: SortSpec[] } | null>(null);

  const onSortChange = useCallback(
    (tabId: string, cur: SortSpec[], column: string, additive: boolean, direction?: SortDirection | null) => {
      const next =
        direction === null
          ? []
          : direction
            ? applySortDirection(cur, column, direction)
            : applySort(cur, column, additive);
      // T01：排序是「先 patch 再重拉」，若守卫生效且用户取消，必须把列头状态还原，
      // 否则箭头停在新的方向、数据却还是旧的 —— 比丢改动更难察觉的假状态。
      if ((sourcesRef.current.get(tabId)?.source.dirtyCount ?? 0) > 0) {
        dirtyGuardRollbackRef.current = { tabId, run: () => ws.patchTable(tabId, { sorts: cur }) };
      }
      pendingSortRef.current = { tabId, sorts: next };
      ws.patchTable(tabId, { sorts: next });
    },
    [ws],
  );

  // ---- A22：单元格右键快速筛选 —— 并进该 tab 的 FilterModel 后走既有重拉 ----
  const onQuickFilter = useCallback(
    (tabId: string, column: string, value: string | null, op: 'eq' | 'ne' | 'contains') => {
      const tab = ws.getTable(tabId);
      if (!tab) return;
      // 基于当前已生效的筛选追加（不是基于 FilterBuilder 里未应用的编辑态）。
      // 🔴 base 必须是 blankFilter() 而不是 emptyFilter()：后者带一条占位条件
      //    （column 为空），追加后会让条件条上永久挂一条「未填完」——
      //    它不进 WHERE，用户会以为筛选没生效。
      const base: FilterModel = tab.filter ?? blankFilter();
      const groups = base.groups.length > 0 ? base.groups : [{ id: 'g1', logic: 'AND' as const, conditions: [] as FilterCondition[] }];
      const ids = groups.flatMap((g) => g.conditions.map((c) => c.id));
      const cond: FilterCondition =
        value === null
          ? { id: nextId('c', ids), column, operator: 'isNull' }
          : { id: nextId('c', ids), column, operator: op, value };
      const next: FilterModel = {
        groups: groups.map((g, i) => (i === 0 ? { ...g, conditions: [...g.conditions, cond] } : g)),
      };
      // 🔴 这里**不需要**再同步任何全局编辑态：`loadTable` 会把 filter 写回
      //    `tab.filter`，而筛选弹窗打开时是从 `openTab.filter` 取种子的 ——
      //    真值只有一处，弹开面板自然看到刚加的这条。
      // 乐观写回：loadTable 要等查询返回才 patch，期间工具栏徽标/状态栏会显示
      // 旧条件数（用户点了「筛选」却看不到计数变化 = 以为没生效）。
      // T01：同理登记回滚 —— 守卫生效且取消时，筛选徽标必须退回去，不能挂着没生效的条件。
      if ((sourcesRef.current.get(tabId)?.source.dirtyCount ?? 0) > 0) {
        dirtyGuardRollbackRef.current = { tabId, run: () => ws.patchTable(tabId, { filter: tab.filter }) };
      }
      ws.patchTable(tabId, { filter: next });
      void loadTable(
        tabId,
        { connId: tab.connId, database: tab.database, tableName: tab.tableName, table: tab.table },
        { keepSort: true, sorts: tab.sorts, filter: next },
      );
      setToast(value === null ? `筛选：${column} 为 NULL` : `筛选：${column} ${op === 'eq' ? '=' : op === 'ne' ? '≠' : '包含'} ${value}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, loadTable],
  );

  // sorts 变化 → 重拉（真实排序在服务端，必须重查）
  useEffect(() => {
    const pending = pendingSortRef.current;
    if (!pending) return;
    const tab = ws.getTable(pending.tabId);
    if (!tab || tab.sorts !== pending.sorts) return;
    pendingSortRef.current = null;
    void loadTable(
      pending.tabId,
      { connId: tab.connId, database: tab.database, tableName: tab.tableName, table: tab.table },
      { keepSort: true, sorts: pending.sorts, filter: tab.filter },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.tabs, loadTable]);

  // ---- 保存：先预演（硬要求，没有"直接保存"路径） ----
  const onRequestSave = useCallback((tabId: string, source: GridDataSource) => {
    const tab = ws.getTable(tabId);
    if (!tab) return;
    const table = tab.table;
    const dirty = source.dirtyCells();
    if (dirty.length === 0) {
      setToast('没有待保存的改动');
      return;
    }

    const strategy = locateStrategy(table);
    const locateCols = locateColumns(table);
    const columns = table.columns.map((c) => c.name);

    const byRow = new Map<number, EditWithLocate[]>();
    /**
     * A4/D2 追加行（row >= 已加载行数）必须走 INSERT，不能构造 UPDATE ——
     * 它们没有已存在的定位键（source.raw 全 null，会生成 `WHERE pk IS NULL`
     * 这种既匹配不到又可能误伤的 WHERE）。粘贴路径此前同样踩这个坑。
     *
     * V10：追加行的表达式值走 `valueKinds` 稀疏映射（core-mutation 的 INSERT 分支）——
     * 只有标记为表达式的列才原样嵌入，其余照旧 ? 绑定。
     */
    const appended = new Map<number, Record<string, unknown>>();
    const appendedKinds = new Map<number, Record<string, 'literal' | 'sql-expr'>>();
    for (const d of dirty) {
      if (d.row >= source.rowCount) {
        const bucket = appended.get(d.row) ?? {};
        bucket[d.column] = d.value;
        appended.set(d.row, bucket);
        if (d.valueKind === 'sql-expr') {
          const kinds = appendedKinds.get(d.row) ?? {};
          kinds[d.column] = 'sql-expr';
          appendedKinds.set(d.row, kinds);
        }
        continue;
      }
      const locateValues = locateCols.map((c) => {
        const ci = columns.indexOf(c.name);
        return source.raw(d.row, ci);
      });
      const bucket = byRow.get(d.row) ?? [];
      bucket.push({
        column: d.column,
        oldValue: source.raw(d.row, d.col),
        newValue: d.value,
        locateValues,
        rowId: String(d.row),
        locate: strategy,
        // V10：表达式标记必须带下去，丢了就会把 NOW() 写成字符串 'NOW()'
        valueKind: d.valueKind ?? 'literal',
      });
      byRow.set(d.row, bucket);
    }

    /**
     * T19：显式新增的空白行即使**一个脏格都没有**也要进 INSERT。
     *
     * 空白行可能全是「自增 / 有默认值」的列（用户什么都不用填），此时脏集合为空；
     * 若只按脏单元格推导，这一行会被当成不存在 —— 用户点了新增、界面也显示了，
     * 保存后却凭空消失。所以「这一行要被插入」由数据源单独记账。
     */
    for (const row of source.blankRowList()) {
      if (row < source.rowCount) continue; // 只有追加行才是 INSERT
      if (!appended.has(row)) appended.set(row, {});
    }

    const plan = buildMutationPlan(tab.database, table, {
      updates: [...byRow.values()],
      // tempId 用 String(row)：SavePreviewModal 靠 Number(rowId) 显示「第 N 行」
      inserts: [...appended.entries()].map(([row, values]) => ({
        tempId: String(row),
        values,
        valueKinds: appendedKinds.get(row),
        // T19：显式新增的空白行 —— 一个值都没有时也必须生成 INSERT
        blank: source.isBlankRow(row),
      })),
    });

    // T09：把行身份 → 定位键/原值/待提交值 编成表，冲突时按语句 refId 反查，
    // 用来「重载该行并对比」（不依赖语句序号对齐，避免 offset 错位）。
    const metaByRowId = new Map<string, { locateColumns: string[]; locateValues: unknown[]; pending: { column: string; original: unknown; next: unknown }[] }>();
    for (const [row, edits] of byRow) {
      metaByRowId.set(String(row), {
        locateColumns: locateCols.map((c) => c.name),
        locateValues: locateCols.map((c) => source.raw(row, columns.indexOf(c.name))),
        pending: edits.map((e) => ({ column: e.column, original: e.oldValue, next: e.newValue })),
      });
    }

    setPreview({
      tabId,
      source,
      statements: plan.statements.map((s) => {
        const meta = s.refId ? metaByRowId.get(s.refId) : undefined;
        return {
          sql: s.sql,
          params: s.params,
          description: s.description,
          // V10：含表达式的语句在预演里显式标注（用户必须知道这段原文即将执行）
          hasSqlExpr: s.hasSqlExpr,
          // T08/R15：逐行 DML 声明「恰好 1 行」契约 —— 主进程逐条核对，不符整批回滚
          kind: s.kind,
          expect: 'one' as const,
          rowId: s.refId ?? null,
          locateColumns: meta?.locateColumns,
          locateValues: meta?.locateValues,
          pending: meta?.pending,
          // T21：把 core-mutation 算好的「旧值→新值」摘要透传给预览弹窗
          summary: s.summary,
        };
      }),
      rejected: plan.rejected.map((r) => ({ row: Number(r.rowId ?? 0), column: r.column, reason: r.reason })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // T01：把 onRequestSave 灌进 ref 桥，供 loadTable 的守卫在待保存时调用
  onRequestSaveRef.current = onRequestSave;

  /**
   * T12 / I04：「保存」这一刻的分流（原生菜单 ⌘S 与页面 keydown 共用同一口径）。
   *
   * 为什么要抽出来：菜单命令与 window keydown 是两条独立入口，各自写一遍必然漂移
   * （这正是 R05 的成因）。这里只写一次 —— 表标签存改动、查询标签存片段、
   * 其余明确提示，**任何情况下都不静默**。
   */
  const requestSaveActive = useCallback(() => {
    if (openTab) {
      const s = sources.get(openTab.id);
      if (s) onRequestSave(openTab.id, s);
      else setToast('当前表没有待保存的改动');
      return;
    }
    if (ws.active?.kind === 'query') {
      const qid = ws.active.id;
      setSnippetReq((prev) => ({ tabId: qid, n: (prev?.n ?? 0) + 1 }));
      return;
    }
    setToast('当前标签没有可保存的内容');
  }, [openTab, sources, onRequestSave, ws, setToast]);

  /** 预演确认 → 真写库 */
  const onConfirmSave = useCallback(async () => {
    if (!preview) return;
    const { tabId, source, statements } = preview;
    const tab = ws.getTable(tabId);
    if (!tab) return;
    setPreview(null);
    try {
      const r = await backend.mutationApply({
        connId: tab.connId,
        database: tab.database,
        statements,
      });

      // T08/T09/R15：冲突/定位异常 → 整批已回滚。**绝不清草稿**，改为弹冲突处理弹窗。
      // 旧实现在这里无条件 clearAll()，用户被告知「影响 N 行」而其中一条根本没落库。
      if (r.outcome !== 'ok') {
        dirtyGuardRollbackRef.current = null;
        setSaveConflict({
          tabId,
          connId: tab.connId,
          database: tab.database,
          source,
          totalStatements: statements.length,
          pendingCount: source.dirtyCells().length,
          conflicts: r.conflicts.map((c) => {
            const st = statements[c.index];
            return {
              index: c.index,
              kind: c.kind,
              actual: c.actual,
              outcome: c.outcome,
              reason: c.reason,
              sql: c.sql,
              row: st?.rowId != null ? Number(st.rowId) : null,
              pending: st?.pending ?? [],
              probe:
                st?.locateColumns && st.locateColumns.length > 0
                  ? buildRowProbeSql(tab.database, tab.tableName, st.locateColumns, st.locateValues ?? [])
                  : null,
            };
          }),
        });
        setToast(`提交未完成：${r.conflicts.length} 处冲突，整批已回滚（你的改动仍在）`);
        return;
      }

      source.clearAll();
      // T38：保存成功后清撤销栈 —— 这些值已经进库，撤销它没有语义
      editHistoryRef.current.get(tabId)?.clear();
      ws.patchTable(tabId, { dirtyCount: 0 });
      // T01：改动已落库 → 守卫登记的回滚作废（乐观写入的排序/筛选现在是真的）
      dirtyGuardRollbackRef.current = null;
      rerender();
      setToast(`已提交：影响 ${r.affected} 行，${r.elapsedMs}ms`);
      // 写完后重新拉，拿到服务端最新值（自增列 / 触发器改动等）
      await loadTable(
        tabId,
        { connId: tab.connId, database: tab.database, tableName: tab.tableName, table: tab.table },
        { keepSort: true, sorts: tab.sorts, filter: tab.filter },
      );
    } catch (e) {
      setToast(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, ws, loadTable]);

  /**
   * T09：冲突行重载探测 —— 按原定位键回查库中现值（只读）。
   * 用列式读取器取值，不解全量行。
   */
  const probeConflictRow = useCallback(
    async (c: ConflictView): Promise<ProbeOutcome | null> => {
      const ctx = saveConflict;
      if (!ctx || !c.probe) return null;
      const out = await backend.queryRun({
        connId: ctx.connId,
        sql: c.probe.sql,
        database: ctx.database,
      });
      const reader = new ColumnarReader(out.payload);
      const row: Record<string, CellValue> = {};
      if (reader.rowCount > 0) {
        for (let ci = 0; ci < reader.columnCount; ci++) {
          row[reader.columnName(ci)] = reader.decodeCell(0, ci);
        }
      }
      return { hits: out.rowCount, row: reader.rowCount > 0 ? row : null };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, saveConflict],
  );

  // ---- A4：复制行 ⌘D —— buildDuplicateRowPlan 构造追加脏行（落库仍走保存预演红线） ----
  const onDuplicateRow = useCallback(
    (tabId: string, source: GridDataSource, row: number) => {
      const tab = ws.getTable(tabId);
      if (!tab) return;
      if (!isEditable(tab.table)) {
        setToast('该表无主键/唯一键，网格只读，不支持复制行');
        return;
      }
      const plan = buildDuplicateRowPlan(
        tab.table,
        // 原始行值（不含脏覆盖）——复制的是库里的现状
        tab.table.columns.map((_, c) => source.raw(row, c)),
      );
      if (plan.rejected) {
        setToast(plan.rejected);
        return;
      }
      /**
       * 🔴 追加位置必须用 `totalRows`（已加载 + 已追加），**不能用 `rowCount`**。
       *
       * `rowCount` 只有**已加载**的行数，不含追加行：连续两次追加会算出同一个行号，
       * 第二次把第一次的脏单元格整个覆盖掉 —— 用户看到「按了两次 ⌘D 只多一行」。
       * 粘贴路径此前用 `plan.appendedRows` 绕过了这个坑，复制行/新增行没有。
       */
      const newRow = source.totalRows;
      for (const e of plan.edits) {
        // needs-input 列（非自增主键）带 reason → 格子标红提示；值保持原始类型
        source.setDirty(newRow, e.col, e.value as string | null, e.reason);
      }
      source.setExtraRows(source.extraRows + 1);
      // T38：行级动作同样进撤销栈（撤销会连行数一起退回）
      historyFor(tabId).push({
        label: '复制行',
        changes: [],
        rowDelta: { before: source.extraRows - 1, after: source.extraRows },
      });
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(plan.summary);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws],
  );

  // ---- T19：新增空白行 —— buildBlankRowPlan 构造一列值都没有的追加行 ----
  /**
   * 与「复制行」的关键差别：空白行**没有任何源值可抄**，每一列都得按
   * 「自增 / 有默认值 / 可空 / 必须填」决定怎么处理，并把 DEFAULT 与 NULL 分开
   * （DEFAULT 的列**不写进 INSERT**，NULL 的列写显式 NULL）—— 判定全在 core-mutation，
   * 这里只负责把结论落到脏单元格上。
   */
  const onAddBlankRow = useCallback(
    (tabId: string, source: GridDataSource) => {
      const tab = ws.getTable(tabId);
      if (!tab) return;
      if (!isEditable(tab.table)) {
        setToast('该表无主键/唯一键，网格只读，不支持新增行');
        return;
      }
      const plan = buildBlankRowPlan(tab.table);
      if (plan.rejected) {
        setToast(plan.rejected);
        return;
      }
      const newRow = source.totalRows; // 追加到**当前总行数**末尾
      source.setExtraRows(source.extraRows + 1);
      // 「这一行要被插入」独立记账 —— 全部列都交给服务端/默认值时脏集合是空的
      source.markBlankRow(newRow);
      // T38：撤销新增行 = 行数退出 + 空白行标记撤掉 + 该行脏格清干净
      const blankChanges: CellChange[] = [];
      for (const e of plan.edits) {
        // auto-skip / use-default 故意**不写**：不写进 INSERT 才能让服务端生成 / 让 DEFAULT 生效
        if (e.kind === 'auto-skip' || e.kind === 'use-default') continue;
        // set-null 写显式 NULL；needs-input 留空并带原因（格子标红）
        source.setDirty(newRow, e.col, null, e.reason);
        blankChanges.push({
          row: newRow,
          col: e.col,
          before: null,
          after: { row: newRow, col: e.col, value: null, valueKind: 'literal' },
        });
      }
      historyFor(tabId).push({
        label: '新增空白行',
        changes: blankChanges,
        rowDelta: { before: source.extraRows - 1, after: source.extraRows },
        blankMarks: [{ row: newRow, before: false, after: true }],
      });
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(plan.summary);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws],
  );

  // ---- D2/V1：从剪贴板粘贴多行 ----
  /**
   * V1：⌘V 与工具栏「粘贴」共用这一条实现。
   *
   * - 不传 tabId/anchor（工具栏按钮）→ 回退到当前激活 tab、钉在第 0 行第 0 列；
   * - ⌘V 路径传网格焦点格 anchor → 从那一格按列对齐（Excel/DataGrip 习惯）。
   *
   * 🔴 只读防线（表无唯一键 / 连接只读）**必须在渲染层先给明确提示**，
   * 否则用户按 ⌘V 毫无反应 —— 这正是 V1 断层要修的缺陷（静默失败）。
   * 真正的安全层仍是主进程 core-sql-guard 的 AST 白名单（红线 4）。
   */
  const onPasteRows = useCallback(
    async (
      targetTabId?: string,
      anchor?: { row: number; col: number },
      targetSource?: GridDataSource,
    ) => {
      const tabId = targetTabId ?? openTab?.id;
      if (!tabId) return;
      const tab = ws.getTable(tabId);
      if (!tab) return;
      const s = targetSource ?? sources.get(tabId);
      const table = tab.table;
      if (!s) return;
      if (!isEditable(table)) {
        setToast('该表无主键/唯一键，网格只读，不支持粘贴');
        return;
      }
      if (readOnlyConns[tab.connId]) {
        setToast('该连接为只读模式，不允许粘贴写入（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        setToast('读不到剪贴板（Electron 下需经 preload 授权）');
        return;
      }
      // 脏单元格按原始列索引寻址，anchor.col 已是原始索引（DataGrid 契约）
      const anchorCol = anchor ? Math.min(Math.max(anchor.col, 0), table.columns.length - 1) : 0;
      const plan = planPasteFromText(text, {
        startRow: anchor?.row ?? 0,
        startCol: anchorCol,
        loadedRows: s.rowCount,
        columns: table.columns,
        editable: true,
      });
      if (plan.rejected) {
        setToast(plan.rejected);
        return;
      }
      for (const c of plan.cells) s.setDirty(c.row, c.col, c.value);
      if (plan.appendedRows > 0) s.setExtraRows(Math.max(s.extraRows, plan.appendedRows));
      ws.patchTable(tabId, { dirtyCount: s.dirtyCount });
      rerender();
      // 落点粘贴时顺带提示被丢弃的列，避免用户以为粘全了
      setToast(plan.dropNotice ? `${plan.summary}；${plan.dropNotice}` : plan.summary);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [openTab, sources, ws, readOnlyConns],
  );

  /**
   * V2：⌘⌫ 删除选中行。与保存共用 core-mutation + SavePreviewModal 这条
   * **唯一写路径**（头号红线）—— 这里只产出 DELETE 语句进预演，绝不直接执行。
   *
   * 与保存不同点：删除的 targets 是**行**（不是脏单元格），所以单独走 deletes，
   * 不与当前脏改动混在同一次预演里（用户按 ⌘⌫ 的意图就是删这几行）。
   */
  const onDeleteRows = useCallback(
    (tabId: string, source: GridDataSource, rows: number[]) => {
      const tab = ws.getTable(tabId);
      if (!tab) return;
      const table = tab.table;
      if (!isEditable(table)) {
        setToast('该表无主键/唯一键，无法安全定位行，网格只读，不支持删除');
        return;
      }
      if (readOnlyConns[tab.connId]) {
        setToast('该连接为只读模式，不允许删除（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      // 只删已加载行：追加脏行（row >= rowCount）尚未落库，没有定位键，直接跳过
      const targets = rows.filter((r) => r >= 0 && r < source.rowCount);
      if (targets.length === 0) {
        setToast('没有可删除的已加载行（追加行尚未保存）');
        return;
      }
      const columns = table.columns.map((c) => c.name);
      const locateCols = locateColumns(table);
      const strategy = locateStrategy(table);
      const deletes = targets.map((row) => ({
        rowId: String(row),
        locate: strategy,
        locateValues: locateCols.map((c) => source.raw(row, columns.indexOf(c.name))),
      }));
      const plan = buildMutationPlan(tab.database, table, { deletes });
      setPreview({
        tabId,
        source,
        // 删除后清脏标记：被删的行连同其未保存的编辑一起消失（用户意图明确）
        statements: plan.statements.map((st) => ({
          sql: st.sql,
          params: st.params,
          description: st.description,
          // T08/R15：删除也必须恰好命中 1 行（否则是定位缺陷或行已被删）
          kind: st.kind,
          expect: 'one' as const,
          // T21：删除的摘要（对象 + 行定位）同样透传给预览
          summary: st.summary,
        })),
        rejected: plan.rejected.map((r) => ({ row: Number(r.rowId ?? 0), column: r.column, reason: r.reason })),
      });
      if (plan.statements.length === 0) {
        setToast(plan.rejected[0]?.reason ?? '没有可删除的行');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ws, readOnlyConns],
  );

  // ---- V13：批量编辑条（Apply / Discard） ----
  /**
   * Apply：把「一列 × 多行」一次性标脏。
   *
   * 🔴 **不引入新写路径** —— 这里只调 source.setDirty，落库仍走既有
   * onRequestSave → buildMutationPlan → SavePreviewModal 逐条预演（头号红线）。
   *
   * 前置拦截与 ⌘V 粘贴同一套（不允许静默失效）：
   *  - 表无主键/唯一键 → 明确提示（isEditable，网格自己也会禁用批量条）；
   *  - 连接只读 → 明确提示（UI 置灰不算防线，但也不能让用户点了没反应）；
   *  - 表达式值再过一次 validateSqlExpression（与单元格编辑同源，双保险）。
   */
  const onBatchEdit = useCallback(
    (tabId: string, source: GridDataSource, cells: { row: number; col: number; value: string | null; valueKind: 'literal' | 'sql-expr' }[]) => {
      const tab = ws.getTable(tabId);
      if (!tab || cells.length === 0) return;
      if (!isEditable(tab.table)) {
        setToast('该表无主键/唯一键，网格只读，不支持批量编辑');
        return;
      }
      if (readOnlyConns[tab.connId]) {
        setToast('该连接为只读模式，不允许批量编辑（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      // 表达式模式：逐格校验（同一批值相同，实际只校验一次即可，但循环更直白）
      for (const c of cells) {
        if (c.valueKind !== 'sql-expr') continue;
        const reason = validateSqlExpression(c.value ?? '').reason;
        if (reason) {
          setToast(`SQL 表达式不合法：${reason}`);
          return;
        }
      }
      // T38：一次批量动作 = 一条历史（撤销一次退回全部，而不是退 100 次）
      const batchChanges: CellChange[] = [];
      for (const c of cells) {
        // 追加行（row >= rowCount）不参与批量编辑：它们还没落库，
        // 批量语义是「改已有多行的同一列」，混进来会产生无定位键的 UPDATE
        if (c.row < 0 || c.row >= source.rowCount) continue;
        // T38：before 必须在 setDirty 之前取，否则撤销会退回「刚写的新值」
        const before = source.snapshotCell(c.row, c.col);
        source.setDirty(c.row, c.col, c.value, undefined, c.valueKind);
        batchChanges.push({
          row: c.row,
          col: c.col,
          before: before ? { row: c.row, col: c.col, ...before } : null,
          after: { row: c.row, col: c.col, value: c.value, valueKind: c.valueKind },
        });
      }
      historyFor(tabId).push({
        label: `批量编辑「${tab.table.columns[cells[0].col]?.name ?? '列'}」${batchChanges.length} 行`,
        changes: batchChanges,
      });
      const colName = tab.table.columns[cells[0].col]?.name ?? '';
      const exprTag = cells[0].valueKind === 'sql-expr' ? '（SQL 表达式）' : '';
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(`已标记 ${cells.length} 行的「${colName}」${exprTag}，按 ⌘S 预演后提交`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, readOnlyConns],
  );

  /** Discard：清掉这批格子的脏标记（回到原始值） */
  const onBatchDiscard = useCallback(
    (tabId: string, source: GridDataSource, cells: { row: number; col: number }[]) => {
      for (const c of cells) source.clearCell(c.row, c.col);
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(`已放弃 ${cells.length} 格的批量改动`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws],
  );

  // ---- V9：外键值导航与候选值 ----
  /**
   * 外键元数据缓存：`connId:db:table` → GridForeignKey[]。
   *
   * 🔴 为什么缓存在 App 而不是各 TablePane：pane 常挂 DOM，
   *    各自 useEffect 拉取会在恢复会话时并发打十几次 information_schema。
   *    缓存按「表」而不是按「tab」，同一张表开两个 tab 只查一次。
   */
  const [fkCache, setFkCache] = useState<Record<string, GridForeignKey[]>>({});

  /** 激活的表 tab 变化时按需拉外键（只拉一次；失败降级为空 = 不画链接） */
  useEffect(() => {
    const tab = openTab;
    if (!tab) return;
    const key = `${tab.connId}:${tab.database}:${tab.tableName}`;
    if (key in fkCache) return;
    let alive = true;
    void (async () => {
      try {
        const fks = await backend.schemaGetForeignKeys({
          connId: tab.connId,
          database: tab.database,
          table: tab.tableName,
        });
        if (!alive) return;
        const mapped: GridForeignKey[] = fks
          // 网格是「单格 → 单行」的导航，只取单列外键；
          // 复合外键要同时匹配多列，跳过去会定位到错误的行（宁可不给入口）
          .filter((fk) => fk.columns.length === 1 && fk.referencedColumns.length === 1)
          .map((fk) => ({
            column: fk.columns[0],
            referencedDatabase: fk.referencedDatabase,
            referencedTable: fk.referencedTable,
            referencedColumn: fk.referencedColumns[0],
            displayColumn: null,
          }));
        setFkCache((prev) => ({ ...prev, [key]: mapped }));
      } catch {
        // 拿不到外键不该打扰用户：缓存成空数组，链接不画（下次也不再重试）
        if (alive) setFkCache((prev) => ({ ...prev, [key]: [] }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab?.id, openTab?.tableName, openTab?.database, openTab?.connId]);

  /**
   * 点击外键值 → 跳到引用表的那一行。
   *
   * 🔴 定位方式：走既有的「打开表 + 按列值筛选」链路（loadTable 的 where
   *    仍由 core-filter 构造、值走 ? 占位参数）—— 不在这里手拼 SQL。
   *    引用表是否可定位由它自己的 isEditable/locateStrategy 决定，
   *    本函数**不自行判断能否跳转**（契约 2）。
   *
   * 引用行不存在 → 明确提示（PRD 要求「而非静默失败」）。
   */
  const onFollowForeignKey = useCallback(
    (tabId: string, fk: GridForeignKey, _row: number, value: string | null) => {
      const tab = ws.getTable(tabId);
      if (!tab) return;
      if (value === null) {
        setToast('本格是 NULL，没有可跳转的引用行');
        return;
      }
      void (async () => {
        try {
          // 引用表可能跨库；确保会话可用（与开表入口同一套握手回环）
          const ensure = await ensureConnection(tab.connId);
          if (ensure !== 'ready') {
            if (ensure === 'need-password') setToast('该连接要求手动输入密码，输入后可再次点击外键值跳转');
            return;
          }
          const bundle = await backend.schemaGetTable(tab.connId, fk.referencedDatabase, fk.referencedTable);
          // 复用既有 tab 也要重拉：跳转的意义就是「带上引用列 = 本格值这个筛选」，
          // 沿用 tab 里的旧筛选会跳到错误的行集（所以不看 needsLoad，一律 loadTable）
          const { id } = ws.openTable(tab.connId, fk.referencedDatabase, bundle.table);
          // 按引用列 = 本格值筛选，直接定位到那一行（值走 ? 参数，防注入不破）
          const filter: FilterModel = {
            groups: [{ id: 'g1', logic: 'AND', conditions: [filterByCellValue(fk.referencedColumn, value)] }],
          };
          // 🔴 用 loadTable 的返回值判断命中，不读 sources/ws ——
          //    那两处要等 React 重渲染才更新，await 之后立刻读会拿到旧值
          //    （会把「刚打开的表」误判成 0 行 → 误报"引用行不存在"）。
          const hit = await loadTable(
            id,
            { connId: tab.connId, database: fk.referencedDatabase, tableName: fk.referencedTable, table: bundle.table },
            { keepSort: true, sorts: [], filter },
          );
          // 命中 0 行要给明确提示 —— 静默打开一张空表是最坏的体验
          setToast(
            hit === 0
              ? `引用行不存在：${fk.referencedTable}.${fk.referencedColumn} = ${value}（可能已被删除）`
              : `已跳转到 ${fk.referencedTable}.${fk.referencedColumn} = ${value}`,
          );
        } catch (e) {
          setToast(`跳转失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, ensureConnection, loadTable],
  );

  /**
   * V9：外键候选值下拉。
   * 🔴 LIMIT 在主进程/驱动层钳制（≤500），渲染层不传大数、绝不全表扫描。
   */
  const onLookupForeignKeyValues = useCallback(
    async (tabId: string, fk: GridForeignKey, keyword: string | null) => {
      const tab = ws.getTable(tabId);
      if (!tab) return null;
      try {
        return await backend.schemaGetReferencedValues({
          connId: tab.connId,
          database: fk.referencedDatabase,
          table: fk.referencedTable,
          valueColumn: fk.referencedColumn,
          displayColumn: fk.displayColumn,
          keyword,
          limit: 200,
        });
      } catch {
        // 下拉拿不到候选值时返回 null：组件会显示原因并保留手输能力
        return null;
      }
    },
    [ws],
  );

  // ---- T38：未保存改动的 undo/redo（每张表一个栈，宿主持有） ----
  /**
   * 为什么栈放宿主而不是网格：改动的入口有五处（单元格、批量条、复制行、
   * 空白行、清除本格），全部落在 `GridDataSource.dirty` 上。栈跟着 source 走，
   * 任何入口只要 push 一条就能被撤销 —— 入口各自维护必然漏。
   *
   * 边界：**保存成功后清栈**（那些值已经进库，撤销它没有语义）；
   *      重载 discard 时也清（草稿已丢，历史跟着无效）。
   */
  const editHistoryRef = useRef(new Map<string, EditHistory>());
  const historyFor = useCallback((tabId: string): EditHistory => {
    let h = editHistoryRef.current.get(tabId);
    if (!h) {
      h = new EditHistory();
      editHistoryRef.current.set(tabId, h);
    }
    return h;
  }, []);
  /** 回放一组状态到 source（撤销与重做共用，方向由调用方给） */
  const applyEntry = useCallback(
    (source: GridDataSource, entry: EditEntry, direction: 'undo' | 'redo') => {
      for (const c of clearsFor(entry, direction)) source.clearCell(c.row, c.col);
      for (const st of statesFor(entry, direction)) {
        source.setDirty(st.row, st.col, st.value, undefined, st.valueKind);
      }
      // 行级副作用（新增行 / 空白行标记）必须一起回放，否则「撤销新增行」留下空壳行
      applyMetaTo(entry, direction, source);
    },
    [],
  );
  const undoEdit = useCallback(
    (tabId: string) => {
      const source = sourcesRef.current.get(tabId)?.source;
      const h = editHistoryRef.current.get(tabId);
      if (!source || !h) return;
      const entry = h.undo();
      if (!entry) return;
      applyEntry(source, entry, 'undo');
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(`已撤销：${entry.label}`);
    },
    [applyEntry, rerender, setToast, ws],
  );
  const redoEdit = useCallback(
    (tabId: string) => {
      const source = sourcesRef.current.get(tabId)?.source;
      const h = editHistoryRef.current.get(tabId);
      if (!source || !h) return;
      const entry = h.redo();
      if (!entry) return;
      applyEntry(source, entry, 'redo');
      ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
      rerender();
      setToast(`已重做：${entry.label}`);
    },
    [applyEntry, rerender, setToast, ws],
  );

  const tablePaneHandlers = useMemo<TablePaneHandlers>(
    () => ({
      onSortChange,
      onCellEdited: (tabId, source, row, col, value, valueKind) => {
        // T38：先快照 before（撤销时「回到干净」与「留下 NULL 草稿」是两条不同 SQL）
        const before = source.snapshotCell(row, col);
        // V10：valueKind 必须原样传进脏单元格 —— 它是「保存时该不该转义」的唯一依据
        source.setDirty(row, col, value, undefined, valueKind);
        historyFor(tabId).push({
          label: '编辑单元格',
          changes: [
            {
              row,
              col,
              before: before ? { row, col, ...before } : null,
              after: { row, col, value, valueKind: valueKind ?? 'literal' },
            },
          ],
        });
        ws.patchTable(tabId, { dirtyCount: source.dirtyCount });
        rerender();
      },
      onSave: onRequestSave,
      onCellActivated: (_tabId, row, col) => {
        const s = openTab ? sources.get(openTab.id) : null;
        if (!s || !openTab) return;
        setCell({
          row,
          col,
          column: openTab.table.columns[col]?.name ?? '',
          value: s.raw(row, col),
        });
      },
      /**
       * 缺陷 5：查看完整值 → 弹窗。
       *
       * 🔴 按 tabId 取该 pane 自己的 source 与 table，**不能用 openTab**：
       *    onCellActivated 用 openTab 是既有实现的历史包袱（激活 pane 才有意义），
       *    但右键菜单可能落在非激活 pane 上（多标签常挂 DOM）。用错 tab 的表现是
       *    「弹窗里显示的是另一张表的值」—— 比不弹更糟。
       *
       * T31：value 仍传 source.raw 的库中原值；脏格的待提交值另走 pending。
       *    两者必须分开传 —— dirty 格的合法值是 string|null（null = 写 SQL NULL），
       *    合在 value 里就没法区分「待写 NULL」与「没有修改」。
       *    🔴 必须读弹窗打开那一刻的现场（source.isDirty / source.value），
       *    不能读 state 快照：弹窗存的是快照，网格脏格此后可能被清除/再改。
       *    这里把 dirty 读法封在 pending 里，CellValueModal 只消费不判定。
       */
      onInspectCell: (tabId, row, col, value) => {
        const t = ws.getTable(tabId);
        if (!t) return;
        const s = sources.get(tabId) ?? null;
        // T31：只读表 / 结果网格没有脏格概念 → pending 传 undefined（弹窗如实说「未提供」）
        const dirty = s ? s.isDirty(row, col) : false;
        setCellModal({
          tabId,
          row,
          col,
          column: t.table.columns[col]?.name ?? '',
          value,
          table: t.table,
          database: t.database,
          // T31：脏格才有待提交值；provided: false 走「宿主未提供」分支（诚实降级）
          pending: s && dirty ? { value: s.value(row, col) as string | null, provided: true } : undefined,
          // T32：可写表才给编辑入口（只读连接 / 无定位键的表都不给 —— 不做假 UI）
          editable: isEditable(t.table) && !readOnlyConns[t.connId],
        });
      },
      // F5：选中统计 → 状态栏（仅激活 pane 回报，见 TablePane 侧实现）
      onSelectionSummary: (_tabId, summary) => setSelectionSummary(summary),
      // A2：网格就地清了脏标记，这里只刷角标
      onCellCleared: (tabId, s) => {
        ws.patchTable(tabId, { dirtyCount: s.dirtyCount });
        rerender();
      },
      // A4：⌘D 复制行 → 追加脏行（落库走保存预演）
      onDuplicateRow,
      // T19：新增空白行（工具栏 / 数据菜单 / 行号右键共用）
      onAddBlankRow,
      // A22：右键快速筛选
      onQuickFilter,
      /**
       * T24/T26：条件条 / 列头快筛对**已生效模型**的修改入口。
       *
       * 与弹窗的草稿（filterDraft）不同：这里拿到的是「追加/删除后的完整模型」，
       * 直接进 loadTable 生效 —— 条件条承诺「不持有状态」，宿主这里就是唯一真值。
       * note 是给用户的一句话说明（删了哪条 / 忽略了什么），由 toast 说出 ——
       * 「绝不静默少给」不能只写在返回值里。
       */
      onFilterChange: (tabId, next, note) => {
        const t = ws.getTable(tabId);
        if (!t) return;
        if (note) setToast(note);
        void loadTable(
          tabId,
          { connId: t.connId, database: t.database, tableName: t.tableName, table: t.table },
          { keepSort: true, sorts: t.sorts, filter: next },
        );
      },
      // V1：⌘V 粘贴（从网格焦点格落点对齐）
      onPaste: (tabId, s, anchor) => void onPasteRows(tabId, anchor, s),
      // V2：⌘⌫ 删除选中行（走 buildMutationPlan 的 deletes + 保存预演）
      onDeleteRows,
      // V13：批量编辑条 Apply/Discard
      onBatchEdit,
      onBatchDiscard,
      // V9：外键跳转与候选值
      onFollowForeignKey,
      onLookupForeignKeyValues,
      // P1-9 / P2-18a/b：网格的一句话反馈（只读拒绝、跳转超界、复制失败…）
      onNotice: (_tabId, msg) => setToast(msg),
      // P0-1：导出快照注册（网格挂载时交来「读当前快照」的函数）
      onExportSnapshot: registerExportSnapshot,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSortChange, onRequestSave, openTab, sources, ws, onDuplicateRow, onAddBlankRow, onQuickFilter, onPasteRows, onDeleteRows, onBatchEdit, onBatchDiscard, onFollowForeignKey, onLookupForeignKeyValues, readOnlyConns, registerExportSnapshot],
  );

  /**
   * T32：完整值弹窗编辑器「存为待提交值」—— 与 onCellEdited 相同的 setDirty 链路
   * （valueKind='literal'；text=null 表示写 SQL NULL）。改动只标当前格，落库仍走保存预演。
   * 🔴 刻意放在 tablePaneHandlers 之外：那个对象的类型是 TablePaneHandlers
   *    （workspace/TablePane.tsx，本任务不可改），而弹窗提交是 App↔CellValueModal
   *    的直连通道，不需要网格中转。
   */
  const onCellModalCommitDraft = useCallback(
    (tabId: string, row: number, col: number, text: string | null) => {
      const s = sources.get(tabId);
      if (!s) return;
      s.setDirty(row, col, text, undefined, 'literal');
      ws.patchTable(tabId, { dirtyCount: s.dirtyCount });
      rerender();
    },
    [sources, ws, rerender],
  );

  // ---- 连接编辑器（§6.1）----
  const closeEditor = useCallback(() => setEditorState('closed'), []);

  const editorTarget = useMemo(
    () => (typeof editorState === 'object' ? editorState.config : null),
    [editorState],
  );

  /** P1-8：非空 = 创建副本模式（保存为一条新连接，密文沿用源连接） */
  const editorDuplicateOf = useMemo(
    () => (typeof editorState === 'object' ? editorState.duplicateOf : null),
    [editorState],
  );

  /** 保存后重新拉列表 —— 否则用户看不到刚建的连接 */
  const reloadConnections = useCallback(async () => {
    const r = await backend.connList();
    setConnections(r.connections);
    setConnStates(r.states);
    setSchemas(r.schemas);
  }, []);

  const onSaveConnection: ConnectionEditorProps['onSave'] = useCallback(
    async (input) => {
      const saved = await backend.connSave(input);
      const r = await backend.connList();
      setConnections(r.connections);
      setConnStates(r.states);
      setSchemas(r.schemas);

      /**
       * D1 补全：保存后自动展开新连接所在的组。
       *
       * 🔴 不能只靠展开记忆：组的 key 含成员 id 集合（`group:ungrouped:id1,id2`），
       *    新建连接会让 key 变化 —— 记忆里的旧 key 失效，新组是折叠的，
       *    用户"保存完看不到刚建的连接"（真机抓到的缺陷）。
       *    这里用保存后的列表重算树，找到包含该连接的组节点并展开。
       */
      const roots = buildTree({ connections: r.connections, schemas: r.schemas });
      const groupKey = findGroupKeyOfConnection(roots, saved.id);
      if (groupKey) setExpanded((prev) => new Set(prev).add(groupKey));

      setToast(input.config.id ? '连接已保存' : '连接已创建');
      // 返回保存后的配置（含主进程生成的 id）：连接编辑器「保存并连接」要用它发起握手
      return saved;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onTestConnection: ConnectionEditorProps['onTest'] = useCallback(
    async (input) => backend.connTest(input),
    [],
  );

  const onPickPrivateKey = useCallback(async () => {
    try {
      return await backend.pickPrivateKey();
    } catch (e) {
      setToast(`选择私钥失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, []);

  /** 断开：本地立即置为 closed（主进程推送通道未订阅，不能等它） */
  const onDisconnectNode = useCallback(async (cfg: ConnectionConfig) => {
    try {
      await backend.connDisconnect(cfg.id);
    } catch (e) {
      setToast(`断开失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setConnStates((s) => ({ ...s, [cfg.id]: { state: 'closed', lastError: null } }));
    setToast(`已断开 ${cfg.name}`);
  }, []);

  /**
   * 树上的连接意图入口。语义反转是 2026-09-26 真机抓到的头号缺陷：
   * 之前 live=true（已连接）反而去 connect、未连接反而去 disconnect，
   * 结果"双击连接永远连不上"，新用户第一次用就卡死在第一步。
   */
  const onToggleConnectionNode = useCallback(
    (cfg: ConnectionConfig, live: boolean) => {
      if (live) void onDisconnectNode(cfg);
      else if (cfg.promptEveryTime) setPwdPrompt(cfg);
      else void onConnectNode(cfg);
    },
    [onConnectNode, onDisconnectNode],
  );

  /** 删除连接：不可逆动作，先确认（生产红标连接依旧要求先摘标签） */
  const onDeleteConnection = useCallback(
    async (cfg: ConnectionConfig) => {
      if (cfg.colorTag === 'red') {
        setToast('生产连接删除需再次确认：请先把颜色标签改为非红色');
        return;
      }
      if (!window.confirm(`确定删除连接「${cfg.name}」吗？\n该操作不可恢复（不影响数据库本身）。`)) return;
      await backend.connDelete(cfg.id);
      await reloadConnections();
      setToast(`已删除连接 ${cfg.name}`);
    },
    [reloadConnections],
  );

  /**
   * 刷新表结构：对所有活连接 schemaRefresh（设计器外改库后让树跟上）。
   */
  const onRefreshSchemas = useCallback(async () => {
    const liveIds = connections
      .filter((c) => {
        const st = connStates[c.id]?.state;
        return st === 'connected' || st === 'busy';
      })
      .map((c) => c.id);
    if (liveIds.length === 0) {
      setToast('没有已连接的连接，先双击或单击连接节点');
      return;
    }
    try {
      const results = await Promise.all(liveIds.map((id) => backend.schemaRefresh(id)));
      setSchemas((prev) => {
        const next = { ...prev };
        liveIds.forEach((id, i) => {
          next[id] = results[i];
        });
        return next;
      });
      setToast(`已刷新 ${liveIds.length} 个连接的表结构`);
    } catch (e) {
      setToast(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [connections, connStates]);

  /** 单连接 schema 刷新（树右键「刷新」） */
  const onRefreshConnSchema = useCallback(async (connId: string) => {
    try {
      const dbs = await backend.schemaRefresh(connId);
      setSchemas((prev) => ({ ...prev, [connId]: dbs }));
      setToast('已刷新表结构');
    } catch (e) {
      setToast(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /**
   * 0.7.3（P0-19）：DDL 完成后「展开并定位」到目标节点。
   *
   * 🔴 为什么不能就地 setExpanded：`onRefreshConnSchema` 只是把新结构写进 schemas，
   *    `treeRoots` 要到下一次渲染才包含新库。此刻拿旧树去 `expandAncestors` 找不到节点，
   *    等于什么都没展开（用户看到「创建成功」但树上没反应）。
   *    所以这里只登记意图，由下面的 effect 在树跟上之后执行一次。
   */
  const pendingRevealRef = useRef<string | null>(null);
  useEffect(() => {
    const key = pendingRevealRef.current;
    if (!key) return;
    if (!findTreeNode(treeRoots, key)) return; // 树还没跟上（schema 推送未到）→ 等下一次
    pendingRevealRef.current = null;
    setActiveKey(key);
    setObScopeKey(key);
    setExpanded((prev) => expandAncestors(prev, treeRoots, key));
  }, [treeRoots]);

  // ---- 0.7.3 P0-19：新建数据库 ----
  /**
   * 对话框上下文。`existing` 取自**已加载的 schema**：它是重名判定的唯一依据
   * （服务端仍会再判一次，这里只是让用户在点确认前就知道重名）。
   */
  const [dbCreate, setDbCreate] = useState<{
    connId: string;
    connName: string;
    existing: string[];
    defaultCharset: string;
    defaultCollation: string;
  } | null>(null);
  const [dbCreateBusy, setDbCreateBusy] = useState(false);
  const [dbCreateError, setDbCreateError] = useState<string | null>(null);

  /**
   * 打开「新建数据库」对话框。
   *
   * 三道前置：只读连接直接拒（写了也是被主进程拦）、连接先握手（DDL 要有活会话）、
   * promptEveryTime 连接先要密码（输完经 pendingAfterConnectRef 回到这里）。
   */
  const openCreateDb = useCallback(
    async (connId: string) => {
      const cfg = connections.find((c) => c.id === connId);
      if (!cfg) {
        setToast('该连接已不存在（可能刚被删除）');
        return;
      }
      if (cfg.readOnly) {
        setToast('该连接已标记为只读，不允许建库（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      const ensure = await ensureConnection(connId);
      if (ensure === 'need-password') {
        setPwdPrompt(cfg);
        pendingAfterConnectRef.current = () => void openCreateDb(connId);
        setToast('该连接要求手动输入密码，输入后自动继续');
        return;
      }
      if (ensure === 'failed') {
        setToast('连接未建立，无法建库（左树单击连接节点重试）');
        return;
      }
      // 字符集/排序规则默认跟随**该实例已有库的第一个** —— 新库与既有库保持一致，
      // 比写死 utf8mb4 更贴近真实环境（有的实例整体是 latin1）
      const dbs = schemas[connId] ?? [];
      const first = dbs.find((d) => d.charset);
      const charset = first?.charset ?? 'utf8mb4';
      setDbCreateError(null);
      setDbCreate({
        connId,
        connName: cfg.name,
        existing: dbs.map((d) => d.name),
        defaultCharset: charset,
        defaultCollation: first?.collation ?? defaultCollationOf(charset),
      });
    },
    [connections, ensureConnection, schemas],
  );

  /** 执行 CREATE DATABASE（对话框点「创建」） */
  const submitCreateDb = useCallback(
    async (v: { name: string; charset: string; collation: string }) => {
      if (!dbCreate) return;
      const { connId } = dbCreate;
      let sql: string;
      try {
        sql = buildCreateDatabaseSql(v);
      } catch (e) {
        setDbCreateError(e instanceof Error ? e.message : String(e));
        return;
      }
      setDbCreateBusy(true);
      setDbCreateError(null);
      try {
        /**
         * 🔴 `database: ''`：CREATE DATABASE 没有库上下文，传空串让主进程跳过 `USE`。
         *    传一个不相干的库名虽然也能执行，但会把会话的默认库改掉（副作用）。
         */
        await backend.mutationApply({
          connId,
          database: '',
          statements: [{ sql, params: [] }],
          mode: 'ddl',
        });
        setDbCreate(null);
        /**
         * 🔴 两件事的顺序都不能动：
         *  1. 登记定位意图必须**在刷新之前** —— `onRefreshConnSchema` 内部 setSchemas
         *     会触发一次重渲染，那个 effect（依赖 treeRoots）就在那一刻跑；先 await
         *     再登记的话 effect 已经带着空 key 跑完了，之后不再跑 → 树永远不展开。
         *  2. 成功回执必须**在刷新之后** —— `onRefreshConnSchema` 自己会 toast
         *     「已刷新表结构」，先报结果会被它盖掉（用户只看到"刷新了"，不知道库建成了）。
         */
        pendingRevealRef.current = `db:${connId}:${v.name}`;
        await onRefreshConnSchema(connId);
        setToast(`已创建数据库 ${v.name}`);
      } catch (e) {
        // 失败不关弹窗：用户填的字符集/名字要留着，服务端原文贴在框里
        setDbCreateError(e instanceof Error ? e.message : String(e));
      } finally {
        setDbCreateBusy(false);
      }
    },
    [dbCreate, onRefreshConnSchema],
  );

  /**
   * 0.7.3（P0-20）：删除数据库。
   *
   * 🔴 **必须走危险第三层**（输库名），而且**无条件**——不像删表只在生产环境才输名。
   *    删库是不可逆的范围最大操作，Navicat 也是无条件输名；生产红标则由 confirmDanger
   *    自动升级标题与红标。
   * 🔴 `database: ''` 同样是为了不 `USE` 这个即将被删的库。
   */
  const onDropDatabase = useCallback(
    async (connId: string, database: string) => {
      if (connections.some((c) => c.id === connId && c.readOnly === true)) {
        setToast('该连接已标记为只读，不允许删除数据库（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      let sql: string;
      try {
        sql = buildDropDatabaseSql(database);
      } catch (e) {
        setToast(`无法构造删除语句：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const isProduction = connections.find((c) => c.id === connId)?.colorTag === 'red';
      const tabsInDb = ws.tabs.filter((t) => t.connId === connId && t.database === database).length;
      const confirmed = await confirmDanger(connId, {
        title: isProduction ? '生产环境危险操作' : '删除数据库',
        statements: [sql],
        reason:
          `将删除数据库 ${database} 及其下全部表、视图、例程与数据，无法自动恢复。` +
          (tabsInDb > 0 ? `将同时关闭该库上的 ${tabsInDb} 个标签。` : ''),
        // 无条件输库名（比删表更严格：删表只在生产环境要求输名）
        requireText: database,
      });
      if (!confirmed) {
        setToast('已取消执行');
        return;
      }
      try {
        await backend.mutationApply({ connId, database: '', statements: [{ sql, params: [] }], mode: 'ddl' });
        /**
         * 🔴 回执必须放在刷新**之后**：`onRefreshConnSchema` 自己会 `setToast('已刷新
         * 表结构')`，先报「已删除数据库 X」会被它当场盖掉（真机 e2e 抓到，用户看到
         * 的是一条与操作无关的刷新提示）。
         */
        await onRefreshConnSchema(connId);
        setToast(`已删除数据库 ${database}`);
        // 该库上的标签全部关闭 —— 它们指向的对象已经不存在，留着只会每点必报错
        for (const t of ws.tabs) {
          if (t.connId === connId && t.database === database) ws.closeTab(t.id);
        }
        // 选中项指向已消失的库时清掉，避免详情面板/工具条拿着死 key
        setActiveKey((prev) => (prev?.startsWith(`db:${connId}:${database}`) || prev?.startsWith(`kind:${connId}:${database}:`) || prev?.startsWith(`obj:${connId}:${database}:`) ? null : prev));
        setObScopeKey((prev) => (prev === `db:${connId}:${database}` || prev?.startsWith(`kind:${connId}:${database}:`) ? null : prev));
      } catch (e) {
        setToast(`删除数据库失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [connections, confirmDanger, ws, onRefreshConnSchema],
  );

  // ---- 0.7.3 P1-22：重命名表（RENAME TABLE） ----
  const [renameTable, setRenameTable] = useState<{ connId: string; database: string; table: TableMeta } | null>(null);

  /**
   * 提交重命名。
   *
   * 三条纪律：
   *  1. 走**同一条** DDL 通道（`mode: 'ddl'`）—— RENAME 是 DDL，不属于网格写语句；
   *  2. 旧表标签**关掉**：它记着旧表名，留着每点必 `doesn't exist`。不做"自动改名复用"
   *     是因为标签上还有筛选/排序/草稿，静默把它们挂到另一张表上更容易出事；
   *  3. 完成后展开定位到**新表**（用户下一步多半就是打开它）。
   */
  const submitRenameTable = useCallback(
    async (rawNewName: string) => {
      if (!renameTable) return;
      const { connId, database, table } = renameTable;
      if (connections.some((c) => c.id === connId && c.readOnly === true)) {
        setToast('该连接已标记为只读，不允许重命名表（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      const newName = rawNewName.trim();
      if (newName === table.name) {
        setRenameTable(null);
        setToast('表名未变化');
        return;
      }
      let sql: string;
      try {
        sql = buildRenameTableSql(database, table.name, newName);
      } catch (e) {
        setToast(`无法构造重命名语句：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      try {
        await backend.mutationApply({ connId, database, statements: [{ sql, params: [] }], mode: 'ddl' });
        setRenameTable(null);
        // 登记在刷新之前（同 submitCreateDb 的说明）；回执在刷新之后再说，否则被"已刷新"盖掉
        pendingRevealRef.current = `obj:${connId}:${database}:${newName}`;
        await onRefreshConnSchema(connId);
        setToast(`已把 ${database}.${table.name} 重命名为 ${newName}`);
        for (const t of ws.tabs) {
          if (t.kind === 'table' && t.connId === connId && t.database === database && t.tableName === table.name) {
            ws.closeTab(t.id);
          }
        }
      } catch (e) {
        // 失败保留对话框：用户改的名字不该丢，服务端原文（如「已存在」）由 toast 报出
        setToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [renameTable, connections, ws, onRefreshConnSchema],
  );

  /**
   * 0.7.3（P2-27）：表维护（优化 / 分析 / 检查）。
   *
   * 审计口径：这三条是**安全操作**（不改行数据），所以不做危险确认 ——
   * 但必须把服务端回执如实报出来：ANALYZE 之后 `estimatedRows` 会变，
   * OPTIMIZE 在大表上可能跑几十秒。回一句「已优化」而不带结果等于让用户猜。
   */
  const onMaintainTable = useCallback(
    async (action: MaintenanceAction, connId: string, database: string, tableName: string) => {
      if (connections.some((c) => c.id === connId && c.readOnly === true)) {
        setToast('该连接已标记为只读，不执行维护命令（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      const label = MAINTENANCE_LABELS[action];
      let sql: string;
      try {
        sql = buildMaintenanceSql(database, tableName, action);
      } catch (e) {
        setToast(`无法构造${label}语句：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      setToast(`正在${label} ${database}.${tableName}…`);
      try {
        const r = await backend.mutationApply({
          connId,
          database,
          statements: [{ sql, params: [] }],
          mode: 'ddl',
        });
        /**
         * ANALYZE 会改统计信息（树的估算行数），刷新一次让数字跟上。
         * 🔴 必须 `await` 且放在回执**之前**：`onRefreshConnSchema` 自带
         *    `setToast('已刷新表结构')`，后发就把「优化表完成：…（回执 N 条 / X ms）」
         *    盖掉，用户看不到维护结果（真机 e2e 抓到）。
         */
        await onRefreshConnSchema(connId);
        setToast(`${label}完成：${database}.${tableName}（服务端回执 ${r.affected} 条结果，${r.elapsedMs} ms）`);
      } catch (e) {
        setToast(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [connections, onRefreshConnSchema],
  );

  // ---- 0.7.3 P2-28：复制表（结构 / 结构 + 数据） ----
  const [copyTable, setCopyTable] = useState<{ connId: string; database: string; table: TableMeta } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  /**
   * 执行复制。
   *
   * 🔴 两条语句**分开发**：`CREATE TABLE … LIKE` 属 DDL 白名单，`INSERT … SELECT`
   *    属写语句白名单 —— 混在一条里必被其中一套拒绝（既有缺陷的形态）。
   * 🔴 第一步成功、第二步失败时**不假装整体失败**：表已经建好了，用户需要知道
   *    「结构在、数据没进来」，否则他会以为什么都没发生再点一次（撞重名）。
   */
  const submitCopyTable = useCallback(
    async (v: { name: string; targetDatabase: string; withData: boolean }) => {
      if (!copyTable) return;
      const { connId, database, table } = copyTable;
      if (connections.some((c) => c.id === connId && c.readOnly === true)) {
        setToast('该连接已标记为只读，不允许复制表（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      let statements: string[];
      try {
        statements = buildCopyTableSql({
          database,
          table: table.name,
          newTable: v.name,
          targetDatabase: v.targetDatabase,
          withData: v.withData,
        });
      } catch (e) {
        setCopyError(e instanceof Error ? e.message : String(e));
        return;
      }
      const [createSql, insertSql] = statements;
      setCopyBusy(true);
      setCopyError(null);
      try {
        await backend.mutationApply({
          connId,
          database: v.targetDatabase,
          statements: [{ sql: createSql, params: [] }],
          mode: 'ddl',
        });
      } catch (e) {
        setCopyError(e instanceof Error ? e.message : String(e));
        setCopyBusy(false);
        return;
      }
      if (insertSql) {
        try {
          await backend.mutationApply({
            connId,
            database: v.targetDatabase,
            statements: [{ sql: insertSql, params: [] }],
            mode: 'grid-write',
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setCopyError(`表结构已复制成功，但数据没进来：${msg}`);
          setCopyBusy(false);
          pendingRevealRef.current = `obj:${connId}:${v.targetDatabase}:${v.name}`;
          void onRefreshConnSchema(connId);
          return;
        }
      }
      setCopyBusy(false);
      setCopyTable(null);
      // 登记在刷新之前、回执在刷新之后（同 submitCreateDb 的说明）
      pendingRevealRef.current = `obj:${connId}:${v.targetDatabase}:${v.name}`;
      await onRefreshConnSchema(connId);
      setToast(
        `已复制 ${database}.${table.name} → ${v.targetDatabase}.${v.name}${v.withData ? '（含数据）' : '（仅结构）'}`,
      );
    },
    [copyTable, connections, onRefreshConnSchema],
  );

  // ---- 0.7.3 P2-29：分组管理（空分组 + 重命名） ----
  const [groupPrompt, setGroupPrompt] = useState<{ mode: 'create' | 'rename'; path: string } | null>(null);

  /** 空分组清单的唯一写入口（内存与 localStorage 一起改，避免两处不一致） */
  const commitEmptyGroups = useCallback((next: string[]) => {
    setEmptyGroups(next);
    saveEmptyGroups(next);
  }, []);

  /** 新建（子）分组：只落一条路径，不碰任何连接 */
  const submitCreateGroup = useCallback(
    (name: string) => {
      if (!groupPrompt) return;
      const full = childGroupPath(groupPrompt.path, name);
      const normalized = normalizeGroupPath(full);
      if (!normalized) {
        setToast('分组名不合法');
        return;
      }
      commitEmptyGroups(addEmptyGroup(emptyGroups, normalized));
      setGroupPrompt(null);
      // 建完就展开父分组，让新节点立刻可见（否则用户以为没建成）
      setExpanded((prev) => new Set(prev).add(`group:${groupPrompt.path}`));
      setToast(`已新建分组 ${normalized}`);
    },
    [groupPrompt, emptyGroups, commitEmptyGroups],
  );

  /**
   * 重命名分组 = 批量改该组连接的 `group` 字段（分组是派生结构，没有独立存储）。
   * 空分组清单也跟着改，否则旧路径会作为一个空壳留在树里。
   */
  const submitRenameGroup = useCallback(
    async (name: string) => {
      if (!groupPrompt) return;
      const from = groupPrompt.path;
      const parent = from.split('/').slice(0, -1).join('/');
      const to = normalizeGroupPath(childGroupPath(parent, name));
      if (!to || to === from) {
        setGroupPrompt(null);
        return;
      }
      const patch = renameGroupPatch(connections, from, to);
      let ok = 0;
      const failures: string[] = [];
      for (const p of patch) {
        const cfg = connections.find((c) => c.id === p.id);
        if (!cfg) continue;
        try {
          await backend.connSave({ config: { ...cfg, group: p.group } });
          ok += 1;
        } catch (e) {
          failures.push(`${cfg.name}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      commitEmptyGroups(renameEmptyGroups(emptyGroups, from, to));
      setGroupPrompt(null);
      await reloadConnections();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(`group:${from}`);
        next.add(`group:${to}`);
        return next;
      });
      if (failures.length > 0) {
        setToast(`已重命名 ${ok} 个连接，${failures.length} 个失败（${failures.join('；')}）`);
      } else {
        setToast(`分组 ${from} 已重命名为 ${to}（${ok} 个连接）`);
      }
    },
    [groupPrompt, connections, emptyGroups, commitEmptyGroups, reloadConnections],
  );

  /**
   * 清空/删除表（树右键，Navicat 对应能力）。
   * 走与网格写操作完全相同的安全链路：confirmDanger（生产环境自动第三层输表名）
   * → mutationApply（主进程只读守卫再兜一次）。标识符转义走 core-sql-ident（红线 5）。
   */
  const onTableDestructive = useCallback(
    async (action: 'truncate' | 'drop', connId: string, database: string, table: TableMeta) => {
      // T14：只读连接不做 DDL。菜单项此时已禁用，这里是**其它路径**（工具栏/命令面板）的兜底。
      if (connections.some((c) => c.id === connId && c.readOnly === true)) {
        setToast('该连接已标记为只读，不允许执行 DDL（写语句会被主进程 AST 守卫拦截）');
        return;
      }
      const qualified = quoteQualified([database, table.name]);
      const sql = action === 'truncate' ? `TRUNCATE TABLE ${qualified}` : `DROP TABLE ${qualified}`;
      const isProduction = connections.find((c) => c.id === connId)?.colorTag === 'red';
      const confirmed = await confirmDanger(connId, {
        title: isProduction ? '生产环境危险操作' : action === 'drop' ? '删除表' : '清空表',
        statements: [sql],
        reason:
          action === 'drop'
            ? '删除表将连同表结构与全部数据一起移除，无法自动恢复'
            : '清空表将删除全部数据行（表结构保留），无法自动恢复',
        requireText: isProduction ? table.name : null,
      });
      if (!confirmed) {
        setToast('已取消执行');
        return;
      }
      try {
        // T08：DDL 入口 —— 走 DDL 白名单，不走网格写语句的表达式白名单
        // （否则 DROP TABLE 会被「只允许 insert/update/delete」误拒）
        await backend.mutationApply({ connId, database, statements: [{ sql, params: [] }], mode: 'ddl' });
        setToast(action === 'drop' ? `已删除表 ${database}.${table.name}` : `已清空表 ${database}.${table.name}`);
        void onRefreshConnSchema(connId);
        for (const t of ws.tabs) {
          if (t.kind === 'table' && t.connId === connId && t.database === database && t.tableName === table.name) {
            if (action === 'drop') ws.closeTab(t.id);
            else void loadTable(t.id, { connId, database, tableName: table.name, table: t.table });
          }
        }
      } catch (e) {
        setToast(`${action === 'drop' ? '删除表' : '清空表'}失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [connections, confirmDanger, ws, loadTable, onRefreshConnSchema],
  );

  /** 复制文本到剪贴板 + toast（树右键「复制库名/表名」） */
  const copyText = useCallback((text: string) => {
 void navigator.clipboard?.writeText(text).catch(() => undefined);
    setToast(`已复制 ${text}`);
  }, []);

  /**
   * 0.7.3（P1-21）：新建视图/过程/函数/触发器/事件 —— **模板方案**。
   *
   * 为什么不建专用设计器：这五类对象的语法各有方言差异（定义者、分隔符、
   * 触发器时机…），一个半吊子设计器只会生成跑不通的 DDL。给一段**单语句、
   * 改了就能执行**的模板，用户在自己的编辑器里改完按 ⌘R，比任何表单都准。
   *
   * 🔴 模板里不含 `BEGIN … END`：编辑器的 splitStatements 按 `;` 切分，块体会被
   *    切成几条废语句（"填了模板 → 执行 → 语法错误"是最伤人的假实现）。
   */
  const openObjectTemplate = useCallback(
    (kind: ObjectCreateKind, connId: string, database: string) => {
      try {
        ws.newQuery(connId, database, buildObjectTemplate(kind, database));
        setToast(`已在查询标签里放好${OBJECT_KIND_TEXT[kind]}模板 —— 改掉名字后执行（⌘R），左侧结构会自动刷新`);
      } catch (e) {
        setToast(`无法生成${OBJECT_KIND_TEXT[kind]}模板：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [ws],
  );

  /**
   * 0.7.3（P2-30）：视图「改定义」一步到位。
   *
   * `SHOW CREATE VIEW` 的原文是 `CREATE … VIEW`，直接拿来改会撞「已存在」；
   * 这里换成 `CREATE OR REPLACE VIEW` 放进新查询标签 —— 用户改完 SELECT 执行就生效，
   * 不用先 DROP（DROP 会丢权限/依赖，这是视图改定义最容易出事的做法）。
   */
  const onOpenViewDefinition = useCallback(
    async (connId: string, database: string, name: string) => {
      try {
        const r = await backend.schemaGetObjectDdl({ connId, database, name, kind: 'view' });
        const asReplace = toCreateOrReplaceView(r.ddl);
        if (!asReplace) {
          setToast(`没能从服务端返回的定义里认出 CREATE VIEW（${name}）—— 已改用「查看定义」展示原文`);
          fillSqlToEditor(r.ddl);
          return;
        }
        ws.newQuery(connId, database, asReplace);
        setToast(`已把 ${name} 的定义放进新查询标签（CREATE OR REPLACE：改完执行即生效）`);
      } catch (e) {
        setToast(`读取视图定义失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [ws, fillSqlToEditor],
  );

  /**
   * 0.7.3（P1-25）：连接右键「测试连接」。
   *
   * 与连接编辑器里的「测试连接」走**同一个** `backend.connTest`：主进程会临时建连、
   * 跑完立刻关，不进注册表也不落盘；不传 `password` 字段 = 沿用已存密码
   * （否则「什么都没改，测试却说 Access denied」）。
   *
   * 🔴 结果一定回报出**服务端版本 + 耗时**：只回一句「连接成功」的话，用户无法区分
   *    「真的连到目标实例」和「连到了本机另一个 3306」—— 这在多环境机器上是真事故。
   */
  const onTestStoredConnection = useCallback(async (cfg: ConnectionConfig) => {
    setToast(`正在测试 ${cfg.name}…`);
    try {
      const r = await backend.connTest({ config: cfg });
      if (r.ok) {
        setToast(`${cfg.name}：连接成功（${r.serverVersion ?? '版本未知'}，${r.elapsedMs} ms）`);
      } else {
        setToast(`${cfg.name}：连接失败 —— ${r.message ?? '服务端未返回原因'}`);
      }
    } catch (e) {
      setToast(`${cfg.name}：测试失败 —— ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /**
   * v0.6.0：批量删除选中的表。
   *
   * 🔴 三条必须守住的纪律：
   *  1. **按 (连接, 库) 分组执行** —— selection 是全局的，可能同时选中两个库甚至
   *     两个连接的表。mutationApply 只吃一个 connId/database，不能混着发。
   *  2. **确认弹窗展示全部 SQL 原文**（红线 1：写操作先展示可预览的原文）。
   *     选了 30 张表就要列 30 条 —— 只写"确定删除 30 张表吗"等于没让用户看清要删什么。
   *  3. **生产环境要输入表数量**（用户拍板）—— confirmDanger 的 requireText 传数量，
   *     不是表名：一次删几十张时逐个输表名不现实，输"30"才是有效门槛。
   *
   * @param targets 已解析好的 { connId, database, table } 列表
   */
  const onDropTablesBatch = useCallback(
    async (targets: { connId: string; database: string; table: TableMeta }[]) => {
   if (targets.length === 0) return;
   // T14：只读连接的目标先剔除并如实告知，而不是整批跑到一半被主进程拦下
   const blocked = targets.filter((t) => connections.some((c) => c.id === t.connId && c.readOnly === true));
   if (blocked.length > 0) {
     const readOnlyIds = new Set(blocked.map((t) => t.connId));
     targets = targets.filter((t) => !readOnlyIds.has(t.connId));
     setToast(`已跳过 ${blocked.length} 张只读连接上的表（写语句会被主进程 AST 守卫拦截）`);
     if (targets.length === 0) return;
   }

      // 按连接分组，逐组独立执行 —— 某组失败不该让其它组的成功结果变成未知
      const groups = new Map<string, { connId: string; database: string; tables: TableMeta[] }>();
      for (const t of targets) {
   const k = `${t.connId}\u0000${t.database}`;
        const g = groups.get(k);
        if (g) g.tables.push(t.table);
     else groups.set(k, { connId: t.connId, database: t.database, tables: [t.table] });
      }

      const statements = targets.map(
     (t) => `DROP TABLE ${quoteQualified([t.database, t.table.name])}`,
      );
      const anyProduction = targets.some(
     (t) => connections.find((c) => c.id === t.connId)?.colorTag === 'red',
      );
      /**
       * P0-4：批量删除跨连接，但判定必须落在**一个真实的目标连接**上 ——
       * 有生产连接就传它（这样 isProduction 才会为真、第三层不会被绕过），
       * 否则传第一个目标。不能传 activeTab（可能是完全无关的连接）。
       */
      const dangerConnId =
        targets.find((t) => connections.find((c) => c.id === t.connId)?.colorTag === 'red')?.connId ??
        targets[0].connId;
    const confirmed = await confirmDanger(dangerConnId, {
    title: anyProduction ? '生产环境危险操作' : '批量删除表',
        statements,
        reason: `将删除 ${targets.length} 张表（表结构与全部数据），无法自动恢复`,
        // 生产环境要求输入表数量而非表名 —— 一次删几十张时逐个输表名不现实
        requireText: anyProduction ? String(targets.length) : null,
      });
      if (!confirmed) {
  setToast('已取消执行');
   return;
      }

      /**
       * 🔴 T30/R09：逐对象执行 + 逐对象报告。
       *
       * 旧实现把整组 DROP 一次发出去，`okCount += g.tables.length` 一次性累加，
       * 失败时只报「失败 N 组」。两个后果：
       *  1. **MySQL 的 DDL 是隐式提交的**，一组里第 2 个失败时第 1 个已经删掉了，
       *     但整组被计入失败 —— 用户以为「都没删」，实际删了一半（反过来，
       *     若第一个成功第二个失败，旧代码把首个也整组计入失败，更糟）。
       *  2. 标签关闭用的是**全部 targets**，失败的表标签也被关掉，用户失去重试入口。
       *
       * 现在：一张表一条语句，成功才计成功、才登记进 deleted；每张之后刷新真实结构
       * （失败也可能是「服务端已执行、响应丢失」，不回源比不刷新更误导）。
       * 这里**不承诺事务回滚全部 DDL** —— MySQL DDL 自动提交，本来就不具备这个语义。
       */
      let okCount = 0;
      const failures: string[] = [];
      const deleted = new Set<string>();
      for (const g of groups.values()) {
        for (const t of g.tables) {
          const sql = `DROP TABLE ${quoteQualified([g.database, t.name])}`;
          try {
            // T08：DDL 入口 —— 走 DDL 白名单（否则 DROP 被表达式白名单误拒）
            await backend.mutationApply({
              connId: g.connId,
              database: g.database,
              statements: [{ sql, params: [] }],
              mode: 'ddl',
            });
            okCount++;
            deleted.add(`${g.connId}\u0000${g.database}\u0000${t.name}`);
          } catch (e) {
            failures.push(`${g.database}.${t.name}：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // 每组结束回源刷新：核实树的真实状态（成功/失败/响应丢失都以此为准）
        void onRefreshConnSchema(g.connId);
      }

      if (failures.length > 0) {
        setToast(`已删除 ${okCount} 张，失败 ${failures.length} 张（${failures.join('；')}）`);
      } else {
        setToast(`已删除 ${okCount} 张表`);
      }

      // 只关闭「确认已删除」的标签 —— 失败的标签必须留着（重试入口 / 排查现场）
      for (const t of ws.tabs) {
        if (t.kind === 'table' && deleted.has(`${t.connId}\u0000${t.database}\u0000${t.tableName}`)) {
          ws.closeTab(t.id);
        }
      }
    },
    [connections, confirmDanger, ws, onRefreshConnSchema],
  );

  /**
   * v0.6.0：把树上选中的 key 解析成可执行的删表目标。
   *
   * 从 treeRoots 反查而不是只信 selection 里的 key —— 表可能刚被别处删掉，
   * 拿着陈旧 key 去 DROP 会报一堆无意义的 "doesn't exist"。
   * 只收 kind === 'table'（视图不可批量删除，语义上也说不通）。
   */
  const resolveSelectedTables = useCallback((): { connId: string; database: string; table: TableMeta }[] => {
    if (treeSelection.size === 0) return [];
    const out: { connId: string; database: string; table: TableMeta }[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'object' && n.table?.kind === 'table' && treeSelection.has(n.key) && n.database) {
  const parts = n.key.split(':');
   const connId = parts[0] === 'obj' && parts.length >= 3 ? parts[1] : '';
      if (connId) out.push({ connId, database: n.database, table: n.table });
     }
        walk(n.children ?? []);
      }
 };
    walk(treeRoots);
    return out;
  }, [treeSelection, treeRoots]);

  /**
   * 树右键「批量删除表…」。调用点只在多选了 ≥2 张表时才出现 ——
   * 选中 1 张时菜单里的「删除表」已经够用，重复出一个入口只会让人多点一次。
   */
  const dropSelectedTables = useCallback(() => {
    const targets = resolveSelectedTables();
    if (targets.length === 0) {
      setToast('选中的对象已不存在（可能刚被删除）');
 return;
    }
    void onDropTablesBatch(targets).then(() => setTreeSelection(new Set()));
  }, [resolveSelectedTables, onDropTablesBatch]);

  /**
   * 树右键「运行 SQL 脚本…」入口：先握手（磁盘快照节点上脚本没法跑），
   * promptEveryTime 连接先要密码（输完经 pendingAfterConnectRef 回到此处）。
   */
  const openScriptModal = useCallback(
    async (connId: string, database: string) => {
      const ensure = await ensureConnection(connId);
      if (ensure === 'need-password') {
        const cfg = connections.find((c) => c.id === connId);
        if (cfg) setPwdPrompt(cfg);
        pendingAfterConnectRef.current = () => void openScriptModal(connId, database);
        setToast('该连接要求手动输入密码，输入后自动继续');
        return;
      }
      if (ensure === 'failed') {
        setToast('连接未建立，无法执行脚本（左树单击连接节点重试）');
        return;
      }
      setScriptTarget({ connId, database });
    },
    [ensureConnection, connections],
  );

  /**
   * V7：连接节点右键「运行 SQL 脚本…」—— 连接级没有库上下文，先弹目标库选择。
   *
   * 库列表来源：① 已加载的 schema（schemas[connId]）；② schema 未加载时先握手 + schemaRefresh
   * 拉一次（连接可能刚连上或来自磁盘快照）。握手走与库/表级完全相同的 ensureConnection，
   * promptEveryTime 场景同样经 pendingAfterConnectRef 回到此处（闭环一致）。
   */
  const openConnScriptPick = useCallback(
    async (connId: string, connName: string) => {
      const ensure = await ensureConnection(connId);
      if (ensure === 'need-password') {
        const cfg = connections.find((c) => c.id === connId);
        if (cfg) setPwdPrompt(cfg);
        pendingAfterConnectRef.current = () => void openConnScriptPick(connId, connName);
        setToast('该连接要求手动输入密码，输入后自动继续');
        return;
      }
      if (ensure === 'failed') {
        setToast('连接未建立，无法执行脚本（左树单击连接节点重试）');
        return;
      }
      // 优先用已加载 schema；为空则拉一次（磁盘快照/首次连接场景）
      let dbs = schemas[connId] ?? [];
      if (dbs.length === 0) {
        try {
          dbs = await backend.schemaRefresh(connId);
          setSchemas((prev) => ({ ...prev, [connId]: dbs }));
        } catch {
          // 拉不到库列表也允许继续（用户可能在脚本里 CREATE DATABASE）
          dbs = [];
        }
      }
      const names = dbs.map((d) => d.name);
      if (names.length === 1) {
        // 只有一个库 → 跳过选择，直接进入脚本流程（少一次点击）
        void openScriptModal(connId, names[0]);
        return;
      }
      setScriptDbPick({ connId, connName, databases: names });
    },
    [ensureConnection, connections, schemas, openScriptModal],
  );

  /**
   * 脚本跑完（或中止）刷新该连接的 schema —— 树要跟上脚本建出来的新表。
   *
   * 🔴 v0.6.0：原来这里是 `.catch(() => undefined)` —— 刷新失败静默吞掉，
   *   用户看到的就是"我明明建了表，刷新了它还是不存在"，且没有任何线索。
   *   刷新失败必须**如实报错**，否则用户无从判断是脚本没建成功还是刷新没生效。
   */
  const onScriptFinished = useCallback(
    (connId: string) => {
      void backend
        .schemaRefresh(connId)
        .then((dbs) => setSchemas((prev) => ({ ...prev, [connId]: dbs })))
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          setToast(`脚本已执行，但刷新表结构失败：${msg}（可在左侧树右键「刷新」重试）`);
        });
    },
    [],
  );

  /**
   * P2-18j：导出全部连接配置。
   *
   * 🔴 文案里必须写明「不含密码」。用户拿到这个文件是要放进网盘/发给同事的，
   *    如果界面上只写「已导出 3 条连接」，他会合理地以为密码也在里面，
   *    于是下次换机导入后一脸茫然地连不上 —— 或者在群里说"密码在文件里"。
   */
  const onExportConnections = useCallback(async () => {
    if (connections.length === 0) {
      setToast('没有可导出的连接');
      return;
    }
    const text = serializeConnectionBundle(buildConnectionBundle(connections, Date.now()));
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      const path = await backend.connBundleSave(`dbstudio-connections-${stamp}.json`, text);
      if (!path) return; // 用户取消：静默（用户自己知道点了取消）
      setToast(`已导出 ${connections.length} 条连接（不含密码，导入后需重输）：${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`导出连接配置失败：${msg}`);
    }
  }, [connections, setToast]);

  /**
   * P2-18j：导入连接配置。
   *
   * 三处必须如实回报的地方：
   *  ① 文件不合法 → 报**解析器给的中文原因**（哪一条缺什么），不是"导入失败"；
   *  ② 重名被改名 → 报出「原名 → 新名」，否则用户按名字找不到刚导入的连接；
   *  ③ 导入的连接一律没有密码 → 说清"首次连接需重输"。
   * 中途某条保存失败 → **不静默续跑**，直接报出已完成条数（与 ALTER 失败同口径）。
   */
  const onImportConnections = useCallback(async () => {
    let path: string | null = null;
    try {
      path = await backend.connBundlePick();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`导入连接需要桌面应用环境：${msg}`);
      return;
    }
    if (!path) return; // 取消
    try {
      // 复用 SQL 文件的读取实现：它在主进程做了编码探测（GBK/UTF-8/BOM），
      // 手工改过的配置常常是 GBK —— 自己用 fs.readFile('utf8') 会读成乱码再报 JSON 解析失败
      const file = await backend.sqlFileRead(path);
      const parsed = parseConnectionBundle(file.text);
      if (!parsed.ok) {
        setToast(`导入失败：${parsed.reason}`);
        return;
      }
      if (parsed.bundle.connections.length === 0) {
        setToast('该文件里没有任何连接配置');
        return;
      }
      const plan = planConnectionImport(parsed.bundle, connections);
      let done = 0;
      for (const config of plan.toCreate) {
        try {
          /**
           * 🔴 `promptEveryTime` 必须放在**顶层入参**，不能只写在 config 里。
           * 主进程的 ConnectionStore.save() 只看 `input.promptEveryTime`：
           * config 里那个字段会先被 normalize 掉，然后密文来源落到
           * `prevFields`（新建 = 没有密文 + promptEveryTime:false）→ 校验器直接拒绝
           * 「未保存密码且未勾选每次手动输入」。只传 config 的话，导入**必然全条失败**。
           */
          await backend.connSave({ config, promptEveryTime: true });
          done += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await reloadConnections();
          setToast(`导入中断：已保存 ${done} / ${plan.toCreate.length} 条，第 ${done + 1} 条（${config.name}）失败：${msg}`);
          return;
        }
      }
      await reloadConnections();
      const renamed = plan.renamed.length
        ? `；${plan.renamed.length} 条重名已改名：${plan.renamed
            .slice(0, 3)
            .map((r) => `${r.from} → ${r.to}`)
            .join('、')}${plan.renamed.length > 3 ? ' 等' : ''}`
        : '';
      setToast(`已导入 ${done} 条连接${renamed}。密码未随文件带过来，首次连接时需重新输入`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`导入连接配置失败：${msg}`);
    }
  }, [connections, reloadConnections, setToast]);

  /**
   * 树节点右键菜单（Navicat 式，按级别出操作）。
   * 右键同时选中该节点 —— 与 Navicat 行为一致，且保证后续动作的上下文可预期。
   */
  const openNodeMenu = useCallback(
    (node: TreeNode, x: number, y: number, extra?: { treeItems: ContextMenuItem[] }) => {
      const items: ContextMenuItem[] = [];
      const parsed = parseTreeKeyContext(node.key);
      const push = (
        key: string,
        label: string,
        icon: ContextMenuItem['icon'],
        onSelect: () => void,
        opts: Partial<ContextMenuItem> = {},
      ) => items.push({ key, label, icon, onSelect, ...opts });

      /**
       * 🔴 T14：只读连接下的**写类动作一律禁用并给出原因**。
       *
       * 原来的做法是「菜单可点 → 走到最后一步才被主进程 AST 守卫拦下」，用户看到的
       * 是「明明能点，却报错」。后端防线不因此减弱（core-sql-guard 仍是最后一道），
       * 这里只负责让入口**诚实地说明能不能做**。
       */
      const readOnlyReason = '该连接已标记为只读：写语句会被主进程 AST 守卫拦截';
      const roGuard = (
        cid: string,
        base: Partial<ContextMenuItem> = {},
      ): Partial<ContextMenuItem> =>
        connections.find((c) => c.id === cid)?.readOnly === true
          ? { ...base, disabled: true, disabledReason: readOnlyReason }
          : base;

      if (node.kind === 'connection' && node.connection) {
        const cfg = node.connection;
        const live = connStates[cfg.id]?.state === 'connected' || connStates[cfg.id]?.state === 'busy';
        push('toggle', live ? '断开连接' : '打开连接', live ? <IconPower size={12} /> : <IconPlug size={12} />, () =>
          onToggleConnectionNode(cfg, live),
        );
        push('newquery', '新建查询', <IconTerminal size={12} />, () => ws.newQuery(cfg.id, null));
        /**
         * 0.7.3（P0-19）：新建数据库。
         *
         * 放在「新建查询」之后、「编辑连接」之前 —— 它是**对象生命周期**的第一环，
         * 与后面的「编辑/复制/连接维护」分开；Navicat 的连接右键也是这个次序。
         */
        push('newdb', '新建数据库…', <IconPlus size={12} />, () => void openCreateDb(cfg.id), roGuard(cfg.id));
        push('edit', '编辑连接…', <IconGear size={12} />, () =>
          setEditorState({ config: cfg, duplicateOf: null }),
        );
        /**
         * P1-8：创建副本。
         *
         * 预填**除密码外的全部字段**（密码是 safeStorage 密文，渲染层根本读不出来）；
         * 名字自动加「副本」并做重名递增。保存时走「新建」并把源连接 id 告诉主进程，
         * 由它把密文按字节复制过来 —— 副本因此不需要用户重输密码。
         * 🔴 默认库/分组/颜色/只读/SSH/SSL/空闲超时全部照抄，否则"副本"就只是
         *    一个地址对得上的空壳。
         */
        push('duplicate', '创建副本…', <IconCopy size={12} />, () =>
          setEditorState({
            config: { ...cfg, name: duplicateConnectionName(cfg.name, connections.map((c) => c.name)) },
            duplicateOf: cfg.id,
          }),
        );
        // 0.7.3（P1-25）：测试连接 —— 与编辑器内那颗按钮同一个后端调用，结果带版本与耗时
        push('testconn', '测试连接', <IconPlug size={12} />, () => void onTestStoredConnection(cfg));
        // V7：连接级「运行 SQL 脚本…」入口 —— 先弹目标库选择（连接可能挂多个库）
        push('runscript', '运行 SQL 脚本…', <IconFileCode size={12} />, () =>
          void openConnScriptPick(cfg.id, cfg.name),
        );
        /**
         * T16（报告 §4.4 最小集）：复制连接信息。
         * 🔴 **必须脱敏** —— 只拼 name/user@host:port/db，绝不带 passwordEnc / 私钥路径。
         *    复制出来的字符串经常被贴到聊天窗口或工单里，带上凭据就是事故。
         */
        push('copyconn', '复制连接信息（不含密码）', <IconCopy size={12} />, () =>
          copyText(
            `${cfg.name}\t${cfg.user}@${cfg.host}:${cfg.port}${cfg.defaultDatabase ? `/${cfg.defaultDatabase}` : ''}`,
          ),
        );
        push('refresh', '刷新表结构', <IconRefresh size={12} />, () => void onRefreshConnSchema(cfg.id));
        // P2-18j：连接配置的搬迁入口。放在连接级（而不是全局设置里）——
        // 用户想到"备份连接"时，手就在某个连接上。
        push('exportconns', '导出全部连接…', <IconExport size={12} />, () => void onExportConnections(), {
          separatorBefore: true,
        });
        push('importconns', '导入连接…', <IconImport size={12} />, () => void onImportConnections());
        push('delete', '删除连接…', <IconXSmall size={12} />, () => void onDeleteConnection(cfg), {
          danger: true,
          separatorBefore: true,
        });
      } else if (node.kind === 'database' && node.database) {
        const connId = parsed?.connId ?? '';
        push('newquery', '新建查询', <IconTerminal size={12} />, () => ws.newQuery(connId, node.database!));
        push('newtable', '新建表…', <IconPlus size={12} />, () =>
          setDesigner({ mode: 'new', database: node.database!, table: null, connId }),
          roGuard(connId),
        );
        // 0.7.3（P0-19 第三入口）：库级也放一条「新建数据库」—— 用户想建库时手常常
        // 已经在某个库上（"再建一个同规格的库"），不必回连接节点
        push('newdb', '新建数据库…', <IconPlus size={12} />, () => void openCreateDb(connId), roGuard(connId));
        // 运行 SQL 脚本：库级别入口（删库重建 / 导入建表+数据脚本）
        push(
          'runscript',
          '运行 SQL 脚本…',
          <IconFileCode size={12} />,
          () => void openScriptModal(connId, node.database!),
        );
        // T16：库级也补一条「插入 SELECT」—— 库名常常是「我要查这个库」的起点
        push('select-in-query', '在新查询中插入 SELECT', <IconTerminal size={12} />, () =>
          // 🔴 quoteQualified 遇到空串会**抛错**（限定名格式校验），所以这里只传库名，
          //    末尾的 `.` 由自己拼 —— 它是语法分隔符，不是标识符
          ws.newQuery(connId, node.database!, `SELECT * FROM ${quoteQualified([node.database!])}.`),
        );
        push('copyname', '复制库名', <IconCopy size={12} />, () => copyText(node.database!));
        /**
         * 0.7.3（P1-24）：导出整库。
         *
         * 🔴 `table: null`：整库没有"当前表"，弹窗据此把范围预选成「整库」
         *    （其余三项如实禁用）。导出弹窗本来就有整库能力（E4），缺的只是入口。
         */
        push(
          'exportdb',
          '导出整库…',
          <IconExport size={12} />,
          () => setExportTarget({ connId, database: node.database!, table: null }),
          // 导出是纯读操作 —— 只读连接照样能导（不要用 roGuard 误伤）
          { separatorBefore: true },
        );
        push('refresh', '刷新', <IconRefresh size={12} />, () => void onRefreshConnSchema(connId), {
          separatorBefore: true,
        });
        /**
         * 0.7.3（P1-21）：库级也放一条「新建视图」—— 视图是这五类里唯一高频的
         * （固化的查询口径 / 报表口径）。过程/函数/触发器/事件从对应**类别**节点
         * 发起：那里才是"我在看这一类对象"的上下文，五个都堆在库菜单里只是噪音。
         */
        push('newview', '新建视图…', <IconPlus size={12} />, () =>
          openObjectTemplate('view', connId, node.database!),
          roGuard(connId, { separatorBefore: true }),
        );
        /**
         * 0.7.3（P0-20）：删除数据库 —— 危险第三层（无条件输库名）。
         * 放在最后且单独隔开：它是该库上唯一不可逆的操作。
         */
        push('dropdb', '删除数据库…', <IconXSmall size={12} />, () => void onDropDatabase(connId, node.database!), {
          ...roGuard(connId, { danger: true, separatorBefore: true }),
        });
      } else if (node.kind === 'kind' && node.database) {
        const connId = parsed?.connId ?? '';
        if (node.objectKind === 'table') {
          push('newtable', '新建表…', <IconPlus size={12} />, () =>
            setDesigner({ mode: 'new', database: node.database!, table: null, connId }),
            roGuard(connId),
          );
        } else if (
          node.objectKind === 'view' ||
          node.objectKind === 'procedure' ||
          node.objectKind === 'function' ||
          node.objectKind === 'trigger' ||
          node.objectKind === 'event'
        ) {
          /**
           * 0.7.3（P1-21）：类别节点上的「新建 X…」—— 此前这五类**只有「刷新」**
           * （能看不能建）。模板走新建查询标签，用户改完执行即可（P1-21 的克制路线）。
           */
          const kind = node.objectKind as ObjectCreateKind;
          push('newobj', `新建${OBJECT_KIND_TEXT[kind]}…`, <IconPlus size={12} />, () =>
            openObjectTemplate(kind, connId, node.database!),
            roGuard(connId),
          );
        }
        push('refresh', '刷新', <IconRefresh size={12} />, () => void onRefreshConnSchema(connId));
        /**
         * 🔴 T17（报告 §5 R13）：类别节点**必须合并树侧自管项**。
         *
         * `TreeView` 已经构造好「全选本组」（`buildGroupMenuItems`），可宿主这里
         * 一直没接 —— 函数存在、能力却**没有真实入口**，属于「看起来做了」。
         * 树把 extras 传过来了就一定要合并，否则这一项永远点不到。
         */
        if (extra?.treeItems?.length) items.push(...extra.treeItems);
      } else if (node.kind === 'object' && node.table && node.database) {
        const connId = parsed?.connId ?? '';
        const table = node.table;
        const qualified = quoteQualified([node.database, table.name]);
        /**
         * 🔴 T16（报告 §4.4）：「打开表」这个泛用文案对视图/过程/函数都叫「表」不准确；
         *    更要紧的是**过程/函数/触发器/事件根本没有可打开的数据网格** ——
         *    给它们这一项就是「出现对象不支持的动作」。所以只在 table / view 上给。
         */
        const openable = table.kind === 'table' || table.kind === 'view';
        if (openable) {
          push('open', table.kind === 'table' ? '打开表' : '打开视图', <IconTable size={12} />, () =>
            onOpenObject(node),
          );
          // T16：直接开一个新查询并预填 SELECT —— 比「新建查询 + 手敲表名」少两步
          push('select-in-query', '在新查询中插入 SELECT', <IconTerminal size={12} />, () =>
            ws.newQuery(connId, node.database!, `SELECT * FROM ${qualified} LIMIT 100;`),
          );
        }
        /**
         * 0.7.3（P2-30）：视图改定义一步到位（CREATE OR REPLACE）。
         * 与树侧的「查看定义」互补：查看是只读看原文，改定义是**可执行**的模板。
         */
        if (table.kind === 'view') {
          push('view-redefine', '在新查询中打开定义（可改）', <IconFileCode size={12} />, () =>
            void onOpenViewDefinition(connId, node.database!, table.name),
            roGuard(connId),
          );
        }
        if (table.kind === 'table') {
          push('design', '设计表…', <IconDesign size={12} />, () =>
            setDesigner({ mode: 'edit', database: node.database!, table, connId }),
            roGuard(connId),
          );
          /**
           * 0.7.3（P1-22）：重命名表（F2）。放在「设计表」之前 —— 它比设计器更常用，
           * 且 F2 的肌肉记忆就落在这里（Finder/VSCode/Excel 都是 F2 改名）。
           */
          push('rename', '重命名表…', <IconDesign size={12} />, () =>
            setRenameTable({ connId, database: node.database!, table }),
            roGuard(connId),
          );
          push('export', '导出数据…', <IconExport size={12} />, () =>
            setExportTarget({ connId, database: node.database!, table }),
          );
          push('import', '导入数据…', <IconImport size={12} />, () =>
            setImportTarget({ connId, database: node.database!, table }),
            roGuard(connId),
          );
          // 表级别脚本入口：对本表所在库执行脚本（重建该表 / 补数据等场景）
          push('runscript', '运行 SQL 脚本…', <IconFileCode size={12} />, () =>
            void openScriptModal(connId, node.database!),
          );
        }
        push('copyname', table.kind === 'table' ? '复制表名' : '复制名称', <IconCopy size={12} />, () =>
          copyText(table.name),
        );
        // T16：完整限定名（`db`.`table`）—— 贴进 SQL 里可直接用，比裸表名常用得多
        push('copyqualified', '复制完整限定名', <IconCopy size={12} />, () => copyText(qualified));
        // 合并树侧自管菜单项（查看定义 / 复制 DDL / INSERT 模板 / 收藏）——排在危险项之前
        if (extra?.treeItems?.length) items.push(...extra.treeItems);
        /**
         * 0.7.3（P2-28 / P2-27）：复制表 + 表维护。
         * 都放在清空/删除**之前**：安全操作不该排在危险操作后面（用户看到红色项
         * 就容易停手，而复制表恰恰是他最想找的那一项）。
         */
        if (table.kind === 'table') {
          push('copytable', '复制表…', <IconCopy size={12} />, () =>
            setCopyTable({ connId, database: node.database!, table }),
            roGuard(connId, { separatorBefore: true }),
          );
          // 维护三项平铺（菜单没有二级结构）：优化/分析/检查都是单表命令，文案自成一句
          for (const action of ['optimize', 'analyze', 'check'] as MaintenanceAction[]) {
            push(
              `maintain-${action}`,
              `${MAINTENANCE_LABELS[action]}…`,
              <IconRefresh size={12} />,
              () => void onMaintainTable(action, connId, node.database!, table.name),
              roGuard(connId),
            );
          }
        }
if (table.kind === 'table') {
      push('truncate', '清空表…', null, () => void onTableDestructive('truncate', connId, node.database!, table),
            roGuard(connId, { danger: true, separatorBefore: true }),
       );
          push('drop', '删除表…', null, () => void onTableDestructive('drop', connId, node.database!, table),
            roGuard(connId, { danger: true }),
          );
    /**
       * v0.6.0：多选了 ≥2 张表时，额外给一个批量删除入口。
    *
  * 刻意**不覆盖**单表「删除表」：用户右键的是某一张表，
    * 语义上「删除表」就该删它；批量是另一件事，多点一次最不容易误删。
         */
          const selectedCount = treeSelection.size;
    if (selectedCount > 1) {
          const n = resolveSelectedTables().length;
     push('drop-batch', `批量删除 ${n} 张表…`, null, dropSelectedTables,
            roGuard(connId, { danger: true, separatorBefore: true }),
   );
        }
        }
      } else if (node.kind === 'group') {
        push('newconn', '新建连接…', <IconPlus size={12} />, () => setEditorState('new'));
        /**
         * 0.7.3（P2-29）：分组管理。
         *
         * 此前整理分组只能逐个进连接编辑器手输 `生产/订单` 路径字符串 ——
         * 「分组」这个能力有了界面却没作业面。
         * 🔴 未分组（`group-root:ungrouped`）**不是**可重命名的实体，不给这两项。
         */
        const groupPath = node.key.startsWith('group:') ? node.key.slice('group:'.length) : '';
        if (groupPath) {
          push('newgroup', '新建子分组…', <IconPlus size={12} />, () =>
            setGroupPrompt({ mode: 'create', path: groupPath }),
            { separatorBefore: true },
          );
          push('renamegroup', '重命名分组…', <IconDesign size={12} />, () =>
            setGroupPrompt({ mode: 'rename', path: groupPath }),
          );
          /**
           * 删除分组：**只允许删空分组**。
           *
           * 有连接的分组"删除"到底意味着什么（连接去哪？）没有无歧义的答案，
           * 所以不做——给出原因，让用户先把连接挪走。空分组则必须能删：
           * 否则「新建分组」就只能建、不能撤销（那是本功能自己造的死路）。
           */
          const groupHasConns = connections.some((c) => isInGroup(c.group, groupPath));
          push(
            'deletegroup',
            '删除分组…',
            <IconXSmall size={12} />,
            () => {
              commitEmptyGroups(removeEmptyGroupSubtree(emptyGroups, groupPath));
              setToast(`已删除空分组 ${groupPath}`);
            },
            groupHasConns
              ? { disabled: true, disabledReason: '该分组下还有连接：请先把连接移到别的分组（或删除连接）再删分组' }
              : { danger: true },
          );
        }
      }

      if (items.length > 0) setCtxMenu({ x, y, title: node.label, items });
    },
    [connStates, connections, onToggleConnectionNode, onDeleteConnection, onRefreshConnSchema, onOpenObject, ws, copyText, onTableDestructive, openScriptModal, openConnScriptPick, treeSelection, resolveSelectedTables, dropSelectedTables, onExportConnections, onImportConnections, openCreateDb, onDropDatabase, onTestStoredConnection, openObjectTemplate, onOpenViewDefinition, onMaintainTable, commitEmptyGroups, emptyGroups],
  );

  /** 树空白区右键：新建连接 */
  const openTreeBackgroundMenu = useCallback((x: number, y: number) => {
    setCtxMenu({
      x,
      y,
      items: [{ key: 'newconn', label: '新建连接…', icon: <IconPlus size={12} />, onSelect: () => setEditorState('new') }],
    });
  }, []);

  // ---- 编辑器执行 SQL：危险语句先过确认（P0-3） ----
  const onRunSql = useCallback(
    async (req: { connId: string; sql: string; database?: string | null; queryId?: string }) => {
      // 🔴 执行前确保会话可用：查询标签可能建立在磁盘快照上（右键新建查询
      //    而没点过连接节点），直接执行会「连接未建立」。这里自动握手。
      const ensure = await ensureConnection(req.connId);
      if (ensure === 'need-password') {
        const cfg = connections.find((c) => c.id === req.connId);
        if (cfg) setPwdPrompt(cfg);
        pendingAfterConnectRef.current = () => void onRunSql(req);
        setToast('该连接要求手动输入密码，输入后自动继续执行');
        return {
          payload: { rowCount: 0, columns: [], buffers: [], bufferCounts: [] },
          elapsedMs: 0,
          rowCount: 0,
          cancelled: true,
          truncated: false,
          queryId: null,
        };
      }
      if (ensure === 'failed') {
        // 握手失败的真实原因已由连接路径 toast；结果页给出明确结论
        throw new Error('自动连接失败（原因见提示；也可在左树单击连接节点重试）');
      }
      // 动态加载守卫：node-sql-parser 太大（~500KB gzip），绝不进首屏 bundle
      const { classifyDanger } = await import('@dbstudio/core-sql-guard');
      const danger = classifyDanger(req.sql);
      if (danger.level !== 'none') {
        const connId = req.connId || sqlConnId;
        const isProduction = connections.find((c) => c.id === connId)?.colorTag === 'red';
        const confirmed = await confirmDanger(connId, {
          title: isProduction ? '生产环境危险操作' : '危险操作确认',
          statements: danger.statements.length > 0 ? danger.statements : [req.sql],
          reason: danger.reason,
          // 生产环境 / DROP DATABASE → 要求输入表名（第三层）
          requireText: danger.requireName,
        });
        if (!confirmed) {
          setToast('已取消执行');
          return {
            payload: { rowCount: 0, columns: [], buffers: [], bufferCounts: [] },
            elapsedMs: 0,
            rowCount: 0,
            cancelled: true,
            truncated: false,
            queryId: null,
          };
        }
      }
      return backend.queryRun(req).then((out) => {
        /**
         * 0.7.3（P1-21）：DDL 跑完自动刷新结构。
         *
         * 建视图/过程/函数/触发器/事件走的是「模板 → 编辑器 → 执行」，执行器此前
         * **不刷新 schema** —— 用户执行成功后左边树上还是旧结构，看起来像没建成，
         * 只能自己想起来去点「刷新」。
         *
         * 判据用关键字而不是 AST：AST 分类器在首屏之外，而且只吃单条语句；
         * 这里要做的决定只是「要不要多跑一次 schemaRefresh」——那是纯读、
         * 幂等、开销可控。**宁可多刷一次，也不要让树停在旧结构上。**
         */
        if (/\b(?:create|alter|drop|rename|truncate)\b/i.test(req.sql)) {
          void onRefreshConnSchema(req.connId);
        }
        return out;
      });
    },
    [ensureConnection, connections, confirmDanger, sqlConnId, onRefreshConnSchema],
  );
  const onCancelSql = useCallback((queryId: string) => backend.queryCancel(queryId), []);

  // ---- 应用筛选（预览文本由 TablePane 自己显示，这里只管过滤动作的触发） ----
  /**
   * 已应用的条件数：从 `openTab.filter` 派生（**唯一真值**），不读草稿。
   * 这样徽标只会在「真的筛了数据」之后才亮，且切表自动跟随。
   * 🔴 用 `effectiveConditionCount` 而不是 `conditionCount`：后者把「未选字段/未填值」
   *    的半截行也数进去，会宣称「筛选 (2)」而 WHERE 里其实只有 1 条（甚至 0 条）。
   */
  const appliedFilter = openTab?.filter ?? null;
  const filterCount = appliedFilter ? effectiveConditionCount(appliedFilter) : 0;

  /** 打开弹窗：把草稿种子设为当前已应用的筛选（没有就空） */
  const openFilter = useCallback(() => {
    setFilterDraft(openTab?.filter ?? emptyFilter());
    setFilterOpen(true);
  }, [openTab]);

  /** 关闭弹窗（取消 / 点遮罩 / Esc）：草稿直接丢弃 */
  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    setFilterDraft(null);
  }, []);

  const applyFilter = useCallback(() => {
    if (!openTab || !filterDraft) return;
    const next = filterDraft;
    closeFilter();
    void loadTable(
      openTab.id,
      { connId: openTab.connId, database: openTab.database, tableName: openTab.tableName, table: openTab.table },
      { keepSort: true, sorts: openTab.sorts, filter: next },
    );
  }, [openTab, filterDraft, closeFilter, loadTable]);

  const clearFilter = useCallback(() => {
    const next = emptyFilter();
    // 「清除」是立即生效的动作（不是草稿）：同时收掉弹窗并重载数据
    closeFilter();
    if (openTab)
      void loadTable(
        openTab.id,
        { connId: openTab.connId, database: openTab.database, tableName: openTab.tableName, table: openTab.table },
        { keepSort: true, sorts: openTab.sorts, filter: next },
      );
  }, [openTab, closeFilter, loadTable]);

  // ---- 全局快捷键（§9.2 键盘优先）----
  // 必须挂在 window 上：焦点可能在树、工具栏、弹窗里，
  // 只挂网格容器会导致 ⌘S / ⌘K 时灵时不灵（真机实测抓到过）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // T13：输入法组合期的按键整段放行（F12 兜底键也在内 —— 组合期不该开浮层）
      if (isImeComposing(e)) return;
      /**
       * T13：模态打开时，全局快捷键**不进背景**。
       *
       * 原实现在偏好设置面板开着时按 ⌘T，会在面板背后新建一个标签（真机 e2e
       * K5.2 抓到）—— 用户眼前的模态并没有「吃掉」键盘。这里用统一闸门收口：
       * `.modal-mask` 是全仓模态的唯一外壳类，只要它在，除 Esc 之外一律放行给
       * 模态自己的 keydown 处理（Esc 仍留给模态关闭，见各弹窗的 onKey）。
       */
      if (e.key !== 'Escape' && document.querySelector('.modal-mask')) {
        // 例外：命令面板已开时，⌘K 仍是它自己的开关（否则开了只能靠 Esc 关）
        const m = e.metaKey || e.ctrlKey;
        const paletteOnly =
          document.querySelectorAll('.modal-mask').length === 1 &&
          !!document.querySelector('.palette');
        if (!(paletteOnly && m && e.key.toLowerCase() === 'k')) return;
      }
      /**
       * V20：⌘F12 打开列快速定位。
       *
       * 🔴 带不带 ⌘ 都收：macOS 可能把 F12 / ⌘F12 分给系统功能（Dashboard、
       *    亮度），此时事件要么不带 metaKey 到达、要么根本不到；只认 ⌘F12 会在
       *    一部分机器上变成"按了没反应"。所以两条都认，并在命令面板里另留一条
       *    同名入口（真正收不到事件时的兜底路径）。
       */
      if (e.key === 'F12') {
        openColumnFinder();
        e.preventDefault();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        setPaletteOpen((v) => !v);
        e.preventDefault();
      } else if (k === 's') {
        // T12 / I04 裁定：⌘S 归「保存表修改」；SQL 标签下改为保存片段，
        // 任何标签下都必须有明确反馈（细节见 requestSaveActive 的注释）。
        requestSaveActive();
        e.preventDefault();
      } else if (k === 't' && !e.shiftKey) {
        newQueryTab(); // ⌘T 新建查询标签（§9.1）
        e.preventDefault();
      } else if (k === 'w' && !e.shiftKey) {
        if (ws.activeId) requestCloseTab(ws.activeId); // ⌘W 关闭当前标签
        e.preventDefault();
      } else if (k === 'f' && e.shiftKey) {
        /**
         * P1-15：⌘⇧F 打开筛选。
         *
         * 键位在 `action-catalog` 里早就给了 `filter`（⇧⌘F，原生菜单也认），
         * 但**页面这一层从来没接** —— 纯浏览器 demo（无菜单）按下去毫无反应；
         * 真机上菜单拦走了事件，所以只有 demo 路径是哑的。审计把它列成
         * 「筛选器无直接快捷键」，指的就是这条断链。
         *
         * 只在表标签下生效：没有表就没有可筛的对象，此时直接吞掉键、
         * 不弹一个空面板（openFilter 需要 openTab 才能种子化草稿）。
         */
        if (openTab) {
          openFilter();
          e.preventDefault();
        }
      } else if (k === '[' && e.shiftKey) {
        ws.cycle(-1);
        e.preventDefault();
      } else if (k === ']' && e.shiftKey) {
        ws.cycle(1);
        e.preventDefault();
      } else if (k === ',') {
        // V5：⌘, 打开偏好设置（macOS 惯例；Electron 下菜单层也转发同命令，
        // 页面分支作纯浏览器 demo 兜底 —— 两边最终都落到 setPrefsOpen(true)）
        setPrefsOpen(true);
        e.preventDefault();
      } else if (/^[1-9]$/.test(k) && !e.shiftKey) {
        // T12 / 报告 §4.2：原条件带 `ws.tabs.length <= 9`，标签超过 9 个时
        // **前九个也一起失效**（用户按 ⌘1 莫名其妙没反应）。越界由 jumpTo 自己兜。
        ws.jumpTo(Number(k) - 1);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newQueryTab, requestCloseTab, ws, requestSaveActive, openColumnFinder, openFilter, openTab]);

  // ---- 命令面板候选项 ----
  const paletteItems: PaletteItem[] = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const [connId, dbs] of Object.entries(schemas)) {
      for (const db of dbs) {
        for (const t of db.tables) {
          out.push({
            id: `${connId}:${db.name}:${t.name}`,
            title: t.name,
            subtitle: `${db.name}`,
            badge: t.kind === 'view' ? '视图' : '表',
            // P1-14：带上「最近使用」时间，排序才会把常看的表排前面
            lastUsedAt: recentTables[`${connId}:${db.name}:${t.name}`],
          });
        }
      }
    }
    // C5 收藏表置顶（稳定排序：收藏组/普通组内部保持原序）。
    // 依赖 paletteOpen：每次打开面板重读 localStorage，收藏后 ⌘K 立即生效。
    const favSet = new Set(loadFavorites());
    out.sort((a, b) => (favSet.has(a.id) ? 0 : 1) - (favSet.has(b.id) ? 0 : 1));

    /**
     * V20 / V19：两条动作条目置顶。
     *
     * 🔴 id 用 `cmd:` 前缀与表条目的「连接:库:表」区分 —— onPickTable 见到这个
     *    前缀就转动作分派，否则会被当成三元组去开一张不存在的表（静默 no-op）。
     *    置顶是因为结果只显示前 10 条，藏在表里等于没有。
     */
    const stripeCol = openTab ? (groupStripeByTab[openTab.id] ?? null) : null;
    out.unshift(
      {
        id: 'cmd:openColumnFinder',
        title: '列列表快速定位',
        subtitle: '⌘F12 · 在当前表里按列名定位',
        badge: '命令',
      },
      {
        id: 'cmd:toggleGroupStripe',
        title: '按列分组着色',
        subtitle: stripeCol ? `当前：${stripeCol}（执行后关闭）` : '按当前列的值交替着色（执行后开启）',
        badge: '命令',
      },
      // V23：磁盘有初始标签的窗口是"任务窗口"，但它同样可以有当前表 ——
      // 只在真的开着表标签时才提示这条，空工作区里搜出来点了也只是报错。
      ...(openTab
        ? [
            {
              id: 'cmd:openInNewWindow',
              title: '在新窗口打开当前表',
              subtitle: `⌘⇧N · ${openTab.database}.${openTab.tableName}（对照查看）`,
              badge: '命令',
            } as PaletteItem,
          ]
        : []),
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas, paletteOpen, openTab, groupStripeByTab, recentTables]);

  /**
   * V19：命令面板里的「按列分组着色」开关 —— 作用于【当前列】。
   *
   * 当前列取详情面板的激活格（cell）。App 层能拿到的"当前列"只有这一处
   * （网格的焦点列没有上抛），没有激活格时就退化为"关掉已开启的列"，
   * 不猜一个列去着色 —— 猜错的着色比不着色更误导。
   */
  const toggleGroupStripeCurrent = useCallback(() => {
    if (!openTab) {
      setToast('没有打开的表标签，无法按列分组着色');
      return;
    }
    const cur = groupStripeByTab[openTab.id] ?? null;
    const col = cell?.column ?? '';
    const target = col !== '' && col !== cur ? col : null;
    toggleGroupStripe(openTab.id, target);
    setToast(target ? `已按「${target}」分组着色（再执行一次关闭）` : '已关闭分组着色');
  }, [openTab, groupStripeByTab, cell, toggleGroupStripe]);

  /**
   * V23：把当前表在**新窗口**打开（对照查看）。
   *
   * 主进程负责建窗口（复用 createMainWindow，玻璃/交通灯/关闭守卫都带上），
   * 这里只需把三元组发过去。失败原因（如超过窗口数上限）由主进程给中文消息，
   * 直接 toast —— 绝不静默失败（点了没反应是本项目反复治理的缺陷形态）。
   */
  const openCurrentInNewWindow = useCallback(() => {
    if (!openTab) {
      setToast('没有打开的表标签，无法在新窗口打开');
      return;
    }
    // ⚠️ 刻意不在这里判 hasIpc()：demo 后端的 openWindowInNew 也会返回
    //    「需要桌面应用环境」的中文原因 —— 让失败原因只有一处口径，
    //    不留两套并行的环境判断（那种分叉最难保持一致）。
    void backend
      .openWindowInNew({ connId: openTab.connId, database: openTab.database, table: openTab.tableName })
      .then((r) => {
        setToast(r.ok ? `已在新窗口打开 ${openTab.database}.${openTab.tableName}` : (r.message ?? '新窗口创建失败'));
      })
      .catch((e) => setToast(`打开新窗口失败：${e instanceof Error ? e.message : String(e)}`));
  }, [openTab]);

  /**
   * V21：手动检查更新。
   *
   * 与启动期静默检查的区别：用户主动点了就**一定要有回执** ——
   * 哪怕结论是「开发模式不检查更新」，也要说出来，否则就是"点了没反应"。
   */
  const checkUpdate = useCallback(() => {
    // 同 openCurrentInNewWindow：环境判断交给后端（demo 后端也返回明确中文原因），
    // 这里不重复判 hasIpc()，避免两套口径分叉。
    setToast('正在检查更新…');
    void backend
      .appCheckUpdate()
      .then((r) => {
        // 有更新时主进程已弹原生对话框给「前往下载」，这里只补一条状态提示
        setToast(r.message);
      })
      .catch((e) => setToast(`检查更新失败：${e instanceof Error ? e.message : String(e)}`));
  }, []);

  const onPickTable = useCallback(
    (item: PaletteItem) => {
      setPaletteOpen(false);
      // V20 / V19：`cmd:` 前缀是动作条目，不能按「连接:库:表」拆
      if (item.id === 'cmd:openColumnFinder') {
        openColumnFinder();
        return;
      }
      if (item.id === 'cmd:toggleGroupStripe') {
        toggleGroupStripeCurrent();
        return;
      }
      if (item.id === 'cmd:openInNewWindow') {
        openCurrentInNewWindow();
        return;
      }
      const [connId, database, tableName] = item.id.split(':');
      if (connId && database && tableName) openTableTab(connId, database, tableName);
    },
    [openTableTab, openColumnFinder, toggleGroupStripeCurrent, openCurrentInNewWindow],
  );

  // ---- 命令面板：命令集 = 内置 + 片段（P1-3 最小版：列表 + 插入） ----
  const paletteCommands: CommandDef[] = useMemo(
    () => {
      const nameOf = new Map(connections.map((c) => [c.id, c.name]));
      return [...BUILTIN_COMMANDS, ...snippets.map((s) => snippetToCommand(s, nameOf.get(s.connectionId)))];
    },
    [snippets, connections],
  );

  /**
   * V4：命令面板 `refresh` 的真实副作用。
   *
   * 「刷新当前对象」的合理语义分两层：
   *  1. 有激活的表 tab → 重拉该表数据（与状态栏刷新同链路，keepSort/keepFilter）；
   *  2. 查询 tab / 无表 tab → 退化为刷新树 schema。
   * 两条都不是空操作 —— V4 治理的核心就是「能搜到的命令必须有可观测副作用」。
   */
  const refreshCurrent = useCallback(() => {
    if (openTab) {
      void loadTable(
        openTab.id,
        { connId: openTab.connId, database: openTab.database, tableName: openTab.tableName, table: openTab.table },
        { keepSort: true, sorts: openTab.sorts, filter: openTab.filter },
      );
      setToast(`已刷新 ${openTab.database}.${openTab.tableName}`);
      return;
    }
    void onRefreshSchemas();
  }, [openTab, loadTable, onRefreshSchemas]);

  /**
   * V4：命令面板 `toggleReadOnly` 的真实副作用。
   *
   * 只读是**连接级**配置（D6），作用对象 = 当前上下文连接（激活 tab 的连接，
   * 否则 sqlConnId）。切换后落盘（connSave 不回传密码）并刷新连接列表 ——
   * UI 置灰 + 主进程 AST 双层拦截都会随之生效。
   * ⚠️ 真正的安全层始终是主进程 core-sql-guard（红线 4），这里只是开关入口。
   */
  const toggleReadOnlyCurrent = useCallback(async () => {
    const connId = activeTab?.connId ?? sqlConnId;
    if (!connId) {
      setToast('没有可用于切换只读的连接');
      return;
    }
    const cfg = connections.find((c) => c.id === connId);
    if (!cfg) {
      setToast('找不到当前连接配置');
      return;
    }
    const next = !cfg.readOnly;
    try {
      await backend.connSave({ config: { ...cfg, readOnly: next } });
      await reloadConnections();
      setToast(`${cfg.name} 已${next ? '开启' : '关闭'}只读模式${next ? '（所有写操作将被主进程拦截）' : ''}`);
    } catch (e) {
      setToast(`切换只读失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [activeTab, sqlConnId, connections, reloadConnections]);

  const onPaletteCommand = useCallback(
    (action: string) => {
      setPaletteOpen(false);
      if (action === 'newConnection') setEditorState('new');
      else if (action === 'newQuery') openSql();
      else if (action === 'toggleTheme') cycleTheme();
      // V4：三条假命令治理 —— 全部接线到真实副作用
      else if (action === 'refresh') refreshCurrent();
      else if (action === 'toggleReadOnly') void toggleReadOnlyCurrent();
      else if (action === 'openPreferences') setPrefsOpen(true);
      // V21 / V23：应用维护与多窗口（与原生菜单同一动作，口径唯一）
      else if (action === 'checkUpdate') checkUpdate();
      else if (action === 'openInNewWindow') openCurrentInNewWindow();
      // F2 字体缩放（与原生菜单共用同一入口）
      else if (action === 'fontZoomIn') zoomStep('in');
      else if (action === 'fontZoomOut') zoomStep('out');
      else if (action === 'fontZoomReset') zoomStep('reset');
      /**
       * P1-15：命令面板的「筛选当前表」。
       * 与 ⌘⇧F / 原生菜单 / 工具栏按钮同一个 `openFilter` —— 不另写一套种子逻辑；
       * 没表标签时明确说一句，而不是静默无反应（V4「假命令治理」的口径）。
       */
      else if (action === 'filter') {
        if (openTab) openFilter();
        else setToast('筛选需要先打开一张表标签');
      }
      /**
       * 0.7.3（P0-19 第三入口）：命令面板「新建数据库」。
       * 目标连接按**当前上下文**推：树上选中的节点所属连接 > 激活标签的连接 > 第一个连接
       * （与「刷新当前对象」同一口径）。推不出来就明说，不静默无反应。
       */
      else if (action === 'createDatabase') {
        const cid = (activeKey ? parseTreeKeyContext(activeKey)?.connId : null) ?? sqlConnId;
        if (!cid) {
          setToast('还没有可用连接：先新建并连接一个连接');
          return;
        }
        void openCreateDb(cid);
      }
      else if (action.startsWith('snippet:')) {
        // T04/R06：按 (connectionId, database, name) 精确回查同名片段
        const s = findSnippetByAction(snippets, action);
        if (!s) {
          setToast('找不到该片段（可能已被删除或归属连接已变更）');
          return;
        }
        fillSqlToEditor(s.sql);
        setToast(s.database ? `已插入片段：${s.name}（${s.database}）` : `已插入片段：${s.name}`);
      } else setToast(`执行命令：${action}`);
    },
    [openSql, cycleTheme, snippets, fillSqlToEditor, zoomStep, refreshCurrent, toggleReadOnlyCurrent, checkUpdate, openCurrentInNewWindow, openFilter, openTab, activeKey, sqlConnId, openCreateDb],
  );

  // ---- F1 原生菜单命令订阅 ----
  // macOS 菜单加速键在菜单层拦截、页面 keydown 收不到 → 不会双重触发；
  // 既有 window keydown 处理保留，作纯浏览器 demo（无菜单）的兜底。
  // ⚠️ 通道名只能写字面量：渲染层不许 value-import shared 实现（S2 红线）。
  useEffect(() => {
    if (!hasIpc()) return;
    const off = window.dbStudio.on('event:menuCommand', (payload) => {
      const cmd = (payload as { command?: string } | null)?.command;
      if (!cmd) return;
      switch (cmd) {
        case 'new-connection': setEditorState('new'); break;
        case 'new-query': newQueryTab(); break;
        case 'close-tab': if (ws.activeId) requestCloseTab(ws.activeId); break;
        case 'open-palette': setPaletteOpen(true); break;
        case 'save': requestSaveActive(); break;
        /**
         * T19：数据菜单「新增空白行」。
         * 与工具栏/右键/⌥⌘N 共用 `onAddBlankRow` —— 菜单只负责把上下文送进来
         * （当前激活表标签的 source），不做第二套判定。
         */
        case 'grid-add-row': {
          // 菜单是 global scope（目录硬规则：局部动作不进原生菜单）⇒ 渲染层按上下文兜底
          if (!openTab) {
            setToast('新增空白行需要先打开一张表标签');
            break;
          }
          const s = sources.get(openTab.id);
          if (!s) {
            setToast('该表标签还没加载数据，暂时不能新增行');
            break;
          }
          onAddBlankRow(openTab.id, s);
          break;
        }
        case 'filter': openFilter(); break;
        case 'export':
          if (openTab) setExportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
          break;
        case 'import':
          // T14：原生菜单项此刻可能还没禁用（菜单动态可用性见 T15），渲染层先兜住
          if (openTab) {
            if (readOnlyConns[openTab.connId]) {
              setToast('该连接已标记为只读，不允许导入数据（写语句会被主进程 AST 守卫拦截）');
              break;
            }
            setImportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
          }
          break;
        case 'design-table':
          if (openTab) {
            if (readOnlyConns[openTab.connId]) {
              setToast('该连接已标记为只读，不允许改表结构（写语句会被主进程 AST 守卫拦截）');
              break;
            }
            setDesigner({ mode: 'edit', database: openTab.database, table: openTab.table });
          }
          break;
        case 'refresh-schema': void onRefreshSchemas(); break;
        case 'font-zoom-in': zoomStep('in'); break;
        case 'font-zoom-out': zoomStep('out'); break;
        case 'font-zoom-reset': zoomStep('reset'); break;
        case 'toggle-theme': cycleTheme(); break;
        case 'open-preferences': setPrefsOpen(true); break;
        case 'check-update': checkUpdate(); break;
        case 'open-in-new-window': openCurrentInNewWindow(); break;
        case 'next-tab': ws.cycle(1); break;
        case 'prev-tab': ws.cycle(-1); break;
      }
    });
    return off;
  }, [newQueryTab, requestCloseTab, ws, requestSaveActive, openFilter, onRefreshSchemas, cycleTheme, zoomStep, checkUpdate, openCurrentInNewWindow, onAddBlankRow, openTab, sources, readOnlyConns]);

  /**
   * ---- W 板块：答复主进程的关闭询问（原生红按钮 / 菜单「关闭窗口」）----
   *
   * 🔴 为什么要有这条链路：frame:false 窗口的红按钮是 macOS 原生控件，
   *    不产生 DOM 事件，⌘W 与标签 × 的那套拦截它绕得过去。这里把同一份
   *    beforeCloseTab 复用到窗口级，保证「有脏改动 → 一定先问」只有一处口径。
   *
   * 必须**每条询问都答复**：主进程等不到答复会走 3s 兜底强制关闭，
   * 那时就没有确认弹窗了。所以下面 try/catch 里失败也按「放行」答复，
   * 而不是沉默 —— 沉默等于把决定权交给兜底，比明确放行更糟。
   */
  useEffect(() => {
    if (!hasIpc()) return;
    const off = window.dbStudio.on('app:beforeCloseAsk', () => {
      let canClose = true;
      try {
        // 逐个脏标签确认，与 ⌘W / 标签 × 完全同口径
        for (const t of ws.tabs) {
          if (!beforeCloseTab(t)) {
            canClose = false;
            break;
          }
        }
      } catch {
        // 确认流程本身出错时不该把窗口锁死 —— 按放行处理，由主进程关闭
        canClose = true;
      }
      void window.dbStudio.replyBeforeClose(canClose).catch(() => {
        /* 答复失败主进程有兜底超时，这里不再处理 */
      });
    });
    return off;
  }, [ws.tabs, beforeCloseTab]);

  // ---- 状态栏：跟随激活 tab ----
  const statusSource = openTab ? sources.get(openTab.id) ?? null : null;
  /**
   * 🔴 T14：「有定位键」（结构可定位）与「当前可写」（再叠加连接只读）**分开表达**。
   * 原来只有一个 `statusEditable`，让人以为「可编辑=能写库」，只读连接下会误导。
   * 判定与 TablePane 共用 `resolveEditability()` —— 两处各写一遍必然漂移。
   */
  const statusConnReadOnly = openTab ? readOnlyConns[openTab.connId] === true : false;
  const statusEdit = resolveEditability(openTab?.table ?? null, statusConnReadOnly);
  const statusLocatable = statusEdit.locatable;
  const statusWritable = statusEdit.writable;
  /** 无激活表时不显示任何原因（否则 title 会挂一句与现状无关的话） */
  const statusReadOnlyReason = openTab ? statusEdit.message : '';
  const statusStrategy = openTab ? locateStrategy(openTab.table) : 'none';

  // ---- T46：活动区身份条（连接 / 环境 / 库 / 对象） ----
  /**
   * 🔴 身份条必须**常驻**且不依赖左树红点：侧栏可被收窄、详情面板可能跟随
   *    另一个选中对象。同名库/同名表跨连接时，这是唯一固定的上下文来源。
   */
  const identity = (() => {
    const act = ws.active;
    if (!act) return null;
    const connId = act.kind === 'table' ? act.connId : act.connId ?? '';
    const conn = connections.find((c) => c.id === connId) ?? null;
    if (act.kind === 'table') {
      return resolveIdentity({
        connId: act.connId,
        database: act.database,
        object: act.tableName,
        kind: act.table.kind === 'view' ? 'view' : 'table',
        conn,
      });
    }
    return resolveIdentity({
      connId,
      database: act.database ?? '',
      object: act.title || '查询',
      kind: 'query',
      conn,
    });
  })();
  /** T46：保存按钮的文案/可用性（脏计数直接进按钮文案） */
  const saveBtn = saveButton({
    dirtyCount: statusSource?.dirtyCount ?? 0,
    writable: statusWritable && !!openTab,
    readOnlyReason: statusReadOnlyReason || (openTab ? '' : '当前没有打开表标签'),
  });

  // ---- A14：大表行数估算（information_schema，绝不做全表 COUNT）----
  // 状态栏显示「约 N 行」；失败（权限/视图）静默降级为不显示
  const [rowsEstimate, setRowsEstimate] = useState<{ key: string; rows: number | null } | null>(null);
  const estimateKey = openTab ? `${openTab.connId}:${openTab.database}:${openTab.tableName}` : null;
  useEffect(() => {
    if (!openTab || !estimateKey) {
      setRowsEstimate(null);
      return;
    }
    let alive = true;
    void backend
      .schemaGetTableInfo({ connId: openTab.connId, database: openTab.database, table: openTab.tableName })
      .then((info) => {
        if (alive) setRowsEstimate({ key: estimateKey, rows: info.rowsEstimate });
      })
      .catch(() => {
        if (alive) setRowsEstimate({ key: estimateKey, rows: null });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey]);

  // F5：切标签时清掉上一个 tab 的选中统计（只有激活 pane 会回报，不清会挂旧值）
  useEffect(() => {
    setSelectionSummary(null);
  }, [ws.activeId]);

  // ---------- 渲染 ----------
  const envTag = hasIpc() ? 'IPC' : 'DEMO';

  /**
   * T46：工具栏密度按**可用宽度**判定（侧栏/详情面板可拖动，窗口宽度不足以代表）。
   * 首次测量前按 full 处理 —— 否则进页面会先闪一下「更多」。
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarW, setToolbarW] = useState(0);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setToolbarW((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const density = toolbarDensity(toolbarW);
  /** T46：紧凑模式「更多」菜单开合 */
  const [moreOpen, setMoreOpen] = useState(false);
  // 密度回到 full 时把更多菜单收起，避免它挂在看不见的按钮上
  useEffect(() => {
    if (density === 'full') setMoreOpen(false);
  }, [density]);

  /**
   * T47：行数口径 —— 精确 / 估算 / 截断分三档（报告 §8.2 第 4 条）。
   * 过去只有一个「约 N 行」，用户会拿估算值判断「导出是不是全量」。
   */
  const statusRowCount = rowCountBasis({
    rowCount: openTab?.payload?.rowCount ?? 0,
    estimated: rowsEstimate?.key === estimateKey ? rowsEstimate.rows : null,
    truncated: openTab?.truncated ?? false,
    hasPayload: !!openTab?.payload,
  });
  /** T47：连接不可用的判定（idle 未连接不算断开，只有这四态才提示） */
  const connDown = (connId: string): boolean => {
    const s = connStates[connId]?.state;
    return s === 'disconnected' || s === 'closed' || s === 'failed';
  };
  const tableTabs = ws.tabs.filter((t): t is TableTabState => t.kind === 'table');
  /** P2-18f：connId → 连接名（标签条用它给同名表加区分标识） */
  const connNameById = useMemo(
    () => Object.fromEntries(connections.map((c) => [c.id, c.name])),
    [connections],
  );
  /**
   * P0-4：设计器的目标连接（危险确认必须用它，不能用 activeTab）。
   * 三重兜底：显式带 connId → 激活表标签的连接 → 含该库的第一个连接。
   */
  const designerConnId =
    designer?.connId ??
    openTab?.connId ??
    (designer
      ? connections.find((c) => (schemas[c.id] ?? []).some((d) => d.name === designer.database))?.id
      : undefined) ??
    '';

  /**
   * P0-5：这次保存预演是否需要「输表名」第三层。
   * 生产连接 + 删行/无 WHERE 更新 → 表名；否则 null（普通预览）。
   */
  const previewGateText = useMemo(() => {
    if (!preview) return null;
    const t = ws.getTable(preview.tabId);
    if (!t) return null;
    const isProduction = connections.find((c) => c.id === t.connId)?.colorTag === 'red';
    return previewRequiresText(preview.statements, { isProduction, tableName: t.tableName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, ws, connections]);

  return (
    <div
      className="app"
      style={{ '--sidebar-w': `${layout.sidebarW}px`, '--detail-w': `${layout.detailW}px` } as React.CSSProperties}
    >
      <aside className="sidebar">
        <div className="sidebar-head">
          {/* W4：交通灯的 no-drag 命中区（透明，仅用于把 hover/click 让给原生按钮） */}
          <div className="traffic-light-safe" aria-hidden="true" data-testid="traffic-light-safe" />
          <span className="sidebar-title">连接</span>
          <span className="spacer" />
          <button
            className="sidebar-btn"
            onClick={() => void onRefreshSchemas()}
            title="刷新结构：重建表/视图清单（不动表里的数据）"
            data-testid="btn-refresh-schema"
          >
            <IconRefresh size={11} />
          </button>
          <button
            className="sidebar-btn"
            onClick={() => setEditorState('new')}
            title="新建连接"
            data-testid="btn-new-connection"
          >
            <IconPlus size={11} />
          </button>
        </div>

        {booting ? (
          <div className="tree-empty">加载连接…</div>
        ) : connections.length === 0 ? (
          <div className="tree-empty">
            {bootError ? `连接列表加载失败：${bootError}` : '还没有连接。'}
            <button className="sidebar-btn wide" onClick={() => setEditorState('new')}>
              新建连接
            </button>
            {/* P2-18j：换新机时第一个动作往往不是"新建"而是"把旧机器的搬过来" ——
                所以导入入口必须出现在空态里，不能只藏在右键菜单（没有连接可右键） */}
            <button
              className="sidebar-btn wide"
              data-testid="btn-import-connections"
              onClick={() => void onImportConnections()}
            >
              导入连接…
            </button>
          </div>
        ) : (
          <TreeView
            roots={treeRoots}
            expanded={expanded}
            onExpandedChange={setExpanded}
            activeKey={activeKey}
            onOpenObject={onOpenObject}
            onSelectNode={(n) => {
              setActiveKey(n.key);
              // 0.7.1：只有"库/类别/连接"这类选择才改清单作用域；
              // 选中具体表（obj:...）时清单内容保持不动，只是那一行被高亮
              if (n.kind !== 'object') setObScopeKey(n.key);
            }}
            columnIndex={columnIndex}
            onOpenTableRef={onOpenTableRef}
            connStates={connStates}
            onToggleConnection={onToggleConnectionNode}
            onEditConnection={(cfg) => setEditorState({ config: cfg, duplicateOf: null })}
            onDeleteConnection={(cfg) => void onDeleteConnection(cfg)}
            onNodeContextMenu={openNodeMenu}
            onBackgroundContextMenu={openTreeBackgroundMenu}
            // C2/C3/C5/C6：查看定义、收藏 toast、F2 重命名（0.7.3 起名副其实）、⇧F2 设计器、Del 删除
            onShowDefinition={(req) => void onShowDefinition(req)}
            onToast={setToast}
            onRenameRequest={(req) => setRenameTable({ connId: req.connId, database: req.database, table: req.table })}
            onDesignRequest={(req) => setDesigner({ mode: 'edit', database: req.database, table: req.table, connId: req.connId })}
            onDeleteRequest={(req) => void onTableDestructive('drop', req.connId, req.database, req.table)}
            // v0.6.0：多选集合回传（批量删除在宿主侧弹危险确认后执行）
            onSelectionChange={setTreeSelection}
            // T03/R03：库行「新建表」显式带 connId（树节点 key 里的），不再用
            // 「第一个含同名库的连接」反查 —— 两个连接都有 order_db 时会串环境。
            onNewTable={(database, connId) => {
              if (!connId) {
                setToast('找不到该库所属的连接，无法新建表');
                return;
              }
              setDesigner({ mode: 'new', database, table: null, connId });
            }}
            // 0.7.3（P0-19）：连接行内的「+ 库」（与库行「+ 表」对称）
            onNewDatabase={(connId) => void openCreateDb(connId)}
          />
        )}
      </aside>

      <PanelResizer title="拖动调整侧栏宽度" onDrag={(dx) => setLayout((l) => ({ ...l, sidebarW: clampW(l.sidebarW + dx, SIDEBAR_W.min, SIDEBAR_W.max) }))} onDragEnd={persistLayout} />

      <main className="workspace">
        <WorkspaceTabsBar
          tabs={ws.tabs}
          activeId={ws.activeId}
          onSelect={ws.activate}
          onClose={requestCloseTab}
          onNewQuery={newQueryTab}
          onBeforeClose={beforeCloseTab}
          readOnlyConns={readOnlyConns}
          // T27：标签右键菜单的三个宿主能力
          // 1) 批量关闭：已经过「一次性列出全部脏标签」的确认，不再逐个问
          onCloseBatch={(ids) => {
            for (const id of ids) ws.closeTab(id);
          }}
          // 2) 在树中定位：选中该节点并展开它的祖先链（组/连接/库/类别）
          onRevealInTree={(key) => {
            setActiveKey(key);
            // 0.7.1：与树单击同一口径 —— 定位到库/类别时才同步清单作用域；
            // 定位到具体表时清单不动（否则"在树中定位一张表"会把中间清单也换掉）
            const hit = findTreeNode(treeRoots, key);
            if (hit && hit.kind !== 'object') setObScopeKey(key);
            setExpanded((prev) => expandAncestors(prev, treeRoots, key));
          }}
          onToast={setToast}
          // P1-7：拖拽排序 / 固定（顺序与固定标记都归 ws，App 不持有第二份）
          onMoveTab={ws.moveTab}
          onTogglePin={ws.togglePin}
          // P2-18f：同名表标签用连接名区分
          connLabels={connNameById}
          // P1-16：浏览对象视图开关（中间面板与标签页二选一显示）
          browseToggle={{
            active: browseMode,
            onToggle: () => setBrowseMode((v) => !v),
            // 没有连接时清单必然是空的，开关没有意义 —— 直接禁用并说明原因
            disabled: connections.length === 0,
            disabledReason: '还没有连接：连上数据库后才能浏览对象',
          }}
        />

        <div className="toolbar" ref={toolbarRef} data-density={density} data-more={moreOpen ? '1' : '0'}>
          {/* T46：身份条 —— 连接 / 环境 / 库 / 对象，四段常驻，永不折叠 */}
          {identity ? (
            <div className="tb-identity" data-testid="toolbar-identity" title={identity.ariaLabel} aria-label={identity.ariaLabel}>
              <span className="tb-id-conn" data-testid="identity-conn">
                {identity.connName}
              </span>
              <span className="tb-id-sep" aria-hidden="true">
                /
              </span>
              <span className="tb-id-env" data-testid="identity-env" data-tone={identity.envTone}>
                {identity.envLabel}
              </span>
              <span className="tb-id-sep" aria-hidden="true">
                /
              </span>
              <span className="tb-id-db" data-testid="identity-db">
                {identity.database}
              </span>
              <span className="tb-id-sep" aria-hidden="true">
                /
              </span>
              <span className="tb-id-object" data-testid="identity-object" data-kind={identity.objectKindLabel}>
                {identity.object}
              </span>
            </div>
          ) : (
            <span className="tb-id-empty" data-testid="toolbar-identity-empty">
              未打开表
            </span>
          )}
          <button onClick={() => setPaletteOpen(true)}>
            <IconSearch size={11} />
            命令面板 ⌘K
          </button>
          <button onClick={openSql} title="新建查询标签（⌘T）" data-testid="btn-new-query">
            <IconTerminal size={11} />
            查询 ⌘T
          </button>
          {openTab ? (
            <>
              <button
                onClick={() => {
                  const s = sources.get(openTab.id);
                  if (s) onRequestSave(openTab.id, s);
                }}
                className={saveBtn.pending ? 'primary' : undefined}
                disabled={saveBtn.disabled}
                title={saveBtn.title}
                data-testid="btn-save"
                data-pending={saveBtn.pending ? '1' : '0'}
              >
                <IconSave size={11} />
                {saveBtn.text}
              </button>
              {/* T46：刷新数据（重跑当前条件）与刷新结构（重建表清单）分开命名 */}
              <button
                onClick={() => void reloadTableData(openTab.id)}
                title="刷新数据：按当前排序与筛选重新查询（不动表结构）"
                data-testid="btn-refresh-data"
              >
                <IconRefresh size={11} />
                刷新数据
              </button>
              <button
                onClick={openFilter}
                data-testid="btn-filter"
                // P1-15：把键位写在 tooltip 上 —— 键位存在但没人知道等于不存在
                title="筛选：按列加条件，可临时停用某条（⌘⇧F）"
              >
                <IconFilter size={11} />
                筛选{filterCount > 0 ? ` (${filterCount})` : ''}
              </button>
              {isCollapsed(density, 'export') ? null : (
                <button
                  onClick={() =>
                    setExportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table })
                  }
                  title="导出当前表（含筛选）"
                  data-testid="btn-export"
                >
                  <IconExport size={11} />
                  导出
                </button>
              )}
              {isCollapsed(density, 'import') ? null : (
                <button
                  onClick={() =>
                    setImportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table })
                  }
                  // T14：只读连接不带导入入口 —— 禁用 + 说明原因，而不是让用户走完向导才报错
                  disabled={statusConnReadOnly}
                  title={
                    statusConnReadOnly
                      ? '该连接已标记为只读，不允许导入数据（写语句会被主进程 AST 守卫拦截）'
                      : '从 CSV/Excel 导入（追加 INSERT）'
                  }
                  data-testid="btn-import"
                >
                  <IconImport size={11} />
                  导入
                </button>
              )}
              {isCollapsed(density, 'design') ? null : (
                <button
                  onClick={() => setDesigner({ mode: 'edit', database: openTab.database, table: openTab.table })}
                  disabled={openTab.table.kind === 'view'}
                  title={openTab.table.kind === 'view' ? '视图不可结构编辑' : '设计表结构（字段/索引/外键）'}
                  data-testid="btn-design"
                >
                  <IconDesign size={11} />
                  设计
                </button>
              )}
              {isCollapsed(density, 'paste') ? null : (
                <button onClick={() => void onPasteRows()} title="从剪贴板粘贴多行（D2）">
                  <IconPaste size={11} />
                  粘贴
                </button>
              )}
              {/* T46：窄屏时低频操作收进「更多」，核心项（身份/保存/筛选）永不折叠 */}
              {density === 'compact' ? (
                <div className="tb-more">
                  <button
                    onClick={() => setMoreOpen((v) => !v)}
                    title="更多操作"
                    data-testid="btn-more"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                  >
                    更多 ▾
                  </button>
                  {moreOpen ? (
                    <div className="tb-more-pop" role="menu" data-testid="tb-more-pop">
                      <button
                        role="menuitem"
                        data-testid="more-export"
                        onClick={() => {
                          setMoreOpen(false);
                          setExportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
                        }}
                      >
                        导出…
                      </button>
                      <button
                        role="menuitem"
                        data-testid="more-import"
                        disabled={statusConnReadOnly}
                        title={statusConnReadOnly ? '该连接已标记为只读，不允许导入数据' : undefined}
                        onClick={() => {
                          setMoreOpen(false);
                          setImportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
                        }}
                      >
                        导入…
                      </button>
                      <button
                        role="menuitem"
                        data-testid="more-design"
                        disabled={openTab.table.kind === 'view'}
                        title={openTab.table.kind === 'view' ? '视图不可结构编辑' : undefined}
                        onClick={() => {
                          setMoreOpen(false);
                          setDesigner({ mode: 'edit', database: openTab.database, table: openTab.table });
                        }}
                      >
                        设计表…
                      </button>
                      <button
                        role="menuitem"
                        data-testid="more-paste"
                        onClick={() => {
                          setMoreOpen(false);
                          void onPasteRows();
                        }}
                      >
                        粘贴多行
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <select
            value={rowHeightMode}
            onChange={(e) => setRowHeightMode(e.target.value as RowHeightMode)}
            title="行高"
          >
            <option value="compact">紧凑 24px</option>
            <option value="standard">标准 28px</option>
            <option value="loose">宽松 32px</option>
          </select>
          <select
            value={themeMode}
            onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
            title="外观（跟随系统 / 浅色 / 深色）"
            data-testid="theme-select"
          >
            <option value="system">外观：跟随系统</option>
            <option value="light">外观：浅色</option>
            <option value="dark">外观：深色</option>
          </select>
          {openTab ? (
            <span style={{ color: 'var(--text-dim)' }} data-testid="toolbar-locate-strategy">
              定位策略：
              {statusStrategy === 'none' ? '无（只读）' : statusStrategy === 'pk' ? '主键' : '唯一键'}
            </span>
          ) : null}
          <span className="spacer" />
          {openTab?.queryMs != null ? (
            <span
              style={{ color: 'var(--text-dim)' }}
              data-testid="toolbar-row-count"
              data-basis={statusRowCount.basis}
              title={statusRowCount.exact ? '精确行数' : '非精确：估算值或被行上限截断'}
            >
              {statusRowCount.label} / {openTab.queryMs}ms
            </span>
          ) : null}
          <span className="env-tag">{envTag}</span>
        </div>

        {/* 🔴 所有 pane 常挂 DOM，靠 .hidden 隐藏 —— 保留编辑器实例 / 脏标记 / 滚动位置 */}
        {/* P1-16：浏览对象视图接管中间面板时，pane 整体让位（DOM 仍在，只是不显示） */}
        {tableTabs.map((t) => (
          <TablePane
            key={t.id}
            tab={t}
            active={!browseMode && ws.activeId === t.id}
            source={sources.get(t.id) ?? null}
            rowHeightMode={rowHeightMode}
            handlers={tablePaneHandlers}
            // V9：外键清单（App 层按表缓存；未拉到 = undefined，网格不画链接）
            foreignKeys={fkCache[`${t.connId}:${t.database}:${t.tableName}`]}
            // V10/V13：连接级只读 → 表达式模式与批量条禁用并给原因
            readOnly={readOnlyConns[t.connId] === true}
            // V22：截断提示条。truncated 来自最近一次 loadTable 的返回；
            // rowLimit 与实际请求的 limit 同源（见 loadTable / loadMoreRows）
            truncated={t.truncated}
            // A14：估算行数只算激活 tab（effect 按 estimateKey 走），非激活 pane 传 null
            estimatedRows={rowsEstimate?.key === estimateKey ? rowsEstimate.rows : null}
            rowLimit={rowLimits[t.id] ?? TABLE_PAGE_LIMIT}
            onLoadMore={loadMoreRows}
            // T47：连接不可用时空白区说「已断开」而不是「零行」
            disconnected={connDown(t.connId)}
            onReload={reloadTableData}
            // T38：撤销/重做（栈按 tab 一个，按钮可用状态随 rerender 刷新）
            canUndo={editHistoryRef.current.get(t.id)?.canUndo ?? false}
            canRedo={editHistoryRef.current.get(t.id)?.canRedo ?? false}
            onUndo={undoEdit}
            onRedo={redoEdit}
            // V19：分组条纹（状态在 App，默认关闭）
            groupStripeColumn={groupStripeByTab[t.id] ?? null}
            onToggleGroupStripe={toggleGroupStripe}
          />
        ))}

        {ws.tabs.map((t) =>
          t.kind === 'query' ? (
            <div
              key={t.id}
              className={`ws-tab-pane${!browseMode && ws.activeId === t.id ? '' : ' hidden'}`}
              data-testid={`pane-${t.id}`}
              data-tab-id={t.id}
            >
              <Suspense fallback={<div className="sql-loading">编辑器载入中…</div>}>
                <SqlEditorPanel
                  connId={t.connId ?? sqlConnId}
                  database={t.database ?? openTab?.database ?? null}
                  databases={t.connId ? (schemas[t.connId] ?? []) : sqlDatabases}
                  onDatabaseChange={(db) => ws.patchQuery(t.id, { database: db })}
                  initialSql={t.initialSql}
                  onRun={onRunSql}
                  onCancel={onCancelSql}
                  onToast={setToast}
                  readOnlyConn={readOnlyConn}
                  registerInjector={registerInjectorWithPending}
                  injectorKey={t.id}
                  // T12：⌘S 在查询标签下直达「保存为片段」（0 = 无请求，挂载不弹窗）
                  snippetSaveSignal={snippetReq?.tabId === t.id ? snippetReq.n : 0}
                  // B7：查询结果一键导出（sql/columns 由编辑器面板回传）
                  onExportResult={(req) => {
                    const cid = t.connId ?? sqlConnId;
                    if (!cid) {
                      setToast('找不到导出所需的连接上下文');
                      return;
                    }
                    setExportTarget({
                      connId: cid,
                      database: req.database ?? t.database ?? openTab?.database ?? '',
                      table: null,
                      sql: req.sql,
                      columns: req.columns,
                      // P0-1：结果网格的选区/已加载行（快照范围用），点击那一刻取的
                      snapshot: req.snapshot,
                    });
                  }}
                  // A12/T39：单表 SELECT 结果 → 打开**源表**（文案不再暗示继承查询条件）；
                  // 带上结果行的主键/唯一键值做安全定位，无键则如实说明不猜行身份
                  onOpenEditableResult={(req) => {
                    openTableTab(req.connId, req.database, req.table, req.locate);
                  }}
                />
              </Suspense>
            </div>
          ) : null,
        )}

        {browseMode || ws.tabs.length === 0 ? (
          connections.length > 0 ? (
            /**
             * v0.6.0：中间面板跟随左侧树（用户拍板：空态时显示对象清单）。
             *
             * 有连接但没开标签时，旧的 EmptyState 只给三张快捷入口卡 ——
             * 中间大片留白，而用户真正想做的事（看这个库有哪些表）只能去左树里数。
             * 有连接就展示清单；一个连接都没有时才保留"新建连接"引导
             * （那种情况下清单必然是空的，显示它没有意义）。
             */
            <ObjectBrowser
              roots={treeRoots}
              /* 作用域用 obScopeKey（只由树驱动），高亮用 activeKey（树与清单共用） */
              activeKey={obScopeKey}
              selectedKey={activeKey}
              onSelectObject={(node) => setActiveKey(node.key)}
              onOpenObject={onOpenObject}
              findByKey={findTreeNode}
              /* 0.7.3 P1-23：右键转手宿主分级菜单 —— 权限/只读/生产危险项一份实现 */
              onNodeContextMenu={(node, x, y) => openNodeMenu(node, x, y)}
            />
          ) : (
            <EmptyState
              hasConnections={false}
              onNewConnection={() => setEditorState('new')}
              onOpenPalette={() => setPaletteOpen(true)}
              onNewQuery={newQueryTab}
            />
          )
        ) : null}

        {toast ? (
          /**
           * P1-11：分级 toast。
           *  - ok：绿色、3.5s 自动消失（成功不需要用户确认）
           *  - warn / error：常驻 + ✕ 手动关闭（错误是排查现场的唯一线索）
           * 点正文仍复制全文（V 系列保留的亮点）。
           */
          <div
            className={toastClass(toast.tone)}
            data-testid="toast"
            data-tone={toast.tone}
            title="点击复制错误信息"
            onClick={() => {
              void navigator.clipboard?.writeText(toast.text).catch(() => undefined);
              setToast('已复制错误信息到剪贴板', 'ok');
            }}
          >
            <span className="toast-text">{toast.text}</span>
            <button
              type="button"
              className="toast-close"
              data-testid="toast-close"
              title="关闭提示"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast();
              }}
            >
              <IconXSmall size={10} />
            </button>
          </div>
        ) : null}

        {/* D1：意外断线/连接失败横幅（自动重连推送在主进程侧接线） */}
        <ConnStateBanner
          connections={connections}
          connStates={connStates}
          onReconnect={(cfg) => {
            if (cfg.promptEveryTime) setPwdPrompt(cfg);
            else void onConnectNode(cfg);
          }}
          onDismiss={() => undefined}
        />

        {/* e2e 可观测性：状态栏的「归属连接 / 是否只读判定为真 / 脏计数」——
            「连接只读但界面没禁用」这类缺陷靠肉眼分不清，必须能直接读到判定输入；
            脏计数同理：断言不该去正则解析「脏单元格：N」这种文案（T19） */}
        <div
          className="statusbar"
          data-conn-id={openTab?.connId ?? ''}
          data-conn-readonly={statusConnReadOnly ? '1' : '0'}
          data-dirty-count={statusSource?.dirtyCount ?? 0}
          /**
           * T38：脏格的**坐标**（row:col,row:col）。
           *
           * 撤销/重做断言只读计数时，两种完全不同的缺陷会得出同一个数：
           *  · 「撤销清错了格」→ 计数不变；
           *  · 「撤销后另一格被重新标脏」→ 计数也不变。
           * 坐标能把它们分开（本次 e2e 就是靠它定性的）。
           */
          data-dirty-cells={(statusSource?.dirtyCells() ?? []).map((c) => `${c.row}:${c.col}`).join(',')}
        >
          <span>标签：{ws.tabs.length}</span>
          <span>脏单元格：{statusSource?.dirtyCount ?? 0}</span>
          {/* T14：两项分开 —— 有定位键 ≠ 当前可写 */}
          <span title={statusLocatable ? '有主键/唯一键，可安全定位到行' : '该表没有主键/唯一键，无法安全定位行'}>
            定位键：{statusLocatable ? '有' : '无'}
          </span>
          <span title={statusReadOnlyReason || undefined} data-testid="status-writable">
            可写：{openTab ? (statusWritable ? '是' : '否') : '—'}
            {!openTab || statusWritable ? '' : `（${statusConnReadOnly ? '只读连接' : '无定位键'}）`}
          </span>
          <span>排序：{openTab?.sorts.map((s) => `${s.column} ${s.direction}`).join(', ') || '无'}</span>
          {selectionSummary ? <span>选中 {selectionSummary.rows} 行 / {selectionSummary.cells} 格</span> : null}
          {statusRowCount.basis !== 'none' ? (
            <span
              data-testid="status-row-count"
              data-basis={statusRowCount.basis}
              title={
                statusRowCount.exact
                  ? '精确行数：当前已加载的行全部来自结果集'
                  : statusRowCount.basis === 'truncated'
                    ? '已被行上限截断：这不是全表总数'
                    : 'information_schema 估算值，不做全表 COUNT'
              }
            >
              {statusRowCount.label}
            </span>
          ) : null}
          {filterCount > 0 ? <span>筛选：{filterCount} 条</span> : null}
          {sqlConnId ? <span>连接：{connStateLabel(connStates[sqlConnId])}</span> : null}
        </div>
      </main>

      {!detailCollapsed ? (
        <PanelResizer
          title="拖动调整详情面板宽度"
          onDrag={(dx) => setLayout((l) => ({ ...l, detailW: clampW(l.detailW - dx, DETAIL_W.min, DETAIL_W.max) }))}
          onDragEnd={persistLayout}
        />
      ) : null}

      <DetailPanel
        table={detailTable}
        database={detailDatabase}
        connId={detailConnId}
        collapsed={detailCollapsed}
        onToggle={() => setDetailCollapsed((v) => !v)}
        onToast={setToast}
      />

      {cellModal ? (
        <CellValueModal
          cell={cellModal}
          table={cellModal.table}
          database={cellModal.database}
          onClose={() => setCellModal(null)}
          onToast={setToast}
          // T31：脏格待提交值（undefined = 无脏格，弹窗如实说明展示的是库中原值）
          pending={cellModal.pending}
          // T32：可写表才有「编辑」入口；提交走与 onCellEdited 相同的 setDirty 链路
          editable={cellModal.editable}
          onCommitDraft={(text) => onCellModalCommitDraft(cellModal.tabId, cellModal.row, cellModal.col, text)}
        />
      ) : null}

      {pwdPrompt ? (
        <PasswordPromptModal
          cfg={pwdPrompt}
          onCancel={() => {
            pendingAfterConnectRef.current = null;
            setPwdPrompt(null);
          }}
          onSubmit={(pwd) => {
            const cfg = pwdPrompt;
            const after = pendingAfterConnectRef.current;
            pendingAfterConnectRef.current = null;
            setPwdPrompt(null);
            void (async () => {
              const ok = await onConnectNode(cfg, pwd);
              if (ok && after) after();
            })();
          }}
        />
      ) : null}

      {ctxMenu ? <TreeContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} /> : null}

      {prefsOpen ? (
        <Suspense fallback={null}>
          <PreferencesPanel
            themeMode={themeMode}
            onThemeMode={setThemeMode}
            fontZoom={fontZoom}
            onFontZoom={zoomStep}
            prefs={prefs}
            onPrefs={patchPrefs}
            onClose={() => setPrefsOpen(false)}
          />
        </Suspense>
      ) : null}

      {dirtyGuard ? (
        <Suspense fallback={null}>
          <DirtyReloadModal
            title={dirtyGuard.title}
            count={dirtyGuard.count}
            onResolve={onDirtyGuardResolve}
          />
        </Suspense>
      ) : null}

      {saveConflict ? (
        <Suspense fallback={null}>
          <SaveConflictModal
            conflicts={saveConflict.conflicts}
            totalStatements={saveConflict.totalStatements}
            pendingCount={saveConflict.pendingCount}
            onProbe={probeConflictRow}
            onClose={() => setSaveConflict(null)}
          />
        </Suspense>
      ) : null}

      {preview ? (
        <SavePreviewModal
          statements={preview.statements}
          rejected={preview.rejected}
          requireText={previewGateText}
          onCancel={() => {
            // T01：预演被取消 = 保存没发生，把守卫登记的回滚补上（列头/筛选退回原样）
            dirtyGuardRollbackRef.current?.run();
            dirtyGuardRollbackRef.current = null;
            setPreview(null);
          }}
          onConfirm={() => void onConfirmSave()}
        />
      ) : null}

      {filterOpen && openTab && filterDraft ? (
        <div className="modal-mask" onClick={closeFilter}>
          <div className="modal filter-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              筛选 — {openTab.database}.{openTab.tableName}
            </header>
            <div className="body">
              <FilterBuilder
                model={filterDraft}
                onChange={setFilterDraft}
                columns={filterableColumns(openTab.table)}
                // V18：方案按表持久化（三元组 → tableKey），保存失败的原因经 toast 出来
                connId={openTab.connId}
                database={openTab.database}
                table={openTab.tableName}
                onToast={setToast}
              />
            </div>
            <footer>
              <button onClick={clearFilter}>清除</button>
              <span className="spacer" />
              {/* 🔴 「取消」必须丢弃草稿 —— 否则徽标会显示一个从未生效的筛选数 */}
              <button onClick={closeFilter} data-testid="btn-filter-cancel">
                取消
              </button>
              <button className="primary" onClick={applyFilter} data-testid="btn-filter-apply">
                应用
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {finderOpen && openTab ? (
        /**
         * V20：列快速定位浮层。
         *
         * 🔴 onPick 这里是**降级实现**：DataGrid 没有暴露「滚动到某列」的 API
         *    （scrollLeft 归网格内部所有，也没有 ref / imperative handle），
         *    所以选中列只能回一句 toast 告诉用户列名。改 DataGrid 不在本次范围
         *    （grid/** 已交付），与其为了滚动去动已交付的组件，先保证入口可达。
         */
        <ColumnQuickFinder
          columns={openTab.table.columns}
          onPick={(col) => {
            setFinderOpen(false);
            setToast(`已定位到列「${col.name}」（${col.dataType}）—— 网格暂未开放"滚动到列"，请横向滚动查看`);
          }}
          onClose={() => setFinderOpen(false)}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          items={paletteItems}
          historySource={historySource}
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
          onPickTable={onPickTable}
          onPickHistory={(it) => {
            setPaletteOpen(false);
            const sql = (it as PaletteItem & { sql?: string }).sql ?? '';
            if (!sql) {
              setToast('这条历史没有 SQL 原文');
              return;
            }
            fillSqlToEditor(sql);
            setToast(`已回填历史到查询标签：${it.title.slice(0, 40)}`);
          }}
          onDeleteHistory={(it) => void onDeleteHistory(it)}
          onToggleHistoryStar={(it, starred) => void onToggleHistoryStar(it, starred)}
          historyReloadKey={historyReload}
          onCommand={onPaletteCommand}
        />
      ) : null}

      {editorState !== 'closed' ? (
        <Suspense fallback={<div className="sql-loading">连接编辑器载入中…</div>}>
          <ConnectionEditor
            editing={editorTarget}
            /* P1-8：非空 = 创建副本（保存为新建 + 密文沿用源连接） */
            duplicateOf={editorDuplicateOf}
            onCancel={closeEditor}
            onSave={onSaveConnection}
            onTest={onTestConnection}
            onPickKeyFile={onPickPrivateKey}
            onConnect={(cfg) => {
              if (cfg.promptEveryTime) setPwdPrompt(cfg);
              else void onConnectNode(cfg);
            }}
          />
        </Suspense>
      ) : null}

      {exportTarget ? (
        <Suspense fallback={<div className="sql-loading">导出面板载入中…</div>}>
          <ExportModal
            backend={backend}
            connId={exportTarget.connId}
            database={exportTarget.database}
            table={exportTarget.table}
            sql={exportTarget.sql ?? null}
            columns={exportTarget.columns ?? null}
            /* P0-1：选区 / 当前已加载 / 仅可见列 都靠这只快照源；null = 没有网格上下文 */
            snapshot={exportSnapshot}
            /* 树右键导出的表可能未在网格打开（无筛选状态）；当前表 tab 正好是它时带筛选 */
            filter={
              openTab &&
              exportTarget.table &&
              openTab.connId === exportTarget.connId &&
              openTab.database === exportTarget.database &&
              openTab.tableName === exportTarget.table.name &&
              filterCount > 0
                ? appliedFilter
                : null
            }
            onClose={() => setExportTarget(null)}
            onToast={setToast}
          />
        </Suspense>
      ) : null}

      {importTarget ? (
        <Suspense fallback={<div className="sql-loading">导入向导载入中…</div>}>
          <ImportWizard
            backend={backend}
            connId={importTarget.connId}
            database={importTarget.database}
            table={importTarget.table}
            onClose={() => setImportTarget(null)}
            onToast={setToast}
            onImported={() => {
              // 该表已有打开的 tab → 重拉数据；否则只更新 schema（树计数）
              const t = ws.tabs.find(
                (x): x is TableTabState =>
                  x.kind === 'table' &&
                  x.connId === importTarget.connId &&
                  x.database === importTarget.database &&
                  x.tableName === importTarget.table.name,
              );
              if (t) {
                void loadTable(
                  t.id,
                  { connId: t.connId, database: t.database, tableName: t.tableName, table: t.table },
                  { keepSort: true, sorts: t.sorts, filter: t.filter },
                );
              }
            }}
          />
        </Suspense>
      ) : null}

      {scriptDbPick ? (
        <ScriptDbPicker
          connName={scriptDbPick.connName}
          databases={scriptDbPick.databases}
          onPick={(db) => {
            const connId = scriptDbPick.connId;
            setScriptDbPick(null);
            void openScriptModal(connId, db);
          }}
          onClose={() => setScriptDbPick(null)}
        />
      ) : null}

      {scriptTarget ? (
        <Suspense fallback={<div className="sql-loading">脚本面板载入中…</div>}>
          <SqlScriptModal
            backend={backend}
            connId={scriptTarget.connId}
            database={scriptTarget.database}
            isProduction={connections.find((c) => c.id === scriptTarget.connId)?.colorTag === 'red'}
            onClose={() => setScriptTarget(null)}
            onToast={setToast}
            onFinished={() => onScriptFinished(scriptTarget.connId)}
            confirmDanger={(req) => confirmDanger(scriptTarget.connId, req)}
          />
        </Suspense>
      ) : null}

      {designer ? (
        <Suspense fallback={<div className="sql-loading">设计器载入中…</div>}>
          <TableDesigner
            backend={backend}
            connId={designerConnId}
            database={designer.database}
            existingTable={designer.table}
            databases={Object.values(schemas).flat()}
            onClose={() => setDesigner(null)}
            onToast={setToast}
            confirmDanger={(opts) =>
              confirmDanger(designerConnId || null, {
                title: opts.title,
                statements: opts.statements,
                reason: '表结构变更将立即生效，删除的列/主键数据无法自动恢复',
                requireText: opts.statements.some((s) => /DROP (COLUMN|PRIMARY KEY)/i.test(s))
                  ? (designer.table?.name ?? designer.database)
                  : null,
              })
            }
            onSaved={() => {
              if (designerConnId) {
                void backend
                  .schemaRefresh(designerConnId)
                  .then((dbs) => setSchemas((prev) => ({ ...prev, [designerConnId]: dbs })))
                  .catch(() => undefined);
              }
            }}
          />
        </Suspense>
      ) : null}

      {/* 0.7.3（P0-19）：新建数据库。静态引入 —— 它复用首屏 .modal 壳，不值得为几十行 JSX 付一次 Suspense 塌陷 */}
      {dbCreate ? (
        <CreateDatabaseModal
          connName={dbCreate.connName}
          existing={dbCreate.existing}
          defaultCharset={dbCreate.defaultCharset}
          defaultCollation={dbCreate.defaultCollation}
          busy={dbCreateBusy}
          error={dbCreateError}
          onCancel={() => {
            if (dbCreateBusy) return;
            setDbCreate(null);
            setDbCreateError(null);
          }}
          onConfirm={(v) => void submitCreateDb(v)}
        />
      ) : null}

      {/* 0.7.3（P1-22）：重命名表。SQL 原文实时预览 —— 改名是不可撤销的结构变更 */}
      {renameTable ? (
        <NamePromptModal
          title={`重命名表 — ${renameTable.database}.${renameTable.table.name}`}
          label="新表名"
          initial={renameTable.table.name}
          validate={(v) =>
            validateNewName(v, {
              label: '新表名',
              // 源表名从"已存在"里排除：否则用户还没改就被判重名
              existing: (schemas[renameTable.connId] ?? [])
                .find((d) => d.name === renameTable.database)
                ?.tables.filter((t) => t.name !== renameTable.table.name)
                .map((t) => t.name) ?? [],
              conflictSuffix: `${renameTable.database} 中`,
            }).error
          }
          preview={(v) => {
            const check = validateNewName(v, { label: '新表名' });
            if (!check.ok) return null;
            try {
              return buildRenameTableSql(renameTable.database, renameTable.table.name, check.value);
            } catch {
              return null;
            }
          }}
          hint="只改表名，数据、索引、外键不会被重建；该表的旧标签会被关闭。"
          confirmLabel="重命名"
          testId="rename-table-modal"
          onCancel={() => setRenameTable(null)}
          onConfirm={(v) => void submitRenameTable(v)}
        />
      ) : null}

      {/* 0.7.3（P2-28）：复制表。两条 SQL 都实时预览（CREATE … LIKE / INSERT … SELECT） */}
      {copyTable ? (
        <CopyTableModal
          database={copyTable.database}
          table={copyTable.table.name}
          databases={(schemas[copyTable.connId] ?? []).map((d) => d.name)}
          existingByDb={Object.fromEntries(
            (schemas[copyTable.connId] ?? []).map((d) => [d.name, d.tables.map((t) => t.name)]),
          )}
          busy={copyBusy}
          error={copyError}
          onCancel={() => {
            if (copyBusy) return;
            setCopyTable(null);
            setCopyError(null);
          }}
          onConfirm={(v) => void submitCopyTable(v)}
        />
      ) : null}

      {/* 0.7.3（P2-29）：新建子分组 / 重命名分组（只改配置，不执行 SQL） */}
      {groupPrompt ? (
        <NamePromptModal
          title={groupPrompt.mode === 'create' ? `新建子分组 — ${groupPrompt.path}` : `重命名分组 — ${groupPrompt.path}`}
          label="分组名"
          initial={groupPrompt.mode === 'rename' ? groupDisplayName(groupPrompt.path) : ''}
          placeholder="例如 订单"
          validate={(v) =>
            groupPrompt.mode === 'rename' && v.trim() === groupDisplayName(groupPrompt.path)
              ? null
              : validateNewName(v, {
                  label: '分组名',
                  // 分组名只禁 `:`（树节点 key 的分段符）；斜杠在这里是子分组分隔符，允许
                  forbid: [':'],
                  // 同层重名会被派生结构合并成一个节点，等于"创建了但看起来没创建"
                  existing:
                    groupPrompt.mode === 'create'
                      ? treeRoots
                          .filter((n) => n.kind === 'group')
                          .flatMap((n) => (n.children ?? []).filter((c) => c.kind === 'group').map((c) => c.label))
                      : [],
                  conflictSuffix: '同级中',
                }).error
          }
          hint={
            groupPrompt.mode === 'create'
              ? '分组只是整理用的标签，不改变连接本身；空分组会保留在树里（可继续往里拖连接）。'
              : '会批量改写该分组及其子分组下所有连接的 group 字段（弹窗里看不到，但连接本身不受影响）。'
          }
          confirmLabel={groupPrompt.mode === 'create' ? '新建' : '重命名'}
          testId="group-name-modal"
          onCancel={() => setGroupPrompt(null)}
          onConfirm={(v) => (groupPrompt.mode === 'create' ? submitCreateGroup(v) : void submitRenameGroup(v))}
        />
      ) : null}

      {dangerRequest ? (
        <Suspense fallback={null}>
          <DangerConfirmModal request={dangerRequest} onResolve={onDangerResolve} />
        </Suspense>
      ) : null}
    </div>
  );
}
