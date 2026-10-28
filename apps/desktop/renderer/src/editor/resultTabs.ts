/**
 * T42：查询结果标签的**集合操作语义**（纯逻辑，不依赖 React / DOM）。
 *
 * 为什么抽出来：固定/重命名/关闭其他这套语义里，真正会写错的是
 * **「新查询不覆盖固定结果」** —— 它在 UI 上的表现是「跑着跑着，我固定的那个
 * 结果不见了」，手点要跑二十次查询才复现得出来。下沉成纯函数后一次单测钉死。
 *
 * 三条语义（改之前先看）：
 *  1. **固定槽位永不被新结果占用**：容量不够时先淘汰最老的**未固定**结果；
 *     全部固定时宁可让总数超过上限，也不丢任何一个固定结果。
 *  2. **「关闭其他」关不掉固定的**：固定 = 显式表达「我要留着它」，
 *     一个顺手的「关闭其他」把它清掉等于背叛用户意图。
 *  3. **重命名是可选覆盖**：空串 = 回到自动标题（行数 / 执行计划），不是把标签清空。
 */

/** 结果标签的元数据（渲染层 ResultTab 只需 extends 它） */
export interface ResultTabMeta {
  id: string;
  pinned: boolean;
  /** 用户自定义名；null = 用自动标题 */
  name: string | null;
  /** 产生时间（epoch ms）—— 来源可追溯的一部分 */
  createdAt: number;
}

/** 结果标签上限（既有行为是 slice(0, 20)，这里显式命名以便单测） */
export const MAX_RESULT_TABS = 20;

/**
 * 追加新结果。
 *
 * 顺序：新结果在前（既有行为），但**淘汰顺序与展示顺序无关** —— 被淘汰的永远是
 * 最老的未固定项，而不是数组尾部的那一个。
 *
 * @returns 合并后的标签数组（保持「新 → 旧」的相对顺序，固定项不重排）
 */
export function mergeResults<T extends ResultTabMeta>(
  existing: readonly T[],
  incoming: readonly T[],
  max: number = MAX_RESULT_TABS,
): T[] {
  const all = [...incoming, ...existing];
  const pinned = all.filter((t) => t.pinned);
  const unpinned = all.filter((t) => !t.pinned);
  // 固定项占掉多少，未固定项就只剩多少位置；
  // 至少留 1 个位置给最新结果 —— 否则「固定满 20 个后新查询什么都不显示」更难懂
  const room = Math.max(1, max - pinned.length);
  const keep = new Set<string>([...pinned, ...unpinned.slice(0, room)].map((t) => t.id));
  return all.filter((t) => keep.has(t.id));
}

/** 关闭其他：保留目标 + **所有固定项** */
export function closeOthers<T extends ResultTabMeta>(tabs: readonly T[], keepId: string): T[] {
  return tabs.filter((t) => t.id === keepId || t.pinned);
}

/** 切换固定 */
export function togglePin<T extends ResultTabMeta>(tabs: readonly T[], id: string): T[] {
  return tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
}

/** 重命名；空串 / 纯空白 = 清除自定义名（回到自动标题） */
export function renameTab<T extends ResultTabMeta>(tabs: readonly T[], id: string, name: string | null): T[] {
  const next = name === null ? null : name.trim();
  const value = next === null || next === '' ? null : next;
  return tabs.map((t) => (t.id === id ? { ...t, name: value } : t));
}

/**
 * 展示顺序：固定项在前（组内保持原相对顺序），未固定项随后。
 *
 * 「固定」不只是不被淘汰，还要**不被挤到看不见的地方** —— 结果标签行是横向滚动的。
 */
export function displayOrder<T extends ResultTabMeta>(tabs: readonly T[]): T[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

// ---------- 展示文案 ----------

export interface ResultTabFacts {
  rowCount: number;
  /** EXPLAIN 结果走另一套标题 */
  explain: boolean;
  error: string | null;
  /**
   * 0.7.1：预先算好的结果标题（`describeRunResult().title`）。
   *
   * 为什么不让这里自己按 rowCount 拼：标签标题是**第三个**消费点，一旦它自己拼，
   * UPDATE 就会在标签上显示「0 行」而消息行显示「已修改 2 行」—— 同一份结果两套说法。
   */
  text?: string | null;
}

/**
 * 标签标题优先级：自定义名 > 执行计划 > 执行失败 > 结果文案 > 行数。
 *
 * 最后的「N 行」只是兜底（旧调用方没传 text 时）；0.7.1 起正常执行一定带 text。
 */
export function resultTabTitle(meta: ResultTabMeta, facts: ResultTabFacts): string {
  if (meta.name !== null) return meta.name;
  if (facts.explain) return '执行计划';
  if (facts.error !== null) return '执行失败';
  if (facts.text) return facts.text;
  return `${facts.rowCount.toLocaleString('en-US')} 行`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** HH:MM:SS（本地时区；结果标签的时间只用于「这是刚才那次吗」的辨识） */
export function clockOf(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export interface ResultOrigin {
  /** 产生该结果的语句原文 */
  sql: string;
  connectionName: string;
  database: string | null;
  createdAt: number;
  elapsedMs: number;
  rowCount: number;
}

/**
 * 来源摘要（tooltip / 消息行）：连接 · 库 · 时间 · 行数 · 耗时。
 *
 * 🔴 只放**已经确定的事实**，拿不到的一律不显示（不是填「未知」）——
 *    「连接: 未命名」这种填充比留空更容易误导。
 */
export function describeResultOrigin(o: ResultOrigin): string {
  const parts: string[] = [o.connectionName];
  if (o.database !== null && o.database !== '') parts.push(o.database);
  parts.push(clockOf(o.createdAt));
  parts.push(`${o.rowCount.toLocaleString('en-US')} 行`);
  if (o.elapsedMs > 0) parts.push(`${o.elapsedMs}ms`);
  return parts.join(' · ');
}

/** 「复制 SQL」用的是**语句原文**，不含 EXPLAIN 包装以外的任何加工 */
export function copyableSql(sql: string): string {
  return sql;
}
