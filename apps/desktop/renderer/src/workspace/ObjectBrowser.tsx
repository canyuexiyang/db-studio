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
 *
 * ## 🔴 v0.7.0 T02/R02：作用域必须带 connId
 *
 * 旧实现只比较 `database`。两个连接（如 prod_order / dev_order）都有 `order_db`
 * 时，选中其中一个的 `order_db`，中间清单会把两个连接的表全列出来、还出现同名
 * 两条。库名不是全局唯一身份 —— 唯一身份是 `(connId, database, kind, name)`。
 * 过滤/排序/连接名的纯逻辑已抽到 `objectBrowserModel.ts`，由单测钉住。
 */

import { useMemo } from 'react';
import { OBJECT_KIND_LABELS, type TreeNode } from '@dbstudio/core-tree-view';
import type { ObjectKind } from '@dbstudio/core-schema-cache';
import { IconTable, IconEye, IconBraces, IconFn, IconZap, IconClock, IconDatabase } from '../ui/icons';
import { collectConnNames, collectObjects, scopeFromActiveKey } from './objectBrowserModel';

const KIND_ICON: Record<ObjectKind, (p: { size?: number }) => React.ReactNode> = {
  table: IconTable,
  view: IconEye,
  procedure: IconBraces,
  function: IconFn,
  trigger: IconZap,
  event: IconClock,
};

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
  const scope = useMemo(() => scopeFromActiveKey(activeKey), [activeKey]);

  const connNames = useMemo(() => collectConnNames(roots), [roots]);

  const objects = useMemo(
    () => collectObjects(
      roots,
      scope ? { connId: scope.connId, database: scope.database } : null,
      scope?.onlyKind ?? null,
      connNames,
    ),
    [roots, scope, connNames],
  );

  /** 跨连接概览时才有必要显示连接名（单库作用域下连接名是冗余噪音） */
  const showConn = scope === null;

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
        <span className="ob-count" data-testid="ob-count">{objects.length}</span>
      </div>
      <div className="ob-list">
        {objects.map((o) => {
          const Ico = KIND_ICON[o.table.kind];
          return (
            <button
              key={o.key}
              className="ob-item"
              title={showConn ? `${o.connName} · ${o.database}.${o.name}` : `${o.database}.${o.name}`}
              data-testid={`ob-item-${o.name}`}
              data-conn-id={o.connId}
              onClick={() => {
                const node = findByKey(roots, o.key);
                if (node) onOpenObject(node);
              }}
            >
              <Ico size={12} />
              <span className="ob-name">{o.name}</span>
              {showConn && <span className="ob-conn">{o.connName}</span>}
              <span className="ob-db">{o.database}</span>
              <span className="ob-kind">{OBJECT_KIND_LABELS[o.table.kind]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
