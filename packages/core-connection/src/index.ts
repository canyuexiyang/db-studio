/**
 * 连接配置模型 + 生命周期状态机（PRD §6.1）
 *
 * 依据：
 *  - §6.1.1 连接配置字段与行为要求
 *  - §6.1.2 SSH 隧道（私钥权限过宽要警告，不静默使用）
 *  - §6.1.3 SSL/TLS（保存前校验文件是否存在）
 *  - §6.1.4 生命周期状态机 + 自动重连（最多 3 次，间隔 1s/2s/4s）
 *  - §6.1.6 只读模式开关（连接级）
 *
 * 设计约束：
 *  1. 本模块【绝不持有明文密码】——只有 passwordEnc（密文 base64）。
 *     明文只在 SecretStore 解密后的内存里短暂存在。
 *  2. 状态机不直接依赖定时器实现：时钟与定时器通过构造参数注入，
 *     这样状态迁移与重连退避可以被单测确定性驱动。
 *  3. 校验失败不抛异常，返回错误列表（UI 需要逐条展示）。
 */

// ---------- 基础类型 ----------

export type DbType = 'mysql' | 'postgresql' | 'redis' | 'mongodb';

/** v1 仅 MySQL 可用，其余在 UI 置灰显示"即将支持" */
export const SUPPORTED_TYPES: ReadonlySet<DbType> = new Set<DbType>(['mysql']);

/** 端口按类型带默认值（§6.1.1） */
export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgresql: 5432,
  redis: 6379,
  mongodb: 27017,
};

/** 8 色可选，生产建议红色 */
export const COLOR_TAGS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
  'brown',
] as const;

export type ColorTag = (typeof COLOR_TAGS)[number];

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authType: 'password' | 'privateKey';
  /** 密文 base64；由 SecretStore 解密 */
  passwordEnc: string | null;
  privateKeyPath: string | null;
  /** 私钥 passphrase 密文 base64 */
  passphraseEnc: string | null;
}

export interface SslConfig {
  enabled: boolean;
  caPath: string | null;
  certPath: string | null;
  keyPath: string | null;
  /** 关闭校验 = 不安全，UI 必须显示黄色警示条（§6.1.3） */
  rejectUnauthorized: boolean;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  /** 密文 base64。null = 未设置（走每次手输） */
  passwordEnc: string | null;
  /** 每次手动输密码、不落盘（§6.1.1 降级模式） */
  promptEveryTime: boolean;
  /** 留空则连接后展示全部库 */
  defaultDatabase: string | null;
  /** 支持"开发/测试/生产"，可嵌套，如 "生产/订单" */
  group: string | null;
  colorTag: ColorTag | null;
  note: string | null;
  /** D6 只读模式（§6.1.6） */
  readOnly: boolean;
  ssh: SshConfig;
  ssl: SslConfig;
  /** 空闲多久自动断开（ms），默认 10 分钟 */
  idleTimeoutMs: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function emptySsh(): SshConfig {
  return {
    enabled: false,
    host: '',
    port: 22,
    user: '',
    authType: 'privateKey',
    passwordEnc: null,
    privateKeyPath: null,
    passphraseEnc: null,
  };
}

export function emptySsl(): SslConfig {
  return {
    enabled: false,
    caPath: null,
    certPath: null,
    keyPath: null,
    rejectUnauthorized: true,
  };
}

export function defaultConnectionConfig(
  over: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  const type = over.type ?? 'mysql';
  return {
    id: '',
    name: '',
    type,
    host: '127.0.0.1',
    port: DEFAULT_PORTS[type],
    user: '',
    passwordEnc: null,
    promptEveryTime: false,
    defaultDatabase: null,
    group: null,
    colorTag: null,
    note: null,
    readOnly: false,
    ssh: emptySsh(),
    ssl: emptySsl(),
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    ...over,
  };
}

// ---------- 校验 ----------

export interface ValidationIssue {
  /** 字段路径，便于 UI 定位高亮 */
  field: string;
  message: string;
  /** error = 禁止保存；warning = 可保存但需提示（如私钥权限过宽） */
  level: 'error' | 'warning';
}

export interface ValidateOptions {
  /** 检查 SSH 私钥文件权限。传入 stat().mode；不传则跳过该检查 */
  sshKeyMode?: number | null;
  /** 检查证书文件是否存在。传入路径 → boolean */
  fileExists?: (p: string) => boolean;
}

export function validateConnectionConfig(
  cfg: ConnectionConfig,
  opts: ValidateOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ field, message, level: 'error' });
  const warn = (field: string, message: string) =>
    issues.push({ field, message, level: 'warning' });

  if (!cfg.name.trim()) err('name', '连接名不能为空');
  if (!SUPPORTED_TYPES.has(cfg.type)) {
    err('type', `数据库类型「${cfg.type}」v1 暂不支持`);
  }
  if (!cfg.host.trim()) err('host', '主机不能为空');

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    err('port', '端口必须是 1~65535 的整数');
  }

  if (cfg.type !== 'redis' && !cfg.user.trim()) {
    err('user', '用户名不能为空');
  }

  // 密码：要么有密文，要么明确走"每次手输"。两者都没有 → 无法连接
  if (!cfg.passwordEnc && !cfg.promptEveryTime) {
    err('password', '未保存密码且未勾选「每次手动输入」，无法确定认证方式');
  }
  // 红线：配置里出现疑似明文密码字段（防误把明文塞进 password 字段）
  if (looksLikePlaintextLeak(cfg)) {
    err('password', '检测到疑似明文凭据字段，密码只允许存入钥匙串');
  }

  if (!Number.isFinite(cfg.idleTimeoutMs) || cfg.idleTimeoutMs < 0) {
    err('idleTimeoutMs', '空闲超时必须是非负数值');
  }

  // ---- SSH（§6.1.2）----
  if (cfg.ssh.enabled) {
    if (!cfg.ssh.host.trim()) err('ssh.host', 'SSH 主机不能为空');
    if (!Number.isInteger(cfg.ssh.port) || cfg.ssh.port < 1 || cfg.ssh.port > 65535) {
      err('ssh.port', 'SSH 端口必须是 1~65535 的整数');
    }
    if (!cfg.ssh.user.trim()) err('ssh.user', 'SSH 用户不能为空');

    if (cfg.ssh.authType === 'privateKey') {
      if (!cfg.ssh.privateKeyPath) {
        err('ssh.privateKeyPath', '私钥认证必须选择私钥文件');
      } else if (opts.sshKeyMode != null) {
        // 权限过宽 → 警告并给修复命令，不静默使用
        const risky = opts.sshKeyMode & 0o077;
        if (risky !== 0) {
          warn(
            'ssh.privateKeyPath',
            `私钥文件权限过宽（${(opts.sshKeyMode & 0o777).toString(8)}），` +
              `建议执行：chmod 600 ${cfg.ssh.privateKeyPath}`,
          );
        }
      }
    } else if (!cfg.ssh.passwordEnc) {
      err('ssh.passwordEnc', 'SSH 密码认证必须提供密码');
    }
  }

  // ---- SSL（§6.1.3）：保存前校验文件存在 ----
  if (cfg.ssl.enabled && opts.fileExists) {
    for (const [field, path] of [
      ['ssl.caPath', cfg.ssl.caPath],
      ['ssl.certPath', cfg.ssl.certPath],
      ['ssl.keyPath', cfg.ssl.keyPath],
    ] as const) {
      if (path && !opts.fileExists(path)) {
        err(field, `文件不存在：${path}`);
      }
    }
    if (!cfg.ssl.rejectUnauthorized) {
      warn('ssl.rejectUnauthorized', '已关闭证书校验，连接不安全');
    }
  }

  return issues;
}

/** 是否存在"看起来像明文凭据"的字段（工程验收：配置文件不出现明文密码） */
function looksLikePlaintextLeak(cfg: ConnectionConfig): boolean {
  const leaky = [cfg.passwordEnc, cfg.ssh.passwordEnc, cfg.ssh.passphraseEnc];
  return leaky.some((v) => {
    if (v === null) return false;
    // 密文一律是 base64；含空白或明显非 base64 字符即视为明文误存
    if (/\s/.test(v)) return true;
    return !/^[A-Za-z0-9+/=]+$/.test(v);
  });
}

export function hasBlockingError(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

// ---------- SSH 私钥权限（纯函数，便于单测） ----------

export interface SshKeyPermissionCheck {
  ok: boolean;
  /** 建议执行的修复命令 */
  fixCommand: string | null;
  message: string | null;
}

export function checkPrivateKeyPermissions(
  mode: number,
  path: string,
): SshKeyPermissionCheck {
  const perm = mode & 0o777;
  if (perm & 0o077) {
    return {
      ok: false,
      fixCommand: `chmod 600 ${path}`,
      message: `私钥文件权限过宽（${perm.toString(8)}），SSH 会拒绝使用该私钥`,
    };
  }
  return { ok: true, fixCommand: null, message: null };
}

// ---------- 生命周期状态机（§6.1.4） ----------

export type ConnectionState =
  | 'idle'          // 未连接
  | 'connecting'    // 连接中
  | 'connected'     // 已连接且空闲
  | 'busy'          // 执行查询中
  | 'disconnected'  // 网络中断，自动重连中
  | 'failed'        // 失败态（需手动重试）
  | 'closed';       // 主动断开

/** 自动重连：最多 3 次，间隔 1s / 2s / 4s（§6.1.4） */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

/** 可注入的时钟与定时器 —— 让重连退避可被单测确定性驱动 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface StateChange {
  from: ConnectionState;
  to: ConnectionState;
  at: number;
  reason?: string;
}

export interface ReconnectPlan {
  attempt: number;
  delayMs: number;
}

export class ConnectionRuntime {
  private _state: ConnectionState = 'idle';
  private _lastError: string | null = null;
  private _lastActiveAt: number;
  private _attempts = 0;
  private _idleTimer: unknown = null;
  private _reconnectTimer: unknown = null;
  /** 待执行的重连计划（测试可主动触发，真实环境由定时器触发） */
  private _pendingReconnect: ReconnectPlan | null = null;
  private readonly history: StateChange[] = [];

  constructor(
    readonly id: string,
    private readonly clock: Clock = systemClock,
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {
    this._lastActiveAt = clock.now();
  }

  get state(): ConnectionState {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get attempts(): number {
    return this._attempts;
  }

  get pendingReconnect(): ReconnectPlan | null {
    return this._pendingReconnect;
  }

  get changes(): readonly StateChange[] {
    return this.history;
  }

  /** 距上次活跃过去了多久（ms） */
  idleFor(): number {
    return this.clock.now() - this._lastActiveAt;
  }

  private transition(to: ConnectionState, reason?: string): void {
    if (this._state === to) return;
    const from = this._state;
    this.history.push({ from, to, at: this.clock.now(), reason });
    this._state = to;
  }

  private clearTimers(): void {
    if (this._idleTimer != null) {
      this.clock.clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._reconnectTimer != null) {
      this.clock.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private armIdleTimer(): void {
    if (this._idleTimer != null) this.clock.clearTimeout(this._idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    this._idleTimer = this.clock.setTimeout(() => {
      // 只有空闲（非 busy）才自动断开释放资源
      if (this._state === 'connected') {
        this.transition('closed', '空闲超时，自动断开释放资源');
      }
    }, this.idleTimeoutMs);
  }

  // ---- 事件 ----

  /** 请求连接。失败态可再次调用（手动重试） */
  connect(): boolean {
    if (this._state === 'connecting' || this._state === 'busy') return false;
    if (this._state === 'connected') return false;
    if (this._state === 'disconnected' && this._pendingReconnect) return false; // 已在重连排队中
    this.clearTimers();
    this._lastError = null;
    this.transition('connecting', this._state === 'failed' ? '用户手动重试' : undefined);
    return true;
  }

  onConnected(): void {
    this._attempts = 0;
    this._pendingReconnect = null;
    this.clearTimers();
    this._lastActiveAt = this.clock.now();
    this._lastError = null;
    this.transition('connected');
    this.armIdleTimer();
  }

  onConnectFailed(message: string): void {
    this._lastError = message;
    this.clearTimers();
    this.transition('failed', message);
  }

  beginQuery(): boolean {
    if (this._state !== 'connected') return false;
    this._lastActiveAt = this.clock.now();
    this.transition('busy');
    return true;
  }

  endQuery(): void {
    if (this._state !== 'busy') return;
    this._lastActiveAt = this.clock.now();
    this.transition('connected');
    this.armIdleTimer();
  }

  /**
   * 网络中断。返回 true 表示已排定一次自动重连；返回 false 表示重试耗尽 → 失败态。
   */
  onNetworkBreak(message = '网络中断'): boolean {
    if (this._state === 'closed' || this._state === 'idle') return false;
    this._lastError = message;
    this.clearTimers();

    if (this._attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.transition('failed', `${message}（已重试 ${this._attempts} 次，仍未恢复）`);
      return false;
    }

    const delayMs = RECONNECT_DELAYS_MS[this._attempts];
    const attempt = this._attempts + 1;
    this._attempts = attempt;
    this._pendingReconnect = { attempt, delayMs };
    this.transition('disconnected', `${message}，${delayMs}ms 后第 ${attempt} 次重连`);

    this._reconnectTimer = this.clock.setTimeout(() => {
      this._reconnectTimer = null;
      this._pendingReconnect = null;
      this.transition('connecting', `第 ${attempt} 次自动重连`);
    }, delayMs);
    return true;
  }

  /** 重连成功：恢复空闲态并重置计数（UI 应据此恢复树展开状态并提示"已重新连接"） */
  onReconnected(): void {
    this.onConnected();
  }

  disconnect(reason = '用户主动断开'): void {
    this.clearTimers();
    this._attempts = 0;
    this._pendingReconnect = null;
    if (this._state !== 'idle') {
      this.transition('closed', reason);
      this.transition('idle', '资源已释放');
    }
  }

  /** 是否可执行查询 */
  canQuery(): boolean {
    return this._state === 'connected';
  }

  /** 是否已建立（含忙碌） */
  isLive(): boolean {
    return this._state === 'connected' || this._state === 'busy';
  }
}

// ---------- 分组（§6.2.1：分组 → 连接，可嵌套） ----------

export interface GroupNode {
  name: string;
  path: string;
  children: GroupNode[];
  connections: ConnectionConfig[];
}

/** 按 group 字段（"生产/订单" 形式）构建分组树 */
export function buildGroupTree(list: ConnectionConfig[]): GroupNode[] {
  const roots: GroupNode[] = [];
  const index = new Map<string, GroupNode>();

  const ensure = (path: string): GroupNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const parts = path.split('/').filter(Boolean);
    const node: GroupNode = {
      name: parts[parts.length - 1] ?? path,
      path,
      children: [],
      connections: [],
    };
    index.set(path, node);
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parent = ensure(parts.slice(0, -1).join('/'));
      parent.children.push(node);
    }
    return node;
  };

  for (const cfg of list) {
    if (!cfg.group) {
      roots.push({
        name: '',
        path: '',
        children: [],
        connections: [cfg],
      });
      continue;
    }
    ensure(cfg.group).connections.push(cfg);
  }

  // 未分组的连接合并进一个根层"未分组"容器，避免散落多个空壳
  const ungrouped = roots.filter((r) => r.path === '');
  if (ungrouped.length > 1) {
    const merged: GroupNode = {
      name: '',
      path: '',
      children: [],
      connections: ungrouped.flatMap((r) => r.connections),
    };
    for (let i = roots.length - 1; i >= 0; i--) {
      if (roots[i].path === '') roots.splice(i, 1);
    }
    roots.push(merged);
  }

  return roots;
}

/** 生产环境判定：红色标签视为生产（危险操作加第三层确认，§6.2.2） */
export function isProduction(cfg: ConnectionConfig): boolean {
  return cfg.colorTag === 'red';
}
