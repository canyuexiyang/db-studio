/**
 * 编辑保存构造器 —— 头号红线的落地机制
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §4.1（B5）
 *
 * 红线：**只提交被编辑的单元格，绝不整行覆盖**。
 * 这不是"尽量"，是几何约束：UPDATE 的 SET 列表里只出现 dirty 的列，
 * 没有 dirty 的列根本不会出现在 SQL 里 —— 想整行覆盖都做不到。
 *
 * 配套三条机制：
 *  1. 行定位策略：无主键/唯一键 → 拒绝编辑（locateStrategy = 'none' → 网格只读）
 *  2. 冲突检测：WHERE 里带上被编辑列的原值；affectedRows=0 → 冲突，不覆盖
 *  3. 批量提交语义：一轮保存 = 单事务；任一失败整轮回滚，UI 保留全部脏标记
 *
 * 安全：标识符走 quoteIdentifier 转义，值一律 ? 占位参数绑定。
 */

import type { TableMeta, ColumnMeta } from '@dbstudio/core-schema-cache';
import { quoteIdentifier, quoteQualified } from '@dbstudio/core-sql-ident';

export type LocateStrategy = 'pk' | 'unique' | 'none';

export class MutationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'MutationError';
  }
}

/**
 * 单元格值的两种形态（V10 SQL 表达式模式）。
 *
 *  - `literal`（缺省）：值走 `?` 占位参数绑定，永不进 SQL 文本 —— 既有防注入路径；
 *  - `sql-expr`：值是一段 SQL 表达式（`NOW()` / `UUID()` / `amount * 2`），
 *    **原样嵌进 SET/VALUES**，不做字符串转义（转义就等于把它变成字符串字面量，
 *    功能直接失效）。安全由三层保证：
 *      ① `validateSqlExpression()` 结构校验（分号/注释/未闭合引号/写关键字黑名单）；
 *      ② 标识符仍走 core-sql-ident（表达式只能出现在**值**的位置）；
 *      ③ 主进程执行前再过一次 AST 白名单（`checkMutationStatement`，fail-closed）。
 *    且完整 SQL 原文在保存预演里逐条展示给用户确认（头号红线）。
 */
export type EditValueKind = 'literal' | 'sql-expr';

/** 一个待提交的单元格改动 */
export interface PendingEdit {
  /** 行标识（定位列原值的序列化）。新增行为 null（尚未拿到 insertId） */
  rowId: string | null;
  locate: LocateStrategy;
  column: string;
  oldValue: unknown;
  newValue: unknown;
  /** V10：缺省 `literal`（? 参数绑定）。`sql-expr` 时 newValue 必须是字符串表达式 */
  valueKind?: EditValueKind;
  /** 类型校验失败原因；存在则该行不可提交 */
  invalid?: { reason: string };
  /** 定位列原值（顺序与 locateColumns(table) 一致）。buildMutationPlan 需要 */
  locateValues?: unknown[];
}

/** 新增行：整行的列值（主键留空由服务端生成） */
export interface PendingInsert {
  tempId: string;
  values: Record<string, unknown>;
  /**
   * V10：逐列标注哪些值是 SQL 表达式（缺省全部按字面量参数绑定）。
   * 用「按列名的稀疏映射」而不是把值包成对象 —— 既有调用方（粘贴/复制行）
   * 一行不改，只有表达式模式才需要填这个字段。
   */
  valueKinds?: Record<string, EditValueKind>;
  /**
   * T19：这一行是**用户显式新增的空白行**（没填任何值也必须出现在 INSERT 里）。
   *
   * 为什么需要这个标记：粘贴 / 复制行都至少有一个非空列，`INSERT (...) VALUES (...)`
   * 天然成立；但「新增空白行」可能一个值都没有（全是自增 / 默认值列），
   * 此时正确语义是 `INSERT INTO t () VALUES ()`（让数据库填满默认值），
   * 而不是报「新增行没有任何有效列值」—— 空表新增一行本来就是这个场景。
   */
  blank?: boolean;
}

export interface PendingDelete {
  rowId: string;
  locate: LocateStrategy;
  /** 定位列的原值（顺序与 locateColumns 一致） */
  locateValues: unknown[];
}

export interface MutationPlan {
  statements: SqlStatement[];
  /** 无法提交的改动及原因（UI 逐条展示） */
  rejected: { rowId: string | null; column: string; reason: string }[];
}

export interface SqlStatement {
  sql: string;
  params: unknown[];
  kind: 'insert' | 'update' | 'delete';
  /** 用于结果回填（新增行拿 insertId） */
  refId?: string;
  /** 人类可读说明，供保存前预览（红线 2：任何写操作必须可预览 SQL 原文） */
  readonly description?: string;
  /**
   * V10：本条语句是否含「原样嵌入」的 SQL 表达式值。
   * 预演弹窗据此显式提示 —— 表达式不走参数绑定，用户必须知道原文即将执行。
   */
  readonly hasSqlExpr?: boolean;
  /**
   * V10：SET / VALUES 段实际占用的 `?` 个数（表达式列不占参数位）。
   *
   * 🔴 `stripConflictComparisons` 必须用它定位 WHERE 参数的起点，
   *    不能用 `edits.length` —— 含表达式时两者不等，错位会把 SET 的参数
   *    当成 WHERE 的值（静默产出错 SQL，是最难查的一类 bug）。
   */
  readonly setParamCount?: number;
  /**
   * T21：本条语句的「旧值 → 新值」核对摘要（对象 / 行定位 / 字段 / 改前改后）。
   *
   * 🔴 它只是**多一层可读核对**，绝不替代原文 SQL —— 头号红线里
   *    「写操作必须可预览 SQL 原文」照旧由 `sql` 承担，且不做可选绕过。
   */
  readonly summary?: ChangeSummary;
}

// ---------- 行定位 ----------

/**
 * 这些类型的原值不进 WHERE —— 浮点与二进制比较不可靠，
 * 拿它们做冲突检测只会产生假冲突。
 */
const NON_COMPARABLE = /^(float|double|real|json|blob|binary|varbinary|geometry|point|text|longtext|mediumtext|tinytext)$/i;

export function isComparableColumn(col: ColumnMeta): boolean {
  const base = col.dataType.replace(/\(.*\)$/, '').trim().toLowerCase();
  return !NON_COMPARABLE.test(base);
}

/** 取用于定位的列：优先主键，其次唯一键组 */
export function locateColumns(table: TableMeta): ColumnMeta[] {
  const pk = table.columns.filter((c) => c.isPrimaryKey);
  if (pk.length > 0) return pk;

  const groups = (table as TableMeta & { uniqueGroups?: string[][] }).uniqueGroups ?? [];
  for (const g of groups) {
    const cols = g
      .map((name) => table.columns.find((c) => c.name === name))
      .filter((c): c is ColumnMeta => !!c);
    if (cols.length === g.length && cols.length > 0) return cols;
  }

  const uniq = table.columns.filter((c) => c.isUnique);
  return uniq;
}

export function locateStrategy(table: TableMeta): LocateStrategy {
  const cols = locateColumns(table);
  if (cols.length === 0) return 'none';
  return table.columns.some((c) => c.isPrimaryKey) ? 'pk' : 'unique';
}

/** 网格能否编辑：无唯一键 → 只读（B5 红线的技术前提） */
export function isEditable(table: TableMeta): boolean {
  return locateStrategy(table) !== 'none';
}

// ---------- 值归一化 ----------

export type CellInput = null | undefined | string | number | boolean | Date | Uint8Array;

/** 把网格里的输入归一化为可绑定的参数 */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** NULL 判定：空字符串不是 NULL（PRD §6.3.4 要求两者视觉可区分） */
export function isNullValue(v: unknown): boolean {
  return v === null || v === undefined;
}

// ---------- V10：SQL 表达式模式（值位置的白名单校验） ----------

/** 表达式长度上限：正常表达式不会超过这个量级，超长基本是粘贴事故 */
export const SQL_EXPR_MAX_LENGTH = 512;

/**
 * 禁止出现在表达式里的关键字（词边界匹配，在**剥掉字符串字面量之后**扫描 ——
 * 否则 `CONCAT('a delete b')` 会被误杀）。
 *
 * 口径刻意保守（宁可误拦不可漏放）：
 *  - 任何 DDL/DML/权限/会话控制语句的**起始词**都不该出现在一个「值」里；
 *  - `SELECT` 不在黑名单 —— PRD 明确允许子查询（`(SELECT MAX(x) FROM y)`）；
 *  - `SLEEP`/`BENCHMARK`/`LOAD_FILE` 在列 —— 它们不是写操作但是 DoS/读盘面，
 *    一个「填值」的入口不该能挂住连接或读服务器文件。
 *
 * 🔴 这一层是**渲染层的即时反馈**（用户敲完就知道不行），不是防线本身。
 *    真正的防线是主进程执行前的 AST 白名单（session-registry.checkMutationStatement）
 *    —— 与只读守卫同一个道理：UI 校验能被绕过，AST 不能。
 */
const FORBIDDEN_EXPR_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE',
  'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'RENAME',
  'GRANT', 'REVOKE', 'CALL', 'LOAD', 'HANDLER',
  'LOCK', 'UNLOCK', 'KILL', 'SHUTDOWN', 'SET',
  'SLEEP', 'BENCHMARK', 'LOAD_FILE', 'INTO', 'OUTFILE', 'DUMPFILE',
] as const;

const FORBIDDEN_EXPR_RE = new RegExp(`\\b(${FORBIDDEN_EXPR_KEYWORDS.join('|')})\\b`, 'i');

export interface SqlExprCheck {
  ok: boolean;
  /** 失败原因（可直接展示给用户）；ok 时为 null */
  reason: string | null;
}

/**
 * 校验一段「将原样嵌进 SET / VALUES 的 SQL 表达式」。
 *
 * 只做**结构性**判定，不做语义解析（语义交给主进程 AST）：
 *  1. 非空、长度有界；
 *  2. 引号/反引号/括号必须闭合 —— 未闭合的字符串会把后面的 SQL 一起吃掉，
 *     这是把「值」变成「语句」的最短路径；
 *  3. 不含分号（多语句）与注释（`--` / `#` / `/* *\/`）—— 注释能藏任意内容；
 *  4. 剥掉字符串字面量后不含写/权限/DoS 关键字。
 *
 * 扫描用一次遍历的状态机（四字符串 + 两注释），与 core-sql-editor 的
 * splitStatements / core-import 的 createStatementSplitter 同一套口径 ——
 * **禁止 split(' ') 或裸正则**：那会在 `SELECT 'a; b'` 上给出错误答案。
 */
export function validateSqlExpression(raw: unknown): SqlExprCheck {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'SQL 表达式必须是文本' };
  }
  const expr = raw.trim();
  if (expr.length === 0) {
    return { ok: false, reason: 'SQL 表达式不能为空' };
  }
  if (expr.length > SQL_EXPR_MAX_LENGTH) {
    return { ok: false, reason: `SQL 表达式过长（${expr.length} > ${SQL_EXPR_MAX_LENGTH} 字符）` };
  }

  // 单次遍历：跟踪引号态，同时把「字符串字面量之外」的字符收集进 outside
  let outside = '';
  let quote: "'" | '"' | '`' | null = null;
  let paren = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const next = expr[i + 1];

    if (quote) {
      // 反斜杠转义（MySQL 默认开启）：跳过下一个字符
      if (ch === '\\' && quote !== '`') {
        i++;
        continue;
      }
      if (ch === quote) {
        // 双写转义（'' / "" / ``）：连吃两个，保持字符串态
        if (next === quote) {
          i++;
          continue;
        }
        quote = null;
      }
      continue; // 字符串内部字符不进 outside（关键字扫描要剥掉它们）
    }

    // 非字符串态
    if (ch === ';') {
      return { ok: false, reason: 'SQL 表达式不能包含分号（不支持多语句）' };
    }
    if (ch === '-' && next === '-') {
      return { ok: false, reason: 'SQL 表达式不能包含注释（--）' };
    }
    if (ch === '#') {
      return { ok: false, reason: 'SQL 表达式不能包含注释（#）' };
    }
    if (ch === '/' && next === '*') {
      return { ok: false, reason: 'SQL 表达式不能包含块注释（/* */）' };
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') {
      paren--;
      if (paren < 0) return { ok: false, reason: 'SQL 表达式括号不匹配（多余的右括号）' };
    }
    outside += ch;
  }

  if (quote) {
    return { ok: false, reason: `SQL 表达式有未闭合的引号（${quote}）` };
  }
  if (paren !== 0) {
    return { ok: false, reason: 'SQL 表达式括号不匹配' };
  }

  const m = outside.match(FORBIDDEN_EXPR_RE);
  if (m) {
    return {
      ok: false,
      reason: `SQL 表达式不能包含「${m[1].toUpperCase()}」—— 值位置只接受函数、算术与子查询`,
    };
  }

  return { ok: true, reason: null };
}

/**
 * 归一化一段合法表达式为「可安全嵌入 SQL 的文本」。
 *
 * 只做 trim（不做任何转义 —— 转义就把它变回字符串字面量了）。
 * 调用方**必须先过 validateSqlExpression**；本函数不再重复校验，
 * 以免两处口径漂移。
 */
export function normalizeSqlExpression(raw: string): string {
  return raw.trim();
}

// ---------- SQL 构造 ----------

interface BuildContext {
  database: string;
  table: TableMeta;
  qualified: string;
}

function ctx(database: string, table: TableMeta): BuildContext {
  return { database, table, qualified: quoteQualified([database, table.name]) };
}

/** 构造定位用的 WHERE 片段（含原值冲突检测） */
function whereClause(
  c: BuildContext,
  locateCols: ColumnMeta[],
  locateValues: unknown[],
  opts: { withOriginalValues?: boolean; extraComparisons?: { column: string; value: unknown }[] } = {},
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  locateCols.forEach((col, i) => {
    const v = locateValues[i];
    if (isNullValue(v)) {
      // 原值是 NULL → 必须用 IS NULL，= NULL 永远为假
      parts.push(`${quoteIdentifier(col.name)} IS NULL`);
    } else {
      parts.push(`${quoteIdentifier(col.name)} = ?`);
      params.push(normalizeValue(v));
    }
  });

  if (opts.extraComparisons) {
    for (const cmp of opts.extraComparisons) {
      const col = c.table.columns.find((x) => x.name === cmp.column);
      if (!col || !isComparableColumn(col)) continue;
      if (isNullValue(cmp.value)) {
        parts.push(`${quoteIdentifier(cmp.column)} IS NULL`);
      } else {
        parts.push(`${quoteIdentifier(cmp.column)} = ?`);
        params.push(normalizeValue(cmp.value));
      }
    }
  }

  return { sql: parts.join(' AND '), params };
}

/**
 * 把同一行的多个 dirty 单元格合并为一条 UPDATE —— 只 SET 被编辑的列。
 */
export function buildUpdate(
  database: string,
  table: TableMeta,
  edits: PendingEdit[],
): SqlStatement {
  if (edits.length === 0) {
    throw new MutationError('没有待更新的单元格', 'EMPTY_EDIT');
  }

  const c = ctx(database, table);
  const strategy = locateStrategy(table);
  if (strategy === 'none') {
    throw new MutationError(
      `表 ${table.name} 无主键/唯一键，无法安全定位行，请使用 SQL 编辑`,
      'NO_UNIQUE_KEY',
    );
  }

  const locateCols = locateColumns(table);
  const first = edits[0];
  if (!first.locateValues) {
    throw new MutationError('缺少定位列原值，无法构造 WHERE', 'MISSING_LOCATE_VALUES');
  }

  // SET 列表：只出现被编辑的列
  const setParts: string[] = [];
  const params: unknown[] = [];
  const extra: { column: string; value: unknown }[] = [];

  for (const e of edits) {
    const col = table.columns.find((x) => x.name === e.column);
    if (!col) {
      throw new MutationError(`列 ${e.column} 不存在于表 ${table.name}`, 'UNKNOWN_COLUMN');
    }
    if (col.isPrimaryKey) {
      // 改主键是危险操作，v1 不接受（需要显式删除+重建语义）
      throw new MutationError(`不支持直接修改主键列 ${e.column}`, 'PK_NOT_EDITABLE');
    }

    /**
     * V10：表达式值**原样嵌入**（不走 ? 绑定），字面量值仍走 ? 绑定。
     *
     * 🔴 params 与 WHERE 参数的顺序契约：SET 段按 edits 顺序逐个 push，
     *    表达式列**不占参数位**（`stripConflictComparisons` 靠
     *    `setParamCount = edits.length` 定位 WHERE 起点，所以那里必须改成
     *    「SET 段实际参数个数」—— 见下方 buildUpdate 的返回与 strip 函数）。
     */
    if (e.valueKind === 'sql-expr') {
      if (typeof e.newValue !== 'string') {
        throw new MutationError(`列 ${e.column} 的 SQL 表达式必须是文本`, 'INVALID_SQL_EXPR');
      }
      const chk = validateSqlExpression(e.newValue);
      if (!chk.ok) {
        throw new MutationError(`列 ${e.column} 的 SQL 表达式不合法：${chk.reason}`, 'INVALID_SQL_EXPR');
      }
      setParts.push(`${quoteIdentifier(e.column)} = ${normalizeSqlExpression(e.newValue)}`);
    } else {
      setParts.push(`${quoteIdentifier(e.column)} = ?`);
      params.push(normalizeValue(e.newValue));
    }
    extra.push({ column: e.column, value: e.oldValue });
  }

  const where = whereClause(c, locateCols, first.locateValues, {
    withOriginalValues: true,
    extraComparisons: extra,
  });

  const sql =
    `UPDATE ${c.qualified} SET ${setParts.join(', ')} WHERE ${where.sql}`;

  const exprCols = edits.filter((e) => e.valueKind === 'sql-expr').map((e) => e.column);
  return {
    sql,
    params: [...params, ...where.params],
    kind: 'update',
    description:
      exprCols.length > 0
        ? `更新 ${c.qualified} 的 ${setParts.length} 个单元格（${exprCols.join('、')} 为 SQL 表达式，原样嵌入）`
        : `更新 ${c.qualified} 的 ${setParts.length} 个单元格`,
    // V10：预演弹窗据此把「表达式原样嵌入」显式标出来（红线：用户必须看得见原文）
    hasSqlExpr: exprCols.length > 0,
    setParamCount: params.length,
    // T21：旧值→新值摘要。原值取自 first.locateValues / e.oldValue（均由调用方从
    // 网格 source.raw() 取得），绝不用 newValue 反推。
    summary: buildChangeSummary({
      kind: 'update',
      database,
      table: table.name,
      locateColumns: locateCols.map((x) => x.name),
      locateValues: first.locateValues,
      changes: edits.map((e) => ({
        column: e.column,
        oldValue: e.oldValue,
        newValue: e.newValue,
        valueKind: e.valueKind,
      })),
    }),
  };
}

export interface BuildUpdateOptions {
  /** 关闭原值冲突检测（仅测试或明确要求覆盖时使用） */
  skipConflictCheck?: boolean;
}

export interface EditWithLocate extends PendingEdit {
  /** 定位列原值（顺序与 locateColumns(table) 一致） */
  locateValues: unknown[];
}

/**
 * 构造整轮保存计划。
 *
 * 执行顺序：UPDATE → DELETE → INSERT（新增行最后，失败即停）。
 */
export function buildMutationPlan(
  database: string,
  table: TableMeta,
  input: {
    updates?: EditWithLocate[][]; // 每个元素 = 同一行的多个单元格
    deletes?: PendingDelete[];
    inserts?: PendingInsert[];
  },
  opts: BuildUpdateOptions = {},
): MutationPlan {
  const statements: SqlStatement[] = [];
  const rejected: MutationPlan['rejected'] = [];

  const strategy = locateStrategy(table);
  const editable = strategy !== 'none';

  // ---- UPDATE ----
  for (const group of input.updates ?? []) {
    const invalid = group.filter((e) => e.invalid);
    for (const e of invalid) {
      rejected.push({
        rowId: e.rowId,
        column: e.column,
        reason: e.invalid!.reason,
      });
    }
    const valid = group.filter((e) => !e.invalid);
    if (valid.length === 0) continue;

    if (!editable) {
      for (const e of valid) {
        rejected.push({
          rowId: e.rowId,
          column: e.column,
          reason: '该表无主键/唯一键，无法安全定位行，网格为只读',
        });
      }
      continue;
    }

    try {
      let stmt = buildUpdate(database, table, valid);
      if (opts.skipConflictCheck) {
        // 去掉 WHERE 中由 extraComparisons 带来的原值条件
        stmt = stripConflictComparisons(stmt, table, valid);
      }
      // T08/T09：带上行身份（rowId）。冲突时渲染层要靠它定位「是哪一行改了」
      // 才能做「重载该行 → 对比库中现值 vs 待提交值」。旧实现只有 INSERT 带 refId，
      // UPDATE/DELETE 冲突后用户根本不知道是哪一行出的问题。
      statements.push({ ...stmt, refId: valid[0].rowId ?? undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const ed of valid) rejected.push({ rowId: ed.rowId, column: ed.column, reason: msg });
    }
  }

  // ---- DELETE ----
  for (const d of input.deletes ?? []) {
    if (!editable) {
      rejected.push({
        rowId: d.rowId,
        column: '*',
        reason: '该表无主键/唯一键，无法安全定位行，网格为只读',
      });
      continue;
    }
    const c = ctx(database, table);
    const locateCols = locateColumns(table);
    const where = whereClause(c, locateCols, d.locateValues, { withOriginalValues: true });
    statements.push({
      sql: `DELETE FROM ${c.qualified} WHERE ${where.sql}`,
      params: where.params,
      kind: 'delete',
      description: `删除 ${c.qualified} 的 1 行`,
      // T08/T09：带行身份，冲突时可定位比较
      refId: d.rowId,
      // T21：删除是整行操作 —— 摘要给对象 + 行定位，无字段级改动
      summary: buildChangeSummary({
        kind: 'delete',
        database,
        table: table.name,
        locateColumns: locateCols.map((x) => x.name),
        locateValues: d.locateValues,
      }),
    });
  }

  // ---- INSERT ----
  for (const ins of input.inserts ?? []) {
    const c = ctx(database, table);
    // 规则：① 列必须存在于表；② 自增列留空则不进列表（交给服务端生成）；
    //       ③ 显式写入的 NULL 是用户意图，要保留
    const usable = Object.entries(ins.values).filter(([k, v]) => {
      const col = table.columns.find((x) => x.name === k);
      if (!col) return false;
      if (col.autoIncrement && isNullValue(v)) return false;
      return true;
    });

    /**
     * T19：显式新增空白行 —— 允许一个值都没有。
     *
     * `INSERT INTO t () VALUES ()` 是 MySQL 的合法语法（所有列取默认值），
     * 也正是「空表新增一行 / 整张表只有自增 + 默认值列」时唯一正确的写法。
     * 旧行为在这里报「新增行没有任何有效列值」，等于把最常见的场景判成错误。
     * ⚠️ 只有调用方**显式**标注 blank 才走这条路（粘贴 / 复制行仍然照旧报错，
     *    因为那两条路径出现空行只可能是用户误操作）。
     */
    if (usable.length === 0) {
      if (ins.blank === true) {
        statements.push({
          sql: `INSERT INTO ${c.qualified} () VALUES ()`,
          params: [],
          kind: 'insert',
          refId: ins.tempId,
          description: `向 ${c.qualified} 插入 1 行（未指定任何列，全部由数据库默认值填充）`,
          setParamCount: 0,
          // T21：空白行没有任何字段改动，摘要给对象 + 「新增行」
          summary: buildChangeSummary({ kind: 'insert', database, table: table.name }),
        });
        continue;
      }
      rejected.push({ rowId: ins.tempId, column: '*', reason: '新增行没有任何有效列值' });
      continue;
    }

    // A4 复制行的配套防线：非自增主键列留空的 INSERT 必然失败
    //（NOT NULL + 唯一索引），在预演阶段就以可读理由拒绝，
    // 而不是让用户确认执行后吃一条数据库报错。
    // 注意只拦「非自增」主键：自增主键留空走上面的剔除逻辑（服务端生成）。
    const emptyPk = table.columns.filter(
      (col) => col.isPrimaryKey && !col.autoIncrement && !usable.some(([k, v]) => k === col.name && !isNullValue(v)),
    );
    if (emptyPk.length > 0) {
      rejected.push({
        rowId: ins.tempId,
        column: emptyPk.map((c) => c.name).join(', '),
        reason: `主键列 ${emptyPk.map((c) => c.name).join('、')} 未填写：非自增主键必须提供新值（复制原值会撞唯一键）`,
      });
      continue;
    }

    /**
     * T19：把**显式 NULL** 写进「NOT NULL 且无默认值」的普通列 —— 预演阶段就拒绝。
     *
     * 这正是「新增空白行」最容易踩的一步：空白行对可空列写显式 NULL 是对的，
     * 但同一套动作落到 NOT NULL 列上，MySQL 严格模式一定报 1048。
     * 与其让用户确认执行后吃一条数据库错误（还得自己去猜是哪一列），
     * 不如在预览里逐列点名。
     *
     * ⚠️ 刻意**排除主键列** —— 但要如实说明：在当前分支顺序下这个排除是**不可达的**。
     *    emptyPk 检查在更上面且会 `continue`，所以「留空的主键列」永远走不到这里；
     *    自增主键留空则早被 usable 剔除。它留在这里只是**对顺序的独立防线**：
     *    将来若有人把 NOT NULL 检查上移，没有这行就会用泛化文案覆盖掉更贴切的「主键列 X 未填写」。
     *    实测过：单独删掉这个条件，测试不变红（因为不可达）—— 所以别把它当承重墙，
     *    真正钉住契约的是下面的**互斥**断言（主键文案 vs NOT NULL 文案）。
     * ⚠️ 与之相对，**「有默认值的列」根本不该走到这里** —— 它们不该被写进 INSERT
     *    （见 buildBlankRowPlan 的 use-default）。真写了显式 NULL 就是用户意图，照样拒绝。
     */
    const nullIntoNotNull = usable.filter(([k, v]) => {
      if (!isNullValue(v)) return false;
      const col = table.columns.find((x) => x.name === k);
      return !!col && !col.nullable && !col.autoIncrement && !col.isPrimaryKey;
    });
    if (nullIntoNotNull.length > 0) {
      rejected.push({
        rowId: ins.tempId,
        column: nullIntoNotNull.map(([k]) => k).join(', '),
        reason: `列 ${nullIntoNotNull.map(([k]) => k).join('、')} 为 NOT NULL，不能写 NULL —— 请填值，或删除这一行`,
      });
      continue;
    }

    /**
     * V10：表达式值原样进 VALUES，字面量仍走 ? 占位。
     * 列名与值的对应关系必须逐列判定（valueKinds 是稀疏映射，缺省 = 字面量）。
     *
     * 🔴 列名列表必须由「实际接受的列」生成，不能用 usable：表达式校验失败的列
     *    被跳过时，若仍把它算进 cols，列数与值数就不匹配 —— MySQL 报的错
     *    (Column count doesn't match value count) 完全指不到真实原因。
     */
    const kinds = ins.valueKinds ?? {};
    const acceptedCols: string[] = [];
    const valueParts: string[] = [];
    const insertParams: unknown[] = [];
    // T21：与 acceptedCols 同源逐列生成摘要（只有真正进 INSERT 的列才进摘要）
    const summaryChanges: { column: string; oldValue: unknown; newValue: unknown; valueKind?: EditValueKind }[] = [];
    let exprCount = 0;
    for (const [k, v] of usable) {
      if (kinds[k] !== 'sql-expr') {
        acceptedCols.push(k);
        valueParts.push('?');
        insertParams.push(normalizeValue(v));
        summaryChanges.push({ column: k, oldValue: null, newValue: v });
        continue;
      }
      if (typeof v !== 'string') {
        rejected.push({ rowId: ins.tempId, column: k, reason: 'SQL 表达式必须是文本' });
        continue;
      }
      const chk = validateSqlExpression(v);
      if (!chk.ok) {
        rejected.push({ rowId: ins.tempId, column: k, reason: `SQL 表达式不合法：${chk.reason}` });
        continue;
      }
      acceptedCols.push(k);
      valueParts.push(normalizeSqlExpression(v));
      summaryChanges.push({ column: k, oldValue: null, newValue: v, valueKind: 'sql-expr' });
      exprCount++;
    }
    if (valueParts.length === 0) {
      // 全部列都被拒（或本来就没有有效列）：上面已给出逐列原因，这里不重复报
      if (usable.length > 0 && rejected.every((r) => r.rowId !== ins.tempId)) {
        rejected.push({ rowId: ins.tempId, column: '*', reason: '新增行没有任何有效列值' });
      }
      continue;
    }
    statements.push({
      sql: `INSERT INTO ${c.qualified} (${acceptedCols.map((k) => quoteIdentifier(k)).join(', ')}) VALUES (${valueParts.join(', ')})`,
      params: insertParams,
      kind: 'insert',
      refId: ins.tempId,
      description:
        exprCount > 0
          ? `向 ${c.qualified} 插入 1 行（含 ${exprCount} 个 SQL 表达式，原样嵌入）`
          : `向 ${c.qualified} 插入 1 行`,
      hasSqlExpr: exprCount > 0,
      setParamCount: insertParams.length,
      // T21：新增行没有「改前」——摘要的 oldText 统一为「（新增）」
      summary: buildChangeSummary({
        kind: 'insert',
        database,
        table: table.name,
        changes: summaryChanges,
      }),
    });
  }

  return { statements, rejected };
}

/**
 * 去掉 UPDATE 中由"原值冲突检测"追加的 WHERE 条件，只留定位列。
 * 仅用于测试或用户明确要求覆盖的场景 —— 默认路径必须带冲突检测。
 */
function stripConflictComparisons(
  stmt: SqlStatement,
  table: TableMeta,
  edits: PendingEdit[],
): SqlStatement {
  const locateCols = locateColumns(table).map((c) => c.name);
  const whereIdx = stmt.sql.indexOf(' WHERE ');
  if (whereIdx < 0) return stmt;
  const head = stmt.sql.slice(0, whereIdx);
  const wherePart = stmt.sql.slice(whereIdx + ' WHERE '.length);

  const conditions = wherePart.split(' AND ');
  const kept: string[] = [];
  const newParams: unknown[] = [];
  /**
   * 🔴 V10：SET 段实际参数个数 —— 表达式列不占 `?` 位，用 edits.length
   *    会在「含表达式 + skipConflictCheck」时错位（把 SET 的参数当 WHERE 值）。
   *    buildUpdate 已把真实个数挂在 stmt.setParamCount 上；缺省退回 edits.length
   *    （旧调用方构造的 stmt 没有这个字段，此时行为与从前完全一致）。
   */
  const setParamCount = stmt.setParamCount ?? edits.length;

  let paramCursor = setParamCount;
  for (const cond of conditions) {
    const m = cond.match(/^`((?:[^`]|``)*)`\s*=\s*\?$/);
    const name = m ? m[1].replace(/``/g, '`') : null;
    if (name && locateCols.includes(name)) {
      kept.push(cond);
      newParams.push(stmt.params[paramCursor]);
    }
    if (m) paramCursor++;
  }

  return {
    ...stmt,
    sql: `${head} WHERE ${kept.join(' AND ')}`,
    params: [...stmt.params.slice(0, setParamCount), ...newParams],
  };
}

// ---------- 复制行（A4：⌘D / 右键「插入复制行」） ----------

/** 复制行产出的单列动作 */
export interface DuplicateRowEdit {
  /** 列下标（table.columns 顺序，与网格的原始列索引一致） */
  col: number;
  column: string;
  /** null = 留空：auto-skip 交给服务端生成，needs-input 等用户填写 */
  value: unknown;
  /** copy=原样复制；auto-skip=自增列留空；needs-input=留空待用户填 */
  kind: 'copy' | 'auto-skip' | 'needs-input';
  /** needs-input 的原因（进入单元格 invalid 提示，随改动一起展示） */
  reason?: string;
}

export interface DuplicateRowPlan {
  /** 每列一个动作，顺序 = table.columns */
  edits: DuplicateRowEdit[];
  /** 自增列（留空由服务端生成） */
  autoSkipped: string[];
  /** 非自增主键列：复制原值会撞唯一键，留空让用户填新值 */
  needsInput: string[];
  /** 整体拒绝（表不可编辑）；null = 可以复制 */
  rejected: string | null;
  /** 汇总文案，UI 直接展示 */
  summary: string;
}

/**
 * 构造「插入复制行」的脏单元格计划（A4）。
 *
 * 输入被复制行的原始值数组（按 table.columns 顺序取，渲染层用
 * `source.raw(row, col)` 逐列取即可），输出每列该复制什么、留空什么。
 * 产出只是**准备脏单元格**，落库仍走 buildMutationPlan 的 INSERT 预演 ——
 * 与头号红线一致：这里绝不直接产生可执行 SQL。
 *
 * 两种主键情形（单测覆盖）：
 *  - 自增主键 → auto-skip：留空，INSERT 时列被剔除，由服务端生成；
 *  - 非自增主键 → needs-input：原样复制必然在保存时撞唯一键，留空
 *    让用户填新值；用户若不填就保存，buildMutationPlan 的 INSERT 预演
 *    会以可读理由拒绝（见下方 INSERT 分支）。
 */
export function buildDuplicateRowPlan(table: TableMeta, rowValues: readonly unknown[]): DuplicateRowPlan {
  if (locateStrategy(table) === 'none') {
    return {
      edits: [],
      autoSkipped: [],
      needsInput: [],
      rejected: '该表无主键/唯一键，无法安全定位行，网格只读，不支持复制行',
      summary: '该表无主键/唯一键，网格只读，不支持复制行',
    };
  }

  const edits: DuplicateRowEdit[] = [];
  const autoSkipped: string[] = [];
  const needsInput: string[] = [];

  table.columns.forEach((col, i) => {
    if (col.autoIncrement) {
      // 自增列留空：buildMutationPlan 会把「自增 + NULL」从 INSERT 列表剔除
      autoSkipped.push(col.name);
      edits.push({ col: i, column: col.name, value: null, kind: 'auto-skip' });
      return;
    }
    if (col.isPrimaryKey) {
      const reason = `主键列 ${col.name} 非自增，复制原值会在保存时撞唯一键，请填写新值`;
      needsInput.push(col.name);
      edits.push({ col: i, column: col.name, value: null, kind: 'needs-input', reason });
      return;
    }
    edits.push({ col: i, column: col.name, value: rowValues[i] ?? null, kind: 'copy' });
  });

  const parts = ['将追加 1 行同值新行'];
  if (autoSkipped.length > 0) parts.push(`${autoSkipped.join('、')} 由服务端生成`);
  if (needsInput.length > 0) parts.push(`主键 ${needsInput.join('、')} 留空待填写`);

  return { edits, autoSkipped, needsInput, rejected: null, summary: parts.join('，') };
}

/** 新增空白行产出的单列动作 */
export interface BlankRowEdit {
  /** 列下标（table.columns 顺序，与网格的原始列索引一致） */
  col: number;
  column: string;
  /**
   * 该列在新行里的处理方式：
   *  - `auto-skip`   —— 自增列：**不写进 INSERT**，由服务端生成；
   *  - `use-default` —— 有数据库默认值：**不写进 INSERT**，让 DEFAULT 生效；
   *  - `set-null`    —— 可空且无默认值：写**显式 NULL**；
   *  - `needs-input` —— NOT NULL 且无默认值：留空待用户填，格子标红。
   */
  kind: 'auto-skip' | 'use-default' | 'set-null' | 'needs-input';
  /** needs-input 的原因（进入单元格 invalid 提示） */
  reason?: string;
}

export interface BlankRowPlan {
  /** 每列一个动作，顺序 = table.columns */
  edits: BlankRowEdit[];
  /** 交给服务端生成（自增列） */
  autoSkipped: string[];
  /** 交给数据库默认值（有 DEFAULT 的列） */
  defaulted: string[];
  /** 无默认值但可空 → 显式写 NULL */
  nulled: string[];
  /** NOT NULL 且无默认值 → 必须用户填 */
  needsInput: string[];
  /** 整体拒绝（表不可编辑）；null = 可以新增 */
  rejected: string | null;
  /** 汇总文案，UI 直接展示 */
  summary: string;
}

/**
 * 构造「新增空白行」的脏单元格计划（T19 / 报告 §5 D16）。
 *
 * 🔴 **预演必须区分 DEFAULT 与 NULL** —— 这两件事在 SQL 层完全不同：
 *   - 写**显式 NULL**：`INSERT (col) VALUES (?)` + `null` ⇒ 该列是 NULL；
 *   - 走**数据库默认值**：**根本不把列写进 INSERT 列表** ⇒ 服务端按 DEFAULT 填。
 *   若一律写 NULL，`DEFAULT 'new'` 这类列会被写成 NULL（甚至违反 NOT NULL），
 *   而且用户看着预览也无法判断到底会发生什么。
 *
 * 产出只是**准备脏单元格**，落库仍走 buildMutationPlan 的 INSERT 预演 ——
 * 与头号红线一致：这里绝不直接产生可执行 SQL。
 *
 * 与 buildDuplicateRowPlan 的差别：复制行是「有源值可抄」，空白行是「一列值都没有」，
 * 所以判定顺序变成「自增 → 有默认值 → 可空 → 必须填」，且不依赖任何行值。
 */
export function buildBlankRowPlan(table: TableMeta): BlankRowPlan {
  if (locateStrategy(table) === 'none') {
    return {
      edits: [],
      autoSkipped: [],
      defaulted: [],
      nulled: [],
      needsInput: [],
      rejected: '该表无主键/唯一键，无法安全定位行，网格只读，不支持新增行',
      summary: '该表无主键/唯一键，网格只读，不支持新增行',
    };
  }

  const edits: BlankRowEdit[] = [];
  const autoSkipped: string[] = [];
  const defaulted: string[] = [];
  const nulled: string[] = [];
  const needsInput: string[] = [];

  table.columns.forEach((col, i) => {
    if (col.autoIncrement) {
      autoSkipped.push(col.name);
      edits.push({ col: i, column: col.name, kind: 'auto-skip' });
      return;
    }
    /**
     * ⚠️ 三种「看起来有默认值」的情况要当心：
     *  - 空串 `''` 是**合法默认值**（`DEFAULT ''`），不能当成「没默认值」；
     *  - information_schema 把 `DEFAULT NULL` 存成**字符串 'NULL'**，
     *    它与「没有 DEFAULT 子句」在本项目里无法区分（驱动统一 `String(r[5])`）；
     *  - 判断错方向的代价不对称：把有默认值误判成没默认值 → 用户被要求多填一格（烦但不丢数据）；
     *    反之会**静默多写/NULL 掉**本该由 DEFAULT 决定的值。
     *  所以这里 fail-closed：'NULL' 一律按「没有可用默认值」处理。
     */
    const dv = col.defaultValue;
    const hasDefault = dv !== null && dv !== undefined && dv.trim().toUpperCase() !== 'NULL';
    if (hasDefault) {
      defaulted.push(col.name);
      edits.push({ col: i, column: col.name, kind: 'use-default' });
      return;
    }
    if (col.nullable) {
      nulled.push(col.name);
      edits.push({ col: i, column: col.name, kind: 'set-null' });
      return;
    }
    const reason = `列 ${col.name} 为 NOT NULL 且无默认值，必须填写`;
    needsInput.push(col.name);
    edits.push({ col: i, column: col.name, kind: 'needs-input', reason });
  });

  const parts = ['将新增 1 行空白行'];
  if (autoSkipped.length > 0) parts.push(`${autoSkipped.join('、')} 由服务端生成`);
  if (defaulted.length > 0) parts.push(`${defaulted.join('、')} 使用数据库默认值`);
  if (nulled.length > 0) parts.push(`${nulled.join('、')} 置为 NULL`);
  if (needsInput.length > 0) parts.push(`${needsInput.join('、')} 必须填写`);

  return { edits, autoSkipped, defaulted, nulled, needsInput, rejected: null, summary: parts.join('，') };
}

// ---------- T21：提交预览「旧值 → 新值」摘要 ----------

/** 摘要里一个字段的「改前 → 改后」展示串 */
export interface ChangeSummaryChange {
  column: string;
  /** 改前展示串（INSERT 恒为「（新增）」—— 新增行没有原值，绝不拿 null 冒充） */
  oldText: string;
  /** 改后展示串 */
  newText: string;
  /** 值为 SQL 表达式（原样嵌入）时标出，供 UI 复用 fx 标记 */
  valueKind?: EditValueKind;
}

/**
 * T21：一条语句的核对摘要 —— 四项：对象 / 行定位 / 字段 / 改前改后。
 *
 * 🔴 头号红线不变：**原文 SQL 仍是权威**，本摘要只是把「这条语句到底改了谁、
 *    改了哪一列、从什么变成了什么」前置成人能一眼核对的形态，不替代也不折叠 SQL。
 */
export interface ChangeSummary {
  kind: 'insert' | 'update' | 'delete';
  /** 对象：受影响目标的限定名（如 `` `db`.`order` ``） */
  target: string;
  /** 行定位展示串（如 `` `id` = 2 ``）；INSERT 无定位键 → 「（新增行）」 */
  locateText: string;
  /** 字段级改动；DELETE（整行）与「空白新增行」为空数组 */
  changes: ChangeSummaryChange[];
}

/**
 * 摘要里的值展示串 —— **仅供人核对**，绝不回喂 SQL。
 *
 * 🔴 保真（红线 6）：
 *  - NULL / undefined → `NULL`，**空串 → `''`**，两者肉眼可分（绝不同形）；
 *  - 字符串原样输出（BIGINT 在列式载荷里本就是字符串 → 不经 JS Number 丢精度）；
 *  - 二进制不展开成垃圾串，只给字节数；
 *  - Date 用 ISO（不做时区补偿，与既有的展示口径一致）。
 *
 * ⚠️ 与渲染层 `grid/conflictProbe.displayValue` 语义相近但**空串口径不同**：
 *    那边把空串渲染成空文本（用于冲突逐列对比），预览摘要需要与 NULL 肉眼可分，
 *    故这里输出 SQL 空串字面量 `''`。
 */
export function formatChangeValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<二进制 ${v.length} 字节>`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v === '' ? "''" : v;
  return String(v);
}

export interface ChangeSummaryInput {
  kind: 'insert' | 'update' | 'delete';
  database: string;
  /** 表名 */
  table: string;
  /** 定位列（顺序与下面的值一致）；INSERT 缺省 */
  locateColumns?: readonly string[];
  /** 定位列原值（**必须来自网格 `source.raw()` 的真实原值，禁止用脏格新值反推**） */
  locateValues?: readonly unknown[];
  /** 字段级改动（缺省 = 无字段级改动，如 DELETE 整行删除） */
  changes?: readonly { column: string; oldValue: unknown; newValue: unknown; valueKind?: EditValueKind }[];
}

/**
 * T21：构造一条语句的摘要 —— **纯函数**（零 IO / 零 React），单测直接覆盖。
 *
 * 刻意只做「结构化 + 格式化」，不推导 SQL 语义：对象 / 行定位 / 字段 / 改前改后
 * 全部来自调用方传入的**真实原值**；调用方（buildMutationPlan）保证只传会真正提交的改动
 *（被拒绝的单元格压根不会走到这里）。
 */
export function buildChangeSummary(input: ChangeSummaryInput): ChangeSummary {
  const locateCols = input.locateColumns ?? [];
  const locateVals = input.locateValues ?? [];
  const locateParts = locateCols.map(
    (col, i) => `${quoteIdentifier(col)} = ${formatChangeValue(locateVals[i])}`,
  );

  const changes: ChangeSummaryChange[] = [];
  for (const c of input.changes ?? []) {
    const item: ChangeSummaryChange = {
      column: c.column,
      oldText: input.kind === 'insert' ? '（新增）' : formatChangeValue(c.oldValue),
      newText: formatChangeValue(c.newValue),
    };
    if (c.valueKind === 'sql-expr') item.valueKind = 'sql-expr';
    changes.push(item);
  }

  return {
    kind: input.kind,
    target: quoteQualified([input.database, input.table]),
    locateText: locateParts.length > 0 ? locateParts.join(' , ') : '（新增行）',
    changes,
  };
}

// ---------- 结果解释 ----------

export type MutationOutcome =
  | { kind: 'ok'; affectedRows: number }
  | { kind: 'conflict'; reason: string }
  | { kind: 'ambiguous'; reason: string };

/**
 * 解释 UPDATE/DELETE 的执行结果（§4.1 冲突检测）。
 *  - affectedRows === 1 → 成功
 *  - affectedRows === 0 → 行已删除或该列已被他人修改 → 冲突，不覆盖
 *  - affectedRows  > 1 → 定位条件不唯一，立即中止整轮（这是 bug，绝不能继续）
 */
export function interpretResult(affectedRows: number): MutationOutcome {
  if (affectedRows === 1) return { kind: 'ok', affectedRows };
  if (affectedRows === 0) {
    return {
      kind: 'conflict',
      reason: '该行已被删除或已被他人修改（affectedRows=0），改动未生效',
    };
  }
  return {
    kind: 'ambiguous',
    reason: `定位条件命中 ${affectedRows} 行而非 1 行，已中止本轮提交（这是定位缺陷，绝不能继续）`,
  };
}

/** 保存前预览用：把计划渲染成可逐条查看的 SQL 文本 */
export function previewSql(plan: MutationPlan): string[] {
  return plan.statements.map((s) => s.sql);
}

// ---------- T25：「使用默认值」的两种语境 ----------

/**
 * MySQL 的「默认值」在 INSERT 与 UPDATE 里是**两件不同的事**，
 * 本项目在代码注释、菜单文案、保存预览三处都必须说清，否则用户会按错的那个预期去理解：
 *
 * | 语境 | 写法 | 语义 | 列没有 DEFAULT 子句时 |
 * |---|---|---|---|
 * | INSERT（新增行） | **不把该列写进 INSERT 列表** | 由数据库按 DEFAULT 填 | 取隐式默认值（可空 → NULL；NOT NULL → 严格模式报错） |
 * | UPDATE（已有行） | `SET col = DEFAULT` | 显式把该列重设为 DEFAULT | 同上，**不是**写成字符串 `'DEFAULT'` |
 *
 * 🔴 最常见的误解是「把默认值当成某个值写进去」——
 *    默认值是**列的约束**，只有数据库知道它现在是什么；
 *    渲染层拿不到、也不该缓存它（缓存会与 DDL 漂移）。
 */
export const DEFAULT_KEYWORD = 'DEFAULT';

/** 一段文本是不是「使用默认值」关键字（去空白、大小写不敏感） */
export function isDefaultKeyword(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toUpperCase() === DEFAULT_KEYWORD;
}

export interface DefaultKeywordEdit {
  column: string;
  /** 固定 `DEFAULT` —— **SQL 关键字**，不是字符串字面量 */
  newValue: string;
  /**
   * 固定 `sql-expr`：这是渲染层目前**唯一**能一路带到 SQL 文本、且被
   * `buildUpdate` 原样嵌入的值形态（见 V10 的通道说明）。
   * 于是 `newValue='DEFAULT' + valueKind='sql-expr'` ⇒ `SET col = DEFAULT`；
   * 而 `newValue='DEFAULT' + valueKind='literal'` ⇒ `SET col = ?` 且参数是字符串 'DEFAULT'。
   * 两者产出的 SQL **完全不同**，单测里互为对照。
   */
  valueKind: EditValueKind;
}

/**
 * 构造「使用默认值」的编辑片段（**UPDATE 语境专用**）。
 *
 * ⚠️ INSERT 语境**不要**调它 —— 新增行要让数据库填默认值，
 *    做法是**把该列从 INSERT 列表里去掉**（即清除该格的待提交值），
 *    写成 `VALUES (DEFAULT)` 虽然语法合法，但它依赖"该列确实有 DEFAULT"，
 *    且会让「这一格到底是空着还是填了」在本地状态里无法区分。
 */
export function defaultValueEdit(column: string): DefaultKeywordEdit {
  return { column, newValue: DEFAULT_KEYWORD, valueKind: 'sql-expr' };
}

/**
 * 人类可读的语境说明（菜单 title / 提示条直接用）。
 *
 * @param isInsertRow 行号 ≥ 已加载行数 = 待插入的新行
 */
export function describeDefaultKeyword(isInsertRow: boolean): string {
  return isInsertRow
    ? '新行：把该列从 INSERT 列表里去掉，由数据库填默认值（不是写 NULL —— 显式 NULL 会覆盖 DEFAULT）'
    : '已有行：UPDATE … SET 该列 = DEFAULT（MySQL 关键字，不是字符串 \'DEFAULT\'）';
}

