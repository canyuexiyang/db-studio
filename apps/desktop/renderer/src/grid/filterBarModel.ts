/**
 * 条件条（T26）与列头快筛 / 单列多值 IN（T24）的纯逻辑。
 *
 * 为什么下沉成纯函数：这两件事的**错误都是静默的** ——
 *  · 「点掉一个条件」如果只是删了 UI 徽标而 WHERE 没变，用户看到的还是旧数据，
 *    而且**没有任何报错**；
 *  · 「草稿 vs 已生效」如果靠组件里的临时变量判，就等于没有判（照旧实现写的断言
 *    会一直是绿的）。
 * 下沉后这两条都能在 node 环境里直接证伪（见 filterBarModel.test.ts）。
 *
 * 🔴 红线：
 *  1. **筛选真值只有 `tab.filter`** —— 本模块只做「由旧模型算出新模型」的纯变换，
 *     不持有任何状态，也不自己拼 SQL 文本（SQL 一律由 `buildWhere` 产出）。
 *  2. **NULL 与空串严格区分**：字面量 NULL 走 `IS NULL` 分支，空串是**一个真实的值**，
 *     两者在 IN 列表里的处理完全不同（`x IN (NULL)` 恒为 UNKNOWN）。
 *  3. **大整数 / 时间不经过 JS Number**：值全程是字符串，`textToParam` 负责把
 *     字面量 NULL 映射成参数 null，其余原样绑定。
 */

import { IN_LIST_LIMIT } from '@dbstudio/core-clipboard';
import {
  buildWhere,
  isConditionComplete,
  isListOperator,
  isRangeOperator,
  needsValue,
  nextId,
  operatorsForColumn,
  type FilterCondition,
  type FilterGroup,
  type FilterModel,
  type FilterOperator,
  type LogicOp,
} from '@dbstudio/core-filter';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';

/** 多值 IN 的上限：直接复用 core-clipboard 的口径（T23），不另立一套 */
export const QUICK_IN_LIMIT = IN_LIST_LIMIT;

// ---------- 值解析 ----------

/** 字面量 NULL 的两种写法（与 core-filter 的 textToParam / 剪贴板口径一致） */
export function isNullToken(raw: string): boolean {
  const t = (raw ?? '').trim();
  return t.toUpperCase() === 'NULL' || t === '\\N';
}

/** 显式空串的写法：两个单引号（裸空片段不算，见 splitInInput） */
export function isEmptyStringToken(raw: string): boolean {
  return (raw ?? '').trim() === "''";
}

export interface SplitInInput {
  /** 解析出的值片段（已 trim；空串 token 已还原成 ''） */
  values: string[];
  /** 出现过的字面量 NULL（只记「有没有」，不记个数） */
  hasNull: boolean;
  /** 被忽略的裸空片段数（a,,b / 行尾逗号 / 空行） */
  emptySkipped: number;
}

/**
 * 把用户粘贴的一段文本拆成 IN 的候选值。
 *
 * 🔴 裸空片段（`a,,b`）**被忽略并计数**，而不是当成空串：
 *    粘贴 100 个 ID 时行尾逗号极常见，把它当空串会**静默把查询放宽**（多出
 *    `col = ''` 的匹配）。要查空串必须显式写 `''` —— 这条规则在 UI 里也写出来了。
 */
export function splitInInput(text: string): SplitInInput {
  const segs = (text ?? '').split(/[,\n]/);
  const values: string[] = [];
  let hasNull = false;
  let emptySkipped = 0;
  for (const seg of segs) {
    const t = seg.trim();
    if (t === '') {
      emptySkipped += 1;
      continue;
    }
    if (isNullToken(t)) {
      hasNull = true;
      continue;
    }
    values.push(isEmptyStringToken(t) ? '' : t);
  }
  // 整个输入是空白（用户还没开始输入）→ 不报「有 N 个空片段」，那句提示对空输入没有意义
  if (values.length === 0 && !hasNull && (text ?? '').trim() === '') {
    return { values, hasNull, emptySkipped: 0 };
  }
  return { values, hasNull, emptySkipped };
}

export interface InValuePlan {
  /** 真正进入 IN 列表的值（去重后、截断后，按输入顺序） */
  values: string[];
  /** 输入里出现过字面量 NULL —— 它**不进** IN 列表，要拆成 OR IS NULL */
  hasNull: boolean;
  /** 去重丢掉的个数 */
  deduped: number;
  /** 被忽略的裸空片段数 */
  emptySkipped: number;
  /** 是否因上限被截断（绝不静默少给） */
  truncated: boolean;
  /** 可应用 = false 时的中文原因 */
  ok: boolean;
  reason: string;
}

/**
 * 多值 IN 的规划：去重 / NULL 拆分 / 上限截断。
 *
 * 与 `core-clipboard.buildInList` 同一套规则（那份产出**字面量**用于复制，
 * 这份产出**参数化条件**用于服务端筛选）—— 单测里有一条刻意拿两者对账，
 * 任一侧规则漂移都会红。
 *
 * 值的形态全程是字符串：BIGINT / DATETIME 因此不会经过 JS Number 掉精度。
 */
export function planInValues(input: SplitInInput, limit: number = QUICK_IN_LIMIT): InValuePlan {
  const fail = (reason: string): InValuePlan => ({
    values: [],
    hasNull: input.hasNull,
    deduped: 0,
    emptySkipped: input.emptySkipped,
    truncated: false,
    ok: false,
    reason,
  });

  if (limit <= 0) return fail('上限设置无效');
  if (input.values.length === 0) {
    return fail(
      input.hasNull
        ? ''
        : input.emptySkipped > 0
          ? "只有空片段：请输入值，查空串要写成 ''"
          : '请输入至少一个值（逗号或换行分隔）',
    );
  }

  const seen = new Set<string>();
  const values: string[] = [];
  let deduped = 0;
  let truncated = false;

  for (const v of input.values) {
    if (seen.has(v)) {
      deduped += 1;
      continue;
    }
    if (values.length >= limit) {
      truncated = true;
      break;
    }
    seen.add(v);
    values.push(v);
  }

  if (values.length === 0) return fail('可进入 IN 列表的值去重后为空');
  return {
    values,
    hasNull: input.hasNull,
    deduped,
    emptySkipped: input.emptySkipped,
    truncated,
    ok: true,
    reason: '',
  };
}

/** 给浮层用的中文摘要（去重 / NULL / 截断 / 空片段都必须说出来） */
export function describeInPlan(plan: InValuePlan, limit: number = QUICK_IN_LIMIT): string {
  if (!plan.ok) return plan.reason || '尚未输入值';
  const parts = [`${plan.values.length} 个值`];
  if (plan.deduped > 0) parts.push(`去重 ${plan.deduped} 个`);
  if (plan.emptySkipped > 0) parts.push(`忽略 ${plan.emptySkipped} 个空片段（查空串请写 ''）`);
  if (plan.hasNull) parts.push('含 NULL → 拆成 OR IS NULL');
  if (plan.truncated) parts.push(`已达上限 ${limit}，多余的值未包含`);
  return parts.join(' · ');
}

// ---------- 按列能力 ----------

export interface ColumnFilterCapability {
  /** 该列可用的快捷操作符（等于 / 包含 / 为空…，由列类型决定） */
  operators: FilterOperator[];
  /** 是否支持多值 IN */
  canIn: boolean;
  /** 不支持多值 IN 时的中文原因 */
  inReason: string;
}

/**
 * 单值快筛里操作符的固定展示顺序（不随 operatorsForColumn 的内部顺序漂移）。
 * 区间（between）与列表（in / notIn）不在其中 —— 快筛只有一个值输入框，
 * 列表走另一条「多值 IN」路径。
 */
const SINGLE_OPERATOR_ORDER: FilterOperator[] = [
  'eq',
  'ne',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
];

/** 按列类型判定可做什么（数值列没有「包含」、二进制列只能判 NULL —— 口径只有 core-filter 一处） */
export function columnFilterCapability(col: ColumnMeta | undefined): ColumnFilterCapability {
  if (!col) return { operators: [], canIn: false, inReason: '拿不到这一列的元数据' };
  const ops = operatorsForColumn(col);
  const allowed = new Set(ops.filter((o) => !isRangeOperator(o) && !isListOperator(o)));
  // 顺序表里的优先，剩下的（如 regexp）按原顺序接在后面
  const operators = [
    ...SINGLE_OPERATOR_ORDER.filter((o) => allowed.has(o)),
    ...ops.filter((o) => allowed.has(o) && !SINGLE_OPERATOR_ORDER.includes(o)),
  ];
  const canIn = ops.includes('in');
  return {
    operators,
    canIn,
    inReason: canIn ? '' : `${col.dataType} 列不支持 IN 筛选（只能判是否为空）`,
  };
}

// ---------- 单值条件的 NULL 换算 ----------

export interface SingleValueResolution {
  ok: boolean;
  operator: FilterOperator;
  /** 需要值时的绑定值（已是原样字符串，或 null 表示真 NULL） */
  value: string | null;
  reason: string;
}

/**
 * 单值快筛的值 → 条件。
 *
 * 🔴 字面量 NULL 必须换算：
 *  - `col = NULL` / `col != NULL` 在 SQL 里恒为 UNKNOWN（**一行都匹配不到**），
 *    用户以为「筛 NULL」其实筛了个空结果 —— 所以 eq+NULL → IS NULL、ne+NULL → IS NOT NULL。
 *  - 包含类操作符遇到 NULL 没有对应语义（`LIKE NULL` 同样恒 UNKNOWN），
 *    直接判不可用并说明，不静默换成 IS NULL（那是另一个查询）。
 */
export function resolveSingleValue(operator: FilterOperator, raw: string): SingleValueResolution {
  if (!needsValue(operator)) return { ok: true, operator, value: null, reason: '' };
  if (!isNullToken(raw)) {
    // 空串是合法输入（查空串），与「没填」区分：这里由调用方判定是否填过
    return { ok: true, operator, value: raw, reason: '' };
  }
  if (operator === 'eq') return { ok: true, operator: 'isNull', value: null, reason: '' };
  if (operator === 'ne') return { ok: true, operator: 'isNotNull', value: null, reason: '' };
  return {
    ok: false,
    operator,
    value: null,
    reason: '「NULL」只能用于等于 / 不等于（已换算成 IS NULL / IS NOT NULL），包含类匹配不支持 NULL',
  };
}

// ---------- 模型变换 ----------

export interface PendingFilterGroup {
  /** 组内条件的连接方式。IN + NULL 要同组用 OR，否则会撞上 AND/OR 优先级 */
  logic?: LogicOp;
  /** 与上一组的连接方式（首组忽略） */
  join?: LogicOp;
  /** 条件（id 由 appendFilterGroups 统一发放，避免与既有 id 撞车） */
  conditions: Omit<FilterCondition, 'id'>[];
}

/**
 * 把新条件组追加到既有筛选模型上。
 *
 * 追加默认 AND（与「在已有条件上再加一条」的直觉一致）；空组顺手清掉 ——
 * 留着空组会让 buildWhere 的括号判断多一层噪音，也让筛选弹窗出现「这个组还没有条件」。
 */
export function appendFilterGroups(base: FilterModel | null, pending: PendingFilterGroup[]): FilterModel {
  const kept: FilterGroup[] = (base?.groups ?? []).filter((g) => (g.conditions ?? []).length > 0);
  let condIds: string[] = (base?.groups ?? []).flatMap((g) => (g.conditions ?? []).map((c) => c.id));
  let groupIds: string[] = kept.map((g) => g.id);

  const built: FilterGroup[] = [];
  for (const p of pending) {
    if (p.conditions.length === 0) continue;
    const conditions: FilterCondition[] = p.conditions.map((c) => {
      const id = nextId('c', condIds);
      condIds = [...condIds, id];
      return { ...c, id };
    });
    const id = nextId('g', groupIds);
    groupIds = [...groupIds, id];
    built.push({ id, logic: p.logic ?? 'AND', join: p.join, conditions });
  }
  return { groups: [...kept, ...built] };
}

/** 删除一条条件（跨组按 id 找）。返回是否被真的删掉了 —— UI 不能自己假设成功 */
export function removeConditionFromModel(
  model: FilterModel,
  condId: string,
): { model: FilterModel; removed: FilterCondition | null } {
  let removed: FilterCondition | null = null;
  const groups: FilterGroup[] = [];
  for (const g of model?.groups ?? []) {
    const hit = (g.conditions ?? []).find((c) => c.id === condId) ?? null;
    if (hit) {
      removed = hit;
      groups.push({ ...g, conditions: (g.conditions ?? []).filter((c) => c.id !== condId) });
    } else {
      groups.push(g);
    }
  }
  if (!removed) return { model, removed: null };
  // 空组不留见 appendFilterGroups 的说明
  return { model: { groups: groups.filter((g) => (g.conditions ?? []).length > 0) }, removed };
}

/**
 * 多值 IN → 条件组。
 *
 * NULL 的处理是这里唯一有实质性复杂度的点：
 *  - 只有非 NULL 值 → 单条 `col IN (?, ?, …)`（参数化，值不进 SQL 文本）；
 *  - 全是 NULL → 单条 `col IS NULL`（绝不产出 `IN ()` 这种语法错误）；
 *  - 混合 → **同一组内 OR**：`(col IN (…) OR col IS NULL)`。
 *    🔴 必须同组：拆成两组用 join:'OR' 会拼成 `a AND (col IN (…)) OR col IS NULL`，
 *    而 SQL 里 AND 优先级高于 OR —— 后半段会脱离其它条件，静默放宽结果集。
 */
export function buildInGroups(
  column: string,
  plan: InValuePlan,
  negated: boolean,
): { ok: boolean; groups: PendingFilterGroup[]; reason: string } {
  if (!plan.ok) return { ok: false, groups: [], reason: plan.reason };
  if (column.trim() === '') return { ok: false, groups: [], reason: '请先选择一列' };

  if (plan.values.length === 0) {
    if (!plan.hasNull) return { ok: false, groups: [], reason: '没有可进入 IN 列表的值' };
    // 全是 NULL：IS NULL / IS NOT NULL
    return { ok: true, groups: [{ conditions: [{ column, operator: negated ? 'isNotNull' : 'isNull' }] }], reason: '' };
  }

  const conditions: Omit<FilterCondition, 'id'>[] = [
    { column, operator: negated ? 'notIn' : 'in', values: plan.values },
  ];
  if (plan.hasNull) {
    conditions.push({ column, operator: negated ? 'isNotNull' : 'isNull' });
  }
  return { ok: true, groups: [{ logic: 'OR', conditions }], reason: '' };
}

// ---------- 条件条（T26）----------

/**
 * 单条条件的「用户可见原文」。
 *
 * 走 `buildWhere` 而不是自己拼字符串：条件条上写的话必须和真正发到服务端的
 * WHERE 是同一口径 —— 两套拼法迟早分叉，而分叉的那一侧就是「徽标说删了、SQL 没变」。
 * 未填完的条件 buildWhere 会静默跳过 → 返回 ''，正好用来标「未生效」。
 */
export function conditionText(c: FilterCondition): string {
  const built = buildWhere({ groups: [{ id: '__probe', logic: 'AND', conditions: [c] }] });
  return built.preview.replace(/^WHERE /, '');
}

export type DraftKind = 'changed' | 'new' | 'removed';

export interface FilterChip {
  id: string;
  groupId: string;
  /** 已生效条件的原文；null = 这条还没填完，不进 WHERE */
  text: string | null;
  /** 未填完（在筛选器里存在，但被 buildWhere 跳过） */
  incomplete: boolean;
  /** 已写入 tab.filter，但这次查询还在路上 —— 不能显示成「已生效」 */
  pending: boolean;
  /** 与草稿的差异；草稿未打开或完全一致时为 null */
  draft: { text: string | null; kind: DraftKind } | null;
  /** 这条是否真的在 IN 列表里（列头快筛加的多值条件，UI 要能看出来） */
  isList: boolean;
}

export interface ChipPlanInput {
  /** 真值：tab.filter */
  applied: FilterModel | null;
  /** 筛选弹窗里的草稿（未打开时为 null） */
  draft?: FilterModel | null;
  /** 该 tab 正在重查 */
  loading?: boolean;
}

function flatten(model: FilterModel | null): { groupId: string; cond: FilterCondition }[] {
  return (model?.groups ?? []).flatMap((g) => (g.conditions ?? []).map((cond) => ({ groupId: g.id, cond })));
}

/**
 * 条件条的徽标规划。
 *
 * 「草稿 vs 已生效」的判据刻意是**逐条按 id 比原文**：
 *  · id 相同、原文相同 → 就是已生效那一条，不给任何草稿标记；
 *  · id 相同、原文不同 → 草稿改了值 → 必须同时显示「已生效值」与「草稿值」；
 *  · 只在草稿里有的 id → 「草稿新增（未应用）」；
 *  · 已生效里有、草稿里没了 → 「草稿中已删除」。
 * 用「草稿里有没有」而不是「值等不等于」判，是为了让**改回原值**也能正确收敛成已生效。
 */
export function planFilterChips({ applied, draft, loading = false }: ChipPlanInput): FilterChip[] {
  const appliedRows = flatten(applied);
  const draftRows = draft ? flatten(draft) : null;
  const draftById = new Map(draftRows?.map((r) => [r.cond.id, r.cond]) ?? []);

  const chips: FilterChip[] = appliedRows.map(({ groupId, cond }) => {
    const complete = isConditionComplete(cond);
    const text = complete ? conditionText(cond) : null;
    let d: FilterChip['draft'] = null;
    if (draftRows) {
      const dc = draftById.get(cond.id);
      if (!dc) {
        d = { text: null, kind: 'removed' };
      } else {
        const dt = isConditionComplete(dc) ? conditionText(dc) : null;
        // 未填完的草稿原文是 null，未填完的已生效原文也是 null —— 都是「没生效」，
        // 不算差异；只有**两边都能拼出 SQL 且原文不同**才算「草稿改了值」。
        if (dt !== text) d = { text: dt, kind: 'changed' };
      }
    }
    return {
      id: cond.id,
      groupId,
      text,
      incomplete: !complete,
      pending: loading,
      draft: d,
      isList: isListOperator(cond.operator),
    };
  });

  // 只在草稿里新增的条件：没有已生效值，但用户得看见「还没应用」
  if (draftRows) {
    const appliedIds = new Set(appliedRows.map((r) => r.cond.id));
    for (const { groupId, cond } of draftRows) {
      if (appliedIds.has(cond.id)) continue;
      chips.push({
        id: cond.id,
        groupId,
        text: null,
        incomplete: !isConditionComplete(cond),
        pending: false,
        draft: { text: isConditionComplete(cond) ? conditionText(cond) : null, kind: 'new' },
        isList: isListOperator(cond.operator),
      });
    }
  }
  return chips;
}

export interface BarStatus {
  /** 给用户看的整条状态文案 */
  label: string;
  /** 'ok' 已生效 / 'pending' 重查在途 / 'draft' 有未应用的草稿 */
  tone: 'ok' | 'pending' | 'draft';
  /** 生效条件数（与 buildWhere 同口径，唯一的计数真值） */
  effective: number;
  /** 界面上的条件行总数（含未填完的） */
  total: number;
  /** 有草稿差异的条数 */
  draftDiff: number;
}

/**
 * 条件条整条的状态。
 *
 * 🔴 这里解决 T26 第三条「查询失败时不能让新徽标和旧数据看起来已一致」：
 *    失败路径（App 的 onFilterChange）会把乐观写入的 `tab.filter` **退回上一个模型**，
 *    所以条件条读到的真值回退、徽标回退，与旧数据重新一致 ——
 *    不是靠「显示一个失败标签」，而是**让真值本身不发生漂移**。
 *    在途（loading）期间则一律标 pending：条件已写进去，但数据还没回来。
 */
export function planBarStatus(input: ChipPlanInput): BarStatus {
  const chips = planFilterChips(input);
  const appliedRows = flatten(input.applied);
  const effective = appliedRows.filter((r) => isConditionComplete(r.cond)).length;
  const draftDiff = chips.filter((c) => c.draft != null).length;
  const total = appliedRows.length + chips.filter((c) => c.draft?.kind === 'new').length;
  const label = input.loading
    ? '正在应用筛选…'
    : draftDiff > 0
      ? `${draftDiff} 条改动尚未应用`
      : effective > 0
        ? `${effective} 条条件已生效`
        : '无筛选条件';
  return {
    label,
    tone: input.loading ? 'pending' : draftDiff > 0 ? 'draft' : 'ok',
    effective,
    total,
    draftDiff,
  };
}
