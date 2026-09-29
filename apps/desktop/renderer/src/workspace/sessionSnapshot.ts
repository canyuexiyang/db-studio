/**
 * F4 会话恢复 —— 标签页记忆（只存轻量元数据）。
 *
 * 为什么不存整份 tab 状态：
 *  - table tab 的 payload 可能几十万行（列式 ArrayBuffer），序列化进
 *    localStorage 既超配额又慢 —— 恢复时重拉数据才是正确语义；
 *  - table 元数据（TableMeta）可能过期，恢复时经 schemaGetTable 重新拿。
 *
 * 因此 query tab 只存 {connId, database, initialSql(截断 100KB)}，
 * table tab 只存 {connId, database, tableName}。上限 20 个标签，
 * 超出时保留【前面的】（打开顺序即用户心智顺序，截尾可预期）。
 *
 * 损坏策略：restorePlan 对任何不合法的输入整体返回空数组 ——
 * 会话恢复是"锦上添花"，宁可少恢复也不让启动被脏数据搞崩。
 */

import type { WorkspaceTab } from './useWorkspaceTabs';

export const SESSION_STORAGE_KEY = 'dbstudio.session.v1';
/** 最多记忆 20 个标签（localStorage 单键 5MB 配额下足够安全） */
export const SESSION_MAX_TABS = 20;
/** initialSql 截断阈值（100KB 字符）——查询草稿可能很大，但恢复 100KB 内的上下文够了 */
export const SESSION_MAX_SQL_CHARS = 100 * 1024;

export interface RestoredQueryTab {
  kind: 'query';
  /** null = 未绑定连接（恢复后由 App 按现有上下文兜底） */
  connId: string | null;
  database: string | null;
  initialSql: string;
}

export interface RestoredTableTab {
  kind: 'table';
  connId: string;
  database: string;
  tableName: string;
}

export type RestoredTab = RestoredQueryTab | RestoredTableTab;

export interface SessionSnapshot {
  version: 1;
  savedAt: number;
  tabs: RestoredTab[];
}

/**
 * 序列化当前标签页。
 *
 * @param activeId 刻意【不存】：activeId 不跨会话恢复（恢复的 tab id 是重新
 *                 生成的，旧 id 必然失效；激活首个恢复的标签即可）。
 *                 参数保留是为了调用点语义完整、未来要恢复时不必改签名。
 */
export function serializeSession(tabs: WorkspaceTab[], _activeId: string | null): SessionSnapshot {
  const out: RestoredTab[] = [];
  for (const t of tabs.slice(0, SESSION_MAX_TABS)) {
    if (t.kind === 'query') {
      out.push({
        kind: 'query',
        connId: t.connId,
        database: t.database,
        // 截断而非丢弃：超大草稿也要保住开头（用户通常在顶部写）
        initialSql: t.initialSql.length > SESSION_MAX_SQL_CHARS
          ? t.initialSql.slice(0, SESSION_MAX_SQL_CHARS)
          : t.initialSql,
      });
    } else {
      // table tab：只记"去哪重开"，payload/table 一概不存（恢复时重拉）
      out.push({ kind: 'table', connId: t.connId, database: t.database, tableName: t.tableName });
    }
  }
  return { version: 1, savedAt: Date.now(), tabs: out };
}

/** 逐项校验：结构对就返回规范化条目，否则 null（由 restorePlan 整体丢弃） */
function parseTab(raw: unknown): RestoredTab | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'query') {
    const connIdOk = typeof r.connId === 'string' || r.connId === null;
    const dbOk = typeof r.database === 'string' || r.database === null;
    if (!connIdOk || !dbOk || typeof r.initialSql !== 'string') return null;
    return {
      kind: 'query',
      connId: r.connId as string | null,
      database: r.database as string | null,
      initialSql: r.initialSql.length > SESSION_MAX_SQL_CHARS
        ? r.initialSql.slice(0, SESSION_MAX_SQL_CHARS)
        : r.initialSql,
    };
  }
  if (r.kind === 'table') {
    // 三个定位字段必须是非空字符串，否则恢复不了
    if (
      typeof r.connId !== 'string' || !r.connId ||
      typeof r.database !== 'string' || !r.database ||
      typeof r.tableName !== 'string' || !r.tableName
    ) {
      return null;
    }
    return { kind: 'table', connId: r.connId, database: r.database, tableName: r.tableName };
  }
  return null;
}

/**
 * 从任意输入（通常是 JSON.parse 的结果）算恢复计划。
 * 任何一层损坏（非对象 / 版本不符 / tabs 不是数组 / 任何一条不合法）→ 空数组。
 *
 * @param isKnown 连接"还在不在"的判据（由调用方拿当前连接列表回答）。
 *   🔴 快照是**上次退出时**的，里面的 connId 可能已经被删了（或换过机器/userData）。
 *     恢复出一个指向不存在连接的标签，状态栏会显示「连接：未知」
 *     （`connStates` 里没有它），而执行按钮只判 `!connId` 所以照样可点 ——
 *     一点必然 NOT_CONNECTED。**比不恢复更糟**：用户看到的是"能点但必然失败"。
 *     所以恢复前先核一遍连接还在不在，不传判据 = 不过滤（兼容既有单测）。
 */
export function restorePlan(
  snapshot: unknown,
  isKnown: (connId: string) => boolean = () => true,
): RestoredTab[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const s = snapshot as Record<string, unknown>;
  if (s.version !== 1) return [];
  if (!Array.isArray(s.tabs)) return [];
  const out: RestoredTab[] = [];
  for (const raw of s.tabs) {
    const tab = parseTab(raw);
    if (!tab) return []; // 一条损坏即整体放弃：半份恢复计划比不恢复更让人困惑
    if (tab.connId !== null && !isKnown(tab.connId)) continue;
    out.push(tab);
  }
  return out.slice(0, SESSION_MAX_TABS);
}

/** 读取持久化的会话快照；没有/损坏返回 null */
export function loadSessionSnapshot(isKnown?: (connId: string) => boolean): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const plan = restorePlan(parsed, isKnown);
    if (plan.length === 0) return null;
    const savedAt =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).savedAt === 'number'
        ? (parsed as Record<string, unknown>).savedAt as number
        : 0;
    return { version: 1, savedAt, tabs: plan };
  } catch {
    return null;
  }
}

/** 持久化会话快照；写失败静默（配额满/隐私模式只影响下次启动） */
export function saveSessionSnapshot(snapshot: SessionSnapshot): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 同上：静默降级
  }
}

/** 清除会话记忆（全部标签关干净时调用，避免下次启动恢复出"上次早已关闭"的标签） */
export function clearSessionSnapshot(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 静默
  }
}
