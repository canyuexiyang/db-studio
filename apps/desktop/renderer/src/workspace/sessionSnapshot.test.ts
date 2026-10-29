/**
 * F4 会话快照纯逻辑测试：序列化瘦身、截断、损坏防御、持久化降级。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceTab, TableTabState, QueryTabState } from './useWorkspaceTabs';
import {
  serializeSession,
  restorePlan,
  loadSessionSnapshot,
  saveSessionSnapshot,
  clearSessionSnapshot,
  SESSION_MAX_TABS,
  SESSION_MAX_SQL_CHARS,
  SESSION_STORAGE_KEY,
} from './sessionSnapshot';

// ---- 测试用 tab 构造（只填序列化会用到的字段，结构对齐 useWorkspaceTabs） ----

function tableTab(over: Partial<TableTabState> = {}): TableTabState {
  return {
    id: 't1',
    kind: 'table',
    title: 'users',
    connId: 'conn-1',
    database: 'shop',
    tableName: 'users',
    table: {} as TableTabState['table'], // 序列化绝不该碰它 —— 塞个空对象监控
    payload: null,
    sorts: [],
    filter: null,
    truncated: false,
    queryMs: null,
    loading: false,
    // T47：加载错误也属于 tab 状态的一部分（序列化不该碰它）
    loadError: null,
    dirtyCount: 0,
    ...over,
  };
}

function queryTab(over: Partial<QueryTabState> = {}): QueryTabState {
  return {
    id: 'q1',
    kind: 'query',
    title: '查询 1',
    connId: 'conn-1',
    database: 'shop',
    initialSql: 'SELECT 1',
    ...over,
  };
}

describe('serializeSession：只存轻量元数据', () => {
  it('table tab 只留 connId/database/tableName，不带 payload/table', () => {
    const payload = { rowCount: 3, columns: [], buffers: [], bufferCounts: [] };
    const snap = serializeSession(
      [tableTab({ payload: payload as unknown as TableTabState['payload'], tableName: 'users' })],
      't1',
    );
    expect(snap.version).toBe(1);
    expect(snap.tabs).toEqual([{ kind: 'table', connId: 'conn-1', database: 'shop', tableName: 'users' }]);
    // 🔴 payload/table 绝不能混进快照（可序列化性 + 体积）
    expect(JSON.stringify(snap)).not.toContain('rowCount');
  });

  it('query tab 留 connId/database/initialSql', () => {
    const snap = serializeSession([queryTab({ initialSql: 'SELECT * FROM o' })], 'q1');
    expect(snap.tabs).toEqual([
      { kind: 'query', connId: 'conn-1', database: 'shop', initialSql: 'SELECT * FROM o' },
    ]);
  });

  it('超过 20 个标签截断保留前 20 个（顺序即心智顺序）', () => {
    const tabs: WorkspaceTab[] = Array.from({ length: 25 }, (_, i) =>
      queryTab({ id: `q${i}`, title: `查询 ${i}` }),
    );
    const snap = serializeSession(tabs, 'q0');
    expect(snap.tabs.length).toBe(SESSION_MAX_TABS);
    expect(snap.tabs[0]).toMatchObject({ kind: 'query', initialSql: 'SELECT 1' });
    expect(snap.tabs).toHaveLength(20);
  });

  it('initialSql 超过 100KB 被截断（保留开头）', () => {
    const big = 'A'.repeat(SESSION_MAX_SQL_CHARS + 100);
    const snap = serializeSession([queryTab({ initialSql: big })], null);
    expect(snap.tabs[0]).toMatchObject({ kind: 'query' });
    expect((snap.tabs[0] as { initialSql: string }).initialSql.length).toBe(SESSION_MAX_SQL_CHARS);
  });

  it('activeId 不进快照（不跨会话恢复）', () => {
    const snap = serializeSession([queryTab()], 'q1');
    expect(JSON.stringify(snap)).not.toContain('q1');
  });
});

describe('restorePlan：损坏数据返回空', () => {
  it('合法快照正常恢复', () => {
    const snap = serializeSession([tableTab(), queryTab({ connId: null, database: null })], 't1');
    const plan = restorePlan(JSON.parse(JSON.stringify(snap)));
    expect(plan).toEqual([
      { kind: 'table', connId: 'conn-1', database: 'shop', tableName: 'users' },
      { kind: 'query', connId: null, database: null, initialSql: 'SELECT 1' },
    ]);
  });

  it.each([
    ['null', null],
    ['非对象', 42],
    ['版本不符', { version: 2, tabs: [] }],
    ['tabs 不是数组', { version: 1, tabs: 'x' }],
    ['条目非对象', { version: 1, tabs: [1] }],
    ['未知 kind', { version: 1, tabs: [{ kind: 'grid', connId: 'c' }] }],
    ['table 缺 tableName', { version: 1, tabs: [{ kind: 'table', connId: 'c', database: 'd' }] }],
    ['table 空串 connId', { version: 1, tabs: [{ kind: 'table', connId: '', database: 'd', tableName: 't' }] }],
    ['query initialSql 非字符串', { version: 1, tabs: [{ kind: 'query', connId: null, database: null, initialSql: 1 }] }],
  ])('%s → 空数组', (_name, input) => {
    expect(restorePlan(input)).toEqual([]);
  });

  it('一条损坏整体放弃（半份恢复计划比不恢复更困惑）', () => {
    const ok = { kind: 'table', connId: 'c', database: 'd', tableName: 't' };
    expect(restorePlan({ version: 1, tabs: [ok, { kind: 'table' }] })).toEqual([]);
  });

  it('恢复条目超过 20 也截断（防手改 localStorage）', () => {
    const tabs = Array.from({ length: 30 }, () => ({ kind: 'query', connId: null, database: null, initialSql: '' }));
    expect(restorePlan({ version: 1, tabs })).toHaveLength(SESSION_MAX_TABS);
  });
});

/**
 * 🔴 快照里的 connId 可能已经不存在（连接被删 / 换机器 / 换 userData）。
 *
 * 现场：真机 e2e 互相污染时抓到 —— 上次退出留下的快照被恢复成一个指向已删连接的
 * query 标签，状态栏显示「连接：未知」，执行按钮只判 `!connId` 所以照样可点，
 * 一点必然 NOT_CONNECTED。**"能点但必然失败"比"不恢复"更糟。**
 */
describe('restorePlan：指向已删除连接的标签不得恢复', () => {
  const known = (ids: string[]) => (connId: string) => ids.includes(connId);

  it('query / table 两条都指向已删连接 → 全部丢弃', () => {
    const snap = {
      version: 1,
      tabs: [
        { kind: 'query', connId: 'ghost-conn', database: null, initialSql: 'SELECT 1' },
        { kind: 'table', connId: 'ghost-conn', database: 'shop', tableName: 'users' },
      ],
    };
    expect(restorePlan(snap, known(['conn-1']))).toEqual([]);
  });

  it('只丢已删的那条，其余照常恢复（别把好的一起丢掉）', () => {
    const snap = {
      version: 1,
      tabs: [
        { kind: 'table', connId: 'conn-1', database: 'shop', tableName: 'users' },
        { kind: 'query', connId: 'ghost-conn', database: null, initialSql: 'SELECT 1' },
      ],
    };
    expect(restorePlan(snap, known(['conn-1']))).toEqual([
      { kind: 'table', connId: 'conn-1', database: 'shop', tableName: 'users' },
    ]);
  });

  it('未绑定连接的 query 标签（connId=null）不受过滤影响 —— 它本就要靠当前上下文兜底', () => {
    const snap = { version: 1, tabs: [{ kind: 'query', connId: null, database: null, initialSql: 'SELECT 1' }] };
    expect(restorePlan(snap, known(['conn-1']))).toHaveLength(1);
  });

  it('不传判据 = 不过滤（既有调用方行为不变）', () => {
    const snap = { version: 1, tabs: [{ kind: 'table', connId: 'ghost-conn', database: 'd', tableName: 't' }] };
    expect(restorePlan(snap)).toHaveLength(1);
  });
});

// ---- localStorage 持久化 ----

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

let store: Map<string, string> | null = null;

beforeEach(() => {
  store = stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store = null;
});

describe('loadSessionSnapshot / saveSessionSnapshot / clearSessionSnapshot', () => {
  it('保存后读回同样的计划', () => {
    const snap = serializeSession([tableTab(), queryTab()], 't1');
    saveSessionSnapshot(snap);
    expect(store!.has(SESSION_STORAGE_KEY)).toBe(true);
    const loaded = loadSessionSnapshot();
    expect(loaded?.tabs).toEqual(snap.tabs);
  });

  it('没有记录返回 null', () => {
    expect(loadSessionSnapshot()).toBeNull();
  });

  it('损坏 JSON 返回 null（不抛异常）', () => {
    store!.set(SESSION_STORAGE_KEY, '{oops');
    expect(loadSessionSnapshot()).toBeNull();
  });

  it('结构不合法返回 null', () => {
    store!.set(SESSION_STORAGE_KEY, JSON.stringify({ version: 9, tabs: [] }));
    expect(loadSessionSnapshot()).toBeNull();
  });

  it('写失败静默（配额满/隐私模式）', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    const snap = serializeSession([queryTab()], null);
    expect(() => saveSessionSnapshot(snap)).not.toThrow();
    expect(() => clearSessionSnapshot()).not.toThrow();
  });

  it('清除后读不到', () => {
    saveSessionSnapshot(serializeSession([queryTab()], null));
    clearSessionSnapshot();
    expect(loadSessionSnapshot()).toBeNull();
  });
});

/**
 * P2-18e：恢复后要落回关闭前正在看的那个标签。
 *
 * 存的是**下标**不是 id（tab id 每次启动重新生成，旧 id 必然失效）。
 * 这里的断言分两半：
 *  1. 序列化时能算出正确的 activeIndex（含"激活项在第 20 个之后"的退化）；
 *  2. 恢复时，被筛掉的标签（连接已删）会让下标错位 —— 必须换算，不能直接照搬。
 */
describe('P2-18e：activeIndex 会话恢复', () => {
  it('记录激活标签的下标', () => {
    const tabs = [tableTab({ id: 't1' }), queryTab({ id: 'q2' }), tableTab({ id: 't3', tableName: 'orders' })];
    expect(serializeSession(tabs, 'q2').activeIndex).toBe(1);
    expect(serializeSession(tabs, 't3').activeIndex).toBe(2);
  });

  it('activeId 已失效 / 为 null → 落到 0（不产生越界下标）', () => {
    const tabs = [tableTab({ id: 't1' }), queryTab({ id: 'q2' })];
    expect(serializeSession(tabs, null).activeIndex).toBe(0);
    expect(serializeSession(tabs, 'gone').activeIndex).toBe(0);
  });

  it('激活项在第 20 个之后 → 退化到 0（那个标签根本不会被恢复）', () => {
    const tabs = Array.from({ length: SESSION_MAX_TABS + 3 }, (_, i) => queryTab({ id: `q${i}` }));
    const snap = serializeSession(tabs, `q${SESSION_MAX_TABS + 2}`);
    expect(snap.tabs).toHaveLength(SESSION_MAX_TABS);
    expect(snap.activeIndex).toBe(0);
  });

  it('读回时 activeIndex 原样保留', () => {
    const snap = serializeSession([tableTab({ id: 't1' }), queryTab({ id: 'q2' })], 'q2');
    saveSessionSnapshot(snap);
    expect(loadSessionSnapshot()?.activeIndex).toBe(1);
  });

  it('🔴 前面的标签因连接已删被筛掉 → 下标要跟着换算（否则会激活错的标签）', () => {
    // 三个标签，第一个指向已删除的 conn-x；激活的是最后一个（原下标 2）
    const snap = serializeSession(
      [
        tableTab({ id: 't1', connId: 'conn-x' }),
        queryTab({ id: 'q2' }),
        tableTab({ id: 't3', tableName: 'orders' }),
      ],
      't3',
    );
    expect(snap.activeIndex).toBe(2);
    saveSessionSnapshot(snap);

    const loaded = loadSessionSnapshot((id) => id !== 'conn-x');
    expect(loaded?.tabs).toHaveLength(2);
    // 原下标 2 在过滤后的列表里是 1 —— 照搬 2 会越界，退到 0 则会激活错误的标签
    expect(loaded?.activeIndex).toBe(1);
  });

  it('激活的那个标签本身被筛掉 → 退到 0（总有标签可见）', () => {
    const snap = serializeSession(
      [queryTab({ id: 'q1' }), tableTab({ id: 't2', connId: 'conn-x' })],
      't2',
    );
    saveSessionSnapshot(snap);
    const loaded = loadSessionSnapshot((id) => id !== 'conn-x');
    expect(loaded?.tabs).toHaveLength(1);
    expect(loaded?.activeIndex).toBe(0);
  });

  it('旧快照没有 activeIndex 字段 → 0（向后兼容，不炸）', () => {
    store!.set(
      SESSION_STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: 1, tabs: [{ kind: 'query', connId: 'conn-1', database: 'shop', initialSql: 'SELECT 1' }] }),
    );
    expect(loadSessionSnapshot()?.activeIndex).toBe(0);
  });
});
