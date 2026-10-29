/**
 * 连接持久化测试 —— 重点是两条红线：
 *  1. **绝不明文落盘密码**
 *  2. safeStorage 不可用时 → 强制每次手输，且不落任何密文
 *
 * 用真的临时目录读写磁盘（不是 mock fs），因为"文件里到底写了什么"
 * 才是这个模块存在的意义 —— mock 掉 fs 就测不到真正的泄漏。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionStore, PlaintextSecretError } from './connection-store.js';
import { SecretStore, type SafeStorageLike } from '@dbstudio/core-secret';
import { defaultConnectionConfig, type ConnectionConfig } from '@dbstudio/core-connection';

/**
 * 可逆的假加密：加个盐前缀，够验证「磁盘上没有原文」。
 *
 * 注意：SecretStore 会对 encryptString 的返回值再做一次 base64，
 * 所以最终 passwordEnc 是合法 base64 —— 正好也满足 core-connection 的
 * `looksLikePlaintextLeak()` 检查（非 base64 会被判为明文误存）。
 *
 * 🔴 盐是可变的（`bumpKey()`）：真实 safeStorage 在密钥轮换后，
 * 同一明文会产出【不同】密文。早期版本用固定盐时，
 * 「轮换后密文变了」这件事根本测不出来 —— 密文替换的断言会静默退化成恒等。
 */
class FakeSafeStorage implements SafeStorageLike {
  private keyVersion = 1;
  constructor(private readonly available = true) {}
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  /** 模拟密钥轮换：之后加密出的密文会带新版本号 */
  bumpKey(): void {
    this.keyVersion++;
  }
  encryptString(plain: string): Buffer {
    return Buffer.from(`s4lt:v${this.keyVersion}:${plain}`, 'utf8');
  }
  decryptString(enc: Buffer): string {
    return Buffer.from(enc).toString('utf8').replace(/^s4lt:v\d+:/, '');
  }
  async encryptStringAsync(plain: string): Promise<Buffer> {
    return this.encryptString(plain);
  }
  async decryptStringAsync(enc: Buffer): Promise<string> {
    return this.decryptString(enc);
  }
}

function unavailableStorage(): SafeStorageLike {
  return new FakeSafeStorage(false);
}

let dir: string;
let store: ConnectionStore;
let secrets: SecretStore;

function rawFile(): string {
  return readFileSync(join(dir, 'connections.json'), 'utf8');
}

function baseCfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return defaultConnectionConfig({
    id: 'c1',
    name: 'prod',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    ...over,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dbstudio-conn-'));
  secrets = new SecretStore(new FakeSafeStorage());
  await secrets.init();
  store = new ConnectionStore(dir, secrets);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('连接配置持久化', () => {
  it('新目录没有连接，不该报错也不该造文件', () => {
    expect(store.listConnections()).toEqual([]);
    expect(existsSync(join(dir, 'connections.json'))).toBe(false);
  });

  it('保存后密码以密文落盘，磁盘上搜不到明文', async () => {
    await store.save({
      config: baseCfg(),
      password: 'super_secret_pwd',
    });
    const raw = rawFile();
    expect(raw).not.toContain('super_secret_pwd');
    // 落盘的是密文：① 不含原文 ② 是合法 base64 ③ 能解回原文。
    // ⚠️ 不要断言密文的【字面值】—— 那会把测试钉死在替身的实现细节上，
    //    密钥轮换一改盐格式就全红，而产品行为其实完全正确。
    const enc = store.get('c1')?.passwordEnc ?? '';
    expect(enc).not.toContain('super_secret_pwd');
    expect(() => Buffer.from(enc, 'base64').toString('base64')).not.toThrow();
    expect(Buffer.from(enc, 'base64').toString('utf8')).toContain('super_secret_pwd');
    expect(await store.passwordFor('c1')).toBe('super_secret_pwd');
  });

  it('能取回明文密码用于建连', async () => {
    await store.save({ config: baseCfg(), password: 'p@ss' });
    expect(await store.passwordFor('c1')).toBe('p@ss');
  });

  it('promptEveryTime 连接不落任何密文，取密码返回 null', async () => {
    await store.save({ config: baseCfg(), password: 'x', promptEveryTime: true });
    expect(store.get('c1')?.passwordEnc).toBeNull();
    expect(store.get('c1')?.promptEveryTime).toBe(true);
    expect(rawFile()).not.toContain('ENC:x');
    expect(await store.passwordFor('c1')).toBeNull();
  });

  it('🔴 safeStorage 不可用时：不落密文且强制每次手输（绝不明文兜底）', async () => {
    const s = new SecretStore(unavailableStorage());
    await s.init();
    const st = new ConnectionStore(dir, s);
    const saved = await st.save({ config: baseCfg(), password: 'plaintext_risk' });

    expect(saved.passwordEnc).toBeNull();
    expect(saved.promptEveryTime).toBe(true);
    // 磁盘上既不该有明文，也不该有密文
    expect(rawFile()).not.toContain('plaintext_risk');
    expect(rawFile()).not.toContain('s4lt');
  });

  it('更新时未传密码 → 保留原密文（不该把密码悄悄清空）', async () => {
    await store.save({ config: baseCfg(), password: 'keep_me' });
    await store.save({ config: baseCfg({ name: 'prod-renamed' }) });
    expect(store.get('c1')?.name).toBe('prod-renamed');
    expect(await store.passwordFor('c1')).toBe('keep_me');
  });

  it('配置校验不通过时拒绝保存（如主机名为空）', async () => {
    await expect(store.save({ config: baseCfg({ host: '' }) })).rejects.toThrow(/校验未通过/);
  });

  it('删除连接', async () => {
    await store.save({ config: baseCfg(), password: 'x' });
    expect(store.remove('c1')).toBe(true);
    expect(store.remove('c1')).toBe(false);
    expect(store.get('c1')).toBeNull();
  });

  it('auditPlaintext 自检：正常保存后无告警', async () => {
    await store.save({ config: baseCfg(), password: 'abc' });
    expect(store.auditPlaintext()).toEqual([]);
  });

  it('🔴 强行塞入明文密码字段 → 落盘时抛错，文件不被污染', async () => {
    // 直接绕过 save() 往内存列表里塞一条带明文 password 的记录，
    // 模拟"有人在别处引入了未加密字段"的事故场景
    const cfg = baseCfg() as any;
    cfg.password = 'leaked_plain';
    (store as any).list = [cfg];

    expect(() => (store as any).writeToDisk()).toThrow(PlaintextSecretError);
    expect(existsSync(join(dir, 'connections.json'))).toBe(false);
  });

  it('配置文件损坏时当作空列表，不让应用起不来', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(dir, 'connections.json'), '{ 这不是合法 JSON', 'utf8');
    const s = new ConnectionStore(dir, secrets);
    expect(s.listConnections()).toEqual([]);
  });

  it('版本不兼容的旧文件当作空列表，不做猜测性迁移', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(
      join(dir, 'connections.json'),
      JSON.stringify({ version: 999, connections: [{ id: 'old' }] }),
      'utf8',
    );
    const s = new ConnectionStore(dir, secrets);
    expect(s.listConnections()).toEqual([]);
  });

  it('重新打开目录能读回连接（持久化真的生效）', async () => {
    await store.save({ config: baseCfg(), password: 'persisted' });
    const reopened = new ConnectionStore(dir, secrets);
    expect(reopened.get('c1')?.name).toBe('prod');
    expect(await reopened.passwordFor('c1')).toBe('persisted');
  });

  // ---------- 密钥轮换（Electron 44 safeStorage 语义）----------

  it('🔴 密钥轮换后：密文真的变了，替换后仍能解出同一明文', async () => {
    const saved = await store.save({ config: baseCfg(), password: 'rotate-pw' });
    const oldCipher = saved.passwordEnc!;

    // 密钥轮换：同一明文产出不同密文 —— 真实 safeStorage 就是这个行为
    (secrets as any).safeStorage.bumpKey();
    const newCipher = await secrets.encrypt('rotate-pw');
    expect(newCipher).not.toBe(oldCipher); // 否则这条测试恒等，等于没测

    const hits = await store.replaceCipher(oldCipher, newCipher);

    expect(hits).toBe(1);
    expect(store.get('c1')?.passwordEnc).toBe(newCipher);
    expect(await store.passwordFor('c1')).toBe('rotate-pw');
    // 明文始终没进过磁盘
    expect(rawFile()).not.toContain('rotate-pw');
  });

  it('同一密文出现在 SSH passphrase 上时也一并替换', async () => {
    const cfg = baseCfg() as any;
    cfg.ssh = { ...cfg.ssh, passphraseEnc: 'SHARED-CIPHER' };
    (store as any).list = [{ ...cfg, passwordEnc: 'SHARED-CIPHER' }];

    const hits = await store.replaceCipher('SHARED-CIPHER', 'NEW-CIPHER');
    expect(hits).toBe(2);
    expect(store.get('c1')?.passwordEnc).toBe('NEW-CIPHER');
    expect(store.get('c1')?.ssh?.passphraseEnc).toBe('NEW-CIPHER');
  });

  it('密文相同 / 空值 → 不写盘、返回 0（幂等且不做无谓 IO）', async () => {
    const saved = await store.save({ config: baseCfg(), password: 'x' });
    expect(await store.replaceCipher(saved.passwordEnc!, saved.passwordEnc!)).toBe(0);
    expect(await store.replaceCipher('', 'NEW')).toBe(0);
    expect(await store.replaceCipher('OLD', '')).toBe(0);
  });

  it('没有命中任何连接时返回 0 且不抛异常', async () => {
    await store.save({ config: baseCfg(), password: 'x' });
    expect(await store.replaceCipher('NOT-EXISTING-CIPHER', 'NEW')).toBe(0);
    expect(store.get('c1')?.passwordEnc).toBeTruthy();
  });
});

/**
 * P1-8 创建副本。
 *
 * 这一组的核心不是"能存下第二条连接"，而是**密文的来路**：渲染层拿到的
 * `passwordEnc` 只是 '' 占位符，副本想沿用密码只能由主进程按字节复制。
 * 复制错了（复制成 '' / 复制成别的连接的密文）都不会报错，
 * 只会得到一条"看着正常、一连就 Access denied"的连接 —— 只能用测试钉住。
 */
describe('创建副本（copySecretsFrom）', () => {
  it('副本沿用源连接已存密码，且源连接的密码不受影响', async () => {
    await store.save({ config: baseCfg(), password: 'p@ss' });
    const dup = await store.save({
      config: baseCfg({ id: 'c2', name: 'prod 副本' }),
      copySecretsFrom: 'c1',
    });

    expect(await store.passwordFor('c2')).toBe('p@ss');
    expect(await store.passwordFor('c1')).toBe('p@ss');
    // 拿到的必须是**真密文**，不是空串占位符（空串会让这条连接永远连不上）
    expect(dup.passwordEnc).toBeTruthy();
    expect(dup.passwordEnc).not.toBe('');
  });

  it('副本不覆盖源连接：两条都在，名字各自独立', async () => {
    await store.save({ config: baseCfg(), password: 'pw' });
    await store.save({ config: baseCfg({ id: 'c2', name: 'prod 副本' }), copySecretsFrom: 'c1' });

    expect(store.listConnections().map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(store.get('c1')?.name).toBe('prod');
    expect(store.get('c2')?.name).toBe('prod 副本');
  });

  it('副本给了新密码 → 用新密码，源连接不动', async () => {
    await store.save({ config: baseCfg(), password: 'old' });
    await store.save({
      config: baseCfg({ id: 'c2', name: 'prod 副本' }),
      password: 'brand-new',
      copySecretsFrom: 'c1',
    });

    expect(await store.passwordFor('c2')).toBe('brand-new');
    expect(await store.passwordFor('c1')).toBe('old');
  });

  it('源连接是「每次手输」→ 副本也手输，且不落任何密文', async () => {
    await store.save({ config: baseCfg(), password: 'x', promptEveryTime: true });
    const dup = await store.save({
      config: baseCfg({ id: 'c2', name: 'prod 副本', promptEveryTime: true }),
      copySecretsFrom: 'c1',
      promptEveryTime: true,
    });

    expect(dup.passwordEnc).toBeNull();
    expect(dup.promptEveryTime).toBe(true);
    expect(await store.passwordFor('c2')).toBeNull();
  });

  it('🔴 源连接不存在 → 显式报错，不静默产出没密码的连接', async () => {
    await expect(
      store.save({ config: baseCfg({ id: 'c2' }), copySecretsFrom: 'ghost' }),
    ).rejects.toThrow(/源连接不存在/);
    expect(store.get('c2')).toBeNull();
    // 报错不该把列表写坏
    expect(store.listConnections()).toEqual([]);
  });

  it('🔴 更新既有连接时忽略 copySecretsFrom（不能悄悄换掉密码来路）', async () => {
    await store.save({ config: baseCfg(), password: 'mine' });
    await store.save({ config: baseCfg({ id: 'c2', name: 'other' }), password: 'theirs' });

    await store.save({ config: baseCfg({ name: 'renamed' }), copySecretsFrom: 'c2' });

    expect(await store.passwordFor('c1')).toBe('mine');
  });

  it('副本的密文同样不落明文', async () => {
    await store.save({ config: baseCfg(), password: 'dup_secret_plain' });
    await store.save({ config: baseCfg({ id: 'c2', name: 'prod 副本' }), copySecretsFrom: 'c1' });

    expect(rawFile()).not.toContain('dup_secret_plain');
    expect(store.auditPlaintext()).toEqual([]);
  });
});
