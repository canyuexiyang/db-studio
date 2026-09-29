import { describe, it, expect } from 'vitest';
import {
  buildTree,
  flattenTree,
  defaultExpanded,
  saveExpansion,
  restoreExpansion,
  toggleExpanded,
  expandAncestors,
  emptyMemory,
  searchTree,
  filterFlatByQuery,
  buildColumnIndex,
  confirmLevelFor,
  OBJECT_KIND_LABELS,
  EXPANSION_MEMORY_VERSION,
} from './index.js';
import { defaultConnectionConfig } from '@dbstudio/core-connection';
import type { DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';

function col(name: string) {
  return {
    name,
    dataType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
  };
}

function table(name: string, kind: TableMeta['kind'] = 'table'): TableMeta {
  return {
    name,
    kind,
    comment: null,
    estimatedRows: 100,
    engine: 'InnoDB',
    collation: null,
    columns: [col('id'), col('name')],
  };
}

function db(name: string, tables: TableMeta[] = [table('order'), table('user'), table('v_order', 'view')]): DatabaseMeta {
  return { name, charset: 'utf8mb4', collation: 'utf8mb4_general_ci', tables };
}

/** colorTag 的实际类型是 ColorTag | null，"无标签"是 null 而不是 'none' */
function conn(id: string, name: string, group = '', colorTag: 'red' | 'blue' | null = null) {
  const c = defaultConnectionConfig();
  return { ...c, id, name, group, colorTag };
}

describe('建树', () => {
  it('分组 → 连接 → 数据库 → 对象类型 → 对象，五层结构', () => {
    const roots = buildTree({
      connections: [conn('c1', 'prod_order', '生产环境', 'red')],
      schemas: { c1: [db('order_db')] },
    });

    expect(roots[0].label).toBe('生产环境');
    const c = roots[0].children![0];
    expect(c.label).toBe('prod_order');
    expect(c.danger).toBe(true); // 红色标签 = 生产
    const d = c.children![0];
    expect(d.label).toBe('order_db');
    expect(d.children!.map((n) => n.label)).toEqual(['表', '视图', '存储过程', '函数', '触发器', '事件']);
    expect(d.children![0].badge).toBe(2); // 两张表
    expect(d.children![0].children!.map((n) => n.label)).toEqual(['order', 'user']);
    expect(d.children![1].children!.map((n) => n.label)).toEqual(['v_order']);
  });

  it('未加载 schema 的连接标记为未加载（懒加载入口）', () => {
    const roots = buildTree({ connections: [conn('c1', 'x')], schemas: {} });
    expect(roots[0].children![0].loaded).toBe(false);
    expect(roots[0].children![0].children).toEqual([]);
  });

  it('无连接时返回空树，不抛异常', () => {
    expect(buildTree({ connections: [] })).toEqual([]);
  });

  it('未分组连接归到"未分组"', () => {
    const roots = buildTree({ connections: [conn('c1', 'a'), conn('c2', 'b')] });
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('未分组');
    expect(roots[0].badge).toBe(2);
  });

  it('对象类型文案', () => {
    expect(OBJECT_KIND_LABELS.table).toBe('表');
    expect(OBJECT_KIND_LABELS.view).toBe('视图');
    // C1：触发器/事件进入树分类
    expect(OBJECT_KIND_LABELS.trigger).toBe('触发器');
    expect(OBJECT_KIND_LABELS.event).toBe('事件');
  });

  it('C1：触发器/事件各归各的 kind 节点，badge 与归属正确', () => {
    const dbs: DatabaseMeta[] = [
      {
        name: 'order_db',
        charset: 'utf8mb4',
        collation: null,
        tables: [
          table('order'),
          { ...table('trg_audit', 'trigger'), triggerTable: 'order', triggerTiming: 'AFTER', triggerEvent: 'INSERT' },
          { ...table('evt_nightly', 'event') },
        ],
      },
    ];
    const roots = buildTree({ connections: [conn('c1', 'dev')], schemas: { c1: dbs } });
    const kinds = roots[0].children![0].children![0].children!;
    const triggerNode = kinds.find((n) => n.objectKind === 'trigger')!;
    const eventNode = kinds.find((n) => n.objectKind === 'event')!;
    expect(triggerNode.label).toBe('触发器');
    expect(triggerNode.badge).toBe(1);
    expect(triggerNode.children![0].label).toBe('trg_audit');
    expect(eventNode.label).toBe('事件');
    expect(eventNode.children![0].label).toBe('evt_nightly');
    // 触发器不应混进表/视图分组
    expect(kinds.find((n) => n.objectKind === 'table')!.children!.map((n) => n.label)).toEqual(['order']);
  });
});

describe('扁平化', () => {
  const roots = buildTree({
    connections: [conn('c1', 'prod', '生产环境')],
    schemas: { c1: [db('order_db')] },
  });

  it('未展开时只有根', () => {
    const flat = flattenTree(roots, new Set());
    expect(flat).toHaveLength(1);
    expect(flat[0].depth).toBe(0);
  });

  it('展开的分支才被压平，未展开的子树整段跳过', () => {
    const flat = flattenTree(roots, new Set([roots[0].key]));
    expect(flat.map((f) => f.node.label)).toEqual(['生产环境', 'prod']);
    expect(flat[1].depth).toBe(1);
  });

  it('全展开时可拿到对象节点', () => {
    const all = new Set([roots[0].key, 'conn:c1', 'db:c1:order_db', 'kind:c1:order_db:table']);
    const flat = flattenTree(roots, all);
    const labels = flat.map((f) => f.node.label);
    // 深度优先：表下面的对象紧跟在"表"之后，不是排在所有类型之后
    expect(labels).toEqual([
      '生产环境', 'prod', 'order_db',
      '表', 'order', 'user',
      '视图', '存储过程', '函数', '触发器', '事件',
    ]);
    expect(flat.at(-1)!.depth).toBe(3);
  });

  it('hasChildren / expanded 供渲染三角用', () => {
    const flat = flattenTree(roots, new Set([roots[0].key]));
    expect(flat[0].hasChildren).toBe(true);
    expect(flat[0].expanded).toBe(true);
    expect(flat[1].expanded).toBe(false); // 连接未展开
  });

  it('展开不存在的 key 不影响结果', () => {
    const flat = flattenTree(roots, new Set(['nonexistent']));
    expect(flat).toHaveLength(1);
  });

  it('空树扁平化为空数组', () => {
    expect(flattenTree([], new Set())).toEqual([]);
  });

  it('parentKey 用于搜索时保留祖先链', () => {
    const flat = flattenTree(roots, new Set([roots[0].key, 'conn:c1']));
    expect(flat[0].parentKey).toBeNull();
    expect(flat[1].parentKey).toBe(roots[0].key);
  });
});

describe('展开记忆（D1）', () => {
  const roots = buildTree({
    connections: [conn('c1', 'prod', '生产环境')],
    schemas: { c1: [db('order_db')] },
  });

  it('首次展开到数据库层：分组与连接开，库下的分类不开', () => {
    const set = defaultExpanded(roots);
    expect(set.has(roots[0].key)).toBe(true);
    expect(set.has('conn:c1')).toBe(true);
    expect(set.has('db:c1:order_db')).toBe(false);
    // 压平后能看到库这一层
    const flat = flattenTree(roots, set);
    expect(flat.map((f) => f.node.label)).toEqual(['生产环境', 'prod', 'order_db']);
  });

  it('记住用户展开的节点，下次恢复', () => {
    let set = defaultExpanded(roots);
    set = toggleExpanded(set, 'db:c1:order_db');
    set = toggleExpanded(set, 'kind:c1:order_db:table');
    const mem = saveExpansion(emptyMemory(), set, ['c1']);

    const restored = restoreExpansion(mem, roots, ['c1']);
    expect(restored.has('db:c1:order_db')).toBe(true);
    expect(restored.has('kind:c1:order_db:table')).toBe(true);
  });

  it('表被删了 → 旧 key 静默失效，不报错也不抖', () => {
    const mem: ReturnType<typeof emptyMemory> = {
      version: EXPANSION_MEMORY_VERSION,
      byConnection: { c1: ['db:c1:gone_db', 'kind:c1:gone_db:table', 'db:c1:order_db'] },
      lastOpened: null,
    };
    const restored = restoreExpansion(mem, roots, ['c1']);
    expect(restored.has('db:c1:gone_db')).toBe(false);
    expect(restored.has('db:c1:order_db')).toBe(true);
  });

  it('版本不兼容 → 回落到默认展开', () => {
    const mem = { version: EXPANSION_MEMORY_VERSION + 1, byConnection: { c1: ['db:c1:order_db'] }, lastOpened: null };
    const restored = restoreExpansion(mem, roots, ['c1']);
    expect(restored.has('db:c1:order_db')).toBe(false);
    expect(restored.has('conn:c1')).toBe(true);
  });

  it('记忆为空 → 默认展开', () => {
    expect(restoreExpansion(null, roots, ['c1']).has('conn:c1')).toBe(true);
    expect(restoreExpansion(undefined, roots, ['c1']).has('conn:c1')).toBe(true);
  });

  it('分组与连接始终展开（收起来会让用户找不到库）', () => {
    const mem = emptyMemory();
    const restored = restoreExpansion(mem, roots, ['c1']);
    expect(restored.has(roots[0].key)).toBe(true);
    expect(restored.has('conn:c1')).toBe(true);
  });

  it('toggleExpanded 返回新 Set，不改原对象', () => {
    const set = new Set(['a']);
    const next = toggleExpanded(set, 'b');
    expect(set.has('b')).toBe(false);
    expect(next.has('b')).toBe(true);
    expect(toggleExpanded(next, 'a').has('a')).toBe(false);
  });

  it('expandAncestors 逐级打开到根', () => {
    const set = expandAncestors(new Set(), roots, 'obj:c1:order_db:order');
    expect(set.has('kind:c1:order_db:table')).toBe(true);
    expect(set.has('db:c1:order_db')).toBe(true);
    expect(set.has('conn:c1')).toBe(true);
    expect(set.has(roots[0].key)).toBe(true);
  });

  it('expandAncestors 对不存在的 key 原样返回', () => {
    const before = new Set(['x']);
    expect(expandAncestors(before, roots, 'nope')).toEqual(before);
  });
});

describe('搜索', () => {
  const roots = buildTree({
    connections: [conn('c1', 'prod', '生产环境')],
    schemas: { c1: [db('order_db', [table('order'), table('user'), table('订单明细')])] },
  });
  const allKeys = new Set([
    roots[0].key,
    'conn:c1',
    'db:c1:order_db',
    'kind:c1:order_db:table',
    'kind:c1:order_db:view',
    'kind:c1:order_db:procedure',
    'kind:c1:order_db:function',
  ]);

  it('按表名模糊匹配', () => {
    const hits = searchTree(roots, 'ord');
    expect(hits.map((h) => h.label)).toContain('order');
    expect(hits.every((h) => h.matchedBy === 'name')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(searchTree(roots, 'ORDER').map((h) => h.label)).toContain('order');
  });

  it('拼音首字母：dd → 订单明细', () => {
    const hits = searchTree(roots, 'dd');
    expect(hits.map((h) => h.label)).toContain('订单明细');
  });

  it('Q2：按字段名反查表', () => {
    const hits = searchTree(roots, 'name', { columnIndex: { name: ['order_db.order', 'order_db.user'] } });
    const byColumn = hits.filter((h) => h.matchedBy === 'column');
    expect(byColumn.length).toBe(2);
    expect(byColumn[0].label).toMatch(/含字段 name/);
    // 列命中在树里没有节点，必须带上库/表信息让渲染层跳转
    expect(byColumn[0].database).toBe('order_db');
    expect(byColumn[0].tableName).toBe('order');
  });

  it('buildColumnIndex：字段名 → 命中表清单，同一张表去重', () => {
    const idx = buildColumnIndex({
      c1: [
        db('order_db'),
        { ...db('shop_db'), tables: [{ ...table('buyer'), columns: [col('id'), col('buyer_name')] }] },
      ],
      c2: [db('other_db')],
    });
    // id 在 order_db 与 shop_db 都有；other_db 没有对应表数据？有：db() 默认含 id 列
    expect(idx['id']).toContain('order_db.order');
    expect(idx['id']).toContain('shop_db.buyer');
    expect(idx['id']).toContain('other_db.order');
    // 同表同名列（这里每列名唯一）不重复
    expect(new Set(idx['id']).size).toBe(idx['id'].length);
    // 空库表不出键
    expect(buildColumnIndex({})).toEqual({});
  });

  it('空查询返回空结果', () => {
    expect(searchTree(roots, '')).toEqual([]);
    expect(searchTree(roots, '   ')).toEqual([]);
  });

  it('结果受 limit 保护，不会上万条', () => {
    const hits = searchTree(roots, 'o', { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('filterFlatByQuery 保留命中节点的祖先链', () => {
    const flat = flattenTree(roots, allKeys);
    const hits = searchTree(roots, 'order');
    const filtered = filterFlatByQuery(flat, hits);
    const labels = filtered.map((f) => f.node.label);
    // 祖先：生产环境 > prod > order_db > 表
    expect(labels).toContain('生产环境');
    expect(labels).toContain('prod');
    expect(labels).toContain('order_db');
    expect(labels).toContain('order');
    expect(labels).not.toContain('user');
  });

  it('无命中时过滤结果为空', () => {
    const flat = flattenTree(roots, allKeys);
    expect(filterFlatByQuery(flat, [])).toEqual([]);
  });
});

describe('危险操作确认层级', () => {
  it('删表/截断：普通环境二次确认，生产环境要输入表名', () => {
    expect(confirmLevelFor('dropTable', false)).toBe('confirm');
    expect(confirmLevelFor('truncateTable', false)).toBe('confirm');
    expect(confirmLevelFor('dropTable', true)).toBe('typeToConfirm');
    expect(confirmLevelFor('truncateTable', true)).toBe('typeToConfirm');
  });

  it('其它操作不需要确认', () => {
    expect(confirmLevelFor('open' as never, false)).toBe('none');
  });
});
