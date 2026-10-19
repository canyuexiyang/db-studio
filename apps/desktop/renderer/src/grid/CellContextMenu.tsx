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

import { useRef, useState } from 'react';
import type { CopyFormat } from '@dbstudio/core-clipboard';
import { IconCopy, IconInfo, IconFn, IconLink, IconBatchEdit } from '../ui/icons';
// T11/T50：键位提示从动作目录取（原手写的 ⇧⌘E 已被裁定让位给「导出数据」）
import { displayOf } from '../../../src/shared/action-catalog.js';
import { useMenuBehavior } from '../ui/useMenuBehavior';
import type { MenuItemState } from './editors/valueEditorModel';

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
  /**
   * 本格是否有待提交改动（T25「撤销本格」的开关；同时进「值编辑」组标题的提示）。
   * 与 canSetNull 刻意分开 —— 「已是原始 NULL」不是待提交改动。
   */
  cellDirty: boolean;
  /** 可编辑且宿主接了 onDuplicateRow 时才出现「插入复制行」 */
  canDuplicate: boolean;
  /**
   * T19：可编辑且宿主接了 onAddBlankRow 时才出现「新增空白行」。
   * 与「插入复制行」并列但**不等价**：复制行需要源行，空表上只有它能用。
   */
  canAddBlankRow: boolean;
  /**
   * T20：删除「菜单打开时选中的那些行」。要求可编辑（删除必须有定位键才能生成安全 WHERE），
   * 且至少选中 1 行。行号右键与单元格右键都提供 —— 但行号右键是它的主场。
   */
  canDeleteRows: boolean;
  /** T20：撤销选中行的**全部**脏格改动（行级撤销，不是单格） */
  canDiscardRows: boolean;
  /** T20：删除的行数文案由宿主给（菜单不自己数，避免与 selection 语义两处实现） */
  deleteRowsLabel: string;
  /** T20：不可删除时的**具体**原因（悬停可见；空串表示「可以说得清就别说」= 不显示 title） */
  deleteDisabledReason: string;
  /** A20：有表上下文（database/tableName）才能生成 INSERT */
  canInsert: boolean;
  /** A20：INSERT 基础上还要有定位列（主键/唯一键）才能生成 UPDATE */
  canUpdate: boolean;
  /** A22：宿主接了 onQuickFilter 且右键落在数据列上 */
  canQuickFilter: boolean;
  /**
   * T23：单列 IN 清单可用时的文案（含列名与去重后的值个数，如
   * `order_no → IN 清单（3 个值）`）；null = 当前上下文给不出一列值。
   *
   * 🔴 单列语义与「整行 SQL」严格分开：IN 清单只取**一列**的值（报告 §5 D20 的
   *    「复制 ID 去写 SQL」），一旦把多列混进来，用户拿到的就是一条语法不通的 IN。
   */
  singleColumnInLabel: string | null;
  /**
   * V9：本格是外键值时的跳转说明（`user.name → user.id`）；null = 不是外键列或本格为 NULL。
   * 🔴 判定权在宿主/网格的 fkByColumn，菜单只管显示 —— 不自行判断能否跳转（契约 2）。
   */
  followLabel: string | null;
  /** V10：能否进入「SQL 表达式模式编辑」（可编辑才给） */
  canExprEdit: boolean;
  /** V13：能否批量编辑当前选中列（命中「一列 × 多行」才给，含行数文案） */
  batchLabel: string | null;
  /**
   * T33（报告 §5 R16）：「查看完整值」**必须**有宿主回调才显示。
   *
   * 🔴 此前两条分支（`onInspectCell` 优先，退化到 `onCellActivated`）都写在
   *    DataGrid 里，宿主一个都没接时菜单项仍然画成可用 —— 点了什么也不发生。
   *   判定改到宿主侧：`onInspectCell` 或 `onCellActivated` 至少一个存在才画。
   */
  canViewFullValue: boolean;
  // ---- T25：四个值编辑动作（可用性 + 禁用原因都来自纯逻辑层）----
  /** 「编辑值…」 */
  editValueState: MenuItemState;
  /** 「设为空串」：数值/日期/JSON 列不接受空串 → 禁用并给**列类型**原因 */
  setEmptyState: MenuItemState;
  /** 「使用默认值」：UPDATE 语境产出 `SET col = DEFAULT`；INSERT 语境去掉该列 */
  useDefaultState: MenuItemState;
  /** 「使用默认值」的语境说明（INSERT 省略列 vs UPDATE DEFAULT） */
  useDefaultHint: string;
  /** 「撤销本格」：没有待提交改动时禁用 */
  discardCellState: MenuItemState;
  /** 「设为 NULL」不可用时的具体原因（缺省用既有文案） */
  setNullDisabledReason?: string;
  /** 本列类型名（进「值编辑」组标题，禁用原因里也要带） */
  columnDataType: string;
  onClose: () => void;
  /** T25：打开类型专用编辑器（ENUM 下拉 / 日期时间 / 多行文本） */
  onEditValue: () => void;
  /** T25：写入空串 `''`（**不是** NULL） */
  onSetEmptyString: () => void;
  /** T25：使用数据库默认值（UPDATE → `SET col = DEFAULT`；INSERT → 省略该列） */
  onUseDefault: () => void;
  /** T25：撤销本格待提交改动（回到原始值） */
  onDiscardCell: () => void;
  onCopyCell: () => void;
  onCopySelection: (format: CopyFormat, includeHeader?: boolean) => void;
  /** A20：复制整行为 SQL（行勾选优先，否则右键所在行；全部可见列） */
  onCopyRows: (format: 'insert' | 'update') => void;
  /** T23：复制单列 IN 清单（只用右键那一列的值，NULL/去重/上限的规则在 core-clipboard） */
  onCopyInList: () => void;
  /** A22：快速筛选（value 为 null 时宿主映射 isNull） */
  onQuickFilter: (op: QuickFilterOp) => void;
  /** V9：跳转到引用表的那一行 */
  onFollowForeignKey: () => void;
  /** V10：以 SQL 表达式模式编辑本格 */
  onExprEdit: () => void;
  /** V13：打开批量编辑条 */
  onBatchEdit: () => void;
  onSetNull: () => void;
  onDuplicateRow: () => void;
  /** T19：新增空白行 */
  /** T19：宿主接的「新增空白行」 */
  onAddBlankRow: () => void;
  /** T20：删除菜单打开时选中的那些行 */
  onDeleteRows: () => void;
  /** T20：撤销选中行的全部脏格改动 */
  onDiscardRows: () => void;
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
  canAddBlankRow,
  canDeleteRows,
  canDiscardRows,
  deleteRowsLabel,
  deleteDisabledReason,
  canInsert,
  canUpdate,
  canQuickFilter,
  singleColumnInLabel,
  followLabel,
  canExprEdit,
  batchLabel,
  canViewFullValue,
  editValueState,
  setEmptyState,
  useDefaultState,
  useDefaultHint,
  discardCellState,
  setNullDisabledReason,
  columnDataType,
  onClose,
  onCopyCell,
  onCopySelection,
  onCopyRows,
  onCopyInList,
  onQuickFilter,
  onFollowForeignKey,
  onExprEdit,
  onBatchEdit,
  onSetNull,
  onDuplicateRow,
  onAddBlankRow,
  onDeleteRows,
  onDiscardRows,
  onViewFullValue,
  onEditValue,
  onSetEmptyString,
  onUseDefault,
  onDiscardCell,
}: CellContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * T22：复制格式收进**二级面板**（报告 §5 D20：格式全部铺开、菜单过长）。
   *
   * 为什么是「就地换页」而不是「悬停弹出的浮层」：
   *  - 悬停子菜单要多一套定位 + 鼠标路径判定，而 T18 的 roving focus 也得跟着改；
   *  - 就地换页天然继承既有的 Esc / ↑↓ / Home / End / 点外面关闭，零新交互代码。
   * 代价是多一次点击，换来的是顶层菜单从十几个项缩回一屏内。
   */
  const [section, setSection] = useState<'root' | 'copy'>('root');
  // T18：边界钳制 + 键盘巡航（↑↓/Home/End）+ Esc 返回原焦点 —— 四类菜单共用一套
  // reclampKey=section：换页后菜单高度变了，必须重新收敛，否则底部会被裁掉
  const pos = useMenuBehavior({ rootRef, x: menu.x, y: menu.y, onClose, reclampKey: section });

  const multiRows = menu.rows.length > 1;
  const title = multiRows
    ? `已选 ${menu.rows.length} 行`
    : menu.column
      ? `${menu.column} · 第 ${menu.row + 1} 行`
      : `第 ${menu.row + 1} 行`;

  /**
   * T20：菜单开在**行号列**上（宿主的 `onGutterContextMenu` 传 `column: ''`）。
   *
   * 行号右键必须是一份**行菜单**，不能是单元格菜单的复制品 —— 两个理由：
   *  1. 「复制该值 / 查看完整值」在行号上只能拿**首列**的值充当「这一行」，
   *     而首列是 id 还是 note 纯属偶然（报告 §5 D17 明确要求
   *     **不以首列值当作用户操作目标**）。指着一个值说「这是这一行」，是误导。
   *  2. 单元格专属动作（设为 NULL / 表达式编辑 / 快速筛选 / 撤销本格）在行号上
   *     没有作用对象 —— 点下去要么无反应要么猜一列，两种都是假 UI。
   *
   * 保留「复制选中区 / 复制为 SQL（整行）」：它们本来就是**整行语义**，
   * 行号右键正是最自然的入口。
   */
  const isGutter = menu.column === '';

  /**
   * T22：复制二级面板。
   *
   * 🔴 分组刻意按「用户想干什么」而不是「有什么格式」来切：
   *    选中区（原样）/ 含列名（要交给别人或粘进空表）/ 整行 SQL（带真实值）/ 单列 IN（去写查询）。
   *    报告 §5 D20 要求「明确选区和整行，避免用户选一格却复制敏感的整行而不知情」——
   *    所以「选中区」与「整行 SQL」是**两个分开的组**，组名直接写清作用域，
   *    而不是靠用户去猜某个格式到底复制了几列。
   */
  if (section === 'copy') {
    return (
      <div className="gd-ctx-menu" ref={rootRef} role="menu" style={{ left: pos.x, top: pos.y }}>
        <div className="gd-ctx-title">
          复制{multiRows ? `（已选 ${menu.rows.length} 行）` : menu.column ? ` · ${menu.column}` : ''}
        </div>

        <button
          type="button"
          className="gd-ctx-item"
          role="menuitem"
          data-testid="ctx-copy-back"
          onClick={() => setSection('root')}
        >
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">← 返回</span>
        </button>

        {!isGutter ? (
          <>
            <div className="gd-ctx-group">当前值</div>
            <button
              type="button"
              className="gd-ctx-item gd-ctx-sub"
              role="menuitem"
              data-testid="ctx-copy-current"
              onClick={onCopyCell}
            >
              <span className="gd-ctx-ico" />
              <span className="gd-ctx-label">复制该值</span>
            </button>
          </>
        ) : null}

        <div className="gd-ctx-group">选中区（只含选中的列，不含其他列）</div>
        {COPY_SUB_ITEMS.map((it) => (
          <button
            key={it.format}
            type="button"
            className="gd-ctx-item gd-ctx-sub"
            role="menuitem"
            disabled={!hasSelection}
            title={hasSelection ? undefined : '当前没有选中区'}
            onClick={() => onCopySelection(it.format)}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">{it.label}</span>
          </button>
        ))}

        <div className="gd-ctx-group">含列名（首行是列名）</div>
        {COPY_HEADER_ITEMS.map((it) => (
          <button
            key={`${it.format}-header`}
            type="button"
            className="gd-ctx-item gd-ctx-sub"
            role="menuitem"
            disabled={!hasSelection}
            title={hasSelection ? '首行输出列名（粘进空表或交付给他人时用）' : '当前没有选中区'}
            onClick={() => onCopySelection(it.format, true)}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">{it.label}</span>
          </button>
        ))}

        <div className="gd-ctx-group">
          整行 SQL（{multiRows ? `${menu.rows.length} 行` : '全部可见列'}，带真实值）
        </div>
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

        {singleColumnInLabel ? (
          <>
            <div className="gd-ctx-group">单列 IN 清单（去写查询）</div>
            <button
              type="button"
              className="gd-ctx-item gd-ctx-sub"
              role="menuitem"
              data-testid="ctx-copy-in-list"
              title={singleColumnInLabel}
              onClick={onCopyInList}
            >
              <span className="gd-ctx-ico" />
              <span className="gd-ctx-label">{singleColumnInLabel}</span>
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="gd-ctx-menu" ref={rootRef} role="menu" style={{ left: pos.x, top: pos.y }}>
      <div className="gd-ctx-title">{title}</div>

      {!isGutter ? (
        <>
      <button type="button" className="gd-ctx-item" role="menuitem" onClick={onCopyCell}>
        <span className="gd-ctx-ico">
          <IconCopy size={11} />
        </span>
        <span className="gd-ctx-label">复制该值</span>
      </button>
      {/*
        T33（报告 §5 R16）：**无回调就不显示**。
        SQL 结果网格（ResultGrid）此前既没接 `onInspectCell` 也没接 `onCellActivated`，
        这一项画出来点了没反应 —— 假 UI。宿主两条里接了任意一条才画。
      */}
      {canViewFullValue ? (
        <button type="button" className="gd-ctx-item" role="menuitem" data-testid="ce-ctx-view-full" onClick={onViewFullValue}>
          <span className="gd-ctx-ico">
            <IconInfo size={11} />
          </span>
          <span className="gd-ctx-label">查看完整值</span>
        </button>
      ) : null}

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
          <span className="gd-ctx-kbd">{displayOf('grid-expr-mode') ?? '⌘E'}</span>
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

        </>
      ) : null}

      {/* T22：复制**整体**收进二级面板 —— 顶层不再一次铺开 10 个格式项（报告 §5 D20）。
          入口文案写清是「整个选区」还是「整行」，避免用户以为复制的是眼前这一格。 */}
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitem"
        data-testid="ctx-copy-open"
        title={
          multiRows
            ? `复制 ${menu.rows.length} 行的内容（可选只选区、含列名、或整行 SQL）`
            : '复制当前值 / 选中区 / 含列名 / 整行 SQL / 单列 IN 清单'
        }
        onClick={() => setSection('copy')}
      >
        <span className="gd-ctx-ico">
          <IconCopy size={11} />
        </span>
        <span className="gd-ctx-label">
          复制…{hasSelection ? (multiRows ? `（选中 ${menu.rows.length} 行）` : '（有选区）') : ''}
        </span>
        <span className="gd-ctx-kbd">▸</span>
      </button>

      {/* A22：快速筛选（走既有 FilterModel 链路，值进 ? 占位参数）
          T20：单元格专属 —— 行号上没有「这一格的值」可言 */}
      {canQuickFilter && !isGutter ? (
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

      {/*
        T25：值编辑组 —— 「编辑值… / 设为空串 / 设为 NULL / 使用默认值 / 撤销本格」。
        四条显式入口**并列**，刻意与「设为 NULL」同级：此前只有「设为 NULL」一个显式入口，
        「清空字符串」只能靠在输入框里删空（是否真的落了空串全看失焦路径），
        「使用默认值」更是完全没有入口（EMPTY/DEFAULT 缺对等入口，即需求原文的问题点）。

        🔴 每条要么可点（有真实回调），要么 disabled + **具体**原因（列类型 / 只读）。
      */}
      {!isGutter ? (
        <>
          <div className="gd-ctx-sep" />
          <div className="gd-ctx-group">
            值编辑 · {columnDataType || '未知类型'}
            {cellDirty ? '（本格有待提交改动）' : ''}
          </div>

          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            data-testid="ce-ctx-edit-value"
            disabled={!editValueState.enabled}
            title={editValueState.enabled ? '打开专用编辑器（ENUM 下拉 / 日期时间 / 多行文本）' : editValueState.reason}
            onClick={onEditValue}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">编辑值…</span>
          </button>

          {/* 空串：与 NULL 是**两个不同的值**，走同一条字面量通道但值不同 */}
          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            data-testid="ce-ctx-set-empty"
            disabled={!setEmptyState.enabled}
            title={setEmptyState.enabled ? "写入空串 ''（不是 NULL）" : setEmptyState.reason}
            onClick={onSetEmptyString}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">设为空串</span>
            <span className="gd-ctx-kbd">''</span>
          </button>

          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            data-testid="ce-ctx-set-null"
            disabled={!canSetNull}
            title={canSetNull ? '写入 SQL NULL（不是空串）' : setNullDisabledReason || '不可编辑，或本格原始值已是 NULL'}
            onClick={onSetNull}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">设为 NULL</span>
            <span className="gd-ctx-kbd">{displayOf('grid-set-null') ?? '⌥0'}</span>
          </button>

          {/*
            「使用默认值」：INSERT 与 UPDATE 是**两条不同的路**，菜单 title 里明说。
            - INSERT（新行）：从 INSERT 列表里去掉这一列 → 数据库填 DEFAULT；
            - UPDATE（已有行）：`SET col = DEFAULT`（MySQL 关键字，不是字符串 'DEFAULT'）。
          */}
          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            data-testid="ce-ctx-use-default"
            disabled={!useDefaultState.enabled}
            title={useDefaultState.enabled ? useDefaultHint : useDefaultState.reason}
            onClick={onUseDefault}
          >
            <span className="gd-ctx-ico">
              <IconFn size={11} />
            </span>
            <span className="gd-ctx-label">使用默认值</span>
            <span className="gd-ctx-kbd">DEFAULT</span>
          </button>

          {/*
            「撤销本格」= 清掉本格的待提交改动回到原始值。
            与旧的「清除本格改动」同义，但**始终显示**：没有改动时 disabled + 原因
            （「本格没有待提交的改动」），而不是凭空消失 —— 消失会让用户以为动作丢了。
          */}
          <button
            type="button"
            className="gd-ctx-item"
            role="menuitem"
            data-testid="ce-ctx-discard-cell"
            disabled={!discardCellState.enabled}
            title={discardCellState.enabled ? '撤销本格待提交改动，回到库中原值' : discardCellState.reason}
            onClick={onDiscardCell}
          >
            <span className="gd-ctx-ico" />
            <span className="gd-ctx-label">撤销本格</span>
          </button>
        </>
      ) : null}

      {/* T20：行级动作组 —— 行号右键的主场，单元格右键同样给（整行语义） */}
      <div className="gd-ctx-sep" data-testid="ctx-row-group-sep" />
      <div className="gd-ctx-group">行操作</div>

      {canAddBlankRow ? (
        <button type="button" className="gd-ctx-item" role="menuitem" onClick={onAddBlankRow} data-testid="ctx-add-row">
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">新增空白行</span>
          <span className="gd-ctx-kbd">{displayOf('grid-add-row') ?? '⌥⌘N'}</span>
        </button>
      ) : null}

      {canDuplicate ? (
        <button type="button" className="gd-ctx-item" role="menuitem" onClick={onDuplicateRow} data-testid="ctx-duplicate-row">
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">插入复制行</span>
          <span className="gd-ctx-kbd">⌘D</span>
        </button>
      ) : null}

      {/* T20：删除选中行。禁用时给**具体**原因（无定位键 / 未选中行 / 只读连接）——
          「能点但报错」是假 UI，这一项尤其不能那样。 */}
      <button
        type="button"
        className="gd-ctx-item"
        role="menuitem"
        data-testid="ctx-delete-rows"
        disabled={!canDeleteRows}
        title={canDeleteRows ? undefined : deleteDisabledReason}
        onClick={onDeleteRows}
      >
        <span className="gd-ctx-ico" />
        <span className="gd-ctx-label">{deleteRowsLabel}</span>
        <span className="gd-ctx-kbd">{displayOf('grid-delete-rows') ?? '⌘⌫'}</span>
      </button>

      {/* T20：行级撤销 —— 只撤销**选中行**的脏格，不牵连其他行的未保存改动 */}
      {canDiscardRows ? (
        <button type="button" className="gd-ctx-item" role="menuitem" data-testid="ctx-discard-rows" onClick={onDiscardRows}>
          <span className="gd-ctx-ico" />
          <span className="gd-ctx-label">撤销选中行的改动</span>
        </button>
      ) : null}
    </div>
  );
}
