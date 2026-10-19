/**
 * T33：结果网格「查看完整值」取值的单元测试。
 *
 * 证伪重点：
 *  - 「越界不弹」配「界内会弹」；
 *  - 「值就是 source.raw 的**同一个对象**」—— 若实现改用展示串，
 *    Uint8Array 会被变成 "[object Uint8Array]" 之类，断言立刻红。
 */

import { describe, it, expect } from 'vitest';
import {
  readResultCell,
  readResultRow,
  buildResultInspectHandler,
  resultDisplayTable,
  resultDisplayDatabase,
  type ResultCellSourceLike,
  type ResultCellRef,
} from './resultCell';

/** 最小假数据源：值按 [row][col] 存原样对象 */
function fakeSource(rows: unknown[][], names: string[]): ResultCellSourceLike {
  return {
    rowCount: rows.length,
    columnCount: names.length,
    columnName: (c) => names[c] ?? '',
    raw: (r, c) => rows[r]?.[c] ?? null,
  };
}

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

describe('T33 读取待检视的单元格', () => {
  const src = fakeSource([['a', 1], ['b', BYTES]], ['name', 'blob']);

  it('界内：拿到列名 + 原始值', () => {
    const cell = readResultCell(src, 1, 1);
    expect(cell).not.toBeNull();
    if (cell === null) throw new Error('unreachable');
    expect(cell.column).toBe('blob');
    // 🔴 同一个对象 —— 内容与原字节一致的唯一保证
    expect(cell.value).toBe(BYTES);
  });

  it('越界一律 null（结果被替换的瞬间网格可能报旧行列号）', () => {
    expect(readResultCell(src, 2, 0)).toBeNull();
    expect(readResultCell(src, 0, 2)).toBeNull();
    expect(readResultCell(src, -1, 0)).toBeNull();
    expect(readResultCell(src, 0, -1)).toBeNull();
    // 非整数（NaN / 小数）也不该取到值
    expect(readResultCell(src, 0.5, 0)).toBeNull();
    expect(readResultCell(src, Number.NaN, 0)).toBeNull();
  });

  it('空结果集任何下标都取不到', () => {
    const empty = fakeSource([], []);
    expect(readResultCell(empty, 0, 0)).toBeNull();
  });
});

describe('T33 回调装配', () => {
  it('界内回调 → open 拿到原始值（对照：下面越界不触发）', () => {
    const src = fakeSource([['a', BYTES]], ['name', 'blob']);
    const seen: ResultCellRef[] = [];
    const h = buildResultInspectHandler(src, (c) => seen.push(c));
    // 🔴 类型层面就已经是必填：写成 undefined 编译不过
    expect(typeof h.onInspectCell).toBe('function');
    h.onInspectCell(0, 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].value).toBe(BYTES);
    expect(seen[0].column).toBe('blob');
  });

  it('越界回调 → 静默不弹（不弹一个内容错的弹窗）', () => {
    const src = fakeSource([['a']], ['name']);
    const seen: ResultCellRef[] = [];
    const h = buildResultInspectHandler(src, (c) => seen.push(c));
    h.onInspectCell(9, 0);
    expect(seen).toHaveLength(0);
  });

  it('大整数与 NULL 各归各位（不丢精度、不混成空串）', () => {
    const big = 9007199254740993n;
    const src = fakeSource([[big, null, '']], ['id', 'n', 's']);
    expect(readResultCell(src, 0, 0)?.value).toBe(big);
    expect(readResultCell(src, 0, 1)?.value).toBeNull();
    // 空串必须保留为空串（红线 6：NULL 与空串严格区分）
    expect(readResultCell(src, 0, 2)?.value).toBe('');
  });
});

describe('T39 读一行结果做行定位', () => {
  const src = fakeSource(
    [
      ['1001', 'alpha', null],
      ['1002', 'beta', BYTES],
    ],
    ['id', 'name', 'blob'],
  );

  it('按列名摊平，数字也转成原文字符串（不经过 Number，大整数不丢精度）', () => {
    const row = readResultRow(src, 0);
    expect(row).toEqual([
      { column: 'id', value: '1001' },
      { column: 'name', value: 'alpha' },
      { column: 'blob', value: null },
    ]);
  });

  it('BIGINT 越 2^53 的原文保持逐字（定位列被 Number 化就会匹到错行）', () => {
    const big = fakeSource([['9007199254740993']], ['id']);
    expect(readResultRow(big, 0)?.[0].value).toBe('9007199254740993');
  });

  it('二进制列不猜值 → null（宿主据此拒绝等值定位）', () => {
    const row = readResultRow(src, 1);
    expect(row?.find((c) => c.column === 'blob')?.value).toBeNull();
    // 对照组：同一行的文本列正常取值
    expect(row?.find((c) => c.column === 'id')?.value).toBe('1002');
  });

  it('越界 → null（结果刚被替换时报旧行号，宁可不定也不定错）', () => {
    expect(readResultRow(src, 2)).toBeNull();
    expect(readResultRow(src, -1)).toBeNull();
    expect(readResultRow(src, 0.5)).toBeNull();
  });
});

describe('T33 值查看器的来源上下文', () => {
  it('单表结果 → 给来源表（弹窗标题可追溯到这张表）', () => {
    const t = resultDisplayTable({ database: 'order_db', table: 'order' });
    expect(t?.name).toBe('order');
  });

  it('JOIN / 聚合 / 未检出 → null，绝不猜一个表名', () => {
    expect(resultDisplayTable(null)).toBeNull();
    expect(resultDisplayTable(undefined)).toBeNull();
    expect(resultDisplayTable({ database: null, table: '' })).toBeNull();
  });

  it('库：优先来源库，没有才退回当前查询库，都没有就是 null', () => {
    expect(resultDisplayDatabase({ database: 'order_db', table: 'order' }, 'other')).toBe('order_db');
    expect(resultDisplayDatabase(null, 'other')).toBe('other');
    expect(resultDisplayDatabase(null, null)).toBeNull();
    expect(resultDisplayDatabase({ database: '', table: 'order' }, '')).toBeNull();
  });
});
