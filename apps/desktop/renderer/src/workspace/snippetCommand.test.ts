import { describe, it, expect } from 'vitest';
import type { Snippet } from '@dbstudio/core-history';
import {
  snippetActionOf,
  parseSnippetAction,
  findSnippetByAction,
  snippetCommandId,
  snippetOriginLabel,
} from './snippetCommand';

function snip(partial: Partial<Snippet> & Pick<Snippet, 'name' | 'connectionId' | 'database' | 'sql'>): Snippet {
  return {
    description: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as Snippet;
}

/**
 * T04/R06 场景：A 库、B 库各有一个同名片段「近 7 天活跃」。
 * 旧实现 action = `snippet:近 7 天活跃`，应用时 `.find(name)` 会命中列表第一个 ——
 * 在 B 库里点命令会插入 A 库的 SQL。这里钉死三元组身份。
 */
const SNIPPETS: Snippet[] = [
  snip({ name: '近 7 天活跃', connectionId: 'c1', database: 'order_db', sql: 'SELECT * FROM a' }),
  snip({ name: '近 7 天活跃', connectionId: 'c1', database: 'log_db', sql: 'SELECT * FROM b' }),
  snip({ name: '近 7 天活跃', connectionId: 'c2', database: 'order_db', sql: 'SELECT * FROM c' }),
  snip({ name: '清理临时表', connectionId: '', database: '', sql: 'DROP TABLE tmp' }),
];

describe('snippetCommand · 身份编码（T04/R06）', () => {
  it('同名片段的 action 各不相同（连接/库/名任一不同即不同）', () => {
    const sameName = SNIPPETS.filter((s) => s.name === '近 7 天活跃');
    const actions = new Set(sameName.map(snippetActionOf));
    expect(actions.size).toBe(sameName.length);
    const ids = new Set(sameName.map(snippetCommandId));
    expect(ids.size).toBe(sameName.length);
  });

  it('action ↔ 身份可无损往返（含中文与控制字符分隔）', () => {
    const s = SNIPPETS[0];
    const parsed = parseSnippetAction(snippetActionOf(s));
    expect(parsed).toEqual({ connectionId: 'c1', database: 'order_db', name: '近 7 天活跃' });
  });

  it('🔴 在 B 库点同名片段，回查得到的是 B 库那条（旧实现会命中 A 库）', () => {
    const target = SNIPPETS.find((s) => s.connectionId === 'c1' && s.database === 'log_db')!;
    const hit = findSnippetByAction(SNIPPETS, snippetActionOf(target));
    expect(hit?.sql).toBe('SELECT * FROM b');
  });

  it('跨连接同名同库也不串（c2/order_db vs c1/order_db）', () => {
    const target = SNIPPETS.find((s) => s.connectionId === 'c2')!;
    const hit = findSnippetByAction(SNIPPETS, snippetActionOf(target));
    expect(hit?.sql).toBe('SELECT * FROM c');
  });

  it('全局片段（空串哨兵）也能精确定位', () => {
    const g = SNIPPETS.find((s) => s.name === '清理临时表')!;
    const hit = findSnippetByAction(SNIPPETS, snippetActionOf(g));
    expect(hit?.sql).toBe('DROP TABLE tmp');
  });

  it('格式不符的 action 返回 null，不误命中', () => {
    expect(parseSnippetAction('snippet:近 7 天活跃')).toBeNull(); // 旧格式：只有名字
    expect(parseSnippetAction('not-a-snippet')).toBeNull();
    expect(findSnippetByAction(SNIPPETS, 'snippet:随便什么')).toBeNull();
  });

  it('副标题显示归属：库名 + 连接名；全局显示「全局」', () => {
    expect(snippetOriginLabel(SNIPPETS[0], 'prod_order')).toContain('库 order_db');
    expect(snippetOriginLabel(SNIPPETS[0], 'prod_order')).toContain('prod_order');
    expect(snippetOriginLabel(SNIPPETS[3])).toContain('全局');
  });
});
