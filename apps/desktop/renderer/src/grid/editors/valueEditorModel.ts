/**
 * 值编辑的**纯逻辑**（T25 / T36 / T37）—— 零 React、零 DOM、零 IO，单测直接覆盖。
 *
 * 项目偏好（AGENTS.md §二）：核心逻辑下沉到可离线单测的形态，React 组件只负责
 * 把结果拼进 DOM。本文件就是那层"结果"：
 *
 *  | 任务 | 本模块产出 |
 *  |---|---|
 *  | T25 | 四个值编辑动作的**可用性 + 禁用原因**（含 INSERT / UPDATE 语义差） |
 *  | T36 | ENUM/SET 的**合法值解析**与**取值校验**（空串 ≠ NULL） |
 *  | T37 | 日期时间文本的**结构化分解与重组**（微秒/时区原样保留） |
 *
 * 🔴 三条保真红线在这一层的具体含义：
 *   1. NULL 与空串是**两个不同的值** —— `''` 走字面量通道，`null` 走 NULL 通道，
 *      二者在 `CellValueEdit` 里是不同的字面量，绝不互相冒充；
 *   2. 日期时间**永不进 `Date`** —— 全程字符串切分与拼接（T37 的核心）；
 *   3. 不静默把用户文本变成 SQL —— 只有**显式动作**（使用默认值 / fx 表达式模式）
 *      才会产出嵌入 SQL 的值。
 */

// ---------- 列类型判定 ----------

/** 参与"能不能写空串"判定的类型族 */
export type ColumnKind =
  | 'enum'
  | 'set'
  | 'datetime'
  | 'date'
  | 'time'
  | 'year'
  | 'numeric'
  | 'json'
  | 'binary'
  | 'text'
  /** 拿不到任何类型信息（查询结果列只有 typeCode 时常见） */
  | 'unknown';

export interface ColumnTypeInfo {
  kind: ColumnKind;
  /** 归一化的类型基名（小写、去掉 `(…)` 与 unsigned/zerofill 后缀） */
  base: string;
  /** ENUM/SET 的**数据库定义值**（DDL 顺序，空串可以是其中之一）；其余类型恒 null */
  enumValues: readonly string[] | null;
}

const NUMERIC_BASES = [
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
  'decimal', 'numeric', 'float', 'double', 'real', 'bit',
];
const TEXT_BASES = [
  'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext',
];
const BINARY_BASES = [
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob',
  'geometry', 'point', 'linestring', 'polygon',
];

/**
 * 取类型基名：`varchar(255)` → `varchar`；`int unsigned` → `int`；
 * `enum('a','b')` → `enum`（括号内容**不**进基名，另有 parseEnumValues 处理）。
 */
export function columnTypeBase(dataType: string | null | undefined): string {
  const s = (dataType ?? '').trim().toLowerCase();
  if (s === '') return '';
  const noParen = s.replace(/\([\s\S]*\)/g, '').trim();
  return noParen.replace(/\s+(unsigned|zerofill|signed)\b/g, '').trim();
}

/**
 * T36：从 `information_schema.COLUMNS.COLUMN_TYPE` 原文里解析 ENUM/SET 的合法值。
 *
 * 例：`enum('a','b','c')` → `['a','b','c']`；`enum('','x')` → `['', 'x']`（空串是合法成员）。
 *
 * 🔴 元数据证据（改需求前先查，别凭空造）：
 *   - `core-schema-cache` 的 `ColumnMeta` **没有**专门的枚举值字段；
 *   - 但 `ColumnMeta.dataType` 存的是 **COLUMN_TYPE 原文**（见
 *     `packages/core-driver-mysql/src/index.ts` 里 `dataType: String(r[3])`，
 *     其 SELECT 列表第 4 项就是 `COLUMN_TYPE`），所以 ENUM/SET 的合法值
 *     **确实随元数据一起到达渲染层**，只是藏在类型串里。
 *   本函数把它解析出来 —— 这是**数据库定义值**，不是猜的。
 *
 * @returns 合法值数组；**非 enum/set、值列表为空、或引号未闭合 → null**（宁可不给下拉，也不给错下拉）
 */
export function parseEnumValues(dataType: string | null | undefined): string[] | null {
  const s = (dataType ?? '').trim();
  const m = /^(enum|set)\s*\(([\s\S]*)\)$/i.exec(s);
  if (!m) return null;
  const items = splitEnumItems(m[2] ?? '');
  if (items === null || items.length === 0) return null;
  const out: string[] = [];
  for (const raw of items) {
    const v = unquoteEnumItem(raw);
    if (v === null) return null; // 任一项解析不了 = 整份定义不可信
    out.push(v);
  }
  return out;
}

/** 按**顶层**逗号切分（引号内的逗号不算） */
function splitEnumItems(inner: string): string[] | null {
  const out: string[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (quote) {
      if (ch === '\\' && next !== undefined) {
        buf += ch + next;
        i++;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          buf += ch + next;
          i++;
          continue;
        }
        quote = null;
        buf += ch;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (quote !== null) return null; // 引号未闭合
  out.push(buf);
  return out;
}

/**
 * 去引号：`'a'` → `a`；`''` → 空串；`'a''b'` → `a'b`；`'a\'b'` → `a'b`。
 * @returns 非法（无引号 / 未闭合 / 引号外还有字符）→ null
 */
export function unquoteEnumItem(token: string): string | null {
  const t = token.trim();
  if (t.length < 2) return null;
  const q = t[0];
  if (q !== "'" && q !== '"') return null;
  let out = '';
  let i = 1;
  let closed = false;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '\\' && i + 1 < t.length) {
      out += t[i + 1];
      i += 2;
      continue;
    }
    if (ch === q) {
      if (t[i + 1] === q) {
        out += q;
        i += 2;
        continue;
      }
      closed = true;
      i += 1;
      break;
    }
    out += ch;
    i += 1;
  }
  if (!closed) return null;
  if (t.slice(i).trim() !== '') return null;
  return out;
}

/** 列的最小元数据（GridColumn 的子集，便于单测不牵扯 React） */
export interface ColumnTypeLike {
  dataType: string;
  /** T36：宿主若直接给了枚举定义值则优先用它；null/undefined/空数组 = 退回解析 dataType */
  enumValues?: readonly string[] | null;
}

/**
 * 判定列类型族 + 取出 ENUM/SET 定义值。
 *
 * 取值优先级：`enumValues`（宿主显式透传）> 解析 `dataType` 串。
 * 宿主没给 `enumValues` 时**不是错误** —— datatype 串里通常就有。
 */
export function resolveColumnTypeInfo(col: ColumnTypeLike): ColumnTypeInfo {
  const base = columnTypeBase(col.dataType);
  if (base === 'enum' || base === 'set') {
    const explicit = col.enumValues && col.enumValues.length > 0 ? col.enumValues : null;
    const parsed = explicit ?? parseEnumValues(col.dataType);
    return { kind: base === 'enum' ? 'enum' : 'set', base, enumValues: parsed };
  }
  if (base === 'datetime' || base === 'timestamp') return { kind: 'datetime', base, enumValues: null };
  if (base === 'date') return { kind: 'date', base, enumValues: null };
  if (base === 'time') return { kind: 'time', base, enumValues: null };
  if (base === 'year') return { kind: 'year', base, enumValues: null };
  if (NUMERIC_BASES.includes(base)) return { kind: 'numeric', base, enumValues: null };
  if (base === 'json') return { kind: 'json', base, enumValues: null };
  if (BINARY_BASES.includes(base)) return { kind: 'binary', base, enumValues: null };
  if (TEXT_BASES.includes(base)) return { kind: 'text', base, enumValues: null };
  return { kind: 'unknown', base, enumValues: null };
}

/**
 * T36：校验一个待写入值是否是**本列定义值之一**。
 *
 * 三条判定（顺序即优先级）：
 *  ① 拿不到定义值 → 拒绝（宁可不给下拉，也不给错下拉 —— 红线 6）；
 *  ② null → 由调用方另行判定是否允许（列可空性），这里返回 ok:false 且不冒充；
 *  ③ 不在定义值里 → 拒绝，并把合法值列出来给用户。
 */
export function validateEnumValue(
  values: readonly string[] | null,
  v: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!values || values.length === 0) {
    return { ok: false, reason: '拿不到本列的 ENUM 定义值（schema 元数据不足），无法确认取值合法' };
  }
  if (v === null) {
    return { ok: false, reason: '空的枚举取值：NULL 只能由「设为 NULL」显式产生' };
  }
  if (values.includes(v)) return { ok: true };
  const shown = values.map((x) => (x === '' ? "''" : x)).join('、');
  return { ok: false, reason: `「${v === '' ? "''" : v}」不是本列定义的枚举值（合法值：${shown}）` };
}

// ---------- T25：四个值编辑动作 ----------

/** 单元格值编辑动作 */
export type CellValueAction = 'edit' | 'empty-string' | 'null' | 'default' | 'discard';

/** 菜单项可用性 + 禁用原因（红线 1：不给"能点但没反应"的项） */
export interface MenuItemState {
  enabled: boolean;
  /** enabled 时为空串；禁用时为**具体**中文原因 */
  reason: string;
}

/**
 * 判定四个动作所需的最小上下文。
 *
 * 🔴 `isInsertRow` 是 T25 的关键：它决定「使用默认值」走 INSERT 省略列
 *    还是 `UPDATE … SET col = DEFAULT`（见 resolveValueEdit）。
 */
export interface CellEditContext {
  /** 表可编辑（有主键/唯一键定位）—— 判定权在 core-mutation.isEditable，不自判 */
  editable: boolean;
  /** 连接级只读 */
  readOnly: boolean;
  /** 行号 ≥ 已加载行数 = 待 INSERT 的新行 */
  isInsertRow: boolean;
  /** 列名；'' = 右键落在行号列（没有作用对象） */
  column: string;
  /** MySQL 类型原文（如 `enum('a','b')`） */
  dataType: string;
  /** 本格是否有待提交改动 */
  cellDirty: boolean;
  /** ENUM/SET 定义值（已由 resolveColumnTypeInfo 解析好） */
  enumValues?: readonly string[] | null;
  /**
   * 列是否可空。**undefined = 未知** —— 渲染层拿不到 nullable 元数据时
   * 不因此禁用「设为 NULL」，由数据库在执行时决定（预览里能看到真实 SQL）。
   */
  nullable?: boolean | null;
  /**
   * 数据库默认值（COLUMN_DEFAULT 原文）。**undefined = 未知**；
   * `null` = 已确认没有 DEFAULT 子句 → 「使用默认值」禁用并给原因。
   */
  defaultValue?: string | null;
}

const OK: MenuItemState = { enabled: true, reason: '' };

/**
 * 「编辑值…」：进单元格的**类型专用编辑器**（ENUM 下拉 / 日期时间 / 多行文本）。
 *
 * 与双击就地编辑的区别：双击进的是单元格内的单行输入框；「编辑值…」开一个
 * 独立浮层，适合长文本换行编辑与枚举/日期这类需要控件的取值。
 */
export function canEditValue(ctx: CellEditContext): MenuItemState {
  if (ctx.column === '') return { enabled: false, reason: '行号列没有可编辑的值' };
  if (ctx.readOnly) {
    return { enabled: false, reason: '该连接已标记为只读：写语句会被主进程 AST 守卫拦截' };
  }
  if (!ctx.editable) {
    return { enabled: false, reason: '该表无主键/唯一键，无法安全定位行，网格为只读' };
  }
  return OK;
}

/** 空串 `''` 在该列是否是一个**合法可写**的取值 */
export function acceptsEmptyString(ctx: CellEditContext): MenuItemState {
  const gate = canEditValue(ctx);
  if (!gate.enabled) return gate;
  const kind = ctx.enumValues && ctx.enumValues.length > 0 ? 'enum' : resolveColumnTypeInfo(ctx).kind;
  switch (kind) {
    case 'enum':
    case 'set': {
      const values = ctx.enumValues ?? null;
      if (!values || values.length === 0) {
        return { enabled: false, reason: '拿不到本列的 ENUM/SET 定义值，无法确认空串是否合法' };
      }
      return values.includes('')
        ? OK
        : { enabled: false, reason: `列类型 ${ctx.dataType} 的定义值里没有空串，写入会被拒绝` };
    }
    case 'numeric':
      return {
        enabled: false,
        reason: `列类型 ${ctx.dataType} 不接受空串：严格模式报错，非严格模式会静默转成 0`,
      };
    case 'json':
      return { enabled: false, reason: '列类型 json 不接受空串（不是合法的 JSON 字面量）' };
    case 'datetime':
    case 'date':
    case 'time':
    case 'year':
      return {
        enabled: false,
        reason: `列类型 ${ctx.dataType} 不接受空串：会被转成零值日期或直接报错`,
      };
    default:
      return OK;
  }
}

/**
 * T36：该列有没有**专用取值控件**。
 *
 * - `enum` → ENUM 下拉（只允许数据库定义值）；
 * - `datetime` / `date` / `time` → 日期时间辅助控件；
 * - `set` → **不给**专用控件：SET 是**多选集合**，且成员里可以含逗号，
 *   朴素 `split(',')` 会切错（`'a,b'` 既可能是两个成员也可能是一个）。
 *   需求原文「SET 多选语义另行评估」，故本轮走通用文本编辑 —— 宁可不给控件，
 *   也不给一个会把值写坏的控件（红线 6）。
 */
export function hasSpecializedEditor(info: ColumnTypeInfo): boolean {
  return info.kind === 'enum' || info.kind === 'datetime' || info.kind === 'date' || info.kind === 'time';
}

/**
 * 「使用默认值」：UPDATE 语境产出 `SET col = DEFAULT`（**不是**字符串 `'DEFAULT'`）。
 *
 * 是否可用的口径：拿不到 `defaultValue` 元数据(= unknown) 时**不禁用** ——
 * 列有没有 DEFAULT 由数据库在执行时决定，且保存预演会把真实 SQL 展示给用户；
 * 只有**已确认**没有 DEFAULT 子句（defaultValue === null）才禁用。
 */
export function canUseDefault(ctx: CellEditContext): MenuItemState {
  const gate = canEditValue(ctx);
  if (!gate.enabled) return gate;
  if (ctx.defaultValue === null) {
    return {
      enabled: false,
      reason: '本列没有数据库默认值（COLUMN_DEFAULT 为空）：DEFAULT 会落到隐式默认值或报错',
    };
  }
  return OK;
}

/** 「撤销本格」：只能撤销**待提交的改动**；原始 NULL 不是待提交改动 */
export function canDiscardCell(ctx: CellEditContext): MenuItemState {
  return ctx.cellDirty ? OK : { enabled: false, reason: '本格没有待提交的改动' };
}

export function menuStateOf(action: CellValueAction, ctx: CellEditContext): MenuItemState {
  switch (action) {
    case 'edit':
      return canEditValue(ctx);
    case 'empty-string':
      return acceptsEmptyString(ctx);
    case 'null':
      return canEditValue(ctx); // 是否已是原始 NULL 由宿主的 canSetNull 判定
    case 'default':
      return canUseDefault(ctx);
    case 'discard':
      return canDiscardCell(ctx);
  }
}

/** 网格可表达的值形态（与 core-mutation 的 EditValueKind 对齐） */
export type GridValueKind = 'literal' | 'sql-expr';

/** UPDATE 语境「使用默认值」产出的 SQL 关键字原文 */
export const DEFAULT_KEYWORD = 'DEFAULT';

/**
 * T25：把「使用默认值」翻译成 core-mutation 能落地的编辑片段。
 *
 * 目前**唯一**能从渲染层一路带到 SQL 的"原样嵌入"通道是 `valueKind:'sql-expr'`
 * （`GridDataSource.setDirty` 只透传 literal / sql-expr 两种形态，
 * 见 `useGridData.ts` 与 `App.tsx` 的 `onCellEdited`）。
 * 好在这正是我们要的语义：`buildUpdate` 对 sql-expr **原样嵌入**，
 * 于是产出 `SET \`col\` = DEFAULT` —— MySQL 的"取该列默认值"，
 * 与写成字符串 `'DEFAULT'` 是完全不同的两件事（后者只是四个字母的文本）。
 *
 * ⚠️ 这不是"把用户文本变成 SQL"：值是**本函数产出的关键字**，不是用户输入。
 */
export function defaultKeywordEdit(): { value: string; valueKind: GridValueKind } {
  return { value: DEFAULT_KEYWORD, valueKind: 'sql-expr' };
}

/** 一次值编辑的落地计划（纯数据，组件据此调用既有回调） */
export type ValueEditPlan =
  /** 打开类型专用编辑器 */
  | { kind: 'open-editor' }
  /** 写入一个字面量值（null = 显式 NULL，'' = 空串） */
  | { kind: 'commit'; value: string | null; valueKind: GridValueKind }
  /** 清除本格待提交改动（回到原始值） */
  | { kind: 'discard' };

/**
 * T25：把「动作 + 上下文」解析成落地计划。
 *
 * 🔴 **INSERT 与 UPDATE 是两条不同的路，别混为一谈**：
 *   - 待插入的新行（`isInsertRow`）：「使用默认值」= **把该列从 INSERT 列表里去掉**，
 *     落库时由数据库填 DEFAULT。走清除脏标记 —— 因为新行没有"原值"可回退，
 *     撤掉待提交值就等价于"不指定这一列"。
 *     ⚠️ 不能写成 `VALUES (NULL)`：显式 NULL 会**覆盖** DEFAULT，两者结果不同。
 *   - 已有行：「使用默认值」= `UPDATE … SET col = DEFAULT`（MySQL 关键字赋值）。
 *
 * @returns 计划；动作在当前上下文不可用 → null（调用方应已禁用，这里是第二道防线）
 */
export function resolveValueEdit(action: CellValueAction, ctx: CellEditContext): ValueEditPlan | null {
  if (!menuStateOf(action, ctx).enabled) return null;
  switch (action) {
    case 'edit':
      return { kind: 'open-editor' };
    case 'empty-string':
      return { kind: 'commit', value: '', valueKind: 'literal' };
    case 'null':
      return { kind: 'commit', value: null, valueKind: 'literal' };
    case 'default':
      return ctx.isInsertRow
        ? // INSERT 省略列：清掉待提交值，让这一列不出现在 INSERT 列表里
          { kind: 'discard' }
        : // UPDATE DEFAULT：原样嵌入关键字
          { kind: 'commit', ...defaultKeywordEdit() };
    case 'discard':
      return { kind: 'discard' };
  }
}

/**
 * 「使用默认值」的**语境说明** —— 直接进菜单项 title，把 INSERT / UPDATE 的
 * 区别摆在用户面前（需求原文要求"先明确…区别"）。
 */
export function describeDefaultAction(ctx: CellEditContext): string {
  const col = ctx.column || '本列';
  return ctx.isInsertRow
    ? `新行：从 INSERT 列表里去掉「${col}」，由数据库填默认值（不是写 NULL —— 显式 NULL 会覆盖 DEFAULT）`
    : `已有行：UPDATE … SET \`${col}\` = DEFAULT（MySQL 关键字，不是字符串 'DEFAULT'）`;
}

// ---------- T36：ENUM 下拉选项 ----------

/** ENUM 下拉的一个选项 */
export interface EnumOption {
  /** 下标编码的 option value（见 enumOptionValue —— 空串与 NULL 必须可区分） */
  value: string;
  /** 实际写入值；null = 设为 NULL */
  actual: string | null;
  label: string;
  /** 该选项不可选时的原因（如「列为 NOT NULL」） */
  disabledReason: string;
}

/** NULL 选项的下标编码前缀 —— 与真实枚举值按下标区分，绝不靠字符串猜 */
export const NULL_OPTION = 'x:null';

/** 第 i 个定义值的 option value 编码 */
export function enumOptionValue(index: number): string {
  return `v:${index}`;
}

/** 解析 option value → 实际写入值；无法识别 → undefined */
export function enumOptionActual(
  value: string,
  values: readonly string[],
): { actual: string | null } | undefined {
  if (value === NULL_OPTION) return { actual: null };
  const m = /^v:(\d+)$/.exec(value);
  if (!m) return undefined;
  const i = Number(m[1]);
  return i >= 0 && i < values.length ? { actual: values[i] ?? null } : undefined;
}

/**
 * 构造 ENUM 下拉选项：**只有数据库定义值**。
 *
 * 顺序：定义值（DDL 顺序）→ 末尾追加 NULL（若列可空或可空性未知）。
 *
 * 🔴 NULL 与空串在这里是**两个独立的选项**：空串是定义值之一（`v:i`），
 *    NULL 是「根本不取值」（`x:null`）—— 编码不同、写入结果不同。
 *    把它们合并成一个"空"选项，正是本次要修的缺陷。
 */
export function buildEnumOptions(
  values: readonly string[] | null,
  nullable: boolean | null | undefined,
): EnumOption[] {
  if (!values || values.length === 0) return [];
  const out: EnumOption[] = values.map((v, i) => ({
    value: enumOptionValue(i),
    actual: v,
    label: enumValueLabel(v),
    disabledReason: '',
  }));
  // 可空性未知（undefined/null）时不拦：数据库会在执行时判定，预览里看得到真实 SQL
  const nullAllowed = nullable !== false;
  out.push({
    value: NULL_OPTION,
    actual: null,
    label: 'NULL',
    disabledReason: nullAllowed ? '' : '该列为 NOT NULL，写入 NULL 会被数据库拒绝',
  });
  return out;
}

/** 枚举值的展示文案：空串渲染成 `''` 而不是一片空白（与 formatChangeValue 同口径） */
export function enumValueLabel(v: string): string {
  return v === '' ? "''" : v;
}

// ---------- T37：日期时间文本 ↔ 控件 ----------

/** MySQL 小数秒最大位数（DATETIME(6)） */
export const MAX_FRACTION_DIGITS = 6;

/**
 * 日期时间文本的**结构化分解**。
 *
 * 🔴 五个片段合起来必须**逐字**等于原始文本（compose 不重排、不补零、不换算时区），
 *    这样"文本 → 控件 → 回写文本"的往返才是恒等的 —— 微秒与时区后缀因此
 *    绝不会被 Date 转换吞掉（T37 的验收口径）。
 */
export interface DateTimeParts {
  /** 归一化后的原文（去首尾空白）；`parsed === false` 时回写它 */
  raw: string;
  /** 是否识别为可编辑的日期/时间结构（false = 控件停用，只能改文本） */
  parsed: boolean;
  /** `YYYY-MM-DD`；文本里没有日期段时 null */
  dateText: string | null;
  /** 日期与时间之间的分隔符原文（`' '` 或 `'T'`）；无时间时 null */
  sepText: string | null;
  /** `HH:MM[:SS]`；无时间段时 null */
  timeText: string | null;
  /** 小数秒原文（含前导点，如 `.123456`）；无则 null */
  fracText: string | null;
  /** 时区后缀原文（如 `Z` / `+08:00` / ` +05:30`）；无则 null */
  zoneText: string | null;
}

const DATE_AT = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_AT = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const FRAC_AT = /^\.(\d{1,6})/;
/** 只认这两种后缀；其它一律按"无法解析"处理（保留原文，不猜） */
const ZONE_ONLY = /^\s*(?:Z|z|[+-]\d{2}:?\d{2})$/;

function unparsed(raw: string): DateTimeParts {
  return { raw, parsed: false, dateText: null, sepText: null, timeText: null, fracText: null, zoneText: null };
}

/**
 * 解析一段日期时间文本。
 *
 * 支持 MySQL 字面量（`YYYY-MM-DD HH:MM:SS[.f]`）与 ISO（`…T…`）；
 * 小数秒最多 6 位（DATETIME(6)）。
 *
 * 🔴 **永不返回被 `Date` 规整过的值**：拿不准就 `parsed:false` + 原文保留，
 *    由调用方显示"控件停用"的原因 —— 静默改写日期比不提供控件更糟。
 *
 * 判定为不可解析的典型：
 *  - 空串 / 纯空白；
 *  - 小数秒超过 6 位；
 *  - 尾部有无法识别的内容（非 Z / ±HH:MM）；
 *  - 零值日期 `0000-00-00` 或不存在的日期 `2024-02-30`。
 */
export function parseDateTimeText(raw: string): DateTimeParts {
  const s = raw.trim();
  if (s === '') return unparsed(s);

  let i = 0;
  let dateText: string | null = null;
  const dm = DATE_AT.exec(s);
  if (dm) {
    dateText = dm[0] ?? null;
    i = (dm[0] ?? '').length;
  }

  let sepText: string | null = null;
  if (dateText !== null && (s[i] === ' ' || s[i] === 'T')) {
    sepText = s[i] ?? null;
    i += 1;
  }

  let timeText: string | null = null;
  const tm = TIME_AT.exec(s.slice(i));
  if (tm) {
    timeText = tm[0] ?? null;
    i += (tm[0] ?? '').length;
  }

  if (dateText === null && timeText === null) return unparsed(s);

  let fracText: string | null = null;
  if (s[i] === '.') {
    const fm = FRAC_AT.exec(s.slice(i));
    if (!fm) return unparsed(s); // 点了却没有数字，或超过 6 位
    fracText = fm[0] ?? null;
    i += (fm[0] ?? '').length;
  }

  let zoneText: string | null = null;
  const rest = s.slice(i);
  if (rest !== '') {
    if (!ZONE_ONLY.test(rest)) return unparsed(s);
    zoneText = rest;
  }

  // 结构对了但日历/时钟非法 → 同样按"不可解析"处理
  if (dateText !== null && !isCalendarDate(dateText)) return unparsed(s);
  if (timeText !== null && !isClockTime(timeText)) return unparsed(s);

  return { raw: s, parsed: true, dateText, sepText, timeText, fracText, zoneText };
}

/** 把五个片段按原文拼回去（不补零、不换算时区） */
export function composeDateTimeText(p: DateTimeParts): string {
  if (!p.parsed) return p.raw;
  return `${p.dateText ?? ''}${p.sepText ?? ''}${p.timeText ?? ''}${p.fracText ?? ''}${p.zoneText ?? ''}`;
}

/**
 * T37 的保真契约：文本 → 控件结构 → 回写文本，**一字不差**。
 *
 * `2024-01-02 03:04:05.123456` 往返后仍是同一个串 —— 微秒没被吞，
 * 也没有被 `Date` 按本地时区挪动。
 */
export function roundTripDateTimeText(raw: string): string {
  return composeDateTimeText(parseDateTimeText(raw));
}

/** 日期段是否是一个真实存在的日历日期（`0000-00-00` / `2024-02-30` → false） */
export function isCalendarDate(dateText: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  return true;
}

function daysInMonth(y: number, mo: number): number {
  if (mo === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * 时间段是否合法。
 *
 * ⚠️ 小时上限取 **838** 而不是 23：MySQL `TIME` 的取值范围是
 *    `-838:59:59 ~ 838:59:59`（时长语义，不是时刻），按 23 卡会误杀合法值。
 *    分/秒仍按 60 卡，所以 `99:99` 这类脏数据照样被判为不可解析。
 */
export function isClockTime(timeText: string): boolean {
  // MySQL TIME 可达 838 小时（时长语义），首位允许多位数字（838:59:59 合法）
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(timeText);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  return h <= 838 && mi <= 59 && s <= 59;
}

/** `<input type="date">` 的 value；无法表达（无日期段 / 零值）→ 空串 */
export function dateInputValueOf(p: DateTimeParts): string {
  if (!p.parsed || p.dateText === null) return '';
  return isCalendarDate(p.dateText) ? p.dateText : '';
}

/**
 * `<input type="time">` 的 value（`HH:MM:SS`）。
 *
 * 🔴 **故意不含小数秒**：time 输入的 value 最多到秒，塞进 `.123456` 会被
 *    浏览器判定非法而清空。微秒由 `fracText` 单独保管并在回写时**原样拼回**，
 *    所以"用控件改时间"不会丢微秒（单测有对照）。
 *
 * 小时 > 23（TIME 时长语义）时控件表达不了 → 返回空串，只能改文本。
 */
export function timeInputValueOf(p: DateTimeParts): string {
  if (!p.parsed || p.timeText === null) return '';
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(p.timeText);
  if (!m) return '';
  const h = Number(m[1]);
  if (h > 23) return '';
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}:${m[3] ?? '00'}`;
}

/** `YYYY-MM-DD` 归一化（输入控件的 value 已是该格式）；不是则 null */
export function normalizeDateInput(v: string): string | null {
  const s = v.trim();
  return isCalendarDate(s) ? s : null;
}

/** `HH:MM[:SS]` 归一化；不是则 null */
export function normalizeTimeInput(v: string): string | null {
  const s = v.trim();
  if (s === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 838 || mi > 59 || sec > 59) return null;
  return m[3] === undefined ? `${m[1]}:${m[2]}` : `${m[1]}:${m[2]}:${m[3]}`;
}

/**
 * 用日期控件的新值改写文本的**日期段**，其余片段原样保留。
 *
 * 不可解析（含零值日期、非法后缀）时**原样返回** —— 绝不猜着改。
 */
export function withDatePart(raw: string, dateText: string): string {
  const p = parseDateTimeText(raw);
  const d = normalizeDateInput(dateText);
  if (!p.parsed || d === null) return p.raw;
  return composeDateTimeText({
    ...p,
    dateText: d,
    sepText: p.sepText ?? (p.timeText !== null ? ' ' : null),
  });
}

/** 用时间控件的新值改写文本的**时间段**，其余片段（含微秒、时区）原样保留 */
export function withTimePart(raw: string, timeText: string): string {
  const p = parseDateTimeText(raw);
  const t = normalizeTimeInput(timeText);
  if (!p.parsed || t === null) return p.raw;
  return composeDateTimeText({
    ...p,
    timeText: t,
    sepText: p.sepText ?? (p.dateText !== null ? ' ' : null),
  });
}

/**
 * 保真提示文案（null = 无需提示）。
 *
 * 三种要说的话：
 *  ① 有小数秒 → 告诉用户微秒被原样保留、不参与控件（T37 验收口径）；
 *  ② 有时区后缀 → 明确"不换算成本地时区"；
 *  ③ 不可解析 → 说明控件为什么停用，且文本可直接改。
 */
export function dateTimeFidelityNote(p: DateTimeParts): string | null {
  if (!p.parsed) {
    return p.raw === ''
      ? '当前值无法用日期控件表达（为空或格式不识别），请直接编辑文本'
      : `当前值含控件无法表达的内容（原文：${p.raw}），已按原样保留，请直接编辑文本`;
  }
  if (p.fracText !== null) {
    return `小数秒 ${p.fracText} 原样保留：日期/时间控件只改前面的部分，不参与微秒`;
  }
  if (p.zoneText !== null) {
    return `时区后缀 ${p.zoneText.trim()} 原样保留：不做本地时区换算`;
  }
  return null;
}
