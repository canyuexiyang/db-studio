/**
 * 片段命名规则（v0.6.0）—— **零依赖子入口**。
 *
 * 🔴 为什么要单独成文件而不是从主入口导出：
 *    `core-history/src/index.ts` 顶部 `import { DatabaseSync } from 'node:sqlite'`。
 *    渲染层要用这套命名规则做实时校验（超 25 字就禁用保存），
 *    从主入口 import 会把 node:sqlite 拖进浏览器 bundle —— 直接构建失败。
 *    与 `@dbstudio/core-sql-editor/facts` 同一思路：拆子入口，主入口再 re-export。
 */

/** 片段名上限：25 个汉字（用户拍板） */
export const SNIPPET_NAME_MAX = 25;

/**
 * 片段名是否合法。
 *
 * 🔴 按**码点**计数而不是 length（UTF-16 码元）：
 *    `'😀'.length === 2`（代理对）—— 用 length 会让 13 个 emoji 被算成 26 而误拒，
 *    也会让含生僻字的正常中文名被判超限。`[...str]` 按码点迭代，是这里唯一正确的口径。
 *
 * 判定口径（用户拍板：名称是「这段 SQL 干什么用」的用途描述）：
 *  - 非空（trim 后）
 *  - 不超过 25 个码点
 *  - 不含换行/制表符（会撑坏弹窗的单行输入展示）
 */
export function isValidSnippetName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if ([...trimmed].length > SNIPPET_NAME_MAX) return false;
  return !/[\n\r\t]/.test(name);
}

/** 名称超长时的提示文案（给出实际字数，用户不用自己数） */
export function snippetNameTooLongMessage(name: string): string {
  return `片段名称最多 ${SNIPPET_NAME_MAX} 个字，当前 ${[...name.trim()].length} 个`;
}