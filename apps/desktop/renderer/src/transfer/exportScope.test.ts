import { describe, it, expect } from 'vitest';
import {
  describeColumnScope,
  describeScopeOptions,
  resolveExport,
  type ScopeFacts,
} from './exportScope';

/** 表 tab 的完整能力：有选区、已加载一页、网格上报了 2 个可见列（共 4 列） */
const TABLE_FACTS: ScopeFacts = {
  hasSql: false,
  hasTable: true,
  filterActive: true,
  selectionRowCount: 3,
  loadedRowCount: 3000,
  visibleColumnCount: 2,
  columnCount: 4,
};

const COLUMNS = [{ name: 'id' }, { name: 'name' }, { name: 'flag' }, { name: 'note' }];

describe('describeScopeOptions · 四种范围口径与快照/重查标记', () => {
  it('选项顺序固定，来源判定为 选区/已加载=快照、全部匹配/整库=重查', () => {
    const opts = describeScopeOptions(TABLE_FACTS);
    expect(opts.map((o) => o.id)).toEqual(['selection', 'loaded', 'matched', 'database']);
    expect(opts.map((o) => o.source)).toEqual(['snapshot', 'snapshot', 'requery', 'requery']);
    expect(opts.every((o) => o.enabled)).toBe(true);
  });

  it('🔴 每个可用选项的说明都以「快照：」或「重查：」开头（用户能直接看出差异）', () => {
    for (const opt of describeScopeOptions(TABLE_FACTS)) {
      const prefix = opt.source === 'snapshot' ? '快照：' : '重查：';
      expect(opt.hint.startsWith(prefix), `${opt.id} 的说明未明示来源：${opt.hint}`).toBe(true);
    }
  });

  it('没有快照能力（宿主没给行）→ 选区/已加载禁用且给出原因，全部匹配仍可用', () => {
    const opts = describeScopeOptions({
      ...TABLE_FACTS,
      selectionRowCount: null,
      loadedRowCount: null,
    });
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    expect(byId.selection.enabled).toBe(false);
    expect(byId.selection.disabledReason).toContain('快照');
    expect(byId.loaded.enabled).toBe(false);
    expect(byId.loaded.disabledReason).toContain('快照');
    expect(byId.matched.enabled).toBe(true);
    expect(byId.matched.disabledReason).toBeNull();
  });

  it('选区为 0 行 → 禁用原因是「没有选中的行」，不是笼统的不可用', () => {
    const opts = describeScopeOptions({ ...TABLE_FACTS, selectionRowCount: 0 });
    const selection = opts.find((o) => o.id === 'selection')!;
    expect(selection.enabled).toBe(false);
    expect(selection.disabledReason).toBe('当前没有选中的行');
  });

  it('表未在网格打开（没有已加载快照）时，全部匹配的说明不提「当前已加载内容」', () => {
    const matched = describeScopeOptions({
      ...TABLE_FACTS,
      filterActive: false,
      selectionRowCount: null,
      loadedRowCount: null,
    }).find((o) => o.id === 'matched')!;
    expect(matched.hint.startsWith('重查：')).toBe(true);
    expect(matched.hint).toContain('不是快照');
    expect(matched.hint).not.toContain('已加载内容的快照');
  });

  it('自定义 SQL 结果集：整库禁用并说明原因，全部匹配明确点出「重新执行」而非快照', () => {
    const opts = describeScopeOptions({
      ...TABLE_FACTS,
      hasSql: true,
      hasTable: false,
      selectionRowCount: null,
      loadedRowCount: null,
      visibleColumnCount: null,
      columnCount: 0,
    });
    const db = opts.find((o) => o.id === 'database')!;
    expect(db.enabled).toBe(false);
    expect(db.disabledReason).toContain('库范围');
    const matched = opts.find((o) => o.id === 'matched')!;
    expect(matched.enabled).toBe(true);
    expect(matched.hint).toContain('重新执行');
    expect(matched.hint).toContain('不是屏幕上这份结果的快照');
  });
});

describe('0.7.3（P1-24）库级入口：只有「整库」可用', () => {
  /** 库节点右键导出：有库、没表、没 SQL、也没有网格快照 */
  const DB_ONLY: ScopeFacts = {
    hasSql: false,
    hasTable: false,
    hasDatabase: true,
    filterActive: false,
    selectionRowCount: null,
    loadedRowCount: null,
    visibleColumnCount: null,
    columnCount: 0,
  };

  it('整库可用，其余三项禁用且各有原因', () => {
    const byId = Object.fromEntries(describeScopeOptions(DB_ONLY).map((o) => [o.id, o]));
    expect(byId.database.enabled).toBe(true);
    expect(byId.database.disabledReason).toBeNull();
    // 没有表上下文 ⇒ 「全部匹配」不可点（否则会导出一张不存在的表）
    expect(byId.matched.enabled).toBe(false);
    expect(byId.matched.disabledReason).toBeTruthy();
    expect(byId.selection.enabled).toBe(false);
    expect(byId.loaded.enabled).toBe(false);
  });

  it('🔴 不带 hasDatabase 时整库仍然禁用（证明这个开关真的在起作用，不是恒真）', () => {
    const db = describeScopeOptions({ ...DB_ONLY, hasDatabase: false }).find((o) => o.id === 'database')!;
    expect(db.enabled).toBe(false);
    expect(db.disabledReason).toBe('需要表或库上下文');
  });

  it('自定义 SQL 结果集即使标了 hasDatabase，整库也禁用（SQL 没有库范围）', () => {
    const db = describeScopeOptions({ ...DB_ONLY, hasSql: true }).find((o) => o.id === 'database')!;
    expect(db.enabled).toBe(false);
    expect(db.disabledReason).toContain('库范围');
  });
});

describe('describeColumnScope · 仅可见列开关的可用性', () => {
  it('表重查 / 快照：可见列已上报 → 可用', () => {
    expect(describeColumnScope(TABLE_FACTS, 'matched')).toMatchObject({ enabled: true, reason: null, visible: 2, total: 4 });
    expect(describeColumnScope(TABLE_FACTS, 'selection').enabled).toBe(true);
  });

  it('整库没有「可见列」概念 → 禁用', () => {
    const r = describeColumnScope(TABLE_FACTS, 'database');
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain('全列');
  });

  it('重查自定义 SQL → 禁用（改写列清单会破坏语义）', () => {
    const r = describeColumnScope({ ...TABLE_FACTS, hasSql: true }, 'matched');
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain('破坏语义');
  });

  it('网格未上报可见列 → 禁用并说明', () => {
    const r = describeColumnScope({ ...TABLE_FACTS, visibleColumnCount: null }, 'loaded');
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain('未上报');
  });
});

describe('resolveExport · 三种范围 + 仅可见列', () => {
  it('选区：只输出传入的选中行，且列裁剪必须连行一起裁（表头与数据同宽）', () => {
    const r = resolveExport({
      scope: 'selection',
      database: 'd',
      tableName: 't',
      rows: [
        [1, 'a', true, null],
        [2, 'b', false, null],
      ],
      columns: COLUMNS,
      visibleColumns: ['id', 'flag'],
      onlyVisibleColumns: true,
    });
    expect(r.source).toBe('snapshot');
    expect(r.sql).toBeNull();
    expect(r.rowCount).toBe(2);
    // 列顺序保持网格顺序（flag 原本在 id 之后）
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'flag']);
    // 🔴 行也要裁：否则表头 2 列、数据 4 列，文件列全串位
    expect(r.rows).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('当前已加载 ≠ 全部匹配：已加载返回快照行且不带 SQL；同一批数据按全部匹配走重查', () => {
    const rows = [
      [1, 'a', true, null],
      [2, 'b', false, null],
    ];
    const loaded = resolveExport({ scope: 'loaded', database: 'd', tableName: 't', rows, columns: COLUMNS });
    expect(loaded).toMatchObject({ source: 'snapshot', sql: null, rowCount: 2 });
    expect(loaded.rows).toEqual(rows);

    const matched = resolveExport({ scope: 'matched', database: 'd', tableName: 't', columns: COLUMNS });
    expect(matched.source).toBe('requery');
    expect(matched.rows).toBeNull();
    expect(matched.rowCount).toBeNull();
  });

  it('全部匹配（有筛选）：重建带 WHERE 的 SELECT，来源标记为重查', () => {
    const r = resolveExport({ scope: 'matched', database: 'order_db', tableName: 'orders', where: '`id` > 10' });
    expect(r.source).toBe('requery');
    expect(r.sql).toBe('SELECT * FROM `order_db`.`orders` WHERE `id` > 10');
    expect(r.rows).toBeNull();
  });

  it('全部匹配（无筛选）：sql 为 null = worker 的 SELECT * 兜底，但来源仍是重查', () => {
    const r = resolveExport({ scope: 'matched', database: 'd', tableName: 't', where: '   ' });
    expect(r.sql).toBeNull();
    expect(r.source).toBe('requery');
  });

  it('全部匹配 + 仅可见列：SQL 里写死列清单（否则 worker 的 SELECT * 会带出全部列）', () => {
    const r = resolveExport({
      scope: 'matched',
      database: 'd',
      tableName: 't',
      where: '`id` > 5',
      columns: COLUMNS,
      visibleColumns: ['id', 'flag'],
      onlyVisibleColumns: true,
    });
    expect(r.sql).toBe('SELECT `id`, `flag` FROM `d`.`t` WHERE `id` > 5');
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'flag']);
  });

  it('全部匹配（自定义 SQL）：原样重查，不改写语句与列', () => {
    const r = resolveExport({ scope: 'matched', database: 'd', querySql: '  SELECT NOW() AS t  ' });
    expect(r.source).toBe('requery');
    expect(r.sql).toBe('SELECT NOW() AS t');
    expect(r.rows).toBeNull();
  });

  it('整库：逐表重查，没有列', () => {
    const r = resolveExport({ scope: 'database', database: 'd' });
    expect(r).toMatchObject({ source: 'requery', sql: null, rows: null, columns: [], rowCount: null });
  });

  it('范围与数据不匹配时抛中文原因，而不是悄悄降级成别的范围', () => {
    expect(() => resolveExport({ scope: 'selection', database: 'd', columns: COLUMNS })).toThrow('没有选区快照');
    expect(() => resolveExport({ scope: 'selection', database: 'd', rows: [], columns: COLUMNS })).toThrow('选区为空');
    expect(() => resolveExport({ scope: 'loaded', database: 'd', columns: COLUMNS })).toThrow('没有已加载行快照');
    expect(() => resolveExport({ scope: 'matched', database: 'd', querySql: 'SELECT 1' })).not.toThrow();
    expect(() => resolveExport({ scope: 'matched', database: 'd' })).toThrow('没有表上下文');
    expect(() =>
      resolveExport({ scope: 'matched', database: 'd', querySql: 'SELECT 1', onlyVisibleColumns: true, columns: COLUMNS }),
    ).toThrow('不能只导出可见列');
    expect(() => resolveExport({ scope: 'database', database: 'd', querySql: 'SELECT 1' })).toThrow('没有整库范围');
    expect(() =>
      resolveExport({ scope: 'database', database: 'd', onlyVisibleColumns: true, columns: COLUMNS }),
    ).toThrow('不支持「仅可见列」');
  });

  it('可见列与结果集列对不上时抛错（不静默丢列）', () => {
    expect(() =>
      resolveExport({
        scope: 'loaded',
        database: 'd',
        rows: [[1, 'a']],
        columns: [{ name: 'id' }, { name: 'name' }],
        visibleColumns: ['id', 'ghost'],
        onlyVisibleColumns: true,
      }),
    ).toThrow('可见列不在结果集中：ghost');
    expect(() =>
      resolveExport({
        scope: 'loaded',
        database: 'd',
        rows: [[1]],
        columns: [{ name: 'id' }],
        visibleColumns: null,
        onlyVisibleColumns: true,
      }),
    ).toThrow('未上报可见列');
  });
});
