/**
 * 标签右键菜单（T27）
 *
 * 复用 `ui/useMenuBehavior`（与树/网格/单元格/SQL 四菜单同套：视口内收敛、点外关闭、
 * Esc 关闭并还回焦点、↑↓/Home/End 巡航）。图标一律来自 ui/icons.tsx（不用 emoji）。
 *
 * 为什么不直接复用 `tree/TreeContextMenu`：它 import 了 backend/favorites/core-sql-ident，
 * 只为复用一段 20 行的渲染就把这些拖进标签条的依赖图，不值得（首屏字节红线）。
 *
 * e2e 钩子：容器 `tab-context-menu`，每项 `tab-menu-<key>`。
 */

import { useRef } from 'react';
import { useMenuBehavior } from '../ui/useMenuBehavior';
import { IconX, IconCopy, IconSearch, IconColumns, IconJumpDown } from '../ui/icons';
import type { TabMenuAction, TabMenuItem } from './tabContextMenuModel';

const ICONS: Record<TabMenuAction, (p: { size?: number }) => React.ReactNode> = {
  close: IconX,
  closeOthers: IconColumns,
  closeRight: IconJumpDown,
  revealInTree: IconSearch,
  copyIdentity: IconCopy,
};

export interface TabContextMenuProps {
  x: number;
  y: number;
  /** 菜单头部：右键命中的标签名 */
  title: string;
  items: TabMenuItem[];
  onAction: (key: TabMenuAction) => void;
  onClose: () => void;
}

export function TabContextMenu({ x, y, title, items, onAction, onClose }: TabContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pos = useMenuBehavior({ rootRef, x, y, onClose, reclampKey: items.length });

  return (
    <div
      className="ctx-menu"
      ref={rootRef}
      role="menu"
      data-testid="tab-context-menu"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="ctx-title">{title}</div>
      {items.map((it) => {
        const Icon = ICONS[it.key];
        return (
          <div key={it.key}>
            {it.separatorBefore ? <div className="ctx-sep" /> : null}
            <button
              className={`ctx-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              role="menuitem"
              title={it.disabled ? it.disabledReason : undefined}
              data-testid={`tab-menu-${it.key}`}
              data-action={it.key}
              onClick={() => {
                onClose();
                onAction(it.key);
              }}
            >
              <span className="ctx-ico">
                <Icon size={11} />
              </span>
              <span className="ctx-label">{it.label}</span>
              {it.shortcut ? <span className="ctx-shortcut">{it.shortcut}</span> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
