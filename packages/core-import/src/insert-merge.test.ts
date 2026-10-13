/**
 * insert-merge 的断言纪律：
 *
 * 这里的每一条都在守护「合并错一次 = 数据损坏」。所以断言分两类：
 *  - **该合并的**：确认能力在（否则性能修复没生效）
 *  - **绝不能合并的**：确认安全性（这是重点，占比更高）
 *
 * 每条「能合并」都要配一条「不能合并」的对照，否则无法区分
 * 「判定正确」与「判定恒为 true」。
 */

import { describe, it, expect } from 'vitest';
import {
  parseInsertShape,
  canMergeWith,
  mergeTwoInsert,
  MERGED_INSERT_MAX_ROWS,
  MERGED_INSERT_MAX_BYTES,
} from './insert-merge.js';
import type { InsertShape } from './insert-merge-types.js';

describe('parseInsertShape', () => {
  it('标准 INSERT 能识别出库/表/列/VALUES', () => {
    const s = parseInsertShape("INSERT INTO `shop`.`orders` (`id`, `name`) VALUES (1, 'a'), (2, 'b')");
    expect(s.mergeable).toBe(true);
    expect(s.database).toBe('shop');
    expect(s.table).toBe('orders');
    expect(s.columns).toEqual(['id', 'name']);
    expect(s.valuesClause).toBe("(1, 'a'), (2, 'b')");
  });

  it('无库前缀时database 为空串', () => {
    const s = parseInsertShape('INSERT INTO orders (id) VALUES (1)');
    expect(s.mergeable).toBe(true);
    expect(s.database).toBe('');
    expect(s.table).toBe('orders');
  });

  it('INSERT IGNORE / LOW_PRIORITY 等修饰词仍可识别', () => {
    expect(parseInsertShape('INSERT IGNORE INTO t (a) VALUES (1)').mergeable).toBe(true);
    expect(parseInsertShape('INSERT LOW_PRIORITY INTO t (a) VALUES (1)').mergeable).toBe(true);
  });

  /**
   * 🔴 这一类必须全部拒绝 —— 每一条合并都会让数据出错，而不是慢一点。
   */
  it('🔴 错误输入：ON DUPLICATE KEY 不合并（幂等语义会变）', () => {
    expect(parseInsertShape('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = a + 1').mergeable)
      .toBe(false);
  });

  it('🔴 错误输入：INSERT ... SELECT 不合并（行数未知）', () => {
    expect(parseInsertShape('INSERT INTO t (a) SELECT x FROM s').mergeable).toBe(false);
  });

  it('🔴 错误输入：非 INSERT 语句不合并', () => {
    expect(parseInsertShape('UPDATE t SET a = 1').mergeable).toBe(false);
    expect(parseInsertShape('CREATE TABLE t (a int)').mergeable).toBe(false);
    expect(parseInsertShape('SELECT 1').mergeable).toBe(false);
    expect(parseInsertShape('DELETE FROM t').mergeable).toBe(false);
  });

  it('🔴 错误输入：含分号的语句不合并（拼起来就是多语句）', () => {
    expect(parseInsertShape('INSERT INTO t (a) VALUES (1);').mergeable).toBe(false);
  });

  it('🔴 错误输入：带前置 CTE(WITH) 的不合并', () => {
    expect(parseInsertShape('WITH x AS (SELECT 1) INSERT INTO t (a) SELECT * FROM x').mergeable).toBe(false);
  });

  it('mysqldump 的条件注释头部不影响识别', () => {
    const s = parseInsertShape('/*!40101 INSERT INTO `t` (`a`) VALUES (1) */');
    expect(s.mergeable).toBe(true);
    expect(s.table).toBe('t');
  });

  it('空串/空白不合并', () => {
    expect(parseInsertShape('').mergeable).toBe(false);
    expect(parseInsertShape('   ').mergeable).toBe(false);
  });
});

describe('canMergeWith', () => {
  const a = parseInsertShape('INSERT INTO db1.t (id, name) VALUES (1, \'a\')');
  const b = parseInsertShape('INSERT INTO db1.t (id, name) VALUES (2, \'b\')');

  it('同库同表同列 → 可合并', () => {
    expect(canMergeWith(a, b)).toBe(true);
  });

  it('🔴 错误输入：列顺序不同不合并（值会落进错误的列）', () => {
    const swapped = parseInsertShape('INSERT INTO db1.t (name, id) VALUES (\'c\', 3)');
    expect(canMergeWith(a, swapped)).toBe(false);
  });

  it('🔴 错误输入：列数不同不合并', () => {
    const fewer = parseInsertShape('INSERT INTO db1.t (id) VALUES (9)');
    expect(canMergeWith(a, fewer)).toBe(false);
  });

  it('🔴 错误输入：不同表不合并', () => {
    const other = parseInsertShape('INSERT INTO db1.t2 (id, name) VALUES (1, \'a\')');
    expect(canMergeWith(a, other)).toBe(false);
  });

  it('🔴 错误输入：不同库不合并', () => {
    const other = parseInsertShape('INSERT INTO db2.t (id, name) VALUES (1, \'a\')');
    expect(canMergeWith(a, other)).toBe(false);
  });

  it('🔴 错误输入：任一方不可合并则整体不合并', () => {
    const sel = parseInsertShape('INSERT INTO db1.t (id, name) SELECT 1, 2');
    expect(canMergeWith(a, sel)).toBe(false);
    expect(canMergeWith(sel, a)).toBe(false);
  });

  it('表名大小写差异不影响判等（MySQL 表名不区分大小写）', () => {
    const upper = parseInsertShape('INSERT INTO DB1.T (id, name) VALUES (5, \'e\')');
    expect(canMergeWith(a, upper)).toBe(true);
  });
});

describe('mergeTwoInsert', () => {
  it('拼接结果是一条语句、含两组值', () => {
    const p = parseInsertShape('INSERT INTO `db1`.`t` (`id`) VALUES (1)');
    const n = parseInsertShape('INSERT INTO `db1`.`t` (`id`) VALUES (2)');
    const merged = mergeTwoInsert('INSERT INTO `db1`.`t` (`id`) VALUES (1)', p, n);
    expect(merged).toBe('INSERT INTO `db1`.`t` (`id`) VALUES (1), (2)');
    // 拼接后不得出现分号（会变成多语句）
    expect(merged.includes(';')).toBe(false);
  });

  it('🔴 拼接保留原文库表名的反引号写法（一个字符都不解释）', () => {
    const p = parseInsertShape('INSERT INTO `my-db`.`weird table` (`a`) VALUES (1)');
    const n = parseInsertShape('INSERT INTO `my-db`.`weird table` (`a`) VALUES (2)');
    const merged = mergeTwoInsert('INSERT INTO `my-db`.`weird table` (`a`) VALUES (1)', p, n);
    expect(merged).toContain('`my-db`');
    expect(merged).toContain('`weird table`');
    expect(merged).toContain('(1), (2)');
  });

  it('首条自身已有多组值时，新值接在末尾', () => {
    const p = parseInsertShape('INSERT INTO t (a) VALUES (1), (2)');
    const n = parseInsertShape('INSERT INTO t (a) VALUES (3)');
    const merged = mergeTwoInsert('INSERT INTO t (a) VALUES (1), (2)', p, n);
    expect(merged).toBe('INSERT INTO t (a) VALUES (1), (2), (3)');
  });

  it('批量上限常量是合理的（防止一条语句无限膨胀）', () => {
    expect(MERGED_INSERT_MAX_ROWS).toBeGreaterThan(0);
    expect(MERGED_INSERT_MAX_ROWS).toBeLessThanOrEqual(2000);
  });
});
/**
 * 🔴 回归守卫：第一版的三类真实 bug（都曾让修复"静默失效"或"数据损坏"）。
 *
 * 这三条不是补充测试，是**事故记录**：每一条都对应一次"测试红了才知道"的真问题。
 */
describe('insert-merge 回归守卫（第一版的三个真 bug）', () => {
  /**
   * Bug 1：表名正则写成 `[^\s(]+`，遇到反引号里的空格（`weird table`）提前截断，
   * 拼接结果丢掉整组新值 —— SQL 仍合法、数据静默少一段。
   */
  it('🔴 表名含空格（反引号标识符）时拼接不丢值', () => {
    const p = parseInsertShape('INSERT INTO `db`.`weird table` (`a`) VALUES (1)');
    const n = parseInsertShape('INSERT INTO `db`.`weird table` (`a`) VALUES (2)');
    expect(p.mergeable).toBe(true);
    expect(p.table).toBe('weird table');
    const merged = mergeTwoInsert('INSERT INTO `db`.`weird table` (`a`) VALUES (1)', p, n);
    // 关键：新值必须在
    expect(merged).toContain('(1), (2)');
  });

  /**
   * Bug 2：一条大正则同时吃「表名 + 列清单 + VALUES」，各段互相抢字符，
   * VALUES 组恒为空 → 所有 INSERT 都判不出可合并，性能修复静默失效。
   * 守卫方式：最普通的 INSERT 必须判为可合并。
   */
  it('🔴 最普通的 INSERT 必须判为可合并（否则性能修复整体失效）', () => {
    const s = parseInsertShape("INSERT INTO users (id, name) VALUES (1, 'a')");
    expect(s.mergeable).toBe(true);
    expect(s.columns).toEqual(['id', 'name']);
    expect(s.valuesClause).toBe("(1, 'a')");
  });

  /**
   * Bug 3：头部切分锚定在末尾，VALUES 子句里含 'VALUES' 字面量时被截断。
   */
  it('🔴 值里含 VALUES 字面量时拼接仍完整', () => {
    const sql = "INSERT INTO t (a) VALUES ('VALUES')";
    const p = parseInsertShape(sql);
    const n = parseInsertShape("INSERT INTO t (a) VALUES ('x')");
    expect(p.mergeable).toBe(true);
    const merged = mergeTwoInsert(sql, p, n);
    expect(merged).toBe("INSERT INTO t (a) VALUES ('VALUES'), ('x')");
  });

  /**
   * 🔴 值里含逗号与右括号（字符串字面量）不能被误判成结构分隔。
   * 判据是 parseInsertShape 能把 valuesClause 原样取出。
   */
  it('🔴 值里含逗号/括号/转义引号时 valuesClause 原样保留', () => {
    const sql = "INSERT INTO t (a, b) VALUES ('x,y', 'p)q')";
    const s = parseInsertShape(sql);
    expect(s.mergeable).toBe(true);
    expect(s.columns).toEqual(['a', 'b']);
    expect(s.valuesClause).toBe("('x,y', 'p)q')");
  });

  /**
   * 🔴 反引号标识符里含点（`my.db`）时库名/表名不能拆错 ——
   * 拆错会把两个不同库的 INSERT 判成可合并，跨库串数据。
   */
  it('🔴 标识符含点时库名/表名拆分正确', () => {
    const s = parseInsertShape('INSERT INTO `my.db`.`t` (`a`) VALUES (1)');
    expect(s.database).toBe('my.db');
    expect(s.table).toBe('t');
    // 与另一个库同名的表不得被判成可合并
    const other = parseInsertShape('INSERT INTO `other`.`t` (`a`) VALUES (2)');
    expect(canMergeWith(s, other)).toBe(false);
  });
});

/**
 * 🔴 双实现漂移防线（本包既有约定，见 index.ts 顶部）。
 *
 * 实现只在 runtime.cjs（CJS），TS 侧是薄封装。这条断言确保两者**行为一致**——
 * worker 用的是 CJS 版，单测跑的是 TS 出口，两者一旦分叉，
 * 就会出现"测试全绿、真机出问题"（本项目最贵的一类故障）。
 *
 * 覆盖多种输入形态：能合的、不能合的、含特殊标识符的。
 */
describe('CJS 实现与 TS 出口行为一致', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cjs = require('./runtime.cjs');

  const samples = [
    "INSERT INTO t (a) VALUES (1)",
    "INSERT INTO `db`.`t` (a, b) VALUES (1, 'x')",
    'INSERT INTO `my.db`.`weird table` (`a`) VALUES (1)',
    'INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 1',
    'INSERT INTO t (a) SELECT x FROM s',
    'UPDATE t SET a = 1',
    "INSERT INTO t (a, b) VALUES ('x,y', 'p)q')",
  ];

  it('parseInsertShape 在 CJS 与 TS 出口上判定完全相同', () => {
    for (const sql of samples) {
      expect(cjs.parseInsertShape(sql)).toEqual(parseInsertShape(sql));
    }
  });

  it('canMergeWith 在 CJS 与 TS 出口上判定完全相同', () => {
    const shapes = samples.map((s) => parseInsertShape(s));
    for (const a of shapes) {
      for (const b of shapes) {
        expect(cjs.canMergeWith(a, b)).toBe(canMergeWith(a, b));
      }
    }
  });

  it('mergeTwoInsert 在 CJS 与 TS 出口上产出一致', () => {
    const pairs: [string, InsertShape][] = [
      ['INSERT INTO t (a) VALUES (1)', parseInsertShape('INSERT INTO t (a) VALUES (1)')],
      ['INSERT INTO `d`.`t` (a) VALUES (1), (2)', parseInsertShape('INSERT INTO `d`.`t` (a) VALUES (1), (2)')],
      [
        'INSERT INTO `my.db`.`weird table` (`a`) VALUES (1)',
        parseInsertShape('INSERT INTO `my.db`.`weird table` (`a`) VALUES (1)'),
      ],
    ];
    const nxt = parseInsertShape('INSERT INTO t (a) VALUES (9)');
    for (const [sql, p] of pairs) {
      expect(cjs.mergeTwoInsert(sql, p, nxt)).toBe(mergeTwoInsert(sql, p, nxt));
    }
  });

  it('批量上限常量两边同值（worker 用 CJS 的值做判断）', () => {
    expect(cjs.MERGED_INSERT_MAX_ROWS).toBe(MERGED_INSERT_MAX_ROWS);
    expect(cjs.MERGED_INSERT_MAX_BYTES).toBe(MERGED_INSERT_MAX_BYTES);
  });
});

/**
 * 🔴🔴 数据丢失回归守卫（2026-10-13 真实缺陷）
 *
 * ## 现象
 * 用户脚本：N 张表的 CREATE TABLE + 每表 50000 行 INSERT。
 * 执行后表建成了，但**每表只有 30~50 行**，而 UI 显示"执行成功、无失败"。
 *
 * ## 机制（保留记录，这是本项目最隐蔽的一类错）
 * worker 的合并写法是：
 *   pending.sql   = mergeTwoInsert(pending.sql, pending.shape, shape)
 *   pending.shape = **没有更新**   ← 致命
 * 于是第二次合并时传进去的 prevShape 仍是**最初那一条**的 valuesClause，
 * 而 prevSql 已经含 2 组 —— 结果 head + 最初那 1 组 + 新那 1 组 = **只2 组**，
 * 中间那组被静默丢弃。再合并又回到 2 组，于是每批恒定只剩最后 2 组。
 *
 * 真机实测吻合：每批 affectedRows 恒为 2，2000 行脚本只落 2002 行（含表头语句）。
 *
 * ## 守卫方式
 * **完全按worker 的调用方式**（不更新 shape）连续合并，然后数元组数量。
 * 这正是旧实现会红、新实现才绿的写法 —— 用「正确用法」写的断言抓不到这个 bug。
 */
describe('🔴 mergeTwoInsert 幂等性：连续合并不得丢数据组', () => {
  const mk = (i: number) => `INSERT INTO \`t\` (\`id\`, \`v\`) VALUES (${i}, 'row_${i}')`;
  const countGroups = (sql: string) => (sql.match(/\(\d+, 'row_\d+'\)/g) ?? []).length;

  it('🔴 501 次连续合并（不更新 shape）后元组数 = 501', () => {
    const first = mk(1);
    const staleShape = parseInsertShape(first); // 故意一直用最初那个 shape
    let sql = first;
    for (let i = 2; i <= 501; i++) {
      sql = mergeTwoInsert(sql, staleShape, parseInsertShape(mk(i)));
    }
    expect(countGroups(sql)).toBe(501);
  });

  it('🔴 错误实现反查：旧写法（信任 prevShape）在同样输入下只剩 2 组', () => {
    // 复刻旧实现，证明这条断言确实有证伪能力
    const oldMerge = (prevSql: string, prev: InsertShape, next: InsertShape) => {
      const at = /\s+VALUES\s+/i.exec(prevSql)!;
      return `${prevSql.slice(0, at.index)} VALUES ${prev.valuesClause}, ${next.valuesClause}`;
    };
    const first = mk(1);
    const stale = parseInsertShape(first);
    let sql = first;
    for (let i = 2; i <= 501; i++) {
      sql = oldMerge(sql, stale, parseInsertShape(mk(i)));
    }
    // 旧实现丢了 499 组 —— 这就是用户看到的「只落几十行」
    expect(countGroups(sql)).toBeLessThan(501);
  });

  it('首组与末组都在（不只是数量对，内容也要对）', () => {
    const first = mk(1);
    const stale = parseInsertShape(first);
    let sql = first;
    for (let i = 2; i <= 51; i++) {
      sql = mergeTwoInsert(sql, stale, parseInsertShape(mk(i)));
    }
    const vals = sql.slice(sql.indexOf('VALUES'));
    expect(vals).toContain("(1, 'row_1')");
    expect(vals).toContain("(51, 'row_51')");
    expect(countGroups(sql)).toBe(51);
  });

  it('值里含括号/逗号/VALUES 字面量时切分仍正确', () => {
    const a = "INSERT INTO t (a) VALUES ('x,y'), ('p)q')";
    const b = "INSERT INTO t (a) VALUES ('VALUES')";
    const pa = parseInsertShape(a);
    const merged = mergeTwoInsert(a, pa, parseInsertShape(b));
    // 三个值组必须都在，且引号内的括号/逗号没被当成分隔符
    expect(merged).toBe("INSERT INTO t (a) VALUES ('x,y'), ('p)q'), ('VALUES')");
  });

  it('值里含括号/逗号时连续合并 100 次仍无损', () => {
    // 这是切分逻辑最容易崩的输入：每次合并都会重新切一遍 prevSql
    const first = "INSERT INTO t (a) VALUES ('x,y')";
    const stale = parseInsertShape(first);
    let sql = first;
    for (let i = 0; i < 100; i++) {
      sql = mergeTwoInsert(sql, stale, parseInsertShape(`INSERT INTO t (a) VALUES ('p${i})q,c')`));
    }
    expect((sql.match(/\('[^']*'\)/g) ?? []).length).toBe(101);
    expect(sql).toContain("('x,y')");
    expect(sql).toContain("('p99)q,c')");
  });

  it('表名带空格（反引号标识符）连续合并仍无损', () => {
    const first = 'INSERT INTO `my.db`.`weird table` (`a`) VALUES (1)';
    const stale = parseInsertShape(first);
    let sql = first;
    for (let i = 2; i <= 20; i++) {
      sql = mergeTwoInsert(sql, stale, parseInsertShape(`INSERT INTO \`my.db\`.\`weird table\` (\`a\`) VALUES (${i})`));
    }
    expect((sql.match(/\(\d+\)/g) ?? []).length).toBe(20);
    expect(sql).toContain('`weird table`');
  });
});
