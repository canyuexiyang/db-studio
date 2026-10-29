/**
 * P2-18j：连接配置导入/导出的纯逻辑测试。
 *
 * 这几条断言的价值都在"防事故"侧，不是防功能缺失：
 *  - 导出文件里**不许**出现任何密文字段（我把它命名为"泄密面"，这是唯一会
 *    把备份文件变成凭据文件的地方）；
 *  - 导入**不许**覆盖本地同名连接（覆盖会连带丢掉本地密码）；
 *  - 文件损坏要整体拒绝，不许"导入了一半"（批量操作少几条最难发现）。
 */

import { describe, it, expect } from 'vitest';
import {
  buildConnectionBundle,
  serializeConnectionBundle,
  parseConnectionBundle,
  planConnectionImport,
  uniqueConnectionName,
  CONNECTION_BUNDLE_FORMAT,
} from './connectionBundle.js';
import type { ConnectionConfig } from '@dbstudio/core-connection';

function cfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: '本地',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    passwordEnc: 'ZW5jcnlwdGVkLXNlY3JldA==',
    promptEveryTime: false,
    defaultDatabase: 'order_db',
    group: '开发/本地',
    colorTag: 'blue',
    note: '每日开发用',
    readOnly: false,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
    ssl: { enabled: false, caPath: null, certPath: null, keyPath: null, rejectUnauthorized: true },
    idleTimeoutMs: 120 * 60 * 1000,
    ...over,
  } as ConnectionConfig;
}

describe('导出（P2-18j）', () => {
  it('🔴 导出文本里不含密码密文（密文是机器绑定的，落进文件就是泄密面）', () => {
    const b = buildConnectionBundle([cfg()], 1000);
    const text = serializeConnectionBundle(b);
    expect(text).not.toContain('ZW5jcnlwdGVkLXNlY3JldA==');
    // 顶层连 `passwordEnc` 这个键都不该存在 —— 判"键"而不是判"值"，
    // 是因为有人可能把它写成 null 却仍留着字段语义（导入侧会误以为支持带密码）
    expect(b.connections[0]).not.toHaveProperty('passwordEnc');
  });

  it('🔴 也不含私钥路径与任何私钥口令字段', () => {
    const withKey = cfg({
      ssh: {
        enabled: true,
        host: 'jump.example.com',
        port: 22,
        user: 'deploy',
        authType: 'privateKey',
        passwordEnc: 'c2VjcmV0LXNzaA==',
        privateKeyPath: '/Users/me/.ssh/id_ed25519',
        passphraseEnc: 'c2VjcmV0LXBhc3M=',
      },
      ssl: {
        enabled: true,
        caPath: '/Users/me/ca.pem',
        certPath: '/Users/me/client.pem',
        keyPath: '/Users/me/client-key.pem',
        rejectUnauthorized: true,
      },
    } as Partial<ConnectionConfig>);
    const text = serializeConnectionBundle(buildConnectionBundle([withKey], 1000));
    // 私钥**路径**本身不是秘密（换机后路径也会变），但口径要清楚：
    // 这里连路径一起不带，避免导入后指向一个不存在的文件而"看起来配了"
    expect(text).not.toContain('id_ed25519');
    expect(text).not.toContain('c2VjcmV0LXBhc3M=');
    expect(text).not.toContain('c2VjcmV0LXNzaA==');
    // 🔴 嵌套子对象也要过白名单：ssl.keyPath 是私钥文件路径，同样不带
    expect(text).not.toContain('client-key.pem');
    expect(text).not.toContain('client.pem');
    expect(text).not.toContain('ca.pem');
  });

  it('嵌套配置保留"重建要填的骨架"（别把 SSH/SSL 开关也一起丢了）', () => {
    const c = buildConnectionBundle(
      [
        cfg({
          ssh: {
            enabled: true,
            host: 'jump.example.com',
            port: 2200,
            user: 'deploy',
            authType: 'privateKey',
            passwordEnc: 'x',
            privateKeyPath: '/Users/me/.ssh/id_ed25519',
            passphraseEnc: 'y',
          },
          ssl: { enabled: true, caPath: '/a', certPath: '/b', keyPath: '/c', rejectUnauthorized: false },
        } as Partial<ConnectionConfig>),
      ],
      1000,
    ).connections[0];
    expect(c.ssh).toEqual({
      enabled: true,
      host: 'jump.example.com',
      port: 2200,
      user: 'deploy',
      authType: 'privateKey',
      passwordEnc: null,
      privateKeyPath: null,
      passphraseEnc: null,
    });
    // 关闭证书校验是"不安全但有意为之"的口径，必须原样保留（否则导入后悄悄变严格）
    expect(c.ssl.rejectUnauthorized).toBe(false);
    expect(c.ssl.keyPath).toBeNull();
  });

  it('保留重建所需字段，且强制成"每次手输密码"', () => {
    const b = buildConnectionBundle([cfg({ passwordEnc: 'abc', promptEveryTime: false })], 1000);
    expect(b.format).toBe(CONNECTION_BUNDLE_FORMAT);
    expect(b.count).toBe(1);
    const c = b.connections[0];
    expect(c.name).toBe('本地');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3306);
    expect(c.user).toBe('root');
    expect(c.defaultDatabase).toBe('order_db');
    expect(c.group).toBe('开发/本地');
    expect(c.colorTag).toBe('blue');
    expect(c.note).toBe('每日开发用');
    expect(c.idleTimeoutMs).toBe(120 * 60 * 1000);
    // 🔴 没有密文可带 → 必须要求重输，否则导入后"以为有密码"却连不上
    expect(c.promptEveryTime).toBe(true);
  });

  it('空列表也能导出（备份一个空环境是合法动作）', () => {
    const b = buildConnectionBundle([], 1000);
    expect(b.connections).toEqual([]);
    expect(b.count).toBe(0);
    expect(parseConnectionBundle(serializeConnectionBundle(b)).ok).toBe(true);
  });
});

describe('解析（P2-18j）', () => {
  const good = () => serializeConnectionBundle(buildConnectionBundle([cfg()], 1000));

  it('往返：导出 → 解析 → 字段一致（不含密文）', () => {
    const r = parseConnectionBundle(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.connections).toHaveLength(1);
    expect(r.bundle.connections[0].name).toBe('本地');
  });

  it('非法 JSON / 别家格式 / 更高版本 / 缺数组 都要给中文原因', () => {
    expect(parseConnectionBundle('{oops')).toEqual({ ok: false, reason: expect.stringContaining('JSON') });
    expect(parseConnectionBundle('[]')).toEqual({ ok: false, reason: expect.stringContaining('顶层') });
    expect(parseConnectionBundle('{"format":"other","version":1,"connections":[]}').ok).toBe(false);
    const higher = parseConnectionBundle(
      JSON.stringify({ format: CONNECTION_BUNDLE_FORMAT, version: 99, connections: [] }),
    );
    expect(higher.ok).toBe(false);
    if (!higher.ok) expect(higher.reason).toContain('版本');
    const noList = parseConnectionBundle(
      JSON.stringify({ format: CONNECTION_BUNDLE_FORMAT, version: 1 }),
    );
    expect(noList.ok).toBe(false);
  });

  it('🔴 有一条不合法就整体拒绝（不许"导入了一半"）', () => {
    const bad = JSON.stringify({
      format: CONNECTION_BUNDLE_FORMAT,
      version: 1,
      connections: [
        { name: '好的', host: 'h', user: 'u', port: 3306 },
        { name: '坏的', host: 'h' }, // 缺 user / port
      ],
    });
    const r = parseConnectionBundle(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('第 2 条');
  });
});

describe('导入计划（P2-18j）', () => {
  it('🔴 同名不覆盖：本地那条保持原样，导入的那条自动改名', () => {
    const local = [cfg({ id: 'local-1', name: '本地', passwordEnc: 'keep-me' })];
    const bundle = buildConnectionBundle([cfg({ name: '本地' })], 1000);
    const plan = planConnectionImport(bundle, local);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0].name).toBe('本地 (2)');
    expect(plan.renamed).toEqual([{ from: '本地', to: '本地 (2)' }]);
    // 本地那条完全没被改（覆盖会连带丢掉它的密码）
    expect(local[0].passwordEnc).toBe('keep-me');
    expect(local[0].name).toBe('本地');
  });

  it('新建项 id 为空串（主进程按 id 有无决定 create/update）', () => {
    const plan = planConnectionImport(buildConnectionBundle([cfg()], 1000), []);
    expect(plan.toCreate[0].id).toBe('');
  });

  it('🔴 导入后必须重输密码（passwordEnc=null 且 promptEveryTime=true）', () => {
    // 即使文件被手工改出 passwordEnc，也不许带进内存模型
    const bundle = buildConnectionBundle([cfg()], 1000);
    (bundle.connections[0] as unknown as Record<string, unknown>).passwordEnc = 'sneaky';
    const plan = planConnectionImport(bundle, []);
    expect(plan.toCreate[0].passwordEnc).toBeNull();
    expect(plan.toCreate[0].promptEveryTime).toBe(true);
  });

  it('同一文件里的重名依次递增（不会导入出两条同名）', () => {
    const bundle = buildConnectionBundle([cfg({ name: 'A' }), cfg({ name: 'A' })], 1000);
    const plan = planConnectionImport(bundle, []);
    expect(plan.toCreate.map((c) => c.name)).toEqual(['A', 'A (2)']);
    expect(plan.renamed).toEqual([{ from: 'A', to: 'A (2)' }]);
  });

  it('名字大小写不同视为重名（MySQL 侧连接名不做大小写区分更安全）', () => {
    const plan = planConnectionImport(buildConnectionBundle([cfg({ name: 'prod' })], 1000), [cfg({ name: 'PROD' })]);
    expect(plan.toCreate[0].name).toBe('prod (2)');
  });

  it('uniqueConnectionName 遇到一串占用时取最小可用后缀', () => {
    expect(uniqueConnectionName('X', [])).toBe('X');
    expect(uniqueConnectionName('X', ['X'])).toBe('X (2)');
    expect(uniqueConnectionName('X', ['X', 'X (2)'])).toBe('X (3)');
    // 名字中间的空格不该影响判重
    expect(uniqueConnectionName('  X  ', ['x'])).toBe('X (2)');
  });
});
