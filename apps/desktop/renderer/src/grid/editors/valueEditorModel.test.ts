/**
 * T25 / T36 / T37 纯逻辑单测。
 *
 * 断言纪律（项目红线 2：断言必须有证伪能力）：
 *  - 每一条「会发生 X」都配一条「不会发生 X」的**对照**；
 *  - 空串与 NULL 的用例刻意成对出现 —— 只写其中一条的话，把实现换成
 *    「一律当 NULL / 一律当空串」也照样是绿的（即断言无证伪能力）。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYWORD,
  NULL_OPTION,
  acceptsEmptyString,
  buildEnumOptions,
  canDiscardCell,
  canEditValue,
  canUseDefault,
  columnTypeBase,
  composeDateTimeText,
  dateInputValueOf,
  validateEnumValue,
  dateTimeFidelityNote,
  describeDefaultAction,
  enumOptionActual,
  enumOptionValue,
  isCalendarDate,
  isClockTime,
  menuStateOf,
  parseDateTimeText,
  parseEnumValues,
  resolveColumnTypeInfo,
  resolveValueEdit,
  roundTripDateTimeText,
  timeInputValueOf,
  withDatePart,
  withTimePart,
  type CellEditContext,
  type ColumnTypeInfo,
} from './valueEditorModel';

// ---------- 夹具 ----------

/** 可编辑的普通文本列上下文 */
function textCtx(over: Partial<CellEditContext> = {}): CellEditContext {
  return {
    editable: true,
    readOnly: false,
    isInsertRow: false,
    column: 'note',
    dataType: 'text',
    cellDirty: false,
    ...over,
  };
}

function infoOf(dataType: string): ColumnTypeInfo {
  return resolveColumnTypeInfo({ dataType });
}

// ============================================================================
// T25-1：「设为空串」产出 '' 而不是 NULL；与「设为 NULL」互为对照
// ============================================================================

describe('T25 设为空串 ≠ 设为 NULL（互为对照）', () => {
  it('「设为空串」产出空串字面量 —— **不是** null', () => {
    const plan = resolveValueEdit('empty-string', textCtx());
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error('fixture broken');
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    // 🔴 证伪点：若实现把空串当成 NULL（返回 null），这条会红
    expect(plan.value).not.toBeNull();
    expect(plan.value).toBe('');
    expect(plan.valueKind).toBe('literal');
  });

  it('「设为 NULL」产出 null —— **不是**空串（对照）', () => {
    const plan = resolveValueEdit('null', textCtx());
    if (plan === null) throw new Error('fixture broken');
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    // 🔴 证伪点：若实现把 NULL 当成空串（返回 ''），这条会红
    expect(plan.value).toBeNull();
    expect(plan.value).not.toBe('');
    expect(plan.valueKind).toBe('literal');
  });

  it('两条路径的 value 严格不等（null 与 "" 不可互换）', () => {
    const a = resolveValueEdit('empty-string', textCtx());
    const b = resolveValueEdit('null', textCtx());
    if (a === null || b === null) throw new Error('fixture broken');
    if (a.kind !== 'commit' || b.kind !== 'commit') throw new Error('fixture broken');
    expect(a.value).not.toBe(b.value);
    // 空串是 falsy，若用 !! 归一就会把两者混为一谈 —— 这里断言的是**身份**而非真假
    expect(Object.is(a.value, b.value)).toBe(false);
  });

  it('「编辑值…」只开编辑器，不落任何值', () => {
    expect(resolveValueEdit('edit', textCtx())).toEqual({ kind: 'open-editor' });
  });
});

// ============================================================================
// T25-2：「使用默认值」在 UPDATE 语境产出 DEFAULT 关键字
// ============================================================================

describe('T25 使用默认值：UPDATE → 关键字，INSERT → 省略列', () => {
  it('UPDATE 语境产出 `DEFAULT` **关键字**（valueKind = sql-expr，不是字符串字面量）', () => {
    const plan = resolveValueEdit('default', textCtx({ isInsertRow: false }));
    if (plan === null) throw new Error('fixture broken');
    expect(plan.kind).toBe('commit');
    if (plan.kind !== 'commit') return;
    expect(plan.value).toBe(DEFAULT_KEYWORD);
    // 🔴 证伪点：若 valueKind 写成 literal，MySQL 会收到字符串 'DEFAULT'
    expect(plan.valueKind).toBe('sql-expr');
  });

  it('INSERT 语境（新行）走「去掉该列」= 清除待提交值（对照）', () => {
    const plan = resolveValueEdit('default', textCtx({ isInsertRow: true }));
    expect(plan).toEqual({ kind: 'discard' });
  });

  it('两种语境的落地计划**不相等**（避免"不管什么行都写 DEFAULT"）', () => {
    const upd = resolveValueEdit('default', textCtx({ isInsertRow: false }));
    const ins = resolveValueEdit('default', textCtx({ isInsertRow: true }));
    expect(upd).not.toEqual(ins);
  });

  it('文案里明说 INSERT 与 UPDATE 的区别（需求原文要求"先明确区别"）', () => {
    const ins = describeDefaultAction(textCtx({ isInsertRow: true, column: 'status' }));
    const upd = describeDefaultAction(textCtx({ isInsertRow: false, column: 'status' }));
    expect(ins).toContain('INSERT');
    expect(ins).toContain('不是写 NULL');
    expect(upd).toContain('DEFAULT');
    expect(upd).toContain('`status`');
    expect(ins).not.toBe(upd);
  });
});

// ============================================================================
// T25-3：禁用时给**列类型 / 只读**原因
// ============================================================================

describe('T25 禁用原因（列类型 / 只读，不是空话）', () => {
  it('行号列右键：四个动作全禁用，原因点明「行号列」', () => {
    const ctx = textCtx({ column: '' });
    for (const a of ['edit', 'empty-string', 'null', 'default'] as const) {
      const s = menuStateOf(a, ctx);
      expect(s.enabled).toBe(false);
      expect(s.reason).toContain('行号列');
    }
  });

  it('连接只读：原因是「只读」而不是泛泛的「不可用」', () => {
    const s = canEditValue(textCtx({ readOnly: true }));
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('只读');
  });

  it('表无主键/唯一键：原因是「无主键/唯一键」', () => {
    const s = canEditValue(textCtx({ editable: false }));
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('无主键/唯一键');
  });

  it('数值列「设为空串」禁用，原因**带列类型**', () => {
    const s = acceptsEmptyString(textCtx({ dataType: 'decimal(12,2)' }));
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('decimal(12,2)');
  });

  it('日期列「设为空串」禁用，原因带列类型（对照：text 列可设空串）', () => {
    expect(acceptsEmptyString(textCtx({ dataType: 'datetime(6)' })).enabled).toBe(false);
    expect(acceptsEmptyString(textCtx({ dataType: 'datetime(6)' })).reason).toContain('datetime(6)');
    expect(acceptsEmptyString(textCtx({ dataType: 'text' })).enabled).toBe(true);
  });

  it('ENUM 列「设为空串」：定义值里有空串才可用（空串 ≠ NULL 的证据）', () => {
    const withEmpty = textCtx({
      dataType: "enum('','paid')",
      enumValues: ['', 'paid'],
    });
    const withoutEmpty = textCtx({
      dataType: "enum('new','paid')",
      enumValues: ['new', 'paid'],
    });
    expect(acceptsEmptyString(withEmpty).enabled).toBe(true);
    expect(acceptsEmptyString(withoutEmpty).enabled).toBe(false);
    expect(acceptsEmptyString(withoutEmpty).reason).toContain('没有空串');
  });

  it('撤销本格：本格没改动 → 禁用并给原因；有改动 → 可用', () => {
    expect(canDiscardCell(textCtx({ cellDirty: false }))).toEqual({
      enabled: false,
      reason: '本格没有待提交的改动',
    });
    expect(canDiscardCell(textCtx({ cellDirty: true }))).toEqual({ enabled: true, reason: '' });
  });

  it('已知「本列没有默认值」→「使用默认值」禁用并给原因', () => {
    const s = canUseDefault(textCtx({ defaultValue: null }));
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('COLUMN_DEFAULT');
  });

  it('宿主未提供默认值元数据（unknown）→ 不禁用（由数据库执行时判定）', () => {
    expect(canUseDefault(textCtx({ defaultValue: undefined })).enabled).toBe(true);
  });
});

// ============================================================================
// T25-4：不可用时不产出计划（第二道防线）
// ============================================================================

describe('T25 resolveValueEdit 在禁用语境下返回 null', () => {
  it('只读连接：任何写值动作都不产出计划', () => {
    const ctx = textCtx({ readOnly: true });
    expect(resolveValueEdit('empty-string', ctx)).toBeNull();
    expect(resolveValueEdit('null', ctx)).toBeNull();
    expect(resolveValueEdit('default', ctx)).toBeNull();
  });
});

// ============================================================================
// T36：ENUM —— 只接受定义值；空串与 NULL 分开
// ============================================================================

describe('T36 parseEnumValues（只认数据库定义值）', () => {
  it("enum('a','b') → ['a','b']", () => {
    expect(parseEnumValues("enum('a','b')")).toEqual(['a', 'b']);
  });

  it("enum('','x') → ['', 'x'] —— **空串是一个合法定义成员**", () => {
    const v = parseEnumValues("enum('','x')");
    expect(v).toEqual(['', 'x']);
    // 🔴 证伪点：若解析把空串丢掉（长度变 1），这条会红
    expect(v).toHaveLength(2);
    expect(v![0]).toBe('');
  });

  it("enum('a''b') → [\"a'b\"] —— 双写引号转义", () => {
    expect(parseEnumValues("enum('a''b')")).toEqual(["a'b"]);
  });

  it('set 同样解析（顺序保留，供后续多选评估）', () => {
    expect(parseEnumValues("set('r','w','x')")).toEqual(['r', 'w', 'x']);
  });

  it('引号未闭合 → null（不猜）', () => {
    expect(parseEnumValues("enum('a'")).toBeNull();
  });

  it('非 enum/set 类型 → null（varchar / int 都不是枚举）', () => {
    expect(parseEnumValues('varchar(255)')).toBeNull();
    expect(parseEnumValues('int(11) unsigned')).toBeNull();
    expect(parseEnumValues('')).toBeNull();
  });
});

describe('T36 validateEnumValue（不合法枚举不写入）', () => {
  const VALUES = ['new', 'paid'];

  it('定义值 → 通过', () => {
    expect(validateEnumValue(VALUES, 'new').ok).toBe(true);
    expect(validateEnumValue(VALUES, 'paid').ok).toBe(true);
  });

  it('非定义值 → 拒绝，且原因里列出合法值', () => {
    const r = validateEnumValue(VALUES, 'shipped');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('new');
    expect(r.reason).toContain('paid');
  });

  it('空串不在定义值里 → 拒绝（空串不是万能通行证）', () => {
    expect(validateEnumValue(VALUES, '').ok).toBe(false);
  });

  it('空串**在**定义值里 → 通过（空串与 NULL 分开的核心证据）', () => {
    expect(validateEnumValue(['', 'paid'], '').ok).toBe(true);
    // 对照：NULL 走的是另一条路径，不被当成空串
    expect(validateEnumValue(['', 'paid'], null).ok).toBe(false);
  });

  it('NULL → 拒绝（只能由「设为 NULL」显式产生，避免与空串混淆）', () => {
    const r = validateEnumValue(VALUES, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('设为 NULL');
  });

  it('拿不到定义值 → 拒绝（红线 6：元数据不足时不假造下拉）', () => {
    const r = validateEnumValue(null, 'new');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('拿不到');
  });
});

describe('T36 buildEnumOptions（空串与 NULL 是两个独立选项）', () => {
  it('定义值 + NULL 选项；空串的 label 渲染成 \'\' 而不是空白', () => {
    const opts = buildEnumOptions(['', 'paid'], true);
    expect(opts).toHaveLength(3);
    expect(opts[0]!.label).toBe("''");
    expect(opts[0]!.actual).toBe('');
    expect(opts[1]!.label).toBe('paid');
    const nullOpt = opts.find((o) => o.actual === null);
    expect(nullOpt).toBeDefined();
    expect(nullOpt!.label).toBe('NULL');
    expect(nullOpt!.value).toBe(NULL_OPTION);
  });

  it('列为 NOT NULL → NULL 选项存在但 disabled + 给原因', () => {
    const opts = buildEnumOptions(['new'], false);
    const nullOpt = opts.find((o) => o.actual === null)!;
    expect(nullOpt.disabledReason).toContain('NOT NULL');
  });

  it('拿不到定义值 → 没有选项（调用方据此显示原因，不画空下拉）', () => {
    expect(buildEnumOptions(null, true)).toEqual([]);
    expect(buildEnumOptions([], true)).toEqual([]);
  });

  it('option value 编码与解码互为逆运算（含空串）', () => {
    const values = ['', 'paid'];
    expect(enumOptionActual(enumOptionValue(0), values)).toEqual({ actual: '' });
    expect(enumOptionActual(enumOptionValue(1), values)).toEqual({ actual: 'paid' });
    expect(enumOptionActual(NULL_OPTION, values)).toEqual({ actual: null });
    expect(enumOptionActual('bogus', values)).toBeUndefined();
    expect(enumOptionActual(enumOptionValue(9), values)).toBeUndefined();
  });
});

describe('T36 resolveColumnTypeInfo', () => {
  it('enum / set / datetime / date / time / 数值 / json / binary / text 分类正确', () => {
    expect(infoOf("enum('a')").kind).toBe('enum');
    expect(infoOf("set('a')").kind).toBe('set');
    expect(infoOf('datetime(6)').kind).toBe('datetime');
    expect(infoOf('timestamp').kind).toBe('datetime');
    expect(infoOf('date').kind).toBe('date');
    expect(infoOf('time').kind).toBe('time');
    expect(infoOf('year').kind).toBe('year');
    expect(infoOf('bigint unsigned').kind).toBe('numeric');
    expect(infoOf('json').kind).toBe('json');
    expect(infoOf('blob').kind).toBe('binary');
    expect(infoOf('varchar(64)').kind).toBe('text');
    expect(infoOf('').kind).toBe('unknown');
  });

  it('enum 定义值可从 COLUMN_TYPE 原文解析；解析不到则为 null', () => {
    expect(infoOf("enum('a','b')").enumValues).toEqual(['a', 'b']);
    expect(infoOf('enum').enumValues).toBeNull();
  });

  it('宿主显式给的 enumValues 优先于 dataType 解析结果', () => {
    const info = resolveColumnTypeInfo({ dataType: "enum('a')", enumValues: ['x', 'y'] });
    expect(info.enumValues).toEqual(['x', 'y']);
  });

  it('enumValues 为空数组时退回解析 dataType（不当成"已知为空"）', () => {
    const info = resolveColumnTypeInfo({ dataType: "enum('a')", enumValues: [] });
    expect(info.enumValues).toEqual(['a']);
  });
});

describe('columnTypeBase', () => {
  it('去掉括号与 unsigned/zerofill 后缀', () => {
    expect(columnTypeBase('varchar(255)')).toBe('varchar');
    expect(columnTypeBase('int(11) unsigned')).toBe('int');
    expect(columnTypeBase('  BIGINT UNSIGNED ')).toBe('bigint');
    expect(columnTypeBase('enum')).toBe('enum');
    expect(columnTypeBase('')).toBe('');
  });
});

// ============================================================================
// T37：日期时间往返保真
// ============================================================================

describe('T37 日期文本 → 控件 → 回写文本（往返一字不差）', () => {
  /**
   * 🔴 保真红线：这组样本里含 DATETIME(6) 微秒与 ISO 时区后缀。
   *    只要实现里出现 `new Date(...)` 再 `toISOString()` 之类的转换，
   *    微秒就会被吞（毫秒化）或整体被挪到 UTC —— 往返断言立刻变红。
   */
  const samples = [
    '2024-01-02 03:04:05.123456',
    '2024-01-02 03:04:05.1',
    '2024-01-02 03:04:05',
    '2024-01-02 03:04',
    '2024-01-02',
    '03:04:05',
    '03:04',
    '2024-01-02T03:04:05Z',
    '2024-01-02T03:04:05.123456Z',
    '2024-01-02 03:04:05.123456+08:00',
    '2024-01-02 03:04:05.123456 +08:00',
  ];

  for (const s of samples) {
    it(`往返保真：${s}`, () => {
      expect(roundTripDateTimeText(s)).toBe(s);
      expect(parseDateTimeText(s).parsed).toBe(true);
    });
  }

  it('对照：改日期后微秒仍原样保留', () => {
    const raw = '2024-01-02 03:04:05.123456';
    expect(withDatePart(raw, '2025-06-07')).toBe('2025-06-07 03:04:05.123456');
  });

  it('对照：改时间后微秒仍原样保留', () => {
    const raw = '2024-01-02 03:04:05.123456';
    expect(withTimePart(raw, '09:08:07')).toBe('2024-01-02 09:08:07.123456');
  });

  it('对照：带时区后缀时改日期**不做时区换算**（后缀原样保留）', () => {
    const raw = '2024-01-02T03:04:05.123456Z';
    expect(withDatePart(raw, '2025-06-07')).toBe('2025-06-07T03:04:05.123456Z');
    expect(withTimePart(raw, '09:08:07')).toBe('2024-01-02T09:08:07.123456Z');
  });

  it('单调性：时间控件的值不含微秒，但仍与原始微秒共存', () => {
    const p = parseDateTimeText('2024-01-02 03:04:05.123456');
    expect(timeInputValueOf(p)).toBe('03:04:05');
    expect(dateInputValueOf(p)).toBe('2024-01-02');
    expect(p.fracText).toBe('.123456');
  });
});

describe('T37 不可解析/非法值 → 明确回退（不静默改写）', () => {
  const bad = [
    '',
    '   ',
    '0000-00-00 00:00:00',
    '2024-02-30 00:00:00',
    '2024-13-01',
    '2024-01-02 03:04:05.1234567',
    '2024-01-02 03:04:05 UTC',
    'yesterday',
    '2024/01/02 03:04:05',
  ];

  for (const s of bad) {
    it(`无法用控件表达：${JSON.stringify(s)} → 原样保留`, () => {
      const p = parseDateTimeText(s);
      expect(p.parsed).toBe(false);
      expect(roundTripDateTimeText(s)).toBe(s.trim());
    });
  }

  it('回退时提示文案里有原文（让用户知道发生了什么）', () => {
    const p = parseDateTimeText('2024-01-02 03:04:05 UTC');
    const note = dateTimeFidelityNote(p);
    expect(note).not.toBeNull();
    expect(note).toContain('2024-01-02 03:04:05 UTC');
  });

  it('改日期/改时间在不可解析时**不落值**（原样返回）', () => {
    expect(withDatePart('2024-01-02 03:04:05 UTC', '2025-01-01')).toBe('2024-01-02 03:04:05 UTC');
    expect(withTimePart('tomorrow', '09:00:00')).toBe('tomorrow');
  });
});

describe('T37 保真提示文案', () => {
  it('有小数秒 → 提示原样保留微秒', () => {
    const note = dateTimeFidelityNote(parseDateTimeText('2024-01-02 03:04:05.123456'));
    expect(note).toContain('.123456');
  });

  it('有时区后缀 → 提示不做本地时区换算', () => {
    const note = dateTimeFidelityNote(parseDateTimeText('2024-01-02T03:04:05Z'));
    expect(note).toContain('Z');
    expect(note).toContain('不');
  });

  it('普通值（无微秒无时区）→ 不提示', () => {
    expect(dateTimeFidelityNote(parseDateTimeText('2024-01-02 03:04:05'))).toBeNull();
  });
});

describe('T37 片段分解与重组', () => {
  it('日期 + 空格 + 时间 + 微秒 各自独立', () => {
    const p = parseDateTimeText('2024-01-02 03:04:05.123456');
    expect(p.dateText).toBe('2024-01-02');
    expect(p.sepText).toBe(' ');
    expect(p.timeText).toBe('03:04:05');
    expect(p.fracText).toBe('.123456');
    expect(p.zoneText).toBeNull();
  });

  it('ISO：分隔符是 T，时区后缀单独保留', () => {
    const p = parseDateTimeText('2024-01-02T03:04:05.123456Z');
    expect(p.sepText).toBe('T');
    expect(p.zoneText).toBe('Z');
  });

  it('只有日期时没有时间段；只有时间时没有日期段', () => {
    expect(parseDateTimeText('2024-01-02').timeText).toBeNull();
    expect(parseDateTimeText('03:04:05').dateText).toBeNull();
  });

  it('compose 在 parsed=false 时返回原文（不补零、不重排）', () => {
    const p = parseDateTimeText('0000-00-00 00:00:00');
    expect(p.parsed).toBe(false);
    expect(composeDateTimeText(p)).toBe('0000-00-00 00:00:00');
  });

  it('文本去首尾空白后往返恒等', () => {
    expect(roundTripDateTimeText('  2024-01-02 03:04:05.123456  ')).toBe('2024-01-02 03:04:05.123456');
  });
});

describe('T37 日历/时钟合法性', () => {
  it('闰年 2 月 29 日合法；平年非法', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
  });

  it('月份/日期边界', () => {
    expect(isCalendarDate('2024-00-01')).toBe(false);
    expect(isCalendarDate('2024-13-01')).toBe(false);
    expect(isCalendarDate('2024-04-31')).toBe(false);
    expect(isCalendarDate('2024-04-30')).toBe(true);
  });

  it('TIME 允许 838:59:59（MySQL 时长语义），但拒绝 99 分', () => {
    expect(isClockTime('838:59:59')).toBe(true);
    expect(isClockTime('99:99')).toBe(false);
  });
});
