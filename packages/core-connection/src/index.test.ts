import { describe, it, expect } from 'vitest';
import {
  ConnectionRuntime,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS,
  KEEPALIVE_MAX_FAILURES,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAYS_MS,
  buildGroupTree,
  checkPrivateKeyPermissions,
  defaultConnectionConfig,
  hasBlockingError,
  isProduction,
  keepAliveDead,
  shouldKeepAlive,
  validateConnectionConfig,
  type Clock,
  type ConnectionConfig,
} from './index.js';

// ---- 可控时钟：让重连退避可被确定性驱动，不依赖真实 sleep ----
function fakeClock(start = 0) {
  let t = start;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let seq = 0;
  const clock: Clock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      const i = timers.findIndex((x) => x.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock,
    /** 推进时间并触发到期定时器 */
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        const i = timers.indexOf(due);
        if (i >= 0) timers.splice(i, 1);
        due.fn();
      }
      t = target;
    },
    pending: () => timers.length,
  };
}

function validCfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return defaultConnectionConfig({
    id: 'c1',
    name: 'local',
    user: 'root',
    passwordEnc: 'YWJj', // base64
    ...over,
  });
}

describe('配置校验', () => {
  it('合法配置无 error', () => {
    const issues = validateConnectionConfig(validCfg());
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('必填字段缺失都报错', () => {
    const issues = validateConnectionConfig(
      defaultConnectionConfig({ id: 'x', user: 'root', passwordEnc: 'YWJj' }),
    );
    expect(issues.find((i) => i.field === 'name')?.level).toBe('error');
  });

  it('v1 不支持的类型被拒', () => {
    const issues = validateConnectionConfig(validCfg({ type: 'postgresql' }));
    expect(hasBlockingError(issues)).toBe(true);
    expect(issues.some((i) => i.field === 'type')).toBe(true);
  });

  it('端口越界被拒', () => {
    expect(hasBlockingError(validateConnectionConfig(validCfg({ port: 0 })))).toBe(true);
    expect(hasBlockingError(validateConnectionConfig(validCfg({ port: 70000 })))).toBe(true);
    expect(hasBlockingError(validateConnectionConfig(validCfg({ port: 65535 })))).toBe(false);
  });

  it('无密文且未勾选每次手输 → 拒绝（无法认证）', () => {
    const issues = validateConnectionConfig(
      validCfg({ passwordEnc: null, promptEveryTime: false }),
    );
    expect(issues.some((i) => i.field === 'password')).toBe(true);
  });

  it('无密文但勾选每次手输 → 允许', () => {
    const issues = validateConnectionConfig(
      validCfg({ passwordEnc: null, promptEveryTime: true }),
    );
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('红线：疑似明文密码字段被识别（工程验收：配置文件不含明文密码）', () => {
    const issues = validateConnectionConfig(validCfg({ passwordEnc: 'my-plain-pwd!' }));
    const pw = issues.find((i) => i.field === 'password');
    expect(pw?.level).toBe('error');
  });

  it('SSH 私钥权限过宽 → warning 且给出 chmod 命令（不静默使用）', () => {
    const cfg = validCfg({
      ssh: { ...defaultConnectionConfig().ssh, enabled: true, host: 'h', user: 'u', privateKeyPath: '/k' },
    });
    const issues = validateConnectionConfig(cfg, { sshKeyMode: 0o644 });
    const w = issues.find((i) => i.field === 'ssh.privateKeyPath');
    expect(w?.level).toBe('warning');
    expect(w?.message).toContain('chmod 600');
    // warning 不阻塞保存
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('SSH 私钥权限 600 → 无警告', () => {
    const issues = validateConnectionConfig(validCfg(), { sshKeyMode: 0o600 });
    expect(issues.filter((i) => i.level === 'warning')).toHaveLength(0);
  });

  it('SSH 密码认证缺密码 → 拒绝', () => {
    const ssh = { ...defaultConnectionConfig().ssh, enabled: true, host: 'h', user: 'u', authType: 'password' as const };
    const issues = validateConnectionConfig(validCfg({ ssh }));
    expect(issues.some((i) => i.field === 'ssh.passwordEnc' && i.level === 'error')).toBe(true);
  });

  it('SSL 文件不存在 → 保存前报错', () => {
    const ssl = { ...defaultConnectionConfig().ssl, enabled: true, caPath: '/no/such/ca.pem' };
    const issues = validateConnectionConfig(validCfg({ ssl }), {
      fileExists: () => false,
    });
    expect(issues.some((i) => i.field === 'ssl.caPath' && i.level === 'error')).toBe(true);
  });

  it('关闭证书校验 → 不安全警示', () => {
    const ssl = { ...defaultConnectionConfig().ssl, enabled: true, rejectUnauthorized: false };
    const issues = validateConnectionConfig(validCfg({ ssl }), { fileExists: () => true });
    expect(
      issues.some((i) => i.field === 'ssl.rejectUnauthorized' && i.level === 'warning'),
    ).toBe(true);
  });
});

describe('私钥权限检查（纯函数）', () => {
  it('0644 不通过并给修复命令', () => {
    const r = checkPrivateKeyPermissions(0o644, '/tmp/id_rsa');
    expect(r.ok).toBe(false);
    expect(r.fixCommand).toBe('chmod 600 /tmp/id_rsa');
  });

  it('0600 通过', () => {
    expect(checkPrivateKeyPermissions(0o600, '/tmp/id_rsa').ok).toBe(true);
  });

  it('只检查 group/other 位，owner 的 rwx 不管', () => {
    expect(checkPrivateKeyPermissions(0o700, '/tmp/id_rsa').ok).toBe(true);
  });
});

describe('生命周期状态机', () => {
  it('正常路径 idle → connecting → connected → busy → connected', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    expect(rt.state).toBe('idle');
    expect(rt.connect()).toBe(true);
    expect(rt.state).toBe('connecting');
    rt.onConnected();
    expect(rt.state).toBe('connected');
    expect(rt.beginQuery()).toBe(true);
    expect(rt.state).toBe('busy');
    rt.endQuery();
    expect(rt.state).toBe('connected');
  });

  it('未连接时不能执行查询', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    expect(rt.canQuery()).toBe(false);
    expect(rt.beginQuery()).toBe(false);
  });

  it('连接失败进入 failed 并记录原始错误', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    rt.connect();
    rt.onConnectFailed('Access denied for user root');
    expect(rt.state).toBe('failed');
    expect(rt.lastError).toBe('Access denied for user root');
  });

  it('失败态可手动重试', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    rt.connect();
    rt.onConnectFailed('x');
    expect(rt.connect()).toBe(true);
    expect(rt.state).toBe('connecting');
  });

  it('自动重连间隔为 1s / 2s / 4s，最多 3 次', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock);
    rt.connect();
    rt.onConnected();

    expect(rt.onNetworkBreak()).toBe(true);
    expect(rt.state).toBe('disconnected');
    expect(rt.pendingReconnect?.delayMs).toBe(1000);

    advance(1000);
    expect(rt.state).toBe('connecting');
    rt.onNetworkBreak(); // 第 1 次重连仍失败
    expect(rt.pendingReconnect?.delayMs).toBe(2000);

    advance(2000);
    rt.onNetworkBreak();
    expect(rt.pendingReconnect?.delayMs).toBe(4000);

    advance(4000);
    rt.onNetworkBreak();
    // 第 4 次中断 → 重试耗尽
    expect(rt.attempts).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(rt.state).toBe('failed');
    expect(rt.pendingReconnect).toBeNull();
  });

  it('重连成功重置尝试计数', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock);
    rt.connect();
    rt.onConnected();
    rt.onNetworkBreak();
    advance(1000);
    rt.onReconnected();
    expect(rt.attempts).toBe(0);
    expect(rt.state).toBe('connected');
    expect(rt.changes.some((c) => c.reason?.includes('已重新连接') || c.to === 'connected')).toBe(true);
  });

  it('RECONNECT_DELAYS_MS 常量与 PRD 一致', () => {
    expect([...RECONNECT_DELAYS_MS]).toEqual([1000, 2000, 4000]);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(3);
  });

  it('空闲超时自动断开（默认 10 分钟）', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 600_000);
    rt.connect();
    rt.onConnected();
    advance(599_000);
    expect(rt.state).toBe('connected');
    advance(2_000);
    expect(rt.state).toBe('closed');
  });

  it('执行查询会刷新空闲计时', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 1000);
    rt.connect();
    rt.onConnected();
    advance(900);
    rt.beginQuery();
    rt.endQuery();
    advance(900);
    expect(rt.state).toBe('connected');
  });

  it('断开后资源释放并可重新连接', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    rt.connect();
    rt.onConnected();
    rt.disconnect();
    expect(rt.state).toBe('idle');
    expect(rt.isLive()).toBe(false);
    expect(rt.connect()).toBe(true);
  });

  it('connecting 期间重复 connect 无效', () => {
    const rt = new ConnectionRuntime('c1', fakeClock().clock);
    expect(rt.connect()).toBe(true);
    expect(rt.connect()).toBe(false);
  });
});

/**
 * 0.7.1 需求 4：心跳保活的调度判据。
 *
 * 这组断言的价值：任何一个条件写漏，代价都是**用户正在跑的查询被抢连接**
 * （点执行报「已有查询在执行」）或者**连接被误判死**（弹断线横幅）。
 */
describe('0.7.1 心跳保活：shouldKeepAlive', () => {
  const base = {
    state: 'connected' as const,
    idleForMs: 60_000,
    hasRunningQuery: false,
    consecutiveFailures: 0,
    keepAliveMs: 60_000,
  };

  it('到点且空闲 → 该发', () => {
    expect(shouldKeepAlive(base)).toBe(true);
  });

  it('保活关闭（keepAliveMs = 0）→ 不发', () => {
    expect(shouldKeepAlive({ ...base, keepAliveMs: 0 })).toBe(false);
  });

  it('🔴 busy 状态绝不插队（否则用户查询会吃 BUSY）', () => {
    expect(shouldKeepAlive({ ...base, state: 'busy' })).toBe(false);
    expect(shouldKeepAlive({ ...base, state: 'disconnected' })).toBe(false);
    expect(shouldKeepAlive({ ...base, state: 'closed' })).toBe(false);
  });

  it('🔴 有查询在跑就不发（与状态机双保险）', () => {
    expect(shouldKeepAlive({ ...base, hasRunningQuery: true })).toBe(false);
  });

  it('刚活动过（不足一个间隔）→ 不发，省一次多余往返', () => {
    expect(shouldKeepAlive({ ...base, idleForMs: 59_999 })).toBe(false);
  });

  it('已连续失败到阈值 → 不再发（等重连杆）', () => {
    expect(shouldKeepAlive({ ...base, consecutiveFailures: KEEPALIVE_MAX_FAILURES })).toBe(false);
    expect(shouldKeepAlive({ ...base, consecutiveFailures: 1 })).toBe(true);
  });

  it('连续失败 2 次判死（偶发 1 次不判）', () => {
    expect(KEEPALIVE_MAX_FAILURES).toBe(2);
    expect(keepAliveDead(1)).toBe(false);
    expect(keepAliveDead(2)).toBe(true);
  });
});

describe('0.7.1 心跳保活：touchActive 与默认值', () => {
  it('touchActive 刷新空闲计时（心跳成功不该让用户被 idle 断开）', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 60_000);
    rt.connect();
    rt.onConnected();
    advance(50_000);
    // 心跳成功：重置计时
    rt.touchActive();
    advance(50_000);
    expect(rt.state).toBe('connected');
    // 再过 11s 真到点了才断
    advance(11_000);
    expect(rt.state).toBe('closed');
  });

  it('touchActive 不迁移状态（心跳不该让 UI 闪 busy 或 connected）', () => {
    const { clock } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 60_000);
    rt.connect();
    rt.onConnected();
    const before = rt.changes.length;
    rt.touchActive();
    expect(rt.state).toBe('connected');
    expect(rt.changes.length).toBe(before); // 没有任何状态迁移记录
  });

  it('busy 期间的 touchActive 不刷新计时（心跳回执说明不了查询仍在跑）', () => {
    const { clock } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 60_000);
    rt.connect();
    rt.onConnected();
    rt.beginQuery();
    const before = rt.changes.length;
    rt.touchActive();
    expect(rt.state).toBe('busy');
    expect(rt.changes.length).toBe(before);
  });

  it('默认空闲超时是 120 分钟（0.7.1 由 10 分钟调整）', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(120 * 60 * 1000);
    expect(DEFAULT_KEEPALIVE_MS).toBe(60_000);
    // 连接默认值必须引用这个常量（不是各自写死）
    expect(defaultConnectionConfig().idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('idleTimeoutMs = 0 → 永不自动断开', () => {
    const { clock, advance } = fakeClock();
    const rt = new ConnectionRuntime('c1', clock, 0);
    rt.connect();
    rt.onConnected();
    advance(24 * 60 * 60 * 1000); // 一整天
    expect(rt.state).toBe('connected');
  });
});

describe('分组树', () => {
  it('按 group 嵌套构建', () => {
    const tree = buildGroupTree([
      validCfg({ id: '1', name: 'a', group: '生产/订单' }),
      validCfg({ id: '2', name: 'b', group: '生产/用户' }),
      validCfg({ id: '3', name: 'c', group: '开发' }),
    ]);
    const prod = tree.find((n) => n.name === '生产');
    expect(prod?.children.map((c) => c.name)).toEqual(['订单', '用户']);
    expect(tree.find((n) => n.name === '开发')?.connections[0].name).toBe('c');
  });

  it('未分组连接合并为一个容器', () => {
    const tree = buildGroupTree([
      validCfg({ id: '1', name: 'a' }),
      validCfg({ id: '2', name: 'b' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].connections.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('空列表返回空树', () => {
    expect(buildGroupTree([])).toEqual([]);
  });

  it('0.7.3：空分组（extraGroups）并进树，且逐段补父节点', () => {
    const tree = buildGroupTree([validCfg({ id: '1', name: 'a', group: '开发' })], ['归档', '归档/2025']);
    expect(tree.map((n) => n.name)).toEqual(['开发', '归档']);
    const archive = tree.find((n) => n.name === '归档');
    expect(archive?.connections).toEqual([]); // 空分组：没有成员，但存在
    expect(archive?.children.map((c) => c.name)).toEqual(['2025']);
  });

  it('空分组路径与已有分组重名时不重复、也不吃掉成员', () => {
    const tree = buildGroupTree([validCfg({ id: '1', name: 'a', group: '开发' })], ['开发', '开发']);
    expect(tree.filter((n) => n.name === '开发')).toHaveLength(1);
    expect(tree.find((n) => n.name === '开发')?.connections.map((c) => c.name)).toEqual(['a']);
  });
});

describe('生产环境判定', () => {
  it('红色标签 = 生产（危险操作加第三层确认）', () => {
    expect(isProduction(validCfg({ colorTag: 'red' }))).toBe(true);
    expect(isProduction(validCfg({ colorTag: 'blue' }))).toBe(false);
    expect(isProduction(validCfg())).toBe(false);
  });
});
