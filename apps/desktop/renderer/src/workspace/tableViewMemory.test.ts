import { beforeEach, describe, expect, it } from 'vitest';
import { TABLE_VIEW_KEY, clearTableView, loadTableView, saveTableView, viewKey } from './tableViewMemory';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key() {
    return null;
  }
  get length() {
    return this.m.size;
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
});

const sorts = [{ column: 'id', direction: 'DESC' as const }];
const filter = { groups: [{ id: 'g1', logic: 'AND' as const, conditions: [{ id: 'c1', column: 'status', operator: 'eq' as const, value: 'new' }] }] };

describe('T43 表视图记忆', () => {
  it('键带连接：两个连接的同名库表互不串味', () => {
    saveTableView('c1', 'order_db', 'order_main', { sorts, filter });
    saveTableView('c2', 'order_db', 'order_main', { sorts: [], filter: null });
    expect(loadTableView('c1', 'order_db', 'order_main')?.sorts).toEqual(sorts);
    // c2 存的是空视图 → 视为「没有记忆」，绝不能读到 c1 的筛选
    expect(loadTableView('c2', 'order_db', 'order_main')).toBeNull();
    expect(viewKey('c1', 'db', 't')).not.toBe(viewKey('c2', 'db', 't'));
  });

  it('存空视图 = 删除该键（不堆空记录）', () => {
    saveTableView('c1', 'db', 't', { sorts, filter });
    saveTableView('c1', 'db', 't', { sorts: [], filter: null });
    expect(loadTableView('c1', 'db', 't')).toBeNull();
    const raw = JSON.parse(localStorage.getItem(TABLE_VIEW_KEY) as string);
    expect(Object.keys(raw)).toHaveLength(0);
  });

  it('清损坏的存档不当成有记忆（宁可少恢复，不能让表打不开）', () => {
    localStorage.setItem(TABLE_VIEW_KEY, '{oops');
    expect(loadTableView('c1', 'db', 't')).toBeNull();
    localStorage.setItem(TABLE_VIEW_KEY, JSON.stringify({ [viewKey('c1', 'db', 't')]: { sorts: 'nope' } }));
    expect(loadTableView('c1', 'db', 't')).toBeNull();
  });

  it('排序方向非法的条目被剔除，合法的保留', () => {
    localStorage.setItem(
      TABLE_VIEW_KEY,
      JSON.stringify({
        [viewKey('c1', 'db', 't')]: {
          sorts: [{ column: 'a', direction: 'ASC' }, { column: 'b', direction: 'sideways' }, { nope: 1 }],
          savedAt: 1,
        },
      }),
    );
    const v = loadTableView('c1', 'db', 't');
    expect(v?.sorts).toEqual([{ column: 'a', direction: 'ASC' }]);
  });

  it('clear 只删这张表，不影响同库其它表', () => {
    saveTableView('c1', 'db', 'a', { sorts, filter: null });
    saveTableView('c1', 'db', 'b', { sorts, filter: null });
    clearTableView('c1', 'db', 'a');
    expect(loadTableView('c1', 'db', 'a')).toBeNull();
    expect(loadTableView('c1', 'db', 'b')?.sorts).toEqual(sorts);
  });

  it('保存时补 savedAt（用于排查「怎么突然有筛选」）', () => {
    saveTableView('c1', 'db', 't', { sorts, filter });
    expect(loadTableView('c1', 'db', 't')?.savedAt).toBeGreaterThan(0);
  });
});
