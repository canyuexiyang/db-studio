/**
 * 收藏表（C5）—— 纯逻辑，不依赖 React/Electron。
 *
 * 存储：localStorage（key `dbstudio.favTables.v1`），值为 JSON string[]，
 * 每项格式 `${connId}:${database}:${table}` —— 与树对象节点 key（`obj:` 之后的部分）
 * 以及 ⌘K 命令面板 PaletteItem.id 完全同构，三处可以零转换互查。
 *
 * 设计取舍：
 *  - storage 参数可注入（测试用内存实现，SSR/无 window 环境自动降级为不落盘）；
 *  - 全部读/写包 try/catch：隐私模式、配额满、JSON 损坏都静默降级为空列表，
 *    收藏是锦上添花的功能，任何异常都不许影响树的首屏与交互；
 *  - 上限 50：toggleFavorite 在模块内硬卡（超出时不新增），调用方（TreeView）
 *    在调用前自查并用 onToast 提示 —— 模块保持无 UI 依赖。
 */

/** localStorage 键（v1：结构变化时换 v2 并做迁移，旧键直接作废） */
export const FAVORITES_STORAGE_KEY = 'dbstudio.favTables.v1';

/** 收藏上限：超出后不再新增（调用方负责提示） */
export const FAVORITES_MAX = 50;

/** 可注入的存储接口（localStorage 的最小子集，便于单测） */
export interface FavoritesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 默认存储：浏览器环境用 localStorage；不存在（单测 node 环境）返回 undefined */
function defaultStorage(): FavoritesStorage | undefined {
  return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

/**
 * 读收藏列表。损坏/非数组/混入非字符串一律丢弃，返回空列表 —— 不抛错。
 */
export function loadFavorites(storage?: FavoritesStorage): string[] {
  const s = storage ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/** 是否已收藏（纯查询，不碰存储） */
export function isFavorite(list: readonly string[], key: string): boolean {
  return list.includes(key);
}

/**
 * 切换收藏并落盘，返回切换后的完整列表。
 * 已收藏 → 移除；未收藏 → 追加（达到 FAVORITES_MAX 时拒绝新增，原样返回）。
 * 列表以存储中的最新值为基准（存储是唯一权威，避免多入口切换互相覆盖）。
 */
export function toggleFavorite(key: string, storage?: FavoritesStorage): string[] {
  const s = storage ?? defaultStorage();
  const cur = loadFavorites(s);
  let next: string[];
  if (cur.includes(key)) {
    next = cur.filter((k) => k !== key);
  } else {
    if (cur.length >= FAVORITES_MAX) return cur;
    next = [...cur, key];
  }
  if (s) {
    try {
      s.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 配额满 / 隐私模式：写入失败不阻断，本次切换仅在内存生效
    }
  }
  return next;
}

/** 构造收藏 key（与树对象节点 key 的 `obj:` 之后部分、⌘K PaletteItem.id 同构） */
export function favoriteKey(connId: string, database: string, table: string): string {
  return `${connId}:${database}:${table}`;
}
