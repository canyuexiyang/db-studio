/**
 * 标签顺序 / 固定 / 标题区分的**纯逻辑**（P1-7 / P2-18f）。
 *
 * 抽出来的理由与 tabContextMenuModel 同：拖拽排序的边界（越界、原地、拖到固定块里）
 * 和「同名表怎么区分」在 UI 里很难造，也看不出对错；纯函数能被单测在错误输入上钉住。
 */

export interface TabLike {
  id: string;
  /** P1-7：固定标签（不被「关闭其他 / 关闭右侧」波及，且始终排在左侧） */
  pinned?: boolean;
  title?: string;
  kind?: 'table' | 'query';
  connId?: string | null;
  database?: string | null;
  tableName?: string;
}

/**
 * 拖拽排序：把 from 位置的项移到 to 位置。
 *
 * 越界 / 原地 → 原样返回（**必须返回同一个引用**的语义由调用方判断：这里返回
 * 浅拷贝也无害，但保持「无变化即原数组」能让调用方用 `===` 短路一次渲染）。
 */
export function moveTabOrder<T extends TabLike>(tabs: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) return tabs;
  if (from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 固定的标签数（= 固定块长度，块内保持相对顺序） */
export function pinnedCount<T extends TabLike>(tabs: readonly T[]): number {
  let n = 0;
  for (const t of tabs) if (t.pinned) n++;
  return n;
}

/**
 * 把某个标签设为固定后，它应该落在哪个下标。
 *
 * 口径与 VSCode 一致：固定标签集中在最左侧，新固定的排到**固定块末尾**。
 * 这样连按几次固定，顺序与用户的操作顺序一致，可预期。
 */
export function pinnedInsertIndex<T extends TabLike>(tabs: readonly T[], id: string): number {
  const others = tabs.filter((t) => t.id !== id);
  return pinnedCount(others);
}

/**
 * 应用一次「固定/取消固定」，返回新顺序。
 *
 * - 固定：打到固定块末尾（见 pinnedInsertIndex）
 * - 取消固定：留在原位，只是去掉标记（用户不想让标签跳走）
 */
export function applyPin<T extends TabLike>(tabs: readonly T[], id: string, pinned: boolean): T[] {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return tabs.slice();
  const updated = tabs.map((t) => (t.id === id ? { ...t, pinned } : t));
  if (!pinned) return updated;
  const without = updated.filter((t) => t.id !== id);
  const tab = updated[idx];
  const at = pinnedCount(without);
  const next = without.slice();
  next.splice(at, 0, tab);
  return next;
}

/**
 * 标签显示标题（P2-18f 同名表可区分）。
 *
 * 现状：两个连接上都有 `users` 时，两个标签都叫 `users`，只能靠 tooltip 分辨
 * —— 而 tooltip 要 hover，用户在做选择的那一刻看不到。
 *
 * 规则：
 *  - 表名在工作区内唯一 → 原样（不制造噪音）
 *  - 同名表跨连接 → `users · 本地测试`（追加连接名）
 *  - 同名表在同一连接的**不同库** → `users · order_db`（追加库名，连接名帮不上忙）
 *  - 连接名缺失 → 退化为连接 id 前 6 位（宁可知其然，也不要两个一模一样的标题）
 */
export function tabDisplayTitle(
  tab: TabLike,
  all: readonly TabLike[],
  connLabels: Record<string, string> = {},
): string {
  const base = tab.title ?? '';
  if (tab.kind !== 'table' || !tab.tableName) return base;
  const sameName = all.filter((t) => t.kind === 'table' && t.tableName === tab.tableName);
  if (sameName.length < 2) return base;
  const sameConn = sameName.filter((t) => (t.connId ?? '') === (tab.connId ?? ''));
  if (sameConn.length > 1) return tab.database ? `${base} · ${tab.database}` : base;
  const label = connLabels[tab.connId ?? ''] ?? (tab.connId ? String(tab.connId).slice(0, 6) : '');
  return label ? `${base} · ${label}` : base;
}
