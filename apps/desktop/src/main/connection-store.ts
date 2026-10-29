/**
 * 连接配置持久化 —— 落盘到 userData/connections.json
 *
 * 红线（PRD §11 / 评审工程验收项）：
 *  1. **绝不明文落盘密码**。密码一律经 safeStorage 加密成 base64 存 `passwordEnc`。
 *  2. safeStorage 不可用时 → 强制 `promptEveryTime=true` 且不落任何密文。
 *  3. 落盘前用 `scanForPlaintextSecrets()` 自检，扫到可疑明文就拒绝写入。
 *     这是防御性设计：宁可拒绝保存，也不能把密码写进用户磁盘。
 *
 * 这个文件刻意**不 import electron** —— safeStorage 通过参数注入，
 * 于是它可以在单测里用替身驱动，不必起 Electron 进程。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  defaultConnectionConfig,
  validateConnectionConfig,
  hasBlockingError,
  type ConnectionConfig,
  type DbType,
} from '@dbstudio/core-connection';
import {
  SecretStore,
  sealSecrets,
  openSecrets,
  scanForPlaintextSecrets,
  type ConnectionSecretFields,
} from '@dbstudio/core-secret';

export const CONNECTIONS_FILE = 'connections.json';
export const CONNECTIONS_VERSION = 1;

export interface ConnectionsFile {
  version: number;
  connections: ConnectionConfig[];
}

/** 保存连接时的入参：明文密码只在内存里出现一次，绝不进磁盘 */
export interface SaveConnectionInput {
  config: Omit<ConnectionConfig, 'passwordEnc' | 'promptEveryTime'> & {
    passwordEnc?: string | null;
    promptEveryTime?: boolean;
  };
  /** 明文密码。不传表示保留原有密文不动 */
  password?: string | null;
  /** 明文 SSH passphrase。不传表示保留原密文 */
  passphrase?: string | null;
  /** 显式要求"每次手输" */
  promptEveryTime?: boolean;
  /**
   * 创建副本：源连接 id。新建连接时把源连接的密文**按字节复制**过来。
   *
   * 为什么需要这个字段：密文只在主进程里，渲染层的 `passwordEnc` 是 '' 占位符，
   * 无法把"原连接存过的密码"带进新连接。没有它，副本只能是条没密码的连接
   * （校验会直接拒绝），用户被迫重输一遍谁都记不住的密码。
   */
  copySecretsFrom?: string | null;
}

export class PlaintextSecretError extends Error {
  constructor(readonly fields: string[]) {
    super(`拒绝保存：检测到疑似明文密码字段 ${fields.join(', ')}。密码必须经 safeStorage 加密，绝不明文落盘。`);
    this.name = 'PlaintextSecretError';
  }
}

export class ConnectionStore {
  private readonly file: string;
  private list: ConnectionConfig[] = [];

  constructor(
    userDataDir: string,
    private readonly secrets: SecretStore,
  ) {
    this.file = join(userDataDir, CONNECTIONS_FILE);
    mkdirSync(dirname(this.file), { recursive: true });
    this.list = this.readFromDisk();
  }

  // ---------- 读 ----------

  private readFromDisk(): ConnectionConfig[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as ConnectionsFile;
      if (raw.version !== CONNECTIONS_VERSION) return []; // 版本不兼容 → 当作空，不猜
      if (!Array.isArray(raw.connections)) return [];
      return raw.connections.map((c) => normalizeConfig(c));
    } catch {
      // 文件损坏：不要让应用起不来，当作没有连接
      return [];
    }
  }

  listConnections(): ConnectionConfig[] {
    return this.list.map((c) => ({ ...c }));
  }

  get(id: string): ConnectionConfig | null {
    const hit = this.list.find((c) => c.id === id);
    return hit ? { ...hit } : null;
  }

  // ---------- 写 ----------

  /**
   * 原子写：先写临时文件再 rename。
   * 防止写到一半崩溃导致连接配置全丢 —— 对自用工具来说这是最疼的事故。
   */
  private writeToDisk(): void {
    const payload: ConnectionsFile = {
      version: CONNECTIONS_VERSION,
      connections: this.list,
    };

    // 落盘前自检：扫到明文凭据直接抛，绝不写下去
    const leaked = scanForPlaintextSecrets(payload.connections);
    if (leaked.length > 0) throw new PlaintextSecretError(leaked);

    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /**
   * 创建副本时的密文来源。没传返回 undefined（普通新建）；传了但找不到 → 抛。
   *
   * ⚠️ 只允许**新建**时走这条路径（调用方已保证 existing 不存在）：
   *    更新一条已有连接时又从别处复制密文，等于悄悄换了它的密码来源。
   */
  private resolveCopySource(id: string | null | undefined): ConnectionConfig | undefined {
    if (!id) return undefined;
    const src = this.list.find((c) => c.id === id);
    if (!src) {
      throw Object.assign(new Error(`创建副本失败：源连接不存在（${id}）`), { code: 'VALIDATION' });
    }
    return src;
  }

  /**
   * 新增或更新一条连接。
   * 明文密码在这里加密，之后就不再以明文形式存在于任何持久化路径。
   */
  async save(input: SaveConnectionInput): Promise<ConnectionConfig> {
    const existing = this.list.find((c) => c.id === input.config.id);
    /**
     * 密文来源：
     *  - 更新：这条连接自己（prevFields 沿用）；
     *  - 创建副本（P1-8）：源连接，密文**原样复制**。
     *
     * 🔴 「找不到源连接」必须报错，不能静默降级成"没有密码"再交给校验器 ——
     *    那样用户看到的是「password 未保存密码」，完全猜不到是副本源丢了。
     */
    const copyFrom = existing ? undefined : this.resolveCopySource(input.copySecretsFrom);
    const secretBase = existing ?? copyFrom;
    const prevFields: ConnectionSecretFields = secretBase
      ? {
          passwordEnc: secretBase.passwordEnc,
          passphraseEnc: secretBase.ssh?.passphraseEnc ?? null,
          promptEveryTime: secretBase.promptEveryTime,
        }
      : { passwordEnc: null, passphraseEnc: null, promptEveryTime: false };

    let fields: ConnectionSecretFields;
    if (input.promptEveryTime) {
      // 用户明确要每次手输 → 清掉所有已存密文
      fields = { passwordEnc: null, passphraseEnc: null, promptEveryTime: true };
    } else if (input.password !== undefined || input.passphrase !== undefined) {
      fields = await sealSecrets(this.secrets, {
        password: input.password,
        passphrase: input.passphrase,
      });
      // 只改动传进来的那一项，另一项沿用旧密文
      if (input.password === undefined) fields.passwordEnc = prevFields.passwordEnc;
      if (input.passphrase === undefined) fields.passphraseEnc = prevFields.passphraseEnc;
    } else {
      fields = prevFields;
    }

    const base = normalizeConfig(input.config as ConnectionConfig);
    const cfg: ConnectionConfig = {
      ...base,
      passwordEnc: fields.passwordEnc,
      promptEveryTime: fields.promptEveryTime,
      ssh: { ...base.ssh, passphraseEnc: fields.passphraseEnc },
    };

    // ⚠️ 校验必须放在【凭据合并之后】：校验器要求 passwordEnc 或 promptEveryTime
    // 至少一个成立，新建连接时这两项恰恰是在上面这一步才填上的。
    const issues = validateConnectionConfig(cfg);
    if (hasBlockingError(issues)) {
      throw new Error(
        `连接配置校验未通过：${issues
          .filter((i) => i.level === 'error')
          .map((i) => `${i.field} ${i.message}`)
          .join('；')}`,
      );
    }

    const idx = this.list.findIndex((c) => c.id === cfg.id);
    if (idx >= 0) this.list[idx] = cfg;
    else this.list.push(cfg);

    this.writeToDisk();
    return { ...cfg };
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((c) => c.id !== id);
    if (this.list.length === before) return false;
    this.writeToDisk();
    return true;
  }

  /** 取明文密码用于建连。promptEveryTime 的连接返回 null（由 UI 弹窗索取） */
  async passwordFor(id: string): Promise<string | null> {
    const cfg = this.get(id);
    if (!cfg) return null;
    const { password } = await openSecrets(this.secrets, {
      passwordEnc: cfg.passwordEnc,
      passphraseEnc: cfg.ssh?.passphraseEnc ?? null,
      promptEveryTime: cfg.promptEveryTime,
    });
    return password;
  }

  /**
   * 取 SSH 凭据（明文，仅在内存里存在一次）。
   *
   * SSH 用的是**另一套**凭据：SSH 密码与私钥 passphrase，跟数据库密码无关。
   * 这里刻意不复用 passwordFor —— 两个东西混在一起最容易出现的 bug 是
   * "拿数据库密码去登 SSH"，报错还是含糊的认证失败。
   */
  async sshCredentialsFor(
    cfg: ConnectionConfig,
  ): Promise<{ password: string | null; passphrase: string | null }> {
    if (!cfg.ssh?.enabled) return { password: null, passphrase: null };
    return openSecrets(this.secrets, {
      passwordEnc: cfg.ssh.passwordEnc ?? null,
      passphraseEnc: cfg.ssh.passphraseEnc ?? null,
      // 私钥认证不需要密码；passphrase 为空是合法情况（无口令私钥）
      promptEveryTime: false,
    });
  }

  /**
   * 用新密钥的密文替换旧密文（safeStorage 密钥轮换时用）。
   *
   * 按密文匹配而非按连接 id：轮换回调手里只有密文串，没有连接上下文。
   * 同一密文出现在多条连接上（用户复制过配置）时一并替换，这是正确行为。
   *
   * @returns 替换了几处
   */
  async replaceCipher(oldCipherBase64: string, newCipherBase64: string): Promise<number> {
    if (!oldCipherBase64 || !newCipherBase64 || oldCipherBase64 === newCipherBase64) return 0;
    let hits = 0;
    let changed = false;

    for (const cfg of this.list) {
      if (cfg.passwordEnc === oldCipherBase64) {
        cfg.passwordEnc = newCipherBase64;
        hits++;
        changed = true;
      }
      if (cfg.ssh?.passphraseEnc === oldCipherBase64) {
        cfg.ssh.passphraseEnc = newCipherBase64;
        hits++;
        changed = true;
      }
    }

    if (changed) this.writeToDisk();
    return hits;
  }

  /** 自检：当前落盘内容里有没有明文凭据（工程验收项，可直接跑） */
  auditPlaintext(): string[] {
    return scanForPlaintextSecrets(this.list);
  }
}

/**
 * 补默认值 —— 老版本文件缺字段时不能让 UI 崩。
 * 注意：这里只补结构，不补凭据（凭据缺失 = 需要重输，这是正确行为）。
 */
export function normalizeConfig(c: Partial<ConnectionConfig>): ConnectionConfig {
  const base = defaultConnectionConfig();
  return {
    ...base,
    ...c,
    id: c.id ?? base.id,
    name: c.name ?? base.name,
    type: (c.type ?? base.type) as DbType,
    ssh: { ...base.ssh, ...(c.ssh ?? {}) },
    ssl: { ...base.ssl, ...(c.ssl ?? {}) },
  } as ConnectionConfig;
}
