/**
 * 隧道管理器测试 —— 替身 core-ssh-tunnel 与凭据来源，不起真 SSH。
 *
 * 这里守的是【配置 → 隧道参数】这段翻译，最容易出错的正是它：
 * 私钥路径 vs 私钥内容、私钥密码 vs 数据库密码，混了报错还含糊。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SshTunnelManager,
  buildTunnelConfig,
  SshKeyReadError,
  tunnelEnabled,
  type TunnelManagerDeps,
} from './tunnel-manager.js';
import { defaultConnectionConfig, type ConnectionConfig } from '@dbstudio/core-connection';
import type { TunnelManager } from './session-registry.js';

let dir: string;
let keyPath: string;

function sshCfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const base = defaultConnectionConfig({
    id: 'ssh1',
    name: 'ssh',
    host: '10.0.0.5',
    port: 3306,
    user: 'root',
    passwordEnc: 'x',
  });
  return {
    ...base,
    ssh: {
      ...base.ssh,
      enabled: true,
      host: 'jump.example.com',
      port: 22,
      user: 'dbuser',
      authType: 'password',
      passwordEnc: 'ssh-pw',
      privateKeyPath: null,
      passphraseEnc: null,
    },
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbstudio-ssh-'));
  keyPath = join(dir, 'id_ed25519');
  writeFileSync(keyPath, 'PRIVATE-KEY-BODY', { mode: 0o600 });
});

function deps(over: Partial<TunnelManagerDeps> = {}): TunnelManagerDeps {
  return {
    credentials: async () => ({ password: 'secret', passphrase: null }),
    ...over,
  };
}

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
});

// ---------- 配置翻译 ----------

describe('连接配置 → 隧道配置', () => {
  it('密码认证：私钥留空，密码来自凭据源', async () => {
    const c = await buildTunnelConfig(sshCfg(), deps());
    expect(c.authType).toBe('password');
    expect(c.password).toBe('secret');
    expect(c.privateKey).toBeNull();
    expect(c.host).toBe('jump.example.com');
    expect(c.port).toBe(22);
    expect(c.user).toBe('dbuser');
  });

  it('🔴 私钥认证读的是【文件内容】不是路径', async () => {
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = keyPath;
    const c = await buildTunnelConfig(cfg, deps());
    expect(c.privateKey).toBe('PRIVATE-KEY-BODY');
    expect(c.privateKey).not.toBe(keyPath);
  });

  it('私钥认证时 passphrase 独立取（不复用数据库密码）', async () => {
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = keyPath;
    const c = await buildTunnelConfig(
      cfg,
      deps({ credentials: async () => ({ password: 'DB-PASSWORD', passphrase: 'KEY-PASS' }) }),
    );
    expect(c.passphrase).toBe('KEY-PASS');
    expect(c.password).toBeNull();
  });

  it('超时默认 10s（PRD §6.1.2）', async () => {
    expect((await buildTunnelConfig(sshCfg(), deps())).connectTimeoutMs).toBe(10_000);
    expect((await buildTunnelConfig(sshCfg(), deps({ timeoutMs: 3000 }))).connectTimeoutMs).toBe(3000);
  });

  it('🔴 私钥文件为空 → 明确报错（ssh2 只会说 Cannot parse privateKey）', async () => {
    const empty = join(dir, 'empty_key');
    writeFileSync(empty, '', { mode: 0o600 });
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = empty;
    await expect(buildTunnelConfig(cfg, deps())).rejects.toThrow(/为空/);
  });

  it('私钥认证但没选文件 → 报错', async () => {
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = null;
    await expect(buildTunnelConfig(cfg, deps())).rejects.toThrow(SshKeyReadError);
  });

  it('🔴 私钥权限过宽 → 拒绝并给出 chmod 命令（默认读文件器）', async () => {
    const loose = join(dir, 'loose_key');
    writeFileSync(loose, 'K', { mode: 0o644 });
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = loose;
    await expect(buildTunnelConfig(cfg, deps())).rejects.toThrow(/chmod 600/);
  });

  it('权限 0600 可用', async () => {
    const cfg = sshCfg();
    cfg.ssh.authType = 'privateKey';
    cfg.ssh.privateKeyPath = keyPath;
    const c = await buildTunnelConfig(cfg, deps());
    expect(c.privateKey).toBe('PRIVATE-KEY-BODY');
  });
});

// ---------- 管理器 ----------

describe('SshTunnelManager', () => {
  it('未开启 SSH → 返回 null（直连）', async () => {
    const m = new SshTunnelManager(deps());
    expect(await m.open(sshCfg({ ssh: { ...sshCfg().ssh, enabled: false } }), { host: 'h', port: 3306 })).toBeNull();
  });

  it('开启 SSH → 建隧道并返回 channel 工厂', async () => {
    const opened: { host: string; port: number }[] = [];
    const mod = {
      createClient: () => {
        const handlers = new Map<string, ((...a: any[]) => void)[]>();
        const client: any = {
          connect: () => setTimeout(() => (handlers.get('ready') ?? []).forEach((f) => f()), 0),
          on: (e: string, cb: any) => {
            const l = handlers.get(e) ?? [];
            l.push(cb);
            handlers.set(e, l);
            return client;
          },
          forwardOut: (_s: string, _sp: number, h: string, p: number, cb: any) => {
            opened.push({ host: h, port: p });
            setTimeout(() => cb(undefined, { on: () => undefined, end: () => undefined }), 0);
          },
          end: () => undefined,
        };
        return client;
      },
    };

    const m = new SshTunnelManager(deps());
    const r = await m.openWithModule(sshCfg(), { host: '10.0.0.5', port: 3306 }, async () => mod as any);
    expect(r).not.toBeNull();
    const s1 = await r!.streamFactory();
    const s2 = await r!.streamFactory();
    // 🔴 两条 channel 必须是不同对象（主连接 + KILL QUERY 管理连接）
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s2);
    // 目标地址必须是【数据库】地址，不是 SSH 自己的地址
    expect(opened).toEqual([
      { host: '10.0.0.5', port: 3306 },
      { host: '10.0.0.5', port: 3306 },
    ]);
  });

  it('🔴 建隧道失败时不留活隧道（此刻还没有驱动接管它）', async () => {
    let ended = 0;
    const mod = {
      createClient: () => {
        const handlers = new Map<string, ((...a: any[]) => void)[]>();
        const client: any = {
          connect: () => setTimeout(() => (handlers.get('error') ?? []).forEach((f) => f(new Error('auth failed'))), 0),
          on: (e: string, cb: any) => {
            const l = handlers.get(e) ?? [];
            l.push(cb);
            handlers.set(e, l);
            return client;
          },
          forwardOut: () => undefined,
          end: () => {
            ended++;
          },
        };
        return client;
      },
    };
    const m = new SshTunnelManager(deps());
    await expect(
      m.openWithModule(sshCfg(), { host: 'h', port: 3306 }, async () => mod as any),
    ).rejects.toThrow();
    expect(ended).toBeGreaterThan(0);
  });

  it('tunnelEnabled 判定开关', () => {
    expect(tunnelEnabled(sshCfg())).toBe(true);
    expect(tunnelEnabled(defaultConnectionConfig())).toBe(false);
  });

  it('满足 TunnelManager 契约（registry 只认这个接口）', () => {
    const m: TunnelManager = new SshTunnelManager(deps());
    expect(typeof m.open).toBe('function');
  });
});
