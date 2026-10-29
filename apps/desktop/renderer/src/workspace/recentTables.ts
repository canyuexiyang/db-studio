/**
 * 表视图「最近使用」记忆（P1-14）。
 *
 * `queryPalette` 早就支持按 `lastUsedAt` 做半衰期加权（core-command-palette），
 * 但 App 构造表条目时从不带该字段 —— 能力建了却空转，「最近打开过的表排前面」
 * 这个最符合直觉的排序实际不生效。
 *
 * 键与表视图记忆（tableViewMemory）同体系：`connId:db:table`，两连接同名表不串。
 * 只存时间戳，存不下就静默降级（记忆是体验增强，不值得打扰用户）。
 */

export const RECENT_TABLES_KEY = 'dbstudio.recentTables.v1';

/** 最多记多少张 —— 防止 localStorage 无限膨胀（超出按最旧淘汰） */
export const RECENT_TABLES_LIMIT = 300;

export type RecentTableMap = Record<string, number>;

export function tableMemoryKey(connId: string, database: string, table: string): string {
  return `${connId}:${database}:${table}`;
}

function sanitize(input: unknown): RecentTableMap {
  if (!input || typeof input !== 'object') return {};
  const out: RecentTableMap = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== 'string' || k === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[k] = n;
  }
  return out;
}

export function loadRecentTables(): RecentTableMap {
  try {
    const raw = localStorage.getItem(RECENT_TABLES_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveRecentTables(map: RecentTableMap): void {
  try {
    localStorage.setItem(RECENT_TABLES_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式/配额满：静默降级为不记忆
  }
}

/**
 * 记录一次「打开表」。
 *
 * 纯函数形态（返回新 map）—— 便于单测直接在错误输入上验证，也让调用点
 * 不必关心存储实现。超过上限时淘汰最旧的一条（一次只淘汰一条，O(n) 但 n≤300）。
 */
export function recordTableUsed(
  map: RecentTableMap,
  key: string,
  now: number,
  limit = RECENT_TABLES_LIMIT,
): RecentTableMap {
  const next: RecentTableMap = { ...map, [key]: now };
  const keys = Object.keys(next);
  if (keys.length <= limit) return next;
  let oldestKey = keys[0];
  let oldestAt = next[oldestKey];
  for (const k of keys) {
    if (next[k] < oldestAt) {
      oldestAt = next[k];
      oldestKey = k;
    }
  }
  delete next[oldestKey];
  return next;
}
