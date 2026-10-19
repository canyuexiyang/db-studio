/**
 * 条件条 / 列头快筛纯逻辑单测（T24 + T26）。
 *
 * 每条断言都按「先复现、再修复」的顺序写：注释里标了**证伪点** ——
 * 即这条断言在什么实现下会红。造不出前置条件的断言宁可不写，所以状态类的
 * 东西全下沉成了纯函数（这里不需要 jsdom）。
 */

import { describe, it, expect } from 'vitest';
import { buildInList, IN_LIST_LIMIT } from '@dbstudio/core-clipboard';
import {
  buildWhere,
  emptyFilter,
  isConditionComplete,
  type FilterCondition,
  type FilterModel,
} from '@dbstudio/core-filter';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import {
  QUICK_IN_LIMIT,
  appendFilterGroups,
  buildInGroups,
  columnFilterCapability,
  conditionText,
  describeInPlan,
  isEmptyStringToken,
  isNullToken,
  planBarStatus,
  planFilterChips,
  planInValues,
  removeConditionFromModel,
  resolveSingleValue,
  splitInInput,
} from './filterBarModel';

function col(name: string, dataType: string): ColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
  };
}

function cond(patch: Partial<FilterCondition> & { id: string; column: string }): FilterCondition {
  return { operator: 'eq', value: '1', ...patch };
}

function model(...conditions: FilterCondition[]): FilterModel {
  return { groups: [{ id: 'g1', logic: 'AND', conditions }] };
}

// ---------- 值解析：NULL / 空串 / 空片段 ----------

describe('splitInInput：NULL 与空串严格区分', () => {
  it('字面量 NULL 被摘出来单独记（不进 IN 列表）', () => {
    const s = splitInInput('1, NULL, 3');
    expect(s.values).toEqual(['1', '3']);
    expect(s.hasNull).toBe(true);
  });

  it('\\N 也是 NULL（与剪贴板同一口径）', () => {
    expect(splitInInput('a,\\N').hasNull).toBe(true);
    expect(splitInInput('a,\\N').values).toEqual(['a']);
  });

  it("'' 是空串值，不是「没填」（证伪点：把空串按 falsy 过滤掉 → 查空串的能力消失）", () => {
    const s = splitInInput("a, '', b");
    expect(s.values).toEqual(['a', '', 'b']);
    expect(s.emptySkipped).toBe(0);
  });

  it('裸空片段被忽略并计数（证伪点：当成空串会静默放宽查询）', () => {
    const s = splitInInput('a,,b,');
    expect(s.values).toEqual(['a', 'b']);
    expect(s.emptySkipped).toBe(2);
  });

  it('换行与逗号等价，两侧空白被 trim', () => {
    expect(splitInInput('1,\n 2 \n,3').values).toEqual(['1', '2', '3']);
  });

  it('token 判定：NULL 大小写不敏感，空串 token 是两枚单引号', () => {
    expect(isNullToken('null')).toBe(true);
    expect(isNullToken('Null')).toBe(true);
    expect(isNullToken('')).toBe(false);
    expect(isEmptyStringToken("''")).toBe(true);
    expect(isEmptyStringToken('')).toBe(false);
  });
});

// ---------- 多值 IN：去重 / 上限 ----------

describe('planInValues：去重与上限', () => {
  it('去重并保留首次出现的顺序', () => {
    const p = planInValues(splitInInput('3,1,3,2,1'));
    expect(p.values).toEqual(['3', '1', '2']);
    expect(p.deduped).toBe(2);
    expect(p.ok).toBe(true);
  });

  it('到上限就截断并如实报告（证伪点：静默少给 = 结果集静默变窄）', () => {
    const values = Array.from({ length: 7 }, (_, i) => String(i));
    const p = planInValues({ values, hasNull: false, emptySkipped: 0 }, 5);
    expect(p.values).toEqual(['0', '1', '2', '3', '4']);
    expect(p.truncated).toBe(true);
    expect(describeInPlan(p, 5)).toContain('已达上限 5');
  });

  it('默认上限与 core-clipboard 的 IN_LIST_LIMIT 同源', () => {
    expect(QUICK_IN_LIMIT).toBe(IN_LIST_LIMIT);
  });

  it('全是 NULL → 不可用于 IN，但 hasNull 保留（调用方据此退化成 IS NULL）', () => {
    const p = planInValues(splitInInput('NULL,NULL'));
    expect(p.ok).toBe(false);
    expect(p.hasNull).toBe(true);
    expect(p.values).toEqual([]);
  });

  it('大整数不经过 JS Number：字符串原样保留（证伪点：Number() 会把尾数吃掉）', () => {
    const big = '9007199254740993';
    const p = planInValues(splitInInput(`${big},${big}`));
    expect(p.values).toEqual([big]);
    // 反证：这个值确实超出安全整数范围 —— 经 Number 一圈就变样（用字符串比，避免比较双方都是同一个 double）
    expect(String(Number(big))).not.toBe(big);
  });

  /**
   * 与 T23 的 buildInList 对账：两份实现服务于不同出口（复制字面量 / 服务端参数化），
   * 但**去重 / NULL / 上限的口径必须一致**，否则用户「复制出来的 IN」和
   * 「快筛筛出来的行」对不上。
   */
  it('与 core-clipboard.buildInList 的账目一致（去重/NULL/截断）', () => {
    // 两侧口径的差别只在「NULL 怎么表达」：我收的是用户敲的字面量 NULL 文本，
    // buildInList 收的是真实 null 值（它服务的是「复制选中的单元格」）。
    const mine = planInValues(splitInInput('1, 2, 1, NULL, 3, 4'));
    const theirs = buildInList({ column: 'id', values: ['1', '2', '1', null, '3', '4'] });
    expect(mine.values.length).toBe(theirs.used);
    expect(mine.deduped).toBe(theirs.deduped);
    expect(mine.hasNull).toBe(theirs.nullCount > 0);
    expect(mine.truncated).toBe(theirs.truncated);
  });

  it('截断场景也与 buildInList 一致', () => {
    const raw = Array.from({ length: 12 }, (_, i) => String(i));
    const mine = planInValues(splitInInput(raw.join(',')), 4);
    const theirs = buildInList({ column: 'id', values: raw, limit: 4 });
    expect(mine.values.length).toBe(theirs.used);
    expect(mine.truncated).toBe(theirs.truncated);
  });
});

// ---------- 单值条件的 NULL 换算 ----------

describe('resolveSingleValue：NULL 不进「= / LIKE」', () => {
  it('等于 + NULL → IS NULL（证伪点：`col = NULL` 恒 UNKNOWN，一行都匹配不到）', () => {
    const r = resolveSingleValue('eq', 'NULL');
    expect(r.ok).toBe(true);
    expect(r.operator).toBe('isNull');
    expect(conditionText(cond({ id: 'c1', column: 'a', operator: r.operator }))).toBe('`a` IS NULL');
  });

  it('不等于 + NULL → IS NOT NULL', () => {
    expect(resolveSingleValue('ne', 'NULL').operator).toBe('isNotNull');
  });

  it('包含 + NULL → 判不可用并给原因（不静默换成 IS NULL）', () => {
    const r = resolveSingleValue('contains', 'NULL');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('包含类匹配不支持 NULL');
  });

  it('空串是合法值，不是 NULL（证伪点：把空串当 NULL 就查不到空串行）', () => {
    const r = resolveSingleValue('eq', '');
    expect(r.ok).toBe(true);
    expect(r.operator).toBe('eq');
    expect(r.value).toBe('');
    expect(isConditionComplete(cond({ id: 'c1', column: 'a', value: '' }))).toBe(true);
  });

  it('为空 / 不为空不需要值', () => {
    expect(resolveSingleValue('isNull', '').value).toBe(null);
    expect(resolveSingleValue('isNull', '').ok).toBe(true);
  });
});

// ---------- 按列能力 ----------

describe('columnFilterCapability：按类型给能力', () => {
  it('数值列没有「包含」', () => {
    expect(columnFilterCapability(col('n', 'int')).operators).not.toContain('contains');
  });

  it('文本列有「包含」', () => {
    expect(columnFilterCapability(col('s', 'varchar(64)')).operators).toContain('contains');
  });

  it('二进制列不支持 IN，并给出中文原因', () => {
    const c = columnFilterCapability(col('b', 'blob'));
    expect(c.canIn).toBe(false);
    expect(c.inReason).toContain('不支持 IN 筛选');
  });

  it('数值列给比较操作符，但区间/列表不在单值快筛里（快筛只有一个值框）', () => {
    const c = columnFilterCapability(col('n', 'int'));
    expect(c.operators).toContain('gt');
    expect(c.operators).toContain('lte');
    expect(c.operators).not.toContain('between');
    expect(c.operators).not.toContain('in');
    expect(c.canIn).toBe(true); // 多值 IN 走另一条路径
  });

  it('拿不到列元数据时整体不可用', () => {
    expect(columnFilterCapability(undefined).operators).toEqual([]);
  });

  it('操作符顺序稳定（不随 operatorsForColumn 内部顺序漂移）', () => {
    expect(columnFilterCapability(col('s', 'varchar(8)')).operators.slice(0, 3)).toEqual(['eq', 'ne', 'contains']);
  });
});

describe('planInValues：不可用时给的是人话', () => {
  it('空输入 → 提示请输入值', () => {
    expect(planInValues(splitInInput('')).reason).toContain('请输入至少一个值');
  });

  it('只有空片段 → 提示查空串要写成引号', () => {
    expect(planInValues(splitInInput('a,,')).values).toEqual(['a']);
    expect(planInValues(splitInInput(',,')).reason).toContain("查空串要写成 ''");
  });
});

// ---------- 删除单条件 → SQL 真的少一条 ----------

describe('removeConditionFromModel：删的是 WHERE，不只是徽标', () => {
  const full = model(
    cond({ id: 'c1', column: 'a', value: '1' }),
    cond({ id: 'c2', column: 'b', operator: 'contains', value: 'x' }),
    cond({ id: 'c3', column: 'c', operator: 'isNull', value: undefined }),
  );

  it('删掉一条后 buildWhere 少一个条件、少一个参数', () => {
    const before = buildWhere(full);
    const after = buildWhere(removeConditionFromModel(full, 'c2').model);
    expect(before.sql).toContain('`b`');
    expect(after.sql).not.toContain('`b`');
    // 证伪点：只删 UI 徽标不改模型 → 两句 SQL 完全一样，这条必红
    expect(after.sql).not.toBe(before.sql);
    expect(after.params.length).toBe(before.params.length - 1);
    expect(before.params.length).toBe(2); // eq + contains，isNull 不占参数
  });

  it('返回被删的那条（UI 要据此 toast），并清掉空出来的组', () => {
    const r = removeConditionFromModel(full, 'c1');
    expect(r.removed?.column).toBe('a');
    expect(r.model.groups.length).toBe(1);
    const empty = removeConditionFromModel(model(cond({ id: 'c9', column: 'z' })), 'c9');
    expect(empty.model.groups.length).toBe(0);
    expect(buildWhere(empty.model).sql).toBe('');
  });

  it('删一条不存在的 id → 模型不变且 removed=null（不假装成功）', () => {
    const r = removeConditionFromModel(full, 'nope');
    expect(r.removed).toBe(null);
    expect(buildWhere(r.model).sql).toBe(buildWhere(full).sql);
  });
});

// ---------- 多值 IN 的条件构造 ----------

describe('buildInGroups：NULL 拆分支且不破坏 AND/OR 优先级', () => {
  it('纯值 → 单条参数化 IN（值不进 SQL 文本）', () => {
    const plan = planInValues(splitInInput('1,2,3'));
    const g = buildInGroups('id', plan, false);
    const m = appendFilterGroups(null, g.groups);
    const built = buildWhere(m);
    expect(built.sql).toBe('`id` IN (?, ?, ?)');
    expect(built.params).toEqual(['1', '2', '3']);
  });

  it('含 NULL → 同组 OR：(IN … OR IS NULL)', () => {
    const plan = planInValues(splitInInput('1,NULL'));
    const m = appendFilterGroups(null, buildInGroups('id', plan, false).groups);
    expect(buildWhere(m).sql).toBe('(`id` IN (?) OR `id` IS NULL)');
  });

  /**
   * 这条是优先级守卫：
   * 若把 IN 与 IS NULL 拆成两个组、靠 join:'OR' 连接，buildWhere 会拼出
   * `other = ? AND (id IN (?)) OR id IS NULL` —— SQL 里 AND 优先于 OR，
   * 末尾的 IS NULL 会脱离其它条件，静默放宽结果集。
   */
  it('与既有条件叠加时，OR 分支必须整体带括号（不能被前面的 AND 抢走）', () => {
    const base = model(cond({ id: 'c1', column: 'other', value: '9' }));
    const plan = planInValues(splitInInput('1,NULL'));
    const m = appendFilterGroups(base, buildInGroups('id', plan, false).groups);
    const sql = buildWhere(m).sql;
    expect(sql).toBe('`other` = ? AND (`id` IN (?) OR `id` IS NULL)');
    // 反证：两组的写法会长成这样（末尾 OR 无括号包裹）
    const twoGroups: FilterModel = {
      groups: [
        { id: 'g1', logic: 'AND', conditions: [cond({ id: 'c1', column: 'other', value: '9' })] },
        { id: 'g2', logic: 'AND', join: 'AND', conditions: [{ id: 'c2', column: 'id', operator: 'in', values: ['1'] }] },
        { id: 'g3', logic: 'AND', join: 'OR', conditions: [{ id: 'c3', column: 'id', operator: 'isNull' }] },
      ],
    };
    expect(buildWhere(twoGroups).sql).toBe('`other` = ? AND `id` IN (?) OR `id` IS NULL');
    expect(buildWhere(twoGroups).sql).not.toBe(sql);
  });

  it('全是 NULL → 退化成 IS NULL，绝不产出 IN ()', () => {
    const plan = planInValues(splitInInput('NULL,NULL'));
    expect(plan.ok).toBe(false);
    const g = buildInGroups('id', plan, false);
    expect(g.ok).toBe(false);
    // 调用方（appendFilterGroups 之前）由 plan.hasNull 走 IS NULL 分支
    const m = appendFilterGroups(null, [{ conditions: [{ column: 'id', operator: plan.hasNull ? 'isNull' : 'in' }] }]);
    expect(buildWhere(m).sql).toBe('`id` IS NULL');
    expect(buildWhere(m).sql).not.toContain('IN ()');
  });

  it('不属于（notIn）与 NULL 的组合语义正确', () => {
    const plan = planInValues(splitInInput('1,NULL'));
    const m = appendFilterGroups(null, buildInGroups('id', plan, true).groups);
    expect(buildWhere(m).sql).toBe('(`id` NOT IN (?) OR `id` IS NOT NULL)');
  });

  it('没选列 → 判不可用', () => {
    expect(buildInGroups('', planInValues(splitInInput('1')), false).ok).toBe(false);
  });
});

describe('appendFilterGroups：追加与 id 发放', () => {
  it('新 id 不与既有 id 撞车（撞车会让 React key 与删除逻辑同时失灵）', () => {
    const base = model(cond({ id: 'c1', column: 'a' }));
    const m = appendFilterGroups(base, [{ conditions: [{ column: 'b', operator: 'eq', value: '2' }] }]);
    const ids = m.groups.flatMap((g) => g.conditions.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
  });

  it('追加默认 AND（与「在已有条件上再加一条」的直觉一致）', () => {
    const base = model(cond({ id: 'c1', column: 'a', value: '1' }));
    const m = appendFilterGroups(base, [{ conditions: [{ column: 'b', operator: 'eq', value: '2' }] }]);
    expect(buildWhere(m).sql).toContain('AND');
  });

  it('空组被清掉（留着会让筛选弹窗出现「这个组还没有条件」）', () => {
    const base: FilterModel = { groups: [{ id: 'g1', logic: 'AND', conditions: [] }] };
    const m = appendFilterGroups(base, [{ conditions: [{ column: 'a', operator: 'eq', value: '1' }] }]);
    expect(m.groups.length).toBe(1);
  });
});

// ---------- 条件条：草稿 vs 已生效 ----------

describe('planFilterChips：草稿与已生效必须能区分', () => {
  const applied = model(
    cond({ id: 'c1', column: 'status', value: 'active' }),
    cond({ id: 'c2', column: 'age', operator: 'gt', value: '18' }),
  );

  it('草稿没打开 → 没有任何草稿标记', () => {
    const chips = planFilterChips({ applied, draft: null });
    expect(chips.every((c) => c.draft === null)).toBe(true);
    expect(chips[0].text).toBe('`status` = \'active\'');
  });

  it('草稿改了同一条的值 → 标记 changed 并同时给出草稿值', () => {
    const draft = model(
      cond({ id: 'c1', column: 'status', value: 'banned' }),
      cond({ id: 'c2', column: 'age', operator: 'gt', value: '18' }),
    );
    const chips = planFilterChips({ applied, draft });
    const c1 = chips.find((c) => c.id === 'c1');
    // 证伪点：若组件按「值等不等于」以外的方式判（或干脆不判草稿），draft 会是 null
    expect(c1?.draft?.kind).toBe('changed');
    expect(c1?.draft?.text).toBe("`status` = 'banned'");
    expect(c1?.text).toBe("`status` = 'active'");
    expect(c1?.draft?.text).not.toBe(c1?.text);
  });

  it('草稿与已生效完全一致 → 不给草稿标记（改回原值要能收敛）', () => {
    const chips = planFilterChips({ applied, draft: applied });
    expect(chips.every((c) => c.draft === null)).toBe(true);
  });

  it('草稿里新增的条件 → kind=new，且没有已生效值', () => {
    const draft = model(
      cond({ id: 'c1', column: 'status', value: 'active' }),
      cond({ id: 'c2', column: 'age', operator: 'gt', value: '18' }),
      cond({ id: 'c3', column: 'name', operator: 'contains', value: 'li' }),
    );
    const chips = planFilterChips({ applied, draft });
    const c3 = chips.find((c) => c.id === 'c3');
    expect(c3?.draft?.kind).toBe('new');
    expect(c3?.text).toBe(null);
    expect(c3?.draft?.text).toContain('`name`');
  });

  it('草稿里删掉的条件 → kind=removed（徽标仍在，显示「草稿中已移除」）', () => {
    const draft = model(cond({ id: 'c1', column: 'status', value: 'active' }));
    const chips = planFilterChips({ applied, draft });
    expect(chips.find((c) => c.id === 'c2')?.draft?.kind).toBe('removed');
  });

  it('未填完的已生效条件：text=null 且 incomplete=true（不进 WHERE，但删得掉）', () => {
    const chips = planFilterChips({ applied: model(cond({ id: 'c1', column: '', value: 'x' })) });
    expect(chips[0].text).toBe(null);
    expect(chips[0].incomplete).toBe(true);
  });

  it('loading 中 → pending=true（条件已写入真值，但数据还没回来）', () => {
    const chips = planFilterChips({ applied, loading: true });
    expect(chips.every((c) => c.pending)).toBe(true);
  });

  it('多值 IN 条件会被标出来（isList）', () => {
    const chips = planFilterChips({
      applied: model(cond({ id: 'c1', column: 'id', operator: 'in', values: ['1', '2'] })),
    });
    expect(chips[0].isList).toBe(true);
    expect(chips[0].text).toBe("`id` IN ('1', '2')");
  });
});

describe('planBarStatus：整条状态与计数口径', () => {
  const applied = model(cond({ id: 'c1', column: 'a', value: '1' }));

  it('已生效：报生效条数', () => {
    const s = planBarStatus({ applied });
    expect(s.tone).toBe('ok');
    expect(s.effective).toBe(1);
    expect(s.label).toContain('1 条条件已生效');
  });

  it('重查在途 → pending（不让「新条件 + 旧数据」看起来已生效）', () => {
    const s = planBarStatus({ applied, loading: true });
    expect(s.tone).toBe('pending');
    expect(s.label).toContain('正在应用筛选');
  });

  it('有未应用的草稿 → draft 并报条数', () => {
    const s = planBarStatus({ applied, draft: model(cond({ id: 'c1', column: 'a', value: '2' })) });
    expect(s.tone).toBe('draft');
    expect(s.draftDiff).toBe(1);
  });

  it('未填完的行不算生效（与 buildWhere 同口径）', () => {
    const s = planBarStatus({ applied: model(cond({ id: 'c1', column: '', value: 'x' })) });
    expect(s.effective).toBe(0);
    expect(s.total).toBe(1);
    expect(s.label).toBe('无筛选条件');
  });

  it('空筛选（emptyFilter）→ 0 条', () => {
    expect(planBarStatus({ applied: emptyFilter() }).effective).toBe(0);
  });
});
