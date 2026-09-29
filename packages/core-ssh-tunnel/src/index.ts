/**
 * SSH 隧道（跳板机）—— `direct-tcpip` 端口转发
 *
 * 依据：
 *  - docs/archive/PRD-v0.4.md §6.1.2 SSH 隧道
 *    · 支持密码认证与私钥认证（私钥文件 + passphrase）
 *    · 支持跳板机（SSH 主机/端口/用户 + 目标库主机/端口）
 *    · 私钥权限过宽要警告（校验在 core-connection，不在这里）
 *    · **隧道建立超时默认 10s**，超时提示"SSH 隧道建立超时"
 *    · 连接关闭时隧道一并释放，不残留孤儿进程
 *  - docs/engineering/TECH-REVIEW-v1.0.md §4.6
 *    · 隧道与 DB 连接必须**成对管理**
 *    · `ssh2` 需配 `keepaliveInterval` / `keepaliveCountMax`，
 *      否则网络断开后隧道变"僵尸" —— 表现是"连着但所有查询超时"
 *
 * 设计约束：
 *  1. **不直接 `import ssh2`**。模块通过 `loadModule()` 注入，默认懒加载。
 *     理由同驱动：冷启动不该付这份钱（S2），且单测要用替身跑通全链路。
 *  2. **每条 DB 连接要一条独立 channel**。mysql2 一条连接占一个 socket，
 *     两条连接（主 + 管理）复用同一条 SSH channel 会互相串包。
 *     所以 `openChannel()` 可以被反复调用，而不是只建一次。
 *  3. **私钥内容由调用方读入**。本模块不碰文件系统 —— 路径与权限校验
 *     是 core-connection 的职责，这里只认"已经拿到的密钥文本"。
 *
 * 🔴 一个真实踩到的坑（改这段代码前务必知道）：
 *    mysql2 的 `stream` 选项**若传函数，是同步调用的** ——
 *    `this.stream = opts.config.stream(opts)`，返回值必须已经是 stream 对象。
 *    传一个返回 Promise 的工厂，mysql2 拿到的是 Promise，
 *    接着 `stream.on(...)` 直接抛 `this.stream.on is not a function`。
 *    → 正确姿势是**先 await 出 channel，再以对象形式传 `stream`**。
 *    这也是 `openChannel()` 必须 async 的原因。
 */

// ---------- 配置 ----------

export type SshAuthMethod = 'password' | 'privateKey';

export interface SshTunnelConfig {
  host: string;
  port: number;
  user: string;
  authType: SshAuthMethod;
  /** 明文密码。只在内存里存在一次，绝不落盘、绝不进日志 */
  password: string | null;
  /** 私钥文件【内容】（不是路径）。由调用方读入，便于测试注入 */
  privateKey: string | null;
  /** 私钥 passphrase（明文，同上） */
  passphrase: string | null;
  /** 隧道建立超时（ms）。PRD §6.1.2 默认 10s */
  connectTimeoutMs?: number;
}

/** PRD §6.1.2：隧道建立超时默认 10s */
export const DEFAULT_TUNNEL_TIMEOUT_MS = 10_000;

/**
 * 评审 §4.6 要求：不配 keepalive，断网后隧道会变僵尸。
 * 15s 发一次，连续 3 次无响应判定断开。
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;

/** 目标库（跳板机后面的那个地址） */
export interface TunnelTarget {
  host: string;
  port: number;
}

// ---------- ssh2 最小接口（便于替身，也避免 any 扩散） ----------

export interface TunnelStream {
  on(event: string, cb: (...args: any[]) => void): unknown;
  once?(event: string, cb: (...args: any[]) => void): unknown;
  end(): unknown;
  destroy?(): unknown;
}

export interface SshClientLike {
  connect(cfg: Record<string, unknown>): unknown;
  on(event: 'ready', cb: () => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  /** direct-tcpip 转发。回调形如 (err, stream) */
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: TunnelStream) => void,
  ): unknown;
  end(): unknown;
}

export interface SshModuleLike {
  createClient(): SshClientLike;
}

/** 依赖注入：测试用替身，生产默认懒加载 ssh2 */
export interface TunnelDeps {
  loadModule?: () => Promise<SshModuleLike>;
  now?: () => number;
}

/**
 * 解包 ssh2 模块 —— 兼容 ESM 与 CJS 两种导出形态。
 *
 * 🔴 真机踩到（2026-09-24，主进程 CJS 产物下）：
 *    `await import('ssh2')` 在 **CJS 产物**里拿到的对象命名导出【不完整】——
 *    只有 `Client` 少数几项，`utils` / `Server` 都在 `mod.default` 上。
 *    而同样的代码在 ESM（tsx 跑脚本）下命名导出是完整的。
 *    → 直接 `const { Client } = await import('ssh2')` 在 dev/脚本里正常，
 *      打包成 CJS 后可能取到 undefined，崩在运行时而不是构建期。
 *
 *    教训同 safeStorage 那次：对外部模块导出形态的假设必须真机验证，
 *    单测替身是按我们的假设写的，只会跟我们一起错。
 */
export function pickSshClient(mod: unknown): new () => SshClientLike {
  const anyMod = mod as any;
  const Client = anyMod?.Client ?? anyMod?.default?.Client;
  if (typeof Client !== 'function') {
    throw new TunnelError(
      `ssh2 模块导出形态异常：未找到 Client（keys=${Object.keys(anyMod ?? {}).join(',')}）`,
      'SSH_FAILED',
    );
  }
  return Client as new () => SshClientLike;
}

async function defaultLoadModule(): Promise<SshModuleLike> {
  // 懒加载：冷启动路径上不 require（评审 §5.1）
  const mod = await import('ssh2');
  const Client = pickSshClient(mod);
  return {
    createClient: () => new Client(),
  };
}

export class TunnelError extends Error {
  constructor(
    message: string,
    /** 供 UI 决定文案与是否可重试 */
    readonly code: TunnelErrorCode = 'SSH_FAILED',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export type TunnelErrorCode =
  | 'SSH_TIMEOUT'
  | 'SSH_AUTH_FAILED'
  | 'SSH_CHANNEL_FAILED'
  | 'SSH_CONFIG'
  | 'SSH_FAILED';

// ---------- 配置构建（纯函数，可单测） ----------

/**
 * 把隧道配置翻译成 ssh2 的 connect 参数。
 *
 * 🔴 私钥认证缺失密钥时**直接抛错**，不要退化成"不认证"——
 *    静默降级会让用户以为连上了，实际卡在认证阶段超时。
 */
export function buildSshConnectOptions(
  cfg: SshTunnelConfig,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!cfg.host.trim()) {
    throw new TunnelError('SSH 主机不能为空', 'SSH_CONFIG');
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new TunnelError(`SSH 端口非法：${cfg.port}`, 'SSH_CONFIG');
  }
  if (!cfg.user.trim()) {
    throw new TunnelError('SSH 用户不能为空', 'SSH_CONFIG');
  }

  const base: Record<string, unknown> = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    // 评审 §4.6：不配会让断网后隧道变僵尸（"连着但全超时"）
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    readyTimeout: cfg.connectTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
  };

  if (cfg.authType === 'password') {
    if (cfg.password == null || cfg.password === '') {
      throw new TunnelError('SSH 密码认证未提供密码', 'SSH_CONFIG');
    }
    base.password = cfg.password;
  } else {
    if (cfg.privateKey == null || cfg.privateKey === '') {
      throw new TunnelError('SSH 私钥认证未提供私钥内容', 'SSH_CONFIG');
    }
    base.privateKey = cfg.privateKey;
    // ssh2 只在 passphrase 非空时才认；传 null 会让部分密钥类型直接失败
    if (cfg.passphrase) base.passphrase = cfg.passphrase;
  }

  return { ...base, ...over };
}

/** 判定错误是不是认证失败（UI 要给不同文案） */
export function isAuthError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e).toLowerCase();
  return (
    msg.includes('authentication') ||
    msg.includes('auth') ||
    msg.includes('permission denied') ||
    msg.includes('publickey') ||
    msg.includes('password')
  );
}

// ---------- 隧道 ----------

export interface OpenChannelResult {
  stream: TunnelStream;
  /** 从发起到 channel 就绪的耗时（ms） */
  elapsedMs: number;
}

/**
 * 一条 SSH 连接 + 其上可开的多条转发 channel。
 *
 * 生命周期必须成对：调用方持有 tunnel，断开 DB 时调 `close()`。
 * 这是 PRD §6.1.2「不残留孤儿进程」的落地点。
 */
export class SshTunnel {
  private client: SshClientLike | null = null;
  private _closed = false;
  /** 已开出的 channel，close 时一并回收 */
  private readonly channels = new Set<TunnelStream>();

  constructor(
    private readonly cfg: SshTunnelConfig,
    private readonly deps: TunnelDeps = {},
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  get isReady(): boolean {
    return this.client !== null && !this._closed;
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /**
   * 建立 SSH 连接。
   *
   * 超时是【我们自己的 Promise 竞速】，不是 ssh2 的 readyTimeout ——
   * 后者只管握手阶段，认证卡住时它不一定触发。PRD 要求"隧道建立超时"
   * 有明确提示，所以这里必须自己兜住。
   */
  async connect(): Promise<{ elapsedMs: number }> {
    if (this._closed) throw new TunnelError('隧道已关闭', 'SSH_FAILED');
    if (this.client) return { elapsedMs: 0 };

    const load = this.deps.loadModule ?? defaultLoadModule;
    const timeoutMs = this.cfg.connectTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
    const started = this.now();

    const mod = await load();
    const client = mod.createClient();
    const options = buildSshConnectOptions(this.cfg);

    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (e: Error | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          e ? reject(e) : resolve();
        };

        client.on('ready', () => finish(null));
        client.on('error', (e) => finish(e));
        client.on('close', () => finish(new Error('SSH 连接已关闭')));

        timer = setTimeout(() => {
          // 超时后必须 end()，否则 ssh2 的 socket 会一直挂着
          try {
            client.end();
          } catch {
            /* 忽略：此时只关心把 Promise 收敛掉 */
          }
          finish(new TunnelError(`SSH 隧道建立超时（${timeoutMs}ms）`, 'SSH_TIMEOUT'));
        }, timeoutMs);

        try {
          client.connect(options);
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      });

      this.client = client;
      return { elapsedMs: this.now() - started };
    } catch (e) {
      try {
        client.end();
      } catch {
        /* 同上 */
      }
      if (e instanceof TunnelError) throw e;
      throw new TunnelError(
        `SSH 连接失败：${String((e as any)?.message ?? e)}`,
        isAuthError(e) ? 'SSH_AUTH_FAILED' : 'SSH_FAILED',
        e,
      );
    }
  }

  /**
   * 开一条到目标库的转发 channel。
   *
   * 可以被调用多次 —— 主连接与 KILL QUERY 用的管理连接各需要一条。
   *
   * 🔴 真机踩到的坑（单测替身永远测不出来）：
   *    `forwardOut` 的回调**不保证一定会被调用**。服务端若关闭了
   *    `AllowTcpForwarding`，有的实现既不 accept 也不 reject ——
   *    于是 Promise 永久挂起，表现为"连接转圈，永远不报错也不成功"。
   *    所以转发阶段必须和建连阶段一样自带超时。
   */
  async openChannel(target: TunnelTarget): Promise<OpenChannelResult> {
    if (!this.client) throw new TunnelError('SSH 隧道尚未建立', 'SSH_FAILED');
    if (this._closed) throw new TunnelError('隧道已关闭', 'SSH_FAILED');

    if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new TunnelError(`隧道目标地址非法：${target.host}:${target.port}`, 'SSH_CONFIG');
    }

    const timeoutMs = this.cfg.connectTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
    const started = this.now();

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const stream = await new Promise<TunnelStream>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          fn();
        };

        timer = setTimeout(() => {
          finish(() =>
            reject(new TunnelError(`SSH 端口转发超时（${timeoutMs}ms）`, 'SSH_CHANNEL_FAILED')),
          );
        }, timeoutMs);

        this.client!.forwardOut('127.0.0.1', 0, target.host, target.port, (err, s) => {
          if (err) {
            finish(() =>
              reject(new TunnelError(`SSH 端口转发失败：${err.message}`, 'SSH_CHANNEL_FAILED', err)),
            );
          } else {
            finish(() => resolve(s));
          }
        });
      });

      // 隧道自身断开时把 channel 从表里摘掉，避免 close() 重复 end
      stream.on('close', () => this.channels.delete(stream));
      this.channels.add(stream);

      return { stream, elapsedMs: this.now() - started };
    } catch (e) {
      if (e instanceof TunnelError) throw e;
      throw new TunnelError(String((e as any)?.message ?? e), 'SSH_CHANNEL_FAILED', e);
    }
  }

  /** 释放：先关所有 channel，再关 SSH 连接 */
  async close(): Promise<void> {
    this._closed = true;
    const client = this.client;
    this.client = null;

    for (const ch of this.channels) {
      try {
        ch.end();
      } catch {
        // 单条 channel 关不掉不能挡住整体回收（孤儿进程是更坏的结果）
      }
    }
    this.channels.clear();

    if (client) {
      try {
        client.end();
      } catch {
        /* 同上 */
      }
    }
  }
}

/**
 * 建立隧道并开第一条 channel —— 最常用的组合路径。
 *
 * ⚠️ 失败时**必须关掉已建的隧道**：否则 SSH 连接会留在进程里，
 *    而调用方拿到的是异常、并不会去关它（PRD §6.1.2 孤儿进程红线）。
 */
export async function openTunnelChannel(
  cfg: SshTunnelConfig,
  target: TunnelTarget,
  deps: TunnelDeps = {},
): Promise<{ tunnel: SshTunnel; stream: TunnelStream; elapsedMs: number }> {
  const tunnel = new SshTunnel(cfg, deps);
  try {
    await tunnel.connect();
    const r = await tunnel.openChannel(target);
    return { tunnel, stream: r.stream, elapsedMs: r.elapsedMs };
  } catch (e) {
    await tunnel.close().catch(() => undefined);
    if (e instanceof TunnelError) throw e;
    throw new TunnelError(String((e as any)?.message ?? e), 'SSH_FAILED', e);
  }
}
