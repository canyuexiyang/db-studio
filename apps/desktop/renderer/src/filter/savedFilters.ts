/**
 * 已保存的筛选方案（V18）—— 按表持久化的命名方案（保存/重命名/删除/搜索/应用）。
 *
 * 定位：用户在筛选器里调了七八个条件、想"下次还这么查"，就需要把它存下来。
 * 方案按 **表** 分组（tableKey 形如 `connId::database::table`），而不是全局一锅粥 ——
 * 换一张表看到的方案列表不该是别的表的。
 *
 * 三条设计取舍：
 *  1. **存储可注入**（`createSavedFilterStore(storage?)`）：默认 `globalThis.localStorage`，
 *     单测注入内存实现。仓库铁律是"核心逻辑不依赖 Electron/浏览器"，所以本模块
 *     在 node 下也能跑（storage 取不到时退化成"只存内存"而不是崩）。
 *  2. **读写全部 try/catch 静默降级**（与 prefs/preferences.ts 同口径）：方案是锦上添花，
 *     隐私模式、配额满、JSON 被手改坏，都不值得打断用户正在做的查询。
 *  3. **读的时候逐条降级**：一条脏数据只丢那一条，不整份作废 —— 用户攒的另外 49 条
 *     不能被一条畸形记录带走。
 *
 * 集成示例（在筛选弹窗里加一排"方案"操作，3 行核心代码）：
 *   const store = useMemo(() => createSavedFilterStore(), []);                 // 一个表一个
 *   const key = savedFilterKey(connId, database, table);
 *   const list = listSavedFilters(store, key);                                 // 已按 updatedAt 倒序
 *   <button onClick={() => {                                                   // 保存
 *     const r = saveFilter(store, key, nameInput, model);
 *     if (!r.ok) toast(r.reason); else setList(listSavedFilters(store, key));
 *   }}>保存当前筛选</button>
 *   // 应用：不需要额外 API，取到条目后直接 setModel(hit.model) 即可。
 */

import { isFilterEmpty, type FilterModel } from '@dbstudio/core-filter';

/** localStorage 键（v1：结构变化时换 v2 并写迁移，旧键直接作废） */
export const SAVED_FILTERS_STORAGE_KEY = 'dbstudio.saved-filters.v1';

/** 单表方案上限：超出后拒绝新增（调用方负责把 reason 提示给用户） */
export const SAVED_FILTERS_MAX_PER_TABLE = 50;

/** 名称长度上限（trim 之后计） */
export const SAVED_FILTER_NAME_MAX = 60;

export interface SavedFilter {
  id: string;
  name: string;
  model: FilterModel;
  createdAt: number;
  updatedAt: number;
}

/** 全量存储结构：`{ [tableKey]: SavedFilter[] }` */
export type SavedFilterMap = Record<string, SavedFilter[]>;

/** localStorage 的最小子集（只要读/写两个方法，便于单测注入内存实现） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 方案仓库：把"读全量 / 写全量"收口成一个对象。
 *
 * 为什么不直接把 storage 传进每个函数？因为多入口（筛选弹窗、⌘K 命令、右键菜单）
 * 同时改同一份数据时，**存储才是唯一权威**；统一走 store 才能保证每次写入前都重读
 * 一遍最新值，避免 A 入口的过期快照覆盖掉 B 入口刚存的东西。
 */
export interface SavedFilterStore {
  /** 读全量（脏数据已逐条降级）；读失败返回 {} */
  getAll(): SavedFilterMap;
  /** 写全量；写失败静默 */
  putAll(map: SavedFilterMap): void;
}

/** 写操作结果：失败时带一句**中文**原因，调用方直接 toast */
export type SaveResult = { ok: true; filter: SavedFilter } | { ok: false; reason: string };

// ---------- 存储层 ----------

/** 默认存储：渲染进程用 localStorage；没有（单测 node 环境）则退化成不落盘 */
function defaultStorage(): StorageLike | undefined {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined;
  } catch {
    // 某些环境访问 localStorage 属性本身就会抛（安全策略）—— 静默当没有
    return undefined;
  }
}

/**
 * 逐条校验一条记录。任一项缺失/类型不对就返回 null（丢弃这一条）。
 *
 * model 只做"形状"校验（有 groups 数组）而不深挖每个条件 —— 条件模型演进后
 * 旧方案也应该能读出来交给筛选器，筛选器自己对不完整条件有静默跳过的容错。
 */
function normalize(raw: unknown): SavedFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // id 是删除/重命名的定位键，没有它这条记录不可操作，只能丢
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  // name 是唯一给人看的东西，空名字无法在下拉里展示，丢
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return null;
  const model = o.model as { groups?: unknown } | null;
  if (!model || typeof model !== 'object' || !Array.isArray(model.groups)) return null;

  // 时间戳缺失补 0：排序时排最后，比丢掉整条好
  const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0;
  const updatedAt = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : createdAt;

  return { id: o.id, name: o.name, model: model as FilterModel, createdAt, updatedAt };
}

/** 读全量：JSON 坏 → {}；某表的值不是数组 → 跳过该表；条目坏 → 只丢那一条 */
function readAll(s: StorageLike | undefined): SavedFilterMap {
  if (!s) return {};
  try {
    const raw = s.getItem(SAVED_FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: SavedFilterMap = {};
    for (const [tableKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const list: SavedFilter[] = [];
      for (const item of value) {
        const one = normalize(item);
        if (one) list.push(one);
      }
      if (list.length > 0) out[tableKey] = list;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写全量：配额满 / 隐私模式写不进去就算了，本次改动仅在内存生效 */
function writeAll(s: StorageLike | undefined, map: SavedFilterMap): void {
  if (!s) return;
  try {
    s.setItem(SAVED_FILTERS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 静默降级：方案没存下来，用户当场还能用，不值得弹错误打断他
  }
}

/** 建一个仓库（storage 省略时用 localStorage） */
export function createSavedFilterStore(storage?: StorageLike): SavedFilterStore {
  const s = storage ?? defaultStorage();
  return {
    getAll: () => readAll(s),
    putAll: (map) => writeAll(s, map),
  };
}

/**
 * 构造 tableKey。分隔符用 `::` 而不是 `:` —— 库名/表名里出现冒号虽罕见但合法，
 * 用双冒号能让 key 在日志与手动排查时一眼切得开。
 */
export function savedFilterKey(connId: string, database: string, table: string): string {
  return `${connId}::${database}::${table}`;
}

// ---------- id ----------

let seq = 0;

/**
 * 生成 id：时间戳 + 模块内自增。
 *
 * 不用 crypto.randomUUID —— 一是单测环境未必有，二是 id 只需在同表内唯一，
 * 顺序可读（sf + base36 时间）在排查脏数据时更好认。
 */
function newId(): string {
  seq += 1;
  return `sf${Date.now().toString(36)}${seq.toString(36)}`;
}

// ---------- 读 ----------

/** 排序：updatedAt 倒序（最近改过的在最上）。同值时保持存储顺序 —— V8 的 sort 稳定 */
function byUpdatedAtDesc(list: readonly SavedFilter[]): SavedFilter[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 列出某张表的全部方案（按 updatedAt 倒序） */
export function listSavedFilters(store: SavedFilterStore, tableKey: string): SavedFilter[] {
  return byUpdatedAtDesc(store.getAll()[tableKey] ?? []);
}

/**
 * 名称模糊搜索（大小写不敏感）。空 query 返回全部 —— "清空搜索框就回到完整列表"
 * 是用户预期，不要返回空。
 */
export function searchSavedFilters(
  list: readonly SavedFilter[],
  query: string,
): SavedFilter[] {
  const q = (query ?? '').trim().toLowerCase();
  if (q === '') return [...list];
  return list.filter((f) => f.name.toLowerCase().includes(q));
}

/** 按 id 取一条（应用方案时用它取 model） */
export function findSavedFilter(
  store: SavedFilterStore,
  tableKey: string,
  id: string,
): SavedFilter | null {
  return (store.getAll()[tableKey] ?? []).find((f) => f.id === id) ?? null;
}

// ---------- 校验 ----------

/** 名称校验：trim 后非空、不超长。返回 null 表示通过 */
function checkName(raw: string): string | null {
  const name = (raw ?? '').trim();
  if (name.length === 0) return '名称不能为空';
  if (name.length > SAVED_FILTER_NAME_MAX) return `名称不能超过 ${SAVED_FILTER_NAME_MAX} 个字符`;
  return null;
}

/** 重名判定：trim 后大小写不敏感 —— "MyFilter" 与 "myfilter" 对用户是同一个东西 */
function isDuplicate(list: readonly SavedFilter[], name: string, exceptId?: string): boolean {
  const target = name.trim().toLowerCase();
  return list.some(
    (f) => f.id !== exceptId && f.name.trim().toLowerCase() === target,
  );
}

// ---------- 写 ----------

/**
 * 保存一个新方案。
 *
 * 拒绝的四种情况都给中文 reason（调用方直接 toast）：空名 / 超长名 / 空筛选模型 /
 * 超上限 / 重名。空模型也拒 —— 存一个"什么都没筛"的方案没有意义，反而污染列表。
 */
export function saveFilter(
  store: SavedFilterStore,
  tableKey: string,
  name: string,
  model: FilterModel,
): SaveResult {
  const bad = checkName(name);
  if (bad) return { ok: false, reason: bad };
  if (!model || isFilterEmpty(model)) {
    return { ok: false, reason: '筛选条件为空，没有可保存的内容' };
  }

  const all = store.getAll();
  const list = all[tableKey] ?? [];
  if (list.length >= SAVED_FILTERS_MAX_PER_TABLE) {
    return { ok: false, reason: `本表最多保存 ${SAVED_FILTERS_MAX_PER_TABLE} 个筛选方案，请先删除一些` };
  }
  const trimmed = name.trim();
  if (isDuplicate(list, trimmed)) {
    return { ok: false, reason: `已存在同名方案「${trimmed}」` };
  }

  const now = Date.now();
  const filter: SavedFilter = { id: newId(), name: trimmed, model, createdAt: now, updatedAt: now };
  all[tableKey] = [...list, filter];
  store.putAll(all);
  return { ok: true, filter };
}

/** 重命名（同时刷新 updatedAt —— 列表是按它排序的，改名不改时间会"沉底"） */
export function renameFilter(
  store: SavedFilterStore,
  tableKey: string,
  id: string,
  name: string,
): SaveResult {
  const bad = checkName(name);
  if (bad) return { ok: false, reason: bad };

  const all = store.getAll();
  const list = all[tableKey] ?? [];
  const idx = list.findIndex((f) => f.id === id);
  if (idx < 0) return { ok: false, reason: '方案不存在或已被删除' };

  const trimmed = name.trim();
  if (isDuplicate(list, trimmed, id)) {
    return { ok: false, reason: `已存在同名方案「${trimmed}」` };
  }

  const next: SavedFilter = { ...list[idx], name: trimmed, updatedAt: Date.now() };
  const copy = [...list];
  copy[idx] = next;
  all[tableKey] = copy;
  store.putAll(all);
  return { ok: true, filter: next };
}

/**
 * 删除一条，返回删除后的剩余列表（已排序，调用方直接 setState）。
 * id 不存在时原样返回 —— 双击删除 / 多入口并发删同一个是很常见的，不该报错。
 */
export function deleteFilter(store: SavedFilterStore, tableKey: string, id: string): SavedFilter[] {
  const all = store.getAll();
  const list = all[tableKey] ?? [];
  if (!list.some((f) => f.id === id)) return byUpdatedAtDesc(list);

  const rest = list.filter((f) => f.id !== id);
  if (rest.length === 0) {
    // 空数组不留在存储里：避免 key 越攒越多，也让"这张表没有方案"读回来是干净的空
    delete all[tableKey];
  } else {
    all[tableKey] = rest;
  }
  store.putAll(all);
  return byUpdatedAtDesc(rest);
}
