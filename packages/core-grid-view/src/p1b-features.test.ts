/**
 * P1-B 网格编辑深度的纯逻辑单测（2026-09-29 新增，V8/V11/V12/V13）
 *
 * 与其他 test 文件同款约定：测试与源码同目录；这里只测纯逻辑，
 * 渲染层行为由 scripts/e2e-ui.mjs 的真机断言守住。
 */
import { describe, it, expect } from 'vitest';
import {
  SelectionModel,
  clampFrozenCount,
  frozenCountForColumn,
  FROZEN_COUNT_MAX,
  computeTransposedVisibleRows,
  canTranspose,
  transposedToOriginal,
  originalToTransposed,
  TRANSPOSE_MAX_FIELDS,
  batchEditTarget,
  planBatchEdit,
  buildColumnOffsets,
  computeVisibleColumns,
  EXPAND_LEVEL_MAX,
} from './index.js';

// ---------- V8 冻结列 ----------

describe('V8 冻结列（列数换算与钳制）', () => {
  it('clampFrozenCount：非法值退化为 0（不冻结）', () => {
    expect(clampFrozenCount(undefined)).toBe(0);
    expect(clampFrozenCount(null)).toBe(0);
    expect(clampFrozenCount('abc')).toBe(0);
    expect(clampFrozenCount(-3)).toBe(0);
    expect(clampFrozenCount(0)).toBe(0);
    expect(clampFrozenCount(NaN)).toBe(0);
  });

  it('clampFrozenCount：超过 FROZEN_COUNT_MAX 钳到上限', () => {
    expect(clampFrozenCount(99)).toBe(FROZEN_COUNT_MAX);
    expect(clampFrozenCount(FROZEN_COUNT_MAX)).toBe(FROZEN_COUNT_MAX);
    expect(clampFrozenCount(2.9)).toBe(2);
  });

  it('clampFrozenCount：给 visibleCount 时至少留 1 列可滚动', () => {
    // 3 列可见 → 最多冻 2 列；冻满等于失去横向滚动，冻结本身无意义
    expect(clampFrozenCount(5, 3)).toBe(2);
    expect(clampFrozenCount(2, 3)).toBe(2);
    // 只有 1 列可见 → 一列都不能冻
    expect(clampFrozenCount(1, 1)).toBe(0);
    expect(clampFrozenCount(3, 0)).toBe(0);
  });

  it('frozenCountForColumn：原始列下标 → 可见列数（隐藏列不占冻结位）', () => {
    // 可见列的原始下标是 [0, 2, 3]（原始第 1 列被隐藏）
    const visible = [0, 2, 3];
    expect(frozenCountForColumn(visible, 0)).toBe(1); // 冻到第 1 个可见列
    expect(frozenCountForColumn(visible, 2)).toBe(2); // 冻到第 2 个可见列
    expect(frozenCountForColumn(visible, 3)).toBe(3);
  });

  it('frozenCountForColumn：列自身被隐藏 → 0（防御性退化，不抛异常）', () => {
    expect(frozenCountForColumn([0, 2], 1)).toBe(0);
    expect(frozenCountForColumn([], 0)).toBe(0);
  });

  it('computeVisibleColumns：冻结列不参与横向裁剪，永远渲染', () => {
    const layout = { widths: [100, 100, 100, 100, 100], frozenCount: 2 };
    const offsets = buildColumnOffsets(layout);
    // 横向滚到最右：普通列窗口右移，但 frozenEnd 恒为 2
    const r = computeVisibleColumns(layout, offsets, 400, 100, 0);
    expect(r.frozenEnd).toBe(2);
    expect(r.start).toBeGreaterThanOrEqual(2);
    // 滚到最左：冻结列就是窗口开头，offsetLeft 落在冻结区之后
    const r0 = computeVisibleColumns(layout, offsets, 0, 300, 0);
    expect(r0.frozenEnd).toBe(2);
    expect(r0.start).toBe(2);
  });

  it('frozenCount 缺省/为 0 时 frozenEnd = 0（默认不冻结，既有行为不变）', () => {
    const layout = { widths: [100, 100] };
    const offsets = buildColumnOffsets(layout);
    expect(computeVisibleColumns(layout, offsets, 0, 200).frozenEnd).toBe(0);
    expect(computeVisibleColumns({ ...layout, frozenCount: 0 }, offsets, 0, 200).frozenEnd).toBe(0);
  });
});

// ---------- V11 递进选区 ----------

describe('V11 Expand Selection（⌥↑ / ⌥↓ 递进选区）', () => {
  function model(rowCount = 10, colCount = 6) {
    return new SelectionModel(rowCount, colCount);
  }

  it('⌥↑ 三档递进：当前列 → 当前行 → 整个网格', () => {
    const s = model();
    s.selectCell({ row: 3, col: 2 });
    expect(s.expandLevel).toBe(0);

    // 第 1 次：整列（列不变，行铺满）
    expect(s.expandSelection(true)).toBe(1);
    expect(s.ranges).toEqual([{ r0: 0, c0: 2, r1: 9, c1: 2 }]);

    // 第 2 次：整行（行不变，列铺满）
    expect(s.expandSelection(true)).toBe(2);
    expect(s.ranges).toEqual([{ r0: 3, c0: 0, r1: 3, c1: 5 }]);

    // 第 3 次：整个网格
    expect(s.expandSelection(true)).toBe(3);
    expect(s.ranges).toEqual([{ r0: 0, c0: 0, r1: 9, c1: 5 }]);

    // 到顶后不再增长
    expect(s.expandSelection(true)).toBe(EXPAND_LEVEL_MAX);
  });

  it('⌥↓ 反向收缩，收到 0 档退回焦点单格', () => {
    const s = model();
    s.selectCell({ row: 3, col: 2 });
    s.expandSelection(true);
    s.expandSelection(true);
    s.expandSelection(true);
    expect(s.expandLevel).toBe(3);

    expect(s.expandSelection(false)).toBe(2);
    expect(s.ranges).toEqual([{ r0: 3, c0: 0, r1: 3, c1: 5 }]);
    expect(s.expandSelection(false)).toBe(1);
    expect(s.ranges).toEqual([{ r0: 0, c0: 2, r1: 9, c1: 2 }]);
    expect(s.expandSelection(false)).toBe(0);
    expect(s.ranges).toEqual([{ r0: 3, c0: 2, r1: 3, c1: 2 }]);
    // 已到 0 档，继续 ⌥↓ 不再变化
    expect(s.expandSelection(false)).toBe(0);
  });

  it('🔴 focus 不随档位移动（递进意图是围绕当前格扩大，不是重置位置）', () => {
    const s = model();
    s.selectCell({ row: 3, col: 2 });
    s.expandSelection(true);
    s.expandSelection(true);
    s.expandSelection(true);
    expect(s.focus).toEqual({ row: 3, col: 2 });
  });

  it('行勾选被清空：否则 ⌘C 的「行选优先」会让全选后复制悄悄退化', () => {
    const s = model();
    s.selectCell({ row: 1, col: 1 });
    s.toggleRow(0);
    s.toggleRow(5);
    expect(s.selectedRows.length).toBe(2);
    // toggleRow 把档位归零了，重新从焦点起爬
    s.expandSelection(true);
    expect(s.selectedRows).toEqual([]);
  });

  it('其他选择动作打断阶梯：selectCell / navigate / extendTo / selectAll 后档位归位', () => {
    const s = model();
    s.selectCell({ row: 2, col: 1 });
    s.expandSelection(true);
    expect(s.expandLevel).toBe(1);
    s.selectCell({ row: 4, col: 4 });
    expect(s.expandLevel).toBe(0);

    s.expandSelection(true);
    s.navigate('down', {});
    expect(s.expandLevel).toBe(0);

    s.expandSelection(true);
    s.extendTo({ row: 6, col: 2 });
    expect(s.expandLevel).toBe(0);

    // ⌘A 语义就是全表 → 档位直接对齐到顶档，⌥↓ 有正确起点
    s.selectAll();
    expect(s.expandLevel).toBe(EXPAND_LEVEL_MAX);
  });

  it('空网格（0 行或 0 列）不抛异常，档位恒 0', () => {
    const s = new SelectionModel(0, 5);
    expect(s.expandSelection(true)).toBe(0);
    const s2 = new SelectionModel(5, 0);
    expect(s2.expandSelection(true)).toBe(0);
  });
});

// ---------- V12 转置 ----------

describe('V12 结果集转置（区间计算与坐标换算）', () => {
  it('坐标换算是互逆的', () => {
    expect(transposedToOriginal(...Object.values(originalToTransposed(7, 3)) as [number, number])).toEqual({ row: 7, col: 3 });
    expect(originalToTransposed(7, 3)).toEqual({ row: 3, col: 7 });
  });

  it('computeTransposedVisibleRows 与纵向公式同源（行高↔列宽、行数↔数据行数）', () => {
    const r = computeTransposedVisibleRows({
      scrollLeft: 0,
      viewportWidth: 300,
      rowWidth: 100,
      rowCount: 50,
      overscan: 2,
    });
    // 视口宽 300 / 每列 100 → 3 列可见 + 左右各 2 缓冲（左侧被钳到 0）
    expect(r.start).toBe(0);
    expect(r.end).toBe(5);
    expect(r.offsetLeft).toBe(0);
    expect(r.totalWidth).toBe(5000);
  });

  it('横向滚动后区间右移，永远不覆盖全量（红线 8：不 decodeAll）', () => {
    const r = computeTransposedVisibleRows({
      scrollLeft: 2000,
      viewportWidth: 300,
      rowWidth: 100,
      rowCount: 100_000,
      overscan: 2,
    });
    expect(r.end - r.start).toBeLessThanOrEqual(8);
    expect(r.start).toBeGreaterThan(0);
    expect(r.end).toBeLessThan(100_000);
  });

  it('rowCount=0 / viewportWidth=0 返回空区间不抛异常', () => {
    expect(computeTransposedVisibleRows({ scrollLeft: 0, viewportWidth: 300, rowWidth: 100, rowCount: 0 }).end).toBe(0);
    expect(computeTransposedVisibleRows({ scrollLeft: 0, viewportWidth: 0, rowWidth: 100, rowCount: 10 }).end).toBe(0);
  });

  it('canTranspose：0 列拒绝、超上限拒绝（带理由），常规通过', () => {
    expect(canTranspose(0)).toEqual({ ok: false, reason: '结果集没有列，无法转置' });
    const tooMany = canTranspose(TRANSPOSE_MAX_FIELDS + 1);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toContain(String(TRANSPOSE_MAX_FIELDS));
    expect(canTranspose(7)).toEqual({ ok: true, reason: null });
    expect(canTranspose(TRANSPOSE_MAX_FIELDS).ok).toBe(true);
  });
});

// ---------- V13 批量编辑条 ----------

describe('V13 批量编辑目标判定（batchEditTarget）', () => {
  it('行号勾选 ≥2 行 → 勾选行 × 焦点列（行选优先，与复制/删除同口径）', () => {
    const t = batchEditTarget([5, 1, 3], [], 2, 10);
    expect(t).toEqual({ column: 2, rows: [1, 3, 5] });
  });

  it('矩形选区「多行 × 单列」→ 该列 × 选区行', () => {
    const t = batchEditTarget([], [{ r0: 2, c0: 4, r1: 6, c1: 4 }], 0, 10);
    expect(t).toEqual({ column: 4, rows: [2, 3, 4, 5, 6] });
  });

  it('反向拖出的选区同样有效（内部归一化）', () => {
    const t = batchEditTarget([], [{ r0: 6, c0: 4, r1: 2, c1: 4 }], 0, 10);
    expect(t).toEqual({ column: 4, rows: [2, 3, 4, 5, 6] });
  });

  it('多列选区不给批量条：一个值填进不同列几乎必然是误操作', () => {
    expect(batchEditTarget([], [{ r0: 0, c0: 1, r1: 5, c1: 3 }], 0, 10)).toBeNull();
  });

  it('单行（勾选 1 行 / 选区 1 行）不给批量条：那就是普通单元格编辑', () => {
    expect(batchEditTarget([4], [], 2, 10)).toBeNull();
    expect(batchEditTarget([], [{ r0: 4, c0: 2, r1: 4, c1: 2 }], 0, 10)).toBeNull();
  });

  it('都没有 → null（批量条不出现）', () => {
    expect(batchEditTarget([], [], 0, 10)).toBeNull();
  });

  it('越界行被过滤，过滤后不足 2 行则不给', () => {
    expect(batchEditTarget([0, 99], [], 1, 10)).toBeNull();
    expect(batchEditTarget([0, 3, 99], [], 1, 10)).toEqual({ column: 1, rows: [0, 3] });
  });

  it('选区尾部超出 rowCount 时被裁剪', () => {
    const t = batchEditTarget([], [{ r0: 8, c0: 1, r1: 20, c1: 1 }], 0, 10);
    expect(t).toEqual({ column: 1, rows: [8, 9] });
  });
});

describe('V13 planBatchEdit（只产脏单元格计划，不产 SQL）', () => {
  it('逐行逐列产出，valueKind 缺省 literal', () => {
    const cells = planBatchEdit({ column: 3, rows: [0, 1, 2], value: 'x' });
    expect(cells).toEqual([
      { row: 0, col: 3, value: 'x', valueKind: 'literal' },
      { row: 1, col: 3, value: 'x', valueKind: 'literal' },
      { row: 2, col: 3, value: 'x', valueKind: 'literal' },
    ]);
  });

  it('valueKind 透传：批量条同样支持 SQL 表达式（V10 联动）', () => {
    const cells = planBatchEdit({ column: 5, rows: [7], value: 'NOW()', valueKind: 'sql-expr' });
    expect(cells[0]).toEqual({ row: 7, col: 5, value: 'NOW()', valueKind: 'sql-expr' });
  });

  it('NULL 值可批量下发（把一列全设为 NULL 是真实诉求）', () => {
    const cells = planBatchEdit({ column: 1, rows: [0, 1], value: null });
    expect(cells.every((c) => c.value === null)).toBe(true);
  });

  it('空行列表 → 空计划（不抛异常）', () => {
    expect(planBatchEdit({ column: 0, rows: [], value: 'x' })).toEqual([]);
  });
});
