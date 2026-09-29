/**
 * MySQL 驱动封装
 *
 * 依据：
 *  - docs/engineering/TECH-REVIEW-v1.0.md §4.4 驱动连接参数规范（R10）—— 直接决定数据正确性
 *  - §4.3 长查询取消：管理连接发 `KILL QUERY <id>` + `max_execution_time` 兜底
 *  - §4.5 Schema 缓存：连接成功后异步拉取元数据
 *  - §5.1 冷启动：驱动【懒加载】，不在 app.whenReady() 里 require
 *
 * 三条硬约束：
 *  1. 驱动模块只在 connect() 里 `await import()` —— 冷启动不能付这份钱
 *  2. 所有值走 ? 占位参数绑定；标识符走 identifier.ts 转义
 *  3. 结果集默认 rowsAsArray（省内存），字段元信息单独返回
 */

import type { DatabaseMeta, ColumnMeta, TableMeta, ObjectKind } from '@dbstudio/core-schema-cache';
import { quoteIdentifier } from '@dbstudio/core-sql-ident';

// 标识符转义已抽到零依赖的 core-sql-ident（原因见该包文件头）。
// 这里 re-export 是为了保持既有 import 路径可用，新代码请直接引 core-sql-ident。
export { quoteIdentifier, quoteQualified, joinIdentifiers, IdentifierError } from '@dbstudio/core-sql-ident';

// ---------- R10 驱动参数 ----------

/**
 * SSL/TLS 材料 —— 值是【文件内容字符串】（PEM 文本），不是路径。
 *
 * 为什么驱动层只认内容不认路径：mysql2 只吃内容；读文件属于"连接配置 →
 * 驱动参数"的翻译工作，归主进程（session-registry）负责，驱动不碰文件系统。
 */
export interface MySqlSslOptions {
  /** CA 证书内容（用于校验服务端证书） */
  ca?: string;
  /** 客户端证书内容（双向认证时） */
  cert?: string;
  /** 客户端私钥内容（双向认证时） */
  key?: string;
  /**
   * 是否校验服务端证书。缺省 true（mysql2 自身默认依赖 Node 环境变量，这里显式化）。
   * 显式 false = 关闭校验 —— 不安全，UI 必须显示黄色警示条（core-connection §6.1.3）。
   */
  rejectUnauthorized?: boolean;
}

export interface MySqlCredentials {
  host: string;
  port: number;
  user: string;
  password: string | null;
  database?: string | null;
  /**
   * SSL/TLS 材料（内容形态，见 MySqlSslOptions）。
   *
   * 🔴 null / 缺省 = 不启用 TLS，构造连接参数时【不出现 ssl 键】——
   *    mysql2 以"是否传了 ssl 选项"判定是否走 TLS，传空对象也会开启
   *    加密握手，所以"没启用"必须干净到键都不存在。
   */
  ssl?: MySqlSslOptions | null;
  /**
   * 底层传输流工厂 —— SSH 隧道走这里（每次调用返回一条【新的】channel）。
   *
   * 🔴 必须是工厂而不是单个 stream：主连接与 KILL QUERY 的管理连接各要一条
   *    独立的 TCP 通道。复用同一条 channel 会互相串包（真机实测：两条
   *    mysql2 连接共用一个 channel 时，第二条握手直接卡死）。
   *
   * 🔴 为什么是 async：mysql2 的 `stream` 选项若传【函数】是同步调用的
   *    （`this.stream = opts.config.stream(opts)`），返回 Promise 会让它
   *    拿到 Promise 再去 `.on()` → `this.stream.on is not a function`。
   *    所以必须由调用方先 await 出 stream，再以对象形式传进 mysql2。
   */
  streamFactory?: (() => Promise<unknown>) | null;
}

/**
 * R10 固定的驱动参数。这些值不是偏好，是正确性要求：
 *  - supportBigNumbers + bigNumberStrings：BIGINT > 2^53 不丢精度
 *  - dateStrings：保留服务端原文（含 DATETIME(6) 微秒），避免"看 UTC 写回本地时间"
 *  - jsonStrings：保留 JSON 原文，避免自动 parse 损大整数精度
 *  - multipleStatements:false：默认禁多语句（注入面）
 *  - rowsAsArray：大结果集省内存省 GC
 */
export const R10_DRIVER_OPTIONS = {
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  dateStrings: true,
  timezone: 'local',
  jsonStrings: true,
  multipleStatements: false,
  rowsAsArray: true,
} as const;

/**
 * 把 MySqlSslOptions 映射成 mysql2 的 ssl 选项对象。
 *
 * 规则：
 *  - ssl 为 null/缺省 → 返回 null（调用方保证连接参数里不出现 ssl 键）
 *  - ssl 存在但一项都映射不上（无内容且未显式给 rejectUnauthorized）→ 也返回 null
 *  - 只要映射出至少一项，rejectUnauthorized 缺省按 true 透传
 */
function toMysql2Ssl(ssl: MySqlSslOptions | null | undefined): Record<string, unknown> | null {
  if (!ssl) return null;
  const out: Record<string, unknown> = {};
  // 空串视为未配置（readFile 不会产出空串的正常证书，防御脏数据误开 TLS）
  if (ssl.ca) out.ca = ssl.ca;
  if (ssl.cert) out.cert = ssl.cert;
  if (ssl.key) out.key = ssl.key;
  if (ssl.rejectUnauthorized !== undefined) out.rejectUnauthorized = ssl.rejectUnauthorized;
  if (Object.keys(out).length === 0) return null;
  out.rejectUnauthorized ??= true;
  return out;
}

export function mysqlConnectionOptions(
  cred: MySqlCredentials,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const ssl = toMysql2Ssl(cred.ssl);
  return {
    host: cred.host,
    port: cred.port,
    user: cred.user,
    password: cred.password ?? '',
    ...(cred.database ? { database: cred.database } : {}),
    // ssl 只在确实有材料时出现；没启用时键都不存在 —— mysql2 靠
    // "有没有 ssl 对象"判定是否启用 TLS，空对象会误开加密握手
    ...(ssl ? { ssl } : {}),
    // 走隧道时不传 stream 给 mysql2 —— stream 是【对象】形态且每条连接
    // 必须不同，只能在 createConnection 调用点现取现传（见 connect()）。
    // 这里保留字段但不填值，避免有人误以为配置层就能解决。
    ...R10_DRIVER_OPTIONS,
    ...over,
  };
}

/** 被排除的系统库（introspect 不关心） */
export const SYSTEM_SCHEMAS = ['mysql', 'sys', 'performance_schema', 'information_schema'] as const;

// ---------- 查询接口抽象（便于无 DB 单测） ----------

export interface FieldMeta {
  name: string;
  /** mysql2 的类型码 */
  type: number;
  length?: number;
  /**
   * V15：列的来源表名（mysql2 字段包的 `orgTable`，取原始表名而非别名）。
   *
   * 为什么必须是 orgTable 而不是 table：JOIN 里用户写的是别名（o / u），
   * 展示别名对用户没帮助 —— 他要的是「这一列来自哪张物理表」。
   * 聚合列 / 常量列 / 表达式列没有来源表，为 null（渲染层据此不显示 tooltip）。
   */
  sourceTable?: string | null;
}

export interface QueryResult {
  rows: unknown[][];
  fields: FieldMeta[];
  affectedRows: number;
  insertId: number | null;
  /** 语句耗时（ms） */
  elapsedMs: number;
}

/** 最小连接契约 —— 真驱动与测试替身都实现它 */
export interface DriverConn {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export interface MySqlModuleLike {
  createConnection(opts: Record<string, unknown>): Promise<DriverConn>;
}

/**
 * 建一条底层连接。
 *
 * 隧道模式下要先 await 出 channel 再传 stream —— 见 MySqlCredentials.streamFactory
 * 注释里那个 mysql2 的同步陷阱。
 */
async function createConn(
  mod: MySqlModuleLike,
  base: Record<string, unknown>,
  cred: MySqlCredentials,
): Promise<DriverConn> {
  if (!cred.streamFactory) return mod.createConnection(base);
  const stream = await cred.streamFactory();
  return mod.createConnection({ ...base, stream });
}

export interface DriverDeps {
  /** 注入模块加载器（测试用替身，生产默认懒加载 mysql2/promise） */
  loadModule?: () => Promise<MySqlModuleLike>;
  now?: () => number;
}

async function defaultLoadModule(): Promise<MySqlModuleLike> {
  // 懒加载：冷启动路径上不 require 驱动（§5.1 第 1 条）
  const mod: any = await import('mysql2/promise');
  return {
    createConnection: (opts) => mod.createConnection(opts),
  };
}

export class DriverError extends Error {
  constructor(
    message: string,
    /** MySQL 原始错误码（如 ER_ACCESS_DENIED_ERROR） */
    readonly code?: string,
    readonly errno?: number,
    readonly sqlState?: string,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/** 把 mysql2 抛出的错误归一化（UI 要展示原始错误码与原文，不做翻译） */
export function normalizeError(e: unknown): DriverError {
  const anyE = e as any;
  if (anyE instanceof DriverError) return anyE;
  return new DriverError(
    String(anyE?.message ?? e),
    anyE?.code,
    anyE?.errno,
    anyE?.sqlState,
  );
}

// ---------- 驱动 ----------

/**
 * 隧道句柄的最小契约 —— 驱动只关心"用完能关"，不关心它是 ssh2 还是别的。
 *
 * 这样 core-driver-mysql 不必依赖 core-ssh-tunnel（依赖方向保持单向：
 * 隧道 → 被驱动使用，而不是驱动认识隧道）。
 */
export interface TunnelHandle {
  close(): Promise<void>;
}

export interface MySqlDriverOptions {
  /** 连接级只读：开启后执行前拦截由 sql-guard 负责，这里是纵深防御 */
  readOnly?: boolean;
  /** 连接后执行 SET SESSION max_execution_time（ms）。0 = 不设置 */
  maxExecutionTimeMs?: number;
  /** 纵深防御：SET SESSION TRANSACTION READ ONLY。需服务端支持，默认关闭 */
  enforceTransactionReadOnly?: boolean;
  /**
   * 绑在本驱动上的 SSH 隧道。
   *
   * 评审 §4.6 要求「隧道与 DB 连接成对管理」—— 挂在驱动上而不是让调用方
   * 自己记着关，是为了杜绝"断开连接但隧道还活着"的孤儿进程
   * （PRD §6.1.2 明确红线）。driver.close() 会一并释放它。
   */
  tunnel?: TunnelHandle | null;
}

// ---------- 对象定义与表信息（C2 / C9+A14） ----------

/** SHOW CREATE 后面跟的动词 —— 六类对象一一对应，缺一不可 */
const SHOW_CREATE_VERB: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  event: 'EVENT',
};

/**
 * 各对象类型 SHOW CREATE 结果里承载 DDL 原文的列名。
 * 🔴 MySQL 对不同对象类型的列名【各不相同】（触发器甚至叫 SQL Original Statement），
 *    必须逐个适配，不能假设有统一的列。
 */
export const SHOW_CREATE_DDL_COLUMN: Record<ObjectKind, string> = {
  table: 'Create Table',
  view: 'Create View',
  procedure: 'Create Procedure',
  function: 'Create Function',
  trigger: 'SQL Original Statement',
  event: 'Create Event',
};

/** information_schema.TABLES 单行的表信息（C9 表信息面板 / A14 行数估算） */
export interface TableInfo {
  engine: string | null;
  /** TABLE_ROWS —— InnoDB 是估算值，UI 必须标"约" */
  rowsEstimate: number | null;
  dataLength: number | null;
  indexLength: number | null;
  /** 由 collation 前缀推导（TABLES 表没有独立的字符集列） */
  charset: string | null;
  collation: string | null;
  comment: string | null;
  /** CREATE_TIME 服务端原文（dateStrings 下是 'YYYY-MM-DD HH:MM:SS'） */
  createTime: string | null;
  autoIncrement: number | null;
}

/** utf8mb4_0900_ai_ci → utf8mb4；无下划线（如 binary）本身就是字符集名 */
function charsetFromCollation(collation: string | null): string | null {
  if (!collation) return null;
  const i = collation.indexOf('_');
  return i > 0 ? collation.slice(0, i) : collation;
}

/**
 * 外键元数据（V9 外键值导航与下拉选择器）。
 *
 * 刻意**不放进 introspect 的常规元数据**（DatabaseMeta/TableMeta）：
 *  - introspect 是「库 → 全部表 → 全部列」的批量拉取，树首屏要走它；
 *    给每张表再挂一次 KEY_COLUMN_USAGE 查询会拖慢首屏（PRD §7 预算）；
 *  - 外键只在「用户点开某张表并聚焦到某个外键单元格」时才需要 —— 按需单表查。
 */
export interface ForeignKeyMeta {
  /** 约束名（复合外键的多列共享一个名字） */
  constraintName: string;
  /** 本表的列，按 ORDINAL_POSITION 排序（复合外键为多列） */
  columns: string[];
  /** 引用的库（跨库外键时与当前库不同） */
  referencedDatabase: string;
  referencedTable: string;
  /** 引用的列，顺序与 columns 一一对应 */
  referencedColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export class MySqlDriver {
  private conn: DriverConn | null = null;
  private admin: DriverConn | null = null;
  private _connectionId: number | null = null;
  private _serverVersion: string | null = null;
  /** 当前正在执行的查询序号，用于取消后识别"被 kill 的是哪一条" */
  private _runningQuerySerial = 0;

  constructor(
    private readonly cred: MySqlCredentials,
    private readonly opts: MySqlDriverOptions = {},
    private readonly deps: DriverDeps = {},
  ) {}

  get connectionId(): number | null {
    return this._connectionId;
  }

  get serverVersion(): string | null {
    return this._serverVersion;
  }

  get isConnected(): boolean {
    return this.conn !== null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async connect(): Promise<{ serverVersion: string; elapsedMs: number }> {
    const load = this.deps.loadModule ?? defaultLoadModule;
    const started = this.now();
    const mod = await load();
    const base = mysqlConnectionOptions(this.cred);

    this.conn = await createConn(mod, base, this.cred);
    // 管理连接：专门用于 KILL QUERY（MySQL 无带内取消，§4.3）
    this.admin = await createConn(mod, base, this.cred);

    const [vRows] = await this.conn.query('SELECT VERSION() AS v, CONNECTION_ID() AS id');
    const first = (vRows as unknown[][])[0] ?? [];
    this._serverVersion = String(first[0] ?? '');
    this._connectionId = Number(first[1] ?? 0);

    await this.applySessionGuards();

    return {
      serverVersion: this._serverVersion,
      elapsedMs: this.now() - started,
    };
  }

  private async applySessionGuards(): Promise<void> {
    if (!this.conn) return;
    const stmts: string[] = [];

    if (this.opts.maxExecutionTimeMs && this.opts.maxExecutionTimeMs > 0) {
      // 仅对 SELECT 生效的硬上限，防止忘记取消的连接长期占用资源
      stmts.push(`SET SESSION max_execution_time = ${Math.floor(this.opts.maxExecutionTimeMs)}`);
    }
    if (this.opts.enforceTransactionReadOnly) {
      // 纵深防御，绝不当唯一防线（作用域受 autocommit 与事务边界影响）
      stmts.push('SET SESSION TRANSACTION READ ONLY');
    }

    for (const s of stmts) {
      try {
        await this.conn.query(s);
      } catch {
        // 服务端不支持时静默跳过：这是兜底项，失败不该让连接建立失败
      }
    }
  }

  /** 执行查询。rowsAsArray:true → rows 为二维数组 */
  async query(sql: string, values: unknown[] = []): Promise<QueryResult> {
    if (!this.conn) throw new DriverError('连接未建立');
    const started = this.now();
    this._runningQuerySerial++;

    let rowsRaw: unknown;
    let fieldsRaw: unknown;
    try {
      [rowsRaw, fieldsRaw] = await this.conn.query(sql, values);
    } catch (e) {
      throw normalizeError(e);
    }

    // V15：顺手带上列的来源表名。mysql2 的字段包里 `table` 是别名、
    // `orgTable` 才是物理表名；两者都可能是 undefined（聚合/常量列）——
    // 用 ?? null 归一，让渲染层只判 null 不用判 undefined。
    const fields: FieldMeta[] = Array.isArray(fieldsRaw)
      ? (fieldsRaw as any[]).map((f) => ({
          name: String(f?.name ?? ''),
          type: Number(f?.type ?? 0),
          sourceTable: (f?.orgTable ?? f?.table ?? null) as string | null,
        }))
      : [];

    // mysql2 对 INSERT/UPDATE/DELETE 返回 OkPacket（对象，非数组）
    const resultSet = rowsRaw as any;
    const isResultSet = Array.isArray(resultSet);

    return {
      rows: isResultSet ? (resultSet as unknown[][]) : [],
      fields,
      affectedRows: isResultSet ? resultSet.length : Number(resultSet?.affectedRows ?? 0),
      insertId: !isResultSet && resultSet?.insertId != null ? Number(resultSet.insertId) : null,
      elapsedMs: this.now() - started,
    };
  }

  /**
   * 取消当前查询（Cmd+. / 取消按钮）。
   * MySQL 没有带内取消 —— 只能从管理连接发 KILL QUERY。
   * 原连接上的 query 会以 error 返回，调用方按"已取消"处理。
   *
   * ⚠️ KILL 语句【不支持占位符参数】：`KILL QUERY ?` 会被服务端直接拒绝
   * （真库实测，e2e 冒烟暴露）。connection_id 来自 CONNECTION_ID()，
   * 是我们自己拿到的整数（非用户输入），因此这里内联是安全的 ——
   * 且必须做整数强转，杜绝任何注入面。
   */
  async cancel(): Promise<boolean> {
    if (!this.admin || this._connectionId == null) return false;
    const id = Math.floor(Number(this._connectionId));
    if (!Number.isInteger(id) || id <= 0) return false;
    try {
      await this.admin.query(`KILL QUERY ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const errs: unknown[] = [];
    for (const c of [this.conn, this.admin]) {
      if (!c) continue;
      try {
        await c.end();
      } catch (e) {
        errs.push(e);
      }
    }
    this.conn = null;
    this.admin = null;
    this._connectionId = null;
    this._runningQuerySerial = 0;

    // 隧道必须跟着连接一起释放（PRD §6.1.2：不残留孤儿进程）。
    // 放在 DB 连接关闭之后 —— 先断业务，再断承载它的通道。
    const tunnel = this.opts.tunnel;
    if (tunnel) {
      try {
        await tunnel.close();
      } catch (e) {
        // 隧道关不掉不能掩盖 DB 连接的真正错误，只追加不覆盖
        errs.push(e);
      }
    }

    if (errs.length > 0) throw normalizeError(errs[0]);
  }

  // ---------- 元数据 introspect（§4.5） ----------

  /** 列出库（排除系统库）。传 null 表示自动（defaultDatabase 优先） */
  async listDatabases(): Promise<string[]> {
    const res = await this.query(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(',')})
       ORDER BY SCHEMA_NAME`,
      [...SYSTEM_SCHEMAS],
    );
    return res.rows.map((r) => String(r[0]));
  }

  /**
   * 拉取库 → 表 → 字段的完整元数据，输出 core-schema-cache 的 DatabaseMeta[]。
   * 查询（库/表/字段/索引/触发器/事件）全部固定条数，不逐表往返 —— 库多时这是数量级差异。
   *
   * 触发器/事件（C1）是元数据增强：这两条查询失败【不该】拖垮核心的库表树
   * （权限不足、老版本服务端缺 EVENTS 表等），所以单独 catch 成空结果，
   * 而不是和库/表/字段一样让整个 introspect 失败。
   */
  async introspect(schemas?: string[]): Promise<DatabaseMeta[]> {
    const targets = schemas ?? (this.cred.database ? [this.cred.database] : await this.listDatabases());
    if (targets.length === 0) return [];

    const placeholders = targets.map(() => '?').join(',');

    const [dbRes, tblRes, colRes, idxRes, trgRes, evtRes] = await Promise.all([
      this.query(
        `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (${placeholders})`,
        [...targets],
      ),
      this.query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT, TABLE_COLLATION
         FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        [...targets],
      ),
      this.query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
                COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY, EXTRA,
                CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        [...targets],
      ),
      // 唯一键分组：复合唯一键必须按【索引组】定位，单列判定会过约束
      this.query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [...targets],
      ),
      this.query(
        `SELECT TRIGGER_SCHEMA, TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (${placeholders})
         ORDER BY TRIGGER_SCHEMA, TRIGGER_NAME`,
        [...targets],
      ).catch(() => null),
      // 只列启用中的事件：DISABLED 的事件不执行，列出来只会误导
      this.query(
        `SELECT EVENT_SCHEMA, EVENT_NAME FROM information_schema.EVENTS
         WHERE EVENT_SCHEMA IN (${placeholders}) AND STATUS = 'ENABLED'
         ORDER BY EVENT_SCHEMA, EVENT_NAME`,
        [...targets],
      ).catch(() => null),
    ]);

    // 库：以 targets 为基准建节点，SCHEMATA 只用于补充字符集/排序规则。
    // 不能反过来——权限过滤或视图差异可能让 SCHEMATA 查不到库，
    // 那样会整库丢失，而 targets 是我们明确指定要看的。
    const dbMap = new Map<string, DatabaseMeta>();
    for (const name of targets) {
      dbMap.set(name, { name, charset: null, collation: null, tables: [] });
    }
    for (const r of dbRes.rows) {
      const name = String(r[0]);
      const meta = dbMap.get(name);
      if (!meta) continue;
      meta.charset = r[1] != null ? String(r[1]) : null;
      meta.collation = r[2] != null ? String(r[2]) : null;
    }

    // 表 / 视图
    const tableKey = (db: string, t: string) => `${db}\u0000${t}`;
    const tableMap = new Map<string, TableMeta>();
    for (const r of tblRes.rows) {
      const db = String(r[0]);
      const name = String(r[1]);
      const tableType = String(r[2] ?? '');
      const kind: TableMeta['kind'] =
        tableType === 'VIEW' ? 'view' : tableType === 'BASE TABLE' ? 'table' : 'table';
      const meta: TableMeta = {
        name,
        kind,
        comment: r[5] != null ? String(r[5]) : null,
        // InnoDB 下 TABLE_ROWS 是估算值，UI 必须标注"约"
        estimatedRows: r[4] != null ? Number(r[4]) : null,
        engine: r[3] != null ? String(r[3]) : null,
        collation: r[6] != null ? String(r[6]) : null,
        columns: [],
      };
      const dbMeta = dbMap.get(db);
      if (!dbMeta) continue;
      dbMeta.tables.push(meta);
      tableMap.set(tableKey(db, name), meta);
    }

    // 唯一键分组（NON_UNIQUE = 0 且非 PRIMARY）
    const uniqueGroups = new Map<string, Map<string, string[]>>();
    for (const r of idxRes.rows) {
      const db = String(r[0]);
      const tbl = String(r[1]);
      const idxName = String(r[2]);
      const col = String(r[3]);
      const nonUnique = Number(r[4]);
      if (nonUnique !== 0) continue;
      if (idxName === 'PRIMARY') continue;
      const k = tableKey(db, tbl);
      let groups = uniqueGroups.get(k);
      if (!groups) {
        groups = new Map();
        uniqueGroups.set(k, groups);
      }
      const arr = groups.get(idxName) ?? [];
      arr.push(col);
      groups.set(idxName, arr);
    }

    // 字段
    const seenSingleUnique = new Map<string, Set<string>>();
    for (const r of colRes.rows) {
      const db = String(r[0]);
      const tbl = String(r[1]);
      const meta = tableMap.get(tableKey(db, tbl));
      if (!meta) continue;

      const colName = String(r[2]);
      const extra = String(r[8] ?? '');
      const isPrimaryKey = String(r[7] ?? '') === 'PRI';

      // 唯一键：单列唯一（UNI）直接标记；复合唯一靠 uniqueGroups 判定
      const groups = uniqueGroups.get(tableKey(db, tbl));
      const inUniqueGroup = groups
        ? [...groups.values()].some((cols) => cols.includes(colName))
        : false;
      const isUnique = String(r[7] ?? '') === 'UNI' || inUniqueGroup;

      if (isUnique && !isPrimaryKey) {
        const s = seenSingleUnique.get(tableKey(db, tbl)) ?? new Set();
        s.add(colName);
        seenSingleUnique.set(tableKey(db, tbl), s);
      }

      const col: ColumnMeta = {
        name: colName,
        dataType: String(r[3] ?? ''),
        nullable: String(r[4] ?? '') === 'YES',
        defaultValue: r[5] != null ? String(r[5]) : null,
        comment: r[6] != null ? String(r[6]) : null,
        isPrimaryKey,
        isUnique,
        autoIncrement: extra.includes('auto_increment'),
        charset: r[9] != null ? String(r[9]) : null,
        collation: r[10] != null ? String(r[10]) : null,
      };
      meta.columns.push(col);
    }

    // 复合唯一键分组挂到表上（可选字段，core-mutation 会用）
    for (const [k, groups] of uniqueGroups) {
      const meta = tableMap.get(k);
      if (!meta || groups.size === 0) continue;
      (meta as TableMeta & { uniqueGroups?: string[][] }).uniqueGroups = [...groups.values()];
    }

    // 触发器（C1）：跟随 procedure/function 的表示方式 —— 进 db.tables、用 kind 区分。
    // 不进 tableMap：触发器没有列，COLUMNS/STATISTICS 的装配不该碰它。
    if (trgRes) {
      for (const r of trgRes.rows) {
        const dbMeta = dbMap.get(String(r[0]));
        if (!dbMeta) continue;
        dbMeta.tables.push({
          name: String(r[1]),
          kind: 'trigger',
          comment: null,
          estimatedRows: null,
          engine: null,
          collation: null,
          columns: [],
          triggerTable: r[2] != null ? String(r[2]) : null,
          triggerTiming: r[3] != null ? String(r[3]) : null,
          triggerEvent: r[4] != null ? String(r[4]) : null,
        });
      }
    }

    // 事件（C1）：只要名字（STATUS='ENABLED' 已在查询里过滤）
    if (evtRes) {
      for (const r of evtRes.rows) {
        const dbMeta = dbMap.get(String(r[0]));
        if (!dbMeta) continue;
        dbMeta.tables.push({
          name: String(r[1]),
          kind: 'event',
          comment: null,
          estimatedRows: null,
          engine: null,
          collation: null,
          columns: [],
        });
      }
    }

    return [...dbMap.values()];
  }

  // ---------- 对象定义与表信息（C2 / C9+A14） ----------

  /**
   * 查看对象定义原文（SHOW CREATE ...）。
   *
   * 定位 DDL 列【按列名不按下标】：rowsAsArray 下各类型 DDL 列的位置不同
   * （PROCEDURE 在第 3 列、EVENT 在第 4 列，VIEW 后面还跟 character_set_client 等
   * 需要丢弃的列），按下标硬编码会在服务端版本差异上翻车。
   * 对象不存在时服务端直接报错（ER_NO_SUCH_TABLE 等），由调用方归类为 NOT_FOUND。
   */
  async showCreateObject(database: string, name: string, kind: ObjectKind): Promise<string> {
    const res = await this.query(
      `SHOW CREATE ${SHOW_CREATE_VERB[kind]} ${quoteIdentifier(database)}.${quoteIdentifier(name)}`,
    );
    const row = res.rows[0];
    const idx = res.fields.findIndex((f) => f.name === SHOW_CREATE_DDL_COLUMN[kind]);
    const ddl = row && idx >= 0 ? row[idx] : null;
    if (typeof ddl !== 'string' || ddl.length === 0) {
      // 查询成功但没有 DDL 列/行：语义上就是"对象不存在"（正常情况服务端会先报错），
      // 带上 ER_NO_SUCH_TABLE 让会话层能归类成 NOT_FOUND
      throw new DriverError(`${database}.${name}（${kind}）不存在或无法读取定义`, 'ER_NO_SUCH_TABLE');
    }
    return ddl;
  }

  /**
   * 表信息：只查 information_schema.TABLES 一行。
   *
   * 🔴 绝不做 SELECT COUNT(*) —— 行数用 TABLE_ROWS 估算值。千万行表上一次
   *    精确 COUNT 就能把「最快查看器」变成「最卡查看器」（PRD 性能预算 §7），
   *    这是红线，任何"顺手精确一下"的优化都是倒退。
   *
   * 列顺序由本方法的 SELECT 文本决定（rowsAsArray 下按下标解构即可）；
   * 返回 null 表示表不存在，由调用方决定报错方式。
   */
  async getTableInfo(database: string, table: string): Promise<TableInfo | null> {
    const res = await this.query(
      `SELECT ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, TABLE_COLLATION,
              TABLE_COMMENT, CREATE_TIME, AUTO_INCREMENT
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    const row = res.rows[0];
    if (!row) return null;

    const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
    // DATA_LENGTH/AUTO_INCREMENT 是 BIGINT 列：bigNumberStrings 下以字符串到达，
    // 转数字（超出 Number 安全范围时精度无意义 —— 表信息展示场景可接受）
    const num = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const collation = str(row[4]);

    return {
      engine: str(row[0]),
      rowsEstimate: num(row[1]),
      dataLength: num(row[2]),
      indexLength: num(row[3]),
      collation,
      // 字符集从排序规则前缀推导：utf8mb4_0900_ai_ci → utf8mb4；
      // 无下划线（如 binary）本身就是字符集名
      charset: charsetFromCollation(collation),
      comment: str(row[5]),
      createTime: str(row[6]),
      autoIncrement: num(row[7]),
    };
  }

  /**
   * V9：查一张表的外键（information_schema.KEY_COLUMN_USAGE + REFERENTIAL_CONSTRAINTS）。
   *
   * 两条查询合成一次往返的取舍：REFERENTIAL_CONSTRAINTS 才有 DELETE_RULE/UPDATE_RULE，
   * KEY_COLUMN_USAGE 才有列与引用列的对应关系。这里用 JOIN 一次拿全，
   * 而不是两次查询在 JS 里拼 —— 外键数量少，JOIN 的代价可忽略，但往返省一半。
   *
   * 🔴 复合外键必须按约束名分组、按 ORDINAL_POSITION 排序：
   *    顺序错了会让「本表第 1 列 = 引用表第 2 列」，跳转定位到错误的行
   *    —— 这类 bug 不报错，只是静默给用户看错数据。
   */
  async listForeignKeys(database: string, table: string): Promise<ForeignKeyMeta[]> {
    const res = await this.query(
      `SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
              kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
              rc.DELETE_RULE, rc.UPDATE_RULE, kcu.ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
       WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database, table],
    );

    const byName = new Map<string, ForeignKeyMeta>();
    for (const r of res.rows) {
      const name = String(r[0]);
      const fk = byName.get(name) ?? {
        constraintName: name,
        columns: [],
        referencedDatabase: String(r[2] ?? database),
        referencedTable: String(r[3] ?? ''),
        referencedColumns: [],
        onDelete: r[5] != null ? String(r[5]) : null,
        onUpdate: r[6] != null ? String(r[6]) : null,
      };
      fk.columns.push(String(r[1]));
      fk.referencedColumns.push(String(r[4] ?? ''));
      byName.set(name, fk);
    }
    return [...byName.values()];
  }

  /**
   * V9：外键列的候选值（下拉选择器的数据源）。SQL 由纯函数
   * buildReferencedValuesSql 构造（可离线单测），这里只负责执行与结果整形。
   */
  async lookupReferencedValues(o: ReferencedValueQuery): Promise<ReferencedValueLookup> {
    const { sql, params, limit, hasDisplayColumn } = buildReferencedValuesSql(o);
    const res = await this.query(sql, params);
    // 多取的那一行只用来判断「还有更多」，不展示给用户
    const truncated = res.rows.length > limit;
    const rows = truncated ? res.rows.slice(0, limit) : res.rows;
    return {
      items: rows.map((r) => ({
        value: r[0],
        label: hasDisplayColumn ? String(r[1] ?? '') : String(r[0] ?? ''),
      })),
      truncated,
    };
  }

  /** 测试连接：返回耗时 + 服务端版本（§6.1.1 要求展示原始错误） */
  static async testConnection(
    cred: MySqlCredentials & { tunnel?: TunnelHandle | null },
    deps: DriverDeps = {},
  ): Promise<{ ok: true; elapsedMs: number; serverVersion: string } | { ok: false; elapsedMs: number; error: DriverError }> {
    const started = deps.now ? deps.now() : Date.now();
    const d = new MySqlDriver(cred, { tunnel: cred.tunnel ?? null }, deps);
    try {
      const r = await d.connect();
      return { ok: true, elapsedMs: r.elapsedMs, serverVersion: r.serverVersion };
    } catch (e) {
      const elapsedMs = (deps.now ? deps.now() : Date.now()) - started;
      return { ok: false, elapsedMs, error: normalizeError(e) };
    } finally {
      await d.close().catch(() => undefined);
    }
  }
}

// ---------- 网格打开用的 SQL 构造（PRD §6.3.1 加载策略） ----------

export interface OpenTableSqlOptions {
  database: string;
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
  where?: string | null;
  /** 与 where 中 `?` 一一对应的参数（值为空数组时 where 不该带 `?`） */
  whereParams?: unknown[];
}

/**
 * 构造网格打开语句。
 * 标识符转义，LIMIT/OFFSET 走参数绑定（不能用 ? 的方言限制下用整数强转）。
 *
 * 🔴 **参数顺序是 `[...whereParams, ...limitParams]`** —— 这个顺序与 SQL 文本里
 *    `?` 的出现顺序（WHERE 在 LIMIT 之前）严格对应。反了不会报错在出错的地方：
 *    用户会看到 `syntax error near ''30''`（值被喂给了 LIMIT），
 *    而真正的 bug 在几百行外的调用方。
 */
export function buildOpenTableSql(o: OpenTableSqlOptions): { sql: string; params: unknown[] } {  const qualified = `${quoteIdentifier(o.database)}.${quoteIdentifier(o.table)}`;
  const where = o.where && o.where.trim() ? ` WHERE ${o.where}` : '';
  const params: unknown[] = [...(o.whereParams ?? [])];

  let order = '';
  if (o.orderBy && o.orderBy.length > 0) {
    order =
      ' ORDER BY ' +
      o.orderBy
        .map((s) => {
          const dir = s.direction === 'DESC' ? 'DESC' : 'ASC';
          return `${quoteIdentifier(s.column)} ${dir}`;
        })
        .join(', ');
  }

  let limitClause = '';
  if (typeof o.limit === 'number' && Number.isFinite(o.limit)) {
    limitClause += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(o.limit)));
    if (typeof o.offset === 'number' && Number.isFinite(o.offset) && o.offset > 0) {
      limitClause += ' OFFSET ?';
      params.push(Math.floor(o.offset));
    }
  }

  return { sql: `SELECT * FROM ${qualified}${where}${order}${limitClause}`, params };
}

// ---------- V9：外键候选值查询（纯函数构造，可离线单测） ----------

/** V9 候选值的单次上限（下拉不是数据浏览器，够选就行） */
export const REFERENCED_VALUE_LIMIT_MAX = 500;
/** V9 候选值默认条数 */
export const REFERENCED_VALUE_LIMIT_DEFAULT = 200;

export interface ReferencedValueQuery {
  database: string;
  table: string;
  /** 引用列（= 候选值的 value） */
  valueColumn: string;
  /** 展示列（= 候选值的 label）；缺省或与 valueColumn 相同 → 只查一列 */
  displayColumn?: string | null;
  keyword?: string | null;
  limit?: number;
}

export interface ReferencedValueLookup {
  items: { value: unknown; label: string }[];
  /** 命中数超过 limit（UI 应提示"仅显示前 N 条，请继续输入过滤"） */
  truncated: boolean;
}

/**
 * LIKE 关键字转义：`%` `_` `\` 三个元字符加反斜杠。
 *
 * 不转义的后果不是安全问题（值仍走 ? 参数绑定），而是**结果失控**：
 * 用户搜 `100%` 会匹配到所有以 `100` 开头的行，看起来像 bug。
 */
export function escapeLikeKeyword(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 构造外键候选值查询。
 *
 * 🔴 三条硬约束（与 getTableInfo「绝不做 COUNT(*)」同源）：
 *  1. **必须带 LIMIT** —— 引用表可能百万行，全量拉回来就毁掉「最快查看器」；
 *  2. 值走 `?` 参数绑定，标识符走 `quoteIdentifier`（红线 5：禁止手拼反引号）；
 *  3. 只取「值列 + 展示列」，不 SELECT *。
 *
 * 返回的 limit 是**钳制后**的值，且 SQL 里多取 1 行用于判断截断 ——
 * 调用方（lookupReferencedValues）靠 `rows.length > limit` 判断，不必再算一次。
 */
export function buildReferencedValuesSql(o: ReferencedValueQuery): {
  sql: string;
  params: unknown[];
  limit: number;
  hasDisplayColumn: boolean;
} {
  const limit = Math.max(1, Math.min(REFERENCED_VALUE_LIMIT_MAX, Math.floor(o.limit ?? REFERENCED_VALUE_LIMIT_DEFAULT)));
  const valueCol = quoteIdentifier(o.valueColumn);
  const hasDisplayColumn = !!o.displayColumn && o.displayColumn !== o.valueColumn;
  const displayCol = hasDisplayColumn ? quoteIdentifier(o.displayColumn!) : null;
  const qualified = `${quoteIdentifier(o.database)}.${quoteIdentifier(o.table)}`;
  const select = displayCol ? `${valueCol}, ${displayCol}` : valueCol;

  const params: unknown[] = [];
  let where = '';
  const kw = o.keyword?.trim();
  if (kw) {
    // 对展示列（没有则对值列）做包含匹配；ESCAPE 显式声明，配合 escapeLikeKeyword
    const target = displayCol ?? valueCol;
    where = ` WHERE ${target} LIKE ? ESCAPE '\\\\'`;
    params.push(`%${escapeLikeKeyword(kw)}%`);
  }
  params.push(limit + 1);

  return {
    sql: `SELECT ${select} FROM ${qualified}${where} ORDER BY ${valueCol} LIMIT ?`,
    params,
    limit,
    hasDisplayColumn,
  };
}
