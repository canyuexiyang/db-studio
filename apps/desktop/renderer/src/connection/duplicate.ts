/**
 * 连接「创建副本」与「已保存密码占位」的纯逻辑（P1-8）。
 *
 * 为什么这些判定要单独抽成不依赖 React/DOM 的模块：它们出错的方式都很**安静** ——
 *   · 少清一个 `id` → 副本直接把原连接覆盖掉（用户看到的是"原连接改名了"）；
 *   · 把 `''` 占位符当成密文存下去 → 得到一条永远连不上的连接；
 *   · 名字不做重名递增 → 树里两条一模一样的连接，删错就回不来了。
 * 这些都不是类型错、不会在 IDE 里标红，只能靠单测钉住。
 */

import type { ConnectionConfig } from '@dbstudio/core-connection';

/** 副本名后缀 */
const COPY_SUFFIX = ' 副本';

/**
 * 主进程把密文剥成 `''`（"已存过"）或 `null`（"没有"）。
 *
 * 🔴 判据是 `!== null`，**不是** `length > 0`。
 *    早先这里的写法是 `v.length > 0`，而主进程恰好把"已存过"剥成空串 ——
 *    于是编辑既有连接时：密码框没有「已保存」占位、校验认为没密码、
 *    保存按钮直接禁用，用户被迫重输一遍谁也记不住的密码。
 *    单测 `hasStoredSecret('')` 就是钉这一条。
 */
export function hasStoredSecret(v: string | null | undefined): boolean {
  return typeof v === 'string';
}

/**
 * 副本的连接名：`原名 副本`；重名时依次 `原名 副本 2`、`原名 副本 3` …
 *
 * `taken` 传当前全部连接名（含不同分组里的同名项）—— 连接名在树里是唯一可读标识，
 * 重名只会让用户删错。
 */
export function duplicateConnectionName(source: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${source}${COPY_SUFFIX}`;
  if (!used.has(base)) return base;
  for (let i = 2; i <= 999; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // 999 条同名副本：理论上碰不到，碰到了也不能返回一个已占用的名字
  return `${base} ${used.size + 1}`;
}

/**
 * 副本保存时提交的配置。
 *
 * 🔴 两件事必须同时成立，缺一个就出事：
 *  1. **清空 `id`** —— `backend.connSave()` 按 `config.id` 有无决定走 create 还是 update，
 *     留着源连接的 id = 用副本的字段覆盖原连接（原连接就此消失）。
 *  2. **清空密文占位** —— 渲染层的 `''` 只代表"源连接存过密码"，不是密文本身。
 *     真密文由主进程按 `copySecretsFrom` 从源连接按字节复制。
 */
export function duplicateSaveConfig(form: ConnectionConfig): ConnectionConfig {
  return {
    ...form,
    id: '',
    passwordEnc: null,
    ssh: { ...form.ssh, passwordEnc: null, passphraseEnc: null },
  };
}
