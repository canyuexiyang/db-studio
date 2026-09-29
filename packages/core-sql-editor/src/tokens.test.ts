import { describe, it, expect } from 'vitest';
import { tokenizeSql, isTrivia, type SqlToken } from './tokens.js';

/** 只看有效 token（跳过空白），断言写起来才不会被空格干扰 */
function sig(sql: string): SqlToken[] {
  return tokenizeSql(sql).filter((t) => t.kind !== 'whitespace');
}
function kinds(sql: string): string[] {
  return sig(sql).map((t) => t.kind);
}
function raws(sql: string): string[] {
  return sig(sql).map((t) => t.raw);
}

describe('tokenizeSql · 无损性', () => {
  it('空输入返回空数组，不抛异常', () => {
    expect(tokenizeSql('')).toEqual([]);
  });

  it('纯空白只出一个 whitespace token 且能还原', () => {
    const t = tokenizeSql('  \t\n ');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('whitespace');
    expect(t.map((x) => x.raw).join('')).toBe('  \t\n ');
  });

  it('综合边界样本：拼接后与原文逐字符相等', () => {
    const samples = [
      "SELECT 'a b' FROM t WHERE x = 1",
      "WHERE note = '-- x' AND s = 'a;b'",
      'SELECT `col with space`, `select` FROM `my table`',
      '-- select * from t\nSELECT 1',
      '# 井号注释 SELECT 1',
      '/* 块注释 select from */ SELECT 1',
      'SELECT 1 /* 未闭合',
      "SELECT '未闭合",
      'SELECT "未闭合双引',
      'SELECT `未闭合反引',
      'SELECT 1--2',
      'SELECT -1, .5, 1e10, 1.5e-3, 0x1F',
      'SELECT a-1, (1)-1, 1-1',
      'SELECT COUNT(*), SUM(x) AS s',
      "INSERT INTO t VALUES ('a', \"b\", `c`)",
      'SELECT ? , :name, @@version',
      "SELECT 'it\\'s' , 'a\\\\b'",
      'SELECT 1;\nSELECT 2;',
    ];
    for (const s of samples) {
      expect(tokenizeSql(s).map((t) => t.raw).join('')).toBe(s);
    }
  });

  it('随机拼接样本（确定性 LCG 200 轮）：拼接后与原文逐字符相等', () => {
    const pieces = [
      'SELECT ', 'FROM t', ' ', '\n', '-- c\n', '# c\n', '/* b */', '/* 多\n行 */',
      "'a b'", "'a;b'", "'-- x'", '"d q"', '`bt id`', '`a``b`', '(', ')', ',', ';',
      '-1', '.5', '1e10', 'a-1', '*', '=', '<>', '<=', '?', '@v', 'ident', 'AND', '`',
    ];
    let seed = 20260929;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round++) {
      let s = '';
      const n = 1 + Math.floor(rnd() * 24);
      for (let k = 0; k < n; k++) s += pieces[Math.floor(rnd() * pieces.length)];
      expect(tokenizeSql(s).map((t) => t.raw).join('')).toBe(s);
    }
  });

  it('from / to 下标可直接切片还原原文', () => {
    const s = "select `a b` from t where s = 'x;y' -- c";
    const toks = tokenizeSql(s);
    for (const t of toks) expect(s.slice(t.from, t.to)).toBe(t.raw);
    // 下标首尾相接、无空洞
    toks.forEach((t, i) => {
      if (i > 0) expect(t.from).toBe(toks[i - 1].to);
    });
  });

  it('未闭合字符串不抛异常，且未闭合段整体是一个 string token', () => {
    const t = tokenizeSql("SELECT 'abc");
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'whitespace', 'string']);
    expect(t[2].raw).toBe("'abc");
    expect(t[2].value).toBe('abc');
  });

  it('未闭合块注释不抛异常，且整段是一个 comment token', () => {
    const t = tokenizeSql('SELECT /* abc');
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'whitespace', 'comment']);
    expect(t[2].raw).toBe('/* abc');
  });

  it('未闭合反引号不抛异常，且不丢字符', () => {
    const s = 'SELECT `abc def';
    const t = tokenizeSql(s);
    expect(t.map((x) => x.raw).join('')).toBe(s);
    expect(t[2].kind).toBe('quoted-ident');
    expect(t[2].value).toBe('abc def');
  });

  it('未闭合双引号不抛异常，且不丢字符', () => {
    const s = 'SELECT "abc def';
    const t = tokenizeSql(s);
    expect(t.map((x) => x.raw).join('')).toBe(s);
    expect(t[2].kind).toBe('string');
  });
});

describe('tokenizeSql · 字符串与注释上下文', () => {
  it("单引号内的关键字与双横线不是关键字/注释", () => {
    const t = sig("SELECT 'select from -- x'");
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'string']);
    expect(t[1].raw).toBe("'select from -- x'");
  });

  it("WHERE s = 'a;b' 里的分号不是 punct", () => {
    const t = sig("WHERE s = 'a;b'");
    expect(t.some((x) => x.kind === 'punct' && x.raw === ';')).toBe(false);
    expect(t.find((x) => x.kind === 'string')?.raw).toBe("'a;b'");
  });

  it("'-- x' 不产生 comment token（MySQL 的 -- 陷阱）", () => {
    const t = sig("WHERE note = '-- x'");
    expect(t.some((x) => x.kind === 'comment')).toBe(false);
  });

  it('注释里的关键字是 comment，不是 keyword', () => {
    const t = tokenizeSql('-- select * from t\nSELECT 1');
    expect(t[0].kind).toBe('comment');
    expect(t[0].raw).toBe('-- select * from t');
    expect(t.filter((x) => x.kind === 'keyword').map((x) => x.raw)).toEqual(['SELECT']);
  });

  it('# 井号注释是 MySQL 方言，同样到行尾', () => {
    const t = tokenizeSql('# select 1\nSELECT 2');
    expect(t[0].kind).toBe('comment');
    expect(t[0].raw).toBe('# select 1');
    expect(t.map((x) => x.raw).join('')).toBe('# select 1\nSELECT 2');
  });

  it('块注释可以跨行，且注释内的引号不开启字符串上下文', () => {
    const s = "/* it's a -- test\nSELECT */ SELECT 1";
    const t = tokenizeSql(s);
    expect(t[0].kind).toBe('comment');
    expect(t[0].raw).toBe("/* it's a -- test\nSELECT */");
    expect(t.at(-1)?.raw).toBe('1');
  });

  it('反引号标识符内含空格与关键字', () => {
    const t = sig('SELECT `select from` FROM `my table`');
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'quoted-ident', 'keyword', 'quoted-ident']);
    expect(t[1].value).toBe('select from');
    expect(t[3].value).toBe('my table');
  });

  it('反引号内不处理反斜杠，只认 `` 加倍', () => {
    const t = sig('SELECT `a\\`b`');
    // 反斜杠不是转义符，所以 `a\` 里的反引号已经闭合了标识符
    expect(t[1].kind).toBe('quoted-ident');
    expect(t[1].raw).toBe('`a\\`');
    const t2 = sig('SELECT `a``b`');
    expect(t2[1].kind).toBe('quoted-ident');
    expect(t2[1].raw).toBe('`a``b`');
    expect(t2[1].value).toBe('a`b');
  });

  it("单引号内反斜杠转义生效：'it\\'s' 是一个完整字符串", () => {
    const t = sig("SELECT 'it\\'s'");
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'string']);
    expect(t[1].raw).toBe("'it\\'s'");
    expect(t[1].value).toBe("it's");
  });

  it('双引号内反斜杠转义生效，且归为 string（MySQL 默认 sql_mode 下双引号是字符串）', () => {
    const t = sig('SELECT "a\\"b"');
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'string']);
    expect(t[1].raw).toBe('"a\\"b"');
    expect(t[1].value).toBe('a"b');
  });

  it('`--` 后面必须跟空白才算注释（MySQL 要求），`1--2` 不是注释', () => {
    const t = sig('SELECT 1--2');
    expect(t.some((x) => x.kind === 'comment')).toBe(false);
    // 前一个 token 是运算符 `-`，所以第二个 `-` 按规则归数字前导符号：1 - (-2)
    expect(raws('SELECT 1--2')).toEqual(['SELECT', '1', '-', '-2']);
    expect(kinds('SELECT 1--2')).toEqual(['keyword', 'number', 'operator', 'number']);
  });

  it('`--` 在行尾（后面没有字符）也算注释', () => {
    const t = sig('SELECT 1 --');
    expect(t.some((x) => x.kind === 'comment')).toBe(true);
  });
});

describe('tokenizeSql · 数字与前导符号', () => {
  it('-1 整体是一个 number', () => {
    expect(raws('SELECT -1')).toEqual(['SELECT', '-1']);
    expect(sig('SELECT -1')[1].kind).toBe('number');
  });

  it('.5 是一个 number', () => {
    expect(raws('SELECT .5')).toEqual(['SELECT', '.5']);
    expect(sig('SELECT .5')[1].kind).toBe('number');
  });

  it('1e10 是一个 number', () => {
    expect(raws('SELECT 1e10')).toEqual(['SELECT', '1e10']);
  });

  it('1.5e-3 与 0x1F 都是一个 number', () => {
    expect(raws('SELECT 1.5e-3, 0x1F')).toEqual(['SELECT', '1.5e-3', ',', '0x1F']);
  });

  it('数字里的 `_` 分隔符不切词（1_000_000 是一个 number，不能被写成 `1 _000_000`）', () => {
    expect(raws('WHERE amount > 1_000_000')).toEqual(['WHERE', 'amount', '>', '1_000_000']);
    expect(sig('WHERE amount > 1_000_000')[3].kind).toBe('number');
  });

  it('a-1 的 `-` 必须是二元运算符（前一个 token 是标识符）', () => {
    const t = sig('SELECT a-1');
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'ident', 'operator', 'number']);
    expect(t[2].raw).toBe('-');
  });

  it('1-1 与 (1)-1 的 `-` 同样是运算符（前一个是数字 / 右括号）', () => {
    expect(kinds('SELECT 1-1')).toEqual(['keyword', 'number', 'operator', 'number']);
    expect(kinds('SELECT (1)-1')).toEqual(['keyword', 'punct', 'number', 'punct', 'operator', 'number']);
  });

  it('运算符 / 关键字 / `(` / `,` 之后的 `-` 归数字前导符号', () => {
    expect(kinds('WHERE x = -1')).toEqual(['keyword', 'ident', 'operator', 'number']);
    expect(raws('WHERE x = -1')).toEqual(['WHERE', 'x', '=', '-1']);
    expect(raws('LIMIT -1')).toEqual(['LIMIT', '-1']);
    expect(raws('SELECT (-1, -2)')).toEqual(['SELECT', '(', '-1', ',', '-2', ')']);
  });

  it('注释对符号判定是透明的（跳过注释看前一个有效 token）', () => {
    // 前一个有效 token 是标识符 a，所以 `-` 是运算符而不是负号
    expect(kinds('SELECT a /* c */ -1')).toEqual(['keyword', 'ident', 'comment', 'operator', 'number']);
    expect(raws('SELECT a /* c */ -1')).toEqual(['SELECT', 'a', '/* c */', '-', '1']);
  });
});

describe('tokenizeSql · 标识符 / 关键字 / 函数', () => {
  it('关键字大小写不敏感归类，并给出规范大写形式', () => {
    const t = sig('select FrOm WhErE');
    expect(t.every((x) => x.kind === 'keyword')).toBe(true);
    expect(t.map((x) => x.upper)).toEqual(['SELECT', 'FROM', 'WHERE']);
  });

  it('标识符大小写原样保留，且 upper 只在 keyword 上出现', () => {
    const t = sig('SELECT MyCol FROM MyTable');
    expect(t[1].kind).toBe('ident');
    expect(t[1].raw).toBe('MyCol');
    expect(t[1].upper).toBeUndefined();
  });

  it('标识符紧跟 `(` 归为 function', () => {
    const t = sig('SELECT COUNT(*), concat_ws(a, b)');
    expect(t.map((x) => x.kind)).toEqual([
      'keyword', 'function', 'punct', 'operator', 'punct', 'punct', 'function', 'punct', 'ident', 'punct', 'ident', 'punct',
    ]);
    expect(t[1].raw).toBe('COUNT');
    expect(t[6].raw).toBe('concat_ws');
  });

  it('标识符与 `(` 之间有空白就不算 function（避免误判）', () => {
    const t = sig('SELECT COUNT (1)');
    expect(t[1].kind).toBe('ident');
    expect(t[1].raw).toBe('COUNT');
  });

  it('中文标识符能吃进去（>127 的字符算标识符字符）', () => {
    const t = sig('SELECT 订单号 FROM 订单表');
    expect(t.map((x) => x.kind)).toEqual(['keyword', 'ident', 'keyword', 'ident']);
    expect(t[1].raw).toBe('订单号');
  });

  it('多字符运算符从长到短匹配', () => {
    expect(raws('SELECT a<=b, c>=d, e<>f, g&&h')).toEqual([
      'SELECT', 'a', '<=', 'b', ',', 'c', '>=', 'd', ',', 'e', '<>', 'f', ',', 'g', '&&', 'h',
    ]);
  });

  it('标点 ()，; . 各自成 token', () => {
    expect(raws('SELECT a.b, f(1);')).toEqual([
      'SELECT', 'a', '.', 'b', ',', 'f', '(', '1', ')', ';',
    ]);
  });

  it('不认识的单字符兜底为 unknown，绝不丢字符', () => {
    const t = sig('SELECT ? , :p');
    expect(t[1].kind).toBe('unknown');
    expect(t[1].raw).toBe('?');
    expect(t[3].kind).toBe('unknown');
    expect(t[3].raw).toBe(':');
  });

  it('DELIMITER 被识别为 keyword（格式化器据此拒绝）', () => {
    const t = sig('DELIMITER $$');
    expect(t[0].kind).toBe('keyword');
    expect(t[0].upper).toBe('DELIMITER');
  });

  it('@ / @@ 开头的会话变量算标识符', () => {
    expect(raws('SET @a = @@version')).toEqual(['SET', '@a', '=', '@@version']);
  });
});

describe('isTrivia', () => {
  it('空白与注释是 trivia，其余不是', () => {
    const kinds = tokenizeSql('  -- c\nSELECT 1').map((t) => isTrivia(t));
    expect(kinds).toEqual([true, true, true, false, true, false]);
  });
});
