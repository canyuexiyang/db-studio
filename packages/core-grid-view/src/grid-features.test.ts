/**
 * A 板块新增纯函数的单测（2026-09-26 网格 A 代理）：
 *   A1 findMatches / A7 estimateColumnWidth / A8 aggregateSelection
 *   A15 serializeGridView / restoreGridView
 * 与 index.test.ts 分文件，避免既有用例文件无限膨胀。
 */
import { describe, it, expect } from 'vitest';
import {
  cellMatches,
  findMatches,
  estimateColumnWidth,
  aggregateSelection,
  serializeGridView,
  restoreGridView,
  gridViewStorageKey,
  GRID_VIEW_STORAGE_PREFIX,
  COLUMN_WIDTH_MIN,
  COLUMN_WIDTH_MAX,
} from './index.js';

describe('A1 结果集内查找', () => {
  const rows = [
    ['apple', 1, null],
    ['Banana', 'ApplePie', 22],
    ['汉字内容', true, 'GRAPE'],
  ];

  it('大小写不敏感的包含匹配，数字按展示口径转字符串', () => {
    const m = findMatches(rows, 0, 'apple');
    // (0,0) apple；(1,1) 'ApplePie'；数字 1/22 不含 apple
    expect(m).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it('NULL/undefined 永不命中；空串查询返回空（调用方不触发扫描）', () => {
    expect(findMatches(rows, 0, 'null')).toEqual([]);
    expect(findMatches(rows, 0, '')).toEqual([]);
    expect(cellMatches(null, 'a')).toBe(false);
    expect(cellMatches(undefined, 'a')).toBe(false);
  });

  it('布尔值转 true/false 参与匹配', () => {
    expect(findMatches(rows, 0, 'true')).toEqual([{ row: 2, col: 1 }]);
  });

  it('columnIndexes 列过滤：只搜指定原始列', () => {
    const m = findMatches(rows, 0, 'apple', { columnIndexes: [1] });
    expect(m).toEqual([{ row: 1, col: 1 }]);
  });

  it('startRow 把块内下标还原成全局行号（分块拼接 = 全量一次搜）', () => {
    const chunk1 = findMatches(rows.slice(0, 2), 0, 'an');
    const chunk2 = findMatches(rows.slice(2), 2, 'an');
    const whole = findMatches(rows, 0, 'an');
    expect([...chunk1, ...chunk2]).toEqual(whole);
    // Banana(1,0) 与 汉字内容 不含 an（拼音不算！）；GRAPE 不含 an
    expect(whole).toEqual([{ row: 1, col: 0 }]);
  });

  it('caseSensitive 关闭不敏感语义', () => {
    expect(findMatches(rows, 0, 'APPLE', { caseSensitive: true })).toEqual([]);
    expect(findMatches(rows, 0, 'GRAPE', { caseSensitive: true })).toEqual([{ row: 2, col: 2 }]);
    expect(cellMatches('ABC', 'b')).toBe(true);
    expect(cellMatches('ABC', 'b', true)).toBe(false);
  });
});

describe('A7 自适应列宽', () => {
  it('无样本时由表头决定宽度', () => {
    const w = estimateColumnWidth([], 'id');
    expect(w).toBeGreaterThanOrEqual(COLUMN_WIDTH_MIN);
    // 'id' = 2 单位 → 2*7*1.06+24 ≈ 39 → 被 min 40 抬起
    expect(w).toBe(COLUMN_WIDTH_MIN);
  });

  it('取样本最大宽度，短列不被撑宽', () => {
    const w = estimateColumnWidth(['1', '22', '333'], 'count');
    expect(w).toBeGreaterThanOrEqual(estimateColumnWidth(['333'], 'count'));
    expect(w).toBeLessThan(100);
  });

  it('中文按 1.6 倍宽估算，明显宽于同长度 ASCII', () => {
    const ascii = estimateColumnWidth(['abcdefghij'], 'c');
    const cjk = estimateColumnWidth(['十个汉字十个汉字'], 'c');
    // 10 个汉字 = 16 单位 > 10 单位
    expect(cjk).toBeGreaterThan(ascii);
  });

  it('超长样本被 maxWidth 封顶，短样本被 minWidth 兜底', () => {
    const long = 'x'.repeat(500);
    expect(estimateColumnWidth([long], 'c')).toBe(COLUMN_WIDTH_MAX);
    expect(estimateColumnWidth([''], 'c')).toBe(COLUMN_WIDTH_MIN);
  });

  it('自定义参数生效（可测性）', () => {
    expect(estimateColumnWidth(['abcd'], 'c', { charWidth: 10, padding: 0, minWidth: 0, maxWidth: 1000 })).toBe(
      Math.ceil(4 * 10 * 1.06),
    );
  });
});

describe('A8 选中区聚合', () => {
  it('正常聚合：count/sum/avg/min/max 单遍完成', () => {
    const a = aggregateSelection([1, 2, 3, 4]);
    expect(a).toEqual({ count: 4, sum: 10, avg: 2.5, min: 1, max: 4 });
  });

  it('非数字/NULL/NaN/Infinity 跳过', () => {
    const a = aggregateSelection([1, null, 'x', NaN, Infinity, -Infinity, undefined, 9]);
    expect(a).toEqual({ count: 2, sum: 10, avg: 5, min: 1, max: 9 });
  });

  it('无可统计数字（空 / 全 NULL / 全字符串）返回 null', () => {
    expect(aggregateSelection([])).toBeNull();
    expect(aggregateSelection([null, undefined])).toBeNull();
    expect(aggregateSelection(['a', 'b'])).toBeNull();
    expect(aggregateSelection([NaN])).toBeNull();
  });

  it('单个值与全负数：min=max、avg 正确', () => {
    expect(aggregateSelection([-5])).toEqual({ count: 1, sum: -5, avg: -5, min: -5, max: -5 });
    const a = aggregateSelection([-10, -2, -6]);
    expect(a).toEqual({ count: 3, sum: -18, avg: -6, min: -10, max: -2 });
  });
});

describe('A15 网格视图持久化', () => {
  it('roundtrip：serialize → restore 原样恢复', () => {
    const s = serializeGridView({ widths: { id: 90, name: 220 }, hidden: ['created_at'], wrap: true, frozenCount: 2 });
    expect(restoreGridView(s)).toEqual({ widths: { id: 90, name: 220 }, hidden: ['created_at'], wrap: true, frozenCount: 2 });
  });

  it('损坏 JSON / 非对象返回 null，不抛异常', () => {
    expect(restoreGridView(null)).toBeNull();
    expect(restoreGridView(undefined)).toBeNull();
    expect(restoreGridView('')).toBeNull();
    expect(restoreGridView('{not json')).toBeNull();
    expect(restoreGridView('42')).toBeNull();
    expect(restoreGridView('"str"')).toBeNull();
  });

  it('单字段类型错只丢该字段，其余恢复（半份数据比全丢好）', () => {
    const raw = JSON.stringify({ widths: { id: 'big', ok: 120 }, hidden: 'name', wrap: 'yes' });
    expect(restoreGridView(raw)).toEqual({ widths: { ok: 120 }, hidden: [], wrap: false, frozenCount: 0 });
  });

  it('宽度 clamp 到 [40, 2000]，非法数字丢弃；hidden 去重', () => {
    const raw = JSON.stringify({ widths: { a: 5, b: 99999, c: 55.9, d: NaN }, hidden: ['x', 'x', 'y'] });
    expect(restoreGridView(raw)).toEqual({ widths: { a: 40, b: 2000, c: 55 }, hidden: ['x', 'y'], wrap: false, frozenCount: 0 });
  });

  it('serialize 写入前同样规范化，存储里永远合法', () => {
    const s = serializeGridView({ widths: { a: -10, b: Number.POSITIVE_INFINITY }, hidden: [], wrap: false });
    expect(restoreGridView(s)).toEqual({ widths: { a: COLUMN_WIDTH_MIN }, hidden: [], wrap: false, frozenCount: 0 });
  });

  it('存储键带版本前缀，不同表互不串key', () => {
    expect(gridViewStorageKey('c1:db:t')).toBe(`${GRID_VIEW_STORAGE_PREFIX}c1:db:t`);
    expect(gridViewStorageKey('c1:db:t')).not.toBe(gridViewStorageKey('c1:db:t2'));
  });

  it('COLUMN_WIDTH 约束：min 40，max 600', () => {
    expect(COLUMN_WIDTH_MIN).toBe(40);
    expect(COLUMN_WIDTH_MAX).toBe(600);
  });
});
