/**
 * 凭据存储（safeStorage）
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §1.3（替换已停止维护的 keytar）
 *
 * 关键设计：
 *  1. 【统一用异步 API】encryptStringAsync / decryptStringAsync
 *     原因：macOS 上访问钥匙串可能弹权限确认并【阻塞当前线程】，
 *     同步 API 会卡住主进程 —— 这直接违背「冷启动 ≤1.5s」与「不卡 UI」。
 *  2. 不可用（isEncryptionAvailable=false）时整连接进入「每次手动输密码、不落盘」模式
 *     （PRD §6.1.1 已定义该降级）
 *  3. 密文 base64 存进 connections.json 的 passwordEnc 字段
 *  4. 私钥 passphrase 同样走 safeStorage
 *
 * 本模块不直接 import electron —— 通过注入 safeStorage 实例，
 * 这样在测试环境与主进程外也能跑（也便于将来换实现）。
 */

/**
 * Electron 44 `decryptStringAsync()` 的解包结果。
 *
 * 🔴【真机实测抓到的破坏性变更】它**不返回 string**，返回的是对象：
 *     { shouldReEncrypt: boolean, result: string }
 *   - `shouldReEncrypt=true` 表示密钥已轮换或存在更安全的新密钥，
 *     官方文档要求【再调一次 decryptStringAsync】拿新密钥下的明文，
 *     并应当把密文重新加密落盘（否则老密文会一直用旧密钥）。
 *   - 早期版本（以及本项目最初的接口定义）签名是 `Promise<string>`。
 *     按旧签名写代码，会把整个对象当密码传给 mysql2，
 *     报 "The data argument must be of type string..." —— 且单测里的替身
 *     因为同样按旧签名实现，**测不出来**。只能靠真机 e2e 逮。
 *
 * 见 docs：https://electronjs.org/docs/api/safe-storage
 */
export interface AsyncDecryptResult {
  result: string;
  shouldReEncrypt: boolean;
}

/** 与 Electron safeStorage 兼容的最小接口（便于测试注入） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Electron 44 提供；旧版本可能没有，需探测 */
  encryptStringAsync?(plain: string): Promise<Buffer>;
  /**
   * ⚠️ 返回【对象】不是字符串。旧 Electron 返回 string，
   * 兼容两种形态由 `normalizeAsyncDecrypt()` 处理。
   */
  decryptStringAsync?(encrypted: Buffer): Promise<AsyncDecryptResult | string>;
  /** Electron 提供，用于判断是否可走异步路径 */
  isAsyncEncryptionAvailable?(): Promise<boolean> | boolean;
}

/**
 * 归一化异步解密结果 —— 同时吃「对象」与「字符串」两种形态。
 *
 * 为什么必须兼容字符串：Electron 各版本签名不一致（见 AsyncDecryptResult 注释），
 * 而密文可能是旧版本写的。硬要求对象形态会让跨版本升级时老密文全废。
 */
export function normalizeAsyncDecrypt(v: AsyncDecryptResult | string): AsyncDecryptResult {
  if (typeof v === 'string') return { result: v, shouldReEncrypt: false };
  if (v && typeof v === 'object' && typeof v.result === 'string') {
    return { result: v.result, shouldReEncrypt: v.shouldReEncrypt === true };
  }
  throw new Error(`safeStorage 异步解密返回了无法识别的形态：${JSON.stringify(v)?.slice(0, 80)}`);
}

export type SecretMode = 'async' | 'sync-fallback' | 'unavailable';

/**
 * 密钥轮换时最多重试解密几次。
 * 正常情况下一次重解就会拿到 shouldReEncrypt=false；
 * 设上限是防止异常实现（或病态密钥环）把调用方拖进死循环。
 */
export const MAX_REENCRYPT_RETRIES = 3;

export interface SecretStoreState {
  /** 当前生效模式 */
  mode: SecretMode;
  /** 加密是否可用（不可用 → 不落盘，每次手输） */
  available: boolean;
  /** 降级原因（设置页展示） */
  reason: string | null;
}

export class SecretStore {
  private readonly safeStorage: SafeStorageLike;
  private state: SecretStoreState = {
    mode: 'unavailable',
    available: false,
    reason: '尚未初始化',
  };

  constructor(safeStorage: SafeStorageLike) {
    this.safeStorage = safeStorage;
  }

  /**
   * 初始化探测。必须在 app.whenReady() 之后调用。
   * 注意：不要为了等它而阻塞窗口创建（PRD §7.2 明确要求）。
   */
  async init(): Promise<SecretStoreState> {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function') {
      this.state = { mode: 'unavailable', available: false, reason: 'safeStorage 不可用' };
      return this.state;
    }

    let available = false;
    try {
      available = this.safeStorage.isEncryptionAvailable();
    } catch {
      available = false;
    }

    if (!available) {
      this.state = {
        mode: 'unavailable',
        available: false,
        reason: '系统加密不可用（无钥匙串/无 Keychain 权限），密码将不落盘',
      };
      return this.state;
    }

    // 优先异步路径（避免阻塞主线程）
    const hasAsync =
      typeof this.safeStorage.encryptStringAsync === 'function' &&
      typeof this.safeStorage.decryptStringAsync === 'function';

    if (hasAsync) {
      this.state = { mode: 'async', available: true, reason: null };
    } else {
      this.state = {
        mode: 'sync-fallback',
        available: true,
        reason: '当前环境无 safeStorage 异步 API，回退同步（可能短暂阻塞）',
      };
    }
    return this.state;
  }

  getState(): SecretStoreState {
    return { ...this.state };
  }

  get available(): boolean {
    return this.state.available;
  }

  /** 是否可以落盘（不可用则必须每次手输） */
  get canPersist(): boolean {
    return this.state.available;
  }

  /** 加密为 base64 密文 */
  async encrypt(plainText: string): Promise<string> {
    this.assertAvailable();
    const buf =
      this.state.mode === 'async'
        ? await this.safeStorage.encryptStringAsync!(plainText)
        : this.safeStorage.encryptString(plainText);
    return Buffer.from(buf).toString('base64');
  }

  /**
   * 从 base64 密文解密。
   *
   * 走异步路径时按官方语义处理【密钥轮换】：
   * `shouldReEncrypt=true` → 再解一次拿新密钥下的明文。
   * 这一步不做的话，轮换后第一次取密码会拿到旧密钥解出的值（虽然内容相同），
   * 但更重要的是调用方**感知不到该重新落盘**，老密文将长期停留在被轮换掉的
   * 旧密钥上 —— 这违背「密钥轮换」的安全意图。
   */
  async decrypt(encryptedBase64: string): Promise<string> {
    this.assertAvailable();
    const buf = Buffer.from(encryptedBase64, 'base64');

    if (this.state.mode !== 'async' || !this.safeStorage.decryptStringAsync) {
      return this.safeStorage.decryptString(buf);
    }

    const first = normalizeAsyncDecrypt(await this.safeStorage.decryptStringAsync(buf));
    if (!first.shouldReEncrypt) return first.result;

    // 密钥已轮换：官方要求再解一次。加次数上限防止异常实现导致死循环。
    for (let i = 0; i < MAX_REENCRYPT_RETRIES; i++) {
      const next = normalizeAsyncDecrypt(await this.safeStorage.decryptStringAsync(buf));
      if (!next.shouldReEncrypt) {
        this.onReencryptNeeded?.(encryptedBase64, next.result);
        return next.result;
      }
    }
    // 极端情况：一直要重解。仍返回最后一次明文，但不再重试。
    return first.result;
  }

  /**
   * 密钥轮换回调：调用方应把明文【重新加密落盘】（用新密钥）。
   * 由上层（主进程）注入，本模块不持有存储职责。
   */
  onReencryptNeeded: ((oldCipherBase64: string, plain: string) => void) | null = null;

  /** 同步版本，仅在启动早期等无法 await 的极少数场景使用，且必须清楚会阻塞 */
  encryptSync(plainText: string): string {
    this.assertAvailable();
    return Buffer.from(this.safeStorage.encryptString(plainText)).toString('base64');
  }

  decryptSync(encryptedBase64: string): string {
    this.assertAvailable();
    return this.safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
  }

  private assertAvailable(): void {
    if (!this.state.available) {
      throw new Error(
        'safeStorage 不可用：不应尝试加解密，连接需走「每次手动输密码、不落盘」模式',
      );
    }
  }
}

// ---------- 连接配置的凭据读写 ----------

export interface ConnectionSecretFields {
  /** 加密后的密码（base64）。未设置或不可用时为 null */
  passwordEnc: string | null;
  /** 加密后的 SSH 私钥 passphrase（base64） */
  passphraseEnc: string | null;
  /** 是否每次手动输密码（PRD §6.1.1 降级模式） */
  promptEveryTime: boolean;
}

/**
 * 把明文凭据写入连接配置。
 * 若加密不可用 → 返回 promptEveryTime=true 且不落任何密文（绝不存明文）。
 */
export async function sealSecrets(
  store: SecretStore,
  opts: { password?: string | null; passphrase?: string | null },
): Promise<ConnectionSecretFields> {
  if (!store.canPersist) {
    // 红线：绝不明文落盘。不可用时强制每次手输。
    return { passwordEnc: null, passphraseEnc: null, promptEveryTime: true };
  }

  const passwordEnc = opts.password ? await store.encrypt(opts.password) : null;
  const passphraseEnc = opts.passphrase ? await store.encrypt(opts.passphrase) : null;

  return {
    passwordEnc,
    passphraseEnc,
    promptEveryTime: false,
  };
}

export async function openSecrets(
  store: SecretStore,
  fields: ConnectionSecretFields,
): Promise<{ password: string | null; passphrase: string | null }> {
  if (fields.promptEveryTime || !store.canPersist) {
    return { password: null, passphrase: null }; // 由 UI 弹窗索取
  }
  return {
    password: fields.passwordEnc ? await store.decrypt(fields.passwordEnc) : null,
    passphrase: fields.passphraseEnc ? await store.decrypt(fields.passphraseEnc) : null,
  };
}

/**
 * 校验连接配置文件里不含明文密码（PRD §八 工程验收项）。
 * 这是个静态自检：扫描已知字段名，若出现非 base64 的可疑明文则报警。
 */
export function scanForPlaintextSecrets(config: unknown): string[] {
  const found: string[] = [];
  const badKeys = /^(password|passwd|pwd|passphrase|secret|token|privatekey)$/i;

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (badKeys.test(k) && typeof v === 'string' && v.length > 0) {
          found.push(`${path}.${k}`);
        } else {
          walk(v, `${path}.${k}`);
        }
      }
    }
  };

  walk(config, '$');
  return found;
}
