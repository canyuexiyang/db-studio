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

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from './useWorkspaceTabs';
import { IconTable, IconTerminal, IconLock, IconX, IconPlus, IconPin, IconDatabase } from '../ui/icons';
import { TabContextMenu } from './TabContextMenu';
import { TabDirtyCloseModal } from './TabDirtyCloseModal';
// P2-18f：同名表标签带连接标识（纯函数，单测在 tabOrder.test.ts）
import { tabDisplayTitle } from './tabOrder';
import {
  buildTabMenuItems,
  closeAllIds,
  closeLeftIds,
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
  /**
   * P1-7：拖拽排序（下标口径 = tabs 数组下标）。
   * 宿主未接时拖拽无效（不画拖拽态，避免"能拖但不生效"的假交互）。
   */
  onMoveTab?: (from: number, to: number) => void;
  /** P1-7：固定 / 取消固定 */
  onTogglePin?: (id: string) => void;
  /** P2-18f：connId → 连接名（同名表标签的区分标识） */
  connLabels?: Record<string, string>;
  /**
   * P1-16：浏览对象视图开关。
   *
   * 审计的原始问题是「清单一开标签就整体消失」—— 它到底是入口还是空态插画
   * 说不清。拍板为①：清单做成**可切换的工作区视图**，开关就放在标签栏右侧
   * （与「＋」同一条视觉带：都是"打开点东西"的动作）。
   * 未接时整个按钮不渲染 —— 不画一个点了没反应的假开关。
   */
  browseToggle?: {
    active: boolean;
    onToggle: () => void;
    disabled?: boolean;
    disabledReason?: string;
  };
}

/** 固定的标签不可被批量关闭（关闭其他 / 关闭右侧）波及 */
function isClosable(tab: WorkspaceTab): boolean {
  return tab.pinned !== true;
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
  onMoveTab,
  onTogglePin,
  connLabels,
  browseToggle,
}: WorkspaceTabsBarProps) {
  /** 右键菜单：命中标签 id + 视口坐标 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 待确认的批量关闭清单（null = 不弹框） */
  const [pending, setPending] = useState<BatchClosePlan | null>(null);
  /** P1-7：拖拽源下标（null = 没在拖） */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  /**
   * P0-3：滚动容器 + 激活标签的引用。
   *
   * 🔴 不用 `scrollIntoView`：它会连带滚动所有可滚祖先（包括窗口），
   *    标签条在很深的布局里，一次 ⌘9 就可能把整页滚走。这里只改容器的
   *    scrollLeft，行为可预测、也能被 e2e 直接断言。
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = activeRef.current;
    const box = scrollRef.current;
    if (!el || !box) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
    // tabs.length 参与依赖：⌘9 跳到视野外的标签、以及"关掉前面的标签导致位移"都要重算
  }, [activeId, tabs.length]);

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
      // P1-7：固定标签不参与批量关闭（isClosable 钩子 —— 该场景早已在单测里留好）
      const plan = planBatchClose(tabs, ids, { isClosable });
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
          runBatch(closeRightIds(tabs, tab.id, { isClosable }));
          return;
        /** 0.7.3（P1-26）：左侧 / 全部同样走 planBatchClose（脏标签一次列全，不连弹框） */
        case 'closeLeft':
          runBatch(closeLeftIds(tabs, tab.id, { isClosable }));
          return;
        case 'closeAll':
          runBatch(closeAllIds(tabs, { isClosable }));
          return;
        case 'togglePin':
          onTogglePin?.(tab.id);
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
    [menuTab, tabs, runBatch, onRevealInTree, onToast, onTogglePin],
  );

  if (tabs.length === 0) return null;

  return (
    <>
      {/*
        P0-3：「+」新建按钮**移出**滚动容器。
        原来它是滚动容器的普通子项，标签一多就被滚走 —— 用户想开新标签得先把
        滚动条拖回最右。现在结构是「滚动区（标签） + 固定区（+）」，与 VSCode/Chrome 一致。
      */}
      <div className="ws-tabs" data-testid="ws-tabs">
        <div className="ws-tabs-scroll" ref={scrollRef} data-testid="ws-tabs-scroll">
          {tabs.map((t, i) => {
            const readOnly = t.connId ? readOnlyConns[t.connId] === true : false;
            // P2-18f：同名表跨连接时标题带连接标识（唯一时不加噪音）
            const label = tabDisplayTitle(t, tabs, connLabels ?? {});
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                ref={isActive ? activeRef : undefined}
                className={`ws-tab${isActive ? ' active' : ''}${t.pinned ? ' pinned' : ''}${
                  dragFrom === i ? ' dragging' : ''
                }`}
                data-testid={`ws-tab-${t.title}`}
                data-tab-id={t.id}
                data-pinned={t.pinned ? '1' : '0'}
                // P1-7：HTML5 拖拽排序（不用 pointer 事件 —— 与单击/中键关闭手势会打架）
                draggable={!!onMoveTab}
                onDragStart={(e) => {
                  setDragFrom(i);
                  // 某些浏览器要求 setData 才会真正开始拖拽
                  e.dataTransfer?.setData('text/plain', t.id);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFrom;
                  setDragFrom(null);
                  if (from === null || from === i) return;
                  onMoveTab?.(from, i);
                }}
                onDragEnd={() => setDragFrom(null)}
                onClick={() => onSelect(t.id)}
                // P1-7：双击关闭（浏览器/编辑器通例）。点关闭按钮时的双击不触发关闭
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest('.ws-tab-close')) return;
                  if (!onBeforeClose || onBeforeClose(t)) onClose(t.id);
                }}
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
                {t.pinned ? (
                  <span className="ws-tab-pin" title="已固定：不参与「关闭其他/右侧」" data-testid="ws-tab-pin">
                    <IconPin size={10} />
                  </span>
                ) : null}
                <span className="ws-tab-icon">{t.kind === 'table' ? <IconTable size={11} /> : <IconTerminal size={11} />}</span>
                <span className="ws-tab-label">
                  {label}
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
        </div>
        <button className="ws-tab-new" title="新建查询标签（⌘T）" onClick={onNewQuery} data-testid="ws-new-query">
          <IconPlus size={12} />
        </button>
        {/* P1-16：浏览对象视图开关（与「＋」同一视觉带，都是"打开点东西"） */}
        {browseToggle ? (
          <button
            className={`ws-tab-new ws-browse-toggle${browseToggle.active ? ' on' : ''}`}
            title={
              browseToggle.disabled
                ? browseToggle.disabledReason ?? '当前无法浏览对象'
                : browseToggle.active
                  ? '结束浏览对象，回到标签视图'
                  : '浏览对象：在中间面板列出当前库/连接的对象（再点一次回到标签）'
            }
            aria-pressed={browseToggle.active}
            disabled={browseToggle.disabled}
            onClick={browseToggle.onToggle}
            data-testid="ws-browse-toggle"
            data-active={browseToggle.active ? '1' : '0'}
          >
            <IconDatabase size={12} />
          </button>
        ) : null}
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
            // P1-7：固定标签不可批量关闭 —— 菜单的禁用态必须与真实行为一致
            isClosable,
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
