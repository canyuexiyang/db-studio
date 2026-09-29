import { describe, it, expect } from 'vitest';
import {
  SecretStore,
  sealSecrets,
  openSecrets,
  scanForPlaintextSecrets,
  normalizeAsyncDecrypt,
  MAX_REENCRYPT_RETRIES,
  type SafeStorageLike,
} from './index.js';

/**
 * 模拟 safeStorage：用简单的可逆变换代替真实加密，
 * 重点验证本模块的【异步优先 / 不可用降级 / 绝不落明文】行为。
 */
class FakeSafeStorage implements SafeStorageLike {
  constructor(
    private opts: { available?: boolean; hasAsync?: boolean; asyncDelayMs?: number } = {},
  ) {}

  isEncryptionAvailable(): boolean {
    return this.opts.available ?? true;
  }

  encryptString(plain: string): Buffer {
    return Buffer.from('SYNC:' + plain, 'utf8');
  }

  decryptString(enc: Buffer): string {
    const s = enc.toString('utf8');
    if (!s.startsWith('SYNC:')) throw new Error('not a sync payload');
    return s.slice(5);
  }
}

/**
 * 🔴 这个替身【必须复刻 Electron 44 的真实返回形态】—— 返回对象，不是字符串。
 *
 * 教训：最初它被写成 `Promise<string>`，跟 index.ts 里的错误签名一模一样，
 * 于是 197 行单测全绿、真机一跑就崩（密码被当成对象传给 mysql2）。
 * **替身照着被测代码的错误理解来实现，测试就失去了意义。**
 * 凡是"替身实现得跟被测代码一样乐观"的地方，都要怀疑它是否在互相掩护。
 */
class AsyncFakeSafeStorage extends FakeSafeStorage {
  /** 模拟 Electron 早期版本：异步解密直接返回字符串 */
  legacyStringReturn = false;
  /** 模拟密钥轮换：前 N 次返回 shouldReEncrypt=true */
  reencryptTimes = 0;
  /** 解密调用次数（断言用） */
  decryptCalls = 0;
  /** 轮换回调收到的数据 */
  static lastReencrypt: { cipher: string; plain: string } | null = null;

  private opts0(): any {
    return (this as any).opts ?? {};
  }

  async encryptStringAsync(plain: string): Promise<Buffer> {
    await new Promise((r) => setTimeout(r, this.opts0().asyncDelayMs ?? 1));
    return Buffer.from('ASYNC:' + plain, 'utf8');
  }

  async decryptStringAsync(enc: Buffer): Promise<{ result: string; shouldReEncrypt: boolean } | string> {
    await new Promise((r) => setTimeout(r, this.opts0().asyncDelayMs ?? 1));
    const s = enc.toString('utf8');
    if (!s.startsWith('ASYNC:')) throw new Error('not an async payload');
    const plain = s.slice(6);

    this.decryptCalls++;
    if (this.legacyStringReturn) return plain;

    const shouldReEncrypt = this.decryptCalls <= this.reencryptTimes;
    return { result: plain, shouldReEncrypt };
  }
}

describe('SecretStore — 模式探测', () => {
  it('有异步 API 时走 async 模式', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true }));
    const st = await s.init();
    expect(st.mode).toBe('async');
    expect(st.available).toBe(true);
    expect(st.reason).toBeNull();
  });

  it('无异步 API 时回退 sync-fallback 并给出原因', async () => {
    const s = new SecretStore(new FakeSafeStorage({ available: true }));
    const st = await s.init();
    expect(st.mode).toBe('sync-fallback');
    expect(st.available).toBe(true);
    expect(st.reason).toContain('异步');
  });

  it('加密不可用时进入 unavailable（密码不落盘）', async () => {
    const s = new SecretStore(new FakeSafeStorage({ available: false }));
    const st = await s.init();
    expect(st.mode).toBe('unavailable');
    expect(st.available).toBe(false);
    expect(s.canPersist).toBe(false); // canPersist 是 store 上的 getter
    expect(st.reason).toContain('不落盘');
  });

  it('safeStorage 缺失时不抛异常', async () => {
    const s = new SecretStore(null as any);
    const st = await s.init();
    expect(st.available).toBe(false);
  });

  it('isEncryptionAvailable 抛异常时降级为不可用', async () => {
    const bad = {
      isEncryptionAvailable() { throw new Error('boom'); },
      encryptString() { return Buffer.from(''); },
      decryptString() { return ''; },
    };
    const s = new SecretStore(bad as any);
    const st = await s.init();
    expect(st.available).toBe(false);
  });
});

describe('SecretStore — 加解密', () => {
  it('异步模式往返正确', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 1 }));
    await s.init();
    const enc = await s.encrypt('p@ssw0rd');
    expect(enc).not.toContain('p@ssw0rd'); // 密文不含明文
    expect(await s.decrypt(enc)).toBe('p@ssw0rd');
  });

  it('同步回退模式往返正确', async () => {
    const s = new SecretStore(new FakeSafeStorage({ available: true }));
    await s.init();
    const enc = await s.encrypt('secret');
    expect(await s.decrypt(enc)).toBe('secret');
  });

  it('特殊字符与 Unicode 往返无损', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 }));
    await s.init();
    for (const pw of ['p@ss; DROP TABLE t; --', '密码🔐', '', 'a'.repeat(500), "quo'te\""]) {
      const enc = await s.encrypt(pw);
      expect(await s.decrypt(enc)).toBe(pw);
    }
  });

  it('不可用时加解密抛异常（强制走手输模式）', async () => {
    const s = new SecretStore(new FakeSafeStorage({ available: false }));
    await s.init();
    await expect(s.encrypt('x')).rejects.toThrow(/不落盘|不可用/);
  });
});

/**
 * 🔴 Electron 44 破坏性变更专项
 *
 * decryptStringAsync() 返回的是 `{ result, shouldReEncrypt }` 对象，不是字符串。
 * 这一组测试**必须**用复刻真实形态的替身来跑 —— 用旧签名的替身会跟
 * 被测代码一起错，全绿但掩盖真 bug（本项目曾经就是这样漏过去的）。
 */
describe('SecretStore — Electron 44 异步解密返回对象', () => {
  it('🔴 异步解密返回对象时仍能取出明文（不把对象当密码）', async () => {
    const fake = new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 });
    const s = new SecretStore(fake);
    await s.init();
    const enc = await s.encrypt('db_p@ss');

    const plain = await s.decrypt(enc);
    // 关键断言：必须是字符串。若回退成旧实现，这里会是 '[object Object]'
    expect(typeof plain).toBe('string');
    expect(plain).toBe('db_p@ss');
  });

  it('兼容旧版本：异步解密返回裸字符串也能工作', async () => {
    const fake = new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 });
    fake.legacyStringReturn = true;
    const s = new SecretStore(fake);
    await s.init();
    const enc = await s.encrypt('old-electron');
    expect(await s.decrypt(enc)).toBe('old-electron');
  });

  it('🔴 shouldReEncrypt=true 时【再解一次】并通知上层重新落盘', async () => {
    const fake = new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 });
    fake.reencryptTimes = 1; // 第一次说要轮换，第二次不再要
    const s = new SecretStore(fake);
    await s.init();
    const enc = await s.encrypt('rotate-me');

    let notified: { cipher: string; plain: string } | null = null;
    s.onReencryptNeeded = (cipher, plain) => { notified = { cipher, plain }; };

    expect(await s.decrypt(enc)).toBe('rotate-me');
    expect(fake.decryptCalls).toBe(2); // 第一次要轮换 → 必须再解一次
    expect(notified).not.toBeNull();
    expect(notified!.plain).toBe('rotate-me');
    expect(notified!.cipher).toBe(enc);
  });

  it('连续要求重解时不会死循环（有重试上限）', async () => {
    const fake = new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 });
    fake.reencryptTimes = 999; // 病态实现：一直要求重解
    const s = new SecretStore(fake);
    await s.init();
    const enc = await s.encrypt('loop');

    expect(await s.decrypt(enc)).toBe('loop');
    expect(fake.decryptCalls).toBeLessThanOrEqual(MAX_REENCRYPT_RETRIES + 1);
  });

  it('归一化函数：字符串 → 对象；非法形态 → 抛错', () => {
    expect(normalizeAsyncDecrypt('abc')).toEqual({ result: 'abc', shouldReEncrypt: false });
    expect(normalizeAsyncDecrypt({ result: 'abc', shouldReEncrypt: true })).toEqual({
      result: 'abc',
      shouldReEncrypt: true,
    });
    expect(normalizeAsyncDecrypt({ result: 'abc' } as any).shouldReEncrypt).toBe(false);
    expect(() => normalizeAsyncDecrypt({ nope: 1 } as any)).toThrow(/无法识别/);
    expect(() => normalizeAsyncDecrypt(42 as any)).toThrow(/无法识别/);
  });
});

describe('sealSecrets / openSecrets', () => {
  it('可用时落密文，promptEveryTime=false', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 }));
    await s.init();
    const fields = await sealSecrets(s, { password: 'pw', passphrase: 'pp' });
    expect(fields.passwordEnc).not.toBeNull();
    expect(fields.passwordEnc).not.toContain('pw');
    expect(fields.promptEveryTime).toBe(false);

    const opened = await openSecrets(s, fields);
    expect(opened.password).toBe('pw');
    expect(opened.passphrase).toBe('pp');
  });

  it('不可用时【绝不明文落盘】，强制 promptEveryTime', async () => {
    const s = new SecretStore(new FakeSafeStorage({ available: false }));
    await s.init();
    const fields = await sealSecrets(s, { password: 'super-secret' });
    expect(fields.passwordEnc).toBeNull();
    expect(fields.passphraseEnc).toBeNull();
    expect(fields.promptEveryTime).toBe(true);
    // 序列化后不得出现明文
    expect(JSON.stringify(fields)).not.toContain('super-secret');
  });

  it('promptEveryTime 的连接解密时返回 null（由 UI 索取）', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 }));
    await s.init();
    const enc = await s.encrypt('pw');
    const opened = await openSecrets(s, { passwordEnc: enc, passphraseEnc: null, promptEveryTime: true });
    expect(opened.password).toBeNull();
  });

  it('无密码字段时返回 null 而非报错', async () => {
    const s = new SecretStore(new AsyncFakeSafeStorage({ available: true, asyncDelayMs: 0 }));
    await s.init();
    const opened = await openSecrets(s, { passwordEnc: null, passphraseEnc: null, promptEveryTime: false });
    expect(opened.password).toBeNull();
    expect(opened.passphrase).toBeNull();
  });
});

describe('scanForPlaintextSecrets（PRD 工程验收项）', () => {
  it('干净配置无告警', () => {
    const cfg = {
      connections: [
        { id: '1', name: 'local', passwordEnc: 'ASDF==', passphraseEnc: null, promptEveryTime: false },
      ],
    };
    expect(scanForPlaintextSecrets(cfg)).toEqual([]);
  });

  it('检出明文 password 字段', () => {
    const cfg = { connections: [{ id: '1', password: 'plaintext-pw' }] };
    expect(scanForPlaintextSecrets(cfg)).toEqual(['$.connections[0].password']);
  });

  it('检出嵌套的明文 secret / token / privateKey', () => {
    const cfg = {
      a: { ssh: { privateKey: '-----BEGIN ...' } },
      b: { auth: { token: 'abc' } },
      c: { deep: { nested: { secret: 'x' } } },
    };
    const hits = scanForPlaintextSecrets(cfg);
    expect(hits).toContain('$.a.ssh.privateKey');
    expect(hits).toContain('$.b.auth.token');
    expect(hits).toContain('$.c.deep.nested.secret');
  });

  it('字段名为 Enc 结尾不算明文', () => {
    const cfg = { passwordEnc: 'base64stuff', passphraseEnc: 'base64stuff' };
    expect(scanForPlaintextSecrets(cfg)).toEqual([]);
  });
});
