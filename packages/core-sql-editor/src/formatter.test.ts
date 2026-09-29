import { describe, it, expect } from 'vitest';
import { formatSql, canFormat } from './formatter.js';
import { tokenizeSql } from './tokens.js';

/** 取出所有字符串字面量与注释的原文，用于「一个字符都不许改」的逐字符比对 */
function literals(sql: string): string[] {
  return tokenizeSql(sql)
    .filter((t) => t.kind === 'string' || t.kind === 'quoted-ident' || t.kind === 'comment')
    .map((t) => t.raw);
}

describe('formatSql · 空输入与不可格式化输入', () => {
  it('空字符串：原样返回且 changed 为 false', () => {
    const r = formatSql('');
    expect(r.text).toBe('');
    expect(r.changed).toBe(false);
    expect(r.unsupported).toBeUndefined();
  });

  it('纯空白：原样返回且 changed 为 false', () => {
    const r = formatSql('   \n\t  ');
    expect(r.text).toBe('   \n\t  ');
    expect(r.changed).toBe(false);
  });

  it('只有行注释：原样返回且 changed 为 false', () => {
    const src = '-- 只有一行注释\n';
    const r = formatSql(src);
    expect(r.text).toBe(src);
    expect(r.changed).toBe(false);
  });

  it('只有块注释：原样返回且 changed 为 false', () => {
    const src = '/* 只有块注释\n第二行 */';
    const r = formatSql(src);
    expect(r.text).toBe(src);
    expect(r.changed).toBe(false);
  });

  it('只有空语句（`;;`）：原样返回且 changed 为 false', () => {
    const r = formatSql('  ;;  ');
    expect(r.text).toBe('  ;;  ');
    expect(r.changed).toBe(false);
  });

  it('DELIMITER：拒绝格式化，text 严格等于原文，并给出中文原因', () => {
    const src = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;';
    const r = formatSql(src);
    expect(r.text).toBe(src);
    expect(r.changed).toBe(false);
    expect(r.unsupported).toBe('不支持 DELIMITER 语句，存储过程/触发器脚本不格式化');
  });

  it('canFormat 对 DELIMITER 返回 false，普通 SQL 返回 true', () => {
    expect(canFormat('DELIMITER $$')).toEqual({ ok: false, reason: '不支持 DELIMITER 语句，存储过程/触发器脚本不格式化' });
    expect(canFormat('SELECT 1')).toEqual({ ok: true });
    expect(canFormat('')).toEqual({ ok: true });
  });

  it("字符串里的 DELIMITER 不算（不能误拒）", () => {
    const r = formatSql("SELECT 'DELIMITER'");
    expect(r.unsupported).toBeUndefined();
    expect(r.text).toBe("SELECT 'DELIMITER';");
  });

  it('注释里的 DELIMITER 不算（不能误拒）', () => {
    const r = formatSql('-- DELIMITER $$\nSELECT 1');
    expect(r.unsupported).toBeUndefined();
    expect(r.text).toBe('-- DELIMITER $$\nSELECT 1;');
  });

  it('恶意 / 畸形输入不崩，且内部异常被兜底成中文原因', () => {
    const hostile = [
      "SELECT '", 'SELECT /*', 'SELECT `', 'SELECT "', '((((((', '))))))',
      'SELECT 1 /* a */ /* b', "SELECT ''''''", 'SELECT \\', '🤯🤯🤯',
    ];
    for (const s of hostile) {
      expect(() => formatSql(s)).not.toThrow();
      const r = formatSql(s);
      expect(typeof r.text).toBe('string');
      // 给了 reason 就必须原样返回（拒绝格式化的契约）
      if (r.unsupported) expect(r.text).toBe(s);
    }
  });
});

describe('formatSql · 子句排版', () => {
  it('简单 SELECT：主子句各占一行，默认补分号', () => {
    expect(formatSql('select id,name from users').text).toBe('SELECT id, name\nFROM users;');
  });

  it('JOIN ... ON：JOIN 换行，ON 再缩进一级', () => {
    expect(formatSql('select u.id, o.total from users u join orders o on o.user_id = u.id').text).toBe(
      ['SELECT u.id, o.total', 'FROM users u', 'JOIN orders o', '  ON o.user_id = u.id;'].join('\n'),
    );
  });

  it('LEFT JOIN / INNER JOIN 同样换行', () => {
    const r = formatSql('select * from a left join b on b.id = a.id inner join c on c.id = a.id');
    expect(r.text).toBe(
      ['SELECT *', 'FROM a', 'LEFT JOIN b', '  ON b.id = a.id', 'INNER JOIN c', '  ON c.id = a.id;'].join('\n'),
    );
  });

  it('子查询：括号内容整体缩进一级', () => {
    expect(formatSql('select * from t where id in (select id from u where x = 1)').text).toBe(
      ['SELECT *', 'FROM t', 'WHERE', '  id IN (', '    SELECT id', '    FROM u', '    WHERE x = 1', '  );'].join('\n'),
    );
  });

  it('派生表 FROM (SELECT ...) x 也缩进一级', () => {
    const r = formatSql('select * from (select a from b) x join c on c.id = x.id');
    expect(r.text).toBe(
      ['SELECT *', 'FROM', '  (', '    SELECT a', '    FROM b', '  ) x', 'JOIN c', '  ON c.id = x.id;'].join('\n'),
    );
  });

  it('INSERT INTO ... VALUES', () => {
    expect(formatSql("insert into t (a,b) values (1,'x')").text).toBe("INSERT INTO t (a, b)\nVALUES (1, 'x');");
  });

  it('多组 VALUES 超宽时每行一组', () => {
    const r = formatSql('insert into t (aaa_1,bbb_2,ccc_3) values (111_1,222_2,333_3),(444_4,555_5,666_6)', {
      maxLineWidth: 40,
    });
    expect(r.text).toBe(
      ['INSERT INTO t (aaa_1, bbb_2, ccc_3)', 'VALUES', '  (111_1, 222_2, 333_3),', '  (444_4, 555_5, 666_6);'].join('\n'),
    );
  });

  it('UPDATE ... SET ... WHERE', () => {
    expect(formatSql("update users set name = 'x' where id = 3").text).toBe(
      ["UPDATE users", "SET name = 'x'", 'WHERE id = 3;'].join('\n'),
    );
  });

  it('DELETE ... WHERE', () => {
    expect(formatSql('delete from users where id < 10').text).toBe('DELETE FROM users\nWHERE id < 10;');
  });

  it('UNION / UNION ALL 各占一行', () => {
    expect(formatSql('select a from t1 union all select b from t2').text).toBe(
      ['SELECT a', 'FROM t1', 'UNION ALL', 'SELECT b', 'FROM t2;'].join('\n'),
    );
    expect(formatSql('select a from t1 union select b from t2').text).toContain('UNION\nSELECT b');
  });

  it('GROUP BY / HAVING / ORDER BY / LIMIT 各占一行', () => {
    const r = formatSql('select a, count(*) c from t where x = 1 group by a having c > 2 order by a desc limit 10');
    expect(r.text).toBe(
      [
        'SELECT a, count(*) c',
        'FROM t',
        'WHERE x = 1',
        'GROUP BY a',
        'HAVING c > 2',
        'ORDER BY a DESC',
        'LIMIT 10;',
      ].join('\n'),
    );
  });

  it('SELECT 列表超宽：每行一项并缩进一级', () => {
    const r = formatSql('select aaaa_1, bbbb_2, cccc_3, dddd_4, eeee_5 from tbl', { maxLineWidth: 30 });
    expect(r.text).toBe(
      ['SELECT', '  aaaa_1,', '  bbbb_2,', '  cccc_3,', '  dddd_4,', '  eeee_5', 'FROM tbl;'].join('\n'),
    );
  });

  it('FROM 列表超宽：每行一项并缩进一级', () => {
    const r = formatSql('select * from table_one, table_two, table_three', { maxLineWidth: 30 });
    expect(r.text).toBe(['SELECT *', 'FROM', '  table_one,', '  table_two,', '  table_three;'].join('\n'));
  });

  it('短列表内联不换行（宽度够就不拆）', () => {
    expect(formatSql('select a, b from t').text).toBe('SELECT a, b\nFROM t;');
  });
});

describe('formatSql · AND / OR 换行', () => {
  it('AND 前换行并缩进一级', () => {
    expect(formatSql("select 1 from t where a = 1 and b = 'x'").text).toBe(
      ['SELECT 1', 'FROM t', 'WHERE', '  a = 1', "  AND b = 'x';"].join('\n'),
    );
  });

  it('OR 前换行并缩进一级', () => {
    expect(formatSql('select 1 from t where a = 1 or b = 2').text).toBe(
      ['SELECT 1', 'FROM t', 'WHERE', '  a = 1', '  OR b = 2;'].join('\n'),
    );
  });

  it('多个 AND / OR 逐个换行', () => {
    const r = formatSql('select 1 from t where a = 1 and b = 2 or c = 3', { maxLineWidth: 200 });
    expect(r.text).toBe(
      ['SELECT 1', 'FROM t', 'WHERE', '  a = 1', '  AND b = 2', '  OR c = 3;'].join('\n'),
    );
  });

  it('BETWEEN ... AND ... 的 AND 不换行（不是布尔连接词）', () => {
    expect(formatSql('select a from t where x between 1 and 5').text).toBe(
      ['SELECT a', 'FROM t', 'WHERE x BETWEEN 1 AND 5;'].join('\n'),
    );
  });
});

describe('formatSql · 语义不变（字符串与注释一个字符都不改）', () => {
  it("'a   b' 的三个空格原样保留", () => {
    const r = formatSql("select 'a   b' ,  2");
    expect(r.text).toBe("SELECT 'a   b', 2;");
    expect(r.text).toContain("'a   b'");
  });

  it('字符串字面量集合逐字符不变（含分号、双横线、关键字）', () => {
    const src = "select 'a   b', 'a;b', '-- x', 'select from' from t where note = 'keep  me'";
    const before = literals(src);
    const after = literals(formatSql(src).text);
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it('注释内容逐字符不变（含多行块注释）', () => {
    const src = 'select /* keep   me */ 1 -- tail   comment\nfrom t';
    const before = literals(src);
    const after = literals(formatSql(src).text);
    expect(after).toEqual(before);
  });

  it('反引号标识符内容不变', () => {
    const src = 'select `col  with  space` from `my  table`';
    const r = formatSql(src);
    expect(literals(r.text)).toEqual(literals(src));
    expect(r.text).toContain('`col  with  space`');
  });

  it('字符串里的分号不会被当成语句分隔符', () => {
    const r = formatSql("select 'a;b' from t; select 2");
    expect(r.text).toBe("SELECT 'a;b'\nFROM t;\nSELECT 2;");
    expect(literals(r.text)).toEqual(["'a;b'"]);
  });
});

describe('formatSql · 选项', () => {
  it('keywordCase 默认 upper', () => {
    expect(formatSql('select 1 from t').text).toBe('SELECT 1\nFROM t;');
  });

  it("keywordCase: 'lower' 全部转小写", () => {
    expect(formatSql('SELECT 1 FROM t WHERE A = 1', { keywordCase: 'lower' }).text).toBe('select 1\nfrom t\nwhere A = 1;');
  });

  it("keywordCase: 'preserve' 保留原文大小写", () => {
    expect(formatSql('select 1 From t where A = 1', { keywordCase: 'preserve' }).text).toBe(
      'select 1\nFrom t\nwhere A = 1;',
    );
  });

  it('indent: 4 时缩进变成 4 空格', () => {
    const r = formatSql('select 1 from t where a = 1 and b = 2', { indent: 4 });
    expect(r.text).toBe(['SELECT 1', 'FROM t', 'WHERE', '    a = 1', '    AND b = 2;'].join('\n'));
  });

  it('semicolon: false 不补分号', () => {
    expect(formatSql('select 1 from t', { semicolon: false }).text).toBe('SELECT 1\nFROM t');
  });

  it('多语句：每条都补分号', () => {
    expect(formatSql('select 1; select 2').text).toBe('SELECT 1;\nSELECT 2;');
  });
});

describe('formatSql · 幂等性', () => {
  const samples: Array<[string, string]> = [
    ['简单查询', "select id,name from users where status = 'active' order by id desc limit 10"],
    ['多表 JOIN', 'select u.id, o.total from users u left join orders o on o.user_id = u.id where o.total > 100'],
    ['子查询', 'select * from t where id in (select id from u where x = 1) and y = 2'],
    ['INSERT VALUES', "insert into t (a,b,c) values (1,'x',3),(4,'y',6)"],
    ['UPDATE', "update users set name = 'x', age = 1 where id = 3 and status = 'a'"],
    ['UNION', 'select a from t1 union all select b from t2 order by a'],
    ['分组聚合', 'select a, count(*) c from t where x = 1 group by a having c > 2 order by a limit 5'],
    ['带注释', "-- 头注释\nselect 1 -- 尾注释\nfrom t where a = 1"],
    ['多语句', "select 'a;b' from t; select 2;"],
    ['超宽列表', 'select aaaa_1, bbbb_2, cccc_3, dddd_4, eeee_5, ffff_6 from some_table where x = 1'],
  ];

  it.each(samples)('%s：format(format(x)) === format(x)', (_name, src) => {
    const once = formatSql(src).text;
    const twice = formatSql(once).text;
    expect(twice).toBe(once);
    // 第三遍再确认一次，排除"两遍刚好循环"的假幂等
    expect(formatSql(twice).text).toBe(once);
  });

  it('幂等性对各类选项同样成立', () => {
    const opts = [
      { keywordCase: 'lower' as const },
      { keywordCase: 'preserve' as const },
      { indent: 4, maxLineWidth: 40 },
      { semicolon: false },
    ];
    for (const o of opts) {
      const once = formatSql('select a, b from t where x = 1 and y = 2', o).text;
      expect(formatSql(once, o).text).toBe(once);
    }
  });
});

describe('formatSql · 性能', () => {
  it('5KB SQL：分词 + 格式化合计 < 50ms', () => {
    let big = '';
    for (let i = 0; i < 40; i++) {
      big += `select id, name, status, created_at from order_table_${i} where status = 'active' and created_at > '2026-01-01' group by id order by created_at desc limit 100;\n`;
    }
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(5000);

    const t0 = performance.now();
    const toks = tokenizeSql(big);
    const r = formatSql(big);
    const t1 = performance.now();

    expect(toks.length).toBeGreaterThan(100);
    expect(r.changed).toBe(true);
    expect(t1 - t0).toBeLessThan(50);
  });

  it('5KB SQL 的格式化结果依然是幂等的', () => {
    let big = '';
    for (let i = 0; i < 40; i++) {
      big += `select id, name from t_${i} where a = 1 and b = 2 union all select c, d from u_${i};\n`;
    }
    const once = formatSql(big).text;
    expect(formatSql(once).text).toBe(once);
  });
});
