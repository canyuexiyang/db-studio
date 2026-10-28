import { describe, it, expect } from 'vitest';
import { checkReadOnly, isReadOnly, checkMutationStatement, statementKindOf } from './index.js';

const M = 'mysql' as const;
const P = 'postgresql' as const;

/**
 * 0.7.1 需求 1 的判据：执行结果文案按语句分类分流。
 *
 * 这里钉住的是「分类不会把写操作误判成结果集」—— 一旦判错，UPDATE 就会继续
 * 显示「返回 0 行」，那正是本次要修的缺陷。
 */
describe('0.7.1 statementKindOf（执行结果分类）', () => {
  const cases: Array<[string, string]> = [
    ['SELECT * FROM t', 'select'],
    ['SELECT COUNT(*) FROM t WHERE a = 1', 'select'],
    ['SHOW TABLES', 'select'],
    ['DESCRIBE t', 'select'],
    ['EXPLAIN SELECT * FROM t', 'select'],
    ['INSERT INTO t (a) VALUES (1)', 'insert'],
    ['REPLACE INTO t (a) VALUES (1)', 'insert'],
    ['UPDATE t SET a = 1 WHERE id = 2', 'update'],
    ['DELETE FROM t WHERE id = 3', 'delete'],
    ['CREATE TABLE t (id int)', 'ddl'],
    ['ALTER TABLE t ADD COLUMN b int', 'ddl'],
    ['DROP TABLE t', 'ddl'],
    ['TRUNCATE TABLE t', 'ddl'],
    // 没有行数概念的：必须落 other，不能显示「返回 0 行」
    ['SET NAMES utf8mb4', 'other'],
    ['USE order_db', 'other'],
  ];

  for (const [sql, kind] of cases) {
    it(`${sql} → ${kind}`, () => {
      expect(statementKindOf(sql, M)).toBe(kind);
    });
  }

  it('解析失败 fail-safe 落 other（不猜方向）', () => {
    expect(statementKindOf('SELCT * FROM t', M)).toBe('other');
  });

  it('空语句落 other，不抛', () => {
    expect(statementKindOf('', M)).toBe('other');
    expect(statementKindOf('   ', M)).toBe('other');
  });

  it('多语句取第一条（执行链路逐条出结果，文案逐条走）', () => {
    expect(statementKindOf('UPDATE t SET a = 1; SELECT * FROM t', M)).toBe('update');
  });

  it('注释/字符串里的关键字不影响判定（走 AST 而非文本匹配）', () => {
    expect(statementKindOf("SELECT 'UPDATE t SET a = 1' AS s", M)).toBe('select');
  });
});


describe('SQL 只读守卫 — 允许的场景', () => {
  const allowed: Array<[string, 'mysql' | 'postgresql', string]> = [
    ['SELECT * FROM t', M, '基础查询'],
    ['SELECT id, name FROM t WHERE id = 1', M, '带 WHERE'],
    ['SELECT * FROM t LIMIT 10', M, '带 LIMIT'],
    ['SHOW TABLES', M, 'SHOW'],
    ['SHOW CREATE TABLE t', M, 'SHOW CREATE'],
    ['DESCRIBE t', M, 'DESCRIBE'],
    ['DESC t', M, 'DESC 简写'],
    ['EXPLAIN SELECT * FROM t', M, 'EXPLAIN'],
    ['USE db1', M, 'USE'],
    ['SET NAMES utf8mb4', M, 'SET NAMES（解析器不支持，走前置放行）'],
    ['SET SESSION time_zone = "+00:00"', M, 'SET 会话时区（白名单内）'],
    ['SET SESSION sql_mode = "STRICT_ALL_TABLES"', M, 'SET 会话 sql_mode'],
    // 误判防护：关键字出现在标识符/字符串里
    ['SELECT update_time FROM t', M, '字段名含 update'],
    ["SELECT * FROM t WHERE name = 'delete'", M, '字符串值含 delete'],
    ['SELECT * FROM t WHERE name = "drop"', M, '字符串值含 drop'],
    ['SELECT deleted_at FROM orders', M, '字段名含 delete'],
    // 误判防护：注释里含写操作关键字
    ['-- DROP TABLE t\nSELECT * FROM t', M, '行注释含 DROP'],
    ['/* UPDATE t SET a=1 */ SELECT * FROM t', M, '块注释含 UPDATE'],
    // 多条只读语句
    ['SELECT * FROM t; SELECT 2', M, '两条都是 SELECT'],
  ];

  for (const [sql, dialect, label] of allowed) {
    it(`允许：${label}`, () => {
      const r = checkReadOnly(sql, dialect);
      expect(r.allowed, `${label} 应被允许，实际拒绝原因：${r.reason} / ${r.message}`).toBe(true);
    });
  }
});

describe('SQL 只读守卫 — 拒绝的场景（安全红线）', () => {
  const rejected: Array<[string, 'mysql' | 'postgresql', string]> = [
    // 基础写操作
    ['UPDATE t SET a = 1', M, 'UPDATE'],
    ['DELETE FROM t WHERE id = 1', M, 'DELETE'],
    ['INSERT INTO t (a) VALUES (1)', M, 'INSERT'],
    ['TRUNCATE TABLE t', M, 'TRUNCATE'],
    ['DROP TABLE t', M, 'DROP'],
    ['ALTER TABLE t ADD COLUMN b INT', M, 'ALTER'],
    ['CREATE TEMPORARY TABLE x (id INT)', M, 'CREATE TEMPORARY TABLE'],
    ['RENAME TABLE a TO b', M, 'RENAME'],
    ['REPLACE INTO t (a) VALUES (1)', M, 'REPLACE'],
    ['LOAD DATA INFILE "/tmp/x" INTO TABLE t', M, 'LOAD DATA'],
    // 正则方案会漏判的经典场景
    ['CALL some_proc()', M, 'CALL（正则必漏）'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", M, 'SELECT INTO OUTFILE（正则必漏）'],
    ['SELECT * FROM t FOR UPDATE', M, 'SELECT FOR UPDATE（加锁）'],
    ['SELECT * FROM t LOCK IN SHARE MODE', M, 'LOCK IN SHARE MODE（加锁）'],
    ['WITH x AS (SELECT 1) UPDATE t SET a = 1', P, 'PG WITH…UPDATE（正则必漏）'],
    // 多语句第二条
    ['SELECT 1; DROP TABLE t', M, '多语句第二条写操作（正则必漏）'],
    ['SELECT * FROM t; DELETE FROM t', M, '多语句第二条 DELETE'],
    // 危险的 SET
    ['SET autocommit = 0', M, 'SET autocommit（有副作用）'],
    ['SET @@global.read_only = 1', M, 'SET @@global（全局级）'],
    ['SET GLOBAL max_connections = 1000', M, 'SET GLOBAL'],
    ['SET @x = 1', M, 'SET 用户变量'],
    // 语法错误 → fail-closed
    ['SELCT * FROM', M, '语法错误（fail-closed）'],
    ['SELECT FROM WHERE', M, '语法错误 2（fail-closed）'],
  ];

  for (const [sql, dialect, label] of rejected) {
    it(`拒绝：${label}`, () => {
      const r = checkReadOnly(sql, dialect);
      expect(r.allowed, `${label} 应被拒绝，实际放行了`).toBe(false);
    });
  }
});

describe('SQL 只读守卫 — 失败语义与定位信息', () => {
  it('解析失败时走 fail-closed 并给出明确原因', () => {
    const r = checkReadOnly('SELCT * FROM', M);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('parse-failed');
    expect(r.message).toContain('无法判定');
  });

  it('多语句被拒时能定位到是哪一条', () => {
    const r = checkReadOnly('SELECT 1; DROP TABLE t', M);
    expect(r.allowed).toBe(false);
    expect(r.statementTypes).toEqual(['select', 'drop']);
    expect(r.offendingStatement).toContain('第 2 条');
  });

  it('返回语句类型，便于日志与诊断', () => {
    expect(checkReadOnly('SELECT * FROM t', M).statementType).toBe('select');
    expect(checkReadOnly('SHOW TABLES', M).statementType).toBe('show');
  });

  it('空语句被拒绝', () => {
    const r = checkReadOnly('   ', M);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('empty');
  });

  it('isReadOnly 是 checkReadOnly 的便捷包装', () => {
    expect(isReadOnly('SELECT 1', M)).toBe(true);
    expect(isReadOnly('DROP TABLE t', M)).toBe(false);
  });
});

describe('SQL 只读守卫 — PostgreSQL 方言', () => {
  it('PG 基础查询允许', () => {
    expect(checkReadOnly('SELECT * FROM t', P).allowed).toBe(true);
  });

  it('PG 写操作拒绝', () => {
    expect(checkReadOnly('UPDATE t SET a = 1', P).allowed).toBe(false);
    expect(checkReadOnly('DELETE FROM t', P).allowed).toBe(false);
  });

  it('PG WITH…UPDATE 拒绝（CTE 后接写操作）', () => {
    const r = checkReadOnly('WITH x AS (SELECT 1) UPDATE t SET a = 1', P);
    expect(r.allowed).toBe(false);
    expect(r.statementType).toBe('update');
  });
});

// ---------- V10：网格写语句的结构白名单（表达式模式的真防线） ----------

describe('V10 checkMutationStatement（网格保存链路结构校验）', () => {
  it('合法写语句放行：带 WHERE 的 UPDATE/DELETE、INSERT', () => {
    for (const sql of [
      'UPDATE `db`.`order` SET amount=? WHERE id=?',
      'UPDATE `db`.`t` SET created_at = NOW() WHERE id = 1',
      'UPDATE `db`.`t` SET note = CONCAT(note, "-x") WHERE id = 1',
      'DELETE FROM `db`.`t` WHERE id=?',
      'INSERT INTO `db`.`t` (a, b) VALUES (?, ?)',
      'INSERT INTO `db`.`t` (created_at) VALUES (NOW())',
    ]) {
      const r = checkMutationStatement(sql);
      expect(r.allowed, sql).toBe(true);
    }
  });

  it('🔴 无 WHERE 的 UPDATE/DELETE 被拒（网格语义永远是定位行）', () => {
    const u = checkMutationStatement('UPDATE `db`.`t` SET a=1');
    expect(u.allowed).toBe(false);
    expect(u.reason).toBe('missing-where');
    const d = checkMutationStatement('DELETE FROM `db`.`t`');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('missing-where');
  });

  it('🔴 多语句被拒（表达式里藏第二条是最短的攻击路径）', () => {
    const r = checkMutationStatement('UPDATE `db`.`t` SET a=1 WHERE id=1; DROP TABLE `t`');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('multi-statement-rejected');
  });

  it('🔴 非 DML 语句类型被拒（DDL / 权限 / CALL 不许走网格保存）', () => {
    for (const sql of [
      'DROP TABLE `db`.`t`',
      'TRUNCATE TABLE `db`.`t`',
      'ALTER TABLE `db`.`t` ADD COLUMN x INT',
      'CREATE TABLE `db`.`t2` (id INT)',
      'GRANT ALL ON *.* TO u',
      'CALL some_proc()',
    ]) {
      const r = checkMutationStatement(sql);
      expect(r.allowed, sql).toBe(false);
      expect(r.reason).toBe('not-in-whitelist');
    }
  });

  it('空语句被拒', () => {
    expect(checkMutationStatement('   ').allowed).toBe(false);
    expect(checkMutationStatement('').reason).toBe('empty');
  });

  it('解析失败 → fail-closed（宁可误拦不可漏放）', () => {
    const r = checkMutationStatement('UPDATE `db`.`t` SET = WHERE WHERE');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('parse-failed');
  });

  it('🔴 这一层独立于只读守卫：正常连接（非只读）也走它，SELECT 被拒', () => {
    // checkReadOnly 是给「只读连接」的；checkMutationStatement 是给「正常连接的写链路」的。
    // SELECT 对前者是放行、对后者必须拒 —— 网格保存链路不该出现 SELECT。
    expect(checkReadOnly('SELECT * FROM t WHERE id=1', 'mysql').allowed).toBe(true);
    expect(checkMutationStatement('SELECT * FROM t WHERE id=1').allowed).toBe(false);
  });
});

/**
 * T19：`INSERT INTO t () VALUES ()`（全默认值插入）的解析器兼容。
 *
 * 🔴 这组用例的由来是一次**真库门禁抓到的缺陷**，不是补测：
 *    T19 的空白行生成 `INSERT INTO t () VALUES ()`，文本正确、单测全绿、UI 预演也正常，
 *    但真机执行时被自己的守卫拦死 —— `node-sql-parser` 对「全默认值插入」的
 *    **三种合法写法全部解析失败**（`() VALUES ()` / `VALUES ()` / `(c) VALUES (DEFAULT)`）。
 *    也就是说：单测断「SQL 文本对不对」和 UI 断「页面上能不能点」都覆盖不到
 *    「这条文本能不能过解析器」—— 只有把文本真的送进执行链路才暴露。
 */
describe('T19 全默认值 INSERT：解析前的等价改写', () => {
  it('单行空插入放行（改写的存在意义）', () => {
    const r = checkMutationStatement('INSERT INTO `db`.`t` () VALUES ()');
    expect(r.allowed).toBe(true);
    expect(r.statementType).toBe('insert');
  });

  it('多行空插入（脚本合并后可能出现）同样放行', () => {
    expect(checkMutationStatement('INSERT INTO `db`.`t` () VALUES (), ()').allowed).toBe(true);
  });

  it('未加反引号的表名与空白差异不影响', () => {
    expect(checkMutationStatement('insert   into t()values()').allowed).toBe(true);
    expect(checkMutationStatement('INSERT INTO db.t () VALUES ()').allowed).toBe(true);
  });

  it('🔴 反例必须仍被拒：列清单为空但 VALUES 里有值（形状非法）', () => {
    // 改写只认「全是空元组」这一种形状；带值的必须照旧 fail-closed，
    // 否则等于修一个解析器兼容问题顺手开了个语法后门。
    const r = checkMutationStatement('INSERT INTO `db`.`t` () VALUES (1)');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('parse-failed');
  });

  it('🔴 反例必须仍被拒：空插入后面拼第二条语句（改写不能吞掉多语句）', () => {
    const r = checkMutationStatement('INSERT INTO `db`.`t` () VALUES (); DROP TABLE `db`.`x`');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('multi-statement-rejected');
  });

  it('🔴 反例必须仍被拒：只读模式下空插入依然是写语句', () => {
    // 改写让解析**成功**了，所以拒绝原因从 parse-failed 变成 not-in-whitelist ——
    // 这正是要盯的点：改写后仍必须落在白名单之外。
    const r = checkReadOnly('INSERT INTO `db`.`t` () VALUES ()', M);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not-in-whitelist');
    expect(r.statementType).toBe('insert');
  });

  it('🔴 反例必须仍被拒：改写不能把别的非法语句顺便救活', () => {
    expect(checkMutationStatement('INSERT INTO `db`.`t` () VALUES () SELECT 1').allowed).toBe(false);
    expect(checkReadOnly('SELCT * FROM t', M).reason).toBe('parse-failed');
  });
});
