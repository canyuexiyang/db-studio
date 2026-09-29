/**
 * 轻量 SQL 格式化器（S0 决策门的自研方案 B 产物）
 *
 * 定位：**只做「排版」，不做「解析」**。不建 AST、不做方言判定、不校验语义，
 * 纯粹在 tokens.ts 的线性 token 流上按子句起始词切段再重排缩进与换行。
 * 这样能保证两件事，也是本文件唯一在乎的两件事：
 *
 *  【语义不变】字符串字面量与注释**一个字符都不改**（原样吐 raw）。
 *    任何"顺手 trim 一下注释内部空格"的聪明做法在这里都是 bug。
 *  【幂等】formatSql(formatSql(x).text).text === formatSql(x).text。
 *    做法：所有换行/内联决策都只依赖 token 序列本身（宽度用 token 渲染后的
 *    文本长度现算），**绝不参考原文当前长什么样**，所以第二遍必然同解。
 *
 * 排版规则（自定，UI 侧会照此展示）：
 *  1. 主子句（SELECT / FROM / WHERE / GROUP BY / ORDER BY / HAVING / LIMIT /
 *     OFFSET / UNION / INSERT INTO / VALUES / UPDATE / SET / DELETE / JOIN 家族）
 *     各占一行，缩进 0 级；`ON` / `USING` 再缩进一级。
 *  2. 子句体：先按顶层逗号切成列表项，再按顶层 AND / OR 切成子项。
 *     - 整条能塞进 maxLineWidth → 内联成一行（`SELECT a, b`）
 *     - 否则 → 关键字一行，列表项每行一项、缩进一级（`  a,`）
 *     - 含顶层 AND / OR 的子句**强制展开**（规格要求 AND/OR 前换行），
 *       `BETWEEN a AND b` 的 AND 例外，不算拆分点。
 *  3. `(` 分两类：`函数名紧邻(` 是调用括号，永远内联；其余是结构括号，
 *     括号体内含主子句词（子查询）→ 展开并整体缩进一级，否则内联。
 *  4. 行注释（`-- ` / `#`）与多行块注释独立成行，内容原样；单行块注释内联。
 *  5. 关键字大小写按 keywordCase；标识符、字符串、函数名一律保留原样
 *     （MySQL 里函数名大小写不敏感但用户可能刻意写小写，不动最安全）。
 *
 * 已知不做（诚实清单见 docs/engineering/S0-格式化体积实测-2026-09-29.md）：
 * CASE WHEN 缩进、DDL 列定义对齐、窗口函数、CTE 缩进美化、方言差异。
 *
 * 兜底：任何内部异常都不冒泡，转成中文 unsupported 并原样返回原文。
 */

import { tokenizeSql, type SqlToken } from './tokens.js';

export interface FormatOptions {
  /** 缩进宽度，默认 2 空格 */
  indent?: number;
  /** 关键字大小写：默认 'upper' */
  keywordCase?: 'upper' | 'lower' | 'preserve';
  /** 单语句最大字符宽度，超过则把顶层列表项换行（尽力而为，不必严格） */
  maxLineWidth?: number;
  /** 在语句末尾补分号，默认 true（多语句时每条都补） */
  semicolon?: boolean;
}

export interface FormatResult {
  text: string;
  /** 与原文是否不同 */
  changed: boolean;
  /** 不支持时的原因（如遇到 DELIMITER）；给了理由就代表【拒绝格式化】，此时 text 必须 === 原文 */
  unsupported?: string;
}

/** 与 index.ts:15 的既有决策保持一致：DELIMITER 不在本包职责内 */
export const DELIMITER_REASON = '不支持 DELIMITER 语句，存储过程/触发器脚本不格式化';

const DEFAULT_INDENT = 2;
const DEFAULT_MAX_WIDTH = 80;

/** 子句起始词（多字词取首词即可，用于"这是子查询吗"的判定） */
const MAJOR_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'UNION', 'INTERSECT',
  'EXCEPT', 'JOIN', 'ON', 'USING', 'WITH', 'PARTITION', 'LEFT', 'RIGHT',
  'INNER', 'OUTER', 'CROSS', 'FULL', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
]);

/** 单字子句词（matchClause 先试多字，再落到单字） */
const MAJOR_SINGLE = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
  'EXCEPT', 'INSERT', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN', 'ON',
  'USING', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'CREATE', 'ALTER',
  'DROP', 'TRUNCATE', 'STRAIGHT_JOIN',
]);

/** 多字子句：长词必须排在短词前面，否则 LEFT OUTER JOIN 会被认成 LEFT JOIN */
const MULTIWORD: string[][] = [
  ['LEFT', 'OUTER', 'JOIN'],
  ['RIGHT', 'OUTER', 'JOIN'],
  ['GROUP', 'BY'],
  ['ORDER', 'BY'],
  ['PARTITION', 'BY'],
  ['INSERT', 'INTO'],
  ['DELETE', 'FROM'],
  ['UNION', 'ALL'],
  ['LEFT', 'JOIN'],
  ['RIGHT', 'JOIN'],
  ['INNER', 'JOIN'],
  ['OUTER', 'JOIN'],
  ['CROSS', 'JOIN'],
  ['FULL', 'JOIN'],
];

/** ON / USING 再缩进一级（规格：JOIN ... ON 换行且 ON 再缩进一级） */
const EXTRA_INDENT = new Set(['ON', 'USING']);

/** SELECT 的修饰符跟在 SELECT 同一行，不单独占一行 */
const SELECT_MODIFIERS = new Set([
  'DISTINCT', 'DISTINCTROW', 'ALL', 'HIGH_PRIORITY', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS',
]);

function isLineComment(raw: string): boolean {
  return raw.startsWith('--') || raw.startsWith('#');
}
/** 行注释、以及含换行的块注释都必须独占若干行（内联会把后面的代码吞进注释里） */
function isStandaloneComment(t: SqlToken): boolean {
  return t.kind === 'comment' && (isLineComment(t.raw) || t.raw.includes('\n'));
}

export function canFormat(sql: string): { ok: true } | { ok: false; reason: string } {
  const toks = tokenizeSql(typeof sql === 'string' ? sql : '');
  for (const t of toks) {
    // 字符串/注释里的 DELIMITER 是 kind 'string' / 'comment'，不会命中
    if (t.kind === 'keyword' && t.upper === 'DELIMITER') return { ok: false, reason: DELIMITER_REASON };
  }
  return { ok: true };
}

export function formatSql(sql: string, opts?: FormatOptions): FormatResult {
  const src = typeof sql === 'string' ? sql : '';
  try {
    const toks = tokenizeSql(src);
    const hasCode = toks.some((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
    // 空输入 / 纯空白 / 只有注释：原样返回（顺带保证 changed === false）
    if (!hasCode) return { text: src, changed: false };

    const gate = canFormat(src);
    if (!gate.ok) return { text: src, changed: false, unsupported: gate.reason };

    const indent = clamp(opts?.indent ?? DEFAULT_INDENT, 0, 8);
    const maxWidth = clamp(opts?.maxLineWidth ?? DEFAULT_MAX_WIDTH, 20, 400);
    const kwCase = opts?.keywordCase ?? 'upper';
    const semicolon = opts?.semicolon !== false;

    // 自己切语句：只在括号深度 0 处的 `;` punct 切（不 import index.ts 的 splitStatements）
    const sigAll = toks.filter((t) => t.kind !== 'whitespace');
    const chunks: string[] = [];
    for (const [lo, hi] of splitBySemicolon(sigAll)) {
      const sig = sigAll.slice(lo, hi);
      if (sig.length === 0) continue;
      if (sig.every((t) => t.kind === 'comment')) {
        chunks.push(sig.map((t) => t.raw).join('').replace(/\s+$/, ''));
        continue;
      }
      const p = new Printer(sig, indent, maxWidth, kwCase);
      p.renderRange(0, sig.length, 0);
      const lines = p.result();
      if (semicolon && lines.length > 0) {
        const last = lines[lines.length - 1];
        // 末行是行注释时不能把 `;` 追加到注释后面（会变成注释的一部分）
        if (isLineComment(last.trimStart())) lines.push(';');
        else lines[lines.length - 1] = last + ';';
      }
      chunks.push(lines.join('\n'));
    }

    // 全是空语句（`;` / `;;`）：原样返回，不当成"改过了"
    if (chunks.length === 0) return { text: src, changed: false };

    const text = chunks.join('\n').trim();
    return { text, changed: text !== src };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: src, changed: false, unsupported: `格式化内部错误，已原样返回：${msg}` };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** 按顶层 `;` 切语句（括号里的分号不算，字符串/注释里的分号在 tokens 层已被吃掉） */
function splitBySemicolon(sig: SqlToken[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.kind === 'punct' && t.raw === '(') depth++;
    else if (t.kind === 'punct' && t.raw === ')') depth = depth > 0 ? depth - 1 : 0;
    else if (t.kind === 'punct' && t.raw === ';' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, sig.length]);
  return out;
}

type Block =
  | { k: 'comment'; token: SqlToken }
  | { k: 'clause'; kw: string; lo: number; hi: number }
  | { k: 'raw'; lo: number; hi: number };

/** 单条语句的打印器：状态集中在实例上，递归进子查询时共用同一个 lines 缓冲 */
class Printer {
  private readonly match: number[];
  private readonly depthOf: number[];
  private lines: string[] = [];
  private cur = '';
  private curDepth = 0;
  private lastTok: SqlToken | null = null;

  constructor(
    private readonly sig: SqlToken[],
    private readonly indent: number,
    private readonly maxWidth: number,
    private readonly kwCase: 'upper' | 'lower' | 'preserve',
  ) {
    const n = sig.length;
    this.match = new Array(n).fill(-1);
    this.depthOf = new Array(n).fill(0);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = sig[i];
      if (t.kind === 'punct' && t.raw === '(') {
        this.depthOf[i] = stack.length;
        stack.push(i);
      } else if (t.kind === 'punct' && t.raw === ')') {
        const open = stack.pop();
        if (open !== undefined) {
          this.match[open] = i;
          this.match[i] = open;
        }
        this.depthOf[i] = stack.length;
      } else {
        this.depthOf[i] = stack.length;
      }
    }
  }

  result(): string[] {
    this.flush();
    return this.lines;
  }

  // ---------- 基础输出 ----------

  private text(t: SqlToken): string {
    if (t.kind === 'keyword') {
      if (this.kwCase === 'upper') return t.upper ?? t.raw.toUpperCase();
      if (this.kwCase === 'lower') return t.raw.toLowerCase();
    }
    return t.raw;
  }

  private needSpace(prev: SqlToken | null, next: SqlToken): boolean {
    const n = this.text(next)[0];
    if (n === ')' || n === ',' || n === ';') return false;
    if (prev === null) return false;
    const p = this.text(prev).slice(-1);
    if (p === '' || p === '(' || p === '.') return false;
    if (n === '.') return false;
    // 函数调用 `COUNT(` 不留空格，其余括号（IN (、FROM (）留一个
    if (n === '(') return prev.kind !== 'function';
    return true;
  }

  private emit(t: SqlToken): void {
    const txt = this.text(t);
    if (this.cur === '') this.cur = txt;
    else this.cur += (this.needSpace(this.lastTok, t) ? ' ' : '') + txt;
    this.lastTok = t;
  }

  private emitRaw(s: string): void {
    if (this.cur === '') this.cur = s;
    else this.cur += ' ' + s;
    this.lastTok = null;
  }

  private flush(): void {
    if (this.cur === '') return;
    this.lines.push(' '.repeat(this.curDepth * this.indent) + this.cur);
    this.cur = '';
    this.lastTok = null;
  }

  private breakLine(depth: number): void {
    this.flush();
    this.curDepth = depth;
  }

  // ---------- 结构 ----------

  renderRange(lo: number, hi: number, depth: number): void {
    for (const b of this.collect(lo, hi)) {
      if (b.k === 'comment') {
        this.breakLine(depth);
        // 只去掉行尾空白；注释内容一个字符都不动（幂等 + 语义不变）
        this.cur = b.token.raw.replace(/\s+$/, '');
        this.flush();
        continue;
      }
      if (b.k === 'clause') {
        const extra = EXTRA_INDENT.has(b.kw.trim().toUpperCase()) ? 1 : 0;
        this.breakLine(depth + extra);
        this.emitRaw(b.kw);
        this.renderBody(b.lo, b.hi, depth + extra, true);
        continue;
      }
      this.breakLine(depth);
      this.renderBody(b.lo, b.hi, depth, false);
    }
  }

  /** 把一段 token 切成「注释块 / 子句块 / 无关键字片段」 */
  private collect(lo: number, hi: number): Block[] {
    const blocks: Block[] = [];
    let i = lo;
    while (i < hi) {
      const t = this.sig[i];
      if (isStandaloneComment(t)) {
        blocks.push({ k: 'comment', token: t });
        i++;
        continue;
      }
      const m = t.kind === 'keyword' ? this.matchClause(i) : null;
      if (m !== null) {
        const j = this.scanBody(i + m.used, hi);
        blocks.push({ k: 'clause', kw: m.text, lo: i + m.used, hi: j });
        i = j;
        continue;
      }
      const j = this.scanBody(i, hi);
      blocks.push({ k: 'raw', lo: i, hi: j });
      i = j;
    }
    return blocks;
  }

  /**
   * 扫出子句体的结束位置。
   *
   * 括号必须整体跳过：否则 `WHERE id IN (SELECT ...)` 里的 SELECT 会被当成
   * 子句边界，把 `id IN (` 和 `SELECT ... )` 拆成两块，子查询被渲染两遍。
   */
  private scanBody(from: number, hi: number): number {
    let j = from;
    while (j < hi) {
      const t = this.sig[j];
      if (isStandaloneComment(t)) return j;
      if (t.kind === 'punct' && t.raw === '(') {
        const close = this.match[j];
        if (close > j && close < hi) {
          j = close + 1;
          continue;
        }
      }
      if (t.kind === 'keyword' && this.matchClause(j) !== null) return j;
      j++;
    }
    return hi;
  }

  private matchClause(i: number): { text: string; used: number } | null {
    const t = this.sig[i];
    if (t.kind !== 'keyword' || !t.upper) return null;
    for (const words of MULTIWORD) {
      if (words[0] !== t.upper) continue;
      let ok = true;
      for (let k = 1; k < words.length; k++) {
        const u = this.sig[i + k];
        if (!u || u.kind !== 'keyword' || u.upper !== words[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return { text: words.map((w) => this.applyCase(w)).join(' '), used: words.length };
    }
    if (MAJOR_SINGLE.has(t.upper)) return { text: this.applyCase(t.raw), used: 1 };
    return null;
  }

  private applyCase(word: string): string {
    if (this.kwCase === 'upper') return word.toUpperCase();
    if (this.kwCase === 'lower') return word.toLowerCase();
    return word;
  }

  private renderBody(lo: number, hi: number, depth: number, isClause: boolean): void {
    let start = lo;
    // SELECT DISTINCT / INSERT ... 的修饰符跟着关键字，不单独起行
    if (isClause) {
      while (start < hi && this.sig[start].kind === 'keyword' && SELECT_MODIFIERS.has(this.sig[start].upper ?? '')) {
        this.emitRaw(this.text(this.sig[start]));
        start++;
      }
    }
    if (start >= hi) return;

    const inline = this.inlineText(start, hi);
    const force = this.hasTopLevelAndOr(start, hi) || this.hasSubqueryParen(start, hi) || this.hasLineComment(start, hi);
    const width = depth * this.indent + this.cur.length + 1 + inline.length;
    if (!force && width <= this.maxWidth) {
      this.emitRaw(inline);
      return;
    }
    for (const seg of this.splitItems(start, hi)) {
      this.breakLine(depth + 1);
      if (seg.lead !== null) this.emit(this.sig[seg.lead]);
      this.renderPiece(seg.lo, seg.hi, depth + 1);
      if (seg.trail !== null) this.emit(this.sig[seg.trail]);
    }
  }

  /** 顶层逗号 / 顶层 AND|OR 切段；逗号归上一段结尾，AND|OR 归下一段开头 */
  private splitItems(lo: number, hi: number): Array<{ lo: number; hi: number; lead: number | null; trail: number | null }> {
    const segs: Array<{ lo: number; hi: number; lead: number | null; trail: number | null }> = [];
    let start = lo;
    let lead: number | null = null;
    for (const cut of this.cuts(lo, hi)) {
      if (cut.type === 'comma') {
        segs.push({ lo: start, hi: cut.idx, lead, trail: cut.idx });
        start = cut.idx + 1;
        lead = null;
        continue;
      }
      // AND / OR 归下一段开头，所以下一段从它**后面**开始，避免渲染成 `AND AND x`
      segs.push({ lo: start, hi: cut.idx, lead, trail: null });
      start = cut.idx + 1;
      lead = cut.idx;
    }
    segs.push({ lo: start, hi, lead, trail: null });
    return segs;
  }

  /**
   * 顶层切分点：逗号，以及 AND / OR。
   *
   * `BETWEEN a AND b` 的 AND 不算切分点 —— 用「最近一个未消费的 BETWEEN」
   * 状态位判定，而不是只看前一个 token（`BETWEEN 1 + 2 AND 3` 前一个是数字）。
   */
  private cuts(lo: number, hi: number): Array<{ idx: number; type: 'comma' | 'andor' }> {
    const base = this.depthOf[lo];
    const out: Array<{ idx: number; type: 'comma' | 'andor' }> = [];
    let pendingBetween = false;
    for (let i = lo; i < hi; i++) {
      if (this.depthOf[i] !== base) continue; // 括号里的逗号/AND 不参与
      const t = this.sig[i];
      if (t.kind === 'keyword' && t.upper === 'BETWEEN') {
        pendingBetween = true;
        continue;
      }
      if (t.kind === 'punct' && t.raw === ',') {
        out.push({ idx: i, type: 'comma' });
        continue;
      }
      if (t.kind === 'keyword' && (t.upper === 'AND' || t.upper === 'OR')) {
        if (pendingBetween) {
          pendingBetween = false;
          continue;
        }
        out.push({ idx: i, type: 'andor' });
      }
    }
    return out;
  }

  private renderPiece(lo: number, hi: number, depth: number): void {
    let i = lo;
    while (i < hi) {
      const t = this.sig[i];
      const close = t.kind === 'punct' && t.raw === '(' ? this.match[i] : -1;
      if (close > i && this.isStructural(i) && this.groupHasMajor(i, close)) {
        this.emit(t); // '('
        this.breakLine(depth + 1);
        this.renderRange(i + 1, close, depth + 1);
        this.breakLine(depth);
        this.emit(this.sig[close]); // ')'
        i = close + 1;
        continue;
      }
      this.emit(t);
      i++;
    }
  }

  /** 结构括号 = 前一个 token 不是标识符/函数名（即不是调用括号） */
  private isStructural(i: number): boolean {
    const p = i > 0 ? this.sig[i - 1] : null;
    return !(p && (p.kind === 'ident' || p.kind === 'function'));
  }

  private groupHasMajor(open: number, close: number): boolean {
    for (let j = open + 1; j < close; j++) {
      const t = this.sig[j];
      if (t.kind === 'keyword' && t.upper && MAJOR_WORDS.has(t.upper)) return true;
    }
    return false;
  }

  private inlineText(lo: number, hi: number): string {
    let s = '';
    for (let i = lo; i < hi; i++) {
      const txt = this.text(this.sig[i]);
      if (s === '') s = txt;
      else s += (this.needSpace(this.sig[i - 1], this.sig[i]) ? ' ' : '') + txt;
    }
    return s;
  }

  /** 含顶层 AND / OR 的子句强制展开（规格：AND / OR 前换行） */
  private hasTopLevelAndOr(lo: number, hi: number): boolean {
    return this.cuts(lo, hi).some((c) => c.type === 'andor');
  }

  private hasSubqueryParen(lo: number, hi: number): boolean {
    const base = this.depthOf[lo];
    for (let i = lo; i < hi; i++) {
      if (this.depthOf[i] !== base) continue;
      const t = this.sig[i];
      if (t.kind !== 'punct' || t.raw !== '(') continue;
      const close = this.match[i];
      if (close > i && this.isStructural(i) && this.groupHasMajor(i, close)) return true;
    }
    return false;
  }

  private hasLineComment(lo: number, hi: number): boolean {
    for (let i = lo; i < hi; i++) {
      if (isStandaloneComment(this.sig[i])) return true;
    }
    return false;
  }
}
