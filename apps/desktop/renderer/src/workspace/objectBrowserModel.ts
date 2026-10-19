/**
 * 中间对象清单的纯模型层（T02/R02）。
 *
 * 从树里收集对象 + 按 (connId, database) 归属过滤 + 排序。
 * 抽成独立模块的原因：这条逻辑正是 R02 的缺陷现场（只比 database 不比 connId），
 * 必须能被单测直接钉住 —— 渲染层 `.tsx` 的组件测试不在 vitest include 里。
 */

import { OBJECT_KIND_ORDER, type TreeNode } from '@dbstudio/core-tree-view';
import type { ObjectKind, TableMeta } from '@dbstudio/core-schema-cache';

/** 清单里的一条对象。身份是 (connId, database, kind, name)，缺一不可。 */
export interface ListedObject {
  key: string;
  name: string;
  database: string;
  connId: string;
  /** 连接名，跨连接概览时用于区分同名库（T02/R02） */
  connName: string;
  table: TableMeta;
}

/** 清单作用域：null = 全部连接概览；否则精确到某连接的某库 */
export type ObjectScope = { connId: string; database: string } | null;

/** 扫描树，建立 connId → 连接名映射（连接节点 label 就是连接名） */
export function collectConnNames(roots: TreeNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'connection') {
        const id = n.key.startsWith('conn:') ? n.key.slice('conn:'.length) : '';
        if (id) out[id] = n.label;
      }
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * 从树里收集对象。
 *
 * @param roots  整棵树的根
 * @param scope  作用域：null = 全部连接；否则 { connId, database } = 某连接某库
 * @param onlyKind 只列某一类别；null = 全类别
 * @param connNames connId → 连接名
 */
export function collectObjects(
  roots: TreeNode[],
  scope: ObjectScope,
  onlyKind: ObjectKind | null,
  connNames: Record<string, string> = {},
): ListedObject[] {
  const out: ListedObject[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      // 只取 kind 节点的直接子节点：扁平遍历整棵树再过滤会重复收录
      if (n.kind === 'kind' && n.database && n.objectKind
        && (!onlyKind || n.objectKind === onlyKind)) {
        const connId = connIdOfKey(n.key);
        // 🔴 T02/R02：作用域必须同时匹配 connId 与 database。
        // 只比 database 会让两个连接的同名库互相混入。
        const inScope = !scope || (scope.connId === connId && scope.database === n.database);
        if (connId && inScope) {
          for (const c of n.children ?? []) {
            if (c.kind === 'object' && c.table && c.database) {
              out.push({
                key: c.key,
                name: c.label,
                database: c.database,
                connId,
                connName: connNames[connId] ?? connId,
                table: c.table,
              });
            }
          }
        }
      }
      walk(n.children ?? []);
    }
  };
  walk(roots);

  // 排序：连接 → 库名 → 类别固定序 → 表名。跨连接概览时，同名表来自不同连接/库
  // 不会撞在一起。
  const orderOf = (k: ObjectKind) => OBJECT_KIND_ORDER.indexOf(k);
  out.sort((a, b) => {
    if (a.connName !== b.connName) return a.connName < b.connName ? -1 : 1;
    if (a.database !== b.database) return a.database < b.database ? -1 : 1;
    const ka = orderOf(a.table.kind);
    const kb = orderOf(b.table.kind);
    if (ka !== kb) return ka - kb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

/** 从 kind/db 节点 key 取 connId（与 App.parseTreeKeyContext 同口径） */
export function connIdOfKey(key: string): string {
  const parts = key.split(':');
  return (parts[0] === 'kind' || parts[0] === 'db' || parts[0] === 'obj') && parts.length >= 3 ? parts[1] : '';
}

/** 从 activeKey 反解清单作用域（`kind:...` / `db:...` → scope，其余 → null） */
export function scopeFromActiveKey(
  activeKey: string | null,
): { connId: string; database: string; onlyKind: ObjectKind | null } | null {
  if (!activeKey) return null;
  const parts = activeKey.split(':');
  if (parts[0] === 'kind' && parts.length >= 4) {
    return { connId: parts[1], database: parts[2], onlyKind: parts[3] as ObjectKind };
  }
  if (parts[0] === 'db' && parts.length >= 3) {
    return { connId: parts[1], database: parts[2], onlyKind: null };
  }
  return null;
}
