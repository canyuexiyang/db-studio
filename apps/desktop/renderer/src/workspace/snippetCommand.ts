/**
 * SQL 片段 → 命令面板条目的身份编码（T04/R06）。
 *
 * 片段在存储层已按 `(connectionId, database, name)` 唯一（core-history 的
 * `snippet` 表 UNIQUE 三列）。但旧实现把命令 action 压成 `snippet:<name>`，
 * 应用时又用 `.find(x => x.name === name)` —— 于是 A 库/B 库各有一个叫「近 7 天
 * 活跃」的片段时，命令面板只能命中列表里第一个，插入的是**另一个库**的 SQL。
 *
 * 这里把完整身份编进 action，应用时按三元组精确回查。分隔符用 `\u0000`
 * （片段名/库名是给人看的文本，不含控制字符），再整体 encodeURIComponent
 * 保证 action 是 ASCII 安全串（原生菜单/快捷键映射要按字符串比较）。
 *
 * 抽成独立模块是为了可单测：`App.tsx` 里的函数不在 vitest include 覆盖范围。
 */

import type { Snippet } from '@dbstudio/core-history';

export const SNIPPET_ACTION_PREFIX = 'snippet:';
const SEP = '\u0000';

/** 片段的完整身份：连接 + 库 + 名称 */
export interface SnippetIdentity {
  connectionId: string;
  database: string;
  name: string;
}

/** 编码为 action 字符串（`snippet:<encoded>`） */
export function snippetActionOf(s: Pick<Snippet, 'connectionId' | 'database' | 'name'>): string {
  const raw = [s.connectionId, s.database, s.name].join(SEP);
  return SNIPPET_ACTION_PREFIX + encodeURIComponent(raw);
}

/** 从 action 解回身份；格式不符返回 null */
export function parseSnippetAction(action: string): SnippetIdentity | null {
  if (!action.startsWith(SNIPPET_ACTION_PREFIX)) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(action.slice(SNIPPET_ACTION_PREFIX.length));
  } catch {
    return null;
  }
  const parts = raw.split(SEP);
  if (parts.length !== 3) return null;
  return { connectionId: parts[0], database: parts[1], name: parts[2] };
}

/** 按身份三元组从片段表里精确回查（同名跨库/跨连接不会串） */
export function findSnippetByAction(snippets: Snippet[], action: string): Snippet | null {
  const id = parseSnippetAction(action);
  if (!id) return null;
  return (
    snippets.find(
      (s) => s.connectionId === id.connectionId && s.database === id.database && s.name === id.name,
    ) ?? null
  );
}

/** 命令面板的稳定 id（同名片段跨库/跨连接不撞） */
export function snippetCommandId(s: Pick<Snippet, 'connectionId' | 'database' | 'name'>): string {
  return `snip:${encodeURIComponent([s.connectionId, s.database, s.name].join(SEP))}`;
}

/** 副标题里显示归属：库名（空 = 全局）+ 连接名（能解析到才显示） */
export function snippetOriginLabel(
  s: Pick<Snippet, 'connectionId' | 'database' | 'description'>,
  connName?: string,
): string {
  const scope = s.database ? `库 ${s.database}` : '全局';
  const conn = connName ? ` · ${connName}` : '';
  const desc = s.description ? `${s.description} — ` : '';
  return `${desc}SQL 片段（${scope}${conn}）— 回车插入到当前查询标签`;
}
