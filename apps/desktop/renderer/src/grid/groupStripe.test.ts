/**
 * 分组行条纹（V19）单测 —— 纯函数，不依赖 DOM。
 * 覆盖：边界判定（1,1,2,2,3 → A,A,B,B,A）、NULL 与 '' 严格区分、数值字符串按数值比、
 *       关闭开关、O(1) 查表一致性、10 万行构建耗时。
 */
import { describe, it, expect } from 'vitest';
import {
  buildGroupStripes,
  stripeClassAt,
  groupStripeClass,
  sameGroupValue,
  STRIPE_A,
  STRIPE_B,
} from './groupStripe';

/** 把整列条纹翻译成 A/B 串，断言时一眼可读 */
function stripesOf(values: readonly unknown[], opts?: { enabled?: boolean }): string {
  const s = buildGroupStripes(values, opts);
  let out = '';
  for (let i = 0; i < values.length; i++) out += stripeClassAt(s, i) === 'grp-b' ? 'B' : 'A';
  return out;
}

describe('buildGroupStripes · 边界判定', () => {
  it('1,1,2,2,3 → A,A,B,B,A（按"值变化的边界"翻转，不是按值哈希）', () => {
    expect(stripesOf([1, 1, 2, 2, 3])).toBe('AABBA');
  });

  it('连续多次变化则严格交替', () => {
    expect(stripesOf(['a', 'b', 'c', 'd'])).toBe('ABAB');
    expect(stripesOf(['a', 'a', 'b', 'b', 'a'])).toBe('AABBA');
  });

  it('空数组 → 空表，任何下标都不着色', () => {
    const s = buildGroupStripes([]);
    expect(s.length).toBe(0);
    expect(stripeClassAt(s, 0)).toBe('');
    expect(groupStripeClass([], 0)).toBe('');
  });

  it('单行 → 第一组 A', () => {
    expect(stripesOf([42])).toBe('A');
  });

  it('全同值 → 全是同一组（A），不交替', () => {
    expect(stripesOf(['x', 'x', 'x', 'x'])).toBe('AAAA');
  });

  it('布尔值也能分组', () => {
    expect(stripesOf([true, true, false, false, true])).toBe('AABBA');
  });
});

describe('sameGroupValue · 相等口径', () => {
  it('NULL 与空串严格区分（数据保真红线）', () => {
    expect(sameGroupValue(null, '')).toBe(false);
    expect(sameGroupValue('', null)).toBe(false);
    expect(stripesOf([null, '', null])).toBe('ABA');
  });

  it('NULL 与 NULL 同组', () => {
    expect(sameGroupValue(null, null)).toBe(true);
    expect(stripesOf([null, null])).toBe('AA');
  });

  it('undefined 按 NULL 处理（网格里"没取到值"与 NULL 同义）', () => {
    expect(sameGroupValue(undefined, null)).toBe(true);
    expect(sameGroupValue(undefined, '')).toBe(false);
  });

  it('数值字符串按数值比："10" 与 "9" 不同值 → 换组', () => {
    expect(sameGroupValue('10', '9')).toBe(false);
    expect(stripesOf(['10', '9'])).toBe('AB');
  });

  it('数值字符串按数值比："10" 与 "10.0" 同值 → 同组', () => {
    expect(sameGroupValue('10', '10.0')).toBe(true);
    expect(stripesOf(['10', '10.0'])).toBe('AA');
  });

  it('"007" 与 "7" 同值（R10：BIGINT 以字符串返回，前导零不该切开同一组）', () => {
    expect(sameGroupValue('007', '7')).toBe(true);
  });

  it('数字 7 与字符串 "7" 同值', () => {
    expect(sameGroupValue(7, '7')).toBe(true);
  });

  it('不能转数值时按字符串比（大小写敏感）', () => {
    expect(sameGroupValue('abc', 'ABC')).toBe(false);
    expect(sameGroupValue('abc', 'abc')).toBe(true);
  });

  it('一个能转数值一个不能 → 不假装相等', () => {
    expect(sameGroupValue(7, 'abc')).toBe(false);
    expect(sameGroupValue('abc', 7)).toBe(false);
  });

  it('首尾有空白的字符串不当数值（避免 " 12" 与 12 混为一组）', () => {
    expect(sameGroupValue(' 12', 12)).toBe(false);
    expect(sameGroupValue('12', 12)).toBe(true);
  });

  it('NaN 不当数值：NaN 与 NaN 不同组（脏数据不该整列粘成一块）', () => {
    expect(sameGroupValue(NaN, NaN)).toBe(false);
    // Infinity 也不算"有限数值"，兜底走严格相等 —— 与 Infinity 自身仍同组
    expect(sameGroupValue(Infinity, Infinity)).toBe(true);
    expect(sameGroupValue(Infinity, 1)).toBe(false);
  });

  it('对称：a 与 b、b 与 a 判定一致', () => {
    const cases: unknown[] = [null, '', '10', '10.0', 7, 'abc', undefined];
    for (const a of cases) {
      for (const b of cases) expect(sameGroupValue(a, b)).toBe(sameGroupValue(b, a));
    }
  });
});

describe('开关与表结构', () => {
  it('enabled:false → 空表，全列不着色', () => {
    const s = buildGroupStripes([1, 1, 2, 2, 3], { enabled: false });
    expect(s.length).toBe(0);
    for (let i = 0; i < 5; i++) expect(stripeClassAt(s, i)).toBe('');
  });

  it('enabled 省略（默认开）→ 正常分条纹', () => {
    expect(stripesOf([1, 1, 2])).toBe('AAB');
  });

  it('返回 Uint8Array，长度等于行数，取值只有 0/1', () => {
    const values = [1, 1, 2, 2, 3, 3, 4];
    const s = buildGroupStripes(values);
    expect(s).toBeInstanceOf(Uint8Array);
    expect(s.length).toBe(values.length);
    for (const v of s) expect(v === STRIPE_A || v === STRIPE_B).toBe(true);
  });

  it('不修改入参（纯函数）', () => {
    const values = [1, 1, 2];
    const copy = [...values];
    buildGroupStripes(values);
    expect(values).toEqual(copy);
  });
});

describe('渲染侧查表（红线：O(1) 且不分配对象）', () => {
  it('同一 rowIndex 多次查表结果完全一致（无副作用、不随机）', () => {
    const s = buildGroupStripes([1, 1, 2, 2, 3]);
    for (const i of [0, 2, 4]) {
      expect(stripeClassAt(s, i)).toBe(stripeClassAt(s, i));
      expect(stripeClassAt(s, i)).toBe(stripeClassAt(s, i));
    }
    expect([0, 1, 2, 3, 4].map((i) => stripeClassAt(s, i))).toEqual([
      'grp-a',
      'grp-a',
      'grp-b',
      'grp-b',
      'grp-a',
    ]);
  });

  it('越界下标（负数 / 超出长度）返回空类名，不抛错', () => {
    const s = buildGroupStripes([1, 1, 2]);
    expect(stripeClassAt(s, -1)).toBe('');
    expect(stripeClassAt(s, 3)).toBe('');
    expect(stripeClassAt(s, 9999)).toBe('');
  });

  it('groupStripeClass 传预计算表与 stripeClassAt 完全等价', () => {
    const values = ['a', 'a', 'b', 'c', 'c'];
    const s = buildGroupStripes(values);
    for (let i = 0; i < values.length; i++) {
      expect(groupStripeClass(s, i)).toBe(stripeClassAt(s, i));
    }
  });

  it('groupStripeClass 直接传值数组（扫描路径）与预计算表结果一致', () => {
    const values = [1, 1, 2, 2, 3, null, null, ''];
    const s = buildGroupStripes(values);
    for (let i = 0; i < values.length; i++) {
      expect(groupStripeClass(values, i)).toBe(stripeClassAt(s, i));
    }
    expect(groupStripeClass(values, 99)).toBe('');
  });

  it('10 万行构建耗时 < 50ms（虚拟滚动预计算必须够快）', () => {
    const n = 100_000;
    const values = Array.from({ length: n }, (_, i) => `group-${i % 1000}`);
    const t0 = performance.now();
    const s = buildGroupStripes(values);
    const cost = performance.now() - t0;
    expect(s.length).toBe(n);
    expect(cost).toBeLessThan(50);
  });
});
