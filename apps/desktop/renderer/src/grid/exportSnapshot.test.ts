/**
 * P0-1 单测：导出快照取数口径。
 *
 * 断言方式：每条都对比**具体行号/列数**，而不是「非空就过」——
 * 单格光标那一组尤其重要：它是「选区选项永远可用且永远是 1 行」的回归防线。
 */

import { describe, expect, it } from 'vitest';
import {
  buildGridSnapshotSource,
  exportSelectionRowIndexes,
  type BuildGridSnapshotInput,
  type SnapshotRange,
} from './exportSnapshot';

const rng = (r0: number, r1: number, c0: number, c1: number): SnapshotRange => ({ r0, r1, c0, c1 });

describe('exportSelectionRowIndexes', () => {
  it('行号勾选优先于矩形选区，且升序去重', () => {
    const rows = exportSelectionRowIndexes(
      { ranges: [rng(0, 9, 0, 3)], selectedRows: [5, 2, 5, 1] },
      10,
    );
    expect(rows).toEqual([1, 2, 5]);
  });

  it('单格光标不算选区（网格一有数据就有这个 range）', () => {
    expect(exportSelectionRowIndexes({ ranges: [rng(0, 0, 0, 0)], selectedRows: [] }, 100)).toEqual([]);
    // 拖到别的单格也一样：仍然只是一个格子
    expect(exportSelectionRowIndexes({ ranges: [rng(7, 7, 4, 4)], selectedRows: [] }, 100)).toEqual([]);
  });

  it('跨行框选 → 覆盖的每一行', () => {
    expect(exportSelectionRowIndexes({ ranges: [rng(3, 6, 1, 2)], selectedRows: [] }, 100)).toEqual([3, 4, 5, 6]);
  });

  it('同一行内跨列（明确框了多个格子）→ 算该行', () => {
    expect(exportSelectionRowIndexes({ ranges: [rng(4, 4, 0, 2)], selectedRows: [] }, 100)).toEqual([4]);
  });

  it('多重选区取最后一块（与复制/删除同口径）', () => {
    const rows = exportSelectionRowIndexes(
      { ranges: [rng(0, 2, 0, 1), rng(8, 9, 0, 1)], selectedRows: [] },
      100,
    );
    expect(rows).toEqual([8, 9]);
  });

  it('越界值按 rowCount 钳制，负行号丢弃', () => {
    expect(exportSelectionRowIndexes({ ranges: [rng(7, 99, 0, 1)], selectedRows: [] }, 10)).toEqual([
      7, 8, 9,
    ]);
    expect(exportSelectionRowIndexes({ ranges: [], selectedRows: [-1, 3, 100] }, 10)).toEqual([3]);
  });

  it('空网格 / 无 range → 空数组', () => {
    expect(exportSelectionRowIndexes({ ranges: [rng(0, 5, 0, 1)], selectedRows: [] }, 0)).toEqual([]);
    expect(exportSelectionRowIndexes({ ranges: [], selectedRows: [] }, 10)).toEqual([]);
  });
});

describe('buildGridSnapshotSource', () => {
  /** 3 行 × 4 列，值 = `r{r}c{c}`；可见列只留 b、d（原始下标 1、3） */
  const base = (): BuildGridSnapshotInput => ({
    rowCount: 3,
    columnCount: 4,
    columns: [
      { name: 'a', dataType: 'int' },
      { name: 'b', dataType: 'varchar(10)' },
      { name: 'c', dataType: 'int' },
      { name: 'd' },
    ],
    visibleColumns: ['b', 'd'],
    ranges: [rng(1, 2, 0, 3)],
    selectedRows: [],
    valueAt: (r, c) => `r${r}c${c}`,
  });

  it('计数即时可读，且不需要逐格解码', () => {
    let decodes = 0;
    const input = base();
    const src = buildGridSnapshotSource({
      ...input,
      valueAt: (r, c) => {
        decodes++;
        return input.valueAt(r, c);
      },
    });
    expect(src.selectedRowCount).toBe(2);
    expect(src.loadedRowCount).toBe(3);
    // 🔴 关键：构造快照源时一次都不该碰单元格（否则 5 万行表开弹窗就卡）
    expect(decodes).toBe(0);
  });

  it('已加载 = 全量行，列数 = 网格列数（不是可见列数）', () => {
    const src = buildGridSnapshotSource(base());
    expect(src.readRows('loaded')).toEqual([
      ['r0c0', 'r0c1', 'r0c2', 'r0c3'],
      ['r1c0', 'r1c1', 'r1c2', 'r1c3'],
      ['r2c0', 'r2c1', 'r2c2', 'r2c3'],
    ]);
    // 🔴 整行导出：只给可见列会让表头与数据错位（列裁剪在 exportScope 做）
    expect(src.visibleColumns).toEqual(['b', 'd']);
    expect(src.columns.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('选区行是整行快照，与已加载行同列序', () => {
    const src = buildGridSnapshotSource(base());
    expect(src.readRows('selection')).toEqual([
      ['r1c0', 'r1c1', 'r1c2', 'r1c3'],
      ['r2c0', 'r2c1', 'r2c2', 'r2c3'],
    ]);
  });

  it('没有显式选区时选区块为空，但已加载照常可读', () => {
    const src = buildGridSnapshotSource({ ...base(), ranges: [rng(0, 0, 0, 0)], selectedRows: [] });
    expect(src.selectedRowCount).toBe(0);
    expect(src.readRows('selection')).toEqual([]);
    expect(src.readRows('loaded')).toHaveLength(3);
  });

  it('可见列是拷贝，外部改动不影响已产出的快照源', () => {
    const input = base();
    const src = buildGridSnapshotSource(input);
    (input.visibleColumns as string[]).push('a');
    expect(src.visibleColumns).toEqual(['b', 'd']);
  });

  it('零行零列不炸（空结果集导出选区应被弹窗禁用，而不是这里抛错）', () => {
    const src = buildGridSnapshotSource({
      ...base(),
      rowCount: 0,
      columnCount: 0,
      ranges: [],
      selectedRows: [],
    });
    expect(src.readRows('loaded')).toEqual([]);
    expect(src.readRows('selection')).toEqual([]);
    expect(src.selectedRowCount).toBe(0);
  });
});
