/**
 * 列头右键菜单（A21，补全竞品清单 A5「列头右键 + 面板」的右键半边）
 *
 * 与 CellContextMenu 同款自绘浮层骨架（视口收敛、点外/Esc/失焦关闭），
 * 刻意不复用其 props —— 两类菜单的条目集不同，共用只会造出参数迷宫。
 *
 * 排序走宿主的 onSortChange 显式方向（'ASC'/'DESC'，null = 取消全部排序）；
 * 复制列名 / 自适应列宽 / 隐藏此列都是 DataGrid 内部能力，直接回调。
 *
 * 本轮追加两个「开关型」条目（V14 列头显示类型 / V19 按此列分组着色）：
 * 开关态用图标位里的 ✓ 表示（勾 = 开，空 = 关），与菜单里其它条目的图标位对齐。
 */

import { useEffect, useRef, useState } from 'react';
import type { SortDirection } from '@dbstudio/core-grid-view';

export interface HeaderContextMenuState {
  /** 视口坐标（contextmenu 事件的 clientX/Y） */
  x: number;
  y: number;
  /** 列名 */
  name: string;
  /** 原始列索引（自适应列宽要用，隐藏列不参与） */
  originalIndex: number;
}

export interface HeaderContextMenuProps {
  menu: HeaderContextMenuState;
  /** 查询结果网格排序是 no-op → false，隐藏排序组 */
  canSort: boolean;
  /** 当前有排序列才启用「取消排序」 */
  hasSort: boolean;
  /** 至少保留 1 列可见（与列显隐面板同一守卫） */
  canHide: boolean;
  /** V8：当前冻结的可见列数（决定菜单文案是「冻结到此列」还是「取消冻结」） */
  frozenCount: number;
  /** V8：本列是第几个可见列（1 起）；冻结到此列 = 冻结前 visiblePos 列 */
  visiblePos: number;
  onClose: () => void;
  onSort: (direction: SortDirection | null) => void;
  onCopyName: () => void;
  onAutoFit: () => void;
  onHide: () => void;
  /** V8：冻结到此列（宿主换算成可见列数） */
  onFreeze: () => void;
  /** V14：当前是否在列头显示数据类型（决定勾选态） */
  showColumnTypes: boolean;
  /** V14：切换「显示列类型」（网格内持久化到 localStorage，宿主不必接线） */
  onToggleShowTypes: () => void;
  /** V19：当前按哪一列分组着色（null = 未开启） */
  groupStripeColumn?: string | null;
  /**
   * V19：切换本列的分组着色（再点一次 = 取消，由 DataGrid 换算成 null 上抛）。
   * 宿主没传 → 菜单项禁用（功能保持关闭，不静默 no-op）。
   */
  onToggleGroupStripe?: () => void;
}

export function HeaderContextMenu({
  menu,
  canSort,
  hasSort,
  canHide,
  frozenCount,
  visiblePos,
  onClose,
  onSort,
  onCopyName,
  onAutoFit,
  onHide,
  onFreeze,
  showColumnTypes,
  onToggleShowTypes,
  groupStripeColumn = null,
  onToggleGroupStripe,
}: HeaderContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  /**
   * V19：本列是否正处于分组着色态（决定勾选态与「取消分组着色」文案）。
   * 口径只有一处 —— 与 DataGrid 里 groupStripeColumn 的比较方式一致（按列名）。
   */
  const stripeOn = groupStripeColumn != null && groupStripeColumn === menu.name;

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
    <div className="gd-ctx-menu" ref={rootRef} role="menu" style={{ left: pos.x, top: pos.y }}>
      <div className="gd-ctx-title">{menu.name}</div>

      {canSort ? (
        <>
          <button type="button" className="gd-ctx-item" role="menuitem" onClick={() => onSort('ASC')}>
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">升序排序</span>
          </button>
          <button type="button" className="gd-ctx-item" role="menuitem" onClick={() => onSort('DESC')}>
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">降序排序</span>
          </button>
          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            disabled={!hasSort}
            title={hasSort ? undefined : '当前没有排序'}
            onClick={() => onSort(null)}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">取消排序</span>
          </button>
          <div className="gd-ctx-sep" />
        </>
      ) : null}

      <button type="button" className="gd-ctx-item" role="menuitem" onClick={onCopyName}>
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">复制列名</span>
      </button>

      {/* V8：冻结到此列。已冻到本列时改为「取消冻结」（toggle 手感与 Excel 一致） */}
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitem"
        data-testid="ctx-freeze"
        onClick={onFreeze}
      >
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">
          {frozenCount === visiblePos && frozenCount > 0 ? '取消冻结' : `冻结到此列（前 ${visiblePos} 列）`}
        </span>
      </button>

      <button type="button" className="gd-ctx-item" role="menuitem" onClick={onAutoFit}>
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">自适应列宽</span>
      </button>
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitem"
        disabled={!canHide}
        title={canHide ? undefined : '至少保留 1 列可见'}
        onClick={onHide}
      >
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">隐藏此列</span>
      </button>

      <div className="gd-ctx-sep" />

      {/* V14：列头显示数据类型（默认关；状态由 DataGrid 持久化到 localStorage） */}
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitemcheckbox"
        aria-checked={showColumnTypes}
        data-testid="ctx-show-types"
        title="列头在列名下方显示数据类型文本（开关持久化在本地）"
        onClick={onToggleShowTypes}
      >
        <span className={`gd-ctx-ico${showColumnTypes ? ' gd-on' : ''}`}>{showColumnTypes ? '✓' : ''}</span>
        <span className="gd-ctx-label">显示列类型</span>
      </button>

      {/* V19：按本列的值给相邻同值行交替着色；再点一次取消。宿主没接线 → 禁用 */}
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitemcheckbox"
        aria-checked={stripeOn}
        data-testid="ctx-group-stripe"
        disabled={!onToggleGroupStripe}
        title={onToggleGroupStripe ? '相邻同值行交替着色，便于看清分组边界' : '宿主未接线，分组着色不可用'}
        onClick={onToggleGroupStripe}
      >
        <span className={`gd-ctx-ico${stripeOn ? ' gd-on' : ''}`}>{stripeOn ? '✓' : ''}</span>
        <span className="gd-ctx-label">{stripeOn ? '取消分组着色' : '按此列分组着色'}</span>
      </button>
    </div>
  );
}
