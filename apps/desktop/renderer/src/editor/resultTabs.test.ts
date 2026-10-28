/**
 * T42：结果标签集合操作的单元测试。
 *
 * 🔴 每一条「不会发生 X」都配一条「会触发 X」的对照：
 *    一个把 `mergeResults` 写成 `[...incoming, ...existing].slice(0, max)`
 *    的实现能通过大半断言，只有「固定槽位不被新结果占用」这组会红。
 */

import { describe, it, expect } from 'vitest';
import {
  mergeResults,
  closeOthers,
  togglePin,
  renameTab,
  displayOrder,
  resultTabTitle,
  describeResultOrigin,
  clockOf,
  MAX_RESULT_TABS,
  type ResultTabMeta,
} from './resultTabs';

function tab(id: string, pinned = false, name: string | null = null, createdAt = 0): ResultTabMeta {
  return { id, pinned, name, createdAt };
}

const ids = (ts: readonly ResultTabMeta[]): string[] => ts.map((t) => t.id);

describe('T42 新查询不覆盖固定结果', () => {
  it('容量满时：淘汰最老的**未固定**结果，固定结果一定还在', () => {
    // 上限 3：已有 [pinned:a, b, c]
    const existing = [tab('a', true), tab('b'), tab('c')];
    const next = mergeResults(existing, [tab('d')], 3);
    expect(next).toHaveLength(3);
    // 证伪点：写成 slice(0, 3) 会把最老的 a（固定）挤掉
    expect(ids(next)).toContain('a');
    expect(ids(next)).not.toContain('c');
  });

  it('对照组：同样的场景不固定时，最老的会被淘汰（否则上一条断言是恒真）', () => {
    const existing = [tab('a'), tab('b'), tab('c')];
    const next = mergeResults(existing, [tab('d')], 3);
    expect(ids(next)).toEqual(['d', 'a', 'b']);
    expect(ids(next)).not.toContain('c');
  });

  it('连续跑满上限：固定结果始终存活', () => {
    let tabs: ResultTabMeta[] = [tab('keep', true)];
    for (let i = 0; i < 30; i++) {
      tabs = mergeResults(tabs, [tab(`n${i}`)], MAX_RESULT_TABS);
      expect(ids(tabs), `第 ${i} 次查询后固定结果丢了`).toContain('keep');
    }
    expect(tabs.length).toBeLessThanOrEqual(MAX_RESULT_TABS);
  });

  it('固定项占满上限时：宁可超出上限也不丢固定结果，且至少保留最新一条', () => {
    const pinned = Array.from({ length: 20 }, (_, i) => tab(`p${i}`, true));
    const next = mergeResults(pinned, [tab('new')], MAX_RESULT_TABS);
    for (const p of pinned) expect(ids(next)).toContain(p.id);
    expect(ids(next)).toContain('new');
  });

  it('新结果排在最前（既有行为不倒退）', () => {
    const next = mergeResults([tab('old1'), tab('old2')], [tab('n1'), tab('n2')], 20);
    expect(ids(next)).toEqual(['n1', 'n2', 'old1', 'old2']);
  });
});

describe('T42 固定与展示顺序', () => {
  it('固定后排到最前', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(ids(displayOrder(togglePin(tabs, 'c')))).toEqual(['c', 'a', 'b']);
  });

  it('取消固定后回到原来的相对位置（对照：上一条是最前）', () => {
    const pinned = togglePin([tab('a'), tab('b'), tab('c')], 'c');
    expect(ids(displayOrder(togglePin(pinned, 'c')))).toEqual(['a', 'b', 'c']);
  });

  it('togglePin 只动目标那一个', () => {
    const next = togglePin([tab('a', true), tab('b')], 'b');
    expect(next[0].pinned).toBe(true);
    expect(next[1].pinned).toBe(true);
  });
});

describe('T42 关闭其他', () => {
  it('保留目标与**所有固定项**（固定不该被顺手清掉）', () => {
    const tabs = [tab('a', true), tab('b'), tab('target'), tab('d', true)];
    // 证伪点：写成 filter(t => t.id === keepId) 会连固定项一起关掉
    expect(ids(closeOthers(tabs, 'target'))).toEqual(['a', 'target', 'd']);
  });

  it('目标本身是固定项时同样成立', () => {
    const tabs = [tab('a'), tab('p', true), tab('b')];
    expect(ids(closeOthers(tabs, 'p'))).toEqual(['p']);
  });

  it('没有固定项时就是「只留目标」', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(ids(closeOthers(tabs, 'b'))).toEqual(['b']);
  });
});

describe('T42 重命名', () => {
  it('自定义名生效', () => {
    expect(renameTab([tab('a')], 'a', '按月统计')[0].name).toBe('按月统计');
  });

  it('空串 / 纯空白 = 清除自定义名，回到自动标题（不是把标签清空）', () => {
    const renamed = renameTab([tab('a')], 'a', '按月统计');
    expect(renameTab(renamed, 'a', '   ')[0].name).toBeNull();
    expect(renameTab(renamed, 'a', null)[0].name).toBeNull();
  });

  it('只动目标那一个', () => {
    const next = renameTab([tab('a'), tab('b')], 'a', 'X');
    expect(next[0].name).toBe('X');
    expect(next[1].name).toBeNull();
  });
});

describe('T42 标签标题与来源', () => {
  it('标题优先级：自定义名 > 执行计划 > 行数；出错时是「执行失败」', () => {
    const facts = { rowCount: 12, explain: false, error: null };
    expect(resultTabTitle(tab('a', false, '我的结果'), facts)).toBe('我的结果');
    expect(resultTabTitle(tab('a'), { ...facts, explain: true })).toBe('执行计划');
    expect(resultTabTitle(tab('a'), { ...facts, error: 'boom' })).toBe('执行失败');
    expect(resultTabTitle(tab('a'), facts)).toBe('12 行');
  });

  /**
   * 0.7.1 需求 1：标签标题是「第三个消费点」。
   *
   * 反例：如果不传 text 就退回 rowCount，UPDATE 的标签会显示「0 行」而消息行显示
   * 「已修改 2 行」—— 同一份结果两套说法。这里钉住「text 优先于行数」。
   */
  it('0.7.1 带结果文案时优先用它（写操作不再显示「0 行」）', () => {
    const facts = { rowCount: 0, explain: false, error: null };
    expect(resultTabTitle(tab('a'), { ...facts, text: '已修改 2 行' })).toBe('已修改 2 行');
    // 自定义名优先级仍高于结果文案
    expect(resultTabTitle(tab('a', false, '我的结果'), { ...facts, text: '已修改 2 行' })).toBe('我的结果');
    // 失败时仍是「执行失败」，不让结果文案盖掉错误
    expect(resultTabTitle(tab('a'), { ...facts, error: 'boom', text: '已修改 2 行' })).toBe('执行失败');
  });

  it('来源摘要含连接 / 库 / 时间 / 行数', () => {
    const s = describeResultOrigin({
      sql: 'SELECT 1',
      connectionName: '本机',
      database: 'order_db',
      createdAt: new Date(2026, 0, 2, 3, 4, 5).getTime(),
      elapsedMs: 12,
      rowCount: 7,
    });
    expect(s).toContain('本机');
    expect(s).toContain('order_db');
    expect(s).toContain('03:04:05');
    expect(s).toContain('7 行');
    expect(s).toContain('12ms');
  });

  it('没有库上下文时不显示库（不留「未知」占位）', () => {
    const s = describeResultOrigin({
      sql: 'SELECT 1',
      connectionName: '本机',
      database: null,
      createdAt: 0,
      elapsedMs: 0,
      rowCount: 0,
    });
    expect(s).not.toContain('null');
    expect(s.startsWith('本机 ·')).toBe(true);
  });

  it('clockOf 是 HH:MM:SS；非法时间不抛', () => {
    expect(clockOf(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05');
    expect(clockOf(NaN)).toBe('--:--:--');
  });
});
