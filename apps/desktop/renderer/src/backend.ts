/**
 * 后端访问层 —— 渲染层与主进程之间的唯一入口。
 *
 * 存在的理由：**降级**。
 * 渲染层在两种环境里跑：
 *  1. Electron（有 window.dbStudio）→ 走真 IPC
 *  2. 纯浏览器 vite dev（没有 preload）→ 走 demo 数据
 *
 * 第二种不是"凑合"，是刻意保留的：UI 开发不该被"先接完主进程"阻塞，
 * 这也是这一层能在 IPC 接线前后保持不变的原因。
 *
 * ⚠️ 所有 IPC 调用都必须收口在这里。组件里直接写 `window.dbStudio.xxx`
 * 会让降级路径失效，也会让测试无从下手。
 */

// ⚠️ 走 renderer-types.ts 而不是 ipc-channels.ts：前者只 re-export 类型，
//    不带任何实现。直接引 ipc-channels 有把 electron 拖进渲染层 bundle 的风险
//    （S2 硬约束：首屏 ≤1.5MB）。
//    T41 新加的 SqlFile* 三个 DTO 还没进 renderer-types 的导出清单（那份清单
//    本轮不让改），所以这里用**相对路径的 type-only import** —— 与
//    SqlEditorPanel 引 action-catalog 的写法同族，编译后被完全擦除，零运行时成本。
import type {
  SqlFileReadResult,
  SqlFileSaveRequest,
  SqlFileSaveResult,
} from '../../src/shared/ipc-channels.js';
import type {
  DbStudioApi,
  ConnListResult,
  ConnectResult,
  QueryOutcomeDto,
  OpenTableRequest,
  RunQueryRequest,
  MutationApplyRequest,
  MutationApplyResult,
  TableBundle,
  GlassModeDto,
  DiagnosticsDto,
  SecretStateDto,
  SaveConnectionRequest,
  ExportStartRequest,
  ImportStartRequest,
  ImportPeekResult,
  ObjectDdlRequest,
  ObjectDdlResult,
  TableInfoRequest,
  TableInfoDto,
  ForeignKeysRequest,
  ForeignKeyDto,
  ReferencedValuesRequest,
  ReferencedValuesDto,
  ScriptStartRequest,
  /** V21：检查更新结论 */
  UpdateCheckResult,
} from '@dbstudio/shared-ipc';
import type { ConnectionConfig } from '@dbstudio/core-connection';
import type { DatabaseMeta } from '@dbstudio/core-schema-cache';
import type { HistoryEntry, Snippet } from '@dbstudio/core-history';
import {
  DEMO_DATABASES,
  DEMO_TABLE_META,
  DEMO_WIDE_TABLE_META,
  DEMO_WIDE_TABLE_NAME,
  buildDemoPayload,
  buildDemoWidePayload,
  buildDemoEmptyPayload,
  DEMO_CONNECTIONS,
} from './demoData';

/**
 * 0.7.1：demo 侧的语句分类（真链路用 core-sql-guard 的 AST，这里只为 demo/e2e 服务）。
 *
 * 只认语句**开头**的关键字，覆盖 e2e 用到的常见语句即可；判不出来的落 `other`
 * （与真链路 fail-safe 口径一致：不给行数口径，显示中性文案）。
 */
type DemoStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

function demoStatementKind(sql: string): DemoStatementKind {
  // 去掉开头的空白与注释（-- / # / 块注释），否则「-- 注释\nUPDATE ...」会判不出来
  const head = sql
    .replace(/^(?:\s+|--[^\n]*\n|--[^\n]*$|#[^\n]*\n|#[^\n]*$|\/\*[\s\S]*?\*\/)*/g, '')
    .trim()
    .toUpperCase();
  if (/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/.test(head)) return 'select';
  if (/^(INSERT|REPLACE)\b/.test(head)) return 'insert';
  if (/^UPDATE\b/.test(head)) return 'update';
  if (/^DELETE\b/.test(head)) return 'delete';
  if (/^(CREATE|DROP|ALTER|TRUNCATE|RENAME)\b/.test(head)) return 'ddl';
  return 'other';
}

/** demo 各语句类型的模拟影响行数（e2e 断言文案时以此为准） */
const DEMO_AFFECTED: Record<DemoStatementKind, number> = {
  select: 0,
  insert: 1,
  update: 3,
  delete: 2,
  ddl: 0,
  other: 0,
};

/** 是否有真 IPC（preload 注入的运行时标记） */
export function hasIpc(): boolean {
  return typeof window !== 'undefined' && window.dbStudioRuntime?.hasIpc === true;
}

function api(): DbStudioApi {
  if (!hasIpc()) throw new Error('当前不在 Electron 环境（无 window.dbStudio）');
  return window.dbStudio;
}

/** 统一抛错：把 IpcResult 拆成"有值就返回，没值就抛" */
async function unwrap<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await p;
  if (r.ok) return r.data;
  const e = new Error(r.error.message) as Error & { code: string };
  e.code = r.error.code;
  throw e;
}

/** 后端接口 —— 真实现与 demo 实现都满足它 */
export interface Backend {
  readonly kind: 'ipc' | 'demo';

  connList(): Promise<ConnListResult>;
  connConnect(id: string, password?: string | null): Promise<ConnectResult>;
  connDisconnect(id: string): Promise<void>;
  connTest(input: SaveConnectionRequest): Promise<{ ok: boolean; serverVersion: string | null; elapsedMs: number; message: string | null }>;
  connSave(input: SaveConnectionRequest): Promise<ConnectionConfig>;
  connDelete(id: string): Promise<boolean>;

  schemaGet(connId: string): Promise<DatabaseMeta[]>;
  schemaRefresh(connId: string): Promise<DatabaseMeta[]>;
  schemaGetTable(connId: string, database: string, table: string): Promise<TableBundle>;
  schemaSearchColumn(connId: string, column: string): Promise<string[]>;
  /** 对象定义查看（C2）：视图/存储过程/函数/触发器/事件/表的 SHOW CREATE */
  schemaGetObjectDdl(req: ObjectDdlRequest): Promise<ObjectDdlResult>;
  /** 表信息（C9/A14）：information_schema 估算行数，不做全表 COUNT */
  schemaGetTableInfo(req: TableInfoRequest): Promise<TableInfoDto>;
  /**
   * V9：外键列表。
   * 返回空数组 = 该表没有外键（或元数据读不到，主进程已降级）——
   * 渲染层据此决定「画不画跳转链接」，不要把它当错误处理。
   */
  schemaGetForeignKeys(req: ForeignKeysRequest): Promise<ForeignKeyDto[]>;
  /** V9：外键候选值（服务端 LIMIT，绝不全表扫描） */
  schemaGetReferencedValues(req: ReferencedValuesRequest): Promise<ReferencedValuesDto>;

  queryRun(req: RunQueryRequest): Promise<QueryOutcomeDto>;
  queryOpenTable(req: OpenTableRequest): Promise<QueryOutcomeDto>;
  queryCancel(queryId: string): Promise<boolean>;

  mutationApply(req: MutationApplyRequest): Promise<MutationApplyResult>;

  // ---- 导出/导入（D3 + §6.6） ----
  exportStart(req: ExportStartRequest): Promise<{ jobId: string }>;
  exportCancel(jobId: string): Promise<boolean>;
  exportPickPath(table: string, format: string): Promise<string | null>;
  importStart(req: ImportStartRequest): Promise<{ jobId: string }>;
  importCancel(jobId: string): Promise<boolean>;
  importPickPath(): Promise<string | null>;
  importPeek(filePath: string, maxRows?: number): Promise<ImportPeekResult>;
  // ---- 运行 SQL 脚本（库/表级别） ----
  scriptStart(req: ScriptStartRequest): Promise<{ jobId: string }>;
  scriptConfirm(jobId: string): Promise<boolean>;
  scriptCancel(jobId: string): Promise<boolean>;
  scriptPickPath(): Promise<string | null>;
  /** 订阅主进程推送（导出/导入/脚本进度），返回退订函数 */
  onTransferEvent(kind: 'export' | 'import' | 'script', cb: (payload: unknown) => void): () => void;

  historyList(connId: string | null, limit?: number): Promise<HistoryEntry[]>;
  historySearch(keyword: string, limit?: number): Promise<HistoryEntry[]>;
  /** V6：删单条历史 */
  historyDelete(id: number): Promise<boolean>;
  /** V6：星标/取消星标 */
  historyStar(id: number, starred: boolean): Promise<boolean>;
  snippetList(): Promise<Snippet[]>;
  /**
   * 按名保存/覆盖片段（**同一连接 + 同一库**内同名即更新，主进程语义）。
   * v0.6.0：加了归属维度 —— 同名片段可在不同库各存一份。
   */
  snippetSave(s: {
    name: string;
    sql: string;
    description?: string | null;
    connectionId?: string;
    database?: string;
  }): Promise<Snippet>;

  appGetMode(): Promise<GlassModeDto>;
  appDiagnostics(): Promise<DiagnosticsDto>;
  secretState(): Promise<SecretStateDto>;
  /** 弹系统选择器选私钥文件，返回绝对路径（取消返回 null） */
  pickPrivateKey(): Promise<string | null>;
  /** BLOB/图片另存（A10）：弹保存框写盘，返回实际路径（取消返回 null） */
  saveBinary(suggestedName: string, data: ArrayBuffer): Promise<string | null>;
  // ---- T41：SQL 文件编辑闭环（打开不执行 / 保存不执行）----
  /** 弹打开框选 .sql 文件（取消返回 null） */
  sqlFilePick(): Promise<string | null>;
  /** 读文件正文（编码探测与回退都在主进程完成） */
  sqlFileRead(path: string): Promise<SqlFileReadResult>;
  /** 保存 / 另存为；被外部改过且未 force → 返回 conflict=true 且未写盘 */
  sqlFileSave(req: SqlFileSaveRequest): Promise<SqlFileSaveResult>;
  /** 订阅连接状态变化（D1 断线横幅）。返回退订函数 */
  onConnState(cb: (p: { id: string; state: string; lastError?: string | null }) => void): () => void;
  /**
   * v0.6.0：订阅 schema 后台刷新结果（快照回源完成、且结构确有变化时推送）。
   * 没有它，磁盘快照会把新表永久挡在树外（刷新失效的第三处根因）。
   */
  onSchema(cb: (p: { id: string; databases: DatabaseMeta[] }) => void): () => void;

  // ---- V21 / V23：应用维护与多窗口 ----

  /**
   * V21：手动检查更新。
   * 开发态/无发布通道时返回 available=false + 中文说明，绝不抛——
   * 「点了没反应」比「明确告诉你查不了」糟糕得多。
   */
  appCheckUpdate(): Promise<UpdateCheckResult>;

  /**
   * V23：在新窗口打开一张表（多窗口共用同一主进程）。
   * ⚠️ 这里**不 unwrap** —— 失败原因（如超窗口上限）需要原样带回给 toast，
   *  throw 出去会被调用方的 catch 吞成通用文案，用户看不到「最多同时打开 4 个」。
   */
  openWindowInNew(req: { connId: string; database: string; table: string }): Promise<{ ok: boolean; message: string | null }>;
}

/** 真 IPC 实现 */
export const ipcBackend: Backend = {
  kind: 'ipc',

  connList: () => unwrap(api().connList()),
  connConnect: (id, password) => unwrap(api().connConnect(id, password)),
  connDisconnect: async (id) => {
    await unwrap(api().connDisconnect(id));
  },
  connTest: (input) => unwrap(api().connTest(input)),
  connSave: (input) =>
    unwrap(
      // 有 id 走更新，无 id 走新建
      input.config?.id ? api().connUpdate(input) : api().connCreate(input),
    ),
  connDelete: (id) => unwrap(api().connDelete(id)),

  schemaGet: (connId) => unwrap(api().schemaGet(connId)),
  schemaRefresh: async (connId) => {
    const r = await unwrap(api().schemaRefresh(connId));
    // handler 返回 { databases, capturedAt }，这里统一成 DatabaseMeta[]
    return (r as unknown as { databases: DatabaseMeta[] }).databases ?? (r as unknown as DatabaseMeta[]);
  },
  schemaGetTable: (connId, database, table) => unwrap(api().schemaGetTable(connId, database, table)),
  schemaSearchColumn: (connId, column) => unwrap(api().schemaSearchColumn(connId, column)),
  schemaGetObjectDdl: (req) => unwrap(api().schemaGetObjectDdl(req)),
  schemaGetTableInfo: (req) => unwrap(api().schemaGetTableInfo(req)),
  schemaGetForeignKeys: (req) => unwrap(api().schemaGetForeignKeys(req)),
  schemaGetReferencedValues: (req) => unwrap(api().schemaGetReferencedValues(req)),

  queryRun: (req) => unwrap(api().queryRun(req)),
  queryOpenTable: (req) => unwrap(api().queryOpenTable(req)),
  queryCancel: (queryId) => unwrap(api().queryCancel(queryId)),

  mutationApply: (req) => unwrap(api().mutationApply(req)),

  exportStart: (req) => unwrap(api().exportStart(req)),
  exportCancel: (jobId) => unwrap(api().exportCancel(jobId)),
  exportPickPath: (table, format) => unwrap(api().exportPickPath(table, format)),
  importStart: (req) => unwrap(api().importStart(req)),
  importCancel: (jobId) => unwrap(api().importCancel(jobId)),
  importPickPath: () => unwrap(api().importPickPath()),
  importPeek: (filePath, maxRows) => unwrap(api().importPeek(filePath, maxRows)),
  scriptStart: (req) => unwrap(api().scriptStart(req)),
  scriptConfirm: (jobId) => unwrap(api().scriptConfirm(jobId)),
  scriptCancel: (jobId) => unwrap(api().scriptCancel(jobId)),
  scriptPickPath: () => unwrap(api().scriptPickPath()),
  onTransferEvent: (kind, cb) =>
    api().on(kind === 'export' ? 'event:export' : kind === 'script' ? 'event:script' : 'event:import', cb),

  historyList: (connId, limit) => unwrap(api().historyList(connId, limit)),
  historySearch: (keyword, limit) => unwrap(api().historySearch(keyword, limit)),
  historyDelete: (id) => unwrap(api().historyDelete(id)),
  historyStar: (id, starred) => unwrap(api().historyStar(id, starred)),
  snippetList: () => unwrap(api().snippetList()),
  snippetSave: (s) => unwrap(api().snippetSave(s)),

  appGetMode: () => unwrap(api().appGetMode()),
  appDiagnostics: () => unwrap(api().appDiagnostics()),
  secretState: () => unwrap(api().secretState()),
  pickPrivateKey: () => unwrap(api().pickPrivateKey()),
  saveBinary: (suggestedName, data) => unwrap(api().saveBinary({ suggestedName, data })),
  // T41：SQL 文件（与「执行脚本」是两条链路：这里只读写文件，不执行任何语句）
  sqlFilePick: () => unwrap(api().sqlFilePick()),
  sqlFileRead: (path) => unwrap(api().sqlFileRead(path)),
  sqlFileSave: (req) => unwrap(api().sqlFileSave(req)),
  // 推送通道：连接状态（D1 断线横幅的信号源）。
  // ⚠️ 字符串与 ipc-channels.ts 的 EVENT_CONN_STATE_CHANNEL 同值——
  //    渲染层不能 value-import shared 的实现（会把 electron 拖进 bundle），所以这里用字面量
  onConnState: (cb) => api().on('event:connState', cb as (p: unknown) => void),
  // v0.6.0：schema 后台刷新推送（同上，字面量而非 value-import shared）
  onSchema: (cb) => api().on('event:schema', cb as (p: unknown) => void),

  // V21：手动检查更新（不 unwrap：开发态是正常结论，不是异常）
  appCheckUpdate: async () => {
    const r = await api().appCheckUpdate();
    if (r.ok) return r.data;
    throw Object.assign(new Error(r.error.message), { code: r.error.code });
  },

  // V23：不 unwrap —— 失败原因要原样交给 toast（见 Backend 接口注释）
  openWindowInNew: async (req) => {
    const r = await api().openWindowInNew(req);
    return r.ok ? { ok: true, message: null } : { ok: false, message: r.error.message };
  },
};

/** 按环境挑后端：有 IPC 用真的，否则降级 demo */
export function pickBackend(): Backend {
  return hasIpc() ? ipcBackend : demoBackend;
}

// ---------- demo 后端（浏览器 dev 用） ----------

/**
 * V6：demo 模式下也要**真的改内存历史列表** —— 否则 UI 里删/星标完看不到变化，
 * 而这类"操作后不刷新"的 bug 恰恰最常见（与 connSave 的 demo 实现同思路）。
 *
 * 预置几条历史供 e2e:ui 断言删除/星标/过滤；写入用自增 id。
 */
const demoHistory = (() => {
  let seq = 1;
  const rows: HistoryEntry[] = [
    { id: seq++, connectionId: 'c1', database: 'demo', sql: 'SELECT * FROM users LIMIT 50', success: true, error: null, durationMs: 12, rowCount: 50, executedAt: Date.now() - 3000, starred: false },
    { id: seq++, connectionId: 'c1', database: 'demo', sql: 'SELECT COUNT(*) FROM order_items', success: true, error: null, durationMs: 34, rowCount: 1, executedAt: Date.now() - 2000, starred: false },
    { id: seq++, connectionId: 'c1', database: 'demo', sql: 'SELCT * FROM users', success: false, error: 'You have an error in your SQL syntax', durationMs: 3, rowCount: 0, executedAt: Date.now() - 1000, starred: false },
  ];
  // 星标优先、其次时间倒序（与 core-history 的 SQL ORDER BY 同口径）
  const sort = () =>
    [...rows].sort((a, b) => (Number(b.starred) - Number(a.starred)) || (b.executedAt - a.executedAt));
  return {
    list(connId: string | null, limit: number): HistoryEntry[] {
      const base = connId ? rows.filter((r) => r.connectionId === connId) : rows;
      return [...base].sort((a, b) => (Number(b.starred) - Number(a.starred)) || (b.executedAt - a.executedAt)).slice(0, limit);
    },
    search(keyword: string, limit: number): HistoryEntry[] {
      const k = keyword.toLowerCase();
      return sort().filter((r) => r.sql.toLowerCase().includes(k)).slice(0, limit);
    },
    remove(id: number): boolean {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    star(id: number, starred: boolean): boolean {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.starred = starred;
      return true;
    },
  };
})();

/**
 * v0.6.0：demo 片段存储（内存）。
 * key = `连接 库 名称`，与主进程 HistoryStore 的「库内唯一」语义对齐。
 */
const demoSnippets = new Map<string, Snippet>();

const demoBackend: Backend = {
  kind: 'demo',

  /**
   * 🔴 每次都要返回**新对象/新数组**（与真 IPC 一致）。
   *
   * demo 里 `DEMO_CONNECTIONS` 是可变的内存源：如果直接把同一个数组/同一个
   * 连接对象交给 React，`setConnections(sameRef)` 会被判定为「状态没变」而不
   * 重渲染；而 `readOnlyConns` 这类 useMemo 也会因为依赖引用没变而**继续返回
   * 旧映射**。现象：命令面板切了只读、连接配置真的改了，但界面里的只读状态
   * 一直是旧的（e2e T49-3 就是这么红的）。
   */
  connList: async () => ({
    connections: DEMO_CONNECTIONS.map((c) => ({ ...c })),
    states: Object.fromEntries(DEMO_CONNECTIONS.map((c) => [c.id, { state: 'connected' as const, lastError: null }])),
    schemas: Object.fromEntries(DEMO_CONNECTIONS.map((c) => [c.id, DEMO_DATABASES])),
    stale: {},
    secret: { available: true, reason: null },
  }),

  connConnect: async () => ({ state: 'connected' as const, serverVersion: '8.4.0-demo', elapsedMs: 3 }),
  connDisconnect: async () => {},
  connTest: async () => ({ ok: true, serverVersion: '8.4.0-demo', elapsedMs: 3, message: null }),
  /**
   * demo 下也要**真的改内存列表** —— 否则 UI 里保存完看不到新连接，
   * 而这类"保存后不刷新"的 bug 恰恰是最常见的。
   * 与其让用户先接上主进程才能发现，不如 demo 模式就把闭环补齐。
   */
  connSave: async (input) => {
    const cfg: ConnectionConfig = input.config?.id
      ? { ...input.config }
      : { ...input.config, id: `demo-${Date.now().toString(36)}` };
    const idx = DEMO_CONNECTIONS.findIndex((c) => c.id === cfg.id);
    if (idx >= 0) DEMO_CONNECTIONS[idx] = cfg;
    else DEMO_CONNECTIONS.push(cfg);
    return cfg;
  },
  connDelete: async (id) => {
    const idx = DEMO_CONNECTIONS.findIndex((c) => c.id === id);
    if (idx >= 0) DEMO_CONNECTIONS.splice(idx, 1);
    return idx >= 0;
  },

  schemaGet: async () => DEMO_DATABASES,
  schemaRefresh: async () => DEMO_DATABASES,
  schemaGetTable: async (_connId, database, table) => ({
    database,
    // 🔴 宽表必须返回它自己的元数据：若退回 DEMO_TABLE_META（7 列），
    //    payload（40 列）与 TableMeta 不匹配 → columns[39] 读到空 reader，
    //    值全 null 却**不报错**（最难查的假绿）
    table:
      table === DEMO_WIDE_TABLE_NAME
        ? DEMO_WIDE_TABLE_META
        : DEMO_TABLE_META.name === table
          ? DEMO_TABLE_META
          : { ...DEMO_TABLE_META, name: table },
    fromCache: false,
    capturedAt: Date.now(),
  }),
  schemaSearchColumn: async () => [],

  // demo：对象定义返回占位文本，表信息返回一组自洽的假数据（UI 流程可走通即可）
  schemaGetObjectDdl: async (req) => ({
    kind: req.kind,
    name: req.name,
    database: req.database,
    ddl: `-- demo 模式：${req.kind} ${req.database}.${req.name} 的定义\nSHOW CREATE 在浏览器 demo 下不可用`,
  }),
  schemaGetTableInfo: async () => ({
    engine: 'InnoDB',
    rowsEstimate: 50_000,
    dataLength: 16_777_216,
    indexLength: 1_048_576,
    charset: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    comment: null,
    createTime: new Date().toISOString(),
    autoIncrement: 50_001,
  }),

  /**
   * V9：demo 外键。
   *
   * 只给 `order` 表配 `user_id → user.id`（demo 数据里 user_id 真实存在，
   * 值域 1000~1899）。刻意不给每张表都配：e2e 要能断言
   * 「有外键的表画链接、没有的表不画」两种形态。
   */
  schemaGetForeignKeys: async (_req) => {
    if (_req.table !== 'order') return [];
    return [
      {
        constraintName: 'fk_order_user',
        columns: ['user_id'],
        referencedDatabase: _req.database,
        referencedTable: 'user',
        referencedColumns: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
    ];
  },

  /**
   * V9：demo 候选值。与 buildDemoPayload 的 user_id 生成规则同源
   * （`1000 + (r % 900)`），所以选出来的值在表里真实存在。
   */
  schemaGetReferencedValues: async (req) => {
    const total = 900;
    const limit = Math.max(1, Math.min(500, Math.floor(req.limit ?? 200)));
    const kw = (req.keyword ?? '').trim();
    const items: { value: unknown; label: string }[] = [];
    for (let i = 0; i < total && items.length <= limit; i++) {
      const id = 1000 + i;
      const label = `用户 ${id}`;
      if (kw && !String(id).includes(kw) && !label.includes(kw)) continue;
      items.push({ value: String(id), label });
    }
    const truncated = items.length > limit;
    return { items: truncated ? items.slice(0, limit) : items, truncated };
  },

  queryRun: async (req) => {
    /**
     * 0.7.1：demo 也要按语句类型分流 —— 早先恒返回 2000 行结果集，
     * 于是「执行 UPDATE 应显示已修改 N 行」在 demo 上永远是假绿（永远 2000 行）。
     *
     * ⚠️ 这里用前缀正则而不是 core-sql-guard 的 AST：渲染层不该为了 demo
     *    把 node-sql-parser 打进首屏 bundle（S2 预算）。真链路的判据仍是 AST，
     *    demo 只需要覆盖 e2e 用到的常见语句。
     */
    const kind = demoStatementKind(req.sql);
    if (kind === 'select') {
      return {
        payload: buildDemoPayload(2000),
        elapsedMs: 4,
        rowCount: 2000,
        affectedRows: 2000,
        insertId: null,
        statementKind: 'select' as const,
        info: null,
        warnings: 0,
        cancelled: false,
        truncated: false,
        queryId: 'demo-query',
      };
    }
    return {
      payload: buildDemoEmptyPayload(),
      elapsedMs: 3,
      rowCount: 0,
      affectedRows: DEMO_AFFECTED[kind],
      insertId: kind === 'insert' ? 5001 : null,
      statementKind: kind,
      info: kind === 'update' ? 'Rows matched: 5  Changed: 3  Warnings: 0' : null,
      warnings: 0,
      cancelled: false,
      truncated: false,
      queryId: 'demo-query',
    };
  },
  queryOpenTable: async (req) => {
    // 🔴 按表名路由 payload：宽表必须回宽表的载荷。
    //    若一律回 buildDemoPayload(50_000)（7 列），打开 wide_metrics 时
    //    TableMeta 有 40 列、payload 只有 7 列 → 第 8~40 列全 null 且**不报错**，
    //    冻结列/转置的宽表断言会建立在一片空数据上（假绿）。
    if (req.table === DEMO_WIDE_TABLE_NAME) {
      const n = 2000;
      return {
        payload: buildDemoWidePayload(n),
        elapsedMs: 8,
        rowCount: n,
        affectedRows: n,
        insertId: null,
        statementKind: 'select' as const,
        info: null,
        warnings: 0,
        cancelled: false,
        truncated: req.limit ? n >= req.limit : false,
        queryId: 'demo-query',
      };
    }
    return {
      payload: buildDemoPayload(50_000),
      elapsedMs: 8,
      rowCount: 50_000,
      affectedRows: 50_000,
      insertId: null,
      statementKind: 'select' as const,
      info: null,
      warnings: 0,
      cancelled: false,
      truncated: req.limit ? 50_000 >= req.limit : false,
      queryId: 'demo-query',
    };
  },
  queryCancel: async () => true,

  mutationApply: async (req) => ({
    affected: req.statements.length,
    elapsedMs: 5,
    insertIds: req.statements.map(() => null),
    outcome: 'ok' as const,
    conflicts: [],
    committed: true,
  }),

  // demo：导出/导入模拟（浏览器 dev 模式下至少 UI 流程可走）
  exportStart: async () => ({ jobId: `demo-export-${Date.now()}` }),
  exportCancel: async () => true,
  exportPickPath: async () => null,
  importStart: async () => ({ jobId: `demo-import-${Date.now()}` }),
  importCancel: async () => true,
  importPickPath: async () => null,
  importPeek: async () => ({ rows: [], delimiter: ',', format: 'csv' as const }),
  // 脚本执行：demo 下没有真库也没有 worker，pickPath 返回 null 走不到 start，
  // 但接口必须齐全 —— 与导入 pickPath 的降级口径一致
  scriptStart: async () => ({ jobId: `demo-script-${Date.now()}` }),
  scriptConfirm: async () => true,
  scriptCancel: async () => true,
  scriptPickPath: async () => null,
  onTransferEvent: () => () => {},

  historyList: async (connId, limit) => demoHistory.list(connId, limit ?? 200),
  historySearch: async (keyword, limit) => demoHistory.search(keyword, limit ?? 100),
  historyDelete: async (id) => demoHistory.remove(id),
  historyStar: async (id, starred) => demoHistory.star(id, starred),
/**
   * v0.6.0：demo 后端**真的存**片段。
   *
   * 🔴 原来这里是 `snippetList: async () => []` —— 永远返空。
   *    后果不是"demo 里收藏不好用"，而是：任何靠 snippetList 验证的功能
   *    （保存后能在列表里看到、⌘K 能搜到）在浏览器 dev 模式下**静默失效**，
   *    门禁全绿、真机却是另一条路径。替身必须实现被测功能，不能返回空数组糊过去。
   *
   * 语义与主进程 HistoryStore 对齐：同一 (connectionId, database) 内同名即覆盖。
   */
  snippetList: async () => [...demoSnippets.values()],
  snippetSave: async (s) => {
    const connectionId = s.connectionId ?? '';
    const database = s.database ?? '';
    const key = `${connectionId}\u0000${database}\u0000${s.name}`;
    const prev = demoSnippets.get(key);
    const row = {
      id: prev?.id ?? Date.now() + demoSnippets.size,
      connectionId,
      database,
      name: s.name,
      sql: s.sql,
      description: s.description ?? null,
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    demoSnippets.set(key, row);
    return row;
  },

  appGetMode: async () => ({ mode: 'css' as const, reason: 'demo 模式（非 Electron）' }),
  appDiagnostics: async () => ({
    fps: null,
    memMb: null,
    runningQueries: 0,
    liveConnections: 0,
    darwinMajor: null,
  }),
  secretState: async () => ({ mode: 'unavailable' as const, available: false, reason: 'demo 模式' }),

  // demo 下没有主进程 dialog：返回 null 表示"取消选择"，
  // 不能返回假路径让用户以为选成功了
  pickPrivateKey: async () => null,
  saveBinary: async () => null,
  /**
   * T41：demo（浏览器）模式没有主进程文件系统 —— **明确说做不到**，
   * 而不是返回一个假路径或假成功（那会让用户以为文件已经存盘了）。
   * 与 pickPrivateKey / saveBinary 的降级口径一致：读写都必须是真的。
   */
  sqlFilePick: async () => null,
  sqlFileRead: async () => {
    throw new Error('浏览器演示模式没有本地文件系统，打开/保存 SQL 文件需要桌面应用环境');
  },
  sqlFileSave: async () => {
    throw new Error('浏览器演示模式没有本地文件系统，打开/保存 SQL 文件需要桌面应用环境');
  },
  onConnState: () => () => {},
  onSchema: () => () => {},

  // V21：demo 模式没有打包产物也没有发布通道 —— 明确说明，不给假结论
  appCheckUpdate: async () => ({
    currentVersion: 'demo',
    latestVersion: null,
    hasUpdate: false,
    message: '浏览器演示模式不检查更新（仅打包产物参与）',
    available: false,
  }),

  // V23：demo 模式没有多窗口（一个浏览器页面就是一个窗口）——
  // 返回失败原因而不是静默成功，UI 会把它 toast 出来
  openWindowInNew: async () => ({ ok: false, message: '多窗口需要桌面应用环境（当前是浏览器演示模式）' }),
};
