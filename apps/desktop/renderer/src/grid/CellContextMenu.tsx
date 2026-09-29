/**
 * 网格单元格/行右键菜单（A3，2026-09-27 扩展：A19 行选 / A20 复制为 SQL / A22 快速筛选）
 *
 * 自绘浮层而非 Electron 原生 Menu：跟随 data-theme、样式与查找条/列选择器同族。
 * 实现方式与 tree/TreeContextMenu.tsx 一致（跟随右键坐标、视口内收敛、点外/Esc 关闭），
 * 但刻意不 import tree 目录 —— 两份独立代码，避免网格 ↔ 树的交叉依赖。
 *
 * 🔴 与树右键相同的行为：菜单出现前宿主已把右键的单元格置为聚焦。
 * 关闭路径：点菜单项 / 点外面（capture 捕获）/ Escape / 窗口失焦 / resize。
 * 点外关闭必须放行菜单内部的 pointerdown，否则菜单项的 click 永远收不到。
 *
 * 复制分组语义（与 DataGrid 的实现约定）：
 *  - 「复制选中区」（TSV/CSV/JSON/Markdown）：选区语义 —— 行号勾选优先，其次矩形选区；
 *  - 「复制为 SQL」（INSERT/UPDATE）：**永远整行语义**（全部可见列）——
 *    右键单格产出单列 INSERT 是误导，宿主侧 copyRowsAs 保证。
 */

import { useEffect, useRef, useState } from 'react';
import type { CopyFormat } from '@dbstudio/core-clipboard';
import { IconCopy, IconInfo, IconFn, IconLink, IconBatchEdit } from '../ui/icons';

export interface CellContextMenuState {
  /** 视口坐标（contextmenu 事件的 clientX/Y） */
  x: number;
  y: number;
  row: number;
  /** 原始列索引（隐藏列不渲染但仍占数据位）；行号列右键时为 0 */
  col: number;
  /** 菜单头部显示「列名 · 行号」；行号列右键时为空串 */
  column: string;
  /** A22：右键单元格的展示值；null = 本格是 NULL（筛选组只给「为 NULL」） */
  cellValue: string | null;
  /** A19：打开菜单时的行勾选快照（>1 时标题显示「已选 N 行」） */
  rows: number[];
}

export type QuickFilterOp = 'eq' | 'ne' | 'contains';

export interface CellContextMenuProps {
  menu: CellContextMenuState;
  /** 有选中区（矩形或行勾选）时才启用「复制选中区」一组 */
  hasSelection: boolean;
  /** 本格能否设为 NULL：可编辑，且不是「原始值就是 NULL 且无脏改动」 */
  canSetNull: boolean;
  /** 有脏改动时显示「清除本格改动」 */
  cellDirty: boolean;
  /** 可编辑且宿主接了 onDuplicateRow 时才出现「插入复制行」 */
  canDuplicate: boolean;
  /** A20：有表上下文（database/tableName）才能生成 INSERT */
  canInsert: boolean;
  /** A20：INSERT 基础上还要有定位列（主键/唯一键）才能生成 UPDATE */
  canUpdate: boolean;
  /** A22：宿主接了 onQuickFilter 且右键落在数据列上 */
  canQuickFilter: boolean;
  /**
   * V9：本格是外键值时的跳转说明（`user.name → user.id`）；null = 不是外键列或本格为 NULL。
   * 🔴 判定权在宿主/网格的 fkByColumn，菜单只管显示 —— 不自行判断能否跳转（契约 2）。
   */
  followLabel: string | null;
  /** V10：能否进入「SQL 表达式模式编辑」（可编辑才给） */
  canExprEdit: boolean;
  /** V13：能否批量编辑当前选中列（命中「一列 × 多行」才给，含行数文案） */
  batchLabel: string | null;
  onClose: () => void;
  onCopyCell: () => void;
  onCopySelection: (format: CopyFormat, includeHeader?: boolean) => void;
  /** A20：复制整行为 SQL（行勾选优先，否则右键所在行；全部可见列） */
  onCopyRows: (format: 'insert' | 'update') => void;
  /** A22：快速筛选（value 为 null 时宿主映射 isNull） */
  onQuickFilter: (op: QuickFilterOp) => void;
  /** V9：跳转到引用表的那一行 */
  onFollowForeignKey: () => void;
  /** V10：以 SQL 表达式模式编辑本格 */
  onExprEdit: () => void;
  /** V13：打开批量编辑条 */
  onBatchEdit: () => void;
  onSetNull: () => void;
  onClearCell: () => void;
  onDuplicateRow: () => void;
  onViewFullValue: () => void;
}

/** A17 的展示型复制格式（SQL 两种在「复制为 SQL」组，整行语义） */
const COPY_SUB_ITEMS: { format: CopyFormat; label: string }[] = [
  { format: 'tsv', label: 'TSV（粘进 Excel）' },
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON 数组' },
  { format: 'markdown', label: 'Markdown 表格' },
];

/**
 * 「含列名」的逃生口（2026-09-29）：默认复制**只带值**（用户明确要求），
 * 但把值粘进空表、或要给别人一份自解释的数据时仍需要表头。
 * 只给 TSV/CSV 两种 —— JSON/Markdown/SQL 的列名本就是结构的一部分，
 * 给一个"含列名的 JSON"是伪选项（点了跟不点一样，比不给更让人困惑）。
 */
const COPY_HEADER_ITEMS: { format: CopyFormat; label: string }[] = [
  { format: 'tsv', label: 'TSV（含列名）' },
  { format: 'csv', label: 'CSV（含列名）' },
];

const SQL_ITEMS: { format: 'insert' | 'update'; label: string; hint: string }[] = [
  { format: 'insert', label: 'INSERT 语句', hint: '带真实值，整行' },
  { format: 'update', label: 'UPDATE 语句', hint: '按主键/唯一键定位' },
];

export function CellContextMenu({
  menu,
  hasSelection,
  canSetNull,
  cellDirty,
  canDuplicate,
  canInsert,
  canUpdate,
  canQuickFilter,
  followLabel,
  canExprEdit,
  batchLabel,
  onClose,
  onCopyCell,
  onCopySelection,
  onCopyRows,
  onQuickFilter,
  onFollowForeignKey,
  onExprEdit,
  onBatchEdit,
  onSetNull,
  onClearCell,
  onDuplicateRow,
  onViewFullValue,
}: CellContextMenuProps) {
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
      // 菜单内部的按下不关闭 —— 否则菜单项的 click 事件永远轮不到
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

  const multiRows = menu.rows.length > 1;
  const title = multiRows
    ? `已选 ${menu.rows.length} 行`
    : menu.column
      ? `${menu.column} · 第 ${menu.row + 1} 行`
      : `第 ${menu.row + 1} 行`;

  return (
    <div className="gd-ctx-menu" ref={rootRef} role="menu" style={{ left: pos.x, top: pos.y }}>
      <div className="gd-ctx-title">{title}</div>

      <button type="button" className="gd-ctx-item" role="menuitem" onClick={onCopyCell}>
        <span className="gd-ctx-ico">
          <IconCopy size={11} />
        </span>
        <span className="gd-ctx-label">复制该值</span>
      </button>
      <button type="button" className="gd-ctx-item" role="menuitem" onClick={onViewFullValue}>
        <span className="gd-ctx-ico">
          <IconInfo size={11} />
        </span>
        <span className="gd-ctx-label">查看完整值</span>
      </button>

      {/* V9：外键值导航 —— 跳到引用表的那一行（宿主走既有 locateStrategy 链路） */}
      {followLabel ? (
        <button
          type="button"
          className="gd-ctx-item"
          role="menuitem"
          data-testid="ctx-follow-fk"
          title={followLabel}
          onClick={onFollowForeignKey}
        >
          <span className="gd-ctx-ico">
            <IconLink size={11} />
          </span>
          <span className="gd-ctx-label">跳转到引用行</span>
          <span className="gd-ctx-hint">{followLabel}</span>
        </button>
      ) : null}

      {/* V10：SQL 表达式模式编辑（NOW() 等原样嵌入 UPDATE） */}
      {canExprEdit ? (
        <button
          type="button"
          className="gd-ctx-item"
          role="menuitem"
          data-testid="ctx-expr-edit"
          title="以 SQL 表达式模式编辑本格：填入 NOW() / UUID() / amount * 2，保存时原样嵌进 UPDATE（不做字符串转义）"
          onClick={onExprEdit}
        >
          <span className="gd-ctx-ico">
            <IconFn size={11} />
          </span>
          <span className="gd-ctx-label">SQL 表达式模式编辑</span>
          <span className="gd-ctx-kbd">⇧⌘E</span>
        </button>
      ) : null}

      {/* V13：批量编辑条（命中「一列 × 多行」才出现） */}
      {batchLabel ? (
        <button
          type="button"
          className="gd-ctx-item"
          role="menuitem"
          data-testid="ctx-batch-edit"
          onClick={onBatchEdit}
        >
          <span className="gd-ctx-ico">
            <IconBatchEdit size={11} />
          </span>
          <span className="gd-ctx-label">{batchLabel}</span>
        </button>
      ) : null}

      {/* A17/A19：展示型复制走选区语义（行号勾选优先）；⌘C 默认 TSV */}
      <div className="gd-ctx-group">
        {multiRows ? `复制选中区（${menu.rows.length} 行）` : '复制选中区'}
      </div>
      {COPY_SUB_ITEMS.map((it) => (
        <button
          key={it.format}
          type="button"
          className="gd-ctx-item gd-ctx-sub"
          role="menuitem"
          disabled={!hasSelection}
          onClick={() => onCopySelection(it.format)}
        >
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">{it.label}</span>
        </button>
      ))}
      {COPY_HEADER_ITEMS.map((it) => (
        <button
          key={`${it.format}-header`}
          type="button"
          className="gd-ctx-item gd-ctx-sub"
          role="menuitem"
          disabled={!hasSelection}
          title="首行输出列名（粘进空表或交付给他人时用）"
          onClick={() => onCopySelection(it.format, true)}
        >
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">{it.label}</span>
        </button>
      ))}

      {/* A20：整行 SQL（带真实值，core-clipboard sqlLiteral） */}
      <div className="gd-ctx-group">复制为 SQL（整行）</div>
      {SQL_ITEMS.map((it) => {
        const ok = it.format === 'insert' ? canInsert : canUpdate;
        const hint = !canInsert
          ? '结果集没有可靠的表上下文，无法生成（多表 JOIN / 聚合查询不可用）'
          : it.format === 'update' && !canUpdate
            ? '没有主键/唯一键定位列，无法安全生成 WHERE'
            : it.hint;
        return (
          <button
            key={it.format}
            type="button"
            className="gd-ctx-item gd-ctx-sub"
            role="menuitem"
            disabled={!ok}
            title={ok ? it.hint : hint}
            onClick={() => onCopyRows(it.format)}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">{it.label}</span>
          </button>
        );
      })}

      {/* A22：快速筛选（走既有 FilterModel 链路，值进 ? 占位参数） */}
      {canQuickFilter ? (
        <>
          <div className="gd-ctx-group">筛选</div>
          {menu.cellValue === null ? (
            <button type="button" className="gd-ctx-item gd-ctx-sub" role="menuitem" onClick={() => onQuickFilter('eq')}>
              <span className="gd-ctx-ico" />
              <span className="gd-ctx-label">为 NULL</span>
            </button>
          ) : (
            <>
              <button type="button" className="gd-ctx-item gd-ctx-sub" role="menuitem" onClick={() => onQuickFilter('eq')}>
                <span className="gd-ctx-ico" />
                <span className="gd-ctx-label">等于此值</span>
              </button>
              <button type="button" className="gd-ctx-item gd-ctx-sub" role="menuitem" onClick={() => onQuickFilter('ne')}>
                <span className="gd-ctx-ico" />
                <span className="gd-ctx-label">不等于此值</span>
              </button>
              <button type="button" className="gd-ctx-item gd-ctx-sub" role="menuitem" onClick={() => onQuickFilter('contains')}>
                <span className="gd-ctx-ico" />
                <span className="gd-ctx-label">包含此值</span>
              </button>
            </>
          )}
        </>
      ) : null}

      <div className="gd-ctx-sep" />
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitem"
        disabled={!canSetNull}
        title={canSetNull ? undefined : '不可编辑，或本格原始值已是 NULL'}
        onClick={onSetNull}
      >
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">设为 NULL</span>
        <span className="gd-ctx-kbd">⌘0</span>
      </button>

      {cellDirty ? (
        <button type="button" className="gd-ctx-item" role="menuitem" onClick={onClearCell}>
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">清除本格改动</span>
        </button>
      ) : null}

      {canDuplicate ? (
        <button type="button" className="gd-ctx-item" role="menuitem" onClick={onDuplicateRow}>
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">插入复制行</span>
          <span className="gd-ctx-kbd">⌘D</span>
        </button>
      ) : null}
    </div>
  );
}
