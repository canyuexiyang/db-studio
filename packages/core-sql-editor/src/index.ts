/**
 * SQL 编辑器的纯逻辑层（PRD §6.4 / 评审 E1~E4）
 *
 * 为什么要有这个包，而不是把这些逻辑写进 React 组件：
 *
 *  1. **E4 的硬要求**：补全候选构建必须是纯函数，这样「补全延迟 ≤100ms」
 *     这条验收不依赖真机，纯逻辑就能测。顺带地，E2 的体积预算也更好守 ——
 *     这个包不进 lazy chunk（它是纯字符串逻辑，几十 KB 都不到）。
 *  2. **语句拆分是这里最容易写错的东西**。天真的 `sql.split(';')` 会被
 *     `SELECT ';'` 和 `-- a; b` 直接打穿。这是 P0 功能里的正确性问题，
 *     必须能被单测覆盖，不能藏在组件的 onChange 里。
 *
 * 刻意不做的事：
 *  - 不做 SQL 格式化（E2：sql-formatter 不入 v1）
 *  - 不支持 `DELIMITER`（存储过程/触发器语法）—— 那是表设计器的活，
 *    §6.4.1 的「多语句按分号拆解」不含自定义分隔符
 */

import type { DatabaseMeta } from '@dbstudio/core-schema-cache';

// ---------- 语句拆分 ----------

/** 拆分出的单条语句 */
export interface SqlStatementSpan {
  /** 语句原文（已 trim，不含结尾分号） */
  text: string;
  /** 在原文中的起始下标 */
  from: number;
  /** 结束下标（不含） */
  to: number;
  /** 原文是否以分号结尾（末尾那条常常没有） */
  terminated: boolean;
}

type CharKind = 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment';

/**
 * 按分号拆分语句 —— 字符串字面量与注释里的分号不算分隔。
 *
 * 四种字符串上下文 + 两种注释上下文都要跳过，少一种就会把
 * `SELECT ';'` 拆成两条。MySQL 的反斜杠转义在字符串内也生效
 * （默认 sql_mode 下 `\'` 不结束字符串）。
 */
export function splitStatements(sql: string): SqlStatementSpan[] {
  const out: SqlStatementSpan[] = [];
  const s = sql ?? '';
  let start = 0;
  let kind: CharKind = 'normal';

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];

    switch (kind) {
      case 'single':
        if (c === '\\' && next !== undefined) i++;
        else if (c === "'") kind = 'normal';
        break;
      case 'double':
        if (c === '\\' && next !== undefined) i++;
        else if (c === '"') kind = 'normal';
        break;
      case 'backtick':
        // 反引号内不处理反斜杠：MySQL 里反引号只能靠 `` 加倍
        if (c === '`') kind = 'normal';
        break;
      case 'line-comment':
        if (c === '\n') kind = 'normal';
        break;
      case 'block-comment':
        if (c === '*' && next === '/') {
          kind = 'normal';
          i++;
        }
        break;
      default:
        if (c === "'") kind = 'single';
        else if (c === '"') kind = 'double';
        else if (c === '`') kind = 'backtick';
        else if (c === '-' && next === '-' && s[i + 2] === ' ') {
          kind = 'line-comment';
          i++; // 跳过第二个 '-'，让 i++ 落在空格上
        } else if (c === '#') kind = 'line-comment';
        else if (c === '/' && next === '*') {
          kind = 'block-comment';
          i++;
        } else if (c === ';') {
          // 连续分号会产生空段，makeSpan 返回 null —— 不能 push 进去，
          // 否则下游 .map(s => s.text) 直接炸
          const span = makeSpan(s, start, i, true);
          if (span) out.push(span);
          start = i + 1;
        }
        break;
    }
  }

  // 收尾：最后一段即使没分号也要收（用户正在敲的那条）
  const tail = makeSpan(s, start, s.length, false);
  if (tail) out.push(tail);
  return out;
}

function makeSpan(s: string, from: number, to: number, terminated: boolean): SqlStatementSpan | null {
  const raw = s.slice(from, to);
  const text = raw.trim();
  if (!text) return null;
  // 去掉尾部空白后的真实结束位置（保不齐有换行缩进）
  const realEnd = to - (raw.length - raw.trimEnd().length);
  return { text, from: from + (raw.length - raw.trimStart().length), to: realEnd, terminated };
}

/** 光标/选区落在这条语句里（含边界） */
export function statementAt(sql: string, pos: number): SqlStatementSpan | null {
  const spans = splitStatements(sql ?? '');
  if (spans.length === 0) return null;
  for (const s of spans) {
    if (pos >= s.from && pos <= s.to) return s;
  }
  // 落在语句之间的空白里：给后一条（正在写的那条），没有就给最后一条
  const after = spans.find((s) => s.from > pos);
  return after ?? spans[spans.length - 1];
}

export interface ExecutionTarget {
  /** 要执行的 SQL。多条时为全部（逐条执行由调用方拆分） */
  sql: string;
  /** 是否来自显式选中 */
  fromSelection: boolean;
}

/**
 * 决定这一下 `Cmd+R` 该执行什么（§6.4.1 选中执行三条规则）。
 *
 * 优先级：有选中 → 选中内容；无选中 → 光标所在语句；全文无分号 → 全部。
 * 注意第二条与第三条不冲突：光标语句在无分号时就是全文。
 */
export function resolveExecution(
  sql: string,
  selection: { from: number; to: number } | null,
): ExecutionTarget | null {
  const s = sql ?? '';
  if (selection && selection.to > selection.from) {
    const picked = s.slice(selection.from, selection.to).trim();
    if (picked) return { sql: picked, fromSelection: true };
  }
  const spans = splitStatements(s);
  if (spans.length === 0) return null;
  // 无分号 → 全文只有一条 span，就是它
  if (spans.length === 1) return { sql: spans[0].text, fromSelection: false };
  const pos = selection && selection.to === selection.from ? selection.from : (selection?.from ?? 0);
  const hit = statementAt(s, pos);
  return hit ? { sql: hit.text, fromSelection: false } : null;
}

/** 执行计划：把要执行的文本再拆成逐条（多语句场景） */
export function toExecutableStatements(sql: string): string[] {
  return splitStatements(sql).map((s) => s.text).filter((t) => t.length > 0);
}

// ---------- EXPLAIN（§6.4.3） ----------

/** EXPLAIN 结果的标准 11 列 */
export const EXPLAIN_COLUMNS = [
  'id',
  'select_type',
  'table',
  'partitions',
  'type',
  'possible_keys',
  'key',
  'key_len',
  'ref',
  'rows',
  'filtered',
  'Extra',
] as const;

export type ExplainColumn = (typeof EXPLAIN_COLUMNS)[number];

/** 访问类型里属于"该看一眼"的（ALL 最严重，index 次之） */
const SCAN_TYPES = new Set(['ALL', 'index']);

export function isFullTableScan(type: string | null | undefined): boolean {
  return !!type && SCAN_TYPES.has(String(type).trim().toUpperCase());
}

/** Extra 里需要高亮的关键词 */
const EXTRA_WARNINGS = [
  'Using filesort',
  'Using temporary',
  'Using join buffer',
  'Range checked for each record',
];

/**
 * Extra 列里的告警词。
 * 用「词」而不是子串匹配：`Using temporary; Using filesort` 要报两条，
 * 而 `Using index condition` 不该被 `Using index` 误伤。
 */
export function extraWarnings(extra: string | null | undefined): string[] {
  if (!extra) return [];
  const e = String(extra);
  return EXTRA_WARNINGS.filter((w) => e.includes(w));
}

export interface ExplainRow {
  [key: string]: unknown;
}

export interface ExplainCell {
  /** 单元格语义：决定 UI 上色 */
  level: 'ok' | 'warn' | 'danger';
  /** 命中的告警词（level!=ok 时有值） */
  reasons: string[];
}

/** 判定一个 EXPLAIN 单元格该不该高亮 */
export function explainCell(column: string, value: unknown): ExplainCell {
  if (column === 'type') {
    return isFullTableScan(String(value ?? ''))
      ? { level: 'danger', reasons: ['全表/全索引扫描'] }
      : { level: 'ok', reasons: [] };
  }
  if (column === 'Extra') {
    const w = extraWarnings(String(value ?? ''));
    return w.length ? { level: 'warn', reasons: w } : { level: 'ok', reasons: [] };
  }
  return { level: 'ok', reasons: [] };
}

/** 给当前语句套 EXPLAIN（已经是 EXPLAIN 开头就不重复套） */
export function wrapExplain(sql: string, opts: { analyze?: boolean; json?: boolean } = {}): string {
  const s = (sql ?? '').trim().replace(/;\s*$/, '');
  if (!s) return '';
  // 已经是 EXPLAIN 语句：不再嵌套（EXPLAIN EXPLAIN ... 是语法错误）
  if (/^explain\s/i.test(s)) return s;
  const parts = ['EXPLAIN'];
  if (opts.analyze) parts.push('ANALYZE');
  if (opts.json) parts.push('FORMAT=JSON');
  return `${parts.join(' ')} ${s}`;
}

// ---------- EXPLAIN FORMAT=JSON 解析（B4 树形视图） ----------

/**
 * EXPLAIN 树节点 —— UI 无关的通用形态。
 *
 * 为什么不直接把 MySQL 的 JSON 原样丢给 UI：JSON plan 里
 * 「表」「排序/分组包装器」「物化子查询」三层语义混在动态字段名里
 * （ordering_operation / nested_loop / materialized_from_subquery…），
 * UI 不该知道这些。这里归一成 title/detail/cost/accessType/children，
 * 渲染层只管缩进和上色。
 */
export interface ExplainNode {
  /** 节点标题：表名或 SELECT #<select_id> */
  title: string;
  /** 次要信息（访问方式中文说明、行数、索引、告警旗标……），按重要性排序 */
  detail: string[];
  /** 优化器估算成本（cost_info.query_cost / prefix_cost），缺省无 */
  cost?: string;
  /** 原始访问类型（ALL / index / ref / eq_ref / range / const …），UI 据此上色 */
  accessType?: string;
  children: ExplainNode[];
}

/** MySQL JSON plan 里会包住表访问的「操作包装器」字段名 */
const EXPLAIN_WRAPPERS = [
  'ordering_operation',
  'grouping_operation',
  'windowing_operation',
  'distinct_operation',
] as const;

/** using_* 布尔旗标 → 人话。没映射到的按原样展示，不静默吞掉 */
const USING_FLAGS: Record<string, string> = {
  using_where: 'Using where',
  using_index: 'Using index（覆盖索引）',
  using_index_condition: 'Using index condition',
  using_filesort: 'Using filesort',
  using_temporary_table: 'Using temporary（临时表）',
  using_join_buffer: 'Using join buffer',
  using_index_for_group_by: 'Using index for group-by',
  using_index_for_skip_scan: 'Using index for skip scan',
  using_mrr: 'Using MRR',
  using_buffered_read: 'Using buffered read',
};

/** access_type → 中文说明（ALL 是要立刻看一眼的那个） */
function accessDescribe(access: string | undefined): string {
  switch (access) {
    case 'ALL':
      return '全表扫描（ALL）';
    case 'index':
      return '全索引扫描（index）';
    case 'range':
      return '索引范围扫描（range）';
    case 'ref':
      return '索引查找（ref）';
    case 'eq_ref':
      return '唯一索引查找（eq_ref）';
    case 'const':
      return '常量查找（const）';
    case 'system':
      return '常量查找（system）';
    case undefined:
      return '访问方式未知';
    default:
      return `访问方式 ${access}`;
  }
}

function isPlanObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return isPlanObject(v) ? v : null;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
}

/** 可能是字符串或字符串数组（possible_keys / ref）的统一展开 */
function keysToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts = v.map((x) => String(x)).filter((x) => x.length > 0);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/**
 * 校验并定位根节点。接受三种形态（都符合实际使用场景）：
 *  - JSON 字符串（`EXPLAIN FORMAT=JSON` 经 mysql2 出来就是单列单行的字符串）
 *  - 已解析的 `{ query_block: {...} }` 对象
 *  - 直接就是 query_block 本身（带 select_id 字段，容错）
 * 其余一律抛错 —— UI 捕获后降级回表格视图。
 */
function explainPlanRoot(planJson: unknown): Record<string, unknown> {
  let obj: unknown = planJson;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error('EXPLAIN JSON 不是合法的 JSON 文本');
    }
  }
  const root = asObject(obj);
  if (!root) throw new Error('EXPLAIN JSON 必须是对象');
  if (asObject(root.query_block)) return root;
  if ('select_id' in root) return { query_block: root };
  throw new Error('EXPLAIN JSON 缺少 query_block 字段');
}

/** cost_info 里挑给人看的成本：块级用 query_cost，表级用 prefix_cost（累计值更有比较意义） */
function pickCost(costInfo: unknown, prefer: 'query' | 'prefix'): string | undefined {
  const ci = asObject(costInfo);
  if (!ci) return undefined;
  return strOrUndef(ci[prefer === 'query' ? 'query_cost' : 'prefix_cost']) ?? strOrUndef(ci.read_cost);
}

/** 收集表节点自带的 using_* 布尔旗标为人话列表 */
function usingFlagTexts(t: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (v === true && k.startsWith('using_')) {
      out.push(USING_FLAGS[k] ?? k);
    }
  }
  return out;
}

/** 把一张表的访问转成节点；物化子查询作为它的子节点继续递归 */
function explainTableNode(t: Record<string, unknown>, inheritedFlags: string[]): ExplainNode {
  const access = strOrUndef(t.access_type);
  const detail: string[] = [accessDescribe(access)];

  if (t.rows_examined_per_scan !== undefined && t.rows_examined_per_scan !== null) {
    detail.push(`每次扫描检查约 ${String(t.rows_examined_per_scan)} 行`);
  }
  if (t.rows_produced_per_join !== undefined && t.rows_produced_per_join !== null) {
    detail.push(`JOIN 输出约 ${String(t.rows_produced_per_join)} 行`);
  }
  if (t.filtered !== undefined && t.filtered !== null) {
    detail.push(`过滤后剩 ${String(t.filtered)}%`);
  }

  const key = keysToString(t.key);
  if (key) {
    detail.push(`使用索引 ${key}`);
  } else {
    const possible = keysToString(t.possible_keys);
    if (possible) detail.push(`可选索引 ${possible}（未用上）`);
  }

  detail.push(...inheritedFlags, ...usingFlagTexts(t));

  const node: ExplainNode = {
    title: strOrUndef(t.table_name) ?? strOrUndef(t.table_alias) ?? '未知表',
    detail,
    cost: pickCost(t.cost_info, 'prefix'),
    accessType: access,
    children: [],
  };

  // 物化/派生表：子查询的执行计划挂在表节点下面
  const sub = asObject(t.materialized_from_subquery);
  const subQb = sub ? asObject(sub.query_block) : null;
  if (subQb) node.children.push(explainQueryBlockNode(subQb));

  return node;
}

/**
 * 收集一个块级别象里的全部表节点。
 *
 * 包装器（排序/分组/窗口）是透明的：using_filesort 这类旗标向下传给
 * 它包住的表 —— 与传统 EXPLAIN 把这些写进 Extra 列的口径一致。
 * 表的三个落点都收：tables[] / nested_loop[]（JOIN）/ 单数 table；
 * union[] 里的子 query_block 作为独立子节点。
 */
function collectExplainChildren(
  level: Record<string, unknown>,
  flags: string[],
  out: ExplainNode[],
): void {
  for (const w of EXPLAIN_WRAPPERS) {
    const inner = asObject(level[w]);
    if (!inner) continue;
    const next = [...flags];
    if (inner.using_filesort === true && !next.includes(USING_FLAGS.using_filesort)) {
      next.push(USING_FLAGS.using_filesort);
    }
    if (inner.using_temporary_table === true && !next.includes(USING_FLAGS.using_temporary_table)) {
      next.push(USING_FLAGS.using_temporary_table);
    }
    collectExplainChildren(inner, next, out);
  }

  const tables = Array.isArray(level.tables) ? level.tables : null;
  if (tables) {
    for (const t of tables) {
      const o = asObject(t);
      if (o) out.push(explainTableNode(o, flags));
    }
  }
  const nestedLoop = Array.isArray(level.nested_loop) ? level.nested_loop : null;
  if (nestedLoop) {
    for (const el of nestedLoop) {
      const o = asObject(asObject(el)?.table);
      if (o) out.push(explainTableNode(o, flags));
    }
  }
  const single = asObject(level.table);
  if (single) out.push(explainTableNode(single, flags));

  const union = Array.isArray(level.union) ? level.union : null;
  if (union) {
    for (const el of union) {
      const qb = asObject(asObject(el)?.query_block);
      if (qb) out.push(explainQueryBlockNode(qb));
    }
  }
}

/** query_block → 树节点 */
function explainQueryBlockNode(qb: Record<string, unknown>): ExplainNode {
  const node: ExplainNode = {
    title: `SELECT #${strOrUndef(qb.select_id) ?? '?'}`,
    detail: [],
    cost: pickCost(qb.cost_info, 'query'),
    children: [],
  };
  collectExplainChildren(qb, [], node.children);
  if (node.children.length === 0 && node.detail.length === 0) {
    // 纯表达式查询（SELECT 1+1）没有表可挂，给一行说明避免渲染成空气
    node.detail.push('无表访问');
  }
  return node;
}

/**
 * 把 MySQL 8 `EXPLAIN FORMAT=JSON` 的输出解析成树。
 *
 * 入参可以是 JSON 字符串或已解析对象；结构不对就抛 Error
 * （调用方捕获后降级回表格视图 + toast，不许崩）。
 */
export function buildExplainTree(planJson: unknown): ExplainNode[] {
  const root = explainPlanRoot(planJson);
  const qb = asObject(root.query_block);
  return [explainQueryBlockNode(qb as Record<string, unknown>)];
}

/**
 * 把 JSON plan 还原成传统 11 列的行 —— 给表格视图用。
 *
 * 为什么需要它（B4 的方案取舍）：执行计划按钮统一直发
 * `EXPLAIN FORMAT=JSON`（一次查询同时喂树/表格两个视图，不再发两条 SQL），
 * 而既有的表格渲染、explainCell 上色都按传统 11 列工作。
 * 这里把 JSON 反推回那 11 列，表格视图就一行不用改。
 *
 * 行序与树遍历一致（深度优先）；子查询块以 DERIVED 行自然穿插，
 * 与 MySQL 传统输出的展示顺序基本对齐。
 */
export function explainJsonToRows(planJson: unknown): Record<string, unknown>[] {
  const root = explainPlanRoot(planJson);
  const out: Record<string, unknown>[] = [];

  const emitTable = (t: Record<string, unknown>, flags: string[], selectId: unknown, selectType: string): void => {
    const extras = [...flags, ...usingFlagTexts(t)];
    out.push({
      id: selectId,
      select_type: selectType,
      table: strOrUndef(t.table_name) ?? strOrUndef(t.table_alias) ?? null,
      partitions: null,
      type: strOrUndef(t.access_type) ?? null,
      possible_keys: keysToString(t.possible_keys),
      key: keysToString(t.key),
      key_len: strOrUndef(t.key_length) ?? null,
      ref: keysToString(t.ref),
      rows: t.rows_examined_per_scan ?? null,
      filtered: strOrUndef(t.filtered) ?? null,
      Extra: extras.length ? extras.join('; ') : null,
    });
    const sub = asObject(t.materialized_from_subquery);
    const subQb = sub ? asObject(sub.query_block) : null;
    if (subQb) walkBlock(subQb, [], 'DERIVED', undefined);
  };

  const walkBlock = (
    level: Record<string, unknown>,
    flags: string[],
    selectType: string,
    inheritedSelectId: string | undefined,
  ): void => {
    // select_id 挂在 query_block 上，包装器（ordering_operation 等）没有 —— 往下透传
    const selectId = strOrUndef(level.select_id) ?? inheritedSelectId;
    for (const w of EXPLAIN_WRAPPERS) {
      const inner = asObject(level[w]);
      if (!inner) continue;
      const next = [...flags];
      if (inner.using_filesort === true && !next.includes(USING_FLAGS.using_filesort)) {
        next.push(USING_FLAGS.using_filesort);
      }
      if (inner.using_temporary_table === true && !next.includes(USING_FLAGS.using_temporary_table)) {
        next.push(USING_FLAGS.using_temporary_table);
      }
      walkBlock(inner, next, selectType, selectId);
    }
    const tables = Array.isArray(level.tables) ? level.tables : null;
    if (tables) for (const t of tables) { const o = asObject(t); if (o) emitTable(o, flags, selectId, selectType); }
    const nestedLoop = Array.isArray(level.nested_loop) ? level.nested_loop : null;
    if (nestedLoop) {
      for (const el of nestedLoop) {
        const o = asObject(asObject(el)?.table);
        if (o) emitTable(o, flags, selectId, selectType);
      }
    }
    const single = asObject(level.table);
    if (single) emitTable(single, flags, selectId, selectType);
    const union = Array.isArray(level.union) ? level.union : null;
    if (union) {
      for (const el of union) {
        const qb = asObject(asObject(el)?.query_block);
        if (qb) walkBlock(qb, [], 'UNION', undefined);
      }
    }
  };

  walkBlock(asObject(root.query_block) as Record<string, unknown>, [], 'SIMPLE', undefined);
  return out;
}

// ---------- 补全（E4） ----------

export type CompletionKind = 'keyword' | 'database' | 'table' | 'column' | 'function';

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** 次要信息：字段的类型、表的库名 */
  detail?: string;
}

/** E4：候选上限。大库可能上万张表，不截断会卡住输入 */
export const MAX_COMPLETION_ITEMS = 200;

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE TABLE', 'ALTER TABLE',
  'DROP TABLE', 'TRUNCATE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'LIKE',
  'BETWEEN', 'EXISTS', 'UNION', 'UNION ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'WITH',
] as const;

const SQL_FUNCTIONS = [
  'NOW()', 'CURDATE()', 'CURTIME()', 'UNIX_TIMESTAMP()', 'FROM_UNIXTIME()',
  'DATE_FORMAT()', 'STR_TO_DATE()', 'DATE_ADD()', 'DATE_SUB()', 'DATEDIFF()',
  'IFNULL()', 'COALESCE()', 'CONCAT()', 'CONCAT_WS()', 'GROUP_CONCAT()',
  'SUBSTRING()', 'LEFT()', 'RIGHT()', 'LENGTH()', 'CHAR_LENGTH()',
  'LOWER()', 'UPPER()', 'TRIM()', 'REPLACE()', 'ROUND()', 'FLOOR()', 'CEIL()',
  'ABS()', 'CAST()', 'JSON_EXTRACT()', 'JSON_OBJECT()',
] as const;

export function keywordCompletions(prefix: string, limit = MAX_COMPLETION_ITEMS): CompletionItem[] {
  const p = (prefix ?? '').toUpperCase();
  const out: CompletionItem[] = [];
  for (const k of SQL_KEYWORDS) {
    if (k.startsWith(p)) out.push({ label: k, kind: 'keyword' });
    if (out.length >= limit) break;
  }
  return out;
}

export function functionCompletions(prefix: string, limit = MAX_COMPLETION_ITEMS): CompletionItem[] {
  const p = (prefix ?? '').toUpperCase();
  const out: CompletionItem[] = [];
  for (const f of SQL_FUNCTIONS) {
    if (f.startsWith(p)) out.push({ label: f, kind: 'function' });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从 schema 缓存构建补全候选（E4：只吃缓存，不查库）。
 *
 * `contextTable` 是「光标所在语句里出现的表名」，给了它就能把该表的字段
 * 排到最前面 —— 补全的价值在排序，不在数量。
 */
export function schemaCompletions(
  databases: DatabaseMeta[],
  prefix: string,
  opts: { contextTable?: string | null; limit?: number } = {},
): CompletionItem[] {
  const limit = opts.limit ?? MAX_COMPLETION_ITEMS;
  const p = (prefix ?? '').toLowerCase();
  const out: CompletionItem[] = [];

  for (const db of databases ?? []) {
    if (out.length >= limit) break;
    if (db.name.toLowerCase().startsWith(p)) {
      out.push({ label: db.name, kind: 'database' });
    }
    for (const t of db.tables ?? []) {
      if (out.length >= limit) break;
      if (t.name.toLowerCase().startsWith(p)) {
        out.push({ label: t.name, kind: 'table', detail: db.name });
      }
    }
  }

  // 上下文表的字段：命中率最高，放最前
  if (opts.contextTable) {
    const ctx = (opts.contextTable ?? '').toLowerCase();
    const cols: CompletionItem[] = [];
    for (const db of databases ?? []) {
      for (const t of db.tables ?? []) {
        if (t.name.toLowerCase() !== ctx) continue;
        for (const c of t.columns ?? []) {
          if (c.name.toLowerCase().startsWith(p)) {
            cols.push({ label: c.name, kind: 'column', detail: c.dataType });
          }
        }
      }
    }
    // 其余表的字段兜在后面
    for (const db of databases ?? []) {
      for (const t of db.tables ?? []) {
        if (t.name.toLowerCase() === ctx) continue;
        for (const c of t.columns ?? []) {
          if (cols.length >= limit) break;
          if (c.name.toLowerCase().startsWith(p)) {
            cols.push({ label: c.name, kind: 'column', detail: c.dataType });
          }
        }
      }
    }
    return [...cols.slice(0, limit), ...out].slice(0, limit);
  }

  for (const db of databases ?? []) {
    for (const t of db.tables ?? []) {
      if (out.length >= limit) break;
      for (const c of t.columns ?? []) {
        if (out.length >= limit) break;
        if (c.name.toLowerCase().startsWith(p)) {
          out.push({ label: c.name, kind: 'column', detail: c.dataType });
        }
      }
    }
  }
  return out.slice(0, limit);
}

/** 全量候选（关键字 + 函数 + schema），前缀过滤 + 截断 */
export function buildCompletions(
  databases: DatabaseMeta[],
  prefix: string,
  opts: { contextTable?: string | null; limit?: number } = {},
): CompletionItem[] {
  const limit = opts.limit ?? MAX_COMPLETION_ITEMS;
  const merged = [
    ...keywordCompletions(prefix, limit),
    ...functionCompletions(prefix, limit),
    ...schemaCompletions(databases, prefix, { ...opts, limit }),
  ];
  // 去重：表名与关键字可能撞（如 `SET`），先来的优先
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const it of merged) {
    const key = `${it.kind}:${it.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从光标前的文本里猜「正在写的词」。
 *
 * 词边界按 SQL 习惯定：标识符里可以有 `_$`，但 **`.` 断词** ——
 * 这是刻意的：用户输入 `order.` 时，补全的前缀应该是【空】而不是 `"order."`，
 * 这样 `schemaCompletions()` 才会返回 order 表的全部字段。
 * 表名上下文由 `contextTableOf()` 单独负责，不靠前缀字符串去猜。
 */
export function wordBefore(text: string, pos: number): { from: number; word: string } {
  const s = text ?? '';
  let i = Math.max(0, Math.min(pos, s.length));
  while (i > 0 && /[A-Za-z0-9_$]/.test(s[i - 1])) i--;
  return { from: i, word: s.slice(i, Math.max(0, Math.min(pos, s.length))) };
}

/**
 * 从光标所在语句里找 `FROM/JOIN/UPDATE/INTO` 后的表名，用于字段补全的上下文。
 * 只取第一个 —— 多表 JOIN 时"猜"要哪个表的字段没有确定答案，
 * 不如给确定的那个（第一张表）并把其余全量兜底。
 */
export function contextTableOf(sql: string): string | null {
  const s = (sql ?? '').replace(/`/g, '');
  const m = /\b(?:from|join|update|into)\s+([A-Za-z0-9_$]+(?:\s*\.\s*[A-Za-z0-9_$]+)?)/i.exec(s);
  if (!m) return null;
  const name = m[1].replace(/\s/g, '');
  const parts = name.split('.');
  return parts[parts.length - 1] ?? null;
}

// ---------- 注释切换（Cmd+/） ----------

/**
 * 注释/取消注释选中行（§6.4.1）。
 *
 * 混选（部分已注释）时统一【加注释】—— 与主流编辑器一致，
 * 不做"有的加有的去"的智能判断，那种行为用户预测不了。
 */
export function toggleLineComment(sql: string, from: number, to: number): { text: string; from: number; to: number } {
  const s = sql ?? '';
  const lineStart = s.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  let lineEnd = s.indexOf('\n', to);
  if (lineEnd === -1) lineEnd = s.length;
  // 选区停在行首时，不该把下一行也卷进来
  const block = s.slice(lineStart, lineEnd);
  if (!block) return { text: s, from, to };

  const lines = block.split('\n');
  const allCommented = lines.every((l) => l.trimStart().startsWith('--'));

  const next = lines
    .map((l) => (allCommented ? l.replace(/^(\s*)--\s?/, '$1') : `-- ${l}`))
    .join('\n');

  const delta = next.length - block.length;
  return {
    text: s.slice(0, lineStart) + next + s.slice(lineEnd),
    from: lineStart,
    to: Math.max(lineStart, to + delta),
  };
}

// ---------- 表元信息展示 ----------
//
// 🔴 这两个函数在【独立入口 facts.ts】里，这里只 re-export。
//    原因：详情面板（首屏组件）要用它们，而本文件还带着关键字表/函数表/补全逻辑。
//    合并成一个入口会让首屏白付 15KB（实测 271KB → 286KB）。
export { tableFacts, formatCount } from './facts.js';
