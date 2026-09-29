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
import { TreeView } from './tree/TreeView';
import { CommandPalette } from './palette/CommandPalette';
import { DetailPanel } from './detail/DetailPanel';
import { CellValueModal, type CellSelection } from './detail/CellValueModal';
import { FilterBuilder } from './filter/FilterBuilder';
import { pickBackend, hasIpc, type Backend } from './backend';
import { useWorkspaceTabs, type TableTabState, type WorkspaceTab } from './workspace/useWorkspaceTabs';
import { WorkspaceTabsBar } from './workspace/WorkspaceTabsBar';
import { TablePane, type TablePaneHandlers } from './workspace/TablePane';
import type { GridForeignKey } from './grid/DataGrid';
// V20：列快速定位浮层。开关（⌘F12）由 App 挂 window，组件自身不碰 window
import { ColumnQuickFinder } from './grid/ColumnQuickFinder';
// V7 目标库选择：组件很小，静态引入（避免弹窗加载间隙布局塌陷，不进 lazy）
import { ScriptDbPicker } from './transfer/ScriptDbPicker';
import { buildTree, buildColumnIndex, emptyMemory, saveExpansion, restoreExpansion, type TreeNode } from '@dbstudio/core-tree-view';
import {
  emptyFilter,
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
  buildDuplicateRowPlan,
  isEditable,
  locateColumns,
  locateStrategy,
  validateSqlExpression,
  type EditWithLocate,
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
// R1 集成：应用壳（F1 菜单/F2 缩放/F4 会话恢复/F7 空态/D1 断线横幅）
import { EmptyState } from './workspace/EmptyState';
import { ConnStateBanner } from './workspace/ConnStateBanner';
import { nextZoom, loadFontZoom, saveFontZoom, applyFontZoom } from './workspace/fontZoom';
import { serializeSession, loadSessionSnapshot, saveSessionSnapshot, clearSessionSnapshot } from './workspace/sessionSnapshot';
// R1 集成：树 UX（C5 收藏加权 ⌘K / C2 查看定义）
import { loadFavorites } from './tree/favorites';
import type { ShowDefinitionRequest } from './tree/TreeView';

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

function snippetToCommand(s: Snippet): CommandDef {
  return {
    id: `snip:${s.name}`,
    action: `snippet:${s.name}`,
    title: s.name,
    subtitle: s.description ?? 'SQL 片段 — 回车插入到当前查询标签',
    badge: '片段',
    keywords: ['snippet', '片段', s.name],
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
  const [activeKey, setActiveKey] = useState<string | null>(null);

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
    statements: { sql: string; params: unknown[]; description?: string; hasSqlExpr?: boolean }[];
    rejected: { row: number; column: string; reason: string }[];
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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
   * 重渲染触发器。
   *
   * 🔴 为什么需要它：`GridDataSource` 的脏单元格 Map 是【可变对象】，
   *    React 无从感知 —— 编辑完不 bump 一次，网格上的脏标记不会出现。
   *    这是 intentionally-unread state：只写不读，唯一作用就是触发重渲染。
   */
  const [, touch] = useState(0);
  const rerender = useCallback(() => touch((v) => v + 1), []);

  // ---- 连接编辑器（§6.1）----
  /** null = 关闭；`'new'` = 新建；ConnectionConfig = 编辑这条 */
  const [editorState, setEditorState] = useState<'closed' | 'new' | ConnectionConfig>('closed');

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
  } | null>(null);
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
   */
  const [cellModal, setCellModal] = useState<
    (CellSelection & { table: TableMeta | null; database: string | null }) | null
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
   * 两条升第三层（手动输入表名）的路径：
   *  1. req.requireText 已有值（DROP DATABASE / 设计器删列 / 无 WHERE 的 DELETE）
   *  2. 当前连接是生产环境（红色标签，colorTag === 'red'）
   */
  const confirmDanger = useCallback(
    (req: DangerConfirmRequest): Promise<boolean> => {
      const connId = activeTab?.connId ?? connections[0]?.id;
      const isProduction = connections.find((c) => c.id === connId)?.colorTag === 'red';
      const finalReq: DangerConfirmRequest = isProduction
        ? { ...req, requireText: req.requireText ?? req.title.match(/表\s+(\S+)/)?.[1] ?? null }
        : req;
      return new Promise((resolve) => {
        dangerResolveRef.current = resolve;
        setDangerRequest(finalReq);
      });
    },
    [activeTab, connections],
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

  // ---------- 树 ----------
  const treeRoots: TreeNode[] = useMemo(() => {
    if (connections.length === 0) return [];
    return buildTree({ connections, schemas });
  }, [connections, schemas]);

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
        ws.patchTable(tabId, { loading: false });
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
        });
        /**
         * V9：把行数返回给调用方。
         * 🔴 不能靠调用方去读 sources/ws —— 那两处都要等 React 重渲染才更新，
         *    `await loadTable()` 之后立刻读会拿到旧值（外键跳转就会把
         *    「刚打开的表」误判成 0 行 → 误报"引用行不存在"）。
         */
        return out.rowCount;
      } catch (e) {
        setToast(`打开表失败：${e instanceof Error ? e.message : String(e)}`);
        ws.patchTable(tabId, { loading: false });
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

  // ---- V19 分组着色：状态归宿主（网格不自持，避免两处真相） ----
  /** tabId → 分组着色列名；缺省 = 关闭（默认关闭） */
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
    async (connId: string, database: string, tableName: string) => {
      try {
        const bundle = await backend.schemaGetTable(connId, database, tableName);
        // 🔴 needsLoad 由 openTable 自己算（setTabs 是异步调度，此刻读
        //    tabsRef 拿不到刚建的 tab —— 首开必空白的根因）
        const { id, needsLoad } = ws.openTable(connId, database, bundle.table);
        // 复用且有数据 → 保留（切换保留状态是 P0-4 核心）；无数据 → 拉数据
        if (needsLoad) void loadTable(id, { connId, database, tableName, table: bundle.table });
      } catch (e) {
        setToast(`打开表失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [ws, loadTable],
  );

  /** 开表入口：表列表可能来自磁盘快照 —— 先确保会话可用（自动握手）再开 */
  const openTableTab = useCallback(
    (connId: string, database: string, tableName: string) => {
      void (async () => {
        const ensure = await ensureConnection(connId);
        if (ensure === 'ready') {
          await openTableTabInner(connId, database, tableName);
          return;
        }
        if (ensure === 'need-password') {
          const cfg = connections.find((c) => c.id === connId);
          if (cfg) setPwdPrompt(cfg);
          pendingAfterConnectRef.current = () => void openTableTabInner(connId, database, tableName);
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
    for (const t of snapshot.tabs) {
      if (t.kind === 'query') {
        ws.newQuery(t.connId ?? connections[0]?.id ?? null, t.database, t.initialSql);
      } else {
        void openTableTabInner(t.connId, t.database, t.tableName);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting]);

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

  const onOpenObject = useCallback(
    (node: TreeNode) => {
      setActiveKey(node.key);
      if (node.kind !== 'object' || !node.table || !node.database) return;
      // 从 key 反查连接 id：obj:<connId>:<db>:<table>
      const connId = node.key.split(':')[1];
      if (!connId) return;
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
      // 基于当前已生效的筛选追加（不是基于 FilterBuilder 里未应用的编辑态）
      const base: FilterModel = tab.filter ?? emptyFilter();
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

    const plan = buildMutationPlan(tab.database, table, {
      updates: [...byRow.values()],
      // tempId 用 String(row)：SavePreviewModal 靠 Number(rowId) 显示「第 N 行」
      inserts: [...appended.entries()].map(([row, values]) => ({
        tempId: String(row),
        values,
        valueKinds: appendedKinds.get(row),
      })),
    });

    setPreview({
      tabId,
      source,
      statements: plan.statements.map((s) => ({
        sql: s.sql,
        params: s.params,
        description: s.description,
        // V10：含表达式的语句在预演里显式标注（用户必须知道这段原文即将执行）
        hasSqlExpr: s.hasSqlExpr,
      })),
      rejected: plan.rejected.map((r) => ({ row: Number(r.rowId ?? 0), column: r.column, reason: r.reason })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

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
      source.clearAll();
      ws.patchTable(tabId, { dirtyCount: 0 });
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
      const newRow = source.rowCount; // 追加到已加载行末尾
      for (const e of plan.edits) {
        // needs-input 列（非自增主键）带 reason → 格子标红提示；值保持原始类型
        source.setDirty(newRow, e.col, e.value as string | null, e.reason);
      }
      source.setExtraRows(source.extraRows + 1);
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
      for (const c of cells) {
        // 追加行（row >= rowCount）不参与批量编辑：它们还没落库，
        // 批量语义是「改已有多行的同一列」，混进来会产生无定位键的 UPDATE
        if (c.row < 0 || c.row >= source.rowCount) continue;
        source.setDirty(c.row, c.col, c.value, undefined, c.valueKind);
      }
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

  const tablePaneHandlers = useMemo<TablePaneHandlers>(
    () => ({
      onSortChange,
      onCellEdited: (tabId, source, row, col, value, valueKind) => {
        // V10：valueKind 必须原样传进脏单元格 —— 它是「保存时该不该转义」的唯一依据
        source.setDirty(row, col, value, undefined, valueKind);
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
       */
      onInspectCell: (tabId, row, col, value) => {
        const t = ws.getTable(tabId);
        if (!t) return;
        setCellModal({
          row,
          col,
          column: t.table.columns[col]?.name ?? '',
          value,
          table: t.table,
          database: t.database,
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
      // A22：右键快速筛选
      onQuickFilter,
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSortChange, onRequestSave, openTab, sources, ws, onDuplicateRow, onQuickFilter, onPasteRows, onDeleteRows, onBatchEdit, onBatchDiscard, onFollowForeignKey, onLookupForeignKeyValues],
  );

  // ---- 连接编辑器（§6.1）----
  const closeEditor = useCallback(() => setEditorState('closed'), []);

  const editorTarget = useMemo(
    () => (editorState === 'closed' || editorState === 'new' ? null : editorState),
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
   * 清空/删除表（树右键，Navicat 对应能力）。
   * 走与网格写操作完全相同的安全链路：confirmDanger（生产环境自动第三层输表名）
   * → mutationApply（主进程只读守卫再兜一次）。标识符转义走 core-sql-ident（红线 5）。
   */
  const onTableDestructive = useCallback(
    async (action: 'truncate' | 'drop', connId: string, database: string, table: TableMeta) => {
      const qualified = quoteQualified([database, table.name]);
      const sql = action === 'truncate' ? `TRUNCATE TABLE ${qualified}` : `DROP TABLE ${qualified}`;
      const isProduction = connections.find((c) => c.id === connId)?.colorTag === 'red';
      const confirmed = await confirmDanger({
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
        await backend.mutationApply({ connId, database, statements: [{ sql, params: [] }] });
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

  /** 脚本跑完（或中止）刷新该连接的 schema —— 树要跟上脚本建出来的新表 */
  const onScriptFinished = useCallback(
    (connId: string) => {
      void backend
        .schemaRefresh(connId)
        .then((dbs) => setSchemas((prev) => ({ ...prev, [connId]: dbs })))
        .catch(() => undefined);
    },
    [],
  );

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

      if (node.kind === 'connection' && node.connection) {
        const cfg = node.connection;
        const live = connStates[cfg.id]?.state === 'connected' || connStates[cfg.id]?.state === 'busy';
        push('toggle', live ? '断开连接' : '打开连接', live ? <IconPower size={12} /> : <IconPlug size={12} />, () =>
          onToggleConnectionNode(cfg, live),
        );
        push('newquery', '新建查询', <IconTerminal size={12} />, () => ws.newQuery(cfg.id, null));
        push('edit', '编辑连接…', <IconGear size={12} />, () => setEditorState(cfg));
        // V7：连接级「运行 SQL 脚本…」入口 —— 先弹目标库选择（连接可能挂多个库）
        push('runscript', '运行 SQL 脚本…', <IconFileCode size={12} />, () =>
          void openConnScriptPick(cfg.id, cfg.name),
        );
        push('refresh', '刷新表结构', <IconRefresh size={12} />, () => void onRefreshConnSchema(cfg.id));
        push('delete', '删除连接…', <IconXSmall size={12} />, () => void onDeleteConnection(cfg), {
          danger: true,
          separatorBefore: true,
        });
      } else if (node.kind === 'database' && node.database) {
        const connId = parsed?.connId ?? '';
        push('newquery', '新建查询', <IconTerminal size={12} />, () => ws.newQuery(connId, node.database!));
        push('newtable', '新建表…', <IconPlus size={12} />, () =>
          setDesigner({ mode: 'new', database: node.database!, table: null, connId }),
        );
        // 运行 SQL 脚本：库级别入口（删库重建 / 导入建表+数据脚本）
        push(
          'runscript',
          '运行 SQL 脚本…',
          <IconFileCode size={12} />,
          () => void openScriptModal(connId, node.database!),
        );
        push('copyname', '复制库名', <IconCopy size={12} />, () => copyText(node.database!));
        push('refresh', '刷新', <IconRefresh size={12} />, () => void onRefreshConnSchema(connId), {
          separatorBefore: true,
        });
      } else if (node.kind === 'kind' && node.database) {
        const connId = parsed?.connId ?? '';
        if (node.objectKind === 'table') {
          push('newtable', '新建表…', <IconPlus size={12} />, () =>
            setDesigner({ mode: 'new', database: node.database!, table: null, connId }),
          );
        }
        push('refresh', '刷新', <IconRefresh size={12} />, () => void onRefreshConnSchema(connId));
      } else if (node.kind === 'object' && node.table && node.database) {
        const connId = parsed?.connId ?? '';
        const table = node.table;
        push('open', '打开表', <IconTable size={12} />, () => onOpenObject(node));
        if (table.kind === 'table') {
          push('design', '设计表…', <IconDesign size={12} />, () =>
            setDesigner({ mode: 'edit', database: node.database!, table, connId }),
          );
          push('export', '导出数据…', <IconExport size={12} />, () =>
            setExportTarget({ connId, database: node.database!, table }),
          );
          push('import', '导入数据…', <IconImport size={12} />, () =>
            setImportTarget({ connId, database: node.database!, table }),
          );
          // 表级别脚本入口：对本表所在库执行脚本（重建该表 / 补数据等场景）
          push('runscript', '运行 SQL 脚本…', <IconFileCode size={12} />, () =>
            void openScriptModal(connId, node.database!),
          );
        }
        push('copyname', '复制表名', <IconCopy size={12} />, () => copyText(table.name));
        // 合并树侧自管菜单项（查看定义 / 复制 DDL / INSERT 模板 / 收藏）——排在危险项之前
        if (extra?.treeItems?.length) items.push(...extra.treeItems);
        if (table.kind === 'table') {
          push('truncate', '清空表…', null, () => void onTableDestructive('truncate', connId, node.database!, table), {
            danger: true,
            separatorBefore: true,
          });
          push('drop', '删除表…', null, () => void onTableDestructive('drop', connId, node.database!, table), {
            danger: true,
          });
        }
      } else if (node.kind === 'group') {
        push('newconn', '新建连接…', <IconPlus size={12} />, () => setEditorState('new'));
      }

      if (items.length > 0) setCtxMenu({ x, y, title: node.label, items });
    },
    [connStates, onToggleConnectionNode, onDeleteConnection, onRefreshConnSchema, onOpenObject, ws, copyText, onTableDestructive, openScriptModal, openConnScriptPick],
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
        const confirmed = await confirmDanger({
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
      return backend.queryRun(req);
    },
    [ensureConnection, connections, confirmDanger, sqlConnId],
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
        if (openTab) {
          const s = sources.get(openTab.id);
          if (s) onRequestSave(openTab.id, s);
        }
        e.preventDefault();
      } else if (k === 't' && !e.shiftKey) {
        newQueryTab(); // ⌘T 新建查询标签（§9.1）
        e.preventDefault();
      } else if (k === 'w' && !e.shiftKey) {
        if (ws.activeId) requestCloseTab(ws.activeId); // ⌘W 关闭当前标签
        e.preventDefault();
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
      } else if (/^[1-9]$/.test(k) && !e.shiftKey && ws.tabs.length <= 9) {
        ws.jumpTo(Number(k) - 1);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newQueryTab, requestCloseTab, ws, openTab, sources, onRequestSave, openColumnFinder]);

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
  }, [schemas, paletteOpen, openTab, groupStripeByTab]);

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
    () => [...BUILTIN_COMMANDS, ...snippets.map(snippetToCommand)],
    [snippets],
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
      else if (action.startsWith('snippet:')) {
        const name = action.slice('snippet:'.length);
        const s = snippets.find((x) => x.name === name);
        if (!s) {
          setToast(`找不到片段：${name}`);
          return;
        }
        fillSqlToEditor(s.sql);
        setToast(`已插入片段：${s.name}`);
      } else setToast(`执行命令：${action}`);
    },
    [openSql, cycleTheme, snippets, fillSqlToEditor, zoomStep, refreshCurrent, toggleReadOnlyCurrent, checkUpdate, openCurrentInNewWindow],
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
        case 'save': if (openTab) { const s = sources.get(openTab.id); if (s) onRequestSave(openTab.id, s); } break;
        case 'filter': openFilter(); break;
        case 'export':
          if (openTab) setExportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
          break;
        case 'import':
          if (openTab) setImportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table });
          break;
        case 'design-table':
          if (openTab) setDesigner({ mode: 'edit', database: openTab.database, table: openTab.table });
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
  }, [newQueryTab, requestCloseTab, ws, openTab, sources, onRequestSave, onRefreshSchemas, cycleTheme, zoomStep, checkUpdate, openCurrentInNewWindow, openFilter]);

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
  const statusEditable = openTab ? isEditable(openTab.table) : false;
  const statusStrategy = openTab ? locateStrategy(openTab.table) : 'none';

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
  const tableTabs = ws.tabs.filter((t): t is TableTabState => t.kind === 'table');

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
            title="刷新表结构（已连接的连接）"
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
          </div>
        ) : (
          <TreeView
            roots={treeRoots}
            expanded={expanded}
            onExpandedChange={setExpanded}
            activeKey={activeKey}
            onOpenObject={onOpenObject}
            onSelectNode={(n) => setActiveKey(n.key)}
            columnIndex={columnIndex}
            onOpenTableRef={onOpenTableRef}
            connStates={connStates}
            onToggleConnection={onToggleConnectionNode}
            onEditConnection={(cfg) => setEditorState(cfg)}
            onDeleteConnection={(cfg) => void onDeleteConnection(cfg)}
            onNodeContextMenu={openNodeMenu}
            onBackgroundContextMenu={openTreeBackgroundMenu}
            // C2/C3/C5/C6：查看定义、收藏 toast、F2 重命名（进设计器）、Del 删除（走危险确认）
            onShowDefinition={(req) => void onShowDefinition(req)}
            onToast={setToast}
            onRenameRequest={(req) => setDesigner({ mode: 'edit', database: req.database, table: req.table, connId: req.connId })}
            onDeleteRequest={(req) => void onTableDestructive('drop', req.connId, req.database, req.table)}
            onNewTable={(database) => {
              const connId = Object.keys(schemas).find((cid) =>
                (schemas[cid] ?? []).some((d) => d.name === database),
              );
              if (!connId) {
                setToast('找不到该库所属的连接，无法新建表');
                return;
              }
              setDesigner({ mode: 'new', database, table: null, connId });
            }}
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
        />

        <div className="toolbar">
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
                className="primary"
                disabled={!statusEditable}
                data-testid="btn-save"
              >
                <IconSave size={11} />
                保存 ⌘S
              </button>
              <button onClick={openFilter} data-testid="btn-filter">
                <IconFilter size={11} />
                筛选{filterCount > 0 ? ` (${filterCount})` : ''}
              </button>
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
              <button
                onClick={() =>
                  setImportTarget({ connId: openTab.connId, database: openTab.database, table: openTab.table })
                }
                title="从 CSV/Excel 导入（追加 INSERT）"
                data-testid="btn-import"
              >
                <IconImport size={11} />
                导入
              </button>
              <button
                onClick={() => setDesigner({ mode: 'edit', database: openTab.database, table: openTab.table })}
                disabled={openTab.table.kind === 'view'}
                title={openTab.table.kind === 'view' ? '视图不可结构编辑' : '设计表结构（字段/索引/外键）'}
                data-testid="btn-design"
              >
                <IconDesign size={11} />
                设计
              </button>
              <button onClick={() => void onPasteRows()} title="从剪贴板粘贴多行（D2）">
                <IconPaste size={11} />
                粘贴
              </button>
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
            <span style={{ color: 'var(--text-dim)' }}>
              {openTab.database}.{openTab.tableName} · 定位策略：
              {statusStrategy === 'none' ? '无（只读）' : statusStrategy === 'pk' ? '主键' : '唯一键'}
            </span>
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>未打开表</span>
          )}
          <span className="spacer" />
          {openTab?.queryMs != null ? (
            <span style={{ color: 'var(--text-dim)' }}>
              {openTab.payload?.rowCount ?? 0} 行 / {openTab.queryMs}ms{openTab.truncated ? '（已截断）' : ''}
            </span>
          ) : null}
          <span className="env-tag">{envTag}</span>
        </div>

        {/* 🔴 所有 pane 常挂 DOM，靠 .hidden 隐藏 —— 保留编辑器实例 / 脏标记 / 滚动位置 */}
        {tableTabs.map((t) => (
          <TablePane
            key={t.id}
            tab={t}
            active={ws.activeId === t.id}
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
            // V19：分组条纹（状态在 App，默认关闭）
            groupStripeColumn={groupStripeByTab[t.id] ?? null}
            onToggleGroupStripe={toggleGroupStripe}
          />
        ))}

        {ws.tabs.map((t) =>
          t.kind === 'query' ? (
            <div
              key={t.id}
              className={`ws-tab-pane${ws.activeId === t.id ? '' : ' hidden'}`}
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
                    });
                  }}
                  // A12：单表 SELECT 结果 → 打开该表的可编辑表格视图（写回走既有保存预演）
                  onOpenEditableResult={(req) => {
                    openTableTab(req.connId, req.database, req.table);
                    setToast(`已在表格中打开 ${req.database}.${req.table}（改动保存前仍会逐条预演 SQL）`);
                  }}
                />
              </Suspense>
            </div>
          ) : null,
        )}

        {ws.tabs.length === 0 ? (
          <EmptyState
            hasConnections={connections.length > 0}
            onNewConnection={() => setEditorState('new')}
            onOpenPalette={() => setPaletteOpen(true)}
            onNewQuery={newQueryTab}
          />
        ) : null}

        {toast ? (
          <div
            className="banner shell-banner"
            title="点击复制错误信息"
            onClick={() => {
              void navigator.clipboard?.writeText(toast).catch(() => undefined);
              setToast('已复制错误信息到剪贴板');
            }}
          >
            {toast}
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

        <div className="statusbar">
          <span>标签：{ws.tabs.length}</span>
          <span>脏单元格：{statusSource?.dirtyCount ?? 0}</span>
          <span>可编辑：{statusEditable ? '是' : '否'}</span>
          <span>排序：{openTab?.sorts.map((s) => `${s.column} ${s.direction}`).join(', ') || '无'}</span>
          {selectionSummary ? <span>选中 {selectionSummary.rows} 行 / {selectionSummary.cells} 格</span> : null}
          {openTab && rowsEstimate?.key === estimateKey && rowsEstimate.rows != null ? (
            <span title="information_schema 估算值，不做全表 COUNT">
              约 {rowsEstimate.rows.toLocaleString('zh-CN')} 行
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

      {preview ? (
        <SavePreviewModal
          statements={preview.statements}
          rejected={preview.rejected}
          onCancel={() => setPreview(null)}
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
            confirmDanger={confirmDanger}
          />
        </Suspense>
      ) : null}

      {designer ? (
        <Suspense fallback={<div className="sql-loading">设计器载入中…</div>}>
          <TableDesigner
            backend={backend}
            connId={designer.connId ?? openTab?.connId ?? connections.find((c) => (schemas[c.id] ?? []).some((d) => d.name === designer.database))?.id ?? ''}
            database={designer.database}
            existingTable={designer.table}
            databases={Object.values(schemas).flat()}
            onClose={() => setDesigner(null)}
            onToast={setToast}
            confirmDanger={(opts) =>
              confirmDanger({
                title: opts.title,
                statements: opts.statements,
                reason: '表结构变更将立即生效，删除的列/主键数据无法自动恢复',
                requireText: opts.statements.some((s) => /DROP (COLUMN|PRIMARY KEY)/i.test(s))
                  ? (designer.table?.name ?? designer.database)
                  : null,
              })
            }
            onSaved={() => {
              const connId =
                openTab?.connId ??
                connections.find((c) => (schemas[c.id] ?? []).some((d) => d.name === designer.database))?.id;
              if (connId) {
                void backend
                  .schemaRefresh(connId)
                  .then((dbs) => setSchemas((prev) => ({ ...prev, [connId]: dbs })))
                  .catch(() => undefined);
              }
            }}
          />
        </Suspense>
      ) : null}

      {dangerRequest ? (
        <Suspense fallback={null}>
          <DangerConfirmModal request={dangerRequest} onResolve={onDangerResolve} />
        </Suspense>
      ) : null}
    </div>
  );
}
