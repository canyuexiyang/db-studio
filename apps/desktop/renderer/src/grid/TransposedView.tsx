/**
 * V12 结果集转置视图（DataGrip「View options → Transpose」）
 *
 * 定位：**宽表的另一种视角**，不是网格的替代品。转置后「一行 = 一个字段，
 * 一列 = 一条数据行」，字段名钉在左侧（sticky），数据行方向做横向虚拟滚动。
 *
 * 🔴 三条纪律（PRD §二 V12 / 红线 8）：
 *  1. **永不 decodeAll()**：只解横向可视区的数据行（`source.decodeRange`），
 *     区间由 core-grid-view 的 `computeTransposedVisibleRows` 算（与纵向同一套
 *     线性公式，只是行高↔列宽、行数↔数据行数互换）。
 *  2. **滚动路径零对象分配**：onScroll 只写两个数字 state；单元格取值走
 *     已解码的二维数组下标，不做字符串拼接、不建中间对象。
 *  3. **纯前端渲染变换**：不产生新查询、不改动数据源、不碰脏单元格。
 *
 * 为什么是独立组件而不是 DataGrid 的一个 flag：
 *  DataGrid 的虚拟滚动是纵向的、选择模型/编辑/拖选都建立在「行=数据行」上。
 *  转置把这套前提整个翻过来，用 flag 分支会让两条滚动路径互相污染 ——
 *  而转置态的真实诉求是「看清楚一条记录的每个字段」，不需要编辑与拖选。
 *  所以这里做成**只读的查看模式**，语义在 UI 上明示（见底部说明条）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeTransposedVisibleRows,
  canTranspose,
  clampCell,
  normalizeRange,
  selectionStats,
  type CellRange,
  type CellPos,
} from '@dbstudio/core-grid-view';
import { rowsFromSelection, serializeCopy, cellToDisplay } from '@dbstudio/core-clipboard';
import { IconX, IconCopy } from '../ui/icons';
import type { GridColumn } from './DataGrid';
import type { GridDataSource } from './useGridData';

/** 转置视图里「一条数据行」占的列宽（固定值：转置是查看模式，不做逐列宽记忆） */
const TRANSPOSED_COL_WIDTH = 180;
/** 字段名列宽（sticky 左钉） */
const FIELD_COL_WIDTH = 180;

export interface TransposedViewProps {
  source: GridDataSource;
  /** 全量列（含隐藏列），下标 = 原始列索引 */
  columns: GridColumn[];
  /** 可见列的原始下标（隐藏列不渲染，口径与 DataGrid 一致） */
  visibleOriginalIndexes: number[];
  rowHeight: number;
  onClose: () => void;
  /** ⌘C 复制后通知宿主（可选，与 DataGrid 的 onCopy 同语义） */
  onCopied?: () => void;
  database?: string;
  tableName?: string;
}

export function TransposedView({
  source,
  columns,
  visibleOriginalIndexes,
  rowHeight,
  onClose,
  onCopied,
  database,
  tableName,
}: TransposedViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);

  const rowCount = source.totalRows;
  const fieldCount = visibleOriginalIndexes.length;
  const gate = useMemo(() => canTranspose(fieldCount), [fieldCount]);

  // 视口宽度：ResizeObserver 拿真实值（与 DataGrid 同款做法，避免首帧算出 0 列）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /**
   * 横向可视区（= 需要解码的数据行区间）。
   * 🔴 只解这一段：滚动到十万行也只解视口内的十来行。
   */
  const vis = useMemo(
    () =>
      computeTransposedVisibleRows({
        scrollLeft,
        viewportWidth,
        rowWidth: TRANSPOSED_COL_WIDTH,
        rowCount,
      }),
    [scrollLeft, viewportWidth, rowCount],
  );

  const rows = useMemo(
    () => source.decodeRange(vis.start, vis.end),
    // 脏单元格变化后要重解（与 DataGrid 的 selVersion 同理，这里没有选区版本，
    // 靠 source 的引用变化 + 区间变化触发）
    [source, vis.start, vis.end],
  );

  // ---- 选择：转置坐标系（row = 字段序号，col = 数据行序号） ----
  const [focus, setFocus] = useState<CellPos>({ row: 0, col: 0 });
  const [anchor, setAnchor] = useState<CellPos>({ row: 0, col: 0 });

  /** 选区矩形（转置坐标）。单格 = anchor 与 focus 相同 */
  const range: CellRange = useMemo(
    () => normalizeRange({ r0: anchor.row, c0: anchor.col, r1: focus.row, c1: focus.col }),
    [anchor, focus],
  );

  const maxField = Math.max(0, fieldCount - 1);
  const maxRow = Math.max(0, rowCount - 1);

  const moveFocus = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      setFocus((prev) => {
        const next = clampCell({ row: prev.row + dRow, col: prev.col + dCol }, fieldCount, rowCount);
        if (!extend) setAnchor(next);
        return next;
      });
    },
    [fieldCount, rowCount],
  );

  /** 把焦点列（= 数据行）滚进视口：转置视图里横向才是数据方向 */
  const revealCol = useCallback(
    (col: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const left = col * TRANSPOSED_COL_WIDTH;
      const right = left + TRANSPOSED_COL_WIDTH;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [],
  );

  /** 把焦点行（= 字段）滚进视口（纵向） */
  const revealRow = useCallback(
    (row: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const top = row * rowHeight;
      const bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [rowHeight],
  );

  useEffect(() => {
    revealCol(focus.col);
    revealRow(focus.row);
  }, [focus, revealCol, revealRow]);

  /**
   * 🔴 Escape 必须挂 window（capture），不能只挂 viewport。
   *
   * 踩过：Esc 只写在 viewport 的 onKeyDown 里，点击单元格后焦点若没落到
   * viewport（React 事件批处理 / 浏览器把焦点给了 body），按 Esc 就毫无反应 ——
   * 用户被**困在转置视图里出不来**，只能用工具栏按钮。
   * 与 CellContextMenu / HeaderContextMenu 的关闭路径同款做法。
   * 方向键/⌘C/⌘A 仍留在 viewport 的 onKeyDown：那些需要焦点才有意义
   * （焦点在别处时移动转置选区是错的）。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  /**
   * 挂载即取焦点。
   * 🔴 用 effect 而不是 JSX 的 autoFocus：autoFocus 只在元素**首次挂载**时生效，
   *    而转置视图是在既有 grid 容器里条件渲染的，某些情况下 React 复用宿主节点，
   *    autoFocus 会被跳过 —— 用户进来就要先点一下才能用方向键/⌘C。
   *    焦点治理纪律：新增交互组件必须自己管好 focus 流转。
   */
  useEffect(() => {
    viewportRef.current?.focus();
  }, []);

  /**
   * ⌘C 复制选中区。
   *
   * 口径明示（PRD 要求「按视觉行还是按数据行」必须定义并在 UI 上说明）：
   * **按数据行** —— 复制出来的是「若干条记录 × 若干字段」的正常表格，
   * 可以直接粘进 Excel。理由：复制的用途是带走数据，视觉上的转置只是
   * 查看姿态，粘出去还是转置的会变成用户的麻烦。
   */
  const copySelection = useCallback(() => {
    // 转置坐标 → 数据坐标：数据行 = 转置的 col，字段（原始列）= 转置的 row
    const dataRanges: CellRange[] = [
      { r0: range.c0, c0: range.r0, r1: range.c1, c1: range.r1 },
    ];
    const columnIndexes: number[] = [];
    for (let f = range.r0; f <= range.r1; f++) {
      const orig = visibleOriginalIndexes[f];
      if (orig !== undefined) columnIndexes.push(orig);
    }
    const res = rowsFromSelection({
      ranges: dataRanges,
      focusRow: range.c0,
      selectedRows: [],
      rowCount,
      colCount: columns.length,
      columnIndexes,
      valueAt: (r, c) => source.value(r, c),
    });
    if (res.rows.length === 0) return false;
    const names = res.columnIndexes.map((i) => columns[i]?.name ?? `列${i + 1}`);
    const text = serializeCopy({ format: 'tsv', columns: names, rows: res.rows, database, table: tableName });
    if (!text) return false;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    return true;
  }, [range, visibleOriginalIndexes, rowCount, columns, source, database, tableName]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        moveFocus(-1, 0, e.shiftKey);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        moveFocus(1, 0, e.shiftKey);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowLeft') {
        moveFocus(0, -1, e.shiftKey);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowRight') {
        moveFocus(0, 1, e.shiftKey);
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'a') {
        // 全选：转置坐标下的整块（= 全部字段 × 全部数据行）
        setAnchor({ row: 0, col: 0 });
        setFocus({ row: maxField, col: maxRow });
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === 'c') {
        if (copySelection()) onCopied?.();
        e.preventDefault();
      }
    },
    [moveFocus, onClose, copySelection, onCopied, maxField, maxRow],
  );

  const summary = useMemo(
    () => selectionStats([range], [], columns.length),
    [range, columns.length],
  );

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.target as HTMLDivElement;
    // 🔴 滚动热路径：只写两个数字，不做任何计算/分配
    setScrollLeft(el.scrollLeft);
  }, []);

  if (!gate.ok) {
    return (
      <div className="gd-transpose" data-testid="transposed-view">
        <div className="gd-transpose-bar">
          <span className="gd-transpose-hint">{gate.reason}</span>
          <button type="button" className="gd-tool-btn" title="退出转置（Esc）" onClick={onClose}>
            <IconX size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gd-transpose" data-testid="transposed-view">
      <div className="gd-transpose-bar">
        <span className="gd-transpose-title">转置视图</span>
        <span className="gd-transpose-hint">
          一行 = 一个字段，一列 = 一条记录 · 只读查看（编辑请先退出转置）
        </span>
        <span className="gd-tool-spacer" />
        <span className="gd-transpose-count" data-testid="transpose-summary">
          选中 {summary.rows} 行 / {summary.cells} 格
        </span>
        <button type="button" className="gd-tool-btn" title="复制选中区为 TSV（按数据行，可直接粘进 Excel）" onClick={() => copySelection()}>
          <IconCopy size={13} />
        </button>
        <button type="button" className="gd-tool-btn" title="退出转置（Esc）" onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>

      <div
        className="gd-transpose-viewport"
        ref={viewportRef}
        tabIndex={0}
        // 挂载即取焦点：否则用户进来就要先点一下才能用方向键/⌘C
        // （焦点治理纪律：交互组件必须管好 focus 流转）
        autoFocus
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-testid="transpose-viewport"
      >
        {/* 表头行：字段名列 + 各数据行的序号 */}
        <div className="gd-tp-head" style={{ height: rowHeight }}>
          <div
            className="gd-tp-field gd-tp-head-field"
            style={{ width: FIELD_COL_WIDTH, flex: `0 0 ${FIELD_COL_WIDTH}px` }}
          >
            字段 \ 行
          </div>
          <div
            className="gd-tp-head-scroll"
            style={{ width: rowCount * TRANSPOSED_COL_WIDTH, transform: `translateX(${-scrollLeft}px)` }}
          >
            {Array.from({ length: vis.end - vis.start }, (_, i) => {
              const rowIndex = vis.start + i;
              const selected = rowIndex >= range.c0 && rowIndex <= range.c1;
              return (
                <div
                  key={rowIndex}
                  className={`gd-tp-cell gd-tp-head-cell${selected ? ' gd-tp-sel' : ''}`}
                  style={{ width: TRANSPOSED_COL_WIDTH, flex: `0 0 ${TRANSPOSED_COL_WIDTH}px` }}
                  onMouseDown={(e) => {
                    const next = { row: 0, col: rowIndex };
                    setFocus(next);
                    if (!e.shiftKey) setAnchor(next);
                    viewportRef.current?.focus();
                  }}
                >
                  {rowIndex + 1}
                </div>
              );
            })}
          </div>
        </div>

        {/* 字段行：每行一个字段，行内是可视数据行的值 */}
        {visibleOriginalIndexes.map((origCol, fieldIdx) => {
          const col = columns[origCol];
          const selectedField = fieldIdx >= range.r0 && fieldIdx <= range.r1;
          return (
            <div className="gd-tp-row" key={col?.name ?? origCol} style={{ height: rowHeight }}>
              <div
                className={`gd-tp-field${selectedField ? ' gd-tp-sel' : ''}`}
                style={{ width: FIELD_COL_WIDTH, flex: `0 0 ${FIELD_COL_WIDTH}px` }}
                title={col ? `${col.name} · ${col.dataType}${col.comment ? ` · ${col.comment}` : ''}` : undefined}
                onMouseDown={(e) => {
                  const next = { row: fieldIdx, col: focus.col };
                  setFocus(next);
                  if (!e.shiftKey) setAnchor(next);
                  viewportRef.current?.focus();
                }}
              >
                <span className="gd-tp-field-name">{col?.name ?? `列${origCol + 1}`}</span>
                <span className="gd-tp-field-type">{col?.dataType ?? ''}</span>
              </div>
              <div
                className="gd-tp-row-scroll"
                style={{ width: rowCount * TRANSPOSED_COL_WIDTH, transform: `translateX(${-scrollLeft}px)` }}
              >
                {Array.from({ length: vis.end - vis.start }, (_, i) => {
                  const rowIndex = vis.start + i;
                  const decoded = rows[i];
                  const v = decoded ? decoded[origCol] : source.value(rowIndex, origCol);
                  const isNull = v === null || v === undefined;
                  const isFocus = focus.row === fieldIdx && focus.col === rowIndex;
                  const inRange =
                    fieldIdx >= range.r0 && fieldIdx <= range.r1 &&
                    rowIndex >= range.c0 && rowIndex <= range.c1;
                  const cls = [
                    'gd-tp-cell',
                    isNull ? 'null' : '',
                    typeof v === 'number' ? 'numeric' : '',
                    source.isDirty(rowIndex, origCol) ? 'dirty' : '',
                    inRange ? 'gd-tp-sel' : '',
                    isFocus ? 'focus' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const text = isNull ? 'NULL' : cellToDisplay(v as never);
                  return (
                    <div
                      key={rowIndex}
                      className={cls}
                      style={{ width: TRANSPOSED_COL_WIDTH, flex: `0 0 ${TRANSPOSED_COL_WIDTH}px` }}
                      title={isNull ? 'NULL' : text}
                      data-tp-row={rowIndex}
                      data-tp-field={fieldIdx}
                      onMouseDown={(e) => {
                        const next = { row: fieldIdx, col: rowIndex };
                        setFocus(next);
                        if (!e.shiftKey) setAnchor(next);
                        viewportRef.current?.focus();
                      }}
                    >
                      {text}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
