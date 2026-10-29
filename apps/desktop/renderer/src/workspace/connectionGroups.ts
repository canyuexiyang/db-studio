/**
 * 连接分组的批量整理逻辑（0.7.3 P2-29）。
 *
 * ## 分组是什么
 *
 * 分组**不是独立实体**：树里的分组由每条连接的 `group` 字段派生
 * （`生产/订单` 表示嵌套），见 core-connection 的 `buildGroupTree`。
 * 于是「整理分组」= 批量改这些连接上的一个字符串字段，不是一个新存储。
 *
 * ## 为什么还要一份 `emptyGroups`
 *
 * 派生结构有一个副作用：**没有连接的分组不存在**。用户点「新建分组」后如果
 * 什么都不建，这个分组立刻消失 —— 那是「点了没反应」的另一种形态。
 * 所以新增一份空分组路径清单（localStorage），`buildTree` 建树时并进去。
 * 它只保存路径，不碰连接与凭据。
 *
 * 🔴 前缀匹配必须**按段**：`生产` 不能命中 `生产环境`。用 `startsWith(from + '/')`
 *    而不是 `startsWith(from)` 就是这条（单测有反例）。
 */

export const EMPTY_GROUPS_KEY = 'dbstudio.emptyGroups.v1';

/** 分组名/路径里禁止出现的字符：`:` 是树节点 key 的分段符 */
const GROUP_FORBIDDEN = [':'] as const;

/**
 * 归一化分组路径：去首尾空白与多余斜杠，逐段 trim。
 *
 * @returns 合法路径；空串或含非法字符 → null（调用方负责给中文原因）
 */
export function normalizeGroupPath(raw: string): string | null {
  const parts = (raw ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p.length > 64) return null;
    for (const ch of GROUP_FORBIDDEN) if (p.includes(ch)) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(p)) return null;
  }
  return parts.join('/');
}

/** 路径最后一段（树行的显示名）；空路径 = 未分组 */
export function groupDisplayName(path: string): string {
  const parts = (path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** 在父路径下拼一个子分组（父为空 = 顶层） */
export function childGroupPath(parent: string, name: string): string {
  const p = (parent ?? '').trim().replace(/\/+$/, '');
  const n = (name ?? '').trim().replace(/^\/+/, '');
  if (!p) return n;
  if (!n) return p;
  return `${p}/${n}`;
}

/** 某条连接的 group 是否落在路径下（含自身；按段匹配） */
export function isInGroup(group: string | null | undefined, path: string): boolean {
  if (!group || !path) return false;
  return group === path || group.startsWith(`${path}/`);
}

/**
 * 重命名分组：算出需要改的连接（id + 新 group）。
 *
 * 只返回**真正会变**的那些 —— 上层据此决定是否还要跑一次批量保存。
 * `to` 为空串 = 移回未分组（group: null）。
 */
export function renameGroupPatch(
  connections: readonly { id: string; group: string | null }[],
  from: string,
  to: string,
): { id: string; group: string | null }[] {
  const src = (from ?? '').trim();
  if (!src) return []; // 未分组不是一个可重命名的实体
  const dest = (to ?? '').trim();
  const out: { id: string; group: string | null }[] = [];
  for (const c of connections) {
    if (!isInGroup(c.group, src)) continue;
    const rest = c.group === src ? '' : c.group!.slice(src.length + 1);
    const next = dest ? (rest ? `${dest}/${rest}` : dest) : rest || null;
    if (next !== c.group) out.push({ id: c.id, group: next });
  }
  return out;
}

/** 空分组清单跟着重命名（否则旧路径会作为一个空壳留在树里） */
export function renameEmptyGroups(paths: readonly string[], from: string, to: string): string[] {
  const src = (from ?? '').trim();
  if (!src) return [...paths];
  const dest = (to ?? '').trim();
  const out: string[] = [];
  for (const p of paths) {
    if (!isInGroup(p, src)) {
      out.push(p);
      continue;
    }
    const rest = p === src ? '' : p.slice(src.length + 1);
    const next = dest ? (rest ? `${dest}/${rest}` : dest) : rest;
    if (next) out.push(next);
  }
  return [...new Set(out)].sort();
}

/** 新建分组：去重后排序（树里的顺序因此稳定，不随点击顺序抖动） */
export function addEmptyGroup(paths: readonly string[], path: string): string[] {
  const p = (path ?? '').trim();
  if (!p) return [...paths];
  return [...new Set([...paths, p])].sort();
}

/** 删除空分组：连子分组一起删（父没了，子分组在树里也没有落脚点） */
export function removeEmptyGroupSubtree(paths: readonly string[], path: string): string[] {
  const p = (path ?? '').trim();
  if (!p) return [...paths];
  return paths.filter((x) => !isInGroup(x, p));
}

// ---------- 持久化（写不进去只影响下次启动，不打扰用户） ----------

export function loadEmptyGroups(): string[] {
  try {
    const raw = localStorage.getItem(EMPTY_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const n = normalizeGroupPath(item);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveEmptyGroups(paths: readonly string[]): void {
  try {
    localStorage.setItem(EMPTY_GROUPS_KEY, JSON.stringify(paths));
  } catch {
    // 隐私模式/配额满：空分组清单丢了不影响已有分组的展示（它们由连接派生）
  }
}
