/**
 * 表名 / 库名提示增强（S3）+ 字段属性提示（S4）。
 *
 * 三条前提，决定了本文件所有取舍：
 *
 *  1. **🔴 不打库、不 IPC**。所有信息只来自调用方传进来的内存 schema
 *     （TableMeta / ColumnMeta / DatabaseMeta）。hover 与补全一样是每次击键都
 *     可能触发的东西，一旦它去查库，用户敲一个字就会发一条 SQL —— 这是任务书
 *     红线。所以这里没有任何 async、没有任何回调、没有任何外部 IO。
 *  2. **只产纯数据，不产样式**。返回值里没有颜色、没有 HTML、没有 className。
 *     高亮交给渲染层用 `matches` 下标自己做（本文件连"紫色"这种词都不该出现）。
 *  3. **稳定 & 不抛异常**。排序必须稳定（同分按原顺序），数值格式化必须确定
 *     （不用 toLocaleString，理由见 groupThousands），任何 null / 脏数据输入
 *     都返回空结果而不是抛异常 —— 渲染层拿到的可能是旧快照或半截 JSON。
 *
 * 为什么 `import type` 而不是 `import`：
 *  @dbstudio/core-schema-cache 的入口带**实现**（node:fs 读写快照、SchemaCache
 *  类），value import 会把它整包拖进依赖图 —— 渲染层只是想拿几个类型，不该为
 *  此付一份 fs 实现。用 `import type` 编译后被完全擦除，零运行时耦合；同时本
 *  文件也就天然不可能"顺手"去 new 一个 SchemaCache 打库。类型以外的东西一律
 *  不引。
 *
 * 零新增依赖：只 import 同包的 tokens.ts（分词是既有能力，不重复造扫描器）。
 */

import { tokenizeSql, type SqlToken } from './tokens.js';
import type { ColumnMeta, TableMeta, DatabaseMeta } from '@dbstudio/core-schema-cache';

// ===========================================================================
// 共用小工具
// ===========================================================================

/** 提示列表默认截断长度。大库上万张表不截断会卡住输入（与 E4 的 MAX_COMPLETION_ITEMS 同理） */
export const DEFAULT_HINT_LIMIT = 50;

/**
 * 收藏加权幅度。
 *
 * 关键约束：它必须**小于**相邻规则档位的间距（档位间距 ≥ 130，见下面 SCORE_*），
 * 这样收藏只能在"同一档位内部"把表往前挪，**永远翻不过**「前缀 > 子串 >
 * 首字母 > 子序列」这条主序 —— 否则用户敲 `ord`，收藏里一个八竿子打不着的
 * 表会盖住 orders，提示就废了。
 */
const FAVORITE_BONUS = 40;

/**
 * 四档匹配基础分（外加 exact）。
 *
 * 档位间距刻意留到 ≥ 130：档内还会叠加「命中靠前 / 名字短 / 覆盖多」三项细节分
 * （合计上限 20 + 30 + 20 = 70）与收藏加权（40），130 > 70 + 40 = 110，所以
 * 细节分与收藏**都不可能**把一条低档结果顶到高档上面去。这是"相对排序永远稳定"
 * 的数字依据，改任何一个数都要重算这条不等式。
 */
const SCORE_EXACT = 1000;
const SCORE_PREFIX = 600;
const SCORE_SUBSTRING = 400;
const SCORE_ACRONYM = 250;
const SCORE_SUBSEQUENCE = 120;

/** 匹配规则：决定档位。'none' = 没命中（调用方据此直接丢弃） */
type MatchRule = 'exact' | 'prefix' | 'substring' | 'acronym' | 'subsequence' | 'none';

interface NameMatch {
  rule: MatchRule;
  /** 档位分 + 细节分（不含收藏加权） */
  score: number;
  /** 命中字符在**去引号后表名**里的下标，渲染层直接用它上色 */
  matches: number[];
}

/** 标识符字符：SQL 里表名/列名的合法组成 */
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isWordChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

/** 反引号标识符去引号比对：`` `my table` `` 与 `my table` 视为同一张表 */
function stripBackticks(s: string): string {
  return s.includes('`') ? s.split('`').join('') : s;
}

/** 展示用文本：null / 非字符串 / 纯空白都算"缺失"（调用方据此整行不显示） */
function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.trim() === '' ? null : v;
}

function yesNo(b: boolean): string {
  return b ? '是' : '否';
}

/**
 * 手写千分位。
 *
 * 为什么不用 `toLocaleString('zh-CN')`：它的输出取决于**运行时 ICU 数据**，
 * Node 与浏览器、不同 Node 版本、甚至不同机器上的 full-icu / small-icu 都可能
 * 给出不同结果（分隔符可能是 `,` 也可能是 `'` 或空格），单测在 CI 上会随机红。
 * 提示 hover 只是要个"量级可读"，不需要本地化 —— 这里用纯字符串拼接，
 * 结果只由数字本身决定，永远可测。
 */
function groupThousands(n: number): string {
  const neg = n < 0;
  const digits = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    // 每三位插一个逗号：余数为 0 的位置（非首位）就是分节处
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

// ---------- token 小工具（与 lint.ts 同口径，但不 import 它：诊断与提示互不相干） ----------

function isSignificant(t: SqlToken): boolean {
  return t.kind !== 'whitespace' && t.kind !== 'comment';
}

function isPunct(t: SqlToken | undefined, ch: string): boolean {
  return t !== undefined && t.kind === 'punct' && t.raw === ch;
}

function isKw(t: SqlToken | undefined, word: string): boolean {
  return t !== undefined && t.kind === 'keyword' && t.upper === word;
}

/** 标识符 token（含反引号标识符）。关键字不算 —— `FROM t WHERE` 的 WHERE 不是表名 */
function isName(t: SqlToken | undefined): t is SqlToken {
  return t !== undefined && (t.kind === 'ident' || t.kind === 'quoted-ident');
}

/** 去引号后的名字：反引号 token 用 value，其余用 raw */
function nameOf(t: SqlToken): string {
  return t.value ?? t.raw;
}

// ===========================================================================
// A. S3 表名 / 库名提示增强
// ===========================================================================

export interface TableHint {
  name: string;
  /** 库名（有则给，用于 `db.table` 形式展示） */
  database: string | null;
  score: number;
  /** 命中字符下标（渲染层高亮用） */
  matches: number[];
}

export interface RankTableOptions {
  /** 收藏表名；命中后额外加分。大小写不敏感；**完全不匹配的表不会因此进榜** */
  favorites?: readonly string[];
  /** 截断长度，默认 50；<= 0 表示一条都不要 */
  limit?: number;
  /**
   * 整批表所属的库名。
   *
   * TableMeta **不带库名**（它是 DatabaseMeta.tables 的元素），而提示项要显示
   * `db.table`，所以只能由调用方补。渲染层已知"当前库"时用这个字段，O(1)。
   */
  database?: string | null;
  /**
   * 跨库提示时用：按**对象引用**反查每张表属于哪个库。
   *
   * 用引用而不是名字，是因为同名表在不同库里都存在（`shop.orders` /
   * `crm.orders`），按名字反查必然查错。代价是：调用方必须把同一份快照里的
   * 对象传进来（别先 map 复制一份），否则查不到 → 回退 null，不影响正确性。
   */
  databases?: readonly DatabaseMeta[];
}

/** 段首字母下标：用于"首字母缩写"匹配。`_` `-` `.` 空格 与驼峰处断词 */
function initialIndexes(name: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (!isWordChar(name[i])) continue; // 分隔符本身不是首字母
    if (i === 0) {
      out.push(i);
      continue;
    }
    const prev = name[i - 1];
    if (!isWordChar(prev)) {
      out.push(i); // `_` / `-` / `.` / 空格 之后
      continue;
    }
    // 驼峰边界：orderMain → o + M
    if (prev >= 'a' && prev <= 'z' && name[i] >= 'A' && name[i] <= 'Z') out.push(i);
  }
  return out;
}

/**
 * 首字母缩写匹配：查询串是各段首字母的**子序列**（允许跳过中间的段）。
 *
 * 例：`om` → `order_main`（o + m）、`ot` → `order_main_table`（o + m? 不，跳过
 * main 段的 m 不匹配 t，再跳过 → o + t 命中）。用子序列而不是"必须连续取前 N
 * 段"，是因为用户敲缩写时经常只记得关键段。
 */
function matchAcronym(name: string, lower: string, q: string): number[] | null {
  const hits: number[] = [];
  let qi = 0;
  for (const idx of initialIndexes(name)) {
    if (qi >= q.length) break;
    if (lower[idx] === q[qi]) {
      hits.push(idx);
      qi++;
    }
  }
  return qi === q.length ? hits : null;
}

/** 子序列匹配：贪心从左到右，越靠前越好（也是渲染层高亮的那一组下标） */
function matchSubsequence(lower: string, q: string): number[] | null {
  const hits: number[] = [];
  let i = 0;
  for (const ch of q) {
    let found = -1;
    while (i < lower.length) {
      if (lower[i] === ch) {
        found = i;
        i++;
        break;
      }
      i++;
    }
    if (found === -1) return null;
    hits.push(found);
  }
  return hits;
}

function rangeFrom(start: number, len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(start + i);
  return out;
}

/**
 * 单条表名的匹配。
 *
 * @param name 去引号后的**原始**表名（保留大小写，驼峰边界要靠它；比较用小写）
 * @param q    查询串（已去引号 / trim / 小写）
 * 规则优先级 exact > prefix > substring > acronym > subsequence，**先命中的档位胜出**。
 */
function matchName(name: string, q: string): NameMatch {
  if (q === '') return { rule: 'none', score: 0, matches: [] };
  const lower = name.toLowerCase();
  if (lower.length < q.length) return { rule: 'none', score: 0, matches: [] };

  let rule: MatchRule = 'none';
  let base = 0;
  let matches: number[] = [];

  if (lower === q) {
    rule = 'exact';
    base = SCORE_EXACT;
    matches = rangeFrom(0, q.length);
  } else if (lower.startsWith(q)) {
    rule = 'prefix';
    base = SCORE_PREFIX;
    matches = rangeFrom(0, q.length);
  } else {
    const at = lower.indexOf(q);
    if (at >= 0) {
      rule = 'substring';
      base = SCORE_SUBSTRING;
      matches = rangeFrom(at, q.length);
    } else {
      const acr = matchAcronym(name, lower, q);
      if (acr !== null && acr.length > 0) {
        rule = 'acronym';
        base = SCORE_ACRONYM;
        matches = acr;
      } else {
        const sub = matchSubsequence(lower, q);
        if (sub !== null && sub.length > 0) {
          rule = 'subsequence';
          base = SCORE_SUBSEQUENCE;
          matches = sub;
        }
      }
    }
  }

  if (rule === 'none') return { rule, score: 0, matches: [] };

  // ---- 档内细节分（合计 ≤ 70，见 SCORE_* 上方的间距说明）----
  const start = matches[0] ?? 0;
  const early = Math.max(0, 20 - start); // 命中越靠前越像目标
  const short = Math.max(0, 30 - name.length); // 同档位里短名优先
  const cover = Math.min(matches.length, 20); // 覆盖的查询字符越多越好
  return { rule, score: base + early + short + cover, matches };
}

/** 表 → 库名 的引用反查表（跨库提示时用） */
function buildDbIndex(databases: readonly DatabaseMeta[] | undefined): Map<TableMeta, string> | null {
  if (!Array.isArray(databases) || databases.length === 0) return null;
  const map = new Map<TableMeta, string>();
  for (const db of databases) {
    if (!db || typeof db !== 'object') continue;
    const dbName = typeof db.name === 'string' ? db.name : null;
    if (dbName === null) continue;
    for (const t of db.tables ?? []) {
      // 先到先得：同一张表对象理论上只属于一个库，重复挂载时不覆盖
      if (t && !map.has(t)) map.set(t, dbName);
    }
  }
  return map;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_HINT_LIMIT;
  return Math.trunc(limit);
}

/**
 * 模糊匹配表名：前缀 > 子串 > 首字母缩写 > 子序列；命中收藏加权。
 *
 * 排序保证：先按 score 降序，**同分按输入顺序**（显式带上原始下标做第二关键字，
 * 不依赖引擎 sort 的稳定性）。
 *
 * 两条容易踩的规则（都有单测守着）：
 *  - **空 query 走"不排名"分支**：全部得分 0、收藏也不加权，严格返回原序前 N。
 *    否则"刚打开提示面板"会莫名其妙把收藏顶到最前面。
 *  - **收藏不是免死金牌**：只有先命中（score > 0）才谈加权；完全不匹配的收藏
 *    一律不进结果，否则收藏一多，榜就被无关表占满了。
 */
export function rankTables(
  tables: readonly TableMeta[],
  query: string,
  opts: RankTableOptions = {},
): TableHint[] {
  const list = Array.isArray(tables) ? tables : [];
  const limit = normalizeLimit(opts.limit);
  if (limit <= 0) return [];

  // 去引号 + trim + 小写：大小写不敏感，`ord 与 ORD 同解
  const q = typeof query === 'string' ? stripBackticks(query).trim().toLowerCase() : '';

  const favorites = new Set<string>();
  for (const f of opts.favorites ?? []) {
    if (typeof f === 'string' && f !== '') favorites.add(stripBackticks(f).trim().toLowerCase());
  }

  const dbIndex = buildDbIndex(opts.databases);
  const fallbackDb = typeof opts.database === 'string' ? opts.database : null;

  interface Scored {
    hint: TableHint;
    /** 原始下标：同分时的唯一决胜依据 */
    order: number;
  }
  const scored: Scored[] = [];

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    // 脏数据（旧快照缺字段 / JSON 半截）直接跳过，绝不让渲染层拿到空名提示项
    if (!t || typeof t !== 'object' || typeof t.name !== 'string') continue;
    // name 去引号后与 matches 下标必须对齐，否则高亮会错位
    const name = stripBackticks(t.name);
    if (name === '') continue;

    let score = 0;
    let matches: number[] = [];
    if (q !== '') {
      const m = matchName(name, q);
      if (m.rule === 'none') continue; // 完全不匹配 → 不进榜（收藏也不例外）
      score = m.score;
      matches = m.matches;
      if (favorites.has(name.toLowerCase())) score += FAVORITE_BONUS;
    }

    scored.push({
      hint: { name, database: (dbIndex !== null ? dbIndex.get(t) : undefined) ?? fallbackDb, score, matches },
      order: i,
    });
  }

  // 空 query：不排序，原序前 N
  if (q === '') return scored.slice(0, limit).map((s) => s.hint);

  scored.sort((a, b) => b.hint.score - a.hint.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.hint);
}

/**
 * 解析光标所在 SQL 里的 `别名 → 表名` 映射（JOIN 多表时给当前位置推断上下文表）。
 *
 * 基于 tokens.ts 的 token 流，只认两种确定形状：
 *   `FROM <tbl> [AS] alias` 与 `JOIN <tbl> [AS] alias`
 * 其中 `<tbl>` 允许 `db.tbl` / `` `db`.`tbl` `` 限定名（**取最后一段**当表名）。
 *
 * 「绝不猜」的边界（写死在这里，逐条有单测）：
 *  1. **只认深度 0**：括号内的 FROM/JOIN 一律不解析 —— 子查询里的别名只在子查询
 *     内部成立，拿到外层来用就是错的（外层光标不该被子查询污染）。这就是任务书
 *     说的"子查询内别名放行不猜"。
 *  2. **派生表不映射**：`FROM (SELECT …) x` 的 x 指向一个结果集而不是表，
 *     没有可指的表名，硬给一个就是猜 —— 直接不给。
 *  3. **关键字不是别名**：tokenizer 已经把 WHERE / ON / GROUP 之类归为 keyword
 *     而非 ident，所以 `FROM orders WHERE` 不会把 WHERE 当别名，无需黑名单。
 *  4. **重复别名先到先得**：`FROM a x JOIN b x` 是用户写错，不替他挑一个。
 *  5. **逗号续表不解析**（`FROM a, b`）：形状不涉及时保持沉默，认不出就返回空。
 *
 * @returns 键为**小写**别名（大小写不敏感查找），值为去引号后的原始表名。
 */
export function aliasMap(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof sql !== 'string' || sql === '') return out;

  const tokens = tokenizeSql(sql);
  const sig: SqlToken[] = [];
  for (const t of tokens) if (isSignificant(t)) sig.push(t);

  let depth = 0;
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (isPunct(t, '(')) {
      depth++;
      continue;
    }
    if (isPunct(t, ')')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue; // 边界 1：子查询内一律放行
    if (!isKw(t, 'FROM') && !isKw(t, 'JOIN')) continue;

    // `FROM (` 是派生表（边界 2），`FROM` 后面什么都没有也是 —— 都不猜
    let p = k + 1;
    if (!isName(sig[p])) continue;

    let lastTok = sig[p];
    p++;
    // 限定名：`db` `.` `tbl`（反引号标识符同样走 isName）
    while (isPunct(sig[p], '.') && isName(sig[p + 1])) {
      lastTok = sig[p + 1];
      p += 2;
    }
    const tableName = nameOf(lastTok);

    let aliasTok: SqlToken | undefined;
    if (isKw(sig[p], 'AS')) {
      if (isName(sig[p + 1])) aliasTok = sig[p + 1];
    } else if (isName(sig[p])) {
      aliasTok = sig[p]; // 无 AS 的隐式别名：`FROM orders o`
    }
    if (aliasTok === undefined) continue;

    const key = nameOf(aliasTok).toLowerCase();
    if (!(key in out)) out[key] = tableName; // 边界 4：先到先得
  }
  return out;
}

/** 覆盖下标 idx 的 token（找不到返回 null） */
function tokenAt(tokens: SqlToken[], idx: number): SqlToken | null {
  for (const t of tokens) {
    if (idx >= t.from && idx < t.to) return t;
  }
  return null;
}

/** 结束于下标 idx（即紧邻其左侧）的 token（找不到返回 undefined） */
function tokenEndingAt(tokens: SqlToken[], idx: number): SqlToken | undefined {
  return tokens.find((t) => t.to === idx);
}

/**
 * 光标处的 schema 限定前缀（`db.` 或 `tbl.` 打了一半）。
 *
 * 语义：**光标左侧最后一个"未完成的 `X.` 前缀"**。`demo.ord|` 的 qualifier 是
 * `demo`（不是空 —— 点是分隔符，限定符在点左边）；`a.b.c|` 取最近那个点左边的
 * `b`（三段限定名时，"列的限定符"就是表）。
 *
 * 返回 null 的边界（逐条有单测）：
 *  - 左侧没有 `.`；
 *  - 那个点**不是真正的点号 token**：落在字符串 / 注释 / 反引号标识符里
 *    （`WHERE s = 'a.b'`、`-- a.b`、`` `a.b` ``）→ 它是数据，不是限定符；
 *    顺带地 `1.5` 里的点属于 number token，也在这里被排除；
 *  - 点左边紧邻的不是标识符（`demo .ord` 有空格、`(x).y` 是右括号）；
 *  - 点与光标之间不是"半截标识符"（有空格 / 又出现一个点 / 是 `*` 等符号）。
 *    点与光标之间**允许为空**（`demo.|`），这正是"打了一半"最常见的形态。
 *
 * @returns qualifier = 去引号后的限定符；from = 它在原文中的起始下标
 *          （渲染层要用它做替换区间的起点，所以必须给）。
 */
export function qualifierAt(sql: string, pos: number): { qualifier: string; from: number } | null {
  if (typeof sql !== 'string' || typeof pos !== 'number' || !Number.isFinite(pos)) return null;
  const p = Math.max(0, Math.min(Math.trunc(pos), sql.length));
  if (p === 0) return null;

  // 1. 光标左侧最后一个点
  let d = -1;
  for (let i = p - 1; i >= 0; i--) {
    if (sql[i] === '.') {
      d = i;
      break;
    }
  }
  if (d < 0) return null;

  const tokens = tokenizeSql(sql);
  // 2. 这个点必须是独立的 punct token
  const dotTok = tokenAt(tokens, d);
  if (dotTok === null || !isPunct(dotTok, '.')) return null;

  // 3. 点到光标之间必须是"半截标识符"（可为空）
  for (let i = d + 1; i < p; i++) {
    if (!IDENT_CHAR.test(sql[i])) return null;
  }

  // 4. 点左侧紧邻的 token 必须是标识符（关键字也不是库名/表名）
  const leftTok = tokenEndingAt(tokens, d);
  if (!isName(leftTok)) return null;

  return { qualifier: nameOf(leftTok), from: leftTok.from };
}

// ===========================================================================
// B. S4 字段属性提示
// ===========================================================================

/**
 * 索引的最小形状（只取本文件用得到的两三个字段）。
 *
 * 为什么本地定义一份而不 import core-table-designer 的 DesignIndex：
 * 那个包是表设计器的实现包，提示层引它属于反向依赖（而且任务书要求零新增依赖）。
 * 这里刻意兼容它的 `columns: { column }[]` 形状，渲染层可以直接把设计器/元数据
 * 里的索引原样喂进来，不用先 map 一次。
 */
export interface IndexRef {
  /** 索引包含的列（有序）。既收纯字符串，也收 `{ column }` 形状 */
  columns: readonly (string | { column?: string } | null | undefined)[];
  /** 是否唯一索引（给了就按它判） */
  unique?: boolean | null;
  /** 索引类型：PRIMARY / UNIQUE / INDEX / FULLTEXT…；给了就不必再换算 unique */
  kind?: string | null;
}

/**
 * TableMeta 的**可选补充**：索引清单 / 字符集 / 创建时间。
 *
 * TableMeta 本身只有 name/kind/comment/estimatedRows/engine/collation/columns，
 * 没有这三样（旧快照也没有）。渲染层若从别处（SHOW INDEX、表设计器、库级默认
 * 字符集）拿到了，就按这个形状补上；**没有就当缺失** —— 缺失的字段一律不显示，
 * 绝不用占位符糊弄用户。
 */
export interface TableExtras {
  indexes?: readonly IndexRef[] | null;
  charset?: string | null;
  createdAt?: string | number | Date | null;
}

/** 带补充信息的表；普通 TableMeta 可直接传（补充字段全是可选） */
export type IndexedTable = TableMeta & TableExtras;

function indexColumnNames(idx: IndexRef): string[] {
  const out: string[] = [];
  for (const c of idx.columns ?? []) {
    if (typeof c === 'string') {
      if (c !== '') out.push(c);
      continue;
    }
    if (c !== null && typeof c === 'object' && typeof c.column === 'string' && c.column !== '') {
      out.push(c.column);
    }
  }
  return out;
}

function isUniqueIndex(idx: IndexRef): boolean {
  if (idx.unique === true) return true;
  if (typeof idx.kind !== 'string') return false;
  const k = idx.kind.trim().toLowerCase();
  return k === 'primary' || k === 'unique';
}

/** 该列是否被某个**非唯一**索引覆盖（拿不到索引清单时永远 false —— 不猜） */
function hasNonUniqueIndex(table: IndexedTable, colName: string): boolean {
  const target = colName.trim().toLowerCase();
  if (target === '') return false;
  if (!Array.isArray(table.indexes)) return false;
  for (const idx of table.indexes) {
    if (idx === null || typeof idx !== 'object') continue;
    if (isUniqueIndex(idx)) continue;
    for (const c of indexColumnNames(idx)) {
      if (c.trim().toLowerCase() === target) return true;
    }
  }
  return false;
}

/**
 * 候选行右侧的短标记（PK / NN / AI / UQ / IDX）。
 *
 * **顺序固定**（按 push 顺序，与"重要性"一致，单测逐条断言）：
 *   PK > UQ > NN > AI > IDX
 * 为什么这个顺序：主键最贵（决定行定位），唯一其次，NOT NULL / 自增是"写入约束"
 * （写错了插不进去），普通索引只是"快不快"，放最后。
 *
 * 刻意**不进 flags** 的东西：默认值、是否有默认值、字符集、注释 —— 它们是"详情"
 * 不是"旗标"，进 `columnFacts()`。旗标只放用户扫一眼就要决定的信息，超过 5 个
 * 就没人看了。
 *
 * IDX 的判定：`IDX` = 该列出现在至少一个**非唯一**索引里（唯一索引已经有 UQ /
 * PK 表达，不再重复给）。拿不到索引清单就不给 —— 宁可少一个标记，不猜。
 *
 * flags 里所有判断都是大小写不敏感（索引列名 ↔ 列名）或直接读布尔字段。
 */
export function columnFlags(col: ColumnMeta, table?: IndexedTable | null): string[] {
  const out: string[] = [];
  if (col === null || typeof col !== 'object') return out;

  if (col.isPrimaryKey === true) out.push('PK');
  if (col.isUnique === true) out.push('UQ');
  if (col.nullable === false) out.push('NN'); // 只有显式 NOT NULL 才标；信息缺失时不标
  if (col.autoIncrement === true) out.push('AI');
  if (table !== null && table !== undefined && typeof table === 'object' && hasNonUniqueIndex(table, col.name ?? '')) {
    out.push('IDX');
  }
  return out;
}

/** hover 展示的一行属性（渲染层直接渲染成 key-value 两列） */
export interface ColumnFact {
  label: string;
  value: string;
}

/**
 * 类型串展示化：只把**类型名**大写，括号里的东西一个字符都不动。
 *
 * `varchar(255)` → `VARCHAR(255)`、`decimal(12,2)` → `DECIMAL(12,2)`（元数据里
 * 大小写混用，统一了才好看）。不动括号内容是因为 `enum('a','B')` 里的是**字面值**，
 * 大写会篡改数据语义。
 */
function formatDataType(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (s === '') return '';
  const m = /^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/.exec(s);
  if (m === null) return s;
  return `${m[1].toUpperCase()}${m[2]}`;
}

/**
 * 字段 hover 的完整属性表。
 *
 * 行序固定（单测断言）：类型 → 可空 → 默认值 → 自增 → 主键 → 唯一 →
 * 字符集 → 排序规则 → 注释。
 *
 * **缺失字段整行不显示**（不显示 `undefined` / `—` / 空串）：hover 的价值在于
 * "每条都是真信息"，塞一排占位符只是噪音。布尔类（可空/自增/主键/唯一）在字段
 * 缺失时（旧快照没有这些键）同样整行不显示 —— 不知道就说不知道，不猜"否"。
 */
export function columnFacts(col: ColumnMeta): ColumnFact[] {
  const out: ColumnFact[] = [];
  if (col === null || typeof col !== 'object') return out;

  const type = formatDataType(col.dataType);
  if (type !== '') out.push({ label: '类型', value: type });

  if (typeof col.nullable === 'boolean') out.push({ label: '可空', value: yesNo(col.nullable) });

  if (col.defaultValue !== null && col.defaultValue !== undefined) {
    // 空串默认值是有意义的（DEFAULT ''），显示成 `''` 免得看成"没有这一行"
    out.push({ label: '默认值', value: col.defaultValue === '' ? "''" : String(col.defaultValue) });
  }

  if (typeof col.autoIncrement === 'boolean') out.push({ label: '自增', value: yesNo(col.autoIncrement) });
  if (typeof col.isPrimaryKey === 'boolean') out.push({ label: '主键', value: yesNo(col.isPrimaryKey) });
  if (typeof col.isUnique === 'boolean') out.push({ label: '唯一', value: yesNo(col.isUnique) });

  const charset = textOrNull(col.charset);
  if (charset !== null) out.push({ label: '字符集', value: charset });
  const collation = textOrNull(col.collation);
  if (collation !== null) out.push({ label: '排序规则', value: collation });
  const comment = textOrNull(col.comment);
  if (comment !== null) out.push({ label: '注释', value: comment });

  return out;
}

/** 时间戳 → `YYYY-MM-DD HH:mm:ss`（UTC）。用 UTC 是为了单测跨机器稳定 */
function isoUtc(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}

function formatCreatedAt(v: unknown): string | null {
  if (typeof v === 'string') return textOrNull(v); // 服务端已经格式化好就原样展示
  if (typeof v === 'number' && Number.isFinite(v)) return isoUtc(new Date(v));
  if (v instanceof Date && !Number.isNaN(v.getTime())) return isoUtc(v);
  return null;
}

/**
 * 表级 hover 信息（注释 / 引擎 / 字符集 / 排序规则 / 字段数 / 行数估算 / 创建时间）。
 *
 * 全是内存数据，不打库。行序固定，缺失项整行不显示（理由同 columnFacts）。
 *
 * @param opts.estimatedRows 显式覆盖行数估算：
 *        - 不传 → 用 `t.estimatedRows`；
 *        - 传数字 → 用它（渲染层刚拿到更准的值时用）；
 *        - 传 **null** → 明确表示"没有"，即使表上有值也不显示这一行。
 */
export function tableFactsHover(
  t: IndexedTable,
  opts: { estimatedRows?: number | null } = {},
): ColumnFact[] {
  const out: ColumnFact[] = [];
  if (t === null || typeof t !== 'object') return out;

  const comment = textOrNull(t.comment);
  if (comment !== null) out.push({ label: '注释', value: comment });
  const engine = textOrNull(t.engine);
  if (engine !== null) out.push({ label: '引擎', value: engine });
  const charset = textOrNull(t.charset);
  if (charset !== null) out.push({ label: '字符集', value: charset });
  const collation = textOrNull(t.collation);
  if (collation !== null) out.push({ label: '排序规则', value: collation });

  if (Array.isArray(t.columns)) out.push({ label: '字段数', value: String(t.columns.length) });

  const rows = opts !== null && opts !== undefined && opts.estimatedRows !== undefined
    ? opts.estimatedRows
    : t.estimatedRows;
  if (typeof rows === 'number' && Number.isFinite(rows)) {
    out.push({ label: '估算行数', value: groupThousands(rows) });
  }

  const created = formatCreatedAt(t.createdAt);
  if (created !== null) out.push({ label: '创建时间', value: created });

  return out;
}
