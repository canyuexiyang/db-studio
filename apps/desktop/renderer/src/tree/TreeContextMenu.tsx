/**
 * 树右键菜单（Navicat 式，PRD §6.2 各级别操作入口）
 *
 * 自绘浮层而非 Electron 原生 Menu：跟随 data-theme 主题、样式与命令面板同族。
 * 关闭路径：点菜单项 / 点外面（capture 捕获）/ Escape / 窗口失焦 / resize。
 * 🔴 点外关闭必须放行菜单内部的 pointerdown —— 否则菜单项的 click 永远收不到。
 */

import { useRef } from 'react';
import { useMenuBehavior } from '../ui/useMenuBehavior';

export interface ContextMenuItem {
  key: string;
  label: string;
  /** 可选图标（ui/icons.tsx 的 SVG） */
  icon?: React.ReactNode;
  /** 快捷键提示（纯展示） */
  shortcut?: string;
  /** 危险动作：红色文本 + 红色 hover */
  danger?: boolean;
  disabled?: boolean;
  /**
   * T14/T18：禁用原因。**禁用而不说原因**比不显示这一项更糟 —— 用户只会以为
   * 「软件坏了」。悬停可见（title），且与原生菜单/工具栏用同一套措辞。
   */
  disabledReason?: string;
  /** 该项上方画分隔线 */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface TreeContextMenuState {
  /** 视口坐标（contextmenu 事件的 clientX/Y） */
  x: number;
  y: number;
  /** 菜单头部显示的节点名 */
  title?: string;
  items: ContextMenuItem[];
}

export function TreeContextMenu({ menu, onClose }: { menu: TreeContextMenuState; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // T18：边界钳制 + 键盘巡航（↑↓/Home/End）+ Esc 返回原焦点 —— 四类菜单共用一套
  const pos = useMenuBehavior({ rootRef, x: menu.x, y: menu.y, onClose });

  return (
    <div className="ctx-menu" ref={rootRef} role="menu" style={{ left: pos.x, top: pos.y }}>
      {menu.title ? <div className="ctx-title">{menu.title}</div> : null}
      {menu.items.map((it) => (
        <div key={it.key}>
          {it.separatorBefore ? <div className="ctx-sep" /> : null}
          <button
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            role="menuitem"
            title={it.disabled ? it.disabledReason : undefined}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="ctx-ico">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.shortcut ? <span className="ctx-shortcut">{it.shortcut}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
