/**
 * 已保存筛选方案（V18）单测 —— 全部注入内存 storage，不碰真实 localStorage。
 * 覆盖：增删改查、重名拒绝、上限、名称校验、搜索、存储异常降级、脏数据逐条丢弃。
 */
import { describe, it, expect } from 'vitest';
import {
  createSavedFilterStore,
  listSavedFilters,
  saveFilter,
  renameFilter,
  deleteFilter,
  searchSavedFilters,
  findSavedFilter,
  savedFilterKey,
  SAVED_FILTERS_STORAGE_KEY,
  SAVED_FILTERS_MAX_PER_TABLE,
  SAVED_FILTER_NAME_MAX,
  type SavedFilter,
  type StorageLike,
} from './savedFilters';

/** 内存 storage：模拟 localStorage 语义，可开关"读抛错/写抛错" */
function makeStorage(opts: { initial?: Record<string, string>; throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const m = new Map<string, string>(Object.entries(opts.initial ?? {}));
  const storage: StorageLike & { dump(): Record<string, string>; writes: number } = {
    getItem: (k) => {
      if (opts.throwOnGet) throw new Error('getItem boom');
      return m.has(k) ? m.get(k)! : null;
    },
    setItem: (k, v) => {
      if (opts.throwOnSet) throw new Error('setItem boom');
      storage.writes += 1;
      m.set(k, v);
    },
    dump: () => Object.fromEntries(m),
    writes: 0,
  };
  return storage;
}

const KEY = savedFilterKey('c1', 'order_db', 'orders');

/** 造一个有实际条件的模型（emptyFilter() 的条件没列名，这里补上） */
function mkModel(column = 'age', value = '18'): SavedFilter['model'] {
  return {
    groups: [
      { id: 'g1', logic: 'AND', conditions: [{ id: 'c1', column, operator: 'gt', value }] },
    ],
  };
}

/** 完全空的模型：一个条件都没有 → isFilterEmpty 为真 */
const EMPTY_MODEL: SavedFilter['model'] = { groups: [{ id: 'g1', logic: 'AND', conditions: [] }] };

describe('saveFilter / listSavedFilters', () => {
  it('空存储时列表为空', () => {
    expect(listSavedFilters(createSavedFilterStore(makeStorage()), KEY)).toEqual([]);
  });

  it('保存后能读回（往返一致，含 model 原样保留）', () => {
    const s = makeStorage();
    const store = createSavedFilterStore(s);
    const model = mkModel('status', 'paid');
    const r = saveFilter(store, KEY, '未付款订单', model);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = listSavedFilters(store, KEY);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('未付款订单');
    expect(list[0].model).toEqual(model);
    expect(list[0].id).toBe(r.filter.id);
  });

  it('名称保存前被 trim（不留首尾空格）', () => {
    const s = makeStorage();
    const store = createSavedFilterStore(s);
    const r = saveFilter(store, KEY, '  高价值客户  ', mkModel());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filter.name).toBe('高价值客户');
  });

  it('列表按 updatedAt 倒序（用固定时间戳验证，不受同毫秒影响）', () => {
    const raw = JSON.stringify({
      [KEY]: [
        { id: 'a', name: 'A', model: mkModel('a'), createdAt: 1, updatedAt: 100 },
        { id: 'b', name: 'B', model: mkModel('b'), createdAt: 2, updatedAt: 300 },
        { id: 'c', name: 'C', model: mkModel('c'), createdAt: 3, updatedAt: 200 },
      ],
    });
    const store = createSavedFilterStore(makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: raw } }));
    expect(listSavedFilters(store, KEY).map((f) => f.name)).toEqual(['B', 'C', 'A']);
  });

  it('updatedAt 相同时保持存储顺序（排序稳定，不随机换位）', () => {
    const raw = JSON.stringify({
      [KEY]: [
        { id: 'a', name: 'A', model: mkModel('a'), createdAt: 1, updatedAt: 7 },
        { id: 'b', name: 'B', model: mkModel('b'), createdAt: 2, updatedAt: 7 },
      ],
    });
    const store = createSavedFilterStore(makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: raw } }));
    expect(listSavedFilters(store, KEY).map((f) => f.name)).toEqual(['A', 'B']);
  });

  it('连续两次保存后的列表本身是"按时间不升序"的', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, 'A', mkModel('a'));
    saveFilter(store, KEY, 'B', mkModel('b'));
    const list = listSavedFilters(store, KEY);
    expect(list).toHaveLength(2);
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[1].updatedAt);
  });

  it('空筛选模型被拒，且给出中文原因', () => {
    const store = createSavedFilterStore(makeStorage());
    const r = saveFilter(store, KEY, '空方案', EMPTY_MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('筛选条件为空');
    expect(listSavedFilters(store, KEY)).toEqual([]);
  });

  it('完全同名的第二条被拒', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, '活跃用户', mkModel());
    const r = saveFilter(store, KEY, '活跃用户', mkModel('x'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('已存在同名方案');
    expect(listSavedFilters(store, KEY)).toHaveLength(1);
  });

  it('重名判定大小写不敏感（MyFilter vs myfilter）', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, 'MyFilter', mkModel());
    expect(saveFilter(store, KEY, 'myfilter', mkModel('b')).ok).toBe(false);
  });

  it('重名判定忽略首尾空格', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, '活跃用户', mkModel());
    expect(saveFilter(store, KEY, '  活跃用户  ', mkModel('b')).ok).toBe(false);
  });

  it('名称为空 / 纯空格被拒', () => {
    const store = createSavedFilterStore(makeStorage());
    const r = saveFilter(store, KEY, '   ', mkModel());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('名称不能为空');
  });

  it(`名称超过 ${SAVED_FILTER_NAME_MAX} 字被拒，正好 ${SAVED_FILTER_NAME_MAX} 字通过`, () => {
    const store = createSavedFilterStore(makeStorage());
    const tooLong = 'x'.repeat(SAVED_FILTER_NAME_MAX + 1);
    const r = saveFilter(store, KEY, tooLong, mkModel());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('名称不能超过');

    const ok = saveFilter(store, KEY, 'x'.repeat(SAVED_FILTER_NAME_MAX), mkModel());
    expect(ok.ok).toBe(true);
  });

  it(`单表达到 ${SAVED_FILTERS_MAX_PER_TABLE} 条后拒绝新增，已存的仍可读`, () => {
    const store = createSavedFilterStore(makeStorage());
    for (let i = 0; i < SAVED_FILTERS_MAX_PER_TABLE; i++) {
      expect(saveFilter(store, KEY, `方案${i}`, mkModel(`c${i}`)).ok).toBe(true);
    }
    const r = saveFilter(store, KEY, '再多一个', mkModel());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('最多保存');
    expect(listSavedFilters(store, KEY)).toHaveLength(SAVED_FILTERS_MAX_PER_TABLE);
  });

  it('不同 tableKey 互不干扰，且各自独立计上限', () => {
    const store = createSavedFilterStore(makeStorage());
    const other = savedFilterKey('c1', 'order_db', 'users');
    saveFilter(store, KEY, '订单方案', mkModel('amount'));
    saveFilter(store, other, '用户方案', mkModel('age'));
    expect(listSavedFilters(store, KEY).map((f) => f.name)).toEqual(['订单方案']);
    expect(listSavedFilters(store, other).map((f) => f.name)).toEqual(['用户方案']);
  });
});

describe('renameFilter', () => {
  it('改名成功并刷新 updatedAt，model 不变', () => {
    const store = createSavedFilterStore(makeStorage());
    const r0 = saveFilter(store, KEY, '旧名字', mkModel('age', '20'));
    if (!r0.ok) throw new Error('setup failed');
    const before = r0.filter;
    const r = renameFilter(store, KEY, before.id, '新名字');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filter.name).toBe('新名字');
    expect(r.filter.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(r.filter.model).toEqual(before.model);
    expect(listSavedFilters(store, KEY)[0].name).toBe('新名字');
  });

  it('改成别人的名字被拒（自己改成自己不算重名）', () => {
    const store = createSavedFilterStore(makeStorage());
    const a = saveFilter(store, KEY, 'A', mkModel('a'));
    const b = saveFilter(store, KEY, 'B', mkModel('b'));
    if (!a.ok || !b.ok) throw new Error('setup failed');
    expect(renameFilter(store, KEY, a.ok ? a.filter.id : '', 'B').ok).toBe(false);
    expect(renameFilter(store, KEY, a.filter.id, 'A').ok).toBe(true);
  });

  it('改名为空 / 超长同样被拒', () => {
    const store = createSavedFilterStore(makeStorage());
    const a = saveFilter(store, KEY, 'A', mkModel());
    if (!a.ok) throw new Error('setup failed');
    expect(renameFilter(store, KEY, a.filter.id, '').ok).toBe(false);
    expect(renameFilter(store, KEY, a.filter.id, 'y'.repeat(SAVED_FILTER_NAME_MAX + 1)).ok).toBe(false);
  });

  it('id 不存在时返回"方案不存在"，不抛错也不改数据', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, 'A', mkModel());
    const r = renameFilter(store, KEY, 'not-exist', 'B');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('不存在');
    expect(listSavedFilters(store, KEY).map((f) => f.name)).toEqual(['A']);
  });
});

describe('deleteFilter', () => {
  it('删除后列表不含它，另一条保留', () => {
    const store = createSavedFilterStore(makeStorage());
    const a = saveFilter(store, KEY, 'A', mkModel('a'));
    saveFilter(store, KEY, 'B', mkModel('b'));
    if (!a.ok) throw new Error('setup failed');
    const rest = deleteFilter(store, KEY, a.filter.id);
    expect(rest.map((f) => f.name)).toEqual(['B']);
    expect(listSavedFilters(store, KEY).map((f) => f.name)).toEqual(['B']);
  });

  it('删除不存在的 id：原样返回剩余列表，不抛错', () => {
    const store = createSavedFilterStore(makeStorage());
    saveFilter(store, KEY, 'A', mkModel());
    expect(deleteFilter(store, KEY, 'nope').map((f) => f.name)).toEqual(['A']);
  });

  it('删掉最后一条后该表的键被清掉（存储里不留空数组）', () => {
    const s = makeStorage();
    const store = createSavedFilterStore(s);
    const a = saveFilter(store, KEY, 'A', mkModel());
    if (!a.ok) throw new Error('setup failed');
    expect(deleteFilter(store, KEY, a.filter.id)).toEqual([]);
    const raw = s.dump()[SAVED_FILTERS_STORAGE_KEY];
    expect(JSON.parse(raw)[KEY]).toBeUndefined();
  });
});

describe('searchSavedFilters', () => {
  const list: SavedFilter[] = [
    { id: '1', name: 'VIP 客户', model: EMPTY_MODEL, createdAt: 1, updatedAt: 1 },
    { id: '2', name: 'vip 黑名单', model: EMPTY_MODEL, createdAt: 2, updatedAt: 2 },
    { id: '3', name: '本月订单', model: EMPTY_MODEL, createdAt: 3, updatedAt: 3 },
  ];

  it('空 query（含纯空格）返回全部', () => {
    expect(searchSavedFilters(list, '')).toEqual(list);
    expect(searchSavedFilters(list, '   ')).toEqual(list);
  });

  it('大小写不敏感匹配（vip 命中两条）', () => {
    expect(searchSavedFilters(list, 'vip').map((f) => f.id)).toEqual(['1', '2']);
    expect(searchSavedFilters(list, 'VIP').map((f) => f.id)).toEqual(['1', '2']);
  });

  it('子串匹配，不要求从头匹配', () => {
    expect(searchSavedFilters(list, '订单').map((f) => f.id)).toEqual(['3']);
  });

  it('无匹配返回空数组', () => {
    expect(searchSavedFilters(list, '不存在的关键字')).toEqual([]);
  });

  it('返回的仍是原对象引用（不破坏列表身份，便于 React key）', () => {
    expect(searchSavedFilters(list, 'VIP')[0]).toBe(list[0]);
  });
});

describe('findSavedFilter', () => {
  it('按 id 取回方案（应用时直接拿 model）', () => {
    const store = createSavedFilterStore(makeStorage());
    const a = saveFilter(store, KEY, 'A', mkModel('amount', '100'));
    if (!a.ok) throw new Error('setup failed');
    const found = findSavedFilter(store, KEY, a.filter.id);
    expect(found?.name).toBe('A');
    expect(found?.model.groups[0].conditions[0].column).toBe('amount');
    expect(findSavedFilter(store, KEY, 'nope')).toBeNull();
  });
});

describe('降级：存储异常与脏数据', () => {
  it('getItem 抛异常 → 列表为空，不崩', () => {
    const store = createSavedFilterStore(makeStorage({ throwOnGet: true }));
    expect(listSavedFilters(store, KEY)).toEqual([]);
  });

  it('setItem 抛异常 → saveFilter 仍返回成功（只在内存生效）', () => {
    const store = createSavedFilterStore(makeStorage({ throwOnSet: true }));
    const r = saveFilter(store, KEY, 'A', mkModel());
    expect(r.ok).toBe(true);
  });

  it('没有 storage（node 无 localStorage）也不崩，只是不落盘', () => {
    const store = createSavedFilterStore(undefined);
    const r = saveFilter(store, KEY, 'A', mkModel());
    expect(r.ok).toBe(true);
    // 每次都重读存储，读不到就是空 —— 调用方据此知道"本次未持久化"
    expect(listSavedFilters(store, KEY)).toEqual([]);
  });

  it('JSON 损坏 → 空列表（整份读不出来就当没有，不许抛）', () => {
    const store = createSavedFilterStore(makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: '{not-json' } }));
    expect(listSavedFilters(store, KEY)).toEqual([]);
  });

  it('顶层不是对象（数组/字符串）→ 空列表', () => {
    const s1 = makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: '[]' } });
    expect(listSavedFilters(createSavedFilterStore(s1), KEY)).toEqual([]);
    const s2 = makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: '"hello"' } });
    expect(listSavedFilters(createSavedFilterStore(s2), KEY)).toEqual([]);
  });

  it('某张表的值不是数组 → 只跳过该表，其它表照常读出', () => {
    const raw = JSON.stringify({ [KEY]: 'oops', 'c1::db::users': [{ id: 'u1', name: 'U', model: EMPTY_MODEL }] });
    const store = createSavedFilterStore(makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: raw } }));
    expect(listSavedFilters(store, KEY)).toEqual([]);
    expect(listSavedFilters(store, 'c1::db::users').map((f) => f.name)).toEqual(['U']);
  });

  it('脏条目逐条降级：缺 id / 缺 name / model 不是对象 的被丢，合法的保留', () => {
    const raw = JSON.stringify({
      [KEY]: [
        { id: 'ok', name: '完好', model: mkModel('a'), createdAt: 1, updatedAt: 2 },
        null,
        42,
        { name: '没有 id', model: mkModel('b') },
        { id: 'x2', model: mkModel('c') },
        { id: 'x3', name: '   ', model: mkModel('d') },
        { id: 'x4', name: 'model 坏了', model: { nope: 1 } },
        { id: 'x5', name: '时间戳缺失', model: mkModel('e') },
      ],
    });
    const store = createSavedFilterStore(makeStorage({ initial: { [SAVED_FILTERS_STORAGE_KEY]: raw } }));
    const list = listSavedFilters(store, KEY);
    expect(list.map((f) => f.name)).toEqual(['完好', '时间戳缺失']);
    // 时间戳缺失的补 0，排序时排在后面
    expect(list[1].createdAt).toBe(0);
    expect(list[1].updatedAt).toBe(0);
  });

  it('更新以存储的最新值为基准（不用调用方手里的过期快照）', () => {
    const s = makeStorage();
    const store1 = createSavedFilterStore(s);
    const store2 = createSavedFilterStore(s);
    const a = saveFilter(store1, KEY, 'A', mkModel('a'));
    const b = saveFilter(store2, KEY, 'B', mkModel('b'));
    if (!a.ok || !b.ok) throw new Error('setup failed');
    // store1 手里没读过 'B'，再存一条也要带上 B
    saveFilter(store1, KEY, 'C', mkModel('c'));
    expect(listSavedFilters(store2, KEY).map((f) => f.name).sort()).toEqual(['A', 'B', 'C']);
  });
});
