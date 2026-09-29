/**
 * 活动会话注册表 —— 主进程唯一的"活连接"持有者。
 *
 * 职责边界：
 *  - 持有 MySqlDriver 实例（驱动是重资源，必须集中管理，不能每个查询建一次）
 *  - 持有 ConnectionRuntime 状态机（连接中/忙碌/断线重连）
 *  - 持有该连接的 schema 快照（磁盘缓存 + 内存）
 *  - 执行查询并把结果编码成列式载荷
 *  - 执行写操作（mutation），**必须**经过只读守卫
 *
 * 刻意做成可注入驱动的形态（`DriverFactory`），这样单测能用替身驱动跑通
 * 整条链路，不必起真实 MySQL 或 Electron。真库验证交给 scripts/e2e-*.mjs。
 *
 * 关键约束（来自实测与评审，改之前先看清楚）：
 *  - 🔴 只读拦截【只有 AST 白名单算数】。UI 置灰能被快捷键/粘贴绕过。
 *     这里的 `checkReadOnly()` 是唯一安全层，UI 那层只是提示。
 *  - 🔴 排序必须在服务端执行（R10 副作用：BIGINT 也返回字符串，客户端排不准）。
 *  - 🔴 取消走「管理连接 KILL QUERY <id>」，且被 KILL 的查询是 **resolve 不是 reject**
 *     （mysql2 行为），判定取消成功要看「提前返回」，不能看「抛异常」。
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  MySqlDriver,
  buildOpenTableSql,
  DriverError,
  type MySqlSslOptions,
  type QueryResult,
  type TunnelHandle,
  type TableInfo,
  type ForeignKeyMeta,
  type ReferencedValueQuery,
  type ReferencedValueLookup,
} from '@dbstudio/core-driver-mysql';
import { ConnectionRuntime, systemClock, type Clock, type ConnectionState } from '@dbstudio/core-connection';
import { SchemaCache, type DatabaseMeta, type TableMeta, type ObjectKind } from '@dbstudio/core-schema-cache';
import { checkReadOnly, checkMutationStatement, extractSingleTable } from '@dbstudio/core-sql-guard';
import { encodeColumnar, type ColumnarPayload } from '@dbstudio/core-ipc-codec';
import type { ConnectionConfig, SslConfig } from '@dbstudio/core-connection';
import type { SqlStatement } from '@dbstudio/core-mutation';
import type { ForeignKeyDto, ReferencedValuesDto } from '../shared/ipc-channels.js';

/** 网格默认加载行数（PRD §6.3.1） */
export const DEFAULT_PAGE_SIZE = 3000;

/** 当前正在跑的查询句柄 */
export interface RunningQuery {
  queryId: string;
  connectionId: string;
  sql: string;
  startedAt: number;
  cancel(): Promise<boolean>;
  /** 是否被取消（判定成功与否要看这个，不是看有没有抛异常） */
  cancelled: boolean;
}

export interface OpenTableOptions {
  database: string;
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
  where?: string | null;
  /** 与 where 中 `?` 一一对应；顺序必须在 LIMIT 参数之前 */
  whereParams?: unknown[];
}

export interface QueryOutcome {
  payload: ColumnarPayload;
  elapsedMs: number;
  rowCount: number;
  /** 是否因取消而提前返回（mysql2 被 KILL 是 resolve，不是 reject） */
  cancelled: boolean;
  /** 是否命中截断（行数 == limit，可能还有更多） */
  truncated: boolean;
  /** 取消句柄 id */
  queryId: string;
  /**
   * A12 查询结果写回：单表 SELECT 检测（core-sql-guard extractSingleTable）。
   * 检测通过时渲染层提供「打开可编辑表格」入口；null = 保持只读。
   */
  source?: { database: string | null; table: string } | null;
}

/**
 * 驱动工厂 —— 生产用真 MySqlDriver，测试用替身。
 *
 * ⚠️ 这个接口必须覆盖 registry 用到的【全部】驱动能力。
 * 之前漏了 introspect，只能在 introspect() 里 `as unknown as MySqlDriver`
 * 强转绕过类型检查 —— 结果是替身驱动一跑就炸，而编译器毫无察觉。
 */
export interface DriverLike {
  connect(): Promise<{ serverVersion: string; elapsedMs: number }>;
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  /** 元数据 introspect。传 undefined = 自动选库 */
  introspect(schemas?: string[]): Promise<DatabaseMeta[]>;
  /** 对象定义原文（C2）：SHOW CREATE，六类对象各自的 DDL 列名由驱动层适配 */
  showCreateObject(database: string, name: string, kind: ObjectKind): Promise<string>;
  /** 表信息（C9/A14）：information_schema.TABLES 单行；null = 表不存在 */
  getTableInfo(database: string, table: string): Promise<TableInfo | null>;
  /** V9：外键列表（KEY_COLUMN_USAGE，复合外键按约束名分组、按 ORDINAL_POSITION 排序） */
  listForeignKeys(database: string, table: string): Promise<ForeignKeyMeta[]>;
  /** V9：外键候选值（服务端 LIMIT，驱动层钳制，绝不全表扫描） */
  lookupReferencedValues(o: ReferencedValueQuery): Promise<ReferencedValueLookup>;
  cancel(): Promise<boolean>;
  close(): Promise<void>;
  readonly connectionId: number | null;
  readonly serverVersion: string | null;
}

/**
 * 建驱动时的上下文 —— SSH 隧道走这里。
 *
 * `streamFactory` 每调用一次要产出一条【新的】底层通道：
 * 主连接与 KILL QUERY 的管理连接各占一条，共用会串包。
 */
export interface DriverContext {
  tunnel: TunnelHandle | null;
  streamFactory: (() => Promise<unknown>) | null;
}

/**
 * 允许同步返回（替身）或异步返回（需要先建 SSH 隧道）。
 * 调用方一律 `await`，两种实现都能吃。
 */
export type DriverFactory = (
  cfg: ConnectionConfig,
  password: string | null,
  ctx?: DriverContext,
) => Promise<DriverLike> | DriverLike;

/**
 * 读取 SSL 证书文件内容（PEM 文本），组装成驱动吃的 MySqlSslOptions。
 *
 * 🔴 读取失败必须抛，不能悄悄降级 —— 路径配了但读不出来时若静默跳过，
 *    连接会降级成"无 CA 校验的 TLS"（甚至无 TLS），中间人攻击对用户不可见。
 *    这里是 fail-closed：文件坏了就连不上，让用户看到真实原因。
 *    （保存时校验层已挡住"enabled 但文件不存在"，这里防的是文件在保存后被
 *    删除/移动的情况。）
 *
 * 路径本来就是 null 的项直接跳过 —— 那是"没配置"，不是"配置了读不到"。
 */
async function readSslMaterial(ssl: SslConfig | null | undefined): Promise<MySqlSslOptions | null> {
  if (!ssl?.enabled) return null;
  const out: MySqlSslOptions = { rejectUnauthorized: ssl.rejectUnauthorized };
  const files = [
    ['ca', ssl.caPath],
    ['cert', ssl.certPath],
    ['key', ssl.keyPath],
  ] as const;
  for (const [field, path] of files) {
    if (!path) continue;
    try {
      out[field] = await readFile(path, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SessionError('SSL_READ_FAILED', `SSL 证书文件读取失败（${field}）: ${path} — ${msg}`);
    }
  }
  return out;
}

/** 生产工厂：真驱动 + 会话级守卫参数（隧道可选）。async：SSL 证书要先读成内容 */
export const realDriverFactory: DriverFactory = async (cfg, password, ctx) => {
  const ssl = await readSslMaterial(cfg.ssl);
  return new MySqlDriver(
    {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.defaultDatabase,
      streamFactory: ctx?.streamFactory ?? null,
      ssl,
    },
    {
      readOnly: cfg.readOnly,
      // 兜底：服务端侧超时。取消仍然主要靠 KILL QUERY（MySQL 无带内取消）
      maxExecutionTimeMs: 0,
      // 隧道挂在驱动上 → driver.close() 时一并释放（PRD §6.1.2 无孤儿进程）
      tunnel: ctx?.tunnel ?? null,
    },
  ) as unknown as DriverLike;
};

/**
 * 隧道管理器 —— 由主进程注入，registry 不认识 ssh2。
 *
 * 依赖方向刻意这么做：registry 只关心"拿一条能通的字节流"，
 * SSH 私钥读取、passphrase 解密这些事都由实现方负责。
 * 于是单测里塞一个假管理器就能跑通带隧道的全链路。
 */
export interface TunnelManager {
  /**
   * 为本次连接开一条隧道。
   * @returns null 表示该连接不需要隧道（直连）
   */
  open(
    cfg: ConnectionConfig,
    target: { host: string; port: number },
  ): Promise<{ tunnel: TunnelHandle; streamFactory: () => Promise<unknown> } | null>;
}

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** 一条连接的全部运行时状态 */
interface Session {
  cfg: ConnectionConfig;
  runtime: ConnectionRuntime;
  driver: DriverLike | null;
  /**
   * SSH 隧道句柄。
   *
   * 评审 §4.6：隧道与 DB 连接必须**成对管理**。这里存一份是为了兜底 ——
   * 正常释放走 driver.close()（隧道挂在驱动上），但驱动建连失败时
   * 驱动自己不持有隧道，必须由 registry 关掉，否则就是孤儿进程。
   */
  tunnel: TunnelHandle | null;
  /** 内存中的 schema 快照（连接期间复用，避免每次展开树都查 information_schema） */
  schema: DatabaseMeta[] | null;
  /** 快照落到磁盘的时间（用于 UI 提示"可能过期"） */
  schemaCapturedAt: number | null;
  /**
   * 会话当前 USE 的库。null = 未选库（连接时没配默认库）。
   *
   * 2026-09-26 真机缺陷修复：查询标签带着所属库传到主进程，但 QUERY_RUN
   * 把它丢了 —— 未设默认库的连接上，编辑器里不带库前缀的表名全部
   * "No database selected"。现在 runQuery 在库变化时补一条 USE，
   * 并跟踪用户手写的 USE，避免缓存把后续查询送错库。
   */
  currentDb: string | null;
  /** connect() 在飞标记：自动重连看到它要让路（手动操作优先） */
  connecting: boolean;
  /** 自动重连在飞标记：防重入（计时器到点与手动操作撞车时只跑一个） */
  reconnectBusy: boolean;
  /**
   * 会话代数：connect() 进入时与 disconnect() 时各 +1。
   * 建连在飞期间代数变了 = 会话归属已变（被断开/被更新的建连取代），
   * 在途结果必须丢弃并释放刚建的资源 —— 否则用户断开后连接会"复活"成 connected。
   */
  gen: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly running = new Map<string, RunningQuery>();
  /** D1 状态推送回调。null = 无人订阅 */
  private onStateChangeCb:
    | ((connId: string, state: ConnectionState, lastError: string | null) => void)
    | null = null;

  constructor(
    private readonly cache: SchemaCache,
    private readonly makeDriver: DriverFactory = realDriverFactory,
    /** SSH 隧道管理器。不传 = 全部直连（单测与不支持隧道的场景） */
    private readonly tunnels: TunnelManager | null = null,
    /**
     * 自动重连取密码用（D1 / PRD §6.1.4）：主进程注入 ConnectionStore.passwordFor。
     * registry 绝不留存明文 —— 每次重连现取现用。不注入时自动重连会因无凭据失败，
     * 额度耗尽进入 failed，等用户手动重试（走正常 connConnect 流程拿密码）。
     * 可后续用 setPasswordProvider 覆盖（接线不必关心构造顺序）。
     */
    private passwordProvider: ((connId: string) => Promise<string | null>) | null = null,
  ) {}

  // ---------- D1：连接状态变化推送 ----------

  /**
   * 订阅连接状态变化，传 null 退订。主进程把它接到 `event:connState` 推送上。
   *
   * 🔴 【每一次】状态迁移都触发：连接成功/失败、查询运行中（busy↔connected）、
   *    断线检测到（含查询中断线）、自动重连、手动断开。
   *    payload 必须带 lastError（失败时非空、成功时 null）——
   *    渲染层断线横幅靠它区分"事故推送"与"例行通知"。
   */
  setOnStateChange(
    cb: ((connId: string, state: ConnectionState, lastError: string | null) => void) | null,
  ): void {
    this.onStateChangeCb = cb;
  }

  /**
   * 注入自动重连用的凭据来源（主进程接 ConnectionStore.passwordFor）。
   * 与构造函数第 4 参等价 —— 提供 setter 是为了让 main.ts 的接线不必关心
   * registry 与 connection-store 的构造顺序。
   */
  setPasswordProvider(provider: ((connId: string) => Promise<string | null>) | null): void {
    this.passwordProvider = provider;
  }

  /** 推送某连接的当前状态。回调异常绝不影响会话本身（推送是旁路，不是链路） */
  private emitState(connId: string): void {
    const cb = this.onStateChangeCb;
    const s = this.sessions.get(connId);
    if (!cb || !s) return;
    try {
      cb(connId, s.runtime.state, s.runtime.lastError);
    } catch {
      // 订阅方的问题不能炸主进程
    }
  }

  /**
   * 带【观测】的时钟：runtime 内部定时器（自动重连 / 空闲超时）到点引发的迁移
   * 外部本来观测不到 —— 包一层，迁移后补推送；若这是"重连计时器到点"
   * （disconnected → connecting），真正的建连由 registry 接手执行（PRD §6.1.4）。
   *
   * 🔴 空闲超时（connected → closed）必须**真的释放驱动与隧道**（2026-09-29 修复）。
   *    runtime 的 idle 定时器只推状态机，不碰资源 —— 于是要么留着一条空闲 socket
   *    白占服务端连接数，要么（更糟）用户下一次操作触发重连时，connect() 直接
   *    新建隧道 + 新建驱动，旧的成了**孤儿**（违反 AGENTS.md §四.7 隧道孤儿红线，
   *    SSH 场景下就是留一个 ssh 子进程在机器上）。
   *    在这里释放是唯一的收口点：idle 迁移只可能由这个定时器引发。
   */
  private observedClock(connId: string): Clock {
    return {
      now: systemClock.now,
      setTimeout: (fn, ms) =>
        systemClock.setTimeout(() => {
          const before = this.sessions.get(connId)?.runtime.state ?? null;
          fn();
          const s = this.sessions.get(connId);
          if (!s || s.runtime.state === before) return;
          // 空闲超时：释放资源（异步，失败只记日志 —— 状态迁移已经完成，不能回滚）
          if (before === 'connected' && s.runtime.state === 'closed') {
            void this.releaseIdleSession(connId);
          }
          this.emitState(connId);
          if (before === 'disconnected' && s.runtime.state === 'connecting') {
            void this.autoReconnect(connId);
          }
        }, ms),
      clearTimeout: systemClock.clearTimeout,
    };
  }

  /**
   * 空闲超时后的资源释放。与 disconnect() 的区别：**不碰状态机**
   * （状态已经是 closed，再调 runtime.disconnect() 会多推一次无意义的迁移）。
   *
   * 释放顺序照抄 disconnect()：先取消在跑查询 → 关驱动（隧道挂在驱动上一并释放）
   * → 兜底再关一次隧道 → 清引用与 schema 缓存引用。
   * 任何一步失败都只记日志：此时会话已经是 closed，用户下一次操作会重新握手，
   * 失败不该冒泡到定时器回调里（那会变成未处理的 Promise 拒绝）。
   */
  private async releaseIdleSession(connId: string): Promise<void> {
    const s = this.sessions.get(connId);
    if (!s) return;
    // 作废在途建连/自动重连的结果（与 disconnect 同口径）
    s.gen++;
    try {
      await this.cancelAll(connId);
      await s.driver?.close();
    } catch {
      // 空闲断开时驱动可能早已被服务端踢掉，close 失败是常态而非异常
    }
    try {
      await this.closeTunnel(s.tunnel);
    } catch {
      // 隧道关不掉不掩盖主流程（closeTunnel 内部已吞错，这里只是双保险）
    }
    s.driver = null;
    s.tunnel = null;
    // schema 保留：树仍要基于它渲染，下次 getSchema 会优先内存命中；
    // 真要回源刷新时（force）会走 introspect —— 那时会话已重新连上。
  }

  /**
   * 自动重连的一轮尝试（PRD §6.1.4：最多 3 次，间隔 1s/2s/4s）。
   *
   * 由"重连计时器到点"触发（observedClock）。复用 connect() 的完整建连链路
   * （隧道 → 驱动工厂 → 握手），密码经 passwordProvider 现取现用。
   * 失败时 connect() 内部已推进到 failed，这里再调 onNetworkBreak 排下一轮；
   * 额度耗尽停在 failed，等手动重试（手动重试走正常 connConnect 流程）。
   */
  private async autoReconnect(connId: string): Promise<void> {
    const s = this.sessions.get(connId);
    if (!s || s.reconnectBusy || s.connecting || s.runtime.state !== 'connecting') return;
    s.reconnectBusy = true;
    try {
      const password = this.passwordProvider ? await this.passwordProvider(connId) : null;
      await this.connect(s.cfg, password);
      // 新驱动 = 会话的 USE 上下文清零，回到连接配置的默认库
      const st = this.sessions.get(connId);
      if (st) st.currentDb = st.cfg.defaultDatabase || null;
    } catch (e) {
      const st = this.sessions.get(connId);
      const msg = e instanceof Error ? e.message : String(e);
      if (!st) return;
      if (st.runtime.state === 'connecting') {
        // 密码获取失败等 connect() 之前的异常：先把状态机推进到 failed
        st.runtime.onConnectFailed(`自动重连失败：${msg}`);
        this.emitState(st.cfg.id);
      }
      if (st.runtime.state === 'failed') {
        // 还有额度 → onNetworkBreak 排下一轮计时器（到点重新进入本方法）；
        // 额度耗尽 → 不迁移，停在 failed 等手动重试（走正常 connConnect 流程）
        const before = st.runtime.state;
        st.runtime.onNetworkBreak(msg);
        if (st.runtime.state !== before) this.emitState(st.cfg.id);
      }
      // 其他状态（idle/closed：期间被断开）不动 —— 不复活会话
    } finally {
      s.reconnectBusy = false;
    }
  }

  /** beginQuery + 推送（busy 迁移也是一次状态变化） */
  private beginQueryTracked(s: Session): boolean {
    const ok = s.runtime.beginQuery();
    if (ok) this.emitState(s.cfg.id);
    return ok;
  }

  /** endQuery + 推送（只有真的从 busy 回到 connected 才推） */
  private endQueryTracked(s: Session): void {
    const before = s.runtime.state;
    s.runtime.endQuery();
    if (s.runtime.state !== before) this.emitState(s.cfg.id);
  }

  /**
   * 查询路径上的驱动报错归类：连接级错误 → 推进断线状态机。
   * 🔴 "查询中连接断开"必须走这里 —— 否则 endQuery 会把死连接标回 connected，
   *    UI 显示正常但每条查询都在报错，用户只能靠反复断开重连自救。
   */
  private noteDriverFailure(s: Session, e: unknown): void {
    if (!isConnectionLostError(e)) return;
    const msg = e instanceof Error ? e.message : String(e);
    s.runtime.onNetworkBreak(msg);
    this.emitState(s.cfg.id);
  }

  /**
   * 造一个"用完即弃"的驱动，用于测试连接。
   * 不进注册表 —— 测试连接不该占用会话槽位，也不该写 schema 缓存。
   *
   * ⚠️ 测试连接**也要走隧道**：否则"测试连接"通过、真正连接失败，
   *    用户会以为是应用的问题，实际是隧道配置没被验证到。
   */
  async makeTestDriver(cfg: ConnectionConfig, password: string | null): Promise<DriverLike> {
    const ctx = await this.openTunnel(cfg);
    // 工厂自身也可能失败（如 SSL 证书文件读取失败）：此时驱动还没被造出来、
    // 不持有隧道，必须在这里关掉，否则测试一次就漏一条孤儿隧道
    try {
      return await this.makeDriver(cfg, password, ctx);
    } catch (e) {
      await this.closeTunnel(ctx.tunnel);
      throw e;
    }
  }

  /**
   * 按需开隧道。不需要隧道（直连）返回 null 上下文。
   *
   * ⚠️ 失败必须抛：隧道建不起来就连不上，静默降级成直连会让用户
   *    连到一个完全不对的目标（PRD §6.1.2 跳板机语义）。
   */
  private async openTunnel(cfg: ConnectionConfig): Promise<DriverContext> {
    if (!this.tunnels || !cfg.ssh?.enabled) {
      return { tunnel: null, streamFactory: null };
    }
    const opened = await this.tunnels.open(cfg, { host: cfg.host, port: cfg.port });
    if (!opened) return { tunnel: null, streamFactory: null };
    return { tunnel: opened.tunnel, streamFactory: opened.streamFactory };
  }

  /** 单独关隧道（驱动建连失败时的兜底路径） */
  private async closeTunnel(t: TunnelHandle | null): Promise<void> {
    if (!t) return;
    try {
      await t.close();
    } catch {
      // 隧道关不掉不该掩盖真正的连接错误，也不该挡住状态推进
    }
  }

  // ---------- 连接生命周期 ----------

  stateOf(connId: string): ConnectionState {
    return this.sessions.get(connId)?.runtime.state ?? 'idle';
  }

  lastError(connId: string): string | null {
    return this.sessions.get(connId)?.runtime.lastError ?? null;
  }

  /** 建立连接。密码由调用方（ConnectionStore）解密后传入，不在这里碰密钥环 */
  async connect(cfg: ConnectionConfig, password: string | null): Promise<{ serverVersion: string; elapsedMs: number }> {
    let s = this.sessions.get(cfg.id);
    if (!s) {
      s = {
        cfg,
        // 时钟带观测：runtime 内部定时器（自动重连/空闲超时）引发的迁移要补推送
        runtime: new ConnectionRuntime(cfg.id, this.observedClock(cfg.id), cfg.idleTimeoutMs),
        driver: null,
        tunnel: null,
        schema: null,
        schemaCapturedAt: null,
        // 驱动建连时 mysql2 会直接连到 defaultDatabase（有配的话），初始库以它为准
        currentDb: cfg.defaultDatabase || null,
        connecting: false,
        reconnectBusy: false,
        gen: 0,
      };
      this.sessions.set(cfg.id, s);
    }
    s.cfg = cfg;
    // 代数 +1：本轮建连在飞期间，disconnect() 或另一次 connect() 会再次 +1，
    // 在途结果据此作废（防止断开后连接"复活"）
    const genAtStart = ++s.gen;
    s.connecting = true;

    try {
      const began = s.runtime.connect();
      if (began) {
        // runtime.connect() 真正引发迁移（idle/failed/closed → connecting）时推送。
        // 自动重连计时器到点的 connecting 迁移由 observedClock 补推，走不到这里
        this.emitState(cfg.id);
      } else if (s.runtime.state !== 'connecting') {
        // 已连接或正在连接 —— 不重复建连（驱动是重资源）
        if (s.runtime.isLive()) {
          return { serverVersion: s.driver?.serverVersion ?? '', elapsedMs: 0 };
        }
      }

      // 隧道先于驱动建：SSH 通了才值得去连数据库，
      // 否则用户会先看到"数据库认证失败"，而真正的原因是跳板机不通。
      let ctx: DriverContext;
      try {
        ctx = await this.openTunnel(cfg);
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        await this.closeTunnel(s.tunnel);
        s.tunnel = null;
        s.runtime.onConnectFailed(msg);
        this.emitState(cfg.id);
        throw new SessionError('SSH_FAILED', msg);
      }
      s.tunnel = ctx.tunnel;

      // 工厂自身也可能失败（SSL 证书文件读取失败等）。不接住的话：隧道变孤儿、
      // 状态卡死在 connecting（retry 会被状态机拒绝），连接永远救不回来。
      let driver: DriverLike;
      try {
        driver = await this.makeDriver(cfg, password, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.closeTunnel(s.tunnel);
        s.tunnel = null;
        s.runtime.onConnectFailed(msg);
        this.emitState(cfg.id);
        throw e instanceof SessionError ? e : new SessionError('CONNECT_FAILED', msg);
      }
      try {
        const info = await driver.connect();
        if (s.gen !== genAtStart) {
          // 建连期间会话被断开/被更新的建连取代：丢弃结果并释放刚建的资源（孤儿红线）
          try {
            await driver.close();
          } catch {
            /* 释放失败不影响归属判定 */
          }
          await this.closeTunnel(s.tunnel);
          s.tunnel = null;
          throw new SessionError('CONNECT_ABORTED', '建连已被取消（会话已断开或重新连接）');
        }
        s.driver = driver;
        s.runtime.onConnected();
        this.emitState(cfg.id);
        return info;
      } catch (e) {
        // 归属已变的失败不再推进状态机（状态归新的持有者管）
        if (e instanceof SessionError && e.code === 'CONNECT_ABORTED') throw e;
        const msg = e instanceof DriverError ? e.message : String(e instanceof Error ? e.message : e);
        s.runtime.onConnectFailed(msg);
        this.emitState(cfg.id);
        try {
          await driver.close();
        } catch {
          // 关闭失败无所谓：连接本来就没建起来
        }
        // 兜底：驱动建连失败时它自己不持有隧道（构造参数传进去了，但
        // connect 失败不会触发 driver 内部的释放路径），这里必须关掉。
        await this.closeTunnel(s.tunnel);
        s.tunnel = null;
        throw new SessionError('CONNECT_FAILED', msg);
      }
    } finally {
      s.connecting = false;
    }
  }

  async disconnect(connId: string): Promise<void> {
    const s = this.sessions.get(connId);
    if (!s) return;
    // 作废在途建连/自动重连的结果（它们会自检代数并释放刚建的资源）
    s.gen++;
    // 先取消该连接上正在跑的查询，否则 close 会挂住
    await this.cancelAll(connId);
    try {
      // 隧道挂在驱动上，driver.close() 会一并释放它
      await s.driver?.close();
    } catch {
      // 断线场景下 close 本就可能失败，状态仍要推进到 closed
    }
    // 再兜一次：驱动没建起来（或 close 抛错）时隧道可能还活着
    await this.closeTunnel(s.tunnel);
    s.driver = null;
    s.tunnel = null;
    s.schema = null;
    const before = s.runtime.state;
    s.runtime.disconnect();
    // 手动断开也要推送（closed→idle 同步两跳，推最终态；lastError 保持原样，
    // 渲染层按 state 判定，idle 不在横幅的事故态集合里）
    if (s.runtime.state !== before) this.emitState(connId);
  }

  isLive(connId: string): boolean {
    const s = this.sessions.get(connId);
    return !!s && s.runtime.isLive();
  }

  // ---------- Schema ----------

  /**
   * 取 schema。优先内存 → 磁盘快照 → 真库 introspect。
   *
   * 树首屏要走磁盘快照（PRD §6.2.1：先出结构再刷新），
   * 但 `force` 时强制回源，用于"刷新"按钮。
   */
  async getSchema(connId: string, opts: { force?: boolean } = {}): Promise<DatabaseMeta[]> {
    const s = this.sessions.get(connId);
    if (!s) throw new SessionError('NOT_CONNECTED', '连接未建立');

    if (!opts.force && s.schema) return s.schema;

    const cached = this.cache.load(connId);
    if (!opts.force && cached.snapshot) {
      s.schema = cached.snapshot.databases;
      s.schemaCapturedAt = cached.snapshot.capturedAt;
      return s.schema;
    }

    if (!s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    const dbs = await this.introspect(s);
    s.schema = dbs;
    s.schemaCapturedAt = Date.now();
    this.cache.save(connId, dbs);
    return dbs;
  }

  private async introspect(s: Session): Promise<DatabaseMeta[]> {
    if (!s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (s.runtime.state !== 'connected' && s.runtime.state !== 'busy') {
      throw new SessionError('NOT_CONNECTED', `当前状态 ${s.runtime.state}，无法读取元数据`);
    }
    // 与既有行为一致：busy 中的嵌套 introspect 不算 BUSY 错误（驱动层会串行化），
    // 但迁移（connected→busy）发生时照常推送
    this.beginQueryTracked(s);
    try {
      const targets = s.cfg.defaultDatabase ? [s.cfg.defaultDatabase] : undefined;
      return await s.driver.introspect(targets);
    } catch (e) {
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  /**
   * 读磁盘快照（不触发 introspect）。
   * 树首屏靠它立刻出结构 —— 用户不该为了看树等一轮 information_schema 查询。
   */
  snapshotInfo(connId: string): { databases: DatabaseMeta[]; stale: boolean; capturedAt: number } | null {
    const st = this.cache.load(connId);
    if (!st.snapshot) return null;
    return {
      databases: st.snapshot.databases,
      stale: st.stale,
      capturedAt: st.snapshot.capturedAt,
    };
  }

  /** 连接的 schema 是否已从真库拉取过（区分"磁盘快照"与"本次会话真实数据"） */
  isSchemaLive(connId: string): boolean {
    return this.sessions.get(connId)?.schema != null;
  }

  /** 取表元数据。网格要靠它判定可编辑性（B5 红线） */
  async getTable(connId: string, database: string, table: string): Promise<TableMeta | null> {
    const dbs = await this.getSchema(connId);
    const db = dbs.find((d) => d.name === database);
    if (!db) return null;
    return db.tables.find((t) => t.name === table) ?? null;
  }

  // ---------- 对象元数据（C2 定义查看 / C9+A14 表信息） ----------

  /**
   * 查看对象定义（SHOW CREATE 原文，C2）。
   * 会话不活 → NOT_CONNECTED（跟随既有错误风格）；
   * 对象不存在/无权限 → NOT_FOUND，message 带服务端原文（不翻译、不吞）。
   */
  async getObjectDdl(
    connId: string,
    req: { database: string; name: string; kind: ObjectKind },
  ): Promise<{ kind: ObjectKind; name: string; database: string; ddl: string }> {
    const s = this.sessions.get(connId);
    if (!s || !s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法读取对象定义`);
    }
    try {
      const ddl = await s.driver.showCreateObject(req.database, req.name, req.kind);
      return { kind: req.kind, name: req.name, database: req.database, ddl };
    } catch (e) {
      this.noteDriverFailure(s, e);
      if (isMissingObjectError(e)) {
        const original = e instanceof Error ? e.message : String(e);
        throw new SessionError('NOT_FOUND', `对象 ${req.database}.${req.name} 不存在或无权查看：${original}`);
      }
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  /**
   * 表信息（C9 表信息面板 / A14 估算行数）：information_schema.TABLES 单行。
   *
   * 🔴 行数是 TABLE_ROWS 估算值，绝不做 SELECT COUNT(*)（驱动层同款红线，
   *    千万行表上一次精确 COUNT 就毁掉「最快查看器」的验收门槛）。
   * 表不存在 → NOT_FOUND。
   */
  async getTableInfo(connId: string, req: { database: string; table: string }): Promise<TableInfo> {
    const s = this.sessions.get(connId);
    if (!s || !s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法读取表信息`);
    }
    try {
      const info = await s.driver.getTableInfo(req.database, req.table);
      if (!info) {
        throw new SessionError('NOT_FOUND', `表 ${req.database}.${req.table} 不存在`);
      }
      return info;
    } catch (e) {
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  // ---------- V9：外键导航与候选值 ----------

  /**
   * 外键列表（按需单表查，不进 introspect）。
   *
   * 🔴 降级语义：表不存在 / 无权读 information_schema → **返回空数组**而不是抛错。
   *    理由：外键信息只是「少一个跳转链接」，不该让用户打不开表；
   *    而连接本身没建立（NOT_CONNECTED）仍然抛 —— 那是真故障，藏起来才是坑。
   */
  async getForeignKeys(connId: string, database: string, table: string): Promise<ForeignKeyDto[]> {
    const s = this.sessions.get(connId);
    if (!s || !s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法读取外键`);
    }
    try {
      const fks = await s.driver.listForeignKeys(database, table);
      return fks.map((fk) => ({
        constraintName: fk.constraintName,
        columns: fk.columns,
        referencedDatabase: fk.referencedDatabase,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }));
    } catch (e) {
      if (isMissingObjectError(e)) return [];
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  /**
   * 外键候选值（下拉数据源）。
   *
   * 🔴 LIMIT 由驱动层 buildReferencedValuesSql 钳制（≤500）——
   *    渲染层传什么都不会变成全表扫描（与 getTableInfo 绝不做 COUNT 同源）。
   * 这里不做「表不存在返回空」的降级：用户已经明确点了下拉，
   * 拿不到候选值必须把原因说出来（V1-V7 的教训：静默失效最伤信任）。
   */
  async lookupReferencedValues(
    connId: string,
    o: {
      database: string;
      table: string;
      valueColumn: string;
      displayColumn?: string | null;
      keyword?: string | null;
      limit?: number;
    },
  ): Promise<ReferencedValuesDto> {
    const s = this.sessions.get(connId);
    if (!s || !s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法读取候选值`);
    }
    try {
      return await s.driver.lookupReferencedValues({
        database: o.database,
        table: o.table,
        valueColumn: o.valueColumn,
        displayColumn: o.displayColumn ?? null,
        keyword: o.keyword ?? null,
        limit: o.limit,
      });
    } catch (e) {
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  // ---------- 查询 ----------

  /**
   * 打开表 —— 网格首屏走这条路径。
   *
   * 排序与过滤都在 SQL 里完成（R10 副作用导致客户端排序不可靠）。
   * 结果编码时传列定义 dataType，把数值列还原成真数值。
   */
  async openTable(connId: string, o: OpenTableOptions): Promise<QueryOutcome> {
    const table = await this.getTable(connId, o.database, o.table);
    const columnTypes = table?.columns.map((c) => c.dataType);
    const built = buildOpenTableSql({
      database: o.database,
      table: o.table,
      limit: o.limit ?? DEFAULT_PAGE_SIZE,
      offset: o.offset ?? 0,
      orderBy: o.orderBy,
      where: o.where ?? null,
      whereParams: o.whereParams ?? [],
    });
    const out = await this.runQuery(connId, built.sql, built.params, { columnTypes });
    // 行数正好等于 limit → 很可能还有更多，UI 应提示截断
    out.truncated = out.rowCount >= (o.limit ?? DEFAULT_PAGE_SIZE);
    return out;
  }

  /**
   * 执行任意 SQL。
   *
   * 只读连接在进入驱动前先过 AST 白名单（fail-closed）。
   * 这是**唯一**的安全层 —— UI 置灰不算数。
   */
  async runQuery(
    connId: string,
    sql: string,
    params: unknown[] = [],
    opts: { columnTypes?: (string | undefined)[]; queryId?: string | null; database?: string | null } = {},
  ): Promise<QueryOutcome> {
    const s = this.sessions.get(connId);
    if (!s) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');

    if (s.cfg.readOnly) {
      const guard = checkReadOnly(sql, 'mysql');
      if (!guard.allowed) {
        throw new SessionError('READ_ONLY', `只读连接：${guard.message}`);
      }
    }

    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法执行查询`);
    }

    // 采用调用方给的 id：渲染层在【发起瞬间】就握有取消句柄，
    // 不必等返回、不必轮询 —— 轮询会遇到"刚好跑完、句柄消失"的竞态
    const queryId = opts.queryId || randomUUID();
    const startedAt = Date.now();
    let cancelled = false;
    const handle: RunningQuery = {
      queryId,
      connectionId: connId,
      sql,
      startedAt,
      cancelled: false,
      cancel: async () => {
        cancelled = true;
        handle.cancelled = true;
        // 🔴 KILL QUERY 走管理连接；被 KILL 的查询是 resolve 不是 reject
        return s.driver!.cancel();
      },
    };
    this.running.set(queryId, handle);

    try {
      // 查询标签声明的库与会话当前库不一致时补一条 USE（同一库不重复发，省一个来回）。
      // beginQuery 已把该连接上的查询串行化，USE + 查询不会与其他语句交错。
      if (opts.database && opts.database !== s.currentDb) {
        await s.driver.query('USE ' + quoteDb(opts.database));
        s.currentDb = opts.database;
      }
      const res = await s.driver.query(sql, params);
      // 用户自己写了 USE xxx：以它为准 —— 否则 currentDb 缓存是陈旧的，
      // 后续带 database 的查询会误判"库没变"而送错库
      const useMatch = /^\s*USE\s+`?([^`;\s]+)`?/i.exec(sql);
      if (useMatch) s.currentDb = useMatch[1];
      const elapsedMs = Date.now() - startedAt;
      // V15：这里刻意传列描述符而不是列名数组 —— 描述符能带上 sourceTable，
      // JOIN 结果的列头才能告诉用户「这一列来自哪张表」。
      // 只传列名的写法会把这个信息静默丢掉（且不会报错，正是最难查的那类）。
      const descriptors = res.fields.map((f) => ({ name: f.name, typeCode: f.type ?? 0, sourceTable: f.sourceTable ?? null }));
      const payload = encodeColumnar(res.rows, descriptors, opts.columnTypes);
      return {
        payload,
        elapsedMs,
        rowCount: res.rows.length,
        cancelled,
        truncated: false,
        queryId,
        // A12：单表 SELECT 检测。解析失败的语句返回 null（fail-closed），
        // 结果集保持只读；这里只做判定，真正写回仍走 mutationApply 全链路
        source: extractSingleTable(sql, 'mysql'),
      };
    } catch (e) {
      // 连接级错误在这里推进断线状态机（查询中断线 ≠ 普通 SQL 错误）
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.running.delete(queryId);
      this.endQueryTracked(s);
    }
  }

  /** 取消查询。找不到句柄不算错误（查询可能刚好跑完） */
  async cancelQuery(queryId: string): Promise<boolean> {
    const h = this.running.get(queryId);
    if (!h) return false;
    return h.cancel();
  }

  async cancelAll(connId: string): Promise<number> {
    let n = 0;
    for (const h of [...this.running.values()]) {
      if (h.connectionId === connId) {
        await h.cancel();
        n++;
      }
    }
    return n;
  }

  listRunning(): { queryId: string; connectionId: string; sql: string; elapsedMs: number }[] {
    const now = Date.now();
    return [...this.running.values()].map((h) => ({
      queryId: h.queryId,
      connectionId: h.connectionId,
      sql: h.sql,
      elapsedMs: now - h.startedAt,
    }));
  }

  // ---------- 写操作 ----------

  /**
   * 应用一个 mutation 计划（保存预演确认后）。
   *
   * 单事务执行：任何一条失败就整体回滚。
   * 只读连接在这里【再拦一次】 —— 纵深防御，不依赖调用方自觉。
   */
  async applyMutation(
    connId: string,
    database: string,
    statements: Pick<SqlStatement, 'sql' | 'params'>[],
  ): Promise<{ affected: number; elapsedMs: number; insertIds: (number | null)[] }> {
    const s = this.sessions.get(connId);
    if (!s) throw new SessionError('NOT_CONNECTED', '连接未建立');
    if (!s.driver) throw new SessionError('NOT_CONNECTED', '连接未建立');

    if (s.cfg.readOnly) {
      throw new SessionError('READ_ONLY', '只读连接不允许写操作');
    }

    if (statements.length === 0) {
      return { affected: 0, elapsedMs: 0, insertIds: [] };
    }

    /**
     * 🔴 V10 的主进程兜底（真防线）：逐条过 AST 结构白名单。
     *
     * 渲染层的 validateSqlExpression 只是即时反馈，能被绕过（改包 / 直接调 IPC）；
     * 只读守卫只服务「只读连接」，正常连接的写链路此前**没有任何 AST 校验** ——
     * 表达式值一旦原样嵌入，就等于把「渲染层拼的 SQL 文本」直接送进数据库。
     *
     * 这里在事务开始【之前】全量校验：任一条不合规 → 整批拒绝、一条都不执行
     * （与保存预演「一轮保存 = 单事务、任一失败整轮回滚」的语义一致）。
     */
    for (const st of statements) {
      const guard = checkMutationStatement(st.sql, 'mysql');
      if (!guard.allowed) {
        // VALIDATION 而不是 READ_ONLY：这不是「连接只读」，是语句结构不合规
        throw new SessionError('VALIDATION', `写语句被安全校验拒绝：${guard.message}`);
      }
    }

    if (!this.beginQueryTracked(s)) {
      throw new SessionError('BUSY', `连接当前状态 ${s.runtime.state}，无法执行写操作`);
    }

    const startedAt = Date.now();
    const insertIds: (number | null)[] = [];
    let affected = 0;

    try {
      await s.driver.query('START TRANSACTION');
      try {
        if (database) {
          await s.driver.query('USE ' + quoteDb(database));
          s.currentDb = database;
        }
        for (const st of statements) {
          const res = await s.driver.query(st.sql, st.params ?? []);
          affected += res.affectedRows ?? 0;
          insertIds.push(res.insertId ?? null);
        }
        await s.driver.query('COMMIT');
      } catch (e) {
        // 回滚失败也要把原始错误抛出去 —— 原始错误才是用户需要看的
        try {
          await s.driver.query('ROLLBACK');
        } catch {
          /* 忽略：优先暴露原始失败原因 */
        }
        throw e;
      }
      return { affected, elapsedMs: Date.now() - startedAt, insertIds };
    } catch (e) {
      // 事务中途断线同样要推进断线状态机（否则死连接顶着 connected 的牌位）
      this.noteDriverFailure(s, e);
      throw e;
    } finally {
      this.endQueryTracked(s);
    }
  }

  // ---------- 释放 ----------

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      try {
        await this.disconnect(id);
      } catch {
        // 退出时要尽力关，但不能因为某条连接卡住而挡住整体退出
      }
    }
  }

  /** 当前活着的隧道数（自检用：退出时应为 0，否则就是孤儿进程） */
  liveTunnelCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.tunnel) n++;
    return n;
  }
}

/** 库名转义。USE 不支持参数绑定，只能内联 —— 所以必须转义 */
export function quoteDb(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

// ---------- 错误归类（断线检测 / NOT_FOUND 判定） ----------

/**
 * 连接级错误码：查询路径上出现即视为断线（"查询中连接断开"也要推进状态机）。
 * 🔴 KILL QUERY 导致的 ER_QUERY_INTERRUPTED 绝不在此列 —— 那是取消，连接还活着。
 */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_CLIENT_INTERACTION_TIMEOUT', // 服务端 wait_timeout 掐断（8.0+）
]);

function isConnectionLostError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CONNECTION_LOST_CODES.has(code);
}

/** 服务端"对象不存在"类错误码 —— C2 定义查看把这类错误归类为 NOT_FOUND（带原文） */
const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set([
  'ER_NO_SUCH_TABLE', // 1146：表/视图不存在
  'ER_BAD_TABLE', // 1051：Unknown table（DROP 语义）
  'ER_SP_DOES_NOT_EXIST', // 1305：PROCEDURE/FUNCTION xxx does not exist
  'ER_TRG_DOES_NOT_EXIST', // 1360：Trigger does not exist
  'ER_EVENT_DOES_NOT_EXIST', // Unknown event
]);

function isMissingObjectError(e: unknown): boolean {
  const anyE = e as { code?: unknown; message?: unknown } | null;
  if (typeof anyE?.code === 'string' && MISSING_OBJECT_CODES.has(anyE.code)) return true;
  // 各版本/对象类型的"不存在"文案不完全落在错误码上，消息兜底（只认明确的"不存在"语义）
  return /does not exist|Unknown (table|view|procedure|function|trigger|event)/i.test(
    String(anyE?.message ?? ''),
  );
}
