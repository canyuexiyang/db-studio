import { describe, it, expect } from 'vitest';
import { lintSql, type LintContext, type SqlDiagnostic } from './lint.js';

// ---------- 断言小工具 ----------

function rules(sql: string, ctx?: LintContext): string[] {
  return lintSql(sql, ctx).map((d) => d.rule);
}

function only(sql: string, ctx?: LintContext): SqlDiagnostic {
  const all = lintSql(sql, ctx);
  expect(all.length).toBe(1);
  return all[0];
}

/** 用「原文切片」断言位置，比手写下标更能防住 off-by-one */
function span(sql: string, ctx?: LintContext): string[] {
  return lintSql(sql, ctx).map((d) => sql.slice(d.from, d.to));
}

const USERS: LintContext = {
  schemaReady: true,
  tables: ['users', 'orders'],
  columns: { users: ['id', 'name', 'email'], orders: ['id', 'user_id'] },
};

// ---------- 1. 空输入 / 纯注释：一律不报 ----------

describe('lintSql · 空输入与只有注释的输入', () => {
  it('空字符串 → 空数组', () => {
    expect(lintSql('')).toEqual([]);
  });

  it('纯空白 → 空数组', () => {
    expect(lintSql('   \n\t  \r\n')).toEqual([]);
  });

  it('只有行注释 → 空数组（注释里的 SELECT 不算）', () => {
    expect(lintSql('-- SELECT FROM')).toEqual([]);
    expect(lintSql('# SELECT (')).toEqual([]);
  });

  it('只有完整的块注释 → 空数组', () => {
    expect(lintSql('/* SELECT * FROM ( */')).toEqual([]);
  });

  it('只有分号的空语句 → 空数组（不清屏后立刻飘红）', () => {
    expect(lintSql('  ;;  ')).toEqual([]);
  });

  it('非字符串入参（JS 调用方传 null）→ 空数组，不抛异常', () => {
    expect(lintSql(null as unknown as string)).toEqual([]);
    expect(lintSql(undefined as unknown as string)).toEqual([]);
  });

  it('合法的单表查询 → 空数组（无 schema 时）', () => {
    expect(lintSql('SELECT id, name FROM users WHERE id > 10 ORDER BY id DESC LIMIT 20')).toEqual([]);
  });
});

// ---------- 2. 未闭合字符串 / 注释 ----------

describe('lintSql · 未闭合的字符串与注释', () => {
  it("未闭合单引号：报在起始引号上（from 是引号下标）", () => {
    const d = only("SELECT 'abc");
    expect(d.rule).toBe('unclosed-string');
    expect(d.from).toBe(7); // "SELECT " 之后那个 '
    expect(d.to).toBe(8); // 只划一个字符，不让后半屏全红
    expect(d.severity).toBe('error');
  });

  it('未闭合双引号：同样报在起始引号', () => {
    const d = only('SELECT "a');
    expect(d.rule).toBe('unclosed-string');
    expect(d.from).toBe(7);
  });

  it('未闭合反引号：按未闭合的标识符引用报错', () => {
    const d = only('SELECT `a');
    expect(d.rule).toBe('unclosed-string');
    expect(d.from).toBe(7);
  });

  it("字符串里的括号不误报：SELECT '('", () => {
    expect(lintSql("SELECT '('")).toEqual([]);
  });

  it("字符串里的右括号不误报：WHERE s = ')'", () => {
    expect(lintSql("SELECT * FROM t WHERE s = ')'")).toEqual([]);
  });

  it("字符串里的关键字不误报（也不会被当成缺表名）：SELECT 'from'", () => {
    expect(lintSql("SELECT 'from'")).toEqual([]);
    expect(rules("SELECT * FROM t WHERE s = 'from join on'")).toEqual([]);
  });

  it("字符串里的分号不切语句：SELECT 'a;b' 只有一条语句", () => {
    expect(lintSql("SELECT 'a;b'")).toEqual([]);
  });

  it('转义过的引号不算未闭合', () => {
    expect(lintSql("SELECT 'a\\'b'")).toEqual([]);
  });

  it('未闭合块注释：/* abc → 报在 /* 上', () => {
    const d = only('/* abc');
    expect(d.rule).toBe('unclosed-comment');
    expect(d.from).toBe(0);
    expect(d.to).toBe(2);
    expect(d.severity).toBe('error');
  });

  it('/*/ 这种长度 3 的也算未闭合', () => {
    expect(rules('SELECT 1 /*/')).toEqual(['unclosed-comment']);
  });

  it('闭合的块注释里的括号不误报', () => {
    expect(lintSql('/* ( ) */ SELECT 1')).toEqual([]);
  });

  it('行注释里的括号与引号不误报', () => {
    expect(lintSql("-- SELECT ('\nSELECT 1")).toEqual([]);
  });
});

// ---------- 3. 括号 ----------

describe('lintSql · 括号配对', () => {
  it('多余的右括号：报在多余的那个 ) 上', () => {
    const sql = 'SELECT (a)) FROM t';
    const d = only(sql);
    expect(d.rule).toBe('unbalanced-paren');
    expect(d.from).toBe(10);
    expect(sql.slice(d.from, d.to)).toBe(')');
  });

  it('未闭合的左括号：报在 ( 自己身上', () => {
    const sql = 'SELECT (a FROM t';
    const d = only(sql);
    expect(d.rule).toBe('unbalanced-paren');
    expect(d.from).toBe(7);
    expect(sql.slice(d.from, d.to)).toBe('(');
  });

  it('正确嵌套 ((a)) 不报', () => {
    expect(lintSql('SELECT ((a)) FROM t')).toEqual([]);
  });

  it('函数调用与子查询嵌套混在一起也不报', () => {
    expect(lintSql("SELECT COUNT(*) FROM (SELECT id FROM t WHERE a IN (1, 2)) x")).toEqual([]);
  });

  it('括号里的分号不当语句分隔符', () => {
    // `;` 在深度 1，不切语句 → 整段是一条语句，只有一个未闭合的 (
    expect(rules('SELECT (1; 2')).toEqual(['unbalanced-paren']);
  });
});

// ---------- 4. 列表项为空 ----------

describe('lintSql · 空列表项', () => {
  it('SELECT , → empty-list，报在逗号', () => {
    const sql = 'SELECT ,';
    const d = only(sql);
    expect(d.rule).toBe('empty-list');
    expect(d.from).toBe(7);
    expect(d.severity).toBe('error');
  });

  it('SELECT a,,b → 报在第二个逗号', () => {
    const sql = 'SELECT a,,b';
    const d = only(sql);
    expect(d.rule).toBe('empty-list');
    expect(d.from).toBe(9);
  });

  it('尾随逗号 SELECT a, FROM t → empty-list', () => {
    const sql = 'SELECT a, FROM t';
    const d = only(sql);
    expect(d.rule).toBe('empty-list');
    expect(sql.slice(d.from, d.to)).toBe(',');
  });

  it('函数参数里的空项 CONCAT(a, ) → empty-list', () => {
    expect(rules('SELECT CONCAT(a, ) FROM t')).toEqual(['empty-list']);
  });

  it('合法逗号列表不误报', () => {
    expect(lintSql('SELECT a, b, c FROM t GROUP BY a, b')).toEqual([]);
  });

  it('SELECT *, b 不误报（`*` 后面可以跟逗号）', () => {
    expect(lintSql('SELECT *, b FROM t')).toEqual([]);
  });

  it('ORDER BY a ASC, b DESC 不误报（ASC 后面可以跟逗号）', () => {
    expect(lintSql('SELECT * FROM t ORDER BY a ASC, b DESC')).toEqual([]);
  });

  it('LIMIT 1, 10 不误报', () => {
    expect(lintSql('SELECT * FROM t LIMIT 1, 10')).toEqual([]);
  });
});

// ---------- 5. FROM / JOIN 缺表名 ----------

describe('lintSql · FROM / JOIN 后面缺表名', () => {
  it('SELECT * FROM → missing-table，报在 FROM', () => {
    const sql = 'SELECT * FROM';
    const d = only(sql);
    expect(d.rule).toBe('missing-table');
    expect(d.from).toBe(9);
    expect(sql.slice(d.from, d.to)).toBe('FROM');
    expect(d.severity).toBe('error');
  });

  it('SELECT * FROM t JOIN → missing-table，报在 JOIN', () => {
    const sql = 'SELECT * FROM t JOIN';
    const d = only(sql);
    expect(d.rule).toBe('missing-table');
    expect(sql.slice(d.from, d.to)).toBe('JOIN');
  });

  it('LEFT JOIN 缺表 → 报在 JOIN 而不是 LEFT', () => {
    expect(span('SELECT * FROM t LEFT JOIN')).toEqual(['JOIN']);
  });

  it('FROM (SELECT 1) x 不误报（子查询是合法表源）', () => {
    expect(lintSql('SELECT * FROM (SELECT 1) x')).toEqual([]);
  });

  it('DELETE FROM 缺表也报（且同时报 no-where，按 from 升序）', () => {
    // no-where 报在 DELETE(0)，missing-table 报在 FROM(7) → 顺序是 [no-where, missing-table]
    expect(rules('DELETE FROM')).toEqual(['no-where', 'missing-table']);
  });
});

// ---------- 6. 关键字拼写 ----------

describe('lintSql · 关键字拼写', () => {
  it('SELCT * FROM t → keyword-typo，提示 SELECT', () => {
    const d = only('SELCT * FROM t');
    expect(d.rule).toBe('keyword-typo');
    expect(d.severity).toBe('warning');
    expect(d.from).toBe(0);
    expect(d.message).toContain('SELECT');
  });

  it('WEHRE a=1 → keyword-typo，提示 WHERE', () => {
    const d = only('WEHRE a=1');
    expect(d.rule).toBe('keyword-typo');
    expect(d.message).toContain('WHERE');
  });

  it('SELECT * FROM t WEHRE a=1（错字在句中）同样报', () => {
    const ds = lintSql('SELECT * FROM t WEHRE a=1');
    expect(ds.map((x) => x.rule)).toEqual(['keyword-typo']);
    expect(ds[0].from).toBe(16);
  });

  it('SELECT * FORM t → keyword-typo（换位也算距离 1）', () => {
    const d = only('SELECT * FORM t');
    expect(d.rule).toBe('keyword-typo');
    expect(d.message).toContain('FROM');
  });

  it('列名 select_time 不误报', () => {
    expect(lintSql('SELECT select_time FROM t')).toEqual([]);
    expect(rules('SELECT * FROM t WHERE select_time > 1')).toEqual([]);
  });

  it('列名 from_addr 不误报', () => {
    expect(lintSql('SELECT from_addr FROM t')).toEqual([]);
    expect(rules('SELECT * FROM t WHERE from_addr = 1')).toEqual([]);
  });

  it('orders（ORDER 的复数派生词）不误报', () => {
    expect(lintSql('SELECT * FROM orders')).toEqual([]);
  });

  it('已知列名 form（FROM 的换位词）不误报', () => {
    expect(lintSql('SELECT form FROM t', { schemaReady: true, tables: ['t'], columns: { t: ['form'] } })).toEqual([]);
  });

  it('短标识符不判拼写（长度 < 4 一律放行）', () => {
    expect(lintSql('SELECT id, sel, whr FROM t')).toEqual([]);
  });

  it('驼峰标识符不误报', () => {
    expect(lintSql('SELECT fromAddr FROM t')).toEqual([]);
  });

  it('引号包裹的标识符不误报', () => {
    expect(lintSql('SELECT `SELCT` FROM t')).toEqual([]);
  });
});

// ---------- 7. UPDATE / DELETE 缺 WHERE ----------

describe('lintSql · UPDATE / DELETE 缺 WHERE', () => {
  it('UPDATE t SET a=1 → no-where（warning）', () => {
    const d = only('UPDATE t SET a=1');
    expect(d.rule).toBe('no-where');
    expect(d.severity).toBe('warning');
    expect(d.from).toBe(0);
  });

  it('UPDATE t SET a=1 WHERE id=1 → 不报', () => {
    expect(lintSql('UPDATE t SET a=1 WHERE id=1')).toEqual([]);
  });

  it('DELETE FROM t → no-where（warning）', () => {
    const d = only('DELETE FROM t');
    expect(d.rule).toBe('no-where');
    expect(d.severity).toBe('warning');
  });

  it('DELETE FROM t WHERE id=1 → 不报', () => {
    expect(lintSql('DELETE FROM t WHERE id=1')).toEqual([]);
  });

  it('子查询里的 WHERE 保护不了外层 DELETE：仍报（只认本层 WHERE）', () => {
    expect(rules('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)')).toEqual([]);
    expect(rules('DELETE FROM t SET a = (SELECT 1 FROM u WHERE x = 1)')).toEqual(['no-where']);
  });

  it('INSERT / SELECT 不报 no-where', () => {
    expect(lintSql('INSERT INTO t (a) VALUES (1)')).toEqual([]);
    expect(lintSql('SELECT * FROM t')).toEqual([]);
  });
});

// ---------- 8. schema 相关规则：开关与命中 ----------

describe('lintSql · unknown-table / unknown-column 的开关', () => {
  it('schemaReady=false 时不报 unknown-table（给了 tables 也不报）', () => {
    expect(lintSql('SELECT * FROM nope', { tables: ['users'], schemaReady: false })).toEqual([]);
  });

  it('完全不给 schemaReady 时也当作未连接，不报', () => {
    expect(lintSql('SELECT * FROM nope', { tables: ['users'] })).toEqual([]);
  });

  it('schemaReady=true 且表不存在 → unknown-table（warning）', () => {
    const sql = 'SELECT * FROM nope WHERE id = 1';
    const d = only(sql, USERS);
    expect(d.rule).toBe('unknown-table');
    expect(d.severity).toBe('warning');
    expect(sql.slice(d.from, d.to)).toBe('nope');
  });

  it('表名大小写不敏感：USERS 能匹配 users', () => {
    expect(lintSql('SELECT * FROM USERS', USERS)).toEqual([]);
  });

  it('反引号包裹的表名去引号后比对', () => {
    expect(lintSql('SELECT * FROM `users`', USERS)).toEqual([]);
    expect(rules('SELECT * FROM `nope`', USERS)).toEqual(['unknown-table']);
  });

  it('带库前缀的表引用取最后一段比对', () => {
    expect(lintSql('SELECT * FROM mydb.users', USERS)).toEqual([]);
  });

  it('系统库前缀不做 unknown-table 判定', () => {
    expect(lintSql('SELECT * FROM information_schema.tables', USERS)).toEqual([]);
  });

  it('别名不参与 unknown-table 判定（FROM users u 里的 u 不报）', () => {
    expect(lintSql('SELECT * FROM users u WHERE u.id = 1', USERS)).toEqual([]);
    expect(lintSql('SELECT * FROM users AS u WHERE u.id = 1', USERS)).toEqual([]);
  });

  it('CTE 名不参与 unknown-table 判定', () => {
    const sql = 'WITH c AS (SELECT id FROM users) SELECT * FROM c';
    expect(lintSql(sql, USERS)).toEqual([]);
  });

  it('逗号连接的多表：后一张表也查', () => {
    expect(rules('SELECT * FROM users, nope', USERS)).toEqual(['unknown-table']);
  });

  it('INSERT INTO / UPDATE 的表也查', () => {
    expect(rules('INSERT INTO nope (a) VALUES (1)', USERS)).toEqual(['unknown-table']);
    expect(rules('UPDATE nope SET a = 1 WHERE id = 1', USERS)).toEqual(['unknown-table']);
  });
});

describe('lintSql · unknown-column', () => {
  it('未知列命中：报在列名上', () => {
    const sql = 'SELECT id, nope FROM users';
    const d = only(sql, USERS);
    expect(d.rule).toBe('unknown-column');
    expect(d.severity).toBe('warning');
    expect(sql.slice(d.from, d.to)).toBe('nope');
  });

  it('已知列放行', () => {
    expect(lintSql('SELECT id, name, email FROM users', USERS)).toEqual([]);
  });

  it('WHERE / ORDER BY / GROUP BY 里的列也查', () => {
    expect(rules('SELECT id FROM users WHERE nope = 1', USERS)).toEqual(['unknown-column']);
    expect(rules('SELECT id FROM users ORDER BY nope', USERS)).toEqual(['unknown-column']);
  });

  it('别名限定的列 u.nope 用别名解析后命中', () => {
    const sql = 'SELECT u.nope FROM users u';
    const d = only(sql, USERS);
    expect(d.rule).toBe('unknown-column');
    expect(sql.slice(d.from, d.to)).toBe('nope');
  });

  it('别名限定的已知列放行', () => {
    expect(lintSql('SELECT u.id, u.name FROM users u WHERE u.email = 1', USERS)).toEqual([]);
  });

  it('AS 别名不算列（SELECT id AS x 的 x 不报）', () => {
    expect(lintSql('SELECT id AS x, name AS y FROM users', USERS)).toEqual([]);
  });

  it('派生表别名不算列', () => {
    expect(lintSql('SELECT x.id FROM (SELECT id FROM users) x', USERS)).toEqual([]);
  });

  it('表本身未知时整条语句不做列判定（宁可漏报）', () => {
    expect(rules('SELECT nope FROM unknown_t', USERS)).toEqual(['unknown-table']);
  });

  it('跨表列不做误判：JOIN 两张已知表时列清单取并集', () => {
    expect(lintSql('SELECT u.id, o.user_id FROM users u JOIN orders o ON u.id = o.user_id', USERS)).toEqual([]);
  });

  it('结果集别名不算列（HAVING n / GROUP BY m 里的别名放行）', () => {
    expect(lintSql('SELECT COUNT(*) AS n FROM users GROUP BY name HAVING n > 1', USERS)).toEqual([]);
    // 隐式别名（函数名后不带 AS 的 m）同样不参与列判定
    expect(lintSql('SELECT UPPER(name) m FROM users GROUP BY m', USERS)).toEqual([]);
    // 别名以外的未知列照报
    expect(rules('SELECT COUNT(*) AS n FROM users GROUP BY nope', USERS)).toEqual(['unknown-column']);
  });

  it('ON DUPLICATE KEY UPDATE 里的 DUPLICATE 不算列', () => {
    expect(lintSql('INSERT INTO users (name) VALUES ("a") ON DUPLICATE KEY UPDATE name = "b"', USERS)).toEqual([]);
  });

  it('INTERVAL / CAST 之类的语法词不算列', () => {
    expect(lintSql('SELECT DATE_ADD(created_at, INTERVAL 1 DAY) FROM users', {
      ...USERS,
      columns: { ...USERS.columns, users: ['id', 'created_at'] },
    })).toEqual([]);
  });
});

// ---------- 9. 排序 / 去重 / 多语句 ----------

describe('lintSql · 排序、去重与多语句下标', () => {
  it('多条诊断按 from 升序返回', () => {
    const ds = lintSql('SELECT (a,,b FROM');
    expect(ds.map((d) => d.rule)).toEqual(['unbalanced-paren', 'empty-list', 'missing-table']);
    const froms = ds.map((d) => d.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
  });

  it('同一段空白上的多条诊断互不重叠', () => {
    const ds = lintSql('SELECT (a,,b FROM');
    for (let i = 1; i < ds.length; i++) expect(ds[i].from).toBeGreaterThanOrEqual(ds[i - 1].to);
  });

  it('重叠时保留更重的一条：未闭合反引号（error）压过 unknown-table（warning）', () => {
    const ds = lintSql('SELECT * FROM `nope', USERS);
    expect(ds.length).toBe(1);
    expect(ds[0].rule).toBe('unclosed-string');
  });

  it('同位置同级别只留一条', () => {
    // ordes 同时命中 unknown-table 与 keyword-typo（同一段字符）
    const ds = lintSql('SELECT * FROM ordes', USERS);
    expect(ds.length).toBe(1);
  });

  it('多语句：第二条语句的诊断下标是全文下标', () => {
    const sql = 'SELECT * FROM;\nUPDATE t SET a=1';
    const ds = lintSql(sql);
    expect(ds.length).toBe(2);
    expect(ds[0].rule).toBe('missing-table');
    expect(ds[0].from).toBe(9);
    const upd = ds[1];
    expect(upd.rule).toBe('no-where');
    // 语句内下标会是 0；全文下标必须落在第二行
    expect(sql.slice(upd.from, upd.to)).toBe('UPDATE');
    expect(upd.from).toBe(15);
  });

  it('多语句：每条语句各报各的', () => {
    const sql = 'SELECT 1;\nDELETE FROM t;\nSELECT 2';
    expect(lintSql(sql).map((d) => d.rule)).toEqual(['no-where']);
  });

  it('多语句 + schema：下标仍然对齐全文', () => {
    const sql = 'SELECT * FROM users;\nSELECT * FROM nope';
    const ds = lintSql(sql, USERS);
    expect(ds.length).toBe(1);
    expect(sql.slice(ds[0].from, ds[0].to)).toBe('nope');
    expect(ds[0].from).toBeGreaterThan(sql.indexOf(';'));
  });
});

// ---------- 10. 幂等与性能 ----------

describe('lintSql · 幂等与性能', () => {
  it('同输入连跑两次结果完全一致（无 schema）', () => {
    const sql = "SELCT a,,b FROM 'x' /* y WHERE z = 1";
    const a = lintSql(sql);
    const b = lintSql(sql);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('同输入连跑两次结果完全一致（带 schema）', () => {
    const sql = 'SELECT u.id, nope FROM users u JOIN nope2 n ON n.id = u.id WHERE nope3 = 1';
    const a = lintSql(sql, USERS);
    const b = lintSql(sql, USERS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('lintSql 不修改入参（无副作用）', () => {
    const sql = 'SELECT * FROM nope';
    lintSql(sql, USERS);
    expect(sql).toBe('SELECT * FROM nope');
  });

  it('5KB SQL 的 lintSql < 20ms', () => {
    const unit =
      "SELECT id, name, email FROM users WHERE status = 'active' AND created_at > '2026-01-01' ORDER BY id DESC LIMIT 100;\n";
    let big = '';
    while (big.length < 5 * 1024) big += unit;
    expect(big.length).toBeGreaterThanOrEqual(5 * 1024);

    // 预热：让 JIT 先跑几遍，测的是稳态而不是首次编译
    for (let i = 0; i < 3; i++) lintSql(big);
    const t0 = performance.now();
    const out = lintSql(big);
    const ms = performance.now() - t0;
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(20);
  });

  it('5KB 带 schema 的 SQL 同样 < 20ms', () => {
    const unit = 'SELECT id, name, email FROM users u WHERE u.id > 1 ORDER BY u.name DESC;\n';
    let big = '';
    while (big.length < 5 * 1024) big += unit;
    for (let i = 0; i < 3; i++) lintSql(big, USERS);
    const t0 = performance.now();
    lintSql(big, USERS);
    expect(performance.now() - t0).toBeLessThan(20);
  });
});
