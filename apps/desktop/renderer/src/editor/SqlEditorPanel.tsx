/**
 * SQL 编辑器面板（PRD §6.4）
 *
 * 这个文件本身是**轻的** —— 它只做编排，CodeMirror 在 `SqlEditorCore` 里
 * 由 `lazyCodemirror()` 动态载入。首屏只多一个 chunk 地址表（E2：≤5KB）。
 *
 * 三条硬约束（改之前先看）：
 *  1. **绝不能静态 import SqlEditorCore** —— 那会让 CodeMirror（782KB 未压缩）
 *     进首屏，直接破 S2 的首屏 ≤1.5MB
 *  2. **执行期间界面不得假死**（§6.4.2）：查询是 await 的，但 UI 状态全部
 *     走 React state，编辑器和网格都还能操作
 *  3. **取消靠 queryId**（R6）：发起瞬间就握句柄，不轮询、不猜
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseMeta } from '@dbstudio/core-schema-cache';
import {
  isValidSnippetName,
  snippetNameTooLongMessage,
  SNIPPET_NAME_MAX,
} from '@dbstudio/core-history/snippet-name';
import { ColumnarReader, type ColumnarPayload } from '@dbstudio/core-ipc-codec';
import {
  resolveExecution,
  splitStatements,
  statementAt,
  toggleLineComment,
  wrapExplain,
  explainCell,
  buildExplainTree,
  explainJsonToRows,
  EXPLAIN_COLUMNS,
  formatCount,
  type ExecutionTarget,
  type ExplainNode,
  type SqlStatementSpan,
} from '@dbstudio/core-sql-editor';
import { DataGrid, type GridColumn } from '../grid/DataGrid';
import { useGridDataSource } from '../grid/useGridData';
import { IconX, IconSave, IconExport, IconBraces, IconStarFilled, IconFolder } from '../ui/icons';
// T33：值查看器**只调用不改**（detail/ 归别的并行任务）
import { CellValueModal } from '../detail/CellValueModal';
// T33：结果网格取值的纯逻辑（值与原字节一致 + 回调装配）
import {
  buildResultInspectHandler,
  readResultRow,
  resultDisplayDatabase,
  resultDisplayTable,
  type ResultCellRef,
  type ResultRowValue,
} from './resultCell';
// T41：SQL 文件文档状态机（脏判定 / 未保存保护 / 文案）
import {
  NO_SQL_FILE,
  fileBadgeText,
  fileDisplayName,
  isFileDirty,
  resolveUnsaved,
  saveButtonLabel,
  unsavedDecision,
  OPEN_BUTTON_TITLE,
  SAVE_AS_BUTTON_TITLE,
  SAVE_BUTTON_TITLE,
  type SqlFileState,
  type SqlFileStamp,
  type UnsavedChoice,
  type UnsavedPrompt,
} from './sqlFileDoc';
// T42：结果标签的集合操作语义（固定 / 关闭其他 / 合并）
import {
  closeOthers,
  displayOrder,
  mergeResults,
  renameTab,
  togglePin,
  describeResultOrigin,
  resultTabTitle,
  type ResultTabMeta,
} from './resultTabs';
import type { ConnectionConfig } from '@dbstudio/core-connection';
// T28/T29：右键菜单与工具栏执行对象的纯逻辑（不依赖 React/DOM，可单测）
import {
  buildSqlContextMenu,
  describeConnectionTarget,
  executionScopeLegend,
  type SqlMenuActionId,
} from './sqlEditorMenuModel';
// T11/T50：工具栏上的键位提示从动作目录取 —— 手写一份必然与裁定漂移
// （本行原先写着 ⇧⌘R / ⇧⌘E，两个都已被 T11 让位/改键）。
import { displayOf } from '../../../src/shared/action-catalog.js';
// S3：收藏表名（与树、⌘K 命令面板同构的 `${connId}:${db}:${table}` 键）
import { loadFavorites } from '../tree/favorites';
// 契约 §一.1：组件自取后端（demo 降级天然可用），不依赖 App 传 props
import { pickBackend } from '../backend';
// T41：SQL 文件的三个 DTO 还没进 renderer-types 的导出清单（那份清单本轮不让改），
// 与 backend.ts 同口径走**相对路径的 type-only import**（编译后被擦除，零运行时成本）
import type {
  SqlFileReadResult,
  SqlFileSaveRequest,
  SqlFileSaveResult,
} from '../../../src/shared/ipc-channels.js';


// 🔴 只在这里 import【类型】，值一律走 lazyCodemirror()
import type { SqlEditorHandle } from './SqlEditorCore';
import { isImeComposing } from '../ui/imeGuard';
import { useMenuBehavior } from '../ui/useMenuBehavior';

type CoreModule = typeof import('./SqlEditorCore');

let corePromise: Promise<CoreModule> | null = null;
/** 惰性载入 CodeMirror。缓存 promise —— 第二次打开标签页要秒开（E3） */
function lazyCodemirror(): Promise<CoreModule> {
  if (!corePromise) corePromise = import('./SqlEditorCore');
  return corePromise;
}

export interface SqlEditorPanelProps {
  connId: string | null;
  database: string | null;
  /** E4：补全数据源，只吃内存里的 schema 缓存 */
  databases: DatabaseMeta[];
  initialSql?: string;
  onRun: (req: { connId: string; sql: string; database?: string | null; queryId?: string }) => Promise<{
    payload: ColumnarPayload;
    elapsedMs: number;
    rowCount: number;
    cancelled: boolean;
    truncated: boolean;
    queryId: string | null;
    /** A12：单表 SELECT 检测结果（主进程 extractSingleTable），null/缺省 = 只读 */
    source?: { database: string | null; table: string } | null;
  }>;
  onCancel: (queryId: string) => Promise<boolean>;
  /**
   * 切换查询目标库（Navicat 式库下拉）。缺省不渲染下拉。
   * 切换只改 tab 的库上下文，不动编辑器文档；执行时由主进程按需补 USE。
   */
  onDatabaseChange?: (database: string | null) => void;
  onToast?: (msg: string) => void;
  readOnlyConn?: boolean;
  /**
   * P1-3 历史回填：把"往这个编辑器写 SQL"的句柄登记给 App 层。
   *
   * CodeMirror 实例由本组件私有持有，React state 够不着 —— 想从命令面板
   * 把历史 SQL 回填进当前标签，只能走这种登记式命令通道。
   * 卸载时以 null 注销；`injectorKey` 是所属查询标签的 id。
   */
  registerInjector?: (key: string, fn: ((sql: string) => void) | null) => void;
  injectorKey?: string;
  /**
   * T12 / I04：宿主投递的「保存为片段」请求信号（递增计数，0 = 无请求）。
   *
   * 🔴 为什么是信号而不是命令句柄：⌘S 由 App 的 window keydown 捕获（焦点可能不在
   *    编辑器），而「保存片段」对话框的开关状态（snippetOpen）归本面板私有。
   *    递增计数是最小耦合的单向通道 —— 面板只在数字变化时开门，不关心是谁按的键，
   *    也不必把面板内部状态提升到 App（那会让 CodeMirror 的生命周期跟着 App 重渲染）。
   */
  snippetSaveSignal?: number;
  /**
   * B7 结果集导出入口：宿主接线后，每个有结果集的页签出现「导出」按钮。
   * req.sql = 产生该结果的那条语句原文；columns = 结果列元数据
   * （typeCode 已映射为可读类型名）。宿主未接时按钮整体隐藏，不许崩。
   */
  onExportResult?: (req: {
    sql: string;
    database: string | null;
    columns: { name: string; dataType: string }[];
  }) => void;
  /**
   * A12 / T39：结果集来自单表 SELECT 时提供「打开源表」入口。
   *
   * 宿主侧复用既有开表链路（schemaGetTable 拿 PK 定位元数据 → 表格 tab），
   * 写回仍走逐条 SQL 预演红线。
   *
   * `locate` = 用户**在结果里点过的那一行**的原始值（列名 → 原文字符串）。
   * 只包含定位所需的键值由宿主再筛（`locateColumns()` 是唯一判定处）——
   * 面板不猜哪一列是主键，宿主也不猜哪一行是目标行。
   */
  onOpenEditableResult?: (req: {
    connId: string;
    database: string;
    table: string;
    locate?: ResultRowValue[];
  }) => void;
  /**
   * V17：内联耗时的数据源。**可选** —— 不传时面板用自己最近一次执行的结果
   * （`onRun` 的返回值里本来就有 elapsedMs / rowCount / cancelled），
   * 传了就以宿主为准（多面板共享同一次执行的场景）。
   */
  lastRun?: { elapsedMs: number; rowCount: number; cancelled: boolean } | null;
  /**
   * T41：SQL 文件的脏状态上报（**宿主可选**）。
   *
   * 🔴 为什么要有这条通道：关闭标签 / 退出应用由 App 统一拦截，而这个面板
   *    够不到那两个入口。宿主接上它才能把「文件有未保存改动」纳入
   *    `beforeCloseTab` 的同一口径（本轮 App.tsx 不在改动范围内，故此处只留接口）。
   */
  onFileDirtyChange?: (dirty: boolean, path: string | null) => void;
}

/** 一个结果集 */
interface ResultTab extends ResultTabMeta {
  id: string;
  sql: string;
  /** T42 来源追溯：产生该结果的连接与库 */
  connId: string | null;
  database: string | null;
  /**
   * 产生该结果的语句在编辑器文档中的起始偏移（B6「定位到语句」用）。
   * EXPLAIN 页签存的是被 EXPLAIN 的原语句偏移；拿不到就 null（不显示链接）。
   */
  offset: number | null;
  payload: ColumnarPayload | null;
  elapsedMs: number;
  rowCount: number;
  truncated: boolean;
  error: string | null;
  cancelled: boolean;
  /** EXPLAIN 结果走特殊渲染 */
  explain: boolean;
  /** 消息面板文案 */
  message: string;
  /** A12：该结果是否可定位到单表（主进程检测），决定「打开可编辑表格」按钮 */
  source?: { database: string | null; table: string } | null;
}

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `q${tabSeq}`;
}

/** 统一把异常收敛成可展示的中文串（toast 里绝不出 [object Object]） */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** typeCode → 可读类型名（仅用于列头 tooltip） */
const TYPE_NAMES: Record<number, string> = {
  0: 'NULL',
  1: 'BOOL',
  2: 'F64',
  3: 'STR',
  4: 'DATE',
  5: 'BIN',
};

// ---------- B3 查询草稿（localStorage） ----------

const DRAFT_KEY_PREFIX = 'dbstudio.draft.v1:';
/** 超过 200KB 不落草稿：localStorage 写大值会卡 UI，这种体量多半也是粘错了东西 */
const DRAFT_MAX_CHARS = 200 * 1024;
/** 输入停顿 400ms 才写盘 —— 敲每个字符都同步写 localStorage 会把输入打糊 */
const DRAFT_DEBOUNCE_MS = 400;

function draftKeyOf(injectorKey?: string): string {
  return DRAFT_KEY_PREFIX + (injectorKey ?? 'default');
}

function readDraft(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as { sql?: unknown };
    return typeof d.sql === 'string' ? d.sql : null;
  } catch {
    // 草稿坏了就当没有 —— 草稿是锦上添花，绝不能阻塞编辑器
    return null;
  }
}

function writeDraft(key: string, sql: string): void {
  if (sql.length > DRAFT_MAX_CHARS) return;
  try {
    localStorage.setItem(key, JSON.stringify({ sql, savedAt: Date.now() }));
  } catch {
    // 配额满 / 隐私模式：静默放弃，不影响编辑
  }
}

// ---------- B4 EXPLAIN 视图模式（per panel 记忆） ----------

type ExplainViewMode = 'table' | 'tree';

function readExplainMode(injectorKey?: string): ExplainViewMode {
  try {
    return localStorage.getItem(`dbstudio.explainView.v1:${injectorKey ?? 'default'}`) === 'tree'
      ? 'tree'
      : 'table';
  } catch {
    return 'table';
  }
}

function writeExplainMode(injectorKey: string | undefined, mode: ExplainViewMode): void {
  try {
    localStorage.setItem(`dbstudio.explainView.v1:${injectorKey ?? 'default'}`, mode);
  } catch {
    // 记不住就用默认表格视图，不致命
  }
}

// ---------- B6 语句偏移定位 ----------

/**
 * 计算执行目标里每条语句在【编辑器文档】中的偏移区间。
 *
 * splitStatements 返回的偏移是相对入参文本的，两种情况要换算：
 *  - 选中执行：入参是选区切片（resolveExecution 还 trim 过），把基准挪到切片起点；
 *    一段选区可以含多条语句 → 返回多条 span
 *  - 非选中执行：目标是单条语句，直接复用 statementAt 的定位口径
 *    （⌘R 无选中 → 偏移基准 0；「执行选中」但选区塌陷 → 光标处），
 *    找不到精确匹配时按语句原文兜底找第一条相同文本
 */
function statementOffsets(
  docText: string,
  selection: { from: number; to: number } | null,
  target: ExecutionTarget,
): SqlStatementSpan[] {
  if (target.fromSelection && selection) {
    const sliced = docText.slice(selection.from, selection.to);
    const base = selection.from + (sliced.length - sliced.trimStart().length);
    return splitStatements(target.sql).map((sp) => ({
      ...sp,
      from: base + sp.from,
      to: base + sp.to,
    }));
  }
  const cursor = selection ? selection.from : 0;
  const hit = statementAt(docText, cursor);
  if (hit && hit.text === target.sql) return [hit];
  const fallback = splitStatements(docText).find((sp) => sp.text === target.sql);
  return fallback ? [fallback] : [];
}

export function SqlEditorPanel(props: SqlEditorPanelProps) {
  const { connId, database, databases, onRun, onCancel, onToast, onDatabaseChange } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SqlEditorHandle | null>(null);
  const queryIdRef = useRef<string | null>(null);

  const [coreLoading, setCoreLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedTick, setElapsedTick] = useState(0);
  const [tabs, setTabs] = useState<ResultTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [timeoutPrompt, setTimeoutPrompt] = useState(false);
  const [snippetOpen, setSnippetOpen] = useState(false);
  /**
   * T41：当前挂载的 SQL 文件状态（path 为 null = 草稿，没有文件目标）。
   *
   * 脏判定走 `isFileDirty(state, doc)`，基线是**最近一次读盘/存盘写进文件的文本**，
   * 不是 React state 里的文档镜像（文档归 CodeMirror，镜像一份会拖慢输入）。
   */
  const [fileState, setFileState] = useState<SqlFileState>(NO_SQL_FILE);
  const [fileDirty, setFileDirty] = useState(false);
  /** T41：未保存保护弹窗（prompt + 用户确认后要继续的那个动作） */
  const [unsavedAsk, setUnsavedAsk] = useState<{ prompt: UnsavedPrompt; go: () => void } | null>(null);
  /** T41：保存时发现文件被外部改过 —— 先摆出来让用户选，绝不直接覆盖 */
  const [saveConflict, setSaveConflict] = useState<{ path: string; current: SqlFileStamp | null } | null>(null);
  /** T42：正在重命名的结果标签 id */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** T42：结果标签右键菜单 */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  /** T33：结果网格「查看完整值」弹窗（与表网格共用同一个值查看器） */
  const [cellModal, setCellModal] = useState<ResultCellRef | null>(null);
  /**
   * T39：每个结果标签**最后一次点过的行**（tabId → 该行原始值）。
   *
   * 用 ref 而不是 state：它只在点「打开源表」的那一刻被读一次，
   * 进 state 会让每次点单元格都重渲染整个结果区。
   */
  const lastRowRef = useRef<Record<string, ResultRowValue[]>>({});
  /** V17：最近一次执行的结果（耗时/行数/是否取消），渲染在编辑器区域内联 */
  const [lastRun, setLastRun] = useState<{ elapsedMs: number; rowCount: number; cancelled: boolean } | null>(null);
  /**
   * S1：编辑器内右键菜单状态；null = 不显示。
   *
   * T28：菜单项是否可用必须与**打开菜单那一刻**的编辑器状态一致 ——
   * 选区/非空快照在开门时用句柄取一次（右键是低频动作，读全文开销可忽略），
   * 不在 React state 里持续镜像文档（那会拖慢输入热路径）。
   */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    hasText: boolean;
  } | null>(null);
  /** T29：选区字符数（0 = 无选区/已塌陷）。只存数字，值不变时 React 会 bail out */
  const [selChars, setSelChars] = useState(0);
  /**
   * T29：目标连接清单（`connList()`），用于在工具栏显示「连接名 · 环境」。
   *
   * 为什么面板自取而不是等 App 传 props：本组件是 lazy 面板，宿主已有
   * `connections` state，但把连接列表塞进 props 会牵动 App 的接线（本任务
   * 明确不许改 App.tsx）。connList 是既有后端能力，自取不新增依赖。
   */
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);

  /**
   * S3：收藏表名 → `rankTables` 的加权输入。
   *
   * 收藏键是 `${connId}:${database}:${table}`，这里剥出最后一段表名并**按当前
   * 连接/库过滤** —— 否则 A 库收藏的表会跑到 B 库的补全加权里。
   * 按 [connId, database] 记忆：树里改收藏后面板重渲染即生效。
   */
  const favorites = useMemo<string[]>(() => {
    const prefix = connId ? `${connId}:` : null;
    if (prefix === null) return [];
    const dbPrefix = database ? `${prefix}${database}:` : null;
    const out: string[] = [];
    for (const key of loadFavorites()) {
      if (!key.startsWith(prefix)) continue;
      if (dbPrefix !== null && !key.startsWith(dbPrefix)) continue;
      const table = key.slice(key.lastIndexOf(':') + 1);
      if (table !== '') out.push(table);
    }
    return out;
  }, [connId, database]);
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  // 编辑器实例：dependencies 里【刻意不放 databases】——
  // 补全源通过闭包读最新值，重建编辑器会丢光标与撤销栈
  const databasesRef = useRef(databases);
  databasesRef.current = databases;
  const propsRef = useRef(props);
  propsRef.current = props;
  /** T41：fileState 的 ref 镜像 —— 防抖回调（deps 为空）里要读最新值 */
  const fileStateRef = useRef(fileState);
  fileStateRef.current = fileState;

  // T29：目标连接清单（连接名 / 环境分组 / 生产标记的唯一来源）
  useEffect(() => {
    let alive = true;
    void pickBackend()
      .connList()
      .then((r) => {
        if (alive) setConnections(r.connections);
      })
      .catch(() => {
        // 取不到连接列表就退化显示 connId（describeConnectionTarget 已兜底），不崩
      });
    return () => {
      alive = false;
    };
  }, []);

  /** T29：执行区文案（执行全部 / 当前语句 或 执行选中 / 指示器）—— 单一真值来源 */
  const scope = useMemo(() => executionScopeLegend(selChars), [selChars]);
  /** T29：目标连接与环境徽标 */
  const connTarget = useMemo(() => describeConnectionTarget(connections, connId), [connections, connId]);

  // ---------- B3 草稿自动保存（debounce 后写 localStorage） ----------
  // 定时器与待写内容放 ref：草稿是副作用，不该牵动 React 渲染
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftPendingRef = useRef<string | null>(null);
  /**
   * T41：文件脏标记同步。
   *
   * 挂在草稿防抖的 flush 上（400ms）而不是每次按键 —— 脏标记只影响工具栏徽标，
   * 不值得为它把输入延迟抬高。值不变时 setState 会被 React bail out，零额外渲染。
   */
  const syncFileDirty = useCallback((doc: string) => {
    const next = isFileDirty(fileStateRef.current, doc);
    setFileDirty((prev) => (prev === next ? prev : next));
  }, []);
  const scheduleDraftSave = useCallback(
    (doc: string) => {
      draftPendingRef.current = doc;
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null;
        const text = draftPendingRef.current;
        draftPendingRef.current = null;
        // flush 时才读 injectorKey：读最新值，避免闭包拿到过期 props
        if (text !== null) writeDraft(draftKeyOf(propsRef.current.injectorKey), text);
        if (text !== null) syncFileDirty(text);
      }, DRAFT_DEBOUNCE_MS);
    },
    [syncFileDirty],
  );

  useEffect(() => {
    let disposed = false;
    let handle: SqlEditorHandle | null = null;

    void (async () => {
      const core = await lazyCodemirror();
      if (disposed || !hostRef.current) return;
      const created = core.createSqlEditor({
        parent: hostRef.current,
        doc: propsRef.current.initialSql ?? 'SELECT * FROM ',
        // 闭包读 ref：schema 刷新后补全源自动跟上，不重建编辑器
        get databases() {
          return databasesRef.current;
        },
        // S3：收藏表名（按当前连接/库过滤后的裸表名）
        get favorites() {
          return favoritesRef.current;
        },
        // V16/S4：当前查询目标库。没有库上下文时诊断自动只跑词法级规则
        get database() {
          return propsRef.current.database ?? null;
        },
        // S1：格式化被拒绝（如 DELIMITER）时的中文原因 → 宿主 toast
        onNotice: (msg) => propsRef.current.onToast?.(msg),
        // S1：编辑器内右键 → 宿主渲染菜单（复用 .ctx-menu/.ctx-item 既有样式）
        // T28：开门瞬间取一次「有无选区 / 是否为空」，作为菜单项可用性的唯一依据
        onContextMenu: (at) => {
          const sel = created.selection();
          setCtxMenu({
            x: at.x,
            y: at.y,
            hasSelection: sel.to > sel.from,
            hasText: created.getText().trim() !== '',
          });
        },
        // T29：选区区间变化（含打字导致的塌陷）→ 工具栏「执行对象」随之更新
        onSelectionChange: (sel) => setSelChars(sel.to - sel.from),
        // 编辑器自己就是 doc 的唯一权威；这里不回写 React state ——
        // 每次按键触发一次全量 setState 会把输入延迟从 <1ms 抬到肉眼可见。
        // B3：草稿保存只挂在 scheduleDraftSave（内部纯 ref + 定时器），不触发渲染
        onChange: (doc) => scheduleDraftSave(doc),
        onExecute: (mode) => void execute(mode),
        onCancel: () => void cancel(),
        onExplain: () => void runExplain(),
        onToggleComment: () => toggleComment(),
      });
      handle = created;
      handleRef.current = created;

      // B3 草稿恢复：仅当面板没有任何「有意写入」的内容（无 initialSql）才恢复。
      // initialSql 是 App 明确塞进来的内容，草稿必须让位；默认占位文本不算内容。
      if (!propsRef.current.initialSql?.trim()) {
        const draftSql = readDraft(draftKeyOf(propsRef.current.injectorKey));
        if (draftSql && draftSql.trim()) {
          created.setDoc(draftSql);
          propsRef.current.onToast?.('已恢复上次未保存的草稿');
        }
      }

      // 登记注入句柄（历史回填/片段插入），卸载时注销。
      // B3：注入视为有意写入 —— setDoc 触发 docChanged → 草稿被注入内容覆盖，
      // 下次挂载不会再恢复旧草稿
      propsRef.current.registerInjector?.(
        propsRef.current.injectorKey ?? '',
        (sql) => {
          created.setDoc(sql);
          created.focus();
        },
      );
      setCoreLoading(false);
      handle.focus();
    })();

    return () => {
      disposed = true;
      handle?.destroy();
      handleRef.current = null;
      propsRef.current.registerInjector?.(propsRef.current.injectorKey ?? '', null);
      // B3：卸载【不删】草稿 —— 主诉求是崩溃恢复，断电/崩溃时根本走不到这里，
      // 草稿必须留在盘上等下次挂载认领。这里只把 debounce 里没落盘的尾巴立刻冲掉
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      const pending = draftPendingRef.current;
      if (pending !== null) {
        draftPendingRef.current = null;
        writeDraft(draftKeyOf(propsRef.current.injectorKey), pending);
      }
    };
    // 只在挂载时建一次；SQL 内容由编辑器和 React 各自持有，不同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 执行耗时 tick（§6.4.2：状态栏显示已耗时）
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsedTick((v) => v + 1), 200);
    return () => clearInterval(t);
  }, [running]);

  const elapsedNow = runStartedAt ? Date.now() - runStartedAt : 0;
  void elapsedTick; // 触发重渲染用

  // ---------- 执行 ----------

  const execute = useCallback(
    async (mode: 'all' | 'selection'): Promise<void> => {
      if (!connId) {
        onToast?.('未选中连接');
        return;
      }
      if (running) {
        onToast?.('已有查询在执行');
        return;
      }
      const h = handleRef.current;
      if (!h) return;

      const docText = h.getDoc();
      const sel = h.selection();
      const target = resolveExecution(docText, mode === 'selection' ? { from: sel.from, to: sel.to } : null);
      if (!target) {
        onToast?.('没有可执行的语句');
        return;
      }

      // 拆分时保留下每条语句在文档中的偏移（B6「定位到语句」要用）
      const spans = statementOffsets(docText, mode === 'selection' ? { from: sel.from, to: sel.to } : null, target);
      if (spans.length === 0) return;

      // 🔴 R6：发起瞬间生成 queryId 并握在手里 —— 取消不依赖返回、不轮询
      const queryId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      queryIdRef.current = queryId;

      setRunning(true);
      setRunStartedAt(Date.now());
      setTimeoutPrompt(false);

      // 30s 超时提示（§6.4.2：**不自动 kill**）
      const timer = setTimeout(() => setTimeoutPrompt(true), 30_000);

      // T42：来源追溯用的时间快照（同一批语句共用一个「这次执行」的时刻）
      const producedAt = Date.now();
      const produced: ResultTab[] = [];
      try {
        for (let i = 0; i < spans.length; i++) {
          const st = spans[i].text;
          const r = await onRun({ connId, sql: st, database, queryId });
          produced.push({
            id: nextTabId(),
            sql: st,
            // T42：来源 SQL / 连接 / 库 / 时间 —— 结果越多越需要知道它是哪次跑出来的
            connId,
            database,
            createdAt: producedAt,
            pinned: false,
            name: null,
            offset: spans[i].from,
            payload: r.payload,
            elapsedMs: r.elapsedMs,
            rowCount: r.rowCount,
            truncated: r.truncated,
            error: null,
            cancelled: r.cancelled,
            explain: false,
            message: r.cancelled ? '已取消' : `返回 ${formatCount(r.rowCount)} 行`,
            source: r.source ?? null,
          });
        }
      } catch (e) {
        // Q5/C3：失败语句也要留在结果区 —— 用户得看清是哪条炸的
        const failed = spans[produced.length];
        produced.push({
          id: nextTabId(),
          sql: failed?.text ?? target.sql,
          connId,
          database,
          createdAt: producedAt,
          pinned: false,
          name: null,
          offset: failed?.from ?? null,
          payload: null,
          elapsedMs: 0,
          rowCount: 0,
          truncated: false,
          error: e instanceof Error ? e.message : String(e),
          cancelled: false,
          explain: false,
          message: '执行失败',
        });
      } finally {
        clearTimeout(timer);
        setRunning(false);
        setRunStartedAt(null);
        queryIdRef.current = null;
        // V17：内联耗时。多语句按**合计**展示 —— 用户关心的是"这一下 ⌘R 花了多久"
        if (produced.length > 0) {
          setLastRun({
            elapsedMs: produced.reduce((s, t) => s + t.elapsedMs, 0),
            rowCount: produced.reduce((s, t) => s + t.rowCount, 0),
            cancelled: produced.some((t) => t.cancelled),
          });
        }
      }

      if (produced.length > 0) {
        // T42：合并而非 slice —— 固定结果永不被新结果挤掉（见 resultTabs.mergeResults）
        setTabs((prev) => mergeResults(prev, produced));
        setActiveTab(produced[0].id);
      }
    },
    [connId, database, onRun, onToast, running],
  );

  const cancel = useCallback(async () => {
    const id = queryIdRef.current;
    if (!id) {
      onToast?.('当前没有正在执行的查询');
      return;
    }
    await onCancel(id).catch(() => false);
    onToast?.('已发送取消（KILL QUERY）');
  }, [onCancel, onToast]);

  /** 关闭单个结果页签（Navicat 式）：关掉激活页签时激活邻位（优先右） */
  const closeResultTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTab((cur) => {
        if (cur !== id) return cur;
        return next[Math.min(idx, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  // =========================================================================
  // T41：SQL 文件闭环（打开不执行 / 保存不执行 / 未保存保护 / 外部覆盖冲突）
  // =========================================================================

  /** 把文件状态落进 state + ref（ref 供防抖回调与防抖外的同步路径读最新值） */
  const applyFileState = useCallback((next: SqlFileState, doc: string) => {
    fileStateRef.current = next;
    setFileState(next);
    setFileDirty(isFileDirty(next, doc));
  }, []);

  /**
   * T41：宿主通道。
   *
   * 关闭标签 / 退出应用的拦截点在 App，本面板够不到 —— 这里只负责如实上报，
   * 宿主接了就能把「SQL 文件未保存」纳入与表格脏改动同一套拦截口径。
   */
  useEffect(() => {
    propsRef.current.onFileDirtyChange?.(fileDirty, fileState.path);
  }, [fileDirty, fileState.path]);

  /** 真正去打开一个文件（调用前已确认没有未保存改动要问） */
  const doOpenSqlFile = useCallback(async () => {
    const backend = pickBackend();
    let path: string | null = null;
    try {
      path = await backend.sqlFilePick();
    } catch (e) {
      propsRef.current.onToast?.(`打开文件失败：${errText(e)}`);
      return;
    }
    if (path === null) return; // 用户取消 —— 什么都不做，也不动编辑器

    let read: SqlFileReadResult;
    try {
      read = await backend.sqlFileRead(path);
    } catch (e) {
      propsRef.current.onToast?.(`读取失败：${errText(e)}`);
      return;
    }
    const h = handleRef.current;
    if (!h) return;
    /**
     * 🔴 打开 = 只把文件正文装进编辑器，**一步都不执行**。
     *    （「运行 SQL 脚本」是另一条链路：SCRIPT_* + 确认摘要，与本按钮无关。）
     */
    h.setDoc(read.text);
    applyFileState(
      { path: read.path, savedText: read.text, encoding: read.encoding, stamp: read.stamp },
      read.text,
    );
    propsRef.current.onToast?.(`已打开 ${fileDisplayName(read.path)}（内容已载入，未执行）`);
    // 回退解码必须说出来 —— 静默按别的编码解出来等于给用户一份可能不对的文件
    if (read.note) propsRef.current.onToast?.(read.note);
  }, [applyFileState]);

  /**
   * T41：打开入口（带未保存保护）。
   *
   * 有未保存改动时先问「保存 / 不保存 / 取消」，取消就**停在原地** ——
   * 绝不一边问一边把编辑器内容换掉。
   */
  const openSqlFile = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    const decision = unsavedDecision(fileStateRef.current, h.getText(), 'open-another');
    if (decision.kind === 'ask') {
      setUnsavedAsk({ prompt: decision.prompt, go: () => void doOpenSqlFile() });
      return;
    }
    void doOpenSqlFile();
  }, [doOpenSqlFile]);

  /**
   * T41：保存 / 另存为。
   *
   * 返回是否真的写盘成功（供未保存保护里「先保存再继续」判断能不能继续）。
   * 🔴 只写文件，不执行 —— 与「执行」按钮是两条互不相干的链路。
   */
  const saveSqlFile = useCallback(
    async (opts: { saveAs: boolean; force?: boolean }): Promise<boolean> => {
      const h = handleRef.current;
      if (!h) return false;
      const st = fileStateRef.current;
      const content = h.getText();
      const req: SqlFileSaveRequest = {
        // 另存为 → 不给 path，主进程弹保存框
        path: opts.saveAs ? null : st.path,
        content,
        suggestedName: opts.saveAs ? fileDisplayName(st.path) === '未命名' ? 'untitled.sql' : fileDisplayName(st.path) : null,
        // 另存为写的是新目标，谈不上「被外部改过」；force = 用户在冲突弹窗里明确要覆盖
        baseline: opts.saveAs || opts.force === true ? null : st.stamp,
        force: opts.force === true,
      };
      let res: SqlFileSaveResult;
      try {
        res = await pickBackend().sqlFileSave(req);
      } catch (e) {
        propsRef.current.onToast?.(`保存失败：${errText(e)}`);
        return false;
      }
      if (res.conflict) {
        // 🔴 一个字节都没写 —— 先把冲突摆出来（覆盖 / 另存为 / 取消）
        setSaveConflict({ path: res.path, current: res.current });
        return false;
      }
      applyFileState({ path: res.path, savedText: content, encoding: 'utf-8', stamp: res.stamp }, content);
      propsRef.current.onToast?.(`已保存到 ${fileDisplayName(res.path)}（只写文件，未执行）`);
      return true;
    },
    [applyFileState],
  );

  /** T41：工具栏「保存文件」—— 有未保存保护之外的任何动作都不触发 */
  const onSaveClick = useCallback(() => {
    if (fileStateRef.current.path === null) {
      void saveSqlFile({ saveAs: true });
      return;
    }
    void saveSqlFile({ saveAs: false });
  }, [saveSqlFile]);

  /** T41：未保存保护里选了「保存」→ 存盘成功才继续，失败就停在原地 */
  const runAfterSave = useCallback(
    (go: () => void) => {
      void saveSqlFile({ saveAs: false }).then((ok) => {
        if (!ok) return;
        setUnsavedAsk(null);
        go();
      });
    },
    [saveSqlFile],
  );

  /** T41：未保存保护弹窗的三选一 */
  const answerUnsaved = useCallback(
    (choice: UnsavedChoice) => {
      const ask = unsavedAsk;
      if (ask === null) return;
      const r = resolveUnsaved(choice);
      if (r.abort) {
        setUnsavedAsk(null);
        return;
      }
      if (!r.saveFirst) {
        setUnsavedAsk(null);
        ask.go();
        return;
      }
      runAfterSave(ask.go);
    },
    [unsavedAsk, runAfterSave],
  );

  // =========================================================================
  // T42：结果标签的固定 / 重命名 / 关闭其他 / 复制 SQL
  // =========================================================================

  const pinResultTab = useCallback((id: string) => {
    setTabs((prev) => togglePin(prev, id));
  }, []);

  const closeOtherResultTabs = useCallback((id: string) => {
    setTabs((prev) => closeOthers(prev, id));
    setActiveTab(id);
    setTabMenu(null);
  }, []);

  /** 复制产生该结果的语句原文（拿不到剪贴板就明确告知，绝不静默） */
  const copyResultSql = useCallback((tab: ResultTab | null) => {
    setTabMenu(null);
    if (!tab) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      propsRef.current.onToast?.('当前环境不支持写入剪贴板');
      return;
    }
    void navigator.clipboard.writeText(tab.sql).then(
      () => propsRef.current.onToast?.('已复制该结果的 SQL'),
      () => propsRef.current.onToast?.('复制失败：剪贴板不可用'),
    );
  }, []);

  const submitRename = useCallback((id: string, name: string) => {
    setTabs((prev) => renameTab(prev, id, name));
    setRenaming(null);
  }, []);

  const runExplain = useCallback(async () => {
    if (!connId) {
      onToast?.('未选中连接');
      return;
    }
    const h = handleRef.current;
    if (!h) return;
    const docText = h.getDoc();
    const sel = h.selection();
    const expanded = sel.to > sel.from;
    const target = resolveExecution(docText, expanded ? { from: sel.from, to: sel.to } : null);
    if (!target) return;

    // B4 方案取舍：统一直发 EXPLAIN FORMAT=JSON —— 一次查询同时喂「树」「表格」
    // 两个视图（表格视图由 explainJsonToRows 把 JSON 还原回传统 11 列），
    // 不多发第二条 EXPLAIN，也不在工具栏多出一个「EXPLAIN JSON」按钮。
    // 拿不到 JSON（demo 后端/极端老版本）时 ExplainView 自动降级回原始表格。
    const sql = wrapExplain(target.sql.replace(/;\s*$/, ''), { json: true });

    // 定位偏移存【原语句】的偏移（EXPLAIN 前缀不在文档里），B6 定位用
    const spans = statementOffsets(docText, expanded ? { from: sel.from, to: sel.to } : null, target);

    const queryId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    queryIdRef.current = queryId;
    setRunning(true);
    setRunStartedAt(Date.now());
    try {
      const r = await onRun({ connId, sql, database, queryId });
      const tab: ResultTab = {
        id: nextTabId(),
        sql,
        // T42：EXPLAIN 结果同样可固定 / 命名 —— 元数据与普通结果同一形状
        connId,
        database,
        createdAt: Date.now(),
        pinned: false,
        name: null,
        offset: spans[0]?.from ?? null,
        payload: r.payload,
        elapsedMs: r.elapsedMs,
        rowCount: r.rowCount,
        truncated: r.truncated,
        error: null,
        cancelled: r.cancelled,
        explain: true,
        message: '执行计划',
      };
      // T42：EXPLAIN 也走 mergeResults —— 固定项永不被挤掉（与 ⌘R 同一口径）
      setTabs((prev) => mergeResults(prev, [tab]));
      setActiveTab(tab.id);
    } catch (e) {
      onToast?.(`EXPLAIN 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
      setRunStartedAt(null);
      queryIdRef.current = null;
    }
  }, [connId, database, onRun, onToast]);

  /** V17 文案：取消与正常返回要说不同的话（"耗时 xx ms · N 行" 对取消没有意义） */
  const elapsedText = useMemo<string | null>(() => {
    const r = props.lastRun !== undefined ? props.lastRun : lastRun;
    if (r === null || r === undefined) return null;
    if (r.cancelled) return `已取消 · ${r.elapsedMs} ms`;
    return `耗时 ${r.elapsedMs} ms · ${formatCount(r.rowCount)} 行`;
  }, [props.lastRun, lastRun]);

  const toggleComment = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    const sel = h.selection();
    const r = toggleLineComment(h.getDoc(), sel.from, sel.to);
    h.setDoc(r.text);
  }, []);

  /**
   * T28：右键菜单动作分派。
   *
   * 每一项都有真实回调（红线 1）—— 没有回调的项在上游 `buildSqlContextMenu`
   * 里就是 `enabled=false` + 中文原因，**根本不会走到这里**，不存在「点了没反应」。
   */
  const runMenuAction = useCallback(
    (id: SqlMenuActionId) => {
      setCtxMenu(null);
      const h = handleRef.current;
      switch (id) {
        case 'sql-run-all':
          void execute('all');
          return;
        case 'sql-run-selection':
          void execute('selection');
          return;
        case 'sql-explain':
          void runExplain();
          return;
        case 'sql-format':
          h?.format();
          return;
        case 'sql-comment':
          toggleComment();
          return;
        case 'sql-cut':
          void h?.cut();
          return;
        case 'sql-copy':
          void h?.copy();
          return;
        case 'sql-paste':
          void h?.paste();
          return;
      }
    },
    [execute, runExplain, toggleComment],
  );

  /** B1：保存片段入口。空编辑器没有可保存的内容 —— 直接提示，不弹空对话框 */
  const openSnippetSave = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    if (!h.getText().trim()) {
      onToast?.('编辑器为空，没有可保存的内容');
      return;
    }
    setSnippetOpen(true);
  }, [onToast]);

  /**
   * T12：宿主 ⌘S 投递的「保存为片段」请求。
   *
   * 只在递增值变化时开门；初值 0 不触发（挂载时不许自动弹窗）。
   * 依赖里带 openSnippetSave 是必须的 —— 它读 handleRef 拿编辑器原文，
   * 闭包过期会导致"空编辑器也能保存"。
   */
  useEffect(() => {
    if ((props.snippetSaveSignal ?? 0) > 0) openSnippetSave();
  }, [props.snippetSaveSignal, openSnippetSave]);

  /** B7：把结果页签的语句原文 + 列元数据交给宿主的导出流程 */
  const exportResult = useCallback((tab: ResultTab) => {
    if (!tab.payload) return;
    // 列式载荷只带 typeCode —— 映射成可读类型名；精确的 MySQL 列类型
    // 在 schema 层，结果集载荷刻意不携带（见 core-ipc-codec 的设计）
    propsRef.current.onExportResult?.({
      sql: tab.sql,
      database: propsRef.current.database ?? null,
      columns: tab.payload.columns.map((c) => ({ name: c.name, dataType: TYPE_NAMES[c.typeCode] ?? '' })),
    });
  }, []);

  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0] ?? null;

  return (
    <div className="sql-editor">
      <div className="sql-toolbar">
        {/* T29：按钮 1 的可见文案必须自己说清是「全部」——
            早先它只写「▶ 执行 ⌘R」，与右边那个「执行当前语句」并排时
            用户根本分不出哪个跑全部（这正是 T29 要修的问题点）。
            ⚠️ e2e 曾用精确文本 /^▶ 执行 ⌘R$/ 点它 —— 那等于让测试文案绑死 UI，
            现已改为 data-testid（语义钩子），文案可以按需求自由演进。 */}
        <button
          className="primary"
          onClick={() => void execute('all')}
          disabled={running || !connId}
          aria-label={scope.runAll}
          data-testid="sql-run-all"
          title={`${scope.runAll}：运行编辑器中的所有语句`}
        >
          {`▶ ${scope.runAll} ${displayOf('sql-run-all') ?? '⌘R'}`}
        </button>
        {/* T29：⌘⏎ 的执行对象随选区实时改名 —— 无选区时叫「执行当前语句」，不叫「执行选中」 */}
        <button
          onClick={() => void execute('selection')}
          disabled={running || !connId}
          title={`${scope.runSelection}：有选区时执行选中内容，无选区时执行光标所在的那条语句`}
          data-testid="sql-run-selection"
        >
          {`${scope.runSelection} ${displayOf('sql-run-selection') ?? '⌘⏎'}`}
        </button>
        <button
          onClick={() => void runExplain()}
          disabled={running || !connId}
          data-testid="sql-run-explain"
        >
          {`${scope.explain} ${displayOf('sql-explain') ?? '⇧⌘X'}`}
        </button>
        <button onClick={() => void cancel()} disabled={!running}>
          {`取消 ${displayOf('sql-cancel') ?? '⌘.'}`}
        </button>
        {/* T41：SQL 文件三件套（打开 / 另存为 / 保存）—— 只操作文件，绝不执行 */}
        <button onClick={openSqlFile} title={OPEN_BUTTON_TITLE} data-testid="sql-open-file">
          <IconFolder size={11} /> 打开文件
        </button>
        <button
          onClick={() => void saveSqlFile({ saveAs: true })}
          title={SAVE_AS_BUTTON_TITLE}
          data-testid="sql-save-as-file"
        >
          另存为
        </button>
        <button
          onClick={onSaveClick}
          title={SAVE_BUTTON_TITLE}
          data-testid="sql-save-file"
        >
          <IconSave size={11} /> {saveButtonLabel(fileState, fileDirty)}
        </button>
        {/* T41：文件状态徽标 —— 草稿 / 文件名 / 未保存，让用户知道内容属于谁 */}
        <span
          data-testid="sql-file-badge"
          data-dirty={fileDirty ? '1' : '0'}
          data-has-file={fileState.path !== null ? '1' : '0'}
          style={{
            whiteSpace: 'nowrap',
            fontSize: 10,
            color: 'var(--text-dim)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 6px',
            background: 'var(--bg-alt)',
          }}
        >
          {fileBadgeText(fileState, fileDirty)}
        </span>
        <button
          onClick={openSnippetSave}
          disabled={running}
          title="把当前编辑器内容存为可复用的 SQL 片段"
          data-testid="sql-save-snippet"
        >
          <IconSave size={11} /> 保存片段
        </button>
        {/* S1：格式化。只在这里 / ⌘I / 右键菜单触发 —— 绝不在 change 时自动跑 */}
        <button
          onClick={() => handleRef.current?.format()}
          title="格式化当前语句或选区（⌘I）"
          data-testid="sql-format"
        >
          <IconBraces size={11} /> 格式化 ⌘I
        </button>
        {onDatabaseChange && databases.length > 0 ? (
          <select
            className="sql-db-select"
            value={database ?? ''}
            onChange={(e) => onDatabaseChange(e.target.value || null)}
            title="查询目标库（左树选中库 / 表标签所在库；未指定库时请用库名限定表名）"
            data-testid="sql-db-select"
          >
            <option value="">（未指定库）</option>
            {databases.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        ) : null}
        {/* T29：⌘⏎ 此刻会执行哪个对象（全部在按钮 1，这里区分「当前语句 / 选中」） */}
        <span
          data-testid="sql-exec-target"
          title={`⌘⏎（${displayOf('sql-run-selection') ?? '⌘⏎'}）的执行对象；⌘R 执行全部语句`}
          style={{
            whiteSpace: 'nowrap',
            fontSize: 10,
            color: 'var(--text-dim)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 6px',
            background: 'var(--bg-alt)',
          }}
        >
          {`执行对象：${scope.hint}`}
        </span>
        {/* T29：这条 SQL 会发往哪个连接、哪个环境 —— 生产环境用红底突出 */}
        <span
          data-testid="sql-conn-target"
          data-production={connTarget.production ? '1' : '0'}
          title={
            connTarget.known
              ? `执行目标连接：${connTarget.name}${connTarget.environment ? ` · ${connTarget.environment}` : ''}`
              : '未能从连接列表匹配到该连接，仅显示连接 id'
          }
          style={{
            whiteSpace: 'nowrap',
            fontSize: 10,
            borderRadius: 4,
            padding: '1px 6px',
            border: `1px solid ${connTarget.production ? 'var(--error-bar)' : 'var(--border)'}`,
            background: connTarget.production ? 'var(--error-bg)' : 'var(--bg-alt)',
            color: connTarget.production ? 'var(--error-bar)' : 'var(--text-dim)',
          }}
        >
          {`${connTarget.production ? '⚠ ' : ''}${connTarget.name}${connTarget.environment ? ` · ${connTarget.environment}` : ''}`}
        </span>
        <span className="spacer" />
        {running ? (
          <span className="sql-running">
            <span className="spinner" />
            执行中 {(elapsedNow / 1000).toFixed(1)}s
          </span>
        ) : null}
        {props.readOnlyConn ? <span className="tag-readonly">只读连接</span> : null}
      </div>

      {timeoutPrompt ? (
        <div className="banner warn sql-timeout">
          <span>查询已运行超过 30 秒，仍在继续。</span>
          <button onClick={() => setTimeoutPrompt(false)}>继续等待</button>
          <button className="primary" onClick={() => { setTimeoutPrompt(false); void cancel(); }}>
            取消执行
          </button>
        </div>
      ) : null}

      <div className="sql-host" ref={hostRef}>
        {coreLoading ? <div className="sql-loading">编辑器载入中…</div> : null}
        {/* V17：内联耗时。绝对定位浮在编辑器右下角 —— 不占流内空间，
            也就不会把编辑器高度挤掉（.sql-host 是 flex 0 0 38%） */}
        {!running && elapsedText !== null ? (
          <span className="sql-elapsed" data-testid="sql-elapsed" title="最近一次执行的耗时与返回行数">
            {elapsedText}
          </span>
        ) : null}
      </div>

      {/* S1：编辑器右键菜单。刻意放在 .sql-host 外面 —— 它是 position: fixed，
          而 .sql-host 有 overflow:hidden，万一某层祖先出现 transform 形成
          包含块，菜单就会被裁掉。挂到 .sql-editor 这一层最稳。 */}
      {ctxMenu !== null ? (
        <EditorContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSelection={ctxMenu.hasSelection}
          hasText={ctxMenu.hasText}
          connected={connId !== null}
          running={running}
          onAction={runMenuAction}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}

      <div className="sql-results">
        {tabs.length > 0 ? (
          <div className="sql-tabs" data-testid="sql-result-tabs">
            {/*
              T42：固定项排前面（displayOrder）—— 固定不只是不被淘汰，
              还要不被横向滚动挤到看不见。渲染顺序即 displayOrder 的输出。
            */}
            {displayOrder(tabs).map((t) => (
              <div
                key={t.id}
                className={`sql-tab${t.id === active?.id ? ' active' : ''}${t.error ? ' errored' : ''}${t.pinned ? ' pinned' : ''}`}
                onClick={() => setActiveTab(t.id)}
                onContextMenu={(e) => {
                  // T42：标签右键 = 固定 / 重命名 / 关闭其他 / 复制 SQL（低频，不抢焦点语义）
                  e.preventDefault();
                  setActiveTab(t.id);
                  setTabMenu({ x: e.clientX, y: e.clientY, id: t.id });
                }}
                title={describeResultOrigin({
                  sql: t.sql,
                  connectionName: describeConnectionTarget(connections, t.connId).known
                    ? describeConnectionTarget(connections, t.connId).name
                    : t.connId ?? '',
                  database: t.database,
                  createdAt: t.createdAt,
                  elapsedMs: t.elapsedMs,
                  rowCount: t.rowCount,
                })}
                data-testid={`sql-result-tab-${t.id}`}
                data-pinned={t.pinned ? '1' : '0'}
              >
                {t.pinned ? <IconStarFilled size={9} /> : null}
                {renaming === t.id ? (
                  <input
                    className="sql-tab-rename"
                    autoFocus
                    defaultValue={t.name ?? ''}
                    placeholder="重命名（留空 = 回到自动标题）"
                    onKeyDown={(e) => {
                      if (isImeComposing(e)) return;
                      if (e.key === 'Enter') submitRename(t.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={(e) => submitRename(t.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="sql-tab-title">
                    {/* T42：标题优先级 = 自定义名 > 执行计划/失败 > 行数（纯函数已钉死） */}
                    {resultTabTitle(t, { rowCount: t.rowCount, explain: t.explain, error: t.error })}
                  </span>
                )}
                <button
                  className="sql-tab-close"
                  title={running ? '执行中暂不可关闭' : '关闭此结果'}
                  disabled={running}
                  data-testid={`sql-result-close-${t.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeResultTab(t.id);
                  }}
                >
                  <IconX size={9} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* T42：结果标签右键菜单（固定 / 重命名 / 关闭其他 / 复制 SQL） */}
        {tabMenu !== null ? (
          <ResultTabMenu
            x={tabMenu.x}
            y={tabMenu.y}
            tab={tabs.find((t) => t.id === tabMenu.id) ?? null}
            running={running}
            onPin={pinResultTab}
            onRename={(id) => {
              setTabMenu(null);
              setRenaming(id);
            }}
            onCloseOthers={closeOtherResultTabs}
            onCopySql={copyResultSql}
            onClose={() => setTabMenu(null)}
          />
        ) : null}

        {active ? (
          <>
            <div className="sql-message">
              <span>{active.message}</span>
              {/* F6 核对：行数与耗时本就在这里展示（「返回 N 行」+ ms 徽标），维持不动 */}
              {active.elapsedMs > 0 ? (
                <span className={active.elapsedMs > 5000 ? 'dur bad' : active.elapsedMs > 1000 ? 'dur warn' : 'dur'}>
                  {active.elapsedMs}ms
                </span>
              ) : null}
              {active.truncated ? <span className="dur warn">结果已截断</span> : null}
              {props.onExportResult && active.payload && !active.error ? (
                <button
                  className="sql-mini-btn"
                  title="导出此结果集（携带语句原文与列元数据）"
                  data-testid={`sql-export-result-${active.id}`}
                  onClick={() => exportResult(active)}
                >
                  <IconExport size={11} /> 导出
                </button>
              ) : null}
              {props.onOpenEditableResult && active.source && connId ? (
                <button
                  className="sql-mini-btn"
                  title={
                    `只打开源表 ${active.source.table} 本身 —— 不继承这条查询的 WHERE / ORDER BY / LIMIT。` +
                    '先在结果里点一行，再点这里可定位到那一行（按主键/唯一键等值筛选）。'
                  }
                  data-testid="sql-open-editable"
                  onClick={() =>
                    props.onOpenEditableResult?.({
                      connId,
                      database: active.source!.database ?? database ?? '',
                      table: active.source!.table,
                      // 没点过行 = 不传 locate（宿主据此不做定位，而不是猜第一行）
                      locate: lastRowRef.current[active.id],
                    })
                  }
                >
                  打开源表
                </button>
              ) : null}
            </div>
            {active.error ? (
              <div className="banner warn sql-error-banner">
                <span className="sql-error-text">{active.error}</span>
                {active.offset !== null ? (
                  <button
                    className="sql-locate-link"
                    title="滚动编辑器到这条语句（不重新执行）"
                    data-testid="sql-locate-statement"
                    onClick={() => handleRef.current?.revealOffset(active.offset as number)}
                  >
                    定位到语句
                  </button>
                ) : null}
              </div>
            ) : null}
            {active.payload ? (
              active.explain ? (
                <ExplainView payload={active.payload} injectorKey={props.injectorKey} onToast={onToast} />
              ) : (
                /* A20：单表查询（主进程 extractSingleTable 检测出 source）时把库表
                   上下文传给网格 —— INSERT 复制可用；UPDATE 因结果集没有定位列
                   元数据保持禁用。检测不出（JOIN/聚合/非 SELECT）→ 静默降级 */
                <ResultGrid
                  payload={active.payload}
                  database={active.source?.database ?? database ?? undefined}
                  tableName={active.source?.table}
                  sortable={false}
                  onToast={onToast}
                  // T33：值查看 —— ResultGrid 内部用 source.raw 读原值（与原字节一致），
                  // 面板只收已经解好的 ResultCellRef（见 ResultGrid 的 onInspectCell 装配）
                  onInspectCell={(cell) => setCellModal(cell)}
                  // T39：记住用户点过的那一行（点「打开源表」时用它做行定位）。
                  // 取值在 ResultGrid 内部完成 —— 它手里才有 GridDataSource（raw 读原值）。
                  onRowActivated={(values) => {
                    lastRowRef.current[active.id] = values;
                  }}
                />
              )
            ) : null}
          </>
        ) : (
          <div className="empty-hint">
            {`${displayOf('sql-run-all') ?? '⌘R'} 执行，${displayOf('sql-explain') ?? '⇧⌘X'} 查看执行计划`}
          </div>
        )}
      </div>

{snippetOpen ? (
        <SnippetSaveDialog
          sql={handleRef.current?.getText() ?? ''}
          // v0.6.0：片段按（连接, 库）归属 —— 归属从编辑器上下文取，不让用户手填
          connectionId={connId}
    database={database ?? null}
   onClose={() => setSnippetOpen(false)}
          onSaved={(name) => {
    setSnippetOpen(false);
    onToast?.(`已保存片段 ${name}`);
          }}
     />
      ) : null}

      {/* T41：未保存保护弹窗（保存 / 不保存 / 取消 —— 取消停在原地，绝不换内容） */}
      {unsavedAsk !== null ? (
        <div className="modal-overlay" role="dialog" data-testid="sql-unsaved-ask">
          <div className="modal">
            <h3>{unsavedAsk.prompt.title}</h3>
            <p className="modal-note">{unsavedAsk.prompt.detail}</p>
            <div className="modal-actions">
              {unsavedAsk.prompt.choices.map((c) => (
                <button
                  key={c.id}
                  className={c.primary ? 'primary' : ''}
                  data-testid={`sql-unsaved-${c.id}`}
                  onClick={() => answerUnsaved(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* T41：保存冲突（文件被外部改过）—— 覆盖 / 另存为 / 取消，绝不静默覆盖 */}
      {saveConflict !== null ? (
        <div className="modal-overlay" role="dialog" data-testid="sql-save-conflict">
          <div className="modal">
            <h3>文件在磁盘上已被修改</h3>
            <p className="modal-note">
              {saveConflict.path}
              {saveConflict.current
                ? `（磁盘版本：${new Date(saveConflict.current.mtimeMs).toLocaleString('zh-CN')} · ${saveConflict.current.size} 字节）`
                : ''}
              —— 一个字节都还没写。覆盖会丢掉外部改动。
            </p>
            <div className="modal-actions">
              <button
                className="primary"
                data-testid="sql-conflict-overwrite"
                onClick={() => {
                  const p = saveConflict.path;
                  setSaveConflict(null);
                  void saveSqlFile({ saveAs: false, force: true }).then((okDone) => {
                    if (okDone) onToast?.(`已覆盖 ${fileDisplayName(p)}`);
                  });
                }}
              >
                覆盖磁盘版本
              </button>
              <button
                data-testid="sql-conflict-saveas"
                onClick={() => {
                  setSaveConflict(null);
                  void saveSqlFile({ saveAs: true });
                }}
              >
                另存为新文件
              </button>
              <button data-testid="sql-conflict-cancel" onClick={() => setSaveConflict(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* T33：结果网格「查看完整值」—— 与表网格共用同一个值查看器 */}
      {cellModal !== null ? (
        <CellValueModal
          cell={{ row: cellModal.row, col: cellModal.col, column: cellModal.column, value: cellModal.value }}
          // 🔴 结果网格没有表结构：columns 传空（见 resultCell.resultDisplayTable 的红线注释）
          table={resultDisplayTable(active?.source ?? null)}
          database={resultDisplayDatabase(active?.source ?? null, database)}
          onClose={() => setCellModal(null)}
          onToast={onToast}
          // T31/T32：结果网格只读 —— pending 不传（弹窗如实说「未提供待提交值」），
          // editable 不传（没有写脏格链路，不给假按钮）
        />
      ) : null}
    </div>
  );
}

/**
 * T42：结果标签右键菜单。
 *
 * 四项都有真实回调（红线 1）；「关闭其他」在执行中禁用（关闭按钮同口径）。
 * 键盘可达性走 useMenuBehavior（T18 同一套：Esc 关闭、↑↓ 巡航、视口钳制）。
 */
function ResultTabMenu({
  x,
  y,
  tab,
  running,
  onPin,
  onRename,
  onCloseOthers,
  onCopySql,
  onClose,
}: {
  x: number;
  y: number;
  tab: ResultTab | null;
  running: boolean;
  onPin: (id: string) => void;
  onRename: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCopySql: (tab: ResultTab | null) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMenuBehavior({ rootRef, x, y, onClose });
  if (tab === null) return null;
  return (
    <div className="ctx-menu" ref={rootRef} role="menu" style={{ left: x, top: y }} data-testid="sql-tab-menu">
      <button
        className="ctx-item"
        role="menuitem"
        data-testid="sql-tab-pin"
        onClick={() => {
          onPin(tab.id);
          onClose();
        }}
      >
        <span className="ctx-label">{tab.pinned ? '取消固定' : '固定此结果'}</span>
        <span className="ctx-shortcut">📌</span>
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        data-testid="sql-tab-rename"
        onClick={() => onRename(tab.id)}
      >
        <span className="ctx-label">重命名…</span>
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        data-testid="sql-tab-close-others"
        disabled={running}
        title={running ? '执行中暂不可关闭' : '保留此结果与所有已固定结果'}
        onClick={() => onCloseOthers(tab.id)}
      >
        <span className="ctx-label">关闭其他</span>
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        data-testid="sql-tab-copy-sql"
        onClick={() => onCopySql(tab)}
      >
        <span className="ctx-label">复制这条 SQL</span>
      </button>
    </div>
  );
}

// ---------- 结果网格（复用 §6.3 网格能力） ----------

function ResultGrid({
  payload,
  database,
  tableName,
  sortable,
  onToast,
  onInspectCell,
  onRowActivated,
}: {
  payload: ColumnarPayload;
  database?: string;
  /** A20：单表查询的源表名（QueryOutcomeDto.source），无则 INSERT 复制静默降级 */
  tableName?: string;
  sortable?: boolean;
  onToast?: (msg: string) => void;
  /** T33：值查看回调（面板传入；读值走 buildResultInspectHandler → source.raw） */
  onInspectCell?: (cell: ResultCellRef) => void;
  /** T39：用户点了一行 → 回传该行原始值（面板存起来做「打开源表」的行定位） */
  onRowActivated?: (values: ResultRowValue[]) => void;
}) {
  const source = useGridDataSource(payload);
  const columns = useMemo<GridColumn[]>(
    () =>
      payload.columns.map((c) => ({
        name: c.name,
        // 列定义只带 typeCode（载荷设计如此），展示成可读名即可 ——
        // 网格的 dataType 只用于 tooltip，不影响渲染
        dataType: TYPE_NAMES[c.typeCode] ?? '',
        width: 160,
      })),
    [payload],
  );
  /**
   * T33：检视回调只在 source 与宿主回调都就绪时装配 ——
   * buildResultInspectHandler 返回的 onInspectCell 是**必填**类型，
   * 谁漏了接线编译期就红（这正是 resultCell.ts 的设计意图）。
   */
  const inspect = useMemo(
    () => (source && onInspectCell ? buildResultInspectHandler(source, onInspectCell) : null),
    [source, onInspectCell],
  );
  if (!source) return null;
  // V1：查询结果网格是只读的（写入口只走「在表格中打开」→ 表 tab）。
  // ⌘V / ⌘⌫ 此前被静默吃掉 —— 用户按键毫无反应。这里给明确出口提示，
  // 把"下一个动作该去哪"告诉用户，而不是假装按键不存在。
  const readonlyHint = () =>
    onToast?.('查询结果网格只读，「在表格中打开」后即可编辑/粘贴/删除');
  return (
    <DataGrid
      source={source}
      columns={columns}
      editable={false}
      database={database}
      tableName={tableName}
      sortable={sortable}
      sorts={[]}
      onSortChange={() => undefined}
      onSave={() => undefined}
      onCopy={() => undefined}
      onPaste={readonlyHint}
      onDeleteRows={readonlyHint}
      onCellEdited={() => undefined}
      onInspectCell={inspect?.onInspectCell}
      // T39：点击即记住这一行（只在面板接了 onRowActivated 时才取值）
      onCellActivated={
        onRowActivated
          ? (row) => {
              const values = readResultRow(source, row);
              if (values) onRowActivated(values);
            }
          : undefined
      }
    />
  );
}

/**
 * S1 / T28 编辑器右键菜单。
 *
 * 为什么由 React 渲染而不是在 CodeMirror 里拼 DOM：菜单要复用既有
 * `.ctx-menu / .ctx-item` 样式（与树、网格右键同一族），内核那边只负责拦下
 * 原生菜单并上报坐标 —— 样式归 styles.css，行为归这里，职责不混。
 *
 * 关闭三件套：点外面、按 Esc、点菜单项。缺一个都会留下一个关不掉的浮层。
 *
 * T28：菜单项**由纯函数 `buildSqlContextMenu` 产出**（可单测），这里只负责：
 *  - 按 `group` 插分隔线；
 *  - 把动作 id 映射成快捷键文案（目录优先，主机键本地兜底）；
 *  - 渲染 `disabled` + `title`（红线 1：禁用必须给原因）；
 *  - 点击后 `onAction(id)` 并关闭。
 */
function EditorContextMenu({
  x,
  y,
  hasSelection,
  hasText,
  connected,
  running,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  hasSelection: boolean;
  hasText: boolean;
  connected: boolean;
  running: boolean;
  onAction: (id: SqlMenuActionId) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 🔴 T18（报告 §4.5）：**改用与树/网格/单元格菜单同一套行为**。
   *
   * 这里原是四份各写一遍的关闭逻辑里最弱的一份：没有视口内收敛（贴右缘/底缘弹出会
   * 被裁切）、没有 resize/失焦关闭、没有键盘巡航。菜单项少的时候看不出来，
   * 一旦补到 5~6 项（见 T28）就会立刻暴露。
   */
  // 剪贴板可用性在开门这一刻探测即可 —— 能力是环境属性，不会在菜单开着时变化
  const clipboardAvailable = typeof navigator !== 'undefined' && !!navigator.clipboard;
  const items = buildSqlContextMenu({ hasSelection, hasText, connected, running, clipboardAvailable });
  const pos = useMenuBehavior({ rootRef, x, y, onClose, reclampKey: items.length });

  return (
    <div
      className="ctx-menu"
      ref={rootRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      data-testid="sql-editor-ctx-menu"
    >
      {items.map((item, i) => {
        // 分组之间插分隔线（复用 .ctx-sep，不新增 CSS）
        const sepBefore = i > 0 && items[i - 1].group !== item.group;
        return (
          <Fragment key={item.id}>
            {sepBefore ? <div className="ctx-sep" /> : null}
            <button
              className="ctx-item"
              role="menuitem"
              data-testid={`sql-editor-ctx-${item.id}`}
              disabled={!item.enabled}
              title={item.enabled ? undefined : item.disabledReason ?? undefined}
              onClick={() => {
                onAction(item.id);
                onClose();
              }}
            >
              <span className="ctx-label">{item.label}</span>
              {item.enabled ? (
                <span className="ctx-shortcut">{shortcutOfMenuAction(item.id)}</span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * 菜单项右侧键位提示。
 *
 * 前五个动作（执行/计划/格式化/注释）的键位**必须**从动作目录取 —— 手写一份
 * 迟早与裁定漂移（action-catalog 头注释点名过这类事故）。剪切/复制/粘贴是主机键，
 * 不在目录里，用本地常量兜底。
 */
const CLIPBOARD_SHORTCUT: Partial<Record<SqlMenuActionId, string>> = {
  'sql-cut': '⌘X',
  'sql-copy': '⌘C',
  'sql-paste': '⌘V',
};

function shortcutOfMenuAction(id: SqlMenuActionId): string | null {
  return displayOf(id) ?? CLIPBOARD_SHORTCUT[id] ?? null;
}

/**
 * EXPLAIN 专用视图（§6.4.3：type=ALL 标红，Extra 告警标黄；B4：表格/树双模式）。
 *
 * 数据源只有一份：`EXPLAIN FORMAT=JSON` 的结果（runExplain 统一直发）。
 *  - 树模式：buildExplainTree 解析 JSON plan 成通用树
 *  - 表格模式：explainJsonToRows 把 JSON 还原回传统 11 列，沿用原有上色
 *  - 拿不到/解析不了 JSON（demo 后端、异常输出）→ 降级为原始表格，
 *    若确有 JSON 文本但解析失败则 toast 提示
 */
function ExplainView({
  payload,
  injectorKey,
  onToast,
}: {
  payload: ColumnarPayload;
  injectorKey?: string;
  onToast?: (msg: string) => void;
}) {
  // 视图选择按面板记忆（localStorage 以注入键区分面板）
  const [mode, setMode] = useState<ExplainViewMode>(() => readExplainMode(injectorKey));
  const changeMode = useCallback(
    (m: ExplainViewMode) => {
      setMode(m);
      writeExplainMode(injectorKey, m);
    },
    [injectorKey],
  );

  const parsed = useMemo<{
    /** 解析出的树；拿不到 JSON 或解析失败为 null */
    tree: ExplainNode[] | null;
    /** 表格行：JSON 还原的 11 列，或降级的原始行 */
    rows: Record<string, unknown>[];
    cols: string[];
    degraded: boolean;
    /** 非 null 表示「确有 JSON 文本但解析失败」，要 toast */
    parseError: string | null;
  }>(() => {
    const raw = materializeSmall(payload);
    const base = { tree: null, rows: raw, cols: payload.columns.map((c) => c.name), degraded: true, parseError: null };
    // FORMAT=JSON 的结果是单行单列，列值是 JSON 文本。按「第一个长得像 JSON
    // 对象的字符串」找，不写死列名 —— 驱动对该列的命名不完全一致
    let planText: string | null = null;
    if (raw.length === 1) {
      for (const v of Object.values(raw[0])) {
        if (typeof v === 'string' && v.trimStart().startsWith('{')) {
          planText = v;
          break;
        }
      }
    }
    if (planText === null) return base;
    try {
      const tree = buildExplainTree(planText);
      return {
        tree,
        rows: explainJsonToRows(planText),
        cols: [...EXPLAIN_COLUMNS],
        degraded: false,
        parseError: null,
      };
    } catch (e) {
      return { ...base, parseError: `执行计划 JSON 解析失败，已回退表格：${e instanceof Error ? e.message : String(e)}` };
    }
  }, [payload]);

  // 解析失败 toast（同一次 payload 只报一次）
  useEffect(() => {
    if (parsed.parseError) onToast?.(parsed.parseError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.parseError]);

  const showTree = mode === 'tree' && parsed.tree !== null;

  return (
    <div className="explain-view">
      <div className="sql-explain-header">
        <button
          className={`sql-mini-btn${mode === 'table' ? ' active' : ''}`}
          onClick={() => changeMode('table')}
          data-testid="sql-explain-table-mode"
        >
          表格
        </button>
        <button
          className={`sql-mini-btn${showTree ? ' active' : ''}`}
          onClick={() => changeMode('tree')}
          disabled={!parsed.tree}
          title={parsed.tree ? '树形执行计划' : '当前结果没有可解析的 JSON 计划'}
          data-testid="sql-explain-tree-mode"
        >
          树
        </button>
        {showTree ? <span className="sql-explain-hint">缩进 = 执行嵌套层级</span> : null}
      </div>
      {showTree && parsed.tree ? (
        <div className="sql-explain-tree">
          {parsed.tree.map((n, i) => (
            <ExplainTreeNode key={i} node={n} />
          ))}
        </div>
      ) : (
        <ExplainTable rows={parsed.rows} cols={parsed.cols} />
      )}
    </div>
  );
}

/** EXPLAIN 传统表格（降级时渲染原始列，正常时渲染还原的 11 列） */
function ExplainTable({ rows, cols }: { rows: Record<string, unknown>[]; cols: string[] }) {
  return (
    <>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c];
                const cell = explainCell(c, v);
                return (
                  <td key={c} className={cell.level === 'ok' ? '' : cell.level} title={cell.reasons.join(' / ')}>
                    {v === null || v === undefined ? 'NULL' : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="explain-legend">列顺序：{EXPLAIN_COLUMNS.join(' / ')}</div>
    </>
  );
}

/** 树节点渲染：缩进表嵌套，accessType 上色（ALL 红 / index 黄 / 其余蓝） */
const ACCESS_BADGE_CLASS: Record<string, string> = {
  ALL: 'sql-access-all',
  INDEX: 'sql-access-index',
};

function ExplainTreeNode({ node }: { node: ExplainNode }) {
  const badge = node.accessType?.toUpperCase() ?? null;
  const badgeClass = badge ? (ACCESS_BADGE_CLASS[badge] ?? 'sql-access-other') : null;
  return (
    <div className="sql-explain-node">
      <div className="sql-node-row">
        {badge && badgeClass ? <span className={`sql-access-badge ${badgeClass}`}>{badge}</span> : null}
        <span className="sql-node-title">{node.title}</span>
        {node.cost ? <span className="sql-node-cost">cost {node.cost}</span> : null}
        {node.detail.length > 0 ? (
          <div className="sql-node-detail">
            {node.detail.map((d, i) => (
              <span key={i}>
                {i > 0 ? ' · ' : null}
                {/* filesort/temporary/join buffer 是要动手优化的信号，黄显 */}
                <span
                  className={
                    d.startsWith('Using filesort') || d.startsWith('Using temporary') || d.startsWith('Using join buffer')
                      ? 'sql-warn-text'
                      : undefined
                  }
                >
                  {d}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <div className="sql-node-kids">
          {node.children.map((c, i) => (
            <ExplainTreeNode key={i} node={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * B1 保存片段对话框（轻量内联，浮在本面板上）。
 *
 * Enter 提交、Esc 取消；重名 = 覆盖（**同一连接 + 同一库**内同名即覆盖，
 * 主进程 HistoryStore 的语义，已在输入框说明文案里注明）。
 * 保存失败把错误显示在对话框内 —— 关掉就丢了错误不友好。
 *
 * v0.6.0：归属维度（连接/库）由编辑器上下文带入，用户不填；
 * 名称上限 25 个**汉字**（按码点计，见 core-history 的 isValidSnippetName）。
 */
function SnippetSaveDialog({
  sql,
  connectionId,
  database,
  onClose,
  onSaved,
}: {
  sql: string;
  connectionId?: string | null;
  database?: string | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 实时字数（超限时禁提交并给出提示，不必等用户点保存才报错）
  const nameLen = [...name.trim()].length;
  const tooLong = nameLen > SNIPPET_NAME_MAX;

  const submit = useCallback(async () => {
    const n = name.trim();
  if (!n) {
      setError('请填写片段名称');
      return;
    }
  if (!isValidSnippetName(n)) {
    setError(snippetNameTooLongMessage(n));
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await pickBackend().snippetSave({
     name: n,
        sql,
    description: description.trim() || null,
        connectionId: connectionId ?? '',
     database: database ?? '',
    });
   onSaved(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [name, description, saving, sql, onSaved, connectionId, database]);

  // 全局捕获 Enter/Esc：焦点不在输入框上（比如刚点了别处）时快捷键依然可用
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, submit]);

  return (
    <div
      className="sql-dialog-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sql-dialog" role="dialog" aria-label="保存片段" data-testid="sql-snippet-dialog">
<div className="sql-dialog-title">保存片段</div>
        <div className="sql-dialog-field">
     <span>归属：{database || '未指定库'}</span>
        </div>
      <label className="sql-dialog-field">
          <span>
 名称（必填；写「这段 SQL 干什么用」，同一库内重名将覆盖已有片段）
     </span>
          <input
    autoFocus
     value={name}
         onChange={(e) => setName(e.target.value)}
 placeholder="如：按状态统计订单"
   data-testid="sql-snippet-name"
          />
{/* 字数按码点计（中文/emoji 都算 1 个），超限即禁用保存 */}
    <em className={tooLong ? 'sql-dialog-count over' : 'sql-dialog-count'}>
    {nameLen} / {SNIPPET_NAME_MAX}
     </em>
     </label>
        <label className="sql-dialog-field">
          <span>描述（可选）</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这段 SQL 做什么用"
          />
        </label>
        {error ? <div className="sql-dialog-error">{error}</div> : null}
        <div className="sql-dialog-actions">
          <button onClick={onClose} disabled={saving}>
            取消
          </button>
<button className="primary" onClick={() => void submit()} disabled={saving || !name.trim() || tooLong}>
     {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * EXPLAIN 结果全量物化。
 *
 * 只有这里敢全量解 —— EXPLAIN 最多几行，不是网格那条 5 万行的热路径。
 * 顺带加个上限：万一用户拿 EXPLAIN 跑了张巨大的派生表，也不该把 UI 撑爆。
 */
function materializeSmall(payload: ColumnarPayload, cap = 200): Record<string, unknown>[] {
  const reader = new ColumnarReader(payload);
  const n = Math.min(reader.rowCount, cap);
  const out: Record<string, unknown>[] = [];
  for (let r = 0; r < n; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < reader.columnCount; c++) {
      row[reader.columnName(c)] = reader.decodeCell(r, c);
    }
    out.push(row);
  }
  return out;
}
