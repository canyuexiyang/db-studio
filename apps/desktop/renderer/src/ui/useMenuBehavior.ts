/**
 * T18（报告 §4.5 通用菜单交互段）：**一套**菜单行为，四类菜单共用。
 *
 * ## 为什么必须共用
 *
 * 树 / 网格 / 单元格 / SQL 四个右键菜单各写了一遍关闭逻辑，于是差异全在细节里：
 *
 * | 能力 | 树 | 网格 | 单元格 | SQL |
 * |---|---|---|---|---|
 * | 视口内收敛（不裁切） | ✅ | ✅ | ✅ | ❌ **直接用 x/y** |
 * | 点外面关闭 | ✅ | ✅ | ✅ | ✅ |
 * | Esc 关闭 | ✅ | ✅ | ✅ | ✅ |
 * | resize / 失焦关闭 | ✅ | ✅ | ✅ | ❌ |
 * | 方向键巡航 / Home / End | ❌ | ❌ | ❌ | ❌ |
 * | Esc 后焦点返回原处 | ❌ | ❌ | ❌ | ❌ |
 *
 * 「先做齐基本交互，再加新动作」—— 新动作加在四份不齐的实现上，只会继续扩大差异。
 *
 * ## 键盘可达性
 *
 * 采用 **roving focus**：菜单打开时**不抢焦点**（右键菜单抢焦点会让 Esc 之后
 * 不知道回哪去），但一按方向键就把焦点落到第一个可选项上，之后 ↑↓ 巡航、
 * Home/End 跳首尾，Enter/Space 走 `<button>` 的原生行为。
 *
 * Esc（含点选后关闭）把焦点**还回打开菜单前的元素**，而不是丢给 body ——
 * 键盘用户按 Esc 之后要继续用树/网格，焦点掉到 body 就等于「迷路」。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isImeComposing } from './imeGuard';

/** 菜单与视口边缘留的空白（右下角弹出时不贴边、不裁切） */
const VIEWPORT_MARGIN = 8;

export interface MenuBehaviorOptions {
  /** 菜单根节点 */
  rootRef: RefObject<HTMLElement | null>;
  /** 期望位置（视口坐标，来自 contextmenu 事件的 clientX/Y） */
  x: number;
  y: number;
  onClose: () => void;
  /**
   * 菜单内容变化的标识（如 item 数量）。
   * 尺寸会随之变化，需要重新收敛 —— 否则「筛选后变矮」的菜单会停在旧位置上。
   */
  reclampKey?: unknown;
}

/** 返回收敛后的位置，直接喂给菜单根节点的 style */
export function useMenuBehavior({ rootRef, x, y, onClose, reclampKey }: MenuBehaviorOptions): {
  x: number;
  y: number;
} {
  const [pos, setPos] = useState({ x, y });

  /**
   * 打开菜单前的焦点元素。
   * 在**首次渲染**时读取 —— 此时菜单还没抢焦点（本 hook 刻意不自动聚焦）。
   */
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  // 渲染后按实际尺寸收敛到视口内（右下角弹出时不裁切）
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - VIEWPORT_MARGIN)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - VIEWPORT_MARGIN)),
    });
  }, [rootRef, x, y, reclampKey]);

  useEffect(() => {
    /** 当前可聚焦的菜单项（禁用的项跳过 —— 它们是「明说做不到」，不是巡航节点） */
    const focusables = (): HTMLElement[] =>
      Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
      );

    const onPointerDown = (e: PointerEvent): void => {
      // 菜单内部的按下不关闭 —— 否则 menuitem 的 click 事件永远轮不到
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // T13：组合期的 Enter/Esc 属于输入法（确认/取消候选词），不是菜单操作
      if (isImeComposing(e)) return;
      const list = focusables();
      if (list.length === 0) return;
      const active = document.activeElement;
      const idx = active instanceof HTMLElement ? list.indexOf(active) : -1;

      switch (e.key) {
        case 'Escape':
          onClose();
          // §4.5：Esc 返回原焦点，而不是让焦点掉到 body
          returnFocusRef.current?.focus?.();
          e.preventDefault();
          return;
        case 'ArrowDown':
          // 首次按下时 idx = -1 → 落到第一项（菜单打开时刻意不抢焦点）
          (list[idx + 1] ?? list[0])?.focus();
          e.preventDefault();
          return;
        case 'ArrowUp':
          (list[idx - 1] ?? list[list.length - 1])?.focus();
          e.preventDefault();
          return;
        case 'Home':
          list[0]?.focus();
          e.preventDefault();
          return;
        case 'End':
          list[list.length - 1]?.focus();
          e.preventDefault();
          return;
        default:
          return;
      }
    };

    const onBlur = (): void => onClose();
    const onResize = (): void => onClose();

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    };
  }, [rootRef, onClose]);

  return pos;
}
