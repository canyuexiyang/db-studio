import { describe, it, expect } from 'vitest';
import {
  splitStatements,
  statementAt,
  resolveExecution,
  toExecutableStatements,
  isFullTableScan,
  extraWarnings,
  explainCell,
  wrapExplain,
  EXPLAIN_COLUMNS,
  buildCompletions,
  schemaCompletions,
  keywordCompletions,
  wordBefore,
  contextTableOf,
  toggleLineComment,
  formatCount,
  MAX_COMPLETION_ITEMS,
  buildExplainTree,
  explainJsonToRows,
  type ExplainNode,
} from './index.js';
import type { DatabaseMeta } from '@dbstudio/core-schema-cache';

const DB: DatabaseMeta[] = [
  {
    name: 'order_db',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [
      {
        name: 'order',
        kind: 'table',
        comment: null,
        estimatedRows: 1000,
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, comment: null, isPrimaryKey: true, isUnique: true, autoIncrement: true, charset: null, collation: null },
          { name: 'status', dataType: 'varchar(16)', nullable: false, defaultValue: null, comment: null, isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null },
        ],
      },
      {
        name: 'user',
        kind: 'table',
        comment: null,
        estimatedRows: 10,
        engine: 'InnoDB',
        collation: null,
        columns: [
          { name: 'user_id', dataType: 'bigint', nullable: false, defaultValue: null, comment: null, isPrimaryKey: true, isUnique: true, autoIncrement: false, charset: null, collation: null },
        ],
      },
    ],
  },
];

// ---------- 语句拆分 ----------

describe('splitStatements', () => {
  it('空输入返回空', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   \n  ')).toEqual([]);
    expect(splitStatements(null as unknown as string)).toEqual([]);
  });

  it('单条无分号', () => {
    const r = splitStatements('SELECT 1');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('SELECT 1');
    expect(r[0].terminated).toBe(false);
  });

  it('多条按分号拆', () => {
    const r = splitStatements('SELECT 1; SELECT 2;');
    expect(r.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(r.every((s) => s.terminated)).toBe(true);
  });

  it('🔴 字符串里的分号不算分隔', () => {
    expect(splitStatements("SELECT ';'")).toHaveLength(1);
    expect(splitStatements("SELECT 'a;b' FROM t; SELECT 2")).toHaveLength(2);
  });

  it('🔴 双引号字符串同理', () => {
    expect(splitStatements('SELECT "a;b"')).toHaveLength(1);
  });

  it('🔴 反引号标识符里的分号不算', () => {
    expect(splitStatements('SELECT `we;ird` FROM t; SELECT 2')).toHaveLength(2);
  });

  it('🔴 行注释里的分号不算（-- 需后跟空格，否则是减号）', () => {
    expect(splitStatements('-- a; b\nSELECT 1')).toHaveLength(1);
    // `a--b` 是减法不是注释，分号要生效
    expect(splitStatements('SELECT 1--2; SELECT 3')).toHaveLength(2);
  });

  it('🔴 # 行注释里的分号不算', () => {
    expect(splitStatements('# a; b\nSELECT 1')).toHaveLength(1);
  });

  it('🔴 块注释里的分号不算', () => {
    expect(splitStatements('/* a; b */ SELECT 1')).toHaveLength(1);
    expect(splitStatements('SELECT 1 /* x; y */; SELECT 2')).toHaveLength(2);
  });

  it('字符串内的反斜杠转义不提前结束字符串', () => {
    expect(splitStatements("SELECT 'a\\'; SELECT 2")).toHaveLength(1);
  });

  it('末尾未终止的语句也要收（用户正在敲）', () => {
    const r = splitStatements('SELECT 1; SELECT 2');
    expect(r).toHaveLength(2);
    expect(r[1].terminated).toBe(false);
  });

  it('span 的 from/to 能切回原文', () => {
    const sql = 'SELECT 1;\n  SELECT 2  ;\n';
    for (const s of splitStatements(sql)) {
      expect(s.text).toBe(sql.slice(s.from, s.to));
    }
  });

  it('连续分号不产生空语句', () => {
    expect(splitStatements('SELECT 1;;;SELECT 2').map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('statementAt', () => {
  it('命中光标所在语句', () => {
    const sql = 'SELECT 1; SELECT 2; SELECT 3';
    expect(statementAt(sql, 2)?.text).toBe('SELECT 1');
    expect(statementAt(sql, 12)?.text).toBe('SELECT 2');
    expect(statementAt(sql, 22)?.text).toBe('SELECT 3');
  });

  it('空输入返回 null', () => {
    expect(statementAt('', 0)).toBeNull();
  });

  it('落在语句间空白时给后一条（正在写的那条）', () => {
    expect(statementAt('SELECT 1;  SELECT 2', 10)?.text).toBe('SELECT 2');
  });
});

describe('resolveExecution（§6.4.1 选中执行三规则）', () => {
  it('有选中 → 执行选中', () => {
    const r = resolveExecution('SELECT 1; SELECT 2', { from: 10, to: 18 });
    expect(r?.sql).toBe('SELECT 2');
    expect(r?.fromSelection).toBe(true);
  });

  it('无选中 → 执行光标所在语句', () => {
    const r = resolveExecution('SELECT 1; SELECT 2; SELECT 3', { from: 12, to: 12 });
    expect(r?.sql).toBe('SELECT 2');
    expect(r?.fromSelection).toBe(false);
  });

  it('全文无分号 → 执行全部', () => {
    const r = resolveExecution('SELECT 1 FROM t WHERE a = 1', { from: 0, to: 0 });
    expect(r?.sql).toBe('SELECT 1 FROM t WHERE a = 1');
  });

  it('空输入 / 空白选区返回 null', () => {
    expect(resolveExecution('', null)).toBeNull();
    expect(resolveExecution('   ', { from: 1, to: 1 })).toBeNull();
  });
});

describe('toExecutableStatements', () => {
  it('多语句逐条', () => {
    expect(toExecutableStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('字符串分号不误拆', () => {
    expect(toExecutableStatements("SELECT ';' ; SELECT 2")).toEqual(["SELECT ';'", 'SELECT 2']);
  });
});

// ---------- EXPLAIN ----------

describe('EXPLAIN（§6.4.3）', () => {
  it('标准列是 12 个（11 列 + partitions）', () => {
    expect(EXPLAIN_COLUMNS).toContain('type');
    expect(EXPLAIN_COLUMNS).toContain('Extra');
  });

  it('type=ALL 判全表扫，大小写不敏感', () => {
    expect(isFullTableScan('ALL')).toBe(true);
    expect(isFullTableScan('all')).toBe(true);
    expect(isFullTableScan('ref')).toBe(false);
    expect(isFullTableScan('')).toBe(false);
    expect(isFullTableScan(null)).toBe(false);
  });

  it('Extra 告警词按「词」匹配，不含糊', () => {
    expect(extraWarnings('Using temporary; Using filesort')).toEqual(
      expect.arrayContaining(['Using filesort', 'Using temporary']),
    );
    // 🔴 `Using index condition` 不该被 `Using index` 误伤
    expect(extraWarnings('Using index condition')).toEqual([]);
    expect(extraWarnings('Using where')).toEqual([]);
    expect(extraWarnings(null)).toEqual([]);
  });

  it('单元格高亮等级', () => {
    expect(explainCell('type', 'ALL').level).toBe('danger');
    expect(explainCell('Extra', 'Using filesort').level).toBe('warn');
    expect(explainCell('rows', 1000).level).toBe('ok');
  });

  it('wrapExplain 不重复嵌套', () => {
    expect(wrapExplain('SELECT 1')).toBe('EXPLAIN SELECT 1');
    expect(wrapExplain('SELECT 1;')).toBe('EXPLAIN SELECT 1');
    expect(wrapExplain('EXPLAIN SELECT 1')).toBe('EXPLAIN SELECT 1');
    expect(wrapExplain('  ')).toBe('');
  });

  it('ANALYZE 与 FORMAT=JSON', () => {
    expect(wrapExplain('SELECT 1', { analyze: true })).toBe('EXPLAIN ANALYZE SELECT 1');
    expect(wrapExplain('SELECT 1', { json: true })).toBe('EXPLAIN FORMAT=JSON SELECT 1');
  });
});

// ---------- 补全（E4） ----------

describe('补全（E4 纯函数 + 缓存数据源）', () => {
  it('关键字前缀匹配', () => {
    expect(keywordCompletions('SEL').map((c) => c.label)).toContain('SELECT');
    expect(keywordCompletions('ZZZ')).toEqual([]);
  });

  it('schema 候选来自缓存：库 / 表 / 字段', () => {
    const labels = schemaCompletions(DB, '').map((c) => c.label);
    expect(labels).toContain('order_db');
    expect(labels).toContain('order');
    expect(labels).toContain('user_id');
  });

  it('🔴 上下文表的字段排在最前', () => {
    const r = schemaCompletions(DB, '', { contextTable: 'user' });
    expect(r[0]).toMatchObject({ label: 'user_id', kind: 'column' });
  });

  it('🔴 候选有上限（大库不卡输入）', () => {
    const big: DatabaseMeta[] = [
      {
        name: 'big',
        charset: null,
        collation: null,
        tables: Array.from({ length: 500 }, (_, i) => ({
          name: `t${i}`,
          kind: 'table' as const,
          comment: null,
          estimatedRows: null,
          engine: null,
          collation: null,
          columns: [],
        })),
      },
    ];
    expect(schemaCompletions(big, 't').length).toBeLessThanOrEqual(MAX_COMPLETION_ITEMS);
    expect(buildCompletions(big, '').length).toBeLessThanOrEqual(MAX_COMPLETION_ITEMS);
  });

  it('前缀过滤生效', () => {
    expect(schemaCompletions(DB, 'ord').map((c) => c.label)).toEqual(['order_db', 'order']);
    expect(schemaCompletions(DB, 'zzz')).toEqual([]);
  });

  it('去重：同 label 不同 kind 保留，同 label 同 kind 去重', () => {
    const all = buildCompletions(DB, '');
    const keys = all.map((c) => `${c.kind}:${c.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('空/null 输入不炸', () => {
    expect(schemaCompletions(null as unknown as DatabaseMeta[], '')).toEqual([]);
    expect(buildCompletions([], 'a')).not.toHaveLength(0); // 关键字仍要给
  });
});

describe('wordBefore', () => {
  it('取光标前的词', () => {
    expect(wordBefore('SELECT ord', 10)).toEqual({ from: 7, word: 'ord' });
  });
  it('空格断词', () => {
    expect(wordBefore('a b', 2).word).toBe('');
  });

  it('🔴 `.` 断词：输入 `order.` 时前缀为空，好让字段补全全量返回', () => {
    expect(wordBefore('order.', 6).word).toBe('');
    expect(wordBefore('order.status', 12).word).toBe('status');
  });
  it('边界不越界', () => {
    expect(wordBefore('abc', 99).word).toBe('abc');
    expect(wordBefore('abc', -5).word).toBe('');
  });
});

describe('contextTableOf', () => {
  it('取 FROM 后的表', () => {
    expect(contextTableOf('SELECT * FROM `order` WHERE 1')).toBe('order');
    expect(contextTableOf('SELECT * FROM order_db.order WHERE 1')).toBe('order');
    expect(contextTableOf('UPDATE user SET a=1')).toBe('user');
  });
  it('无匹配返回 null', () => {
    expect(contextTableOf('SELECT 1')).toBeNull();
  });
});

// ---------- 注释切换 ----------

describe('toggleLineComment（Cmd+/）', () => {
  it('加注释', () => {
    expect(toggleLineComment('SELECT 1', 0, 8).text).toBe('-- SELECT 1');
  });

  it('全选已注释 → 取消', () => {
    const r = toggleLineComment('-- SELECT 1\n-- SELECT 2', 0, 22);
    expect(r.text).toBe('SELECT 1\nSELECT 2');
  });

  it('🔴 混选（部分已注释）→ 统一加注释', () => {
    const r = toggleLineComment('-- a\nb', 0, 5);
    expect(r.text).toBe('-- -- a\n-- b');
  });

  it('选区在行内也覆盖整行', () => {
    expect(toggleLineComment('SELECT 1\nSELECT 2', 10, 12).text).toBe('SELECT 1\n-- SELECT 2');
  });

  it('光标不越界', () => {
    const r = toggleLineComment('abc', 1, 1);
    expect(r.from).toBeLessThanOrEqual(r.to);
  });
});

describe('formatCount', () => {
  it('千分位', () => {
    expect(formatCount(12_450_000)).toBe('12,450,000');
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(NaN)).toBe('—');
  });
});

// ---------- B4：EXPLAIN FORMAT=JSON → 树 ----------

/**
 * 手写的 MySQL 8 典型 plan 结构（字段名与真机 EXPLAIN FORMAT=JSON 一致）：
 *  - 顶层 query_block + cost_info
 *  - ordering_operation 包着 nested_loop（两表 JOIN，其中一张全表扫描）
 *  - 第二张表带物化子查询（materialized_from_subquery → 子 query_block）
 */
const PLAN_JSON_TEXT = `{
  "query_block": {
    "select_id": 1,
    "cost_info": { "query_cost": "875.35" },
    "ordering_operation": {
      "using_filesort": true,
      "nested_loop": [
        {
          "table": {
            "table_name": "orders",
            "access_type": "ALL",
            "rows_examined_per_scan": 1000,
            "rows_produced_per_join": 1000,
            "filtered": "100.00",
            "cost_info": {
              "read_cost": "180.20",
              "eval_cost": "100.00",
              "prefix_cost": "280.20",
              "data_read_per_join": "1M"
            },
            "using_where": true
          }
        },
        {
          "table": {
            "table_name": "customers",
            "access_type": "eq_ref",
            "possible_keys": ["PRIMARY"],
            "key": "PRIMARY",
            "used_key_parts": ["id"],
            "key_length": "8",
            "ref": ["order_db.orders.customer_id"],
            "rows_examined_per_scan": 1,
            "rows_produced_per_join": 100,
            "filtered": "100.00",
            "cost_info": {
              "read_cost": "1.00",
              "eval_cost": "10.00",
              "prefix_cost": "390.20",
              "data_read_per_join": "8K"
            },
            "using_index_condition": true,
            "materialized_from_subquery": {
              "query_block": {
                "select_id": 2,
                "cost_info": { "query_cost": "12.40" },
                "table": {
                  "table_name": "tags",
                  "access_type": "index",
                  "key": "PRIMARY",
                  "key_length": "8",
                  "rows_examined_per_scan": 12,
                  "filtered": "100.00",
                  "using_index": true,
                  "cost_info": { "read_cost": "12.00", "eval_cost": "1.20", "prefix_cost": "12.40" }
                }
              }
            }
          }
        }
      ]
    }
  }
}`;

describe('buildExplainTree', () => {
  const tree = (): ExplainNode[] => buildExplainTree(PLAN_JSON_TEXT);

  it('🔴 JSON 字符串与已解析对象等价', () => {
    expect(buildExplainTree(PLAN_JSON_TEXT)).toEqual(buildExplainTree(JSON.parse(PLAN_JSON_TEXT)));
  });

  it('根节点是 query_block：标题带 select_id、cost 取 query_cost', () => {
    const [root] = tree();
    expect(root.title).toBe('SELECT #1');
    expect(root.cost).toBe('875.35');
    expect(root.accessType).toBeUndefined();
  });

  it('nested_loop 两张表按序成为根的孩子；包装器的 filesort 旗标透传给表', () => {
    const [root] = tree();
    expect(root.children).toHaveLength(2);
    const [orders, customers] = root.children;
    expect(orders.title).toBe('orders');
    expect(orders.accessType).toBe('ALL');
    expect(orders.detail.some((d) => d.includes('全表扫描'))).toBe(true);
    expect(orders.detail).toContain('Using filesort');
    expect(orders.cost).toBe('280.20');
    expect(customers.accessType).toBe('eq_ref');
    expect(customers.detail.some((d) => d.includes('使用索引 PRIMARY'))).toBe(true);
  });

  it('物化子查询挂在表节点下，select_id 换层', () => {
    const [, customers] = tree()[0].children;
    expect(customers.children).toHaveLength(1);
    const sub = customers.children[0];
    expect(sub.title).toBe('SELECT #2');
    expect(sub.cost).toBe('12.40');
    expect(sub.children[0].title).toBe('tags');
    expect(sub.children[0].accessType).toBe('index');
    expect(sub.children[0].detail).toContain('Using index（覆盖索引）');
  });

  it('行数与过滤信息进 detail', () => {
    const [orders] = tree()[0].children;
    expect(orders.detail.some((d) => d.includes('1000'))).toBe(true);
  });

  it('🔴 非法输入一律抛错（UI 降级回表格）', () => {
    expect(() => buildExplainTree('not a json {')).toThrow();
    expect(() => buildExplainTree(null)).toThrow();
    expect(() => buildExplainTree(42)).toThrow();
    expect(() => buildExplainTree([])).toThrow();
    expect(() => buildExplainTree({})).toThrow();
    expect(() => buildExplainTree({ foo: { bar: 1 } })).toThrow();
  });

  it('容错：直接给 query_block 本身也能解析', () => {
    const nodes = buildExplainTree({
      select_id: 1,
      cost_info: { query_cost: '2.00' },
      table: {
        table_name: 't1',
        access_type: 'const',
        key: 'PRIMARY',
        rows_examined_per_scan: 1,
        filtered: '100.00',
      },
    });
    expect(nodes[0].title).toBe('SELECT #1');
    expect(nodes[0].children[0].accessType).toBe('const');
  });

  it('纯表达式查询（无表）不产生空树', () => {
    const [root] = buildExplainTree('{"query_block": {"select_id": 1, "cost_info": {"query_cost": "0.00"}}}');
    expect(root.children).toHaveLength(0);
    expect(root.detail.length).toBeGreaterThan(0);
  });

  it('UNION：两个分支成为独立子节点', () => {
    const [root] = buildExplainTree({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '5.00' },
        union: [
          { query_block: { select_id: 1, table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 3, filtered: '100.00' } } },
          { query_block: { select_id: 2, table: { table_name: 'b', access_type: 'ref', key: 'k', rows_examined_per_scan: 2, filtered: '100.00' } } },
        ],
      },
    });
    expect(root.children.map((c) => c.title)).toEqual(['SELECT #1', 'SELECT #2']);
  });
});

describe('explainJsonToRows', () => {
  it('🔴 还原传统 11 列，行序与树遍历一致', () => {
    const rows = explainJsonToRows(PLAN_JSON_TEXT);
    expect(rows).toHaveLength(3); // orders / customers / tags
    expect(rows.map((r) => r.table)).toEqual(['orders', 'customers', 'tags']);
    const orders = rows[0];
    expect(orders.id).toBe('1');
    expect(orders.select_type).toBe('SIMPLE');
    expect(orders.type).toBe('ALL');
    expect(orders.rows).toBe(1000);
    expect(String(orders.Extra)).toContain('Using filesort');
    expect(String(orders.Extra)).toContain('Using where');
    const customers = rows[1];
    expect(customers.type).toBe('eq_ref');
    expect(customers.key).toBe('PRIMARY');
    expect(customers.ref).toBe('order_db.orders.customer_id');
    const tags = rows[2];
    expect(tags.select_type).toBe('DERIVED');
    expect(tags.Extra).toContain('Using index');
  });

  it('explainCell 能直接给还原出的行上色（type=ALL → danger）', () => {
    const rows = explainJsonToRows(PLAN_JSON_TEXT);
    expect(explainCell('type', rows[0].type).level).toBe('danger');
    expect(explainCell('Extra', rows[0].Extra).reasons).toContain('Using filesort');
  });

  it('非法输入抛错', () => {
    expect(() => explainJsonToRows('x')).toThrow();
    expect(() => explainJsonToRows(undefined)).toThrow();
  });
});
