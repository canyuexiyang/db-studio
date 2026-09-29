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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseMeta } from '@dbstudio/core-schema-cache';
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
import { IconX, IconSave, IconExport, IconBraces } from '../ui/icons';
// S3：收藏表名（与树、⌘K 命令面板同构的 `${connId}:${db}:${table}` 键）
import { loadFavorites } from '../tree/favorites';
// 契约 §一.1：组件自取后端（demo 降级天然可用），不依赖 App 传 props
import { pickBackend } from '../backend';


// 🔴 只在这里 import【类型】，值一律走 lazyCodemirror()
import type { SqlEditorHandle } from './SqlEditorCore';

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
   * A12：结果集来自单表 SELECT 时提供「打开可编辑表格」入口。
   * 宿主侧复用既有开表链路（schemaGetTable 拿 PK 定位元数据 → 表格 tab），
   * 写回仍走逐条 SQL 预演红线。宿主未接时按钮隐藏。
   */
  onOpenEditableResult?: (req: { connId: string; database: string; table: string }) => void;
  /**
   * V17：内联耗时的数据源。**可选** —— 不传时面板用自己最近一次执行的结果
   * （`onRun` 的返回值里本来就有 elapsedMs / rowCount / cancelled），
   * 传了就以宿主为准（多面板共享同一次执行的场景）。
   */
  lastRun?: { elapsedMs: number; rowCount: number; cancelled: boolean } | null;
}

/** 一个结果集 */
interface ResultTab {
  id: string;
  sql: string;
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
  /** V17：最近一次执行的结果（耗时/行数/是否取消），渲染在编辑器区域内联 */
  const [lastRun, setLastRun] = useState<{ elapsedMs: number; rowCount: number; cancelled: boolean } | null>(null);
  /** S1：编辑器内右键菜单的视口坐标；null = 不显示 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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

  // ---------- B3 草稿自动保存（debounce 后写 localStorage） ----------
  // 定时器与待写内容放 ref：草稿是副作用，不该牵动 React 渲染
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftPendingRef = useRef<string | null>(null);
  const scheduleDraftSave = useCallback((doc: string) => {
    draftPendingRef.current = doc;
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      const text = draftPendingRef.current;
      draftPendingRef.current = null;
      // flush 时才读 injectorKey：读最新值，避免闭包拿到过期 props
      if (text !== null) writeDraft(draftKeyOf(propsRef.current.injectorKey), text);
    }, DRAFT_DEBOUNCE_MS);
  }, []);

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
        onContextMenu: (at) => setCtxMenu(at),
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

      const produced: ResultTab[] = [];
      try {
        for (let i = 0; i < spans.length; i++) {
          const st = spans[i].text;
          const r = await onRun({ connId, sql: st, database, queryId });
          produced.push({
            id: nextTabId(),
            sql: st,
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
        setTabs((prev) => [...produced, ...prev].slice(0, 20));
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
      setTabs((prev) => [tab, ...prev].slice(0, 20));
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
        <button className="primary" onClick={() => void execute('all')} disabled={running || !connId}>
          ▶ 执行 ⌘R
        </button>
        <button onClick={() => void execute('selection')} disabled={running || !connId}>
          执行选中 ⇧⌘R
        </button>
        <button onClick={() => void runExplain()} disabled={running || !connId}>
          执行计划 ⇧⌘E
        </button>
        <button onClick={() => void cancel()} disabled={!running}>
          取消 ⌘.
        </button>
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
          onClose={() => setCtxMenu(null)}
          onFormat={() => handleRef.current?.format()}
        />
      ) : null}

      <div className="sql-results">
        {tabs.length > 0 ? (
          <div className="sql-tabs" data-testid="sql-result-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`sql-tab${t.id === active?.id ? ' active' : ''}${t.error ? ' errored' : ''}`}
                onClick={() => setActiveTab(t.id)}
                title={t.sql}
              >
                <span className="sql-tab-title">
                  {t.explain ? '执行计划' : `${formatCount(t.rowCount)} 行`}
                  {t.error ? ' ⚠' : ''}
                </span>
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
                  title={`该结果只引用了 ${active.source.table} 一张表 —— 打开它的可编辑表格视图（写回仍需保存预演）`}
                  data-testid="sql-open-editable"
                  onClick={() =>
                    props.onOpenEditableResult?.({
                      connId,
                      database: active.source!.database ?? database ?? '',
                      table: active.source!.table,
                    })
                  }
                >
                  打开可编辑表格
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
                />
              )
            ) : null}
          </>
        ) : (
          <div className="empty-hint">⌘R 执行，或 ⇧⌘E 查看执行计划</div>
        )}
      </div>

      {snippetOpen ? (
        <SnippetSaveDialog
          sql={handleRef.current?.getText() ?? ''}
          onClose={() => setSnippetOpen(false)}
          onSaved={(name) => {
            setSnippetOpen(false);
            onToast?.(`已保存片段 ${name}`);
          }}
        />
      ) : null}
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
}: {
  payload: ColumnarPayload;
  database?: string;
  /** A20：单表查询的源表名（QueryOutcomeDto.source），无则 INSERT 复制静默降级 */
  tableName?: string;
  sortable?: boolean;
  onToast?: (msg: string) => void;
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
    />
  );
}

/**
 * S1 编辑器右键菜单。
 *
 * 为什么由 React 渲染而不是在 CodeMirror 里拼 DOM：菜单要复用既有
 * `.ctx-menu / .ctx-item` 样式（与树、网格右键同一族），内核那边只负责拦下
 * 原生菜单并上报坐标 —— 样式归 styles.css，行为归这里，职责不混。
 *
 * 关闭三件套：点外面、按 Esc、点菜单项。缺一个都会留下一个关不掉的浮层。
 */
function EditorContextMenu({
  x,
  y,
  onClose,
  onFormat,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onFormat: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      // 落在菜单内部不算"点外面"（菜单自己会处理点击）
      if (!(e.target instanceof Element) || !e.target.closest('.ctx-menu')) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" style={{ left: x, top: y }} data-testid="sql-editor-ctx-menu">
      <button
        className="ctx-item"
        data-testid="sql-editor-ctx-format"
        onClick={() => {
          onFormat();
          onClose();
        }}
      >
        <span className="ctx-label">格式化 SQL</span>
        <span className="ctx-shortcut">⌘I</span>
      </button>
    </div>
  );
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
 * Enter 提交、Esc 取消；重名 = 覆盖（主进程 HistoryStore.addSnippet 的
 * 「按名 upsert」语义，已在输入框说明文案里注明）。
 * 保存失败把错误显示在对话框内 —— 关掉就丢了错误不友好。
 */
function SnippetSaveDialog({
  sql,
  onClose,
  onSaved,
}: {
  sql: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const n = name.trim();
    if (!n) {
      setError('请填写片段名称');
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await pickBackend().snippetSave({ name: n, sql, description: description.trim() || null });
      onSaved(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [name, description, saving, sql, onSaved]);

  // 全局捕获 Enter/Esc：焦点不在输入框上（比如刚点了别处）时快捷键依然可用
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        <label className="sql-dialog-field">
          <span>名称（必填；重名将覆盖已有片段）</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：按状态统计订单"
            data-testid="sql-snippet-name"
          />
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
          <button className="primary" onClick={() => void submit()} disabled={saving || !name.trim()}>
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
