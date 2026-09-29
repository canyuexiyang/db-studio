/**
 * 收藏表（C5）单测 —— 注入内存 storage，不碰真实 localStorage。
 * 覆盖：读/写往返、切换、上限、损坏数据降级、注入隔离。
 */
import { describe, it, expect } from 'vitest';
import {
  loadFavorites,
  isFavorite,
  toggleFavorite,
  favoriteKey,
  FAVORITES_STORAGE_KEY,
  FAVORITES_MAX,
  type FavoritesStorage,
} from './favorites';

/** 内存 storage：模拟 localStorage 的 get/set 语义 */
function makeStorage(initial: Record<string, string> = {}): FavoritesStorage & { dump(): Record<string, string> } {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

describe('loadFavorites', () => {
  it('空存储返回空列表', () => {
    expect(loadFavorites(makeStorage())).toEqual([]);
  });

  it('能读回 toggleFavorite 落盘的数据（往返一致）', () => {
    const s = makeStorage();
    toggleFavorite('c1:order_db:order', s);
    toggleFavorite('c1:log_db:access_log', s);
    expect(loadFavorites(s)).toEqual(['c1:order_db:order', 'c1:log_db:access_log']);
  });

  it('JSON 损坏返回空列表（不抛错）', () => {
    const s = makeStorage({ [FAVORITES_STORAGE_KEY]: '{not-json' });
    expect(loadFavorites(s)).toEqual([]);
  });

  it('非数组 JSON 返回空列表', () => {
    const s = makeStorage({ [FAVORITES_STORAGE_KEY]: '"c1:db:t"' });
    expect(loadFavorites(s)).toEqual([]);
  });

  it('混入非字符串项被过滤，合法项保留', () => {
    const s = makeStorage({ [FAVORITES_STORAGE_KEY]: JSON.stringify(['c1:db:t1', 42, null, 'c1:db:t2']) });
    expect(loadFavorites(s)).toEqual(['c1:db:t1', 'c1:db:t2']);
  });
});

describe('isFavorite / favoriteKey', () => {
  it('包含判定与 key 同构格式', () => {
    const key = favoriteKey('c1', 'order_db', 'order');
    expect(key).toBe('c1:order_db:order');
    expect(isFavorite([key], key)).toBe(true);
    expect(isFavorite([], key)).toBe(false);
  });
});

describe('toggleFavorite', () => {
  it('未收藏 → 追加并落盘；再切 → 移除并落盘', () => {
    const s = makeStorage();
    const key = favoriteKey('c1', 'order_db', 'order');
    expect(toggleFavorite(key, s)).toEqual([key]);
    expect(toggleFavorite(key, s)).toEqual([]);
    expect(JSON.parse(s.dump()[FAVORITES_STORAGE_KEY])).toEqual([]);
  });

  it('以上限为界拒绝新增（原样返回，不抛错），取消收藏不受限', () => {
    const full = Array.from({ length: FAVORITES_MAX }, (_, i) => `c1:db:t${i}`);
    const s = makeStorage({ [FAVORITES_STORAGE_KEY]: JSON.stringify(full) });
    const oneMore = favoriteKey('c1', 'db', 'overflow');
    expect(toggleFavorite(oneMore, s)).toEqual(full);
    expect(loadFavorites(s)).toEqual(full);
    // 已满仍可取消收藏
    expect(toggleFavorite(full[0], s)).not.toContain(full[0]);
  });

  it('以存储中的最新值为基准（不依赖调用方快照）', () => {
    const s = makeStorage();
    const k1 = favoriteKey('c1', 'db', 'a');
    toggleFavorite(k1, s);
    // 调用方手里拿着过期快照 []，切换结果仍以存储为准
    expect(toggleFavorite(k1, s)).toEqual([]);
  });
});
