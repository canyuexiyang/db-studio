/**
 * v0.6.0：中间面板的对象清单（跟随左侧树选中项联动）。
 *
 * 用户拍板的需求是「工具面板跟随树」：选了某个库的「表」，中间就该看到那个库
 * 所有表；没选库就该看到全部连接的对象。
 *
 * ## 为什么不新增 IPC
 *
 * 数据侧早就齐了：`buildTree`（core-tree-view）已经按 kind 分好类、算好 badge。
 * 缺的只是**渲染层**——所以本组件是纯展示 + 一个打开回调，不发任何请求。
 *
 * ## 三种形态（按 activeKey 推导，不是三套组件）
 *
 *  - 未选中任何东西 → 全部连接的所有对象（概览）
 *  - 选中某库      → 该库的表/视图清单
 *  - 选中某类别（表/视图…）→ 该库该类别的对象
 *
 * 之所以合成一个组件而不是三个：它们的差别只是"过滤条件"，
 * 拆开会导致三份几乎一样的 JSX，样式改动要改三处。
 */

import { useMemo } from 'react';
import { OBJECT_KIND_LABELS, OBJECT_KIND_ORDER, type TreeNode } from '@dbstudio/core-tree-view';
import type { ObjectKind, TableMeta } from '@dbstudio/core-schema-cache';
import { IconTable, IconEye, IconBraces, IconFn, IconZap, IconClock, IconDatabase } from '../ui/icons';

const KIND_ICON: Record<ObjectKind, (p: { size?: number }) => React.ReactNode> = {
  table: IconTable,
  view: IconEye,
  procedure: IconBraces,
  function: IconFn,
  trigger: IconZap,
  event: IconClock,
};

/** 清单里的一条对象 */
interface ListedObject {
  key: string;
  name: string;
  database: string;
  connId: string;
  table: TableMeta;
}

/**
 * 从树里收集对象。
 *
 * @param roots  整棵树的根
 * @param scope 作用域：null = 全部连接；否则 { connId, database } = 某个库
 * @param onlyKind 只列某一类别；null = 全类别（仍按OBJECT_KIND_ORDER 排序）
 */
function collectObjects(
  roots: TreeNode[],
  scope: { connId: string; database: string } | null,
  onlyKind: ObjectKind | null,
): ListedObject[] {
  const out: ListedObject[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      // 只取 kind 节点的直接子节点：扁平遍历整棵树再过滤会重复收录
      if (n.kind === 'kind' && n.database && n.objectKind
        && (!onlyKind || n.objectKind === onlyKind)
        && (!scope || scope.database === n.database)) {
        const connId = connIdOfKey(n.key);
        if (connId) {
          for (const c of n.children ?? []) {
            if (c.kind === 'object' && c.table && c.database) {
              out.push({ key: c.key, name: c.label, database: c.database, connId, table: c.table });
            }
          }
        }
      }
      walk(n.children ?? []);
    }
  };
  walk(roots);

  // 排序：库名 → 类别固定序 → 表名。跨连接概览时，同名表来自不同库不会撞在一起。
  const orderOf = (k: ObjectKind) => OBJECT_KIND_ORDER.indexOf(k);
  out.sort((a, b) => {
    if (a.database !== b.database) return a.database < b.database ? -1 : 1;
    const ka = orderOf(a.table.kind);
    const kb = orderOf(b.table.kind);
    if (ka !== kb) return ka - kb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

/** 从 kind/db 节点 key 取 connId（与 App.parseTreeKeyContext 同口径） */
function connIdOfKey(key: string): string {
  const parts = key.split(':');
  return (parts[0] === 'kind' || parts[0] === 'db' || parts[0] === 'obj') && parts.length >= 3 ? parts[1] : '';
}

export interface ObjectBrowserProps {
  roots: TreeNode[];
  /** 左侧树当前选中的节点 key（联动源） */
  activeKey: string | null;
  /** 点清单里的一项 → 打开该表 */
  onOpenObject: (node: TreeNode) => void;
  /** 按 key 反查节点（点清单项时要拿到完整 TreeNode 才能 open） */
  findByKey: (roots: TreeNode[], key: string) => TreeNode | null;
}

export function ObjectBrowser({ roots, activeKey, onOpenObject, findByKey }: ObjectBrowserProps) {
  /**
   * 作用域与类别：从 activeKey 反解。
   *
   * `kind:<connId>:<db>:<kind>` 直接给出三者；`db:<connId>:<db>` 给出前两者；
   * 其它（连接节点/分组/空）→ null = 全部连接概览。
   */
  const scope = useMemo((): { connId: string; database: string; onlyKind: ObjectKind | null } | null => {
    if (!activeKey) return null;
    const parts = activeKey.split(':');
    if (parts[0] === 'kind' && parts.length >= 4) {
      return { connId: parts[1], database: parts[2], onlyKind: parts[3] as ObjectKind };
    }
    if (parts[0] === 'db' && parts.length >= 3) {
      return { connId: parts[1], database: parts[2], onlyKind: null };
    }
    return null;
  }, [activeKey]);

  const objects = useMemo(
    () => collectObjects(roots, scope ? { connId: scope.connId, database: scope.database } : null, scope?.onlyKind ?? null),
    [roots, scope],
  );

  const title = scope
    ? scope.onlyKind
      ? `${scope.database} · ${OBJECT_KIND_LABELS[scope.onlyKind]}`
      : `${scope.database} · 全部对象`
    : '全部连接的对象';

  if (objects.length === 0) {
    return (
      <div className="ob-root" data-testid="object-browser">
        <div className="ob-head">
          <IconDatabase size={12} />
          <span className="ob-title">{title}</span>
        </div>
        <div className="ob-empty">
          {scope ? '该范围内没有对象（连接后才会拉到结构）' : '还没有对象。连上数据库后，这里会列出各库的表与视图。'}
        </div>
      </div>
    );
  }

  return (
    <div className="ob-root" data-testid="object-browser">
      <div className="ob-head">
        <IconDatabase size={12} />
        <span className="ob-title">{title}</span>
        <span className="ob-count">{objects.length}</span>
      </div>
      <div className="ob-list">
        {objects.map((o) => {
          const Ico = KIND_ICON[o.table.kind];
          return (
            <button
              key={o.key}
              className="ob-item"
              title={`${o.database}.${o.name}`}
              data-testid={`ob-item-${o.name}`}
              onClick={() => {
                const node = findByKey(roots, o.key);
                if (node) onOpenObject(node);
              }}
            >
              <Ico size={12} />
              <span className="ob-name">{o.name}</span>
              <span className="ob-db">{o.database}</span>
              <span className="ob-kind">{OBJECT_KIND_LABELS[o.table.kind]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}