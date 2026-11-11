import { describe, expect, it } from 'vitest';
import { needsStateBlock, resolveGridState, rowCountBasis, type GridStateInput } from './gridStates';

const base: GridStateInput = {
  disconnected: false,
  loading: false,
  error: null,
  hasPayload: true,
  rowCount: 5,
};

function state(patch: Partial<GridStateInput>) {
  return resolveGridState({ ...base, ...patch });
}

describe('T47 resolveGridState', () => {
  it('六种状态各自的 kind 互不重叠', () => {
    expect(state({ loading: true }).kind).toBe('loading');
    expect(state({ error: 'Access denied' }).kind).toBe('error');
    expect(state({ disconnected: true }).kind).toBe('disconnected');
    expect(state({ hasPayload: false }).kind).toBe('idle');
    expect(state({ rowCount: 0 }).kind).toBe('empty');
    expect(state({}).kind).toBe('ready');
  });

  it('每种空白态的主文案互不相同（共用一句话等于没区分）', () => {
    const titles = [
      state({ loading: true }).title,
      state({ error: 'x' }).title,
      state({ disconnected: true }).title,
      state({ hasPayload: false }).title,
      state({ rowCount: 0 }).title,
    ];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('loading 优先于 error：重试时先显示加载中，而不是继续挂旧错误', () => {
    expect(state({ loading: true, error: '上一轮的失败' }).kind).toBe('loading');
  });

  it('error 优先于 disconnected：原始错误不能被「已断开」吞掉', () => {
    const s = state({ error: 'ER_ACCESS_DENIED_ERROR: Access denied', disconnected: true });
    expect(s.kind).toBe('error');
    expect(s.hint).toContain('Access denied');
  });

  it('断开且未查询 → disconnected（不是「尚未查询」）', () => {
    expect(state({ disconnected: true, hasPayload: false }).kind).toBe('disconnected');
  });

  it('有载荷但零行 → empty，且提示与 idle 不同', () => {
    const empty = state({ rowCount: 0 });
    const idle = state({ hasPayload: false });
    expect(empty.kind).toBe('empty');
    expect(empty.hint).not.toBe(idle.hint);
  });

  it('有行时 ready 不占位（不遮住网格）', () => {
    const s = state({});
    expect(needsStateBlock(s)).toBe(false);
    // 对照组：空白态必须占位
    expect(needsStateBlock(state({ rowCount: 0 }))).toBe(true);
  });

  // P0-4：空表点「新增空白行」后 payload.rowCount 仍是 0，
  // 若继续判 empty 就整块不渲染 DataGrid —— 刚加的行看不见。
  it('零行但有草稿新增行 → ready，网格必须交回 DataGrid 渲染', () => {
    const s = state({ rowCount: 0, extraRows: 1 });
    expect(s.kind).toBe('ready');
    expect(needsStateBlock(s)).toBe(false);
  });

  it('对照：零行且没有草稿行仍是 empty（新增入口不会凭空消失）', () => {
    const s = state({ rowCount: 0, extraRows: 0 });
    expect(s.kind).toBe('empty');
    expect(needsStateBlock(s)).toBe(true);
  });

  it('loading 优先于草稿行：重拉数据时不能把加载态误判成 ready', () => {
    expect(state({ rowCount: 0, extraRows: 2, loading: true }).kind).toBe('loading');
  });

  // 0.7.5：零行的两种成因必须分开说（筛选无结果 vs 空表），且互作对照
  it('零行 + hasFilter → 文案指向「筛选条件」，提示放宽/清空', () => {
    const s = state({ rowCount: 0, hasFilter: true });
    expect(s.kind).toBe('empty');
    expect(s.title).toContain('筛选条件');
    expect(s.hint).toMatch(/放宽|清空/);
  });

  it('对照：零行 + 无 hasFilter → 文案指向「还没有数据」，提示新增行', () => {
    const s = state({ rowCount: 0 });
    expect(s.kind).toBe('empty');
    expect(s.title).toContain('还没有数据');
    expect(s.title).not.toContain('筛选');
    expect(s.hint).toContain('新增');
  });

  it('对照：两种零行文案的主文案与提示都不能共用一句话', () => {
    const filtered = state({ rowCount: 0, hasFilter: true });
    const empty = state({ rowCount: 0, hasFilter: false });
    expect(filtered.title).not.toBe(empty.title);
    expect(filtered.hint).not.toBe(empty.hint);
    // 缺省（不传）与显式 false 同义 —— 宿主没接线时不能悄悄变成「筛选」口径
    expect(state({ rowCount: 0 }).title).toBe(empty.title);
  });

  it('hasFilter 只改文案，不改优先级：仍是 empty 且需要占位', () => {
    const s = state({ rowCount: 0, hasFilter: true });
    expect(needsStateBlock(s)).toBe(true);
    expect(state({ rowCount: 0, hasFilter: true, loading: true }).kind).toBe('loading');
    expect(state({ rowCount: 0, hasFilter: true, error: 'boom' }).kind).toBe('error');
    expect(state({ rowCount: 0, hasFilter: true, disconnected: true }).kind).toBe('disconnected');
    expect(state({ rowCount: 0, hasFilter: true, hasPayload: false }).kind).toBe('idle');
  });

  it('对照：草稿新增行仍优先于筛选文案（零行 + hasFilter + extraRows → ready）', () => {
    const s = state({ rowCount: 0, hasFilter: true, extraRows: 1 });
    expect(s.kind).toBe('ready');
    expect(needsStateBlock(s)).toBe(false);
  });
});

describe('T47 rowCountBasis', () => {
  it('未查询 → none（不给任何数字）', () => {
    expect(rowCountBasis({ rowCount: 0, estimated: 1000, truncated: false, hasPayload: false }).basis).toBe(
      'none',
    );
  });

  it('无估算且未截断 → exact', () => {
    const r = rowCountBasis({ rowCount: 30, estimated: null, truncated: false, hasPayload: true });
    expect(r.basis).toBe('exact');
    expect(r.exact).toBe(true);
    expect(r.label).toBe('30 行');
  });

  it('估算值大于已加载 → estimated，且不得标记为精确', () => {
    const r = rowCountBasis({ rowCount: 500, estimated: 12000, truncated: false, hasPayload: true });
    expect(r.basis).toBe('estimated');
    expect(r.exact).toBe(false);
    expect(r.label).toContain('约');
  });

  it('截断时同时说「已截断」与估算行数，不能只给一个总数', () => {
    const r = rowCountBasis({ rowCount: 1000, estimated: 1_000_000, truncated: true, hasPayload: true });
    expect(r.basis).toBe('truncated');
    expect(r.label).toContain('已截断');
    expect(r.label).toContain('已加载 1,000 行');
    expect(r.exact).toBe(false);
  });

  it('截断但估算缺失 → 仍要说「已截断」', () => {
    const r = rowCountBasis({ rowCount: 1000, estimated: null, truncated: true, hasPayload: true });
    expect(r.label).toBe('已加载 1,000 行（已截断）');
  });

  it('对照：截断与非截断在同样行数下文案必须不同', () => {
    const a = rowCountBasis({ rowCount: 1000, estimated: 1000, truncated: true, hasPayload: true });
    const b = rowCountBasis({ rowCount: 1000, estimated: 1000, truncated: false, hasPayload: true });
    expect(a.label).not.toBe(b.label);
  });
});
