import { describe, it, expect } from 'vitest';
import { applyPin, moveTabOrder, pinnedCount, pinnedInsertIndex, tabDisplayTitle, type TabLike } from './tabOrder';

const ids = (tabs: readonly TabLike[]) => tabs.map((t) => t.id);

describe('moveTabOrder', () => {
  const tabs: TabLike[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('把 d 拖到最前', () => {
    expect(ids(moveTabOrder(tabs, 3, 0))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('把 a 拖到末尾', () => {
    expect(ids(moveTabOrder(tabs, 0, 3))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('原地不动 / 越界 → 原数组（引用相等，调用方可短路）', () => {
    expect(moveTabOrder(tabs, 2, 2)).toBe(tabs);
    expect(moveTabOrder(tabs, -1, 2)).toBe(tabs);
    expect(moveTabOrder(tabs, 0, 4)).toBe(tabs);
  });

  it('不修改入参（拖拽不能就地改 tabs 数组）', () => {
    const before = ids(tabs);
    moveTabOrder(tabs, 0, 2);
    expect(ids(tabs)).toEqual(before);
  });
});

describe('applyPin（P1-7 固定）', () => {
  const tabs: TabLike[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('固定后落到固定块末尾（第一个被固定的在最左）', () => {
    const one = applyPin(tabs, 'c', true);
    expect(ids(one)).toEqual(['c', 'a', 'b']);
    const two = applyPin(one, 'b', true);
    expect(ids(two)).toEqual(['c', 'b', 'a']);
  });

  it('取消固定留在原位，只去掉标记', () => {
    const pinned = applyPin(tabs, 'c', true);
    const unpinned = applyPin(pinned, 'c', false);
    expect(ids(unpinned)).toEqual(['c', 'a', 'b']);
    expect(unpinned[0].pinned).toBe(false);
  });

  it('id 不存在 → 原样（右键的标签可能这一帧已被关掉）', () => {
    expect(ids(applyPin(tabs, 'zz', true))).toEqual(['a', 'b', 'c']);
  });

  it('pinnedCount / pinnedInsertIndex 与固定块一致', () => {
    const pinned = applyPin(applyPin(tabs, 'c', true), 'a', true);
    expect(pinnedCount(pinned)).toBe(2);
    expect(pinnedInsertIndex(pinned, 'b')).toBe(2);
  });
});

describe('tabDisplayTitle（P2-18f 同名表可区分）', () => {
  const labels = { c1: '本地测试', c2: '生产' };

  it('表名唯一 → 不追加任何东西（不制造噪音）', () => {
    const tabs: TabLike[] = [
      { id: '1', kind: 'table', title: 'users', tableName: 'users', connId: 'c1', database: 'db' },
      { id: '2', kind: 'table', title: 'orders', tableName: 'orders', connId: 'c2', database: 'db' },
    ];
    expect(tabDisplayTitle(tabs[0], tabs, labels)).toBe('users');
  });

  it('同名表跨连接 → 追加连接名', () => {
    const tabs: TabLike[] = [
      { id: '1', kind: 'table', title: 'users', tableName: 'users', connId: 'c1', database: 'db' },
      { id: '2', kind: 'table', title: 'users', tableName: 'users', connId: 'c2', database: 'db' },
    ];
    expect(tabDisplayTitle(tabs[0], tabs, labels)).toBe('users · 本地测试');
    expect(tabDisplayTitle(tabs[1], tabs, labels)).toBe('users · 生产');
  });

  it('同名表在同一连接的不同库 → 追加库名（连接名帮不上忙）', () => {
    const tabs: TabLike[] = [
      { id: '1', kind: 'table', title: 'users', tableName: 'users', connId: 'c1', database: 'db_a' },
      { id: '2', kind: 'table', title: 'users', tableName: 'users', connId: 'c1', database: 'db_b' },
    ];
    expect(tabDisplayTitle(tabs[0], tabs, labels)).toBe('users · db_a');
    expect(tabDisplayTitle(tabs[1], tabs, labels)).toBe('users · db_b');
  });

  it('连接名缺失 → 退化为连接 id 前 6 位（不要两个一模一样的标题）', () => {
    const tabs: TabLike[] = [
      { id: '1', kind: 'table', title: 'users', tableName: 'users', connId: 'conn-abcdef', database: 'db' },
      { id: '2', kind: 'table', title: 'users', tableName: 'users', connId: 'conn-xyz', database: 'db' },
    ];
    expect(tabDisplayTitle(tabs[0], tabs, {})).toBe('users · conn-a');
  });

  it('查询标签原样返回', () => {
    const tabs: TabLike[] = [{ id: 'q1', kind: 'query', title: '查询 1' }];
    expect(tabDisplayTitle(tabs[0], tabs, labels)).toBe('查询 1');
  });
});
