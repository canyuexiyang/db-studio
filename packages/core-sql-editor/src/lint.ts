/**
 * SQL 编辑器「实时错误检测」的纯逻辑层（V16）—— 零依赖、零 IPC、**不打库**。
 *
 * 三条决定所有取舍的前提（后面每条规则的实现都受它们约束）：
 *
 *  1. **完全建立在 tokens.ts 之上，不重复造扫描器**。字符串 / 注释 / 反引号
 *     在 tokenizer 里已经是**不透明 token**（一个 token 一段），所以
 *     「字符串里的括号」「注释里的 SELECT」「反引号里的关键字」根本走不到
 *     诊断逻辑里 —— 这是「不误报」最大的一块保障，不需要再写一遍状态机。
 *  2. **宁可漏报，不可误报**（任务书红线）。用户被划红线会不敢写代码，代价
 *     远高于少提示一条。凡是拿不准的规则一律放行，并在注释里写清「为什么
 *     放行」。schema 相关规则**必须** ctx.schemaReady === true 才启用。
 *  3. **幂等、无副作用、线性时间**。只读 token 流 + 纯函数：同输入永远同输出，
 *     没有 Date.now()、没有随机、不改入参。渲染层每次击键都会调用（外面有
 *     防抖），所以主流程只有两趟线性扫描，唯一的多余开销是拼写检查的一个
 *     O(len) 编辑距离判定（不是 DP 全表）。
 *
 * 刻意不 import ./index.js：index.ts 后续要 re-export 本文件，反向 import 会
 * 形成循环依赖。语句拆分因此在 token 流上自己做一份 —— 只在括号深度 0 处的
 * `;` 切分，天然不会切到 `(SELECT 1; ...)` 或字符串里的分号。
 *
 * 诊断下标一律是**全文下标**（不是语句内下标）：多语句时第 N 条语句的报错也
 * 能被渲染层直接定位到原文。
 */

import { tokenizeSql, type SqlToken } from './tokens.js';

export type DiagnosticSeverity = 'error' | 'warning';

export interface SqlDiagnostic {
  /** 起始下标（含） */
  from: number;
  /** 结束下标（不含） */
  to: number;
  severity: DiagnosticSeverity;
  /** 中文说明（直接展示给用户） */
  message: string;
  /** 规则代号，便于渲染层做「忽略此规则」与单测断言 */
  rule: SqlLintRule;
}

export type SqlLintRule =
  | 'unclosed-string' | 'unclosed-comment' | 'unbalanced-paren'
  | 'empty-statement' | 'missing-table' | 'empty-list'
  | 'unknown-table' | 'unknown-column'
  | 'keyword-typo' | 'no-where';

export interface LintContext {
  /** 可选：已知表名（当前库）。给了才启用 unknown-table / unknown-column */
  tables?: readonly string[];
  /** 可选：表名 → 列名。给了才启用 unknown-column */
  columns?: Readonly<Record<string, readonly string[]>>;
  /** 是否已连接（未连接时 schema 相关规则一律不报，避免"没数据就满屏红线"） */
  schemaReady?: boolean;
}

/** 去重权重：同一位置 error 压过 warning */
const SEVERITY_WEIGHT: Record<DiagnosticSeverity, number> = { error: 2, warning: 1 };

/**
 * 拼写检查的目标关键字表（**只放 DML 子句词**，且长度都 ≥ 4）。
 *
 * 为什么刻意不放全：关键字拼写误报的代价极高（用户好好的列名被划红线）。
 * 下面这些词的单数/复数/派生形是极常见的表名列名，一旦放进目标表就会变成
 * 常驻误报，所以**宁可漏报**：
 *  - TABLE / VIEW / INDEX / DATABASE / SCHEMA / COLUMN → `tables` `views` `schemas`
 *  - LEFT / RIGHT / INNER / OUTER / CROSS → `rights` `index`
 *  - CREATE / ALTER / DROP / SHOW / TRUNCATE / PRIMARY / DEFAULT → `drops` `defaults`
 *  - VALUES → `value`（极常见列名，且是 VALUES 的前缀，前缀规则本就会放行）
 */
const TYPO_TARGETS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'UPDATE', 'DELETE', 'DISTINCT', 'BETWEEN', 'EXISTS',
  'UNION', 'JOIN', 'USING', 'WHEN', 'THEN', 'ELSE', 'CASE', 'DESC',
];

/**
 * 逗号「左侧缺内容」的合法前驱黑名单：这些关键字后面**不可能**合法地紧跟逗号。
 *
 * 用黑名单（而不是「任何关键字」）是因为有反例：`ORDER BY a ASC, b` 的逗号
 * 前驱就是关键字 ASC，判成 empty-list 就是误报。
 */
const LEFT_EMPTY_PREV = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'SET', 'VALUES', 'BY', 'IN', 'ON', 'USING',
  'WHERE', 'HAVING', 'AND', 'OR', 'NOT', 'THEN', 'ELSE', 'WHEN', 'CASE',
  'FROM', 'JOIN', 'UNION', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'EXISTS', 'WITH',
  'INTO', 'LIMIT', 'OFFSET', 'GROUP', 'ORDER',
]);

/** 逗号「右侧缺内容」的后继：这些关键字出现在逗号后，说明逗号后面这一项是空的 */
const RIGHT_EMPTY_NEXT = new Set([
  'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'INTO',
  'VALUES', 'SET', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
  'CROSS', 'UNION', 'WITH', 'SELECT', 'AS', 'BY', 'AND', 'OR', 'END', 'WHEN',
  'THEN', 'ELSE', 'ASC', 'DESC',
]);

/** 这些关键字后面跟的是表名 / 别名，不是列名 */
const NOT_COL_PREV = new Set([
  'AS', 'FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'PARTITION', 'DATABASE',
  'SCHEMA', 'INDEX', 'VIEW', 'KEY',
]);

/** 这些关键字后面跟的标识符**可以**是列名（列引用位置） */
const COL_PREV_KEYWORDS = new Set([
  'SELECT', 'WHERE', 'HAVING', 'BY', 'ON', 'SET', 'AND', 'OR', 'NOT',
  'THEN', 'ELSE', 'WHEN', 'USING', 'BETWEEN', 'DISTINCT', 'IN', 'LIKE',
  'VALUES', 'EXISTS',
]);

/**
 * 不是本项目关键字表里的字、但常出现在表达式 / 子句里的「MySQL 语法词」。
 * 它们在 token 流里是普通 ident，若不放行会被 unknown-column 误报
 * （`INTERVAL 1 DAY`、`CAST(a AS CHAR)`、`ON DUPLICATE KEY UPDATE`）。
 * 这份表只会**放行**，不会产生新诊断，所以宁可多写几个。
 */
const SYNTAX_WORDS = new Set([
  'INTERVAL', 'DAY', 'MONTH', 'YEAR', 'HOUR', 'MINUTE', 'SECOND', 'QUARTER',
  'WEEK', 'DATE', 'DATETIME', 'TIME', 'TIMESTAMP', 'ROLLUP', 'CHAR', 'VARCHAR',
  'BINARY', 'SIGNED', 'UNSIGNED', 'DECIMAL', 'JSON', 'TEXT', 'INT', 'INTEGER',
  'BOOLEAN', 'BLOB', 'NUMERIC', 'REAL', 'FLOAT', 'DOUBLE',
  'DUPLICATE', 'RECURSIVE', 'CUBE', 'GROUPS', 'ONLY', 'DISTINCTROW', 'FIRST',
  'AFTER', 'STORED', 'VIRTUAL', 'AUTO_INCREMENT', 'COMMENT', 'ENGINE',
  'CHARSET', 'COLLATE', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'FOREIGN',
  'REFERENCES', 'CONSTRAINT', 'CHECK', 'FORCE', 'IGNORE', 'SHARE', 'MODE',
  'LOCK', 'STATUS', 'VARIABLES', 'PROCESSLIST', 'WARNINGS', 'ERRORS', 'RANGE',
  'LIST', 'COLUMNS', 'PARTITIONS', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT',
  'GRANTS', 'PRIVILEGES',
]);

/** 系统库：写了库前缀的表引用不做 unknown-table 判定（`information_schema.tables`） */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// ---------- 小工具 ----------

function isSignificant(t: SqlToken): boolean {
  return t.kind !== 'whitespace' && t.kind !== 'comment';
}

function isPunct(t: SqlToken | undefined, ch: string): boolean {
  return t !== undefined && t.kind === 'punct' && t.raw === ch;
}

function isKw(t: SqlToken | undefined, word: string): boolean {
  return t !== undefined && t.kind === 'keyword' && t.upper === word;
}

/** 类型守卫：顺手把 undefined 排掉，省掉下游一堆 `!` */
function isName(t: SqlToken | undefined): t is SqlToken {
  return t !== undefined && (t.kind === 'ident' || t.kind === 'quoted-ident');
}

/** `=` 在 tokenizer 里归 operator 而不是 punct */
function isEq(t: SqlToken | undefined): boolean {
  return t !== undefined && t.kind === 'operator' && t.raw === '=';
}

/** 去引号后的标识符名：反引号用 value，其余用 raw */
function nameOf(t: SqlToken): string {
  return t.value ?? t.raw;
}

function diag(t: SqlToken, severity: DiagnosticSeverity, rule: SqlLintRule, message: string): SqlDiagnostic {
  return { from: t.from, to: Math.max(t.to, t.from + 1), severity, message, rule };
}

// ---------- 编辑距离 ----------

/**
 * Damerau 口径的「编辑距离 ≤ 1」（插入 / 删除 / 替换 / **相邻字符换位**）。
 *
 * 为什么必须含换位：`FORM`→`FROM`、`WEHRE`→`WHERE` 在纯 Levenshtein 下距离是
 * **2**（两次替换），只认替换/插入/删除会漏掉最常见的手误类型。
 *
 * 为什么不用 DP 全表：这是每次击键都可能跑的东西。这里按长度分情况 O(n) 判定，
 * 且只在 |len 差| ≤ 1 时才比，比通用 DP 快一个量级。
 */
function editDistanceAtMostOne(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    const mism: number[] = [];
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        mism.push(i);
        if (mism.length > 2) return false; // 早退：已经不可能 ≤ 1
      }
    }
    if (mism.length <= 1) return true; // 0 = 相同，1 = 一次替换
    // 2 处不同且相邻互换 → 一次换位
    const [i, j] = mism;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }

  // 长度差 1：长串删掉恰好一个字符后等于短串
  const long = la > lb ? a : b;
  const short = la > lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i++;
  }
  return true;
}

/** 字面量是否闭合（只看单个 token 的原文，代价 O(token) 且与 tokenizer 同口径） */
function isClosedLiteral(raw: string, quote: string): boolean {
  const backtick = quote === '`';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (!backtick && c === '\\') {
      i++; // 单/双引号内反斜杠转义生效
      continue;
    }
    if (c === quote) {
      if (backtick && raw[i + 1] === quote) {
        i++; // 反引号只能靠 `` 加倍
        continue;
      }
      return i === raw.length - 1;
    }
  }
  return false;
}

// ---------- 语句切分 ----------

interface StmtRange {
  /** token 下标区间 [start, end) */
  start: number;
  end: number;
}

/**
 * 在 token 流上按 `;` 切语句：只有**括号深度 0** 处的分号才算分隔，
 * 所以 `(SELECT 1; SELECT 2)`、字符串/注释里的分号都不会被误切。
 */
function splitStatements(tokens: SqlToken[]): StmtRange[] {
  const out: StmtRange[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'punct') continue;
    if (t.raw === '(') depth++;
    else if (t.raw === ')') {
      if (depth > 0) depth--;
    } else if (t.raw === ';' && depth === 0) {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < tokens.length) out.push({ start, end: tokens.length });
  return out;
}

// ---------- 主入口 ----------

/**
 * 对整段 SQL 做静态诊断（不打库、不 IPC）。
 *
 * @returns 按 from 升序、**互不重叠**的诊断数组；同一位置只留更重的那条。
 */
export function lintSql(sql: string, ctx: LintContext = {}): SqlDiagnostic[] {
  const src = typeof sql === 'string' ? sql : '';
  if (!src) return [];
  // 运行时兜底（JS 调用方可能传 null）：tokenizeSql 自己也会兜，但这里先省一次扫描
  const tokens = tokenizeSql(src);
  const out: SqlDiagnostic[] = [];

  // A. 词法级：与语句结构无关，全文扫一遍
  collectLexicalIssues(tokens, out);

  // B. 语句级。未连接时 schema 一律置空 → unknown-* 规则自动停摆，
  //    避免「还没连上就满屏红线」。
  const schemaReady = ctx.schemaReady === true;
  const schema: Schema = {
    tables: schemaReady && ctx.tables && ctx.tables.length > 0 ? ctx.tables : null,
    columns: schemaReady && ctx.columns ? ctx.columns : null,
  };
  for (const range of splitStatements(tokens)) {
    lintStatement(tokens, range, schema, out);
  }

  return finalize(out);
}

// ---------- A. 词法级规则 ----------

function collectLexicalIssues(tokens: SqlToken[], out: SqlDiagnostic[]): void {
  for (const t of tokens) {
    if (t.kind === 'string' || t.kind === 'quoted-ident') {
      const quote = t.raw[0];
      if (!isClosedLiteral(t.raw, quote)) {
        // 只标起始引号那一个字符：未闭合的 token 会一直吃到 EOF，
        // 整段划红会让编辑器后半屏全红，反而看不清问题在哪。
        out.push({
          from: t.from,
          to: t.from + 1,
          severity: 'error',
          rule: 'unclosed-string',
          message: quote === '`'
            ? '标识符引用未闭合：缺少结束的反引号 `'
            : `字符串未闭合：缺少结束的 ${quote}`,
        });
      }
    } else if (t.kind === 'comment' && t.raw.startsWith('/*')) {
      // `/*/` 长度为 3，endsWith('*/') 为真但其实没闭合，所以要卡长度 ≥ 4
      if (!(t.raw.length >= 4 && t.raw.endsWith('*/'))) {
        out.push({
          from: t.from,
          to: t.from + 2,
          severity: 'error',
          rule: 'unclosed-comment',
          message: '块注释未闭合：缺少结束的 */',
        });
      }
    }
  }
}

// ---------- B. 语句级规则 ----------

interface Schema {
  tables: readonly string[] | null;
  columns: Readonly<Record<string, readonly string[]>> | null;
}

interface TableRef {
  /** 去引号后的表名（`db.tbl` 取最后一段） */
  name: string;
  /** 全文下标，覆盖整个限定名 */
  from: number;
  to: number;
  /** 库前缀（`db.tbl` 的 db，无前缀时为空串） */
  qualifier: string;
  /** 别名（去引号后），没有则为空串 */
  alias: string;
}

function lintStatement(tokens: SqlToken[], range: StmtRange, schema: Schema, out: SqlDiagnostic[]): void {
  /** 本语句内「有效 token」的全局下标（跳过空白与注释） */
  const sig: number[] = [];
  /** 与 sig 平行：该 token 所在的括号深度（`(` 自身的深度是外层深度） */
  const depth: number[] = [];
  const parenStack: number[] = [];

  for (let i = range.start; i < range.end; i++) {
    const t = tokens[i];
    if (!isSignificant(t)) continue;
    if (isPunct(t, '(')) {
      depth.push(parenStack.length);
      parenStack.push(i);
      sig.push(i);
      continue;
    }
    if (isPunct(t, ')')) {
      if (parenStack.length > 0) parenStack.pop();
      else out.push(diag(t, 'error', 'unbalanced-paren', '多余的右括号：没有与之匹配的 ('));
      depth.push(parenStack.length);
      sig.push(i);
      continue;
    }
    depth.push(parenStack.length);
    sig.push(i);
  }
  // 收尾：留在栈里的都是没闭合的 `(` —— 报在它自己身上
  for (const idx of parenStack) {
    out.push(diag(tokens[idx], 'error', 'unbalanced-paren', '未闭合的左括号：缺少 )'));
  }
  if (sig.length === 0) return; // 空语句 / 纯注释段：不产生任何诊断

  const at = (k: number): SqlToken | undefined => (k >= 0 && k < sig.length ? tokens[sig[k]] : undefined);
  const upperOf = (t: SqlToken): string => (t.kind === 'keyword' ? t.upper ?? t.raw.toUpperCase() : t.raw.toUpperCase());

  // ---- B1. 列表项为空（连续逗号 / 缺一侧内容）----
  for (let k = 0; k < sig.length; k++) {
    const comma = at(k);
    if (comma === undefined || !isPunct(comma, ',')) continue;
    const prev = at(k - 1);
    const next = at(k + 1);
    const leftEmpty =
      prev === undefined ||
      isPunct(prev, '(') ||
      isPunct(prev, ',') ||
      (prev.kind === 'keyword' && LEFT_EMPTY_PREV.has(upperOf(prev))) ||
      // `SELECT *, b` 是合法的，所以 `*` 不算「左侧缺内容」
      (prev.kind === 'operator' && prev.raw !== '*');
    const rightEmpty =
      next === undefined ||
      isPunct(next, ')') ||
      (next.kind === 'keyword' && RIGHT_EMPTY_NEXT.has(upperOf(next)));
    if (leftEmpty) {
      out.push(diag(comma, 'error', 'empty-list', '列表项为空：逗号前面缺少内容'));
    } else if (rightEmpty) {
      out.push(diag(comma, 'error', 'empty-list', '列表项为空：逗号后面缺少内容'));
    }
  }

  // ---- B2. FROM / JOIN 后面明显缺表名 ----
  for (let k = 0; k < sig.length; k++) {
    const t = at(k);
    if (t === undefined) continue;
    const isFrom = isKw(t, 'FROM');
    const isJoin = isKw(t, 'JOIN');
    if (!isFrom && !isJoin) continue;
    const next = at(k + 1);
    // 只认「紧跟语句结束 / 右括号」这两种确定无疑的情况；
    // `FROM (subquery)`、`FROM t`、`FROM @v` 一律放行（宁可漏报）。
    if (next === undefined || isPunct(next, ')')) {
      out.push(diag(t, 'error', 'missing-table', isFrom ? 'FROM 后面缺少表名' : 'JOIN 后面缺少表名'));
    }
  }

  // ---- B3. UPDATE / DELETE 缺 WHERE ----
  const head = at(0);
  if (head !== undefined && (isKw(head, 'UPDATE') || isKw(head, 'DELETE'))) {
    let hasWhere = false;
    for (let k = 1; k < sig.length; k++) {
      // 只要本层的 WHERE：子查询里的 WHERE 保护不了外层 UPDATE/DELETE
      if (depth[k] === 0 && isKw(at(k), 'WHERE')) {
        hasWhere = true;
        break;
      }
    }
    if (!hasWhere) {
      out.push(diag(
        head,
        'warning',
        'no-where',
        isKw(head, 'UPDATE') ? 'UPDATE 没有 WHERE：会更新整张表的所有行' : 'DELETE 没有 WHERE：会删除整张表的所有行',
      ));
    }
  }

  // ---- B4. 收集表引用（unknown-table 与 unknown-column 共用）----
  const refs: TableRef[] = [];
  /** 已被当成「表名 / 别名 / 限定名列」消费掉的 sig 位置，列判定要跳过 */
  const consumed = new Set<number>();
  /** CTE / 派生表之类的本地名（大小写不敏感），不参与 unknown-table */
  const localNames = new Set<string>();

  // CTE 名：认 `xxx AS (` 这个形状（WITH cte AS (...) / CREATE VIEW v AS (...)）。
  // 尽力而为：认不出来时不猜，只是少收集一个名字。
  for (let k = 0; k + 2 < sig.length; k++) {
    const t = at(k);
    if (isName(t) && isKw(at(k + 1), 'AS') && isPunct(at(k + 2), '(')) {
      localNames.add(nameOf(t).toLowerCase());
    }
  }

  /**
   * 查询结果的别名（大小写不敏感）：`AS x` 的显式别名，以及 `) x` 这种
   * 跟在右括号后的隐式别名（`MAX(a) m`、`FROM (SELECT 1) x`）。
   *
   * 为什么必须收集：`SELECT COUNT(*) AS n ... HAVING n > 1`、`GROUP BY m`
   * 里的 n / m 是**结果集别名**而不是表里的列，不收集就会把完全正确的
   * 语句划成 unknown-column。隐式别名只认 `) 标识符` 这一种（另一种
   * `SELECT id uid` 的 uid 本来就不落在列位置上，不会被查）。
   */
  const aliasNames = new Set<string>();
  for (let k = 0; k + 1 < sig.length; k++) {
    const cur = at(k);
    const nxt = at(k + 1);
    if (!isName(nxt)) continue;
    if (isKw(cur, 'AS') || isPunct(cur, ')')) aliasNames.add(nameOf(nxt).toLowerCase());
  }

  const collectRefs = (k: number): void => {
    let p = k + 1;
    for (;;) {
      const first = at(p);
      if (!isName(first)) return; // `(` 开头是子查询 / 派生表，放行
      // 解析限定名：`db`.`tbl` 这类，取最后一段当表名
      const parts: number[] = [p];
      for (;;) {
        const dot = at(parts[parts.length - 1] + 1);
        const after = at(parts[parts.length - 1] + 2);
        if (isPunct(dot, '.') && isName(after)) parts.push(parts[parts.length - 1] + 2);
        else break;
      }
      const lastPos = parts[parts.length - 1];
      const lastTok = at(lastPos);
      if (lastTok === undefined) return;
      const firstTok = at(parts[0]);
      if (firstTok === undefined) return;
      for (const q of parts) consumed.add(q);

      const ref: TableRef = {
        name: nameOf(lastTok),
        from: firstTok.from,
        to: lastTok.to,
        qualifier: parts.length > 1 ? nameOf(firstTok) : '',
        alias: '',
      };
      refs.push(ref);

      p = lastPos + 1;
      // 别名：AS x 或隐式 x（关键字不是标识符，所以 `FROM t WHERE` 不会误吃）
      if (isKw(at(p), 'AS')) {
        consumed.add(p);
        if (isName(at(p + 1))) {
          ref.alias = nameOf(at(p + 1)!);
          consumed.add(p + 1);
          p += 2;
        } else {
          p += 1;
        }
      } else if (isName(at(p))) {
        ref.alias = nameOf(at(p)!);
        consumed.add(p);
        p += 1;
      }
      // 逗号续表：`FROM a, b`
      if (isPunct(at(p), ',') && isName(at(p + 1))) p += 1;
      else return;
    }
  };

  for (let k = 0; k < sig.length; k++) {
    const t = at(k);
    if (t === undefined) continue;
    if (isKw(t, 'FROM') || isKw(t, 'JOIN') || isKw(t, 'INTO')) collectRefs(k);
  }
  if (isKw(at(0), 'UPDATE')) collectRefs(0);

  // ---- B5. unknown-table ----
  let tableSet: Set<string> | null = null;
  if (schema.tables !== null) {
    tableSet = new Set(schema.tables.map((t) => t.toLowerCase()));
    for (const ref of refs) {
      if (!ref.name) continue;
      const lower = ref.name.toLowerCase();
      if (localNames.has(lower)) continue; // CTE 名：放行
      // 写了系统库前缀的引用不做判定（手上没有系统库的表清单，判了必误报）
      if (ref.qualifier && SYSTEM_SCHEMAS.has(ref.qualifier.toLowerCase())) continue;
      if (tableSet.has(lower)) continue;
      out.push({
        from: ref.from,
        to: ref.to,
        severity: 'warning',
        rule: 'unknown-table',
        message: `未知表 ${ref.name}：当前库里没有这张表`,
      });
    }
  }

  // ---- B6. unknown-column ----
  if (schema.columns !== null && refs.length > 0) {
    // 保守开关：本语句解析出的表**全部**都能查到列清单才启用。
    // 只要有一张表查不到列（子查询没解析到、CTE、临时表…），整条语句的列
    // 判定就停摆 —— 宁可漏报，不能拿半份列清单去划红线。
    const colsByTable = new Map<string, readonly string[]>();
    let complete = true;
    for (const ref of refs) {
      const cols = lookupColumns(schema.columns, ref.name);
      if (cols === null) {
        complete = false;
        break;
      }
      colsByTable.set(ref.name.toLowerCase(), cols);
    }
    if (complete) {
      const known = new Set<string>();
      for (const cols of colsByTable.values()) {
        for (const c of cols) known.add(c.toLowerCase());
      }
      // 别名 → 表名，用于解析 `u.id` 这种限定列
      const aliasToTable = new Map<string, string>();
      for (const ref of refs) {
        if (ref.alias) aliasToTable.set(ref.alias.toLowerCase(), ref.name);
      }
      for (let k = 0; k < sig.length; k++) {
        if (consumed.has(k)) continue;
        const t = at(k);
        if (!isName(t)) continue;
        const name = nameOf(t);
        const lower = name.toLowerCase();
        if (SYNTAX_WORDS.has(upperOf(t))) continue;
        if (aliasNames.has(lower)) continue; // 结果集别名不是表里的列
        if (localNames.has(lower)) continue;
        if (tableSet !== null && tableSet.has(lower)) continue;
        const prev = at(k - 1);
        const next = at(k + 1);

        // 限定列 `u.id` / `t`.`id`：先解析限定符，解析不出来就放行
        if (isPunct(next, '.') && isName(at(k + 2))) {
          const member = nameOf(at(k + 2)!);
          const target = aliasToTable.get(lower) ?? (colsByTable.has(lower) ? lower : null);
          const cols = target === null ? null : (colsByTable.get(target.toLowerCase()) ?? null);
          if (cols !== null && !hasColumn(cols, member)) {
            const memberTok = at(k + 2)!;
            out.push({
              from: memberTok.from,
              to: memberTok.to,
              severity: 'warning',
              rule: 'unknown-column',
              message: `未知列 ${member}：表 ${target} 里没有这一列`,
            });
          }
          consumed.add(k);
          consumed.add(k + 1);
          consumed.add(k + 2);
          continue;
        }

        // 裸列：必须处在「列引用位置」，且不是别名 / 表名 / 函数调用
        if (prev === undefined) continue;
        if (isPunct(prev, '.') || isPunct(next, '(')) continue;
        const inColPosition =
          (prev.kind === 'keyword' && COL_PREV_KEYWORDS.has(upperOf(prev)) && !NOT_COL_PREV.has(upperOf(prev))) ||
          isPunct(prev, ',') ||
          isPunct(prev, '(') ||
          prev.kind === 'operator';
        if (!inColPosition) continue;
        if (!known.has(lower)) {
          out.push(diag(t, 'warning', 'unknown-column', `未知列 ${name}：这条语句的表里没有这一列`));
        }
      }
    }
  }

  // ---- B7. 关键字拼写 ----
  // 已知表名 / 列名永远不划红线：用户自己的标识符优先于「像拼错的关键字」
  const knownNames = new Set<string>();
  if (schema.tables !== null) for (const t of schema.tables) knownNames.add(t.toLowerCase());
  if (schema.columns !== null) {
    for (const cols of Object.values(schema.columns)) for (const c of cols) knownNames.add(c.toLowerCase());
  }
  for (let k = 0; k < sig.length; k++) {
    const t = at(k);
    if (t === undefined || t.kind !== 'ident') continue; // 只认裸标识符：关键字 / 函数 / 引号标识符都不是拼写错误
    const raw = t.raw;
    if (raw.length < 4) continue; // 短词（a / id / key）不判，误报率太高
    // 含下划线或驼峰 → 用户自有命名（select_time / fromAddr），放行
    if (raw.includes('_') || /[a-z][A-Z]/.test(raw)) continue;
    const prev = at(k - 1);
    const next = at(k + 1);
    // `t.xxx` 的成员、以及 `xxx.yyy` 的限定符都在标识符位置，放行
    if (isPunct(prev, '.') || isPunct(next, '.')) continue;
    // `WHERE form = 1` 里的 form 更可能是列名，放行（注意 `=` 是 operator 不是 punct）
    if (isEq(prev) || isEq(next)) continue;
    if (knownNames.has(raw.toLowerCase())) continue;
    const target = findTypoTarget(raw);
    if (target === null) continue;
    out.push(diag(t, 'warning', 'keyword-typo', `疑似关键字拼写错误：${raw}，是否想输入 ${target}？`));
  }
}

function hasColumn(cols: readonly string[], name: string): boolean {
  const lower = name.toLowerCase();
  for (const c of cols) if (c.toLowerCase() === lower) return true;
  return false;
}

/** 表名 → 列清单（表名大小写不敏感；查不到返回 null） */
function lookupColumns(
  columns: Readonly<Record<string, readonly string[]>>,
  table: string,
): readonly string[] | null {
  const direct = columns[table];
  if (direct !== undefined) return direct;
  const lower = table.toLowerCase();
  // Object.keys 顺序即插入顺序，稳定 → 结果幂等
  for (const key of Object.keys(columns)) {
    if (key.toLowerCase() === lower) return columns[key];
  }
  return null;
}

/**
 * 命中「距离 ≤ 1」的关键字。
 *
 * 额外的一条放行规则：**两者互为前缀时一律放行**。因为
 * `orders` / `forms` / `updated` / `limits` / `value`(VALUES) 这类「关键字 ± 后缀」
 * 是极常见的表名列名，而真正的手误（SELCT / WEHRE / FORM）都不是前缀关系。
 * 这条规则让我们少报一点，但几乎消灭了「列名被当错别字」这一类误报。
 */
function findTypoTarget(word: string): string | null {
  const upper = word.toUpperCase();
  for (const kw of TYPO_TARGETS) {
    if (Math.abs(kw.length - upper.length) > 1) continue;
    if (upper.startsWith(kw) || kw.startsWith(upper)) continue;
    if (editDistanceAtMostOne(upper, kw)) return kw;
  }
  return null;
}

// ---------- 收尾：排序 + 去重 ----------

/**
 * 按 from 升序排序，并消除重叠（重叠时保留更重的一条；同级保留靠前那条）。
 * 返回的顺序也就是渲染层画下划线的顺序。
 */
function finalize(list: SqlDiagnostic[]): SqlDiagnostic[] {
  const sorted = [...list].sort(
    (a, b) =>
      a.from - b.from ||
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      a.to - b.to,
  );
  const kept: SqlDiagnostic[] = [];
  for (const d of sorted) {
    const last = kept[kept.length - 1];
    if (last === undefined || d.from >= last.to) {
      kept.push(d);
      continue;
    }
    // 重叠：更重的替换掉先到的那条（error 压 warning）
    if (SEVERITY_WEIGHT[d.severity] > SEVERITY_WEIGHT[last.severity]) kept[kept.length - 1] = d;
  }
  return kept;
}
