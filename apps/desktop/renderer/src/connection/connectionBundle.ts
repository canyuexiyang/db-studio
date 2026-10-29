/**
 * P2-18j：连接配置的导入 / 导出（换机与备份）。
 *
 * ## 为什么导出**必须**剥掉密码
 *
 * 密码在主进程由 safeStorage 加密后落盘（`passwordEnc`）—— 它绑定当前机器与
 * 当前用户钥匙串：换一台机器解不开，所以"带着密码备份"在技术上无意义；
 * 而把密文写进一个明文 JSON 文件里，把"备份文件"变成了"凭据文件"——
 * 用户会把它放进网盘、发给同事、贴进工单。这是纯亏本的泄露面。
 *
 * 因此导出的每条连接都是"能照着重建、但要重输密码"的形态：
 * 手动输密码模式保持原样，其余一律标成 `promptEveryTime: true` + `passwordEnc: null`。
 *
 * ## 为什么导入不覆盖
 *
 * 导入的语义是"把另一台机器的连接搬过来"，不是"同步"。重名时**自动改名**
 * （`name (2)`）而不是覆盖本地已有连接：覆盖会连带丢掉本地那条的密码与历史，
 * 而用户点「导入」时想的是"多几条"，不是"改我现在的"。
 */

import type { ConnectionConfig, SshConfig, SslConfig } from '@dbstudio/core-connection';

/** 文件格式标识（导入时先认它，防止把别家的 JSON 当成本产品配置） */
export const CONNECTION_BUNDLE_FORMAT = 'dbstudio.connections';
export const CONNECTION_BUNDLE_VERSION = 1;

/** 导出形态：去掉 id（换机会重排）与 passwordEnc（机器绑定，且是泄密面） */
export type ExportedConnection = Omit<ConnectionConfig, 'id' | 'passwordEnc'>;

export interface ConnectionBundle {
  format: typeof CONNECTION_BUNDLE_FORMAT;
  version: number;
  exportedAt: number;
  /** 导出时的条数（冗余字段：导入时可用它做"文件被改过"的粗校验） */
  count: number;
  connections: ExportedConnection[];
}

/**
 * SSH 子配置的导出形态：只留"换机后要重填"的骨架。
 *
 * 🔴 白名单只覆盖顶层字段是不够的 —— `ssh` 与 `ssl` 是**嵌套对象**，
 *    整个透传会把 `ssh.passwordEnc` / `ssh.passphraseEnc`（密文）和
 *    `ssl.keyPath`（私钥文件路径）一起写进备份文件。所以这两个子对象
 *    要各自过一遍白名单。
 *
 * 私钥**路径**本身不是秘密，但它指向的文件在另一台机器上不存在：带过去只会
 * 让编辑框"看起来配好了"、连接时才报错。宁可留空让用户重选。
 */
function exportSsh(ssh: SshConfig): SshConfig {
  return {
    enabled: ssh.enabled,
    host: ssh.host,
    port: ssh.port,
    user: ssh.user,
    authType: ssh.authType,
    passwordEnc: null,
    privateKeyPath: null,
    passphraseEnc: null,
  };
}

/** SSL 同理：保留开关与校验口径，丢掉指向本机文件的三个路径 */
function exportSsl(ssl: SslConfig): SslConfig {
  return {
    enabled: ssl.enabled,
    caPath: null,
    certPath: null,
    keyPath: null,
    rejectUnauthorized: ssl.rejectUnauthorized,
  };
}

/**
 * 把当前连接列表变成可落盘的 bundle。
 *
 * 🔴 用**白名单**取字段，而不是 `delete cfg.passwordEnc`：
 *    以后给 ConnectionConfig 加任何新字段（比如未来的 token/keychain 引用），
 *    白名单会自动挡在导出之外；黑名单则会默默把它带进备份文件。
 */
export function buildConnectionBundle(list: ConnectionConfig[], now: number): ConnectionBundle {
  const connections: ExportedConnection[] = list.map((c) => ({
    name: c.name,
    type: c.type,
    host: c.host,
    port: c.port,
    user: c.user,
    // 无论本地是不是手动输密码模式，导出后都必须重输：没有密文可带
    promptEveryTime: true,
    defaultDatabase: c.defaultDatabase,
    group: c.group,
    colorTag: c.colorTag,
    note: c.note,
    readOnly: c.readOnly,
    ssh: exportSsh(c.ssh),
    ssl: exportSsl(c.ssl),
    idleTimeoutMs: c.idleTimeoutMs,
  }));
  return {
    format: CONNECTION_BUNDLE_FORMAT,
    version: CONNECTION_BUNDLE_VERSION,
    exportedAt: now,
    count: connections.length,
    connections,
  };
}

/** 落盘文本：带缩进，方便用户肉眼看/手工改（这也是"备份"该有的样子） */
export function serializeConnectionBundle(bundle: ConnectionBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export type ParseBundleResult =
  | { ok: true; bundle: ConnectionBundle }
  | { ok: false; reason: string };

/** 字符串字段的最小校验（缺字段就当文件损坏，宁可拒绝也不导入半条） */
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * 解析导入文件。
 *
 * 校验策略：**整体拒绝**而不是"跳过坏的那条"。理由是导入是批量操作，
 * 静默少导入几条的后果（用户以为搬完了，实际少了生产库连接）比直接报错更糟。
 */
export function parseConnectionBundle(text: string): ParseBundleResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法的 JSON 文件（可能选错了文件）' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '文件内容不是连接配置（顶层应为对象）' };
  }
  const o = raw as Record<string, unknown>;
  if (o.format !== CONNECTION_BUNDLE_FORMAT) {
    return { ok: false, reason: `不是 DB Studio 的连接配置文件（缺少 format=${CONNECTION_BUNDLE_FORMAT}）` };
  }
  if (typeof o.version !== 'number' || o.version > CONNECTION_BUNDLE_VERSION) {
    return {
      ok: false,
      reason: `文件版本 ${String(o.version)} 高于当前支持的 v${CONNECTION_BUNDLE_VERSION}，请升级应用后再导入`,
    };
  }
  if (!Array.isArray(o.connections)) {
    return { ok: false, reason: '文件里没有 connections 数组' };
  }
  const list = o.connections as unknown[];
  const bad: string[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      bad.push(`第 ${i + 1} 条不是对象`);
      return;
    }
    const c = item as Record<string, unknown>;
    if (!isStr(c.name) || !c.name.trim()) bad.push(`第 ${i + 1} 条缺少连接名`);
    else if (!isStr(c.host)) bad.push(`第 ${i + 1} 条（${c.name}）缺少 host`);
    else if (!isStr(c.user)) bad.push(`第 ${i + 1} 条（${c.name}）缺少 user`);
    else if (typeof c.port !== 'number') bad.push(`第 ${i + 1} 条（${c.name}）缺少 port`);
  });
  if (bad.length > 0) {
    return { ok: false, reason: `文件有 ${bad.length} 处不合法：${bad.slice(0, 3).join('；')}` };
  }
  return {
    ok: true,
    bundle: {
      format: CONNECTION_BUNDLE_FORMAT,
      version: o.version,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0,
      count: typeof o.count === 'number' ? o.count : list.length,
      connections: list as ExportedConnection[],
    },
  };
}

/**
 * 导入后要新建的连接（id 为空串 = 让主进程 create）。
 *
 * `renamed` 回传"哪个名字被改了、改成了什么"，导入完成的提示里要如实说出来 ——
 * 用户按名字找连接，悄悄改名等于让他找不到。
 */
export interface ImportPlan {
  toCreate: ConnectionConfig[];
  renamed: { from: string; to: string }[];
}

/** 生成不与 taken 冲突的名字（`name (2)` / `name (3)` …，只加后缀不改主体） */
export function uniqueConnectionName(desired: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = desired.trim() || '导入的连接';
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export function planConnectionImport(
  bundle: ConnectionBundle,
  existing: ConnectionConfig[],
): ImportPlan {
  const taken = existing.map((c) => c.name);
  const toCreate: ConnectionConfig[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const src of bundle.connections) {
    const name = uniqueConnectionName(src.name, taken);
    taken.push(name); // 同一文件里的重名也要递增，否则导入后两条同名
    if (name !== src.name) renamed.push({ from: src.name, to: name });
    toCreate.push({
      ...src,
      // 空 id = 新建（主进程按 config.id 有无决定 create/update）
      id: '',
      name,
      // 密文不可能随文件过来：一律要求重输
      passwordEnc: null,
      promptEveryTime: true,
    });
  }
  return { toCreate, renamed };
}
