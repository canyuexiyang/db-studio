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
      statements.push(stmt);
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

    if (usable.length === 0) {
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
    let exprCount = 0;
    for (const [k, v] of usable) {
      if (kinds[k] !== 'sql-expr') {
        acceptedCols.push(k);
        valueParts.push('?');
        insertParams.push(normalizeValue(v));
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
