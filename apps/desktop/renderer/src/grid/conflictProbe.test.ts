import { describe, it, expect } from 'vitest';
import { buildRowProbeSql, buildDiff, displayValue } from './conflictProbe';

describe('buildRowProbeSql · 冲突行回查（T09/R15）', () => {
  it('单列定位键生成 NULL 安全比较（`<=>` 而不是 `=`）', () => {
    const p = buildRowProbeSql('order_db', 'orders', ['id'], [42]);
    expect(p.sql).toBe('SELECT * FROM `order_db`.`orders` WHERE `id` <=> ? LIMIT 2');
    expect(p.params).toEqual([42]);
  });

  it('复合定位键逐列 AND 拼接', () => {
    const p = buildRowProbeSql('d', 't', ['a', 'b'], [1, 'x']);
    expect(p.sql).toBe('SELECT * FROM `d`.`t` WHERE `a` <=> ? AND `b` <=> ? LIMIT 2');
    expect(p.params).toEqual([1, 'x']);
  });

  it('🔴 标识符走 core-sql-ident（含反引号的名字不会被拼坏）', () => {
    const p = buildRowProbeSql('we`ird', 'ta`ble', ['c`ol'], [1]);
    expect(p.sql).toBe('SELECT * FROM `we``ird`.`ta``ble` WHERE `c``ol` <=> ? LIMIT 2');
  });

  it('没有定位列时抛错（不生成会误伤的 SQL）', () => {
    expect(() => buildRowProbeSql('d', 't', [], [])).toThrow();
  });
});

describe('displayValue / buildDiff', () => {
  it('NULL 与空串必须可区分（红线 6）', () => {
    expect(displayValue(null)).toBe('NULL');
    expect(displayValue(undefined)).toBe('NULL');
    expect(displayValue('')).toBe('');
    expect(displayValue('')).not.toBe(displayValue(null));
  });

  it('二进制值不展开成垃圾字符串', () => {
    expect(displayValue(new Uint8Array([1, 2, 3]))).toBe('<二进制 3 字节>');
  });

  it('标出「库中现值 ≠ 原值」的列（冲突根因）', () => {
    const diff = buildDiff(
      [
        { column: 'title', original: 'old', next: 'mine' },
        { column: 'qty', original: 5, next: 6 },
      ],
      { title: 'changed-by-other', qty: 5 },
    );
    expect(diff[0].drifted).toBe(true); // 被他人改过
    expect(diff[0].current).toBe('changed-by-other');
    expect(diff[0].next).toBe('mine');
    expect(diff[1].drifted).toBe(false);
    expect(diff[1].current).toBe('5');
  });

  it('未探测到（current=null）时全部列为 null，不谎报「已变化」', () => {
    const diff = buildDiff([{ column: 'a', original: 1, next: 2 }], null);
    expect(diff[0].current).toBeNull();
    expect(diff[0].drifted).toBe(false);
  });
});
