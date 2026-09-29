import { describe, it, expect } from 'vitest';
import {
  rankTables,
  aliasMap,
  qualifierAt,
  columnFlags,
  columnFacts,
  tableFactsHover,
  DEFAULT_HINT_LIMIT,
  type IndexedTable,
  type IndexRef,
} from './hints.js';
import type { ColumnMeta, DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';

// ---------- 夹具 ----------

function mkCol(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'int',
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
    ...over,
  };
}

function mkTable(name: string, over: Partial<IndexedTable> = {}): IndexedTable {
  return {
    name,
    kind: 'table',
    comment: null,
    estimatedRows: null,
    engine: 'InnoDB',
    collation: null,
    columns: [],
    ...over,
  };
}

/** 取提示里的表名序列（断言顺序最常用的形状） */
function names(hints: { name: string }[]): string[] {
  return hints.map((h) => h.name);
}

function labels(facts: { label: string }[]): string[] {
  return facts.map((f) => f.label);
}

// ===========================================================================
describe('rankTables · 四种匹配规则的相对排序', () => {
  it('精确匹配 > 前缀', () => {
    const t = [mkTable('orders'), mkTable('order_items')];
    expect(names(rankTables(t, 'orders'))).toEqual(['orders', 'order_items']);
  });

  it('前缀 > 子串', () => {
    // xorders 只是子串（命中位置 1），orders 是前缀
    const t = [mkTable('xorders'), mkTable('orders')];
    expect(names(rankTables(t, 'ord'))).toEqual(['orders', 'xorders']);
  });

  it('子串 > 首字母缩写', () => {
    // mom 含子串 om；order_main 靠 o + m 两个段首字母命中
    const t = [mkTable('order_main'), mkTable('mom')];
    expect(names(rankTables(t, 'om'))).toEqual(['mom', 'order_main']);
  });

  it('首字母缩写 > 子序列', () => {
    // oxm 只能按子序列 o…m 命中，档位低于缩写
    const t = [mkTable('oxm'), mkTable('order_main')];
    expect(names(rankTables(t, 'om'))).toEqual(['order_main', 'oxm']);
  });

  it('四档同时在场时按 exact > prefix > substring > acronym > subsequence 排', () => {
    const t = [
      mkTable('oxm'), // subsequence
      mkTable('order_main'), // acronym
      mkTable('mom'), // substring
      mkTable('om_log'), // prefix
      mkTable('om'), // exact
    ];
    expect(names(rankTables(t, 'om'))).toEqual(['om', 'om_log', 'mom', 'order_main', 'oxm']);
  });

  it('输出得分单调不增', () => {
    const t = [mkTable('oxm'), mkTable('mom'), mkTable('order_main'), mkTable('orders')];
    const hints = rankTables(t, 'or');
    for (let i = 1; i < hints.length; i++) {
      expect(hints[i].score).toBeLessThanOrEqual(hints[i - 1].score);
    }
  });

  it('完全不匹配的表不进榜', () => {
    const t = [mkTable('users'), mkTable('orders')];
    expect(names(rankTables(t, 'ord'))).toEqual(['orders']);
  });

  it('大小写不敏感：大写查询命中小写表名', () => {
    const hints = rankTables([mkTable('orders')], 'ORD');
    expect(names(hints)).toEqual(['orders']);
  });

  it('大小写不敏感：小写查询命中大写表名', () => {
    expect(names(rankTables([mkTable('ORDERS')], 'ord'))).toEqual(['ORDERS']);
  });
});

// ===========================================================================
describe('rankTables · limit 与空 query', () => {
  it('空 query 返回原序（不按字母、不按收藏）', () => {
    const t = [mkTable('zebra'), mkTable('apple'), mkTable('mango')];
    expect(names(rankTables(t, ''))).toEqual(['zebra', 'apple', 'mango']);
  });

  it('空 query 时所有 score 为 0、matches 为空（渲染层不该高亮任何字符）', () => {
    const hints = rankTables([mkTable('orders')], '');
    expect(hints[0].score).toBe(0);
    expect(hints[0].matches).toEqual([]);
  });

  it('空 query 时收藏也不加权（否则就不是原序了）', () => {
    const t = [mkTable('zebra'), mkTable('apple')];
    expect(names(rankTables(t, '', { favorites: ['apple'] }))).toEqual(['zebra', 'apple']);
  });

  it('limit 截断生效', () => {
    const t = [mkTable('a1'), mkTable('a2'), mkTable('a3')];
    expect(names(rankTables(t, 'a', { limit: 2 }))).toEqual(['a1', 'a2']);
  });

  it('limit = 0 返回空数组', () => {
    expect(rankTables([mkTable('orders')], 'ord', { limit: 0 })).toEqual([]);
  });

  it('默认 limit 是 50', () => {
    const t = Array.from({ length: 60 }, (_, i) => mkTable(`t${i}`));
    expect(rankTables(t, '')).toHaveLength(DEFAULT_HINT_LIMIT);
  });
});

// ===========================================================================
describe('rankTables · 收藏加权', () => {
  it('同档位命中时收藏排到前面', () => {
    const t = [mkTable('orders'), mkTable('order_items')];
    const base = names(rankTables(t, 'ord'));
    const fav = names(rankTables(t, 'ord', { favorites: ['order_items'] }));
    expect(base).toEqual(['orders', 'order_items']); // 不加收藏：短名在前
    expect(fav).toEqual(['order_items', 'orders']); // 加了收藏：收藏在前
  });

  it('收藏不会翻转规则档位（前缀的非收藏 > 子序列的收藏）', () => {
    const t = [mkTable('oxm'), mkTable('om_log')];
    const hints = rankTables(t, 'om', { favorites: ['oxm'] });
    expect(names(hints)).toEqual(['om_log', 'oxm']);
  });

  it('完全不匹配的收藏不会被塞进结果', () => {
    const t = [mkTable('orders'), mkTable('zzz')];
    expect(names(rankTables(t, 'ord', { favorites: ['zzz'] }))).toEqual(['orders']);
  });

  it('收藏表名大小写不敏感', () => {
    const t = [mkTable('orders'), mkTable('order_items')];
    expect(names(rankTables(t, 'ord', { favorites: ['ORDER_ITEMS'] }))).toEqual(['order_items', 'orders']);
  });
});

// ===========================================================================
describe('rankTables · 稳定性与 matches', () => {
  it('同分按原顺序（输入顺序即输出顺序）', () => {
    const t = [mkTable('ab_cd'), mkTable('ab_ce')];
    const hints = rankTables(t, 'ab');
    expect(hints[0].score).toBe(hints[1].score);
    expect(names(hints)).toEqual(['ab_cd', 'ab_ce']);
  });

  it('同分顺序随输入顺序翻转（证明确实稳定而非巧合）', () => {
    const t = [mkTable('ab_ce'), mkTable('ab_cd')];
    expect(names(rankTables(t, 'ab'))).toEqual(['ab_ce', 'ab_cd']);
  });

  it('matches：前缀命中给出连续下标', () => {
    expect(rankTables([mkTable('orders')], 'ord')[0].matches).toEqual([0, 1, 2]);
  });

  it('matches：子串命中从命中位置起算', () => {
    expect(rankTables([mkTable('xorders')], 'ord')[0].matches).toEqual([1, 2, 3]);
  });

  it('matches：首字母缩写给各段首字母下标', () => {
    expect(rankTables([mkTable('order_main')], 'om')[0].matches).toEqual([0, 6]);
  });

  it('matches：子序列给贪心匹配到的下标', () => {
    expect(rankTables([mkTable('oxm')], 'om')[0].matches).toEqual([0, 2]);
  });

  it('反引号表名去引号比对，且 name 与 matches 下标对齐', () => {
    const hints = rankTables([mkTable('`my table`')], 'my ta');
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('my table');
    expect(hints[0].matches).toEqual([0, 1, 2, 3, 4]);
  });

  it('查询串里的反引号同样被去掉', () => {
    expect(names(rankTables([mkTable('orders')], '`ord`'))).toEqual(['orders']);
  });
});

// ===========================================================================
describe('rankTables · database 字段', () => {
  it('没有库信息时是 null（TableMeta 本身不带库名）', () => {
    expect(rankTables([mkTable('orders')], 'ord')[0].database).toBeNull();
  });

  it('opts.database 给整批表补库名', () => {
    expect(rankTables([mkTable('orders')], 'ord', { database: 'demo' })[0].database).toBe('demo');
  });

  it('opts.databases 按对象引用反查所属库（同名表不混淆）', () => {
    const shopOrders = mkTable('orders');
    const crmOrders = mkTable('orders');
    const dbs: DatabaseMeta[] = [
      { name: 'shop', charset: null, collation: null, tables: [shopOrders] },
      { name: 'crm', charset: null, collation: null, tables: [crmOrders] },
    ];
    const hints = rankTables([shopOrders, crmOrders], 'ord', { databases: dbs });
    expect(hints.map((h) => h.database)).toEqual(['shop', 'crm']);
  });

  it('反查不到时回退到 opts.database', () => {
    const orphan = mkTable('orders');
    expect(rankTables([orphan], 'ord', { database: 'demo', databases: [] })[0].database).toBe('demo');
  });
});

// ===========================================================================
describe('rankTables · 健壮性', () => {
  it('null / 非数组入参返回空数组，不抛异常', () => {
    expect(rankTables(null as unknown as TableMeta[], 'a')).toEqual([]);
    expect(rankTables(undefined as unknown as TableMeta[], 'a')).toEqual([]);
    expect(rankTables('nope' as unknown as TableMeta[], 'a')).toEqual([]);
  });

  it('null / 非字符串 query 当作空 query 处理', () => {
    const t = [mkTable('zebra'), mkTable('apple')];
    expect(names(rankTables(t, null as unknown as string))).toEqual(['zebra', 'apple']);
    expect(names(rankTables(t, 42 as unknown as string))).toEqual(['zebra', 'apple']);
  });

  it('数组里的脏项（null / 无 name）被跳过而不是崩', () => {
    const t = [null as unknown as TableMeta, { kind: 'table' } as unknown as TableMeta, mkTable('orders')];
    expect(names(rankTables(t, 'ord'))).toEqual(['orders']);
  });

  it('不修改入参数组', () => {
    const t = [mkTable('zebra'), mkTable('apple')];
    rankTables(t, 'a');
    expect(names(t as unknown as { name: string }[])).toEqual(['zebra', 'apple']);
  });
});

// ===========================================================================
describe('aliasMap · FROM / JOIN', () => {
  it('带 AS 的别名', () => {
    expect(aliasMap('SELECT * FROM orders AS o WHERE o.id = 1')).toEqual({ o: 'orders' });
  });

  it('不带 AS 的隐式别名', () => {
    expect(aliasMap('SELECT * FROM orders o WHERE o.id = 1')).toEqual({ o: 'orders' });
  });

  it('多表 JOIN 全部收进来', () => {
    const sql = 'SELECT * FROM orders o JOIN users u ON o.uid = u.id';
    expect(aliasMap(sql)).toEqual({ o: 'orders', u: 'users' });
  });

  it('LEFT JOIN / INNER JOIN 等形式同样认（认的是 JOIN 这个词）', () => {
    const sql = 'SELECT * FROM orders AS o LEFT JOIN users AS u ON o.uid = u.id';
    expect(aliasMap(sql)).toEqual({ o: 'orders', u: 'users' });
  });

  it('限定名取最后一段当表名', () => {
    expect(aliasMap('SELECT * FROM demo.orders o')).toEqual({ o: 'orders' });
  });

  it('反引号标识符去引号', () => {
    expect(aliasMap('SELECT * FROM `orders` `o`')).toEqual({ o: 'orders' });
  });

  it('没有别名就返回空对象（不把下一个词猜成别名）', () => {
    expect(aliasMap('SELECT * FROM orders WHERE id = 1')).toEqual({});
  });

  it('关键字不会被当成别名', () => {
    expect(aliasMap('SELECT * FROM orders ORDER BY id')).toEqual({});
    expect(aliasMap('SELECT * FROM orders GROUP BY id')).toEqual({});
  });

  it('重复别名先到先得（不替用户挑）', () => {
    expect(aliasMap('SELECT * FROM a x JOIN b x ON x.id = 1')).toEqual({ x: 'a' });
  });

  it('子查询内一律放行不猜（内层别名与派生表别名都不收）', () => {
    expect(aliasMap('SELECT * FROM (SELECT id FROM items i) x')).toEqual({});
  });

  it('JOIN 子查询时不收派生表别名，但外层别名照收', () => {
    const sql = 'SELECT * FROM orders o JOIN (SELECT uid FROM logs) s ON o.id = s.uid';
    expect(aliasMap(sql)).toEqual({ o: 'orders' });
  });

  it('逗号续表不解析（认不出就不猜）', () => {
    expect(aliasMap('SELECT * FROM orders AS o, users u')).toEqual({ o: 'orders' });
  });

  it('只认 FROM / JOIN：UPDATE 不在范围内', () => {
    expect(aliasMap('UPDATE orders SET x = 1')).toEqual({});
  });

  it('别名键小写（大小写不敏感查找），表名保留原始大小写', () => {
    expect(aliasMap('SELECT * FROM OrderItems OI')).toEqual({ oi: 'OrderItems' });
  });

  it('空 / 非字符串输入返回空对象，不抛异常', () => {
    expect(aliasMap('')).toEqual({});
    expect(aliasMap(null as unknown as string)).toEqual({});
    expect(aliasMap(undefined as unknown as string)).toEqual({});
    expect(aliasMap(123 as unknown as string)).toEqual({});
  });
});

// ===========================================================================
describe('qualifierAt · 基本形态', () => {
  it('demo.ord| 的 qualifier 是 demo（点在左边，不是空）', () => {
    expect(qualifierAt('SELECT * FROM demo.ord', 22)).toEqual({ qualifier: 'demo', from: 14 });
  });

  it('点后还没打字（demo.|）也算未完成前缀', () => {
    expect(qualifierAt('SELECT * FROM demo.', 19)).toEqual({ qualifier: 'demo', from: 14 });
  });

  it('三段限定名取最近那个点左边的段（db.tbl.col| → tbl）', () => {
    expect(qualifierAt('SELECT a.b.c', 12)).toEqual({ qualifier: 'b', from: 9 });
  });

  it('from 是限定符在原文中的起始下标（渲染层用它做替换区间）', () => {
    const sql = 'SELECT * FROM demo.ord';
    const hit = qualifierAt(sql, 22);
    expect(hit).not.toBeNull();
    expect(sql.slice(hit!.from, hit!.from + hit!.qualifier.length)).toBe('demo');
  });

  it('反引号限定符去引号', () => {
    expect(qualifierAt('SELECT * FROM `my db`.ord', 24)?.qualifier).toBe('my db');
  });

  it('左侧没有点 → null', () => {
    expect(qualifierAt('SELECT * FROM ord', 16)).toBeNull();
  });
});

// ===========================================================================
describe('qualifierAt · 边界（返回 null 的情形）', () => {
  it('点在字符串里 → null（那是数据，不是限定符）', () => {
    expect(qualifierAt("SELECT 'a.b' FROM t", 11)).toBeNull();
  });

  it('点在行注释里 → null', () => {
    expect(qualifierAt('-- a.b\nSELECT 1', 6)).toBeNull();
  });

  it('点在块注释里 → null', () => {
    expect(qualifierAt('/* a.b */ SELECT 1', 7)).toBeNull();
  });

  it('点在反引号标识符里 → null（`a.b` 是一整个标识符）', () => {
    expect(qualifierAt('SELECT `a.b` FROM t', 12)).toBeNull();
  });

  it('数字里的点 → null（1.5 是 number token）', () => {
    expect(qualifierAt('SELECT 1.5', 9)).toBeNull();
  });

  it('点后有空格 → null（前缀已经断掉了）', () => {
    expect(qualifierAt('SELECT * FROM demo. ord', 20)).toBeNull();
  });

  it('限定符与点之间有空格 → null', () => {
    expect(qualifierAt('SELECT * FROM demo .ord', 21)).toBeNull();
  });

  it('点左侧不是标识符（右括号）→ null', () => {
    expect(qualifierAt('SELECT (1).x', 12)).toBeNull();
  });

  it('点后是 * 而不是半截标识符 → null', () => {
    expect(qualifierAt('SELECT t.*', 10)).toBeNull();
  });

  it('点后又出现一个点 → null', () => {
    expect(qualifierAt('SELECT a..b', 11)).toBeNull();
  });

  it('pos = 0 / 负数 → null', () => {
    expect(qualifierAt('demo.ord', 0)).toBeNull();
    expect(qualifierAt('demo.ord', -5)).toBeNull();
  });

  it('pos 超出长度时按末尾截断处理', () => {
    expect(qualifierAt('SELECT a.b', 999)).toEqual({ qualifier: 'a', from: 7 });
  });

  it('非字符串 sql / 非数字 pos → null，不抛异常', () => {
    expect(qualifierAt(null as unknown as string, 3)).toBeNull();
    expect(qualifierAt('a.b', Number.NaN)).toBeNull();
    expect(qualifierAt('a.b', '1' as unknown as number)).toBeNull();
  });
});

// ===========================================================================
describe('columnFlags', () => {
  it('全命中时顺序固定为 PK > UQ > NN > AI > IDX', () => {
    const col = mkCol('id', { isPrimaryKey: true, isUnique: true, nullable: false, autoIncrement: true });
    const table = mkTable('t', { indexes: [{ columns: ['id'], unique: false }] });
    expect(columnFlags(col, table)).toEqual(['PK', 'UQ', 'NN', 'AI', 'IDX']);
  });

  it('只给命中的标记，且顺序不因缺失而错位', () => {
    const col = mkCol('email', { isUnique: true, nullable: false });
    expect(columnFlags(col)).toEqual(['UQ', 'NN']);
  });

  it('PK 与非空组合', () => {
    expect(columnFlags(mkCol('id', { isPrimaryKey: true, nullable: false }))).toEqual(['PK', 'NN']);
  });

  it('NOT NULL 只在 nullable === false 时出现', () => {
    expect(columnFlags(mkCol('a', { nullable: true }))).toEqual([]);
    expect(columnFlags(mkCol('a', { nullable: false }))).toEqual(['NN']);
  });

  it('AI 来自 autoIncrement', () => {
    expect(columnFlags(mkCol('id', { autoIncrement: true }))).toEqual(['AI']);
  });

  it('IDX 来自非唯一索引', () => {
    const table = mkTable('t', { indexes: [{ columns: ['name'], unique: false }] });
    expect(columnFlags(mkCol('name'), table)).toEqual(['IDX']);
  });

  it('索引类型写成 kind: INDEX 也算非唯一', () => {
    const table = mkTable('t', { indexes: [{ columns: ['name'], kind: 'INDEX' }] });
    expect(columnFlags(mkCol('name'), table)).toEqual(['IDX']);
  });

  it('唯一索引不给 IDX（已经有 UQ 表达）', () => {
    const table = mkTable('t', { indexes: [{ columns: ['email'], kind: 'UNIQUE' }] });
    expect(columnFlags(mkCol('email', { isUnique: true }), table)).toEqual(['UQ']);
  });

  it('索引列名与列名大小写不敏感', () => {
    const table = mkTable('t', { indexes: [{ columns: ['Name'] }] });
    expect(columnFlags(mkCol('name'), table)).toEqual(['IDX']);
  });

  it('兼容 { column } 形状的索引列', () => {
    const table = mkTable('t', { indexes: [{ columns: [{ column: 'name' }] }] });
    expect(columnFlags(mkCol('name'), table)).toEqual(['IDX']);
  });

  it('复合非唯一索引里的第二列也有 IDX', () => {
    const table = mkTable('t', { indexes: [{ columns: ['a', 'b'], unique: false }] });
    expect(columnFlags(mkCol('b'), table)).toEqual(['IDX']);
  });

  it('拿不到索引清单就不给 IDX（不猜）', () => {
    expect(columnFlags(mkCol('name'), null)).toEqual([]);
    expect(columnFlags(mkCol('name'), mkTable('t'))).toEqual([]);
  });

  it('null / 脏字段输入返回空数组，不抛异常', () => {
    expect(columnFlags(null as unknown as ColumnMeta)).toEqual([]);
    expect(columnFlags(undefined as unknown as ColumnMeta)).toEqual([]);
    expect(columnFlags({} as unknown as ColumnMeta)).toEqual([]);
  });
});

// ===========================================================================
describe('columnFacts', () => {
  it('信息齐全时行序固定', () => {
    const col = mkCol('id', {
      dataType: 'bigint',
      nullable: false,
      defaultValue: '0',
      autoIncrement: true,
      isPrimaryKey: true,
      isUnique: true,
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
      comment: '主键',
    });
    expect(labels(columnFacts(col))).toEqual([
      '类型', '可空', '默认值', '自增', '主键', '唯一', '字符集', '排序规则', '注释',
    ]);
  });

  it('缺失字段整行不显示（不是显示 undefined）', () => {
    const col = mkCol('id');
    const facts = columnFacts(col);
    expect(labels(facts)).toEqual(['类型', '可空', '自增', '主键', '唯一']);
    for (const f of facts) expect(f.value).not.toBe('undefined');
  });

  it('类型带长度：varchar(255) → VARCHAR(255)', () => {
    expect(columnFacts(mkCol('name', { dataType: 'varchar(255)' }))[0].value).toBe('VARCHAR(255)');
  });

  it('类型带精度：decimal(12,2) → DECIMAL(12,2)', () => {
    expect(columnFacts(mkCol('amt', { dataType: 'decimal(12,2)' }))[0].value).toBe('DECIMAL(12,2)');
  });

  it('只大写类型名，不动括号里的字面值', () => {
    expect(columnFacts(mkCol('s', { dataType: "enum('a','B')" }))[0].value).toBe("ENUM('a','B')");
  });

  it('默认值为 null → 没有默认值这一行', () => {
    expect(labels(columnFacts(mkCol('a', { defaultValue: null })))).not.toContain('默认值');
  });

  it('默认值为空串 → 显示成两个单引号（免得看成没有这一行）', () => {
    const f = columnFacts(mkCol('a', { defaultValue: '' })).find((x) => x.label === '默认值');
    expect(f?.value).toBe("''");
  });

  it('注释为空串也当作缺失', () => {
    expect(labels(columnFacts(mkCol('a', { comment: '' })))).not.toContain('注释');
  });

  it('布尔字段缺失（旧快照）时对应行不出现，不猜“否”', () => {
    const col = mkCol('a', { nullable: undefined, isPrimaryKey: undefined });
    const labs = labels(columnFacts(col));
    expect(labs).not.toContain('可空');
    expect(labs).not.toContain('主键');
    // 仍然给了的字段照常出现
    expect(labs).toEqual(['类型', '自增', '唯一']);
  });

  it('可空 / 自增 / 主键 / 唯一 用 是 / 否 表达', () => {
    const facts = columnFacts(mkCol('a', { nullable: false, autoIncrement: false, isPrimaryKey: true }));
    expect(facts.find((f) => f.label === '可空')?.value).toBe('否');
    expect(facts.find((f) => f.label === '自增')?.value).toBe('否');
    expect(facts.find((f) => f.label === '主键')?.value).toBe('是');
  });

  it('null / 脏输入返回空数组，不抛异常', () => {
    expect(columnFacts(null as unknown as ColumnMeta)).toEqual([]);
    expect(columnFacts(undefined as unknown as ColumnMeta)).toEqual([]);
    expect(columnFacts({} as unknown as ColumnMeta)).toEqual([]);
  });
});

// ===========================================================================
describe('tableFactsHover', () => {
  it('信息齐全时行序固定', () => {
    const t = mkTable('orders', {
      comment: '订单表',
      engine: 'InnoDB',
      collation: 'utf8mb4_general_ci',
      charset: 'utf8mb4',
      estimatedRows: 1234,
      columns: [mkCol('id'), mkCol('name')],
      createdAt: '2024-01-02 03:04:05',
    });
    expect(labels(tableFactsHover(t))).toEqual([
      '注释', '引擎', '字符集', '排序规则', '字段数', '估算行数', '创建时间',
    ]);
  });

  it('缺失项整行不显示（引擎 / 排序规则 / 行数都没给）', () => {
    const t = mkTable('orders', { comment: null, engine: null, collation: null, estimatedRows: null, columns: [] });
    expect(labels(tableFactsHover(t))).toEqual(['字段数']);
  });

  it('字段数来自 columns.length', () => {
    const t = mkTable('t', { columns: [mkCol('a'), mkCol('b'), mkCol('c')] });
    expect(tableFactsHover(t).find((f) => f.label === '字段数')?.value).toBe('3');
  });

  it('千分位：1000 → 1,000', () => {
    const t = mkTable('t', { estimatedRows: 1000 });
    expect(tableFactsHover(t).find((f) => f.label === '估算行数')?.value).toBe('1,000');
  });

  it('千分位：123 → 123（不到四位不加逗号）', () => {
    const t = mkTable('t', { estimatedRows: 123 });
    expect(tableFactsHover(t).find((f) => f.label === '估算行数')?.value).toBe('123');
  });

  it('千分位：多位与 0 都对', () => {
    expect(tableFactsHover(mkTable('t', { estimatedRows: 1234567 })).find((f) => f.label === '估算行数')?.value).toBe('1,234,567');
    expect(tableFactsHover(mkTable('t', { estimatedRows: 0 })).find((f) => f.label === '估算行数')?.value).toBe('0');
  });

  it('opts.estimatedRows 覆盖表上的估算值', () => {
    const t = mkTable('t', { estimatedRows: 100 });
    expect(tableFactsHover(t, { estimatedRows: 2000 }).find((f) => f.label === '估算行数')?.value).toBe('2,000');
  });

  it('opts.estimatedRows = null 表示“没有”，即使表上有值也不显示', () => {
    const t = mkTable('t', { estimatedRows: 100 });
    expect(labels(tableFactsHover(t, { estimatedRows: null }))).not.toContain('估算行数');
  });

  it('创建时间是 epoch 毫秒时按 UTC 渲染（跨机器单测稳定）', () => {
    const t = mkTable('t', { createdAt: Date.UTC(2024, 0, 2, 3, 4, 5) });
    expect(tableFactsHover(t).find((f) => f.label === '创建时间')?.value).toBe('2024-01-02 03:04:05');
  });

  it('创建时间是字符串时原样展示', () => {
    expect(tableFactsHover(mkTable('t', { createdAt: '2024-01-02' })).find((f) => f.label === '创建时间')?.value).toBe('2024-01-02');
  });

  it('null / 脏输入返回空数组，不抛异常', () => {
    expect(tableFactsHover(null as unknown as IndexedTable)).toEqual([]);
    expect(tableFactsHover(undefined as unknown as IndexedTable)).toEqual([]);
    expect(tableFactsHover({} as unknown as IndexedTable)).toEqual([]);
  });

  it('普通 TableMeta（无补充字段）也能直接用', () => {
    const plain: TableMeta = {
      name: 'orders',
      kind: 'table',
      comment: '订单',
      estimatedRows: 42,
      engine: 'InnoDB',
      collation: null,
      columns: [mkCol('id')],
    };
    expect(labels(tableFactsHover(plain))).toEqual(['注释', '引擎', '字段数', '估算行数']);
    expect(columnFlags(mkCol('id'), plain)).toEqual([]);
  });
});

// ===========================================================================
describe('IndexRef 边界', () => {
  it('索引列为空数组 / 含 null 项时不崩且不给 IDX', () => {
    const t = mkTable('t', { indexes: [{ columns: [] }, { columns: [null, undefined] } as unknown as IndexRef] });
    expect(columnFlags(mkCol('name'), t)).toEqual([]);
  });

  it('indexes 里的脏项被跳过', () => {
    const t = mkTable('t', { indexes: [null as unknown as IndexRef, { columns: ['name'] }] });
    expect(columnFlags(mkCol('name'), t)).toEqual(['IDX']);
  });
});
