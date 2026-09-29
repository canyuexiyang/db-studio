/**
 * SQL 分词器 —— 格式化 / 语法高亮 / 错误诊断共用的底层
 *
 * 为什么单独一个文件，而且**不 import ./index.js**：
 *  - index.ts 里已经有一套状态机（splitStatements），但 index.ts 还扛着补全
 *    与 EXPLAIN，后续要 re-export 本文件；让 tokens.ts 反向依赖它会形成循环
 *    依赖，所以这里自带一份最小关键字表。
 *  - 两份关键字表**刻意各自独立**：index.ts 那份服务于补全（要全、要带空格的
 *    复合词如 'GROUP BY'、'IS NOT NULL'），这份服务于格式化与高亮（只要能认出
 *    子句起始词 + 少数几个常量词）。两者不必一致，也不必同步。
 *
 * 状态机沿用 index.ts:44 splitStatements 的边界处理：四种字符串上下文
 * （单引号 / 双引号内反斜杠转义生效；反引号内**不**处理反斜杠，只能靠 `` 加倍）
 * + 两种注释上下文（`-- ` 后必须跟空白，MySQL 方言；`#`；`/* * /`）。
 * 这是最容易造成**数据语义损坏**的地方：`SELECT 'a b'` 的空格绝不能当分词点，
 * `WHERE note = '-- x'` 里的 `--` 不是注释，`WHERE s = 'a;b'` 的分号不切语句。
 *
 * 两条硬保证（都有单测守着）：
 *  1. **无损**：tokens.map(t => t.raw).join('') === sql，对任意输入成立，
 *     包括未闭合字符串与未闭合块注释 —— 所以宁可吐一个极窄的 'unknown'
 *     兜底 token，也绝不丢字符。
 *  2. **不抛异常**：任何输入（含 null / undefined / 畸形串）都稳定返回数组。
 *
 * 零依赖：不 import 任何 npm 包，纯字符串逻辑。
 */

export type SqlTokenKind =
  | 'whitespace'
  | 'comment'
  | 'string'
  | 'quoted-ident'
  | 'number'
  | 'ident'
  | 'keyword'
  | 'function'
  | 'operator'
  | 'punct'
  | 'unknown';

export interface SqlToken {
  kind: SqlTokenKind;
  /** 原文片段（无损拼接的基本单位） */
  raw: string;
  /** 起始下标（含） */
  from: number;
  /** 结束下标（不含） */
  to: number;
  /** 去引号后的值：只对 string / quoted-ident 有意义，其余等于 raw */
  value?: string;
  /** kind === 'keyword' 时的规范大写形式（如 select → SELECT） */
  upper?: string;
}

/**
 * 最小关键字表（服务于格式化 / 高亮，不是补全候选表）。
 *
 * 刻意不含 COUNT/SUM/AVG 这类聚合名：它们后面几乎总是紧跟 `(`，本文件会把
 * 「标识符 + 紧邻左括号」归为 'function'，放进关键字表反而会挡住这条规则。
 */
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'AS', 'DISTINCT', 'ALL',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'UNION',
  'INTERSECT', 'EXCEPT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'STRAIGHT_JOIN',
  'ON', 'USING', 'WITH', 'ASC', 'DESC', 'PARTITION',
  'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'PRIMARY', 'KEY', 'DEFAULT',
  'DELIMITER', 'TRUE', 'FALSE',
]);

/** 多字符运算符：必须从长到短匹配，否则 `<=` 会被切成 `<` + `=` */
const MULTI_OPS = ['<=>', '<>', '!=', '<=', '>=', '||', '&&', '<<', '>>', '->>', '->'];
const SINGLE_OPS = '+-*/%=<>&|^~!';
const PUNCT = '(),;.';

/** MySQL 的空白集合（`--` 后面必须跟这些之一才算注释） */
function isWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}
function isHex(c: string | undefined): boolean {
  return isDigit(c) || (c !== undefined && ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')));
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c === '@' || c.charCodeAt(0) > 127;
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/** MySQL 字符串转义表；未列出的转义按 MySQL 语义「丢掉反斜杠、留下字符」 */
const ESCAPES: Record<string, string> = {
  '0': '\0',
  "'": "'",
  '"': '"',
  '\\': '\\',
  'b': '\b',
  'n': '\n',
  'r': '\r',
  't': '\t',
  'Z': '\u001a',
  '%': '%',
  '_': '_',
};

/** 反斜杠转义还原（单引号 / 双引号串） */
function unescapeBackslash(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) {
      out += c; // 结尾裸反斜杠：原样留下，别丢字符
      continue;
    }
    out += ESCAPES[n] ?? n;
    i++;
  }
  return out;
}

/** 反引号串：`` 表示一个字面反引号，反斜杠不是转义符 */
function unescapeBacktick(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '`' && body[i + 1] === '`') {
      out += '`';
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * `-` / `+` 能不能当数字的前导符号。
 *
 * 判定规则（写死在这里，单测逐条验证）：看**前一个有效 token**（跳过空白与
 * 注释，注释是透明的）：
 *  - 没有前一个（语句/括号开头）→ 是符号
 *  - 前一个属于 operator / keyword / `(` / `,` → 是符号（`x = -1`、`LIMIT -1`）
 *  - 前一个属于 number / string / quoted-ident / ident / function / `)` → 是
 *    二元运算符（`a-1`、`1-1`、`(1)-1`）
 *  `-` 后面必须紧跟数字或 `.数字`，否则一律是运算符。
 */
function signAllowed(prev: SqlToken | null): boolean {
  if (prev === null) return true;
  if (prev.kind === 'operator' || prev.kind === 'keyword') return true;
  if (prev.kind === 'punct' && (prev.raw === '(' || prev.raw === ',')) return true;
  // 上面已排除 `)`；其余 punct 不引入负号
  return false;
}

export function tokenizeSql(sql: string): SqlToken[] {
  const s = typeof sql === 'string' ? sql : '';
  const out: SqlToken[] = [];
  const len = s.length;

  const push = (kind: SqlTokenKind, from: number, to: number, extra?: { value?: string; upper?: string }): void => {
    if (to <= from) return; // 空 token 会破坏「无损拼接」的可逆性假设
    const t: SqlToken = { kind, raw: s.slice(from, to), from, to };
    if (extra?.value !== undefined) t.value = extra.value;
    if (extra?.upper !== undefined) t.upper = extra.upper;
    out.push(t);
  };
  /** 最后一个「有效」token：空白与注释都算透明，不参与符号判定 */
  const lastSignificant = (): SqlToken | null => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k];
      if (t.kind !== 'whitespace' && t.kind !== 'comment') return t;
    }
    return null;
  };

  let i = 0;
  while (i < len) {
    const c = s[i];
    const next = s[i + 1];

    // ---- 1. 空白 ----
    if (isWs(c)) {
      let j = i;
      while (j < len && isWs(s[j])) j++;
      push('whitespace', i, j);
      i = j;
      continue;
    }

    // ---- 2. 注释（两种上下文）----
    // MySQL 要求 `--` 后跟空白才算注释；index.ts:80 只认空格，这里放宽到任意
    // 空白（含行尾），更符合 MySQL 实际行为，且是 index.ts 规则的超集。
    if (c === '-' && next === '-' && (s[i + 2] === undefined || isWs(s[i + 2]))) {
      let j = i + 2;
      while (j < len && s[j] !== '\n') j++;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < len && s[j] !== '\n') j++;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < len && !(s[j] === '*' && s[j + 1] === '/')) j++;
      // 未闭合：吃到 EOF，保证无损且不抛异常
      const end = s[j] === '*' && s[j + 1] === '/' ? j + 2 : len;
      push('comment', i, end);
      i = end;
      continue;
    }

    // ---- 3. 字符串（四种上下文中的三种起始符）----
    if (c === "'" || c === '"' || c === '`') {
      const backtick = c === '`';
      let j = i + 1;
      let closed = false;
      while (j < len) {
        const ch = s[j];
        if (!backtick && ch === '\\' && j + 1 < len) {
          j += 2; // 反斜杠转义：吃掉被转义的字符
          continue;
        }
        if (ch === c) {
          if (backtick && s[j + 1] === '`') {
            j += 2; // 反引号内只能靠 `` 加倍
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      const end = closed ? j : len; // 未闭合 → 到 EOF
      const body = s.slice(i + 1, closed ? end - 1 : end);
      push(backtick ? 'quoted-ident' : 'string', i, end, {
        value: backtick ? unescapeBacktick(body) : unescapeBackslash(body),
      });
      i = end;
      continue;
    }

    // ---- 4. 数字（含前导符号判定，见 signAllowed 注释）----
    const signed = (c === '-' || c === '+') && (isDigit(next) || (next === '.' && isDigit(s[i + 2])));
    if (isDigit(c) || (c === '.' && isDigit(next)) || (signed && signAllowed(lastSignificant()))) {
      let j = i;
      if (signed) j++;
      // 十六进制字面量 0x1F
      if (s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X') && isHex(s[j + 2])) {
        j += 2;
        while (j < len && (isHex(s[j]) || (s[j] === '_' && isHex(s[j + 1])))) j++;
      } else {
        // MySQL 允许数字里的 `_` 分隔符（1_000_000）。不认它的话 1_000 会被切成
        // `1` + 标识符 `_000`，格式化后变成 `1 _000` —— 数字字面量被改写了，
        // 属于 formatter 最不能犯的错。
        while (j < len && (isDigit(s[j]) || (s[j] === '_' && isDigit(s[j + 1])))) j++;
        if (s[j] === '.' && isDigit(s[j + 1])) {
          j++;
          while (j < len && isDigit(s[j])) j++;
        }
        const e = s[j];
        if (e === 'e' || e === 'E') {
          let k = j + 1;
          if (s[k] === '-' || s[k] === '+') k++;
          if (isDigit(s[k])) {
            k++;
            while (k < len && isDigit(s[k])) k++;
            j = k;
          }
        }
      }
      push('number', i, j);
      i = j;
      continue;
    }

    // ---- 5. 标识符 / 关键字 / 函数 ----
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdentPart(s[j])) j++;
      const raw = s.slice(i, j);
      const upper = raw.toUpperCase();
      // 紧跟 `(`（中间不许有空白，否则 `COUNT (` 只是普通标识符）→ 函数调用
      if (s[j] === '(') {
        push('function', i, j);
        i = j;
        continue;
      }
      if (KEYWORDS.has(upper)) {
        push('keyword', i, j, { upper });
      } else {
        push('ident', i, j);
      }
      i = j;
      continue;
    }

    // ---- 6. 运算符 ----
    let op: string | null = null;
    for (const m of MULTI_OPS) {
      if (s.startsWith(m, i)) {
        op = m;
        break;
      }
    }
    if (op === null && SINGLE_OPS.includes(c)) op = c;
    if (op !== null) {
      push('operator', i, i + op.length);
      i += op.length;
      continue;
    }

    // ---- 7. 标点 ----
    if (PUNCT.includes(c)) {
      push('punct', i, i + 1);
      i++;
      continue;
    }

    // ---- 8. 兜底：不认识的单字符（如 `?` `:` `@` 之外的占位符）----
    // 故意只吃一个字符：宁可多吐几个 unknown，也不能破坏无损拼接。
    push('unknown', i, i + 1);
    i++;
  }

  return out;
}

/** 空白与注释：格式化时要跳过、但绝不能改写的两类 token */
export function isTrivia(t: SqlToken): boolean {
  return t.kind === 'whitespace' || t.kind === 'comment';
}
