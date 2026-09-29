import { describe, it, expect } from 'vitest';
import {
  ROW_HEIGHTS,
  rowHeightPx,
  computeVisibleRange,
  computeScrollToReveal,
  buildColumnOffsets,
  computeVisibleColumns,
  clampCell,
  normalizeRange,
  rangeContains,
  rangeCellCount,
  rangeRowCount,
  rangeRows,
  SelectionModel,
  nextSortDirection,
  applySort,
  applySortDirection,
  sortPriority,
  selectionStats,
  toOrderBy,
  loadState,
  shouldWarnLargeTable,
  DEFAULT_PAGE_SIZE,
  LARGE_TABLE_THRESHOLD,
} from './index.js';

describe('行高三档', () => {
  it('紧凑/标准/宽松 = 24/28/32', () => {
    expect(ROW_HEIGHTS).toEqual({ compact: 24, standard: 28, loose: 32 });
    expect(rowHeightPx('compact')).toBe(24);
    expect(rowHeightPx('standard')).toBe(28);
    expect(rowHeightPx('loose')).toBe(32);
  });

  it('未知档位回落到标准，不抛异常', () => {
    expect(rowHeightPx('weird' as never)).toBe(28);
  });
});

describe('纵向虚拟滚动', () => {
  const base = { rowHeight: 28, viewportHeight: 280, rowCount: 1000 };

  it('顶部：只渲染可视区 + 上下缓冲', () => {
    const r = computeVisibleRange({ ...base, scrollTop: 0 });
    expect(r.firstVisibleIndex).toBe(0);
    expect(r.lastVisibleIndex).toBe(9); // 280/28 = 10 行
    expect(r.start).toBe(0); // 上方无缓冲可给
    expect(r.end).toBe(20); // 10 可见 + 10 下方缓冲
    expect(r.offsetTop).toBe(0);
    expect(r.totalHeight).toBe(28_000);
  });

  it('中段：上下各 10 行缓冲', () => {
    const r = computeVisibleRange({ ...base, scrollTop: 28 * 100 });
    expect(r.firstVisibleIndex).toBe(100);
    expect(r.lastVisibleIndex).toBe(109); // 10 行可见
    expect(r.start).toBe(90); // 上缓冲 10 行
    expect(r.end).toBe(120); // 100..109 可见 + 下缓冲 10 行
    expect(r.offsetTop).toBe(90 * 28);
  });

  it('底部：末行不越界', () => {
    const r = computeVisibleRange({ ...base, scrollTop: 28 * 992 });
    expect(r.start).toBe(982);
    expect(r.end).toBe(1000);
    expect(r.lastVisibleIndex).toBe(999);
  });

  it('滚动到底部再往下滚（越界 scrollTop）仍裁剪到末行', () => {
    const r = computeVisibleRange({ ...base, scrollTop: 999_999 });
    expect(r.end).toBe(1000);
    expect(r.start).toBe(989); // 末行 999 - 下缓冲无余量 - 上缓冲 10
  });

  it('空结果集 / 零高度容器 / 负 scrollTop 都不抛异常', () => {
    const empty = computeVisibleRange({ ...base, scrollTop: 0, rowCount: 0 });
    expect(empty.start).toBe(0);
    expect(empty.end).toBe(0);
    expect(empty.lastVisibleIndex).toBe(-1);

    const noViewport = computeVisibleRange({ ...base, scrollTop: 0, viewportHeight: 0 });
    expect(noViewport.end).toBe(0);

    const neg = computeVisibleRange({ ...base, scrollTop: -500 });
    expect(neg.start).toBe(0);
  });

  it('overscan 可覆盖为 0', () => {
    const r = computeVisibleRange({ ...base, scrollTop: 28 * 100, overscan: 0 });
    expect(r.start).toBe(100);
    expect(r.end).toBe(110);
  });
});

describe('滚动定位', () => {
  it('已完全可见 → 不滚动', () => {
    expect(computeScrollToReveal(5, 0, 280, 28)).toBeNull();
  });

  it('在上方 → 滚到该行顶部', () => {
    expect(computeScrollToReveal(0, 28 * 50, 280, 28)).toBe(0);
  });

  it('在下方 → 让该行底部贴视口底', () => {
    // 行 20：top=560 bottom=588 → scrollTop=308
    expect(computeScrollToReveal(20, 0, 280, 28)).toBe(308);
  });

  it('rowHeight<=0 或 viewport<=0 返回 null（容器未布局）', () => {
    expect(computeScrollToReveal(5, 0, 0, 28)).toBeNull();
    expect(computeScrollToReveal(5, 0, 280, 0)).toBeNull();
  });
});

describe('横向列布局', () => {
  const layout = { widths: [80, 100, 120, 140], frozenCount: 1 };
  const offs = buildColumnOffsets(layout);

  it('偏移是前缀和，末元素为总宽', () => {
    expect(offs.offsets).toEqual([0, 80, 180, 300, 440]);
    expect(offs.totalWidth).toBe(440);
  });

  it('冻结列永远渲染，不参与裁剪', () => {
    const r = computeVisibleColumns(layout, offs, 300, 200);
    expect(r.frozenEnd).toBe(1);
    expect(r.start).toBeLessThanOrEqual(2);
    expect(r.end).toBe(4);
  });

  it('无冻结列时从第 0 列起算', () => {
    const l = { widths: [80, 100, 120, 140] };
    const o = buildColumnOffsets(l);
    const r = computeVisibleColumns(l, o, 0, 200);
    expect(r.frozenEnd).toBe(0);
    expect(r.start).toBe(0);
    expect(r.end).toBe(4); // 0..200 覆盖前两列 + overscan
  });

  it('视口宽 0 时只渲染冻结列', () => {
    const r = computeVisibleColumns(layout, offs, 0, 0);
    expect(r.start).toBe(1);
    expect(r.end).toBe(1);
  });
});

describe('范围工具', () => {
  it('clampCell 夹到合法下标', () => {
    expect(clampCell({ row: -5, col: -1 }, 10, 4)).toEqual({ row: 0, col: 0 });
    expect(clampCell({ row: 99, col: 99 }, 10, 4)).toEqual({ row: 9, col: 3 });
  });

  it('空网格 clamp 后行列都是 0（不出现 -1）', () => {
    expect(clampCell({ row: 3, col: 3 }, 0, 0)).toEqual({ row: 0, col: 0 });
  });

  it('normalizeRange 把反向拖动归一化', () => {
    expect(normalizeRange({ r0: 5, c0: 3, r1: 2, c1: 1 })).toEqual({ r0: 2, c0: 1, r1: 5, c1: 3 });
  });

  it('contains / 计数', () => {
    const r = { r0: 2, c0: 1, r1: 5, c1: 3 };
    expect(rangeContains(r, 2, 1)).toBe(true);
    expect(rangeContains(r, 5, 3)).toBe(true);
    expect(rangeContains(r, 1, 2)).toBe(false);
    expect(rangeCellCount(r)).toBe(12);
    expect(rangeRowCount(r)).toBe(4);
  });

  it('rangeRows 按行展开，供复制逐行取值', () => {
    expect(rangeRows({ r0: 2, c0: 1, r1: 4, c1: 2 })).toEqual([
      { row: 2, c0: 1, c1: 2 },
      { row: 3, c0: 1, c1: 2 },
      { row: 4, c0: 1, c1: 2 },
    ]);
  });
});

describe('选择模型', () => {
  it('初始为第一格', () => {
    const m = new SelectionModel(100, 8);
    expect(m.focus).toEqual({ row: 0, col: 0 });
    expect(m.isSelected(0, 0)).toBe(true);
    expect(m.isSelected(1, 0)).toBe(false);
  });

  it('方向键移动：非 Shift 收焦为单格，Shift 从 anchor 扩展', () => {
    const m = new SelectionModel(100, 8);
    m.navigate('down');
    m.navigate('right');
    expect(m.focus).toEqual({ row: 1, col: 1 });
    expect(m.primaryRange).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 });

    m.navigate('down', { shift: true });
    m.navigate('right', { shift: true });
    expect(m.anchor).toEqual({ row: 1, col: 1 }); // anchor 不动
    expect(m.focus).toEqual({ row: 2, col: 2 });
    expect(m.primaryRange).toEqual({ r0: 1, c0: 1, r1: 2, c1: 2 });
  });

  it('Shift 反向移动也能归一化（左下拖到右上）', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 5, col: 5 });
    m.navigate('up', { shift: true });
    m.navigate('left', { shift: true });
    expect(m.primaryRange).toEqual({ r0: 4, c0: 4, r1: 5, c1: 5 });
  });

  it('Cmd+方向跳到边界', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 50, col: 4 });
    expect(m.navigate('left', { cmd: true })).toEqual({ row: 50, col: 0 });
    expect(m.navigate('right', { cmd: true })).toEqual({ row: 50, col: 7 });
    expect(m.navigate('up', { cmd: true })).toEqual({ row: 0, col: 7 });
    expect(m.navigate('down', { cmd: true })).toEqual({ row: 99, col: 7 });
  });

  it('边界不越界：顶到 0 就停', () => {
    const m = new SelectionModel(3, 3);
    expect(m.navigate('up')).toEqual({ row: 0, col: 0 });
    expect(m.navigate('left')).toEqual({ row: 0, col: 0 });
  });

  it('Cmd+A 全选', () => {
    const m = new SelectionModel(100, 8);
    m.selectAll();
    expect(m.primaryRange).toEqual({ r0: 0, c0: 0, r1: 99, c1: 7 });
    expect(m.focus).toEqual({ row: 99, col: 7 });
  });

  it('Cmd+点击追加多块选区', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 1, col: 1 });
    m.selectCell({ row: 5, col: 5 }, { additive: true });
    expect(m.ranges).toHaveLength(2);
    expect(m.isSelected(1, 1)).toBe(true);
    expect(m.isSelected(5, 5)).toBe(true);
    expect(m.isSelected(3, 3)).toBe(false);
    // 普通点击则重置
    m.selectCell({ row: 9, col: 0 });
    expect(m.ranges).toHaveLength(1);
  });

  it('extendTo 用于鼠标拖选', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 2, col: 2 });
    m.extendTo({ row: 6, col: 4 });
    expect(m.primaryRange).toEqual({ r0: 2, c0: 2, r1: 6, c1: 4 });
  });

  it('extendTo additive（V3）：⌘ 拖保留已有选区块，只重拉最后一块', () => {
    const m = new SelectionModel(100, 8);
    // 第一块：普通拖选 2,2 → 3,3
    m.selectCell({ row: 2, col: 2 });
    m.extendTo({ row: 3, col: 3 });
    // 第二块：⌘ 点击 6,5 追加，⌘ 拖到 8,7
    m.selectCell({ row: 6, col: 5 }, { additive: true });
    m.extendTo({ row: 8, col: 7 }, { additive: true });
    expect(m.ranges).toHaveLength(2);
    expect(m.ranges[0]).toEqual({ r0: 2, c0: 2, r1: 3, c1: 3 });
    expect(m.ranges[1]).toEqual({ r0: 6, c0: 5, r1: 8, c1: 7 });
    // 非 additive 拖选替换全部（既有语义不变）
    m.extendTo({ row: 9, col: 1 });
    expect(m.ranges).toHaveLength(1);
    // ranges getter 归一口径：反向拖选 (6,5)→(9,1) 收敛为左上/右下
    expect(m.ranges[0]).toEqual({ r0: 6, c0: 1, r1: 9, c1: 5 });
  });

  it('setFocus：只移焦点不清选区（行号列点击的落点）', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 2, col: 3 }); // 建立一个单格矩形选区
    m.selectRowOnly(5);
    m.setFocus({ row: 5, col: 0 });
    expect(m.focus).toEqual({ row: 5, col: 0 });
    expect(m.selectedRows).toEqual([5]); // 行勾选保留
    expect(m.primaryRange).toEqual({ r0: 2, c0: 3, r1: 2, c1: 3 }); // 矩形选区保留
  });

  it('clearRanges：清矩形选区、保留焦点与行勾选（行号点选进「行选模式」用）', () => {
    const m = new SelectionModel(100, 8);
    m.selectCell({ row: 2, col: 3 });
    m.selectRowOnly(5);
    m.clearRanges();
    expect(m.ranges).toEqual([]);
    expect(m.focus).toEqual({ row: 2, col: 3 });
    expect(m.selectedRows).toEqual([5]);
    // 清空后再 ⌘C 走行选、统计不再混入旧选区
    expect(m.primaryRange).toBeNull();
  });

  it('Space 逐行勾选，可取消', () => {
    const m = new SelectionModel(100, 8);
    expect(m.toggleRow(3)).toBe(true);
    expect(m.toggleRow(7)).toBe(true);
    expect(m.selectedRows).toEqual([3, 7]);
    expect(m.toggleRow(3)).toBe(false);
    expect(m.selectedRows).toEqual([7]);
    m.clearRows();
    expect(m.selectedRows).toEqual([]);
  });

  it('越界行勾选返回 false 且不记录', () => {
    const m = new SelectionModel(10, 8);
    expect(m.toggleRow(10)).toBe(false);
    expect(m.toggleRow(-1)).toBe(false);
    expect(m.selectedRows).toEqual([]);
  });

  it('删除行后行号上移：焦点/选区/行选择一起修正', () => {
    const m = new SelectionModel(10, 8);
    m.selectCell({ row: 8, col: 1 });
    m.toggleRow(9);
    m.removeRows([0, 1, 2]);
    expect(m.rowCount).toBe(7);
    expect(m.focus).toEqual({ row: 5, col: 1 }); // 8 - 3
    expect(m.selectedRows).toEqual([6]); // 9 - 3
  });

  it('resize：结果集变小后焦点与选区被裁剪', () => {
    const m = new SelectionModel(1000, 8);
    m.selectCell({ row: 900, col: 7 });
    m.resize(100, 4);
    expect(m.focus).toEqual({ row: 99, col: 3 });
    expect(m.rowCount).toBe(100);
  });

  it('空网格上所有操作不抛异常且选区为空', () => {
    const m = new SelectionModel(0, 0);
    expect(m.primaryRange).toBeNull();
    m.selectCell({ row: 0, col: 0 });
    m.navigate('down');
    m.selectAll();
    expect(m.primaryRange).toBeNull();
    expect(m.isSelected(0, 0)).toBe(false);
  });

  it('snapshot 返回拷贝（调用方改不坏内部状态）', () => {
    const m = new SelectionModel(10, 4);
    const s = m.snapshot();
    s.focus.row = 999;
    expect(m.focus.row).toBe(0);
  });

  it('行号列点选：selectRowOnly 替换旧勾选', () => {
    const m = new SelectionModel(100, 8);
    m.toggleRow(3);
    m.toggleRow(7);
    m.selectRowOnly(5);
    expect(m.selectedRows).toEqual([5]);
    expect(m.isRowSelected(5)).toBe(true);
    expect(m.hasRowSelected(5)).toBe(true);
    expect(m.hasRowSelected(3)).toBe(false);
    // 越界行不动原选择
    m.selectRowOnly(999);
    expect(m.selectedRows).toEqual([5]);
  });

  it('行号列 Shift/拖选：selectRowRange 选中整段（端点任意顺序）', () => {
    const m = new SelectionModel(100, 8);
    m.toggleRow(1);
    m.selectRowRange(7, 4);
    expect(m.selectedRows).toEqual([4, 5, 6, 7]);
    m.selectRowRange(90, 200); // 越界端点钳到 99
    expect(m.selectedRows).toEqual(Array.from({ length: 10 }, (_, i) => 90 + i));
  });

  it('空网格的行选操作不抛异常', () => {
    const m = new SelectionModel(0, 0);
    expect(m.selectRowOnly(0)).toBe(false);
    m.selectRowRange(0, 3);
    expect(m.selectedRows).toEqual([]);
  });

  it('⌘A 全选清空行勾选（复制语义不被旧行选劫持）', () => {
    const m = new SelectionModel(100, 8);
    m.toggleRow(3);
    m.selectAll();
    expect(m.selectedRows).toEqual([]);
    expect(m.primaryRange).toEqual({ r0: 0, c0: 0, r1: 99, c1: 7 });
  });
});

describe('选中统计 selectionStats', () => {
  it('矩形选区：行数按区间并集，格数按矩形乘积', () => {
    const s = selectionStats(
      [
        { r0: 0, c0: 0, r1: 2, c1: 3 },
        { r0: 2, c0: 1, r1: 4, c1: 2 }, // 与上一块行重叠
      ],
      [],
      8,
    );
    expect(s).toEqual({ rows: 5, cells: 12 + 6 });
  });

  it('行勾选：未被选区覆盖的行按整行格数计', () => {
    const s = selectionStats([{ r0: 0, c0: 0, r1: 1, c1: 1 }], [1, 5, 9], 4);
    // 行 1 已在选区里；行 5、9 各补整行 4 格
    expect(s).toEqual({ rows: 4, cells: 4 + 8 });
  });

  it('行勾选与选区混合去重', () => {
    const s = selectionStats(
      [{ r0: 2, c0: 0, r1: 4, c1: 7 }],
      [3, 10],
      8,
    );
    expect(s).toEqual({ rows: 4, cells: 24 + 8 });
  });

  it('空选区空勾选 → 全零', () => {
    expect(selectionStats([], [], 8)).toEqual({ rows: 0, cells: 0 });
  });
});

describe('排序三态', () => {
  it('列头菜单显式方向：applySortDirection 设为唯一排序列', () => {
    expect(applySortDirection([{ column: 'a', direction: 'DESC' }], 'b', 'ASC')).toEqual([
      { column: 'b', direction: 'ASC' },
    ]);
    // 同列重复设置也直接给值（菜单语义：点降序就是降序）
    expect(applySortDirection([{ column: 'a', direction: 'ASC' }], 'a', 'DESC')).toEqual([
      { column: 'a', direction: 'DESC' },
    ]);
  });

  it('无 → ASC → DESC → 无', () => {
    expect(nextSortDirection(null)).toBe('ASC');
    expect(nextSortDirection('ASC')).toBe('DESC');
    expect(nextSortDirection('DESC')).toBeNull();
    expect(nextSortDirection(undefined)).toBe('ASC');
  });

  it('普通点击：单列排序，清空其它列；第三次点击清空', () => {
    let s = applySort([], 'id');
    expect(s).toEqual([{ column: 'id', direction: 'ASC' }]);
    s = applySort(s, 'id');
    expect(s).toEqual([{ column: 'id', direction: 'DESC' }]);
    s = applySort(s, 'id');
    expect(s).toEqual([]);

    s = applySort(s, 'name');
    expect(s).toEqual([{ column: 'name', direction: 'ASC' }]);
    s = applySort(s, 'age');
    expect(s).toEqual([{ column: 'age', direction: 'ASC' }]); // 已被上一行清空，只剩 age
  });

  it('Shift+点击：多列追加，列头角标 ①②③ 有序', () => {
    let s = applySort([], 'a', true);
    s = applySort(s, 'b', true);
    s = applySort(s, 'c', true);
    expect(s).toEqual([
      { column: 'a', direction: 'ASC' },
      { column: 'b', direction: 'ASC' },
      { column: 'c', direction: 'ASC' },
    ]);
    expect(sortPriority(s, 'a')).toBe(1);
    expect(sortPriority(s, 'b')).toBe(2);
    expect(sortPriority(s, 'c')).toBe(3);
  });

  it('Shift 第三次点击只移除该列，保留其它列', () => {
    let s = applySort([], 'a', true);
    s = applySort(s, 'b', true);
    s = applySort(s, 'b', true);
    s = applySort(s, 'b', true);
    expect(s).toEqual([{ column: 'a', direction: 'ASC' }]);
    expect(sortPriority(s, 'b')).toBeNull();
  });

  it('空列名不产生排序', () => {
    expect(applySort([], '')).toEqual([]);
  });

  it('toOrderBy 给驱动层用（服务端排序）', () => {
    expect(toOrderBy([{ column: 'id', direction: 'DESC' }])).toEqual([{ column: 'id', direction: 'DESC' }]);
  });
});

describe('加载状态', () => {
  it('有估算值时标注"约"字，不谎报精确值', () => {
    const s = loadState(3000, 12_450_000);
    expect(s.hasMore).toBe(true);
    expect(s.label).toBe('已加载 3,000 / 约 12,450,000 行（估算）');
  });

  it('已加载到底：hasMore=false', () => {
    const s = loadState(50, 50);
    expect(s.hasMore).toBe(false);
  });

  it('无估算值时不臆造总数', () => {
    const s = loadState(3000, null);
    expect(s.estimated).toBeNull();
    expect(s.label).toBe('已加载 3,000 行');
    expect(s.hasMore).toBe(true); // 不知道总数 → 允许继续加载更多
  });

  it('非法估算值（NaN/Infinity）当作无', () => {
    expect(loadState(10, NaN).estimated).toBeNull();
    expect(loadState(10, Infinity).estimated).toBeNull();
  });

  it('大表阈值 10 万', () => {
    expect(LARGE_TABLE_THRESHOLD).toBe(100_000);
    expect(shouldWarnLargeTable(100_001)).toBe(true);
    expect(shouldWarnLargeTable(100_000)).toBe(false);
    expect(shouldWarnLargeTable(null)).toBe(false);
  });

  it('默认页大小 3000', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(3000);
  });
});
