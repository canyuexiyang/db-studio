/**
 * 筛选构建器（PRD §6.3.3）
 *
 * 把图形化条件变成 SQL —— 三条硬约束：
 *
 *  1. **值一律 `?` 占位绑定，绝不拼进字符串**。用户在值框里输入的任何东西
 *     都只是参数，注入面在这里被彻底掐断。
 *  2. **标识符走 `quoteIdentifier`**。
 *  3. **可预览**：产出的 `preview` 是给用户看的条件原文，UI 展示它而不是自己拼一遍
 *     （Navicat 的"长条件显示不下也加不了条件"正是预览不可编辑的后果）。
 *
 * 不变量：不完整的条件（字段名空 / 需要值却没值）**静默跳过**，不生成半截 SQL。
 * 这比抛异常更符合筛选器的交互 —— 用户是边填边看的。
 */

import type { ColumnMeta, TableMeta } from '@dbstudio/core-schema-cache';
import { quoteIdentifier } from '@dbstudio/core-sql-ident';

// ---------- 操作符 ----------

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isNull'
  | 'isNotNull'
  | 'startsWith'
  | 'endsWith'
  | 'regexp'
  | 'in'
  | 'notIn';

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: '等于',
  ne: '不等于',
  contains: '包含',
  notContains: '不包含',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  between: '介于',
  isNull: '为空',
  isNotNull: '不为空',
  startsWith: '以…开头',
  endsWith: '以…结尾',
  regexp: '正则',
  in: '属于',
  notIn: '不属于',
};

/** 不需要值的操作符 */
export const VALUELESS_OPERATORS: readonly FilterOperator[] = ['isNull', 'isNotNull'];

/** 需要两个值的操作符 */
export const RANGE_OPERATORS: readonly FilterOperator[] = ['between'];

/** 需要值列表的操作符（UI 用逗号/换行分隔，ENUM 字段给下拉多选） */
export const LIST_OPERATORS: readonly FilterOperator[] = ['in', 'notIn'];

export function needsValue(op: FilterOperator): boolean {
  return !VALUELESS_OPERATORS.includes(op);
}

/**
 * 单值操作符的值是否为"已填"。
 *
 * 空串对"等于"是有意义的输入（查空串 '），所以**不能用空串判不完整** ——
 * 只有 `undefined / null`（用户根本没碰过输入框）才算没填。
 * 这条很容易写反：写成 `(v ?? '') !== ''` 会让"查空串"永远无法提交。
 */
export function hasSingleValue(c: FilterCondition): boolean {
  return c.value !== undefined && c.value !== null;
}

export function isRangeOperator(op: FilterOperator): boolean {
  return RANGE_OPERATORS.includes(op);
}

export function isListOperator(op: FilterOperator): boolean {
  return LIST_OPERATORS.includes(op);
}

// ---------- 操作符按字段类型动态变化 ----------

function baseType(dataType: string): string {
  return (dataType ?? '').replace(/\(.*\)$/, '').trim().toLowerCase();
}

function isNumericType(dataType: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/.test(baseType(dataType));
}

function isTemporalType(dataType: string): boolean {
  return /^(date|datetime|timestamp|time)$/.test(baseType(dataType));
}

function isTextType(dataType: string): boolean {
  const t = baseType(dataType);
  if (/^(char|varchar|text|tinytext|mediumtext|longtext)$/.test(t)) return true;
  // ENUM/SET 与 JSON 都表现为字符串，允许包含类匹配
  return /^(enum|set|json)$/.test(t);
}

function isBinaryType(dataType: string): boolean {
  return /^(blob|tinyblob|mediumblob|longblob|binary|varbinary|geometry|point)$/.test(baseType(dataType));
}

/**
 * 按字段类型给出可用操作符。
 *
 * 例：数值字段不给"包含"（PRD §6.3.3 明确要求），二进制字段几乎不给操作符
 * —— 没人会对 BLOB 做 LIKE。
 */
export function operatorsForColumn(col: ColumnMeta): FilterOperator[] {
  const common: FilterOperator[] = ['eq', 'ne', 'isNull', 'isNotNull'];

  if (isBinaryType(col.dataType)) {
    return ['isNull', 'isNotNull'];
  }

  if (isNumericType(col.dataType) || isTemporalType(col.dataType)) {
    return [...common, 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn'];
  }

  if (isTextType(col.dataType)) {
    return [
      ...common,
      'contains',
      'notContains',
      'startsWith',
      'endsWith',
      'regexp',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'in',
      'notIn',
    ];
  }

  // 未知类型：给最保守的集合，宁可少给也不给会出错的
  return common;
}

/** 字段是否为"下拉多选"候选（ENUM/SET 给多选，PRD §6.3.3） */
export function suggestMultiSelect(col: ColumnMeta): boolean {
  return /^(enum|set)$/.test(baseType(col.dataType));
}

export function enumOptions(col: ColumnMeta): string[] {
  const m = /^(?:enum|set)\((.*)\)$/i.exec((col.dataType ?? '').trim());
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

// ---------- 条件模型 ----------

export type LogicOp = 'AND' | 'OR';

export interface FilterCondition {
  id: string;
  column: string;
  operator: FilterOperator;
  /** 单值 / between 的第一个值 */
  value?: string;
  /** between 的第二个值 */
  value2?: string;
  /** in / notIn 的候选值 */
  values?: string[];
  /** 分组内连接符（与前一个条件之间）。首个条件的此字段被忽略 */
  logic?: LogicOp;
}

/** 一层括号分组（PRD §6.3.3：支持一层括号分组，P1） */
export interface FilterGroup {
  id: string;
  logic: LogicOp;
  conditions: FilterCondition[];
  /** 与前一个分组之间的连接符。首个分组的此字段被忽略 */
  join?: LogicOp;
}

export interface FilterModel {
  groups: FilterGroup[];
}

/**
 * 编辑器种子的空模型：**带一条占位行**，供筛选器打开时直接开始填。
 *
 * 🔴 占位行是「草稿」，不是已生效条件 —— 只有筛选器应该用它。
 *    任何「往已生效模型里追加条件」的代码都必须用 `blankFilter()`：
 *    否则占位行会被当成真条件写进 `tab.filter`，条件条上永久挂着一条
 *    「未填完」（它不会进 WHERE，用户会以为筛选没生效）。
 */
export function emptyFilter(): FilterModel {
  return { groups: [{ id: 'g1', logic: 'AND', conditions: [{ id: 'c1', column: '', operator: 'eq', value: '' }] }] };
}

/** 空模型：一个空 AND 组，**不带占位条件**（用于程序化追加条件） */
export function blankFilter(): FilterModel {
  return { groups: [{ id: 'g1', logic: 'AND', conditions: [] }] };
}

/**
 * 去掉「连列都没选」的占位条件 —— 它是编辑器里的空行，不是条件。
 *
 * 与 `isConditionComplete` 的「未填完」刻意不同：
 *  · `column` 有值但值没填 → 是**用户写了一半的条件**，条件条要如实显示「未填完」；
 *  · `column` 为空 → 连筛哪一列都没定，它对 WHERE 无意义、对用户无信息，
 *    留着只会让条件条上永久挂一条「未填完」（`emptyFilter()` 的占位行就是这么漏进去的）。
 *
 * 返回 null = 清洗后没有任何条件（等价于「没有筛选」），调用方据此删键、
 * 而不是存一条空模型。
 */
export function stripPlaceholderConditions(model: FilterModel | null): FilterModel | null {
  if (!model) return null;
  const groups = (model.groups ?? [])
    .map((g) => ({
      ...g,
      conditions: (g.conditions ?? []).filter((c) => (c.column ?? '').trim() !== ''),
    }))
    .filter((g) => g.conditions.length > 0);
  return groups.length === 0 ? null : { groups };
}

export function isFilterEmpty(model: FilterModel): boolean {
  return (model?.groups ?? []).every((g) => (g.conditions ?? []).length === 0);
}

export function conditionCount(model: FilterModel): number {
  return (model?.groups ?? []).reduce((n, g) => n + (g.conditions?.length ?? 0), 0);
}

/**
 * 🔴 **会真正进 WHERE 的条件数** —— 与 `conditionCount` 刻意分开。
 *
 * 为什么必须分开：`conditionCount` 数的是**所有**条件（含未选字段、未填值的半截行），
 * 而 `buildWhere()` 的生效判据是 `isConditionComplete(c)`（内部已含 `!c.column → false`）。
 * 用前者去显示「筛选 (N) 条」会**虚报** —— 用户加了一行还没填完，工具栏就宣称
 * 已有筛选，而查询结果一行没变。这类"UI 说的和数据不一致"最难自查。
 *
 * ⚠️ 改 `buildWhere` 的跳过判据时，**必须同步改这里** —— 两处口径漂移的表现是
 *    徽标数与 WHERE 预览里的条件数对不上（单测 `生效条件数与 buildWhere 一致` 会红）。
 */
export function effectiveConditionCount(model: FilterModel): number {
  return (model?.groups ?? []).reduce(
    (n, g) => n + (g.conditions ?? []).filter((c) => isConditionComplete(c)).length,
    0,
  );
}

/** 给新条件/新分组发 id（避免 UI 自己造 key 造重复） */
export function nextId(prefix: string, existing: string[]): string {
  const set = new Set(existing);
  let i = 1;
  while (set.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// ---------- 值处理 ----------

/** 把列表输入（逗号/换行分隔）拆成候选值 */
export function parseListInput(text: string): string[] {
  return (text ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 值是否"可提交"。
 *
 * 空串对"等于"是合法输入（查空串），但对"为空"之外的大多数操作符没意义 ——
 * 这里不做过度拦截，交给 UI 提示；SQL 侧只保证"结构完整"。
 */
export function isConditionComplete(c: FilterCondition): boolean {
  if (!c.column) return false;
  if (!needsValue(c.operator)) return true;
  if (isListOperator(c.operator)) return (c.values ?? []).length > 0;
  if (isRangeOperator(c.operator)) {
    // BETWEEN 的两个端点都要求非空：空端点几乎一定是"还没填完"，
    // 而单值操作符的空串是有意义的（查空串），两者规则不同，别统一处理。
    return (c.value ?? '') !== '' && (c.value2 ?? '') !== '';
  }
  return hasSingleValue(c);
}

/** 空串是否代表 NULL —— 与剪贴板保持一致：字面量 NULL 表示 NULL */
export function textToParam(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (t.toUpperCase() === 'NULL' || t === '\\N') return null;
  return raw;
}

// ---------- SQL 生成 ----------

export interface BuiltWhere {
  /** WHERE 子句原文（不含 WHERE 关键字），空条件时为 '' */
  sql: string;
  /** 与 sql 中 ? 一一对应的参数 */
  params: unknown[];
  /** 给用户看的可读条件（UI 直接展示，不要再拼一遍） */
  preview: string;
}

function valueLiteral(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function conditionSql(c: FilterCondition, colIdentifier: string, params: unknown[]): string | null {
  switch (c.operator) {
    case 'eq':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} = ?`;
    case 'ne':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} != ?`;
    case 'gt':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} > ?`;
    case 'gte':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} >= ?`;
    case 'lt':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} < ?`;
    case 'lte':
      params.push(textToParam(c.value ?? ''));
      return `${colIdentifier} <= ?`;
    case 'between':
      params.push(textToParam(c.value ?? ''));
      params.push(textToParam(c.value2 ?? ''));
      return `${colIdentifier} BETWEEN ? AND ?`;
    case 'contains':
      params.push(`%${c.value ?? ''}%`);
      return `${colIdentifier} LIKE ?`;
    case 'notContains':
      params.push(`%${c.value ?? ''}%`);
      return `${colIdentifier} NOT LIKE ?`;
    case 'startsWith':
      params.push(`${c.value ?? ''}%`);
      return `${colIdentifier} LIKE ?`;
    case 'endsWith':
      params.push(`%${c.value ?? ''}`);
      return `${colIdentifier} LIKE ?`;
    case 'regexp':
      params.push(c.value ?? '');
      return `${colIdentifier} REGEXP ?`;
    case 'in': {
      const vals = (c.values ?? []).map(textToParam);
      if (vals.length === 0) return null;
      params.push(...vals);
      return `${colIdentifier} IN (${vals.map(() => '?').join(', ')})`;
    }
    case 'notIn': {
      const vals = (c.values ?? []).map(textToParam);
      if (vals.length === 0) return null;
      params.push(...vals);
      return `${colIdentifier} NOT IN (${vals.map(() => '?').join(', ')})`;
    }
    case 'isNull':
      return `${colIdentifier} IS NULL`;
    case 'isNotNull':
      return `${colIdentifier} IS NOT NULL`;
    default:
      return null;
  }
}

function conditionPreview(c: FilterCondition, colIdentifier: string): string | null {
  switch (c.operator) {
    case 'isNull':
      return `${colIdentifier} IS NULL`;
    case 'isNotNull':
      return `${colIdentifier} IS NOT NULL`;
    case 'between':
      return `${colIdentifier} BETWEEN ${valueLiteral(textToParam(c.value ?? ''))} AND ${valueLiteral(textToParam(c.value2 ?? ''))}`;
    case 'in': {
      const vals = (c.values ?? []).map(textToParam);
      return vals.length === 0 ? null : `${colIdentifier} IN (${vals.map(valueLiteral).join(', ')})`;
    }
    case 'notIn': {
      const vals = (c.values ?? []).map(textToParam);
      return vals.length === 0 ? null : `${colIdentifier} NOT IN (${vals.map(valueLiteral).join(', ')})`;
    }
    case 'contains':
      return `${colIdentifier} LIKE '%${c.value ?? ''}%'`;
    case 'notContains':
      return `${colIdentifier} NOT LIKE '%${c.value ?? ''}%'`;
    case 'startsWith':
      return `${colIdentifier} LIKE '${c.value ?? ''}%'`;
    case 'endsWith':
      return `${colIdentifier} LIKE '%${c.value ?? ''}'`;
    case 'regexp':
      return `${colIdentifier} REGEXP '${c.value ?? ''}'`;
    case 'eq':
      return `${colIdentifier} = ${valueLiteral(textToParam(c.value ?? ''))}`;
    case 'ne':
      return `${colIdentifier} != ${valueLiteral(textToParam(c.value ?? ''))}`;
    case 'gt':
      return `${colIdentifier} > ${valueLiteral(textToParam(c.value ?? ''))}`;
    case 'gte':
      return `${colIdentifier} >= ${valueLiteral(textToParam(c.value ?? ''))}`;
    case 'lt':
      return `${colIdentifier} < ${valueLiteral(textToParam(c.value ?? ''))}`;
    case 'lte':
      return `${colIdentifier} <= ${valueLiteral(textToParam(c.value ?? ''))}`;
    default:
      return null;
  }
}

/**
 * 把筛选模型编译成 WHERE。
 *
 * 不完整的条件被静默跳过（不是抛异常）—— 用户是边填边看的，
 * 半截条件不该让整个查询失败。
 */
export function buildWhere(model: FilterModel): BuiltWhere {
  const params: unknown[] = [];
  const previewParts: string[] = [];
  const sqlParts: string[] = [];

  const groups = model?.groups ?? [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const innerSql: string[] = [];
    const innerPreview: string[] = [];

    for (let ci = 0; ci < (g.conditions ?? []).length; ci++) {
      const c = g.conditions[ci];
      if (!c.column || !isConditionComplete(c)) continue;

      const ident = quoteIdentifier(c.column);
      const sql = conditionSql(c, ident, params);
      const preview = conditionPreview(c, ident);
      if (!sql || !preview) continue;

      if (innerSql.length > 0) {
        const logic = (ci > 0 ? c.logic : undefined) ?? g.logic ?? 'AND';
        innerSql.push(logic);
        innerPreview.push(logic);
      }
      innerSql.push(sql);
      innerPreview.push(preview);
    }

    if (innerSql.length === 0) continue;

    const joinedSql = innerSql.join(' ');
    const joinedPreview = innerPreview.join(' ');
    // 多个条件才需要括号；单条件不加括号，避免出现 (a = 1) 这种噪音。
    // 计数必须按"真正生成了 SQL 的条件"算，否则被跳过的半截条件会导致多余括号。
    const effectiveCount = (g.conditions ?? []).filter(
      (c) => c.column && isConditionComplete(c),
    ).length;
    const needsParens = effectiveCount > 1;

    if (sqlParts.length > 0) {
      const join = g.join ?? 'AND';
      sqlParts.push(join);
      previewParts.push(join);
    }
    sqlParts.push(needsParens ? `(${joinedSql})` : joinedSql);
    previewParts.push(needsParens ? `(${joinedPreview})` : joinedPreview);
  }

  const preview = previewParts.join(' ');
  return {
    sql: sqlParts.join(' '),
    params,
    preview: preview ? `WHERE ${preview}` : '',
  };
}

// ---------- 快捷筛选（§6.3.3） ----------

/** 单元格右键「按此值筛选」 */
export function filterByCellValue(column: string, value: unknown): FilterCondition {
  const isNull = value === null || value === undefined;
  return {
    id: `c-${Date.now().toString(36)}`,
    column,
    operator: isNull ? 'isNull' : 'eq',
    value: isNull ? undefined : String(value),
  };
}

/** 列头漏斗：常用条件（等于 / 包含 / 为空） */
export function quickFiltersForColumn(col: ColumnMeta): FilterOperator[] {
  const ops = operatorsForColumn(col);
  // 按固定顺序返回，UI 的下拉顺序才稳定（不随 operatorsForColumn 内部顺序漂移）
  const order: FilterOperator[] = ['eq', 'contains', 'isNull', 'isNotNull'];
  return order.filter((o) => ops.includes(o));
}

/**
 * 把筛选条件并入打开表的 SQL 参数。
 * 返回 null 表示无有效条件（调用方直接不加 WHERE）。
 */
export function toOpenTableFilter(model: FilterModel): { where: string; params: unknown[] } | null {
  const built = buildWhere(model);
  if (!built.sql) return null;
  return { where: built.sql, params: built.params };
}

/** 打开表用的列顺序（用于筛选器字段下拉，直接复用表元数据） */
export function filterableColumns(table: TableMeta): ColumnMeta[] {
  return (table?.columns ?? []).filter((c) => !isBinaryType(c.dataType));
}
