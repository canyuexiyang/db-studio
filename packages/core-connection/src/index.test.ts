import { describe, it, expect } from 'vitest';
import {
  ConnectionRuntime,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAYS_MS,
  buildGroupTree,
  checkPrivateKeyPermissions,
  defaultConnectionConfig,
  hasBlockingError,
  isProduction,
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
});

describe('生产环境判定', () => {
  it('红色标签 = 生产（危险操作加第三层确认）', () => {
    expect(isProduction(validCfg({ colorTag: 'red' }))).toBe(true);
    expect(isProduction(validCfg({ colorTag: 'blue' }))).toBe(false);
    expect(isProduction(validCfg())).toBe(false);
  });
});
