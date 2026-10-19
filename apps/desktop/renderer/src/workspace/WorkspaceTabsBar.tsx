/**
 * 多标签条（P0-4）—— 工作区顶部 tab UI
 *
 * 交互：
 *  - 单击切换；中键/关闭按钮关闭（table tab 有脏数据时 onBeforeClose 返回 false 拦截）
 *  - 【T27】右键菜单：关闭 / 关闭其他 / 关闭右侧 / 在树定位 / 复制完整对象身份
 *  - ＋ 新建查询标签
 *  - 只读连接的 tab 标题后带锁图标（PRD §6.2 只读标识）
 *  - 图标一律来自 ui/icons.tsx（红线：禁止 emoji 当图标）
 *
 * ## T27 的两个纪律
 *
 * 1. **集合计算与脏清单全部走 `tabContextMenuModel` 的纯函数** —— 「关闭右侧」
 *    的边界（无右侧 / 只剩自己 / 不可关闭）和「批量关闭一次列出全部脏表」都是
 *    纯计算，留在组件里就没法单测，只能靠真机点。
 * 2. **批量关闭只弹一次框**：`planBatchClose` 一次算出全部脏标签清单，交给
 *    `TabDirtyCloseModal` 列全；空清单（没有脏表）直接关，不弹框。
 */

import { memo, useCallback, useState } from 'react';
import type { WorkspaceTab } from './useWorkspaceTabs';
import { IconTable, IconTerminal, IconLock, IconX, IconPlus } from '../ui/icons';
import { TabContextMenu } from './TabContextMenu';
import { TabDirtyCloseModal } from './TabDirtyCloseModal';
import {
  buildTabMenuItems,
  closeOthersIds,
  closeRightIds,
  formatObjectIdentity,
  objectIdentityOf,
  planBatchClose,
  treeKeyOfTab,
  type BatchClosePlan,
  type TabMenuAction,
} from './tabContextMenuModel';

export interface WorkspaceTabsBarProps {
  tabs: WorkspaceTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  /** 关闭前确认（table tab 有脏数据时弹确认）；返回 true 才真正关 */
  onBeforeClose?: (tab: WorkspaceTab) => boolean;
  /** 连接只读标记（connId → readOnly） */
  readOnlyConns: Record<string, boolean>;
  /**
   * T27：批量关闭（已经过一次性的脏清单确认）。
   * 必须传 —— 否则只能退化为逐个 `onClose`，而 `onClose` 对每个脏标签各问一次
   * 就是需求要消灭的「连弹十个框」。
   */
  onCloseBatch?: (ids: string[]) => void;
  /** T27：在树中定位（参数是树节点 key，展开祖先由宿主走真实树算） */
  onRevealInTree?: (treeKey: string) => void;
  /** T27：轻量反馈（复制身份等） */
  onToast?: (msg: string) => void;
}

export const WorkspaceTabsBar = memo(function WorkspaceTabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewQuery,
  onBeforeClose,
  readOnlyConns,
  onCloseBatch,
  onRevealInTree,
  onToast,
}: WorkspaceTabsBarProps) {
  /** 右键菜单：命中标签 id + 视口坐标 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 待确认的批量关闭清单（null = 不弹框） */
  const [pending, setPending] = useState<BatchClosePlan | null>(null);

  // 标签可能在菜单打开期间被别处关掉（⌘W / 删表后关标签）→ 菜单随之消失
  const menuTab = menu ? tabs.find((t) => t.id === menu.id) ?? null : null;

  const closeIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      if (onCloseBatch) {
        onCloseBatch(ids);
        return;
      }
      // 宿主没接批量关闭时的退化路径（不该发生：那样脏标签会被逐个确认）
      for (const id of ids) onClose(id);
    },
    [onCloseBatch, onClose],
  );

  /** 批量关闭入口：先算清单，脏的一次列全，干净的当场关 */
  const runBatch = useCallback(
    (ids: string[]) => {
      const plan = planBatchClose(tabs, ids);
      if (plan.closableIds.length === 0) return;
      if (!plan.needsConfirm) {
        closeIds(plan.closableIds);
        return;
      }
      setPending(plan);
    },
    [tabs, closeIds],
  );

  const onMenuAction = useCallback(
    (action: TabMenuAction) => {
      const tab = menuTab;
      if (!tab) return;
      switch (action) {
        case 'close':
          runBatch([tab.id]);
          return;
        case 'closeOthers':
          runBatch(closeOthersIds(tabs, tab.id));
          return;
        case 'closeRight':
          runBatch(closeRightIds(tabs, tab.id));
          return;
        case 'revealInTree': {
          const key = treeKeyOfTab(tab);
          if (key && onRevealInTree) onRevealInTree(key);
          return;
        }
        case 'copyIdentity': {
          const id = objectIdentityOf(tab);
          if (!id) return;
          const text = formatObjectIdentity(id);
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          onToast?.(`已复制对象身份：${text}`);
          return;
        }
      }
    },
    [menuTab, tabs, runBatch, onRevealInTree, onToast],
  );

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="ws-tabs" data-testid="ws-tabs">
        {tabs.map((t, i) => {
          const readOnly = t.connId ? readOnlyConns[t.connId] === true : false;
          return (
            <div
              key={t.id}
              className={`ws-tab${t.id === activeId ? ' active' : ''}`}
              data-testid={`ws-tab-${t.title}`}
              data-tab-id={t.id}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                // 中键关闭（macOS 惯例）
                if (e.button === 1) {
                  e.preventDefault();
                  if (!onBeforeClose || onBeforeClose(t)) onClose(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              title={t.kind === 'table' ? `${t.database}.${t.tableName}` : t.title}
              /* e2e 可观测性：标签归属哪个连接、该连接是否只读 —— 「读不到 readOnly」
                 这类缺陷只能靠这两个属性在真机上一眼定位（T13/T14 踩过） */
              data-conn-id={t.connId ?? ''}
              data-readonly={readOnly ? '1' : '0'}
            >
              <span className="ws-tab-icon">{t.kind === 'table' ? <IconTable size={11} /> : <IconTerminal size={11} />}</span>
              <span className="ws-tab-label">
                {t.title}
                {readOnly ? <span className="ws-tab-readonly" title="只读连接"><IconLock size={10} /></span> : null}
                {t.kind === 'table' && t.dirtyCount > 0 ? (
                  <span className="ws-tab-dirty" title={`${t.dirtyCount} 个未保存改动`}>
                    {' •'}
                  </span>
                ) : null}
              </span>
              <button
                className="ws-tab-close"
                title="关闭（⌘W）"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!onBeforeClose || onBeforeClose(t)) onClose(t.id);
                }}
              >
                <IconX size={10} />
              </button>
              {/* ⌘1..9 提示 */}
              {i < 9 ? <span className="ws-tab-index">{i + 1}</span> : null}
            </div>
          );
        })}
        <button className="ws-tab-new" title="新建查询标签（⌘T）" onClick={onNewQuery} data-testid="ws-new-query">
          <IconPlus size={12} />
        </button>
      </div>

      {menu && menuTab ? (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          title={menuTab.kind === 'table' ? `${menuTab.database}.${menuTab.tableName}` : menuTab.title}
          items={buildTabMenuItems({
            tabs,
            tab: menuTab,
            activeId,
            canRevealInTree: Boolean(onRevealInTree),
          })}
          onAction={onMenuAction}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {pending ? (
        <TabDirtyCloseModal
          plan={pending}
          onCancel={() => setPending(null)}
          onConfirm={(ids) => {
            setPending(null);
            closeIds(ids);
          }}
        />
      ) : null}
    </>
  );
});
