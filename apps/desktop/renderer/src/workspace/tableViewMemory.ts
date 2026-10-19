/**
 * T43：**表视图记忆**（筛选 + 排序，按 连接:库:表 为键）。
 *
 * ## 边界（先看这里，别把它当 Navicat 的 table profile）
 *
 *  - **只记「怎么看」，不记数据**。恢复视图不会恢复旧数据，也不缓存任何行 ——
 *    打开表仍然是实打实的一次查询。
 *  - 键必须带 `connId`：两个连接下有同名库同名表时，**不能**把生产的筛选
 *    带到测试库上（与 T02/T03 同源的红线）。
 *  - **列布局（宽度/显隐）不在本模块**：它已经由 `DataGrid` 的 `memoryKey`
 *    单独持久化（键同样是 conn:db:table）。这里只管筛选与排序，避免两处写同一份数据。
 *  - 恢复筛选必须**可见**：筛选条（T26）会列出已生效条件，用户能一眼看到
 *    「为什么只有 3 行」。静默套用筛选才是危险的做法。
 *
 * ## 容错
 *
 * localStorage 里的历史数据可能是旧版本、可能被手改坏。读取一律 try/catch，
 * 形状不对就当没有（**宁可少恢复一个视图，也不能让表打不开**）。
 */

import type { FilterModel } from '@dbstudio/core-filter';
import type { SortSpec } from '@dbstudio/core-grid-view';

export const TABLE_VIEW_KEY = 'dbstudio.tableView.v1';

export interface TableView {
  sorts: SortSpec[];
  filter: FilterModel | null;
  /** 记录时间（仅用于排查「怎么突然有筛选」这类问题） */
  savedAt: number;
}

type Store = Record<string, TableView>;

/** 记忆键：连接 + 库 + 表，三段缺一不可 */
export function viewKey(connId: string, database: string, tableName: string): string {
  return `${connId}\u0000${database}\u0000${tableName}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore(): Store {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(TABLE_VIEW_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const view = validateView(v);
      if (view) out[k] = view;
    }
    return out;
  } catch {
    return {};
  }
}

function validateView(v: unknown): TableView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const sorts = Array.isArray(o.sorts)
    ? o.sorts.filter(
        (s): s is SortSpec =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as SortSpec).column === 'string' &&
          ((s as SortSpec).direction === 'ASC' || (s as SortSpec).direction === 'DESC'),
      )
    : [];
  const filter =
    o.filter && typeof o.filter === 'object' && Array.isArray((o.filter as FilterModel).groups)
      ? (o.filter as FilterModel)
      : null;
  const savedAt = typeof o.savedAt === 'number' ? o.savedAt : 0;
  // 两者都空 = 等价于「没有记忆」，不必占一条
  if (sorts.length === 0 && !filter) return null;
  return { sorts, filter, savedAt };
}

/** 读一张表的视图记忆；没有/损坏一律 null */
export function loadTableView(connId: string, database: string, tableName: string): TableView | null {
  return readStore()[viewKey(connId, database, tableName)] ?? null;
}

/**
 * 写一张表的视图记忆。
 *
 * 🔴 空视图（无排序无筛选）**删除**该键，而不是存一条空记录：
 * 否则用户「清空筛选」后下次打开又会被一条空记录覆盖成"没有视图"，
 * 行为上看不出差别，但库里会堆一堆无意义条目。
 */
export function saveTableView(
  connId: string,
  database: string,
  tableName: string,
  view: { sorts: SortSpec[]; filter: FilterModel | null },
): void {
  const s = storage();
  if (!s) return;
  const key = viewKey(connId, database, tableName);
  const store = readStore();
  const next = validateView({ ...view, savedAt: Date.now() });
  if (!next) delete store[key];
  else store[key] = next;
  try {
    s.setItem(TABLE_VIEW_KEY, JSON.stringify(store));
  } catch {
    // 配额满/被禁用：视图记忆是增强能力，写不进去不影响主流程
  }
}

export function clearTableView(connId: string, database: string, tableName: string): void {
  const s = storage();
  if (!s) return;
  const store = readStore();
  delete store[viewKey(connId, database, tableName)];
  try {
    s.setItem(TABLE_VIEW_KEY, JSON.stringify(store));
  } catch {
    /* 同上 */
  }
}
