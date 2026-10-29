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
 *
 * ## 🔴 0.7.1（真机反馈 3）：单击 = 选中，双击 = 打开
 *
 * 旧实现单击就 `onOpenObject` —— 用户只是想看看这张表的 DDL，结果标签越开越多。
 * 现在与左侧树、Finder、Navicat 一致：
 *   单击 → `onSelectObject`（右侧详情面板显示表设计/DDL，清单内高亮该行）
 *   双击 → `onOpenObject`（真的把表打开成标签）
 *   键盘 → Enter / ⌘↓ 等价双击；空格 = 选中（原生 button 行为）
 *
 * **不做「单击延迟 300ms 等双击」那套**：那会让单击有肉眼可感的迟滞，
 * 而本产品的差异点正是"反应最快"。双击的 dblclick 之前会先触发一次 click，
 * 那次 click 只更新选中态（幂等、无副作用），不会误开标签。
 *
 * ## 🔴 0.7.2 P1-16：定位拍板 —— **可切换的工作区视图**（不是空态装饰）
 *
 * 审计指出的真正问题不是"清单不好用"，而是**它只在零标签时存在**：一旦开了
 * 任何标签，整块清单连同它已经做好的单击/双击语义全部消失，于是它到底是
 * 「入口」还是「空态插画」谁也说不清，两套口径同时维护。
 *
 * 拍板选①（升级为可切换视图）：标签栏右侧加一个「浏览对象」开关（⌘⇧B），
 * 打开时中间面板显示本清单、标签页整体让位（面板 DOM 不卸载，保留滚动与草稿）；
 * 在清单里双击打开表时**自动关掉浏览态**，否则用户会觉得"双击没反应"。
 *
 * 为什么不选②（砍成纯空态引导）：清单已经有真实价值（跨库对象一览 + 单击看
 * DDL），砍掉是把可用能力换成"更少的维护面"，而真正的成本（右键菜单）本就不在
 * 这里 —— 右键菜单仍只挂在左树，避免同一动作两套入口各写一遍权限/脏检查。
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
  /**
   * 决定清单**作用域**的 key（来自左侧树的库/类别选择）。
   *
   * 🔴 0.7.1 起它**不等于**"当前选中项" —— 单击清单里的表会把选中项指到那张表，
   * 但清单内容不该跟着跳（作用域只由树决定）。二者拆开见 App 的 `obScopeKey`。
   */
  activeKey: string | null;
  /** 当前选中项 key（清单内高亮；由 App 的 activeKey 传入） */
  selectedKey?: string | null;
  /** 单击清单项 → 选中（右侧详情跟随），**不打开**表 */
  onSelectObject: (node: TreeNode) => void;
  /** 双击 / Enter / ⌘↓ → 打开该表 */
  onOpenObject: (node: TreeNode) => void;
  /** 按 key 反查节点（选中/打开都要拿到完整 TreeNode） */
  findByKey: (roots: TreeNode[], key: string) => TreeNode | null;
}

export function ObjectBrowser({
  roots,
  activeKey,
  selectedKey = null,
  onSelectObject,
  onOpenObject,
  findByKey,
}: ObjectBrowserProps) {
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
          const selected = o.key === selectedKey;
          const selectNode = () => {
            const node = findByKey(roots, o.key);
            if (node) onSelectObject(node);
          };
          const openNode = () => {
            const node = findByKey(roots, o.key);
            if (node) onOpenObject(node);
          };
          return (
            <button
              key={o.key}
              className="ob-item"
              title={
                (showConn ? `${o.connName} · ${o.database}.${o.name}` : `${o.database}.${o.name}`) +
                '\n单击查看表设计 / DDL，双击打开'
              }
              data-testid={`ob-item-${o.name}`}
              data-conn-id={o.connId}
              /* 语义钩子：e2e 靠它判"当前选中哪一行"，别改用 class 或观感 */
              data-active={selected ? '1' : undefined}
              aria-current={selected ? 'true' : undefined}
              onClick={selectNode}
              onDoubleClick={openNode}
              onKeyDown={(e) => {
                // 键盘等价双击：Enter / ⌘↓ 打开。这里必须 preventDefault ——
                // 否则 <button> 的 Enter 激活会紧接着再触发一次 onClick（选中）。
                // 空格不抢：空格 = 选中（原生行为），与 Finder 一致。
                if (e.key === 'Enter' || (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey))) {
                  e.preventDefault();
                  openNode();
                }
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
