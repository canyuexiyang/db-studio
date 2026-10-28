/**
 * 类型化 IPC 通道定义（主进程与渲染进程共享）
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §2.1
 *  - 渲染进程 nodeIntegration:false + contextIsolation:true + sandbox:true
 *  - ⚠️ sandbox 开启时 preload 必须是 CommonJS，ESM preload 会失败
 *  - 通过 contextBridge 暴露类型化 API
 *
 * 这个文件被主/渲染/preload 三方共同引用，是契约的单一来源。
 * 任何 IPC 通道的增删改都必须先改这里，然后同步改 ipc-channels.cjs
 * （有测试守着两份一致性，改漏了会红）。
 */

import type { ColumnarPayload } from '@dbstudio/core-ipc-codec';
import type { ConnectionConfig, ConnectionState } from '@dbstudio/core-connection';
import type { DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';
import type { HistoryEntry, Snippet } from '@dbstudio/core-history';

/** 通道名常量 —— 避免字符串散落各处 */
export const IPC = {
  // 连接
  CONN_LIST: 'conn:list',
  CONN_CREATE: 'conn:create',
  CONN_UPDATE: 'conn:update',
  CONN_DELETE: 'conn:delete',
  CONN_CONNECT: 'conn:connect',
  CONN_DISCONNECT: 'conn:disconnect',
  CONN_TEST: 'conn:test',

  // Schema
  SCHEMA_GET: 'schema:get',
  SCHEMA_REFRESH: 'schema:refresh',
  SCHEMA_GET_TABLE: 'schema:getTable',
  SCHEMA_SEARCH_COLUMN: 'schema:searchColumn',
  /** 对象定义查看（C2）：视图/存储过程/函数/触发器/事件的 SHOW CREATE */
  SCHEMA_GET_OBJECT_DDL: 'schema:getObjectDdl',
  /** 表信息（C9 表信息面板 / A14 行数估算）：information_schema.TABLES，不做全表 COUNT */
  SCHEMA_GET_TABLE_INFO: 'schema:getTableInfo',
  /** V9：外键列表（KEY_COLUMN_USAGE + REFERENTIAL_CONSTRAINTS，按需单表查） */
  SCHEMA_GET_FOREIGN_KEYS: 'schema:getForeignKeys',
  /** V9：外键候选值（引用表的 value/label，服务端 LIMIT，绝不全表扫描） */
  SCHEMA_GET_REFERENCED_VALUES: 'schema:getReferencedValues',

  // 查询
  QUERY_RUN: 'query:run',
  QUERY_OPEN_TABLE: 'query:openTable',
  QUERY_CANCEL: 'query:cancel',
  QUERY_RUNNING: 'query:running',

  // 编辑保存
  MUTATION_APPLY: 'mutation:apply',

  // 导出/导入
  EXPORT_START: 'export:start',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_PICK_PATH: 'export:pickPath',
  IMPORT_START: 'import:start',
  IMPORT_CANCEL: 'import:cancel',
  IMPORT_PICK_PATH: 'import:pickPath',
  IMPORT_PEEK: 'import:peek',

  // 运行 SQL 脚本（库/表级别导入脚本：建表 + 数据一次跑完）
  SCRIPT_START: 'script:start',
  SCRIPT_CONFIRM: 'script:confirm',
  SCRIPT_CANCEL: 'script:cancel',
  SCRIPT_PICK_PATH: 'script:pickPath',

  // 历史与片段
  HISTORY_LIST: 'history:list',
  HISTORY_SEARCH: 'history:search',
  HISTORY_CLEAR: 'history:clear',
  /** V6：删单条历史（区别于 clear 的整表清空） */
  HISTORY_DELETE: 'history:delete',
  /** V6：星标/取消星标一条历史 */
  HISTORY_STAR: 'history:star',
  SNIPPET_LIST: 'snippet:list',
  SNIPPET_SAVE: 'snippet:save',

  // 凭据
  SECRET_STATE: 'secret:state',

  // 应用
  APP_GET_MODE: 'app:getMode',
  APP_SET_GLASS: 'app:setGlass',
  APP_DIAGNOSTICS: 'app:diagnostics',
  /**
   * W 板块：渲染层对关闭询问的答复（渲染 → 主）。
   *
   * ⚠️ 询问用的 APP_BEFORE_CLOSE_ASK **不在本表里** —— 它是主→渲染的单向推送，
   *    放进来会被「所有 IPC 通道都必须注册 handler」的测试判红（也确实该判红：
   *    它不是 invoke 通道）。见下方 EVENT_BEFORE_CLOSE_ASK。
   */
  APP_BEFORE_CLOSE_REPLY: 'app:beforeCloseReply',
  /** V21：手动检查更新（菜单「检查更新…」/ 命令面板） */
  APP_CHECK_UPDATE: 'app:checkUpdate',
  /** V23：在新窗口打开一张表（多窗口，共用同一主进程） */
  APP_OPEN_WINDOW: 'app:openWindow',

  // 文件选择（渲染层沙箱无 fs，必须经主进程 dialog）
  FILE_PICK_PRIVATE_KEY: 'file:pickPrivateKey',
  /** BLOB/图片另存到磁盘（A10）：渲染层传数据，主进程弹保存框并写文件 */
  FILE_SAVE_BINARY: 'file:saveBinary',

  // T41：SQL 文件编辑闭环（打开 / 读取 / 保存&另存为）。
  // ⚠️ 这三条只做【文件读写】，与「执行 SQL」是两件事 —— 打开不执行、保存不执行。
  /** 弹打开框选 .sql 文件，返回绝对路径（取消返回 null） */
  SQL_FILE_PICK: 'sqlfile:pick',
  /** 读文件正文（主进程做编码探测与回退，返回给渲染层的永远是解好的文本） */
  SQL_FILE_READ: 'sqlfile:read',
  /**
   * 保存 / 另存为。
   * path 为 null → 弹保存框（另存为）；带 baseline → 先比对是否被外部改过。
   */
  SQL_FILE_SAVE: 'sqlfile:save',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------- 主进程单向推送通道（不在 IPC map 里：它们只被订阅，不被 invoke） ----------

/** 连接状态变化推送 —— ipc-handlers.ts 里的 EVENT_CONN_STATE 与这里必须同值 */
export const EVENT_CONN_STATE_CHANNEL = 'event:connState';
/**
 * v0.6.0：schema 后台刷新推送（快照 → 真库回源完成后）。
 *
 * 与 EVENT_CONN_STATE_CHANNEL 同口径：单向推送、只被订阅不被 invoke，
 * 因此**刻意不放进 IPC map**（那张表要求每个 key 都有 handler）。
 */
export const EVENT_SCHEMA_CHANNEL = 'event:schema';
/** 原生菜单命令转发（F1）：main/menu.ts → 渲染层 App */
export const EVENT_MENU_COMMAND = 'event:menuCommand';

/**
 * W 板块：窗口关闭前的「能否关闭」询问（主 → 渲染，单向推送）。
 *
 * 🔴 为什么必须有这条：frame:false 窗口用的是 macOS **原生**红按钮，
 *    它的点击不经过任何 DOM 事件，渲染层无从得知。若不询问，
 *    有脏改动的标签会被静默丢掉 —— 直接违反保存预演红线。
 *    主进程在收到 APP_BEFORE_CLOSE_REPLY 之前会 preventDefault 住 close。
 *
 * ⚠️ 刻意**不放进 IPC map**：那张表的每个 key 都必须是 invoke 通道
 *    （有测试守卫「所有通道都注册了 handler」）。这条只被订阅、不被 invoke，
 *    放进去会让 renderer 侧误以为可以 invoke 它。答复方向仍在 IPC 表里
 *    （APP_BEFORE_CLOSE_REPLY）—— 一问一答两个方向，只有答是 invoke。
 */
export const EVENT_BEFORE_CLOSE_ASK = 'app:beforeCloseAsk';

/** 统一的 IPC 响应包装 —— 让渲染侧不必 try/catch 每一处 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function err<T>(code: string, message: string): IpcResult<T> {
  return { ok: false, error: { code, message } };
}

/** 标准错误码 —— 渲染层据此决定提示文案与是否可重试 */
export const ERROR_CODES = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  CONNECT_FAILED: 'CONNECT_FAILED',
  /** SSH 隧道建立失败（超时 / 认证失败 / 端口转发被拒） */
  SSH_FAILED: 'SSH_FAILED',
  READ_ONLY: 'READ_ONLY',
  BUSY: 'BUSY',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  PLAINTEXT_LEAK: 'PLAINTEXT_LEAK',
  CANCELLED: 'CANCELLED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------- 载荷与返回类型 ----------

export interface ConnListResult {
  /** 连接列表（扁平，树由渲染层用 buildTree 组装） */
  connections: ConnectionConfig[];
  /** 连接 id → 运行时状态 */
  states: Record<string, { state: ConnectionState; lastError: string | null }>;
  /** 可立即渲染的 schema 快照（磁盘缓存），没有的不出现在 key 里 */
  schemas: Record<string, DatabaseMeta[]>;
  /** 快照是否过期（UI 提示"可能过期，建议刷新"） */
  stale: Record<string, boolean>;
  secret: { available: boolean; reason: string | null };
}

export interface ConnectResult {
  state: ConnectionState;
  serverVersion: string | null;
  elapsedMs: number;
}

export interface OpenTableRequest {
  connId: string;
  database: string;
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
  /**
   * WHERE 子句原文（不含 WHERE 关键字），由 core-filter 生成。
   * 里面的值一律是 `?` 占位 —— 见 whereParams。
   */
  where?: string | null;
  /**
   * 与 where 中 `?` 一一对应的参数。
   *
   * 🔴 **顺序是 `[...whereParams, ...limitParams]`** —— 这个顺序由
   *    core-driver-mysql 的 buildOpenTableSql 保证。反了报的错完全指向别处
   *    （`syntax error near ''30''`，把值喂给了 LIMIT），极难定位。
   */
  whereParams?: unknown[];
}

export interface QueryOutcomeDto {
  payload: ColumnarPayload;
  elapsedMs: number;
  /** 结果集行数。非 SELECT 恒为 0 —— 影响行数看 affectedRows（0.7.1） */
  rowCount: number;
  /**
   * 0.7.1：OkPacket.affectedRows。
   *
   * 🔴 UPDATE 时是**匹配行数（matched）**（mysql2 默认带 CLIENT_FOUND_ROWS）；
   *    真实变更数看 `info` 里的 `Changed:`。INSERT/DELETE 就是插入/删除行数。
   *    结果集时等于 rowCount。
   */
  affectedRows: number;
  /** 0.7.1：INSERT 自增值；无自增为 null */
  insertId: number | null;
  /** 0.7.1：语句分类，决定 UI 文案（'select' → 返回 N 行 / 'update' → 已修改 N 行 …） */
  statementKind: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';
  /** 0.7.1：OkPacket.info 原文（`Rows matched: N  Changed: M`），无则 null */
  info: string | null;
  /** 0.7.1：服务端告警数 */
  warnings: number;
  /** 是否因取消提前返回（mysql2 被 KILL 是 resolve 不是 reject） */
  cancelled: boolean;
  /** 行数达到 limit，很可能还有更多 */
  truncated: boolean;
  /**
   * 查询句柄 id —— 取消执行要用它。
   *
   * 为什么必须回传：主进程的 running 表是「查询开始才有、结束即删」的，
   * 渲染层没法在发起时就预知 id。早先只留了 `queryRunning()` 轮询这一条路，
   * 但那是竞态的（查询可能刚好跑完，句柄消失，取消静默失效）。
   */
  queryId: string | null;
  /**
   * 查询结果的可写回来源（A12 查询结果写回）。
   *
   * 主进程在执行 SELECT 后检测：当语句只引用【一张表】时，回填其所属库表，
   * 渲染层据此把结果集网格变成可编辑（写回走既有 mutationApply 链路）。
   * 检测不出（JOIN/聚合/多表/非 SELECT）时为 null —— 结果集保持只读。
   */
  source?: { database: string | null; table: string } | null;
}

export interface RunQueryRequest {
  connId: string;
  sql: string;
  /** 当前库上下文，用于写历史 */
  database?: string | null;
  /**
   * 客户端生成的查询句柄 id（可选）。
   *
   * 由渲染层生成并传入，主进程直接采用 —— 这样渲染层在【发起的瞬间】
   * 就握有取消句柄，不必等返回、不必轮询。
   */
  queryId?: string | null;
}

export interface MutationApplyRequest {
  connId: string;
  database: string;
  /**
   * T08：入口语义。缺省 `'grid-write'`。
   *
   * - `'grid-write'` —— 网格保存预演：语句可能含**原样嵌入的表达式**，走
   *   `checkMutationStatement`（只放行 insert/update/delete + 强制 WHERE）。
   * - `'ddl'` —— 树右键「删除表 / 清空表」等结构变更：走 `checkDdlStatement`
   *   （只放行 DDL 白名单 + 单语句）。
   *
   * 🔴 拆开的理由：同一个入口承载两类语义，用一把白名单卡死会导致
   *    「删除表」这类正常功能被表达式防线误伤（v0.6.1 实际缺陷）。
   */
  mode?: 'grid-write' | 'ddl';
  /**
   * T08/R15：写语句 + 逐条「预期影响行数」契约。
   *
   * - `expect: 'one'` —— 逐行 DML（编辑 UPDATE / DELETE、单行 INSERT）。主进程会
   *   逐条核对 `affectedRows === 1`；不符则**整批回滚**并返回冲突明细，绝不当作成功。
   * - `expect: 'any'`（缺省）—— DDL / 批量语句（DROP、批量删表等）。不做行数核对，
   *   因为它们本来就可能影响 0 行（`DROP TABLE IF EXISTS` 已删除时返回 0）。
   *
   * 不能对**所有** mutation 都要求「恰好 1 行」—— 同一入口同时承载 DDL，那会把
   * 正常的 DDL 判成失败；契约必须由调用方（知道自己发的是哪种语句）声明。
   */
  statements: {
    sql: string;
    params: unknown[];
    expect?: 'one' | 'any';
    kind?: 'insert' | 'update' | 'delete';
  }[];
}

/** T08：一条未满足预期行数的语句（提交已回滚） */
export interface MutationConflict {
  /** 语句在本次提交中的序号（从 0 起） */
  index: number;
  kind: string;
  expect: 'one' | 'any';
  actual: number;
  /** core-mutation.interpretResult 的判定：0 行 → conflict；多行 → ambiguous */
  outcome: 'conflict' | 'ambiguous';
  reason: string;
  sql: string;
  /** 已成功执行、但随本次提交一起被回滚的语句数 */
  executedBefore: number;
}

export interface MutationApplyResult {
  affected: number;
  elapsedMs: number;
  insertIds: (number | null)[];
  /**
   * T08：整批结果的判定。`'conflict'` / `'ambiguous'` 时**整批已回滚**，
   * `affected === 0`、`committed === false`，草稿必须保留。
   */
  outcome: 'ok' | 'conflict' | 'ambiguous';
  conflicts: MutationConflict[];
  /** 是否已提交落库（outcome === 'ok' 才为 true） */
  committed: boolean;
}

export interface TableBundle {
  database: string;
  table: TableMeta;
  /** 元数据是否来自磁盘缓存（UI 可提示"可能过期"） */
  fromCache: boolean;
  capturedAt: number | null;
}

export interface GlassModeDto {
  mode: 'native' | 'css' | 'none';
  reason: string | null;
}

export interface DiagnosticsDto {
  fps: number | null;
  memMb: number | null;
  runningQueries: number;
  liveConnections: number;
  darwinMajor: number | null;
}

/** V21：更新检查结论（服务端类型，渲染层只做展示） */
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  /** 中文结论，直接展示 */
  message: string;
  /** 是否真的可用（开发态 / 无发布通道时为 false） */
  available: boolean;
}

export interface SecretStateDto {
  mode: 'async' | 'sync-fallback' | 'unavailable';
  available: boolean;
  reason: string | null;
}

/** 保存连接时的入参（明文密码只在这一次 IPC 调用中出现，不落盘） */
export interface SaveConnectionRequest {
  config: ConnectionConfig;
  password?: string | null;
  passphrase?: string | null;
  promptEveryTime?: boolean;
}

// ---------- 对象定义与表信息（R1 竞品对齐：C2 / C9 / A14） ----------

/** 可查看 DDL 的对象类型 —— 与 core-tree-view 的 ObjectKind 对齐（多 trigger/event 两类） */
export type DbObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export interface ObjectDdlRequest {
  connId: string;
  database: string;
  name: string;
  kind: DbObjectKind;
}

export interface ObjectDdlResult {
  kind: DbObjectKind;
  name: string;
  database: string;
  /** SHOW CREATE 原文。不同对象类型的驱动返回列名不同（Create View 等），这里统一成字符串 */
  ddl: string;
}

export interface TableInfoRequest {
  connId: string;
  database: string;
  table: string;
}

/**
 * 表信息（information_schema.TABLES 单行）。
 * 🔴 rowsEstimate 是估算值（TABLE_ROWS），【绝不做全表 COUNT】——
 *    千万行表上一次精确 COUNT 就能把「最快查看器」变成「最卡查看器」。
 */
export interface TableInfoDto {
  engine: string | null;
  rowsEstimate: number | null;
  dataLength: number | null;
  indexLength: number | null;
  charset: string | null;
  collation: string | null;
  comment: string | null;
  createTime: string | null;
  autoIncrement: number | null;
}

// ---------- V9：外键导航与候选值 ----------

export interface ForeignKeysRequest {
  connId: string;
  database: string;
  table: string;
}

/**
 * 一条外键（复合外键的多个列合并在 columns/referencedColumns 里，顺序一一对应）。
 *
 * 🔴 顺序是 ORDINAL_POSITION 序：错位会让「本表第 1 列 = 引用表第 2 列」，
 *    跳转定位到错误的行 —— 不报错，只是静默给用户看错数据。
 */
export interface ForeignKeyDto {
  constraintName: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface ReferencedValuesRequest {
  connId: string;
  database: string;
  table: string;
  /** 引用列（= 候选值的 value） */
  valueColumn: string;
  /** 展示列（= label）；null = 用 valueColumn */
  displayColumn?: string | null;
  /** 服务端 LIKE 过滤（null = 不过滤） */
  keyword?: string | null;
  limit?: number;
}

/**
 * 候选值。
 *
 * 🔴 **必须带 limit**（主进程钳到 ≤500）：引用表可能百万行，
 *    全量拉回来就毁掉「最快查看器」—— 与 getTableInfo 绝不做 COUNT(*) 同源。
 */
export interface ReferencedValuesDto {
  items: { value: unknown; label: string }[];
  /** 命中数超过 limit（UI 提示"仅显示前 N 条，请继续输入过滤"） */
  truncated: boolean;
}

// ---------- T41：SQL 文件编辑闭环 ----------

/**
 * 文件戳 —— 「外部有没有动过这个文件」的唯一判据。
 *
 * 两个字段都要：mtime 在部分文件系统上只有秒级精度，size 是独立的第二证据。
 * 判定逻辑只在主进程 `main/sql-file.ts` 的 `detectExternalChange` 一处。
 */
export interface SqlFileStamp {
  mtimeMs: number;
  size: number;
}

export interface SqlFileReadResult {
  path: string;
  /** 已解好的正文（编码问题在主进程解决，渲染层绝不自己猜字节） */
  text: string;
  /** 识别出的编码名（'utf-8' / 'utf-8-bom' / 'utf-16le' / 'gb18030' / 'latin1' …） */
  encoding: string;
  /** 是否由 BOM 判定 */
  bom: boolean;
  /** 是否走了回退（非 UTF-8）—— true 时 note 必非空，UI 必须展示 */
  fallback: boolean;
  note: string | null;
  stamp: SqlFileStamp;
}

export interface SqlFileSaveRequest {
  /** 目标路径；null = 弹保存框（另存为） */
  path: string | null;
  content: string;
  /** 另存为时的默认文件名 */
  suggestedName?: string | null;
  /** 打开 / 上次保存时记下的戳；给了就先比对，不给表示不检查 */
  baseline?: SqlFileStamp | null;
  /** 用户在冲突弹窗里明确选择「仍然覆盖」 */
  force?: boolean;
}

/**
 * 保存结果。
 *
 * 🔴 `conflict: true` 时**文件一个字节都没写** —— 先发现再写，
 *    绝不是「写了再告诉用户覆盖错了」。
 */
export type SqlFileSaveResult =
  | { conflict: false; path: string; stamp: SqlFileStamp }
  | { conflict: true; path: string; current: SqlFileStamp | null };

// ---------- 导入/导出（D3 + §6.6） ----------

export type ExportFormat = 'xlsx' | 'csv' | 'json' | 'sql' | 'markdown';

/** 导出细化配置（E2）：不传的字段用各自格式的历史默认值 */
export interface ExportOptions {
  /** CSV/TSV 分隔符（默认 ','） */
  delimiter?: string | null;
  /** 编码：utf8 默认；utf8-bom 便于 Excel 直接打开不乱码 */
  encoding?: 'utf8' | 'utf8-bom' | null;
  /** NULL 值的文本表示（默认 \N） */
  nullText?: string | null;
  /** 是否含表头（默认 true） */
  includeHeader?: boolean | null;
}

export interface ExportStartRequest {
  connId: string;
  format: ExportFormat;
  /** 主进程弹保存框后由渲染层回填的绝对路径 */
  outputPath: string;
  database: string;
  /**
   * 表名。scope === 'database' 时忽略（整库导出，E4 轻量备份）。
   * 也接受 '*' 作为整库语义的兼容写法。
   */
  table: string;
  /** 非空时按 SQL 导出（B7 查询结果导出），忽略 table 的行数据语义 */
  sql?: string | null;
  columns?: { name: string; dataType: string }[] | null;
  /** 'table'（默认）= 单表；'database' = 整库全部表（仅 sql/markdown） */
  scope?: 'table' | 'database' | null;
  options?: ExportOptions | null;
}

export interface ImportPeekResult {
  /** 文件前 N 行（含表头） */
  rows: string[][];
  delimiter: string;
  format: 'csv' | 'tsv' | 'xlsx';
}

export interface ImportStartRequest {
  connId: string;
  filePath: string;
  format: 'csv' | 'tsv' | 'xlsx' | 'json';
  delimiter?: string | null;
  hasHeader: boolean;
  database: string;
  table: string;
  /** 文件列 → 表列名（null = 跳过该文件列）；JSON 导入时是【对象字段 → 表列名】 */
  mapping: (string | null)[];
  /** 表列元数据（worker 校验用） */
  columns: { name: string; dataType: string; nullable: boolean; autoIncrement: boolean }[];
  batchSize?: number;
  /** E5 失败行重跑：只导这些文件行号（0 基，不含表头）。缺省 = 全部行 */
  retryRows?: number[] | null;
}

export interface ImportDoneDetail {
  fileRow: number;
  column: string;
  reason: string;
}

export interface ImportDoneResult {
  rowsDone: number;
  elapsedMs: number;
  batches: number;
  invalidRows: number;
  invalidDetail: ImportDoneDetail[];
  totalRows: number;
}

// ---------- 运行 SQL 脚本（库/表级别，utilityProcess 流式执行） ----------

/** 脚本扫描统计（worker 阶段 1 产出，UI 摘要确认用） */
export interface ScriptScanStats {
  statements: number;
  ddl: number;
  dml: number;
  /** SET/USE/SELECT 等不改数据与结构的语句 */
  session: number;
  other: number;
  /** 检出 DROP DATABASE/SCHEMA —— UI 走第三层确认（输库名） */
  hasDropDatabase: boolean;
  /** 脚本含 DELIMITER 指令（存储过程/触发器） */
  hasDelimiter: boolean;
  fileBytes: number;
}

export interface ScriptStartRequest {
  connId: string;
  filePath: string;
  /** 脚本执行的默认库上下文（树节点所在库） */
  database: string;
  /** 脚本文件编码（utf8 默认；gbk 常见于国内旧导出） */
  encoding?: 'utf8' | 'gbk' | null;
  /** 遇错策略：'stop'（默认）| 'continue' */
  onError?: 'stop' | 'continue' | null;
}

export interface ScriptErrorDetail {
  /** 语句序号（1 基，按执行顺序） */
  no: number;
  message: string;
  /** 失败语句预览（压缩空白，≤200 字符） */
  sql: string;
}

export interface ScriptDoneResult {
  executed: number;
  failed: number;
  /**
   * v0.6.0-hotfix：MySQL **亲口报告**的写入行数（affectedRows 之和）。
   *
   * 🔴 为什么必须与 `executed` 分开：executed 是「我们认为发出了多少条」，
   *    affectedRows 是「数据库真的写进去多少行」。二者可以严重背离 ——
   *    2026-10-13 的数据丢失缺陷就是 executed=50004 / failed=0，
   *    但 affectedRows 只有 2002。UI 若只展示 executed，
   *    用户看到的就是「全部成功」，而库里少了 96% 的数据。
   *
   * 有了这个字段，UI 可以在 done 阶段做一致性核对并显式告警，
   * 让这类缺陷**不可能再静默通过**。
   */
  affectedRows?: number;
  elapsedMs: number;
  errors: ScriptErrorDetail[];
  /** true = 停止模式下中途失败退出 */
  aborted: boolean;
  /** aborted 时的最后一条错误 */
  lastError?: string | null;
}

/** 渲染侧通过 contextBridge 拿到的 API（preload 注入 window.dbStudio） */
export interface DbStudioApi {
  // ---- 连接 ----
  connList(): Promise<IpcResult<ConnListResult>>;
  connCreate(input: SaveConnectionRequest): Promise<IpcResult<ConnectionConfig>>;
  connUpdate(input: SaveConnectionRequest): Promise<IpcResult<ConnectionConfig>>;
  connDelete(id: string): Promise<IpcResult<boolean>>;
  connConnect(id: string, password?: string | null): Promise<IpcResult<ConnectResult>>;
  connDisconnect(id: string): Promise<IpcResult<null>>;
  connTest(input: SaveConnectionRequest): Promise<IpcResult<{ ok: boolean; serverVersion: string | null; elapsedMs: number; message: string | null }>>;

  // ---- Schema ----
  schemaGet(connId: string): Promise<IpcResult<DatabaseMeta[]>>;
  schemaRefresh(connId: string): Promise<IpcResult<DatabaseMeta[]>>;
  schemaGetTable(connId: string, database: string, table: string): Promise<IpcResult<TableBundle>>;
  schemaSearchColumn(connId: string, column: string): Promise<IpcResult<string[]>>;
  /** 对象定义查看（C2）：视图/存储过程/函数/触发器/事件/表的 SHOW CREATE */
  schemaGetObjectDdl(req: ObjectDdlRequest): Promise<IpcResult<ObjectDdlResult>>;
  /** 表信息（C9/A14）：information_schema.TABLES 估算，不做全表 COUNT */
  schemaGetTableInfo(req: TableInfoRequest): Promise<IpcResult<TableInfoDto>>;
  /** V9：外键列表（按需单表查，不进 introspect 的批量元数据） */
  schemaGetForeignKeys(req: ForeignKeysRequest): Promise<IpcResult<ForeignKeyDto[]>>;
  /** V9：外键候选值（服务端 LIMIT，绝不全表扫描） */
  schemaGetReferencedValues(req: ReferencedValuesRequest): Promise<IpcResult<ReferencedValuesDto>>;

  // ---- 查询 ----
  queryRun(req: RunQueryRequest): Promise<IpcResult<QueryOutcomeDto>>;
  queryOpenTable(req: OpenTableRequest): Promise<IpcResult<QueryOutcomeDto>>;
  queryCancel(queryId: string): Promise<IpcResult<boolean>>;
  queryRunning(): Promise<IpcResult<{ queryId: string; connectionId: string; sql: string; elapsedMs: number }[]>>;

  // ---- 写操作 ----
  mutationApply(req: MutationApplyRequest): Promise<IpcResult<MutationApplyResult>>;

  // ---- 导出/导入 ----
  exportStart(req: ExportStartRequest): Promise<IpcResult<{ jobId: string }>>;
  exportCancel(jobId: string): Promise<IpcResult<boolean>>;
  /** 弹保存框，返回绝对路径（取消返回 null） */
  exportPickPath(table: string, format: string): Promise<IpcResult<string | null>>;
  importStart(req: ImportStartRequest): Promise<IpcResult<{ jobId: string }>>;
  importCancel(jobId: string): Promise<IpcResult<boolean>>;
  /** 弹打开框选导入文件（取消返回 null） */
  importPickPath(): Promise<IpcResult<string | null>>;
  /** 读文件预览（前 N 行 + 分隔符探测） */
  importPeek(filePath: string, maxRows?: number): Promise<IpcResult<ImportPeekResult>>;

  // ---- 运行 SQL 脚本 ----
  /** 选好文件后发起：worker 先扫描统计，scan 消息回来后等 confirm/cancel */
  scriptStart(req: ScriptStartRequest): Promise<IpcResult<{ jobId: string }>>;
  /** 用户确认摘要后放行执行 */
  scriptConfirm(jobId: string): Promise<IpcResult<boolean>>;
  /** 取消（扫描等待期 / 执行中都有效；kill worker = 真取消） */
  scriptCancel(jobId: string): Promise<IpcResult<boolean>>;
  /** 弹打开框选 .sql 脚本文件（取消返回 null） */
  scriptPickPath(): Promise<IpcResult<string | null>>;

  // ---- 历史 ----
  historyList(connId: string | null, limit?: number): Promise<IpcResult<HistoryEntry[]>>;
  historySearch(keyword: string, limit?: number): Promise<IpcResult<HistoryEntry[]>>;
  historyClear(connId?: string | null): Promise<IpcResult<number>>;
  /** V6：删单条历史（返回是否命中） */
  historyDelete(id: number): Promise<IpcResult<boolean>>;
  /** V6：星标/取消星标（返回是否命中） */
  historyStar(id: number, starred: boolean): Promise<IpcResult<boolean>>;
  snippetList(): Promise<IpcResult<Snippet[]>>;
  /**
   * 按名保存/覆盖片段 —— v0.6.0 起是**同一连接 + 同一库**内同名即覆盖。
   * 归属维度是这轮加的：同名片段要在不同库各存一份，靠 connectionId/database 区分。
   */
  snippetSave(s: {
    name: string;
    sql: string;
    description?: string | null;
    connectionId?: string;
    database?: string;
  }): Promise<IpcResult<Snippet>>;

  // ---- 应用 ----
  appGetMode(): Promise<IpcResult<GlassModeDto>>;
  appSetGlass(enabled: boolean): Promise<IpcResult<GlassModeDto>>;
  appDiagnostics(): Promise<IpcResult<DiagnosticsDto>>;
  secretState(): Promise<IpcResult<SecretStateDto>>;

  /** 弹系统文件选择器，返回绝对路径；用户取消返回 null */
  pickPrivateKey(): Promise<IpcResult<string | null>>;

  /** BLOB/图片另存（A10）：弹保存框并写入磁盘，返回实际路径；取消返回 null */
  saveBinary(req: { suggestedName: string; data: ArrayBuffer }): Promise<IpcResult<string | null>>;

  // ---- T41：SQL 文件（打开只装载内容，不执行；保存只写文件，不执行）----
  /** 弹打开框选 .sql 文件（取消返回 null） */
  sqlFilePick(): Promise<IpcResult<string | null>>;
  /** 读文件正文（含编码探测与回退） */
  sqlFileRead(path: string): Promise<IpcResult<SqlFileReadResult>>;
  /** 保存 / 另存为；被外部改过且未 force 时返回 conflict=true 且不写盘 */
  sqlFileSave(req: SqlFileSaveRequest): Promise<IpcResult<SqlFileSaveResult>>;

  /**
   * W 板块：答复主进程的关闭询问。
   *
   * 只有 true 会让窗口真的关闭；false = 用户反悔，窗口保持不动。
   * 渲染层必须在收到 APP_BEFORE_CLOSE_ASK 后**一定**答复一次，
   * 否则主进程 3s 兜底会强制关闭（防止渲染层崩溃后窗口关不掉）。
   */
  replyBeforeClose(ok: boolean): Promise<IpcResult<null>>;

  /** V21：手动检查更新，返回中文结论（开发态返回「开发模式不检查更新」） */
  appCheckUpdate(): Promise<IpcResult<UpdateCheckResult>>;

  /**
   * V23：在新窗口打开一张表。
   * 窗口数达上限 / 创建失败时返回带中文原因的失败结果（消息直接可展示）。
   */
  openWindowInNew(req: { connId: string; database: string; table: string }): Promise<IpcResult<{ opened: boolean }>>;

  /** 订阅主进程推送（连接状态变化等），返回退订函数 */
  on(channel: string, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    dbStudio: DbStudioApi;
    /** 通道名表，避免渲染侧硬编码字符串 */
    dbStudioChannels: Record<string, string>;
    /** 渲染层据此判断跑在 Electron（有真 IPC）还是纯浏览器（降级 demo） */
    dbStudioRuntime: { hasIpc: boolean };
  }
}
