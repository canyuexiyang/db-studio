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
