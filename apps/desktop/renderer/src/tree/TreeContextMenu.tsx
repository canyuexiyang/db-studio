/**
 * 树右键菜单（Navicat 式，PRD §6.2 各级别操作入口）
 *
 * 自绘浮层而非 Electron 原生 Menu：跟随 data-theme 主题、样式与命令面板同族。
 * 关闭路径：点菜单项 / 点外面（capture 捕获）/ Escape / 窗口失焦 / resize。
 * 🔴 点外关闭必须放行菜单内部的 pointerdown —— 否则菜单项的 click 永远收不到。
 */

import { useEffect, useRef, useState } from 'react';

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
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // 渲染后按实际尺寸做视口内收敛（右下角弹出时不裁切）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      // 菜单内部的按下不关闭 —— 否则 menuitem 的 click 事件永远轮不到
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

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
