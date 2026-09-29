/**
 * 分组行条纹（V19）—— 按某列的值把**连续相邻**行分组、交替着色。
 *
 * 场景：结果集按 `status` 排过序（或没排序但天然成块），同值区块一眼可辨，
 * 不用逐行比对 —— Navicat 没有这个，DBeaver 的分组条又太重。
 *
 * 🔴 判定基于「值变化的边界」而不是「值本身哈希」：
 *    相邻行值相同 → 同一组；值变化 → 翻转条纹。所以 1,1,2,2,3 → A,A,B,B,A
 *    （哈希法会得出 A,A,B,B,C，同值区块之间反而看不出区别）。
 *    这也意味着**条纹不表示"第几组"，只表示"与上一组不同"** —— 这正是要的效果。
 *
 * 🔴 性能红线（虚拟滚动）：
 *    这个函数会随每一行渲染被调用（10 万行的表滚动时每秒上千次），
 *    所以热路径上**禁止对象分配、正则、字符串拼接**。做法是：
 *      ① 数据/排序列变化时调一次 `buildGroupStripes(values)`，得到 1 字节/行的 Uint8Array；
 *      ② 渲染时只做 `stripeClassAt(stripes, rowIndex)` —— 一次下标读取 + 一次整数比较。
 *    这样滚动时零分配、无 GC 抖动。`groupStripeClass` 是给"一次性/小规模"场景
 *    的便利函数（或当你手上只有值数组时），**不要**把它放进每行的渲染循环。
 *
 * 集成示例（DataGrid 里：列值数组 → 建表 → 行渲染查表）：
 *   const stripes = useMemo(() => buildGroupStripes(statusValues, { enabled: stripeOn }), [statusValues, stripeOn]);
 *   <div className={`grid-row ${stripeClassAt(stripes, i)}`}>…</div>
 *   // 另需在 styles.css 里给 .grp-a / .grp-b 各一条 background（见文件末尾注释）
 */

export type GroupStripeClass = '' | 'grp-a' | 'grp-b';

export interface GroupStripeOptions {
  /** 关闭时整列不着色（返回空表，渲染侧查表一律得到 ''） */
  enabled?: boolean;
}

/** 条纹编码：Uint8Array 里的取值。0/1 交替，1 字节/行 */
export const STRIPE_A = 0;
export const STRIPE_B = 1;

/** 空白字符码（用于"不当数值处理"，避免 Number(' 12') === 12 这种误判） */
const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;

/**
 * 取值比较用的数值化：能转就转，转不了返回 NaN。
 *
 * 全程只用 charCodeAt / Number，**不产生任何字符串分配**（不 trim、不 slice）。
 */
function numericOf(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    if (v.length === 0) return NaN; // '' 绝不当数值：保住 NULL 与 '' 的区别
    // 首尾空白不当数值处理（Number(' 12') 也是 12，会让 ' 12' 与 '12' 混为一组）
    const first = v.charCodeAt(0);
    if (first === SPACE || first === TAB || first === LF || first === CR) return NaN;
    const last = v.charCodeAt(v.length - 1);
    if (last === SPACE || last === TAB || last === LF || last === CR) return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 两行的值是否属于同一组。
 *
 * 规则（写死在这里，别在调用方各写一套）：
 *  ① **NULL 与空串严格区分**（数据保真红线）：null/undefined 只在彼此之间同组，
 *     与 '' 永不同组 —— 混在一起会让"未填写"和"填了空字符串"看不出区别。
 *  ② 两个都能 Number() 且有限 → **按数值比**。R10 的副作用是 BIGINT 列回的是
 *     字符串，"10" 与 "10.0" / 7 与 "7" 必须算同值，否则同一笔订单会被切成两块。
 *  ③ 其余（含非数值串）→ 按字符串比（大小写敏感，与 SQL 默认排序一致）。
 */
export function sameGroupValue(a: unknown, b: unknown): boolean {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull && bNull;

  const na = numericOf(a);
  const nb = numericOf(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  // 一个能转一个不能转（如 7 与 'abc'）→ 退回严格相等，不假装相等
  return (a as unknown) === (b as unknown);
}

/**
 * 一次性预计算整列条纹表（数据变化 / 换排序列时调一次，不是每行调）。
 *
 * @returns Uint8Array，长度 = values.length（关闭时长度 0），取值 STRIPE_A / STRIPE_B
 *
 * 关闭开关时返回**长度 0** 而不是填满 sentinel：渲染侧查表越界自然得到 ''，
 * 比"存一个 255 表示不着色"更省内存（10 万行省 100KB），也少一次分支判断。
 */
export function buildGroupStripes(
  values: readonly unknown[],
  opts: GroupStripeOptions = {},
): Uint8Array {
  const n = values.length;
  if (opts.enabled === false || n === 0) return new Uint8Array(0);

  const out = new Uint8Array(n);
  // 第一行永远是 A：区块从 A 起算，1,1,2,2,3 → A,A,B,B,A
  let stripe = STRIPE_A;
  out[0] = stripe;
  for (let i = 1; i < n; i++) {
    if (!sameGroupValue(values[i - 1], values[i])) {
      stripe = stripe === STRIPE_A ? STRIPE_B : STRIPE_A;
    }
    out[i] = stripe;
  }
  return out;
}

/**
 * 渲染侧查表：O(1)，无分配、无正则、无字符串拼接。
 * 越界（含"未启用"的空表、负数下标）一律返回 ''（不着色）。
 */
export function stripeClassAt(stripes: Uint8Array, rowIndex: number): GroupStripeClass {
  if (rowIndex < 0 || rowIndex >= stripes.length) return '';
  return stripes[rowIndex] === STRIPE_B ? 'grp-b' : 'grp-a';
}

/** 手里只有值数组时的一次性扫描（O(rowIndex)，**不要**放进每行渲染循环） */
function scanStripeAt(values: readonly unknown[], rowIndex: number, enabled: boolean): GroupStripeClass {
  if (!enabled || rowIndex < 0 || rowIndex >= values.length) return '';
  let stripe: 0 | 1 = STRIPE_A;
  for (let i = 1; i <= rowIndex; i++) {
    if (!sameGroupValue(values[i - 1], values[i])) stripe = stripe === STRIPE_A ? STRIPE_B : STRIPE_A;
  }
  return stripe === STRIPE_B ? 'grp-b' : 'grp-a';
}

/**
 * 单条取类名。
 *
 * 第一个参数既可以是**预计算好的 Uint8Array**（推荐，O(1) 查表），
 * 也可以是原始值数组（内部扫描，仅用于一次性/小数据/单测）。
 * 之所以两种都收：集成方常常已经在行渲染里拿到了值数组，让它先建一次表
 * 再查是两步；而热路径只需要"传表进来"这一种写法。
 */
export function groupStripeClass(
  source: readonly unknown[] | Uint8Array,
  rowIndex: number,
  opts: GroupStripeOptions = {},
): GroupStripeClass {
  if (source instanceof Uint8Array) return stripeClassAt(source, rowIndex);
  return scanStripeAt(source, rowIndex, opts.enabled !== false);
}

/*
 * 样式（交给接线方加进 styles.css，本模块不改样式文件）：
 *   .grid-row.grp-a { background: var(--bg); }
 *   .grid-row.grp-b { background: var(--bg-alt); }
 */
