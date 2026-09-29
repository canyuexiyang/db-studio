/**
 * SSH 隧道测试 —— 用替身 ssh2 模块跑通全链路，不起真 SSH 服务。
 * （真 SSH + 真 MySQL 的验证在 scripts/e2e-ssh.mjs，那是另一层保障。）
 *
 * 重点守四条：
 *  1. 🔴 认证方式不能静默降级 —— 私钥为空必须报错，不能退化成"不认证"
 *  2. 🔴 超时必须能真正收敛 Promise（ssh2 的 readyTimeout 只管握手，
 *     认证卡住时不触发，所以超是我们自己兜的）
 *  3. 🔴 失败路径要关掉已建的隧道，不留孤儿连接
 *  4. 🔴 keepalive 必须配（评审 §4.6：不配断网后变僵尸隧道）
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SshTunnel,
  TunnelError,
  buildSshConnectOptions,
  openTunnelChannel,
  isAuthError,
  pickSshClient,
  DEFAULT_TUNNEL_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_COUNT_MAX,
  type SshTunnelConfig,
  type SshClientLike,
  type SshModuleLike,
  type TunnelStream,
} from './index.js';

// ---------- 替身 ssh2 ----------

class FakeStream implements TunnelStream {
  ended = false;
  destroyed = false;
  private handlers = new Map<string, ((...a: any[]) => void)[]>();

  on(event: string, cb: (...a: any[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  end(): unknown {
    this.ended = true;
    this.emit('close');
    return this;
  }
  destroy(): unknown {
    this.destroyed = true;
    return this;
  }
}

type ReadyBehavior = 'ready' | 'error' | 'never' | 'close';

class FakeClient implements SshClientLike {
  ended = false;
  connectOptions: Record<string, unknown> | null = null;
  forwardCalls: { dstIP: string; dstPort: number }[] = [];
  /** 让下一次 forwardOut 失败 */
  failForward: string | null = null;
  /** 让下一次 forwardOut 永不回调（测转发卡住） */
  hangForward = false;

  private handlers = new Map<string, ((...a: any[]) => void)[]>();

  constructor(private readonly behavior: ReadyBehavior) {}

  connect(cfg: Record<string, unknown>): unknown {
    this.connectOptions = cfg;
    // 异步触发，贴近真实（同步 emit 会让 await 之前就丢了事件）
    setTimeout(() => {
      if (this.behavior === 'ready') this.emit('ready');
      else if (this.behavior === 'error') this.emit('error', new Error('All configured authentication methods failed'));
      else if (this.behavior === 'close') this.emit('close');
    }, 0);
    return this;
  }

  on(event: string, cb: (...a: any[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  forwardOut(
    _srcIP: string,
    _srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: TunnelStream) => void,
  ): unknown {
    this.forwardCalls.push({ dstIP, dstPort });
    setTimeout(() => {
      if (this.hangForward) return; // 永不回调
      if (this.failForward) cb(new Error(this.failForward), null as unknown as TunnelStream);
      else cb(undefined, new FakeStream());
    }, 0);
    return this;
  }

  end(): unknown {
    this.ended = true;
    return this;
  }
}

function fakeModule(behavior: ReadyBehavior = 'ready'): { mod: SshModuleLike; client: () => FakeClient } {
  let made: FakeClient | null = null;
  const mod: SshModuleLike = {
    createClient: () => {
      made = new FakeClient(behavior);
      return made;
    },
  };
  return { mod, client: () => made! };
}

const baseCfg = (over: Partial<SshTunnelConfig> = {}): SshTunnelConfig => ({
  host: 'jump.example.com',
  port: 22,
  user: 'dbuser',
  authType: 'password',
  password: 'secret',
  privateKey: null,
  passphrase: null,
  ...over,
});

const TARGET = { host: '10.0.0.5', port: 3306 };

// ---------- 配置构建 ----------

describe('SSH 连接参数（纯函数）', () => {
  it('密码认证：只带 password，不带私钥', () => {
    const o = buildSshConnectOptions(baseCfg());
    expect(o.password).toBe('secret');
    expect(o.privateKey).toBeUndefined();
    expect(o.username).toBe('dbuser');
  });

  it('私钥认证：带 privateKey，不带 password', () => {
    const o = buildSshConnectOptions(
      baseCfg({ authType: 'privateKey', password: null, privateKey: 'KEY-BODY' }),
    );
    expect(o.privateKey).toBe('KEY-BODY');
    expect(o.password).toBeUndefined();
  });

  it('私钥带 passphrase 时才传（传 null 会让部分密钥类型失败）', () => {
    const withPass = buildSshConnectOptions(
      baseCfg({ authType: 'privateKey', privateKey: 'K', passphrase: 'pp' }),
    );
    expect(withPass.passphrase).toBe('pp');

    const noPass = buildSshConnectOptions(baseCfg({ authType: 'privateKey', privateKey: 'K' }));
    expect(noPass.passphrase).toBeUndefined();
  });

  it('🔴 keepalive 必配（评审 §4.6：不配断网后隧道变僵尸）', () => {
    const o = buildSshConnectOptions(baseCfg());
    expect(o.keepaliveInterval).toBe(KEEPALIVE_INTERVAL_MS);
    expect(o.keepaliveCountMax).toBe(KEEPALIVE_COUNT_MAX);
    expect(KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('超时默认 10s（PRD §6.1.2），可覆盖', () => {
    expect(buildSshConnectOptions(baseCfg()).readyTimeout).toBe(DEFAULT_TUNNEL_TIMEOUT_MS);
    expect(buildSshConnectOptions(baseCfg({ connectTimeoutMs: 3000 })).readyTimeout).toBe(3000);
  });

  it('🔴 私钥认证但没给密钥 → 报错，不静默降级成免认证', () => {
    expect(() => buildSshConnectOptions(baseCfg({ authType: 'privateKey', privateKey: null }))).toThrow(
      TunnelError,
    );
  });

  it('密码认证但没给密码 → 报错', () => {
    expect(() => buildSshConnectOptions(baseCfg({ password: null }))).toThrow(TunnelError);
  });

  it('主机 / 用户 / 端口非法一律拒绝', () => {
    expect(() => buildSshConnectOptions(baseCfg({ host: '  ' }))).toThrow(/主机/);
    expect(() => buildSshConnectOptions(baseCfg({ user: '' }))).toThrow(/用户/);
    expect(() => buildSshConnectOptions(baseCfg({ port: 0 }))).toThrow(/端口/);
    expect(() => buildSshConnectOptions(baseCfg({ port: 70000 }))).toThrow(/端口/);
  });
});

describe('🔴 ssh2 模块解包（真机踩过的坑）', () => {
  it('CJS 形态：Client 只在 default 上时也要能取到', async () => {
    // 主进程打包成 CJS 后，await import('ssh2') 的命名导出不完整，
    // utils/Server 都跑到 default 上去了 —— 只认命名导出会在真机上崩。
    const cjsShaped = {
      default: { Client: class {}, Server: class {} },
    };
    const t = new SshTunnel(baseCfg(), { loadModule: async () => cjsShaped as unknown as SshModuleLike });
    // 连不上没关系，只要不是崩在"导出形态异常"上
    let msg = '';
    try {
      await t.connect();
    } catch (e) {
      msg = String((e as Error)?.message ?? '');
    }
    expect(msg).not.toContain('导出形态异常');
  });

  it('导出形态完全不对时给明确报错，而不是 undefined 崩溃', () => {
    // 直接测解包函数：替身模块不走这条路径（它本来就是假模块），
    // 所以必须把解包逻辑单独暴露出来才能守住这个契约。
    expect(() => pickSshClient({ somethingElse: 1 })).toThrow(/导出形态异常/);
    expect(() => pickSshClient(null)).toThrow(/导出形态异常/);
  });
});

describe('错误分类', () => {
  it('认证失败要能识别出来（UI 给不同文案）', () => {
    expect(isAuthError(new Error('All configured authentication methods failed'))).toBe(true);
    expect(isAuthError(new Error('Permission denied (publickey)'))).toBe(true);
    expect(isAuthError(new Error('ECONNREFUSED'))).toBe(false);
  });
});

// ---------- 连接生命周期 ----------

describe('隧道建立', () => {
  it('connect 成功并记耗时', async () => {
    const { mod } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    const r = await t.connect();
    expect(t.isReady).toBe(true);
    expect(typeof r.elapsedMs).toBe('number');
  });

  it('重复 connect 不重复建连（SSH 连接是重资源）', async () => {
    const { mod, client } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    const first = client();
    await t.connect();
    expect(client()).toBe(first);
  });

  it('认证失败 → 归为 SSH_AUTH_FAILED', async () => {
    const { mod } = fakeModule('error');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await expect(t.connect()).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('连接被关闭 → 报错而不是永久挂起', async () => {
    const { mod } = fakeModule('close');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await expect(t.connect()).rejects.toThrow(/关闭/);
  });

  it('🔴 超时能真正收敛 Promise（ssh2 readyTimeout 只管握手，认证卡住不触发）', async () => {
    vi.useFakeTimers();
    try {
      const { mod, client } = fakeModule('never');
      const t = new SshTunnel(baseCfg({ connectTimeoutMs: 5000 }), { loadModule: async () => mod });
      const p = t.connect();
      // 断言在超时前不 settled
      let settled = false;
      void p.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(4000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
      // 超时的隧道必须被 end 掉，否则 socket 一直挂着
      expect(client().ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connect 抛错时也要 end 掉 client，不留悬挂 socket', async () => {
    const { mod, client } = fakeModule('error');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await expect(t.connect()).rejects.toThrow();
    expect(client().ended).toBe(true);
  });

  it('已关闭的隧道不能再连', async () => {
    const { mod } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.close();
    await expect(t.connect()).rejects.toThrow(/已关闭/);
  });
});

// ---------- channel ----------

describe('转发 channel', () => {
  it('openChannel 把目标地址原样传给 ssh2', async () => {
    const { mod, client } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    await t.openChannel(TARGET);
    expect(client().forwardCalls).toEqual([{ dstIP: '10.0.0.5', dstPort: 3306 }]);
  });

  it('🔴 可以开多条 channel（主连接 + KILL QUERY 管理连接各要一条）', async () => {
    const { mod, client } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    await t.openChannel(TARGET);
    await t.openChannel(TARGET);
    expect(client().forwardCalls).toHaveLength(2);
    expect(t.channelCount).toBe(2);
  });

  it('未 connect 就开 channel → 报错', async () => {
    const { mod } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await expect(t.openChannel(TARGET)).rejects.toThrow(/尚未建立/);
  });

  it('目标地址非法 → 报错（防注入脏值进 SSH 协议栈）', async () => {
    const { mod } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    await expect(t.openChannel({ host: '', port: 3306 })).rejects.toThrow(/非法/);
    await expect(t.openChannel({ host: 'x', port: 0 })).rejects.toThrow(/非法/);
  });

  it('forwardOut 出错 → 归为 SSH_CHANNEL_FAILED', async () => {
    // 转发失败要能拿到具体原因（服务端常见 "administratively prohibited"）
    const failing: SshModuleLike = {
      createClient: () => {
        const c = new FakeClient('ready');
        c.failForward = 'administratively prohibited';
        return c;
      },
    };
    const t = new SshTunnel(baseCfg(), { loadModule: async () => failing });
    await t.connect();
    await expect(t.openChannel(TARGET)).rejects.toMatchObject({ code: 'SSH_CHANNEL_FAILED' });
  });

  it('🔴 forwardOut 永不回调 → 超时，不能永久挂起', async () => {
    // 真机踩到：sshd 关掉 AllowTcpForwarding 时，有的实现既不 accept
    // 也不 reject —— 回调永远不来。表现为"连接转圈，不成功也不报错"。
    const hanging: SshModuleLike = {
      createClient: () => {
        const c = new FakeClient('ready');
        c.hangForward = true;
        return c;
      },
    };
    // ⚠️ connect 也要靠 setTimeout(0) 触发 ready，必须在【真计时器】下完成，
    //    否则它会和下面要测的转发超时一起被假计时器卡住。
    const t = new SshTunnel(baseCfg({ connectTimeoutMs: 2000 }), { loadModule: async () => hanging });
    await t.connect();

    vi.useFakeTimers();
    try {
      const p = t.openChannel(TARGET);
      let settled = false;
      void p.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).rejects.toMatchObject({ code: 'SSH_CHANNEL_FAILED' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- 释放 ----------

describe('隧道释放（PRD §6.1.2 不残留孤儿进程）', () => {
  it('close 同时关 SSH 连接与所有 channel', async () => {
    const { mod, client } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    const a = await t.openChannel(TARGET);
    const b = await t.openChannel(TARGET);

    await t.close();

    expect(client().ended).toBe(true);
    expect((a.stream as unknown as FakeStream).ended).toBe(true);
    expect((b.stream as unknown as FakeStream).ended).toBe(true);
    expect(t.isReady).toBe(false);
    expect(t.channelCount).toBe(0);
  });

  it('close 幂等（退出清理路径会重复调用）', async () => {
    const { mod } = fakeModule('ready');
    const t = new SshTunnel(baseCfg(), { loadModule: async () => mod });
    await t.connect();
    await t.close();
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('🔴 openTunnelChannel 失败时把已建隧道关掉（否则 SSH 连接泄漏）', async () => {
    // 转发失败：connect 已成功，异常发生在第二步。
    // 组合函数必须自己收尾 —— 调用方只拿到异常，不会去关它建的隧道。
    const clients: FakeClient[] = [];
    const failing: SshModuleLike = {
      createClient: () => {
        const c = new FakeClient('ready');
        c.failForward = 'administratively prohibited';
        clients.push(c);
        return c;
      },
    };

    await expect(openTunnelChannel(baseCfg(), TARGET, { loadModule: async () => failing })).rejects.toMatchObject({
      code: 'SSH_CHANNEL_FAILED',
    });
    // 关键断言：SSH 连接真的被 end 掉了，没留在进程里
    expect(clients).toHaveLength(1);
    expect(clients[0].ended).toBe(true);
  });

  it('openTunnelChannel 成功时返回 tunnel + stream，且调用方能自行关闭', async () => {
    const { mod } = fakeModule('ready');
    const r = await openTunnelChannel(baseCfg(), TARGET, { loadModule: async () => mod });
    expect(r.tunnel.isReady).toBe(true);
    expect(r.stream).toBeTruthy();
    await r.tunnel.close();
    expect(r.tunnel.isReady).toBe(false);
  });
});
