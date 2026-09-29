/**
 * 列快速定位（V20）单测 —— 纯函数，不碰 DOM。
 * 覆盖：四档匹配规则、档位排序、命中下标、稳定排序、limit 截断、空输入、驼峰缩写。
 */
import { describe, it, expect } from 'vitest';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import { rankColumns, DEFAULT_COLUMN_HIT_LIMIT } from './columnFinder';

/** 造一个列（只填打分用到的字段） */
function col(name: string, dataType = 'int', extra: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
    ...extra,
  };
}

/** 只取列名，断言时更好读 */
function names(hits: { column: ColumnMeta }[]): string[] {
  return hits.map((h) => h.column.name);
}

const COLS = [
  col('id', 'bigint', { isPrimaryKey: true }),
  col('created_at', 'datetime'),
  col('customer_address_id', 'bigint'),
  col('status', 'varchar(32)'),
  col('total_amount', 'decimal(12,2)'),
];

describe('rankColumns · 空输入', () => {
  it('空 query 返回原顺序的若干条，不打分也不高亮', () => {
    const hits = rankColumns(COLS, '');
    expect(names(hits)).toEqual(['id', 'created_at', 'customer_address_id', 'status', 'total_amount']);
    expect(hits.every((h) => h.score === 0)).toBe(true);
    expect(hits.every((h) => h.matches.length === 0)).toBe(true);
  });

  it('纯空格 query 等同空输入', () => {
    expect(names(rankColumns(COLS, '   '))).toEqual(names(rankColumns(COLS, '')));
  });

  it('空 query 也受 limit 约束（默认 50 条）', () => {
    const many = Array.from({ length: 80 }, (_, i) => col(`c${i}`));
    expect(rankColumns(many, '')).toHaveLength(DEFAULT_COLUMN_HIT_LIMIT);
    expect(names(rankColumns(many, ''))[0]).toBe('c0');
  });

  it('列集合为空 → 空数组', () => {
    expect(rankColumns([], 'id')).toEqual([]);
    expect(rankColumns([], '')).toEqual([]);
  });

  it('limit ≤ 0 → 空数组（调用方要"先不要结果"）', () => {
    expect(rankColumns(COLS, 'id', 0)).toEqual([]);
    expect(rankColumns(COLS, '', 0)).toEqual([]);
  });
});

describe('rankColumns · 前缀与子串', () => {
  it('前缀命中（cre → created_at 排在子序列命中的列之前）', () => {
    const hits = rankColumns(COLS, 'cre');
    expect(names(hits)[0]).toBe('created_at');
    expect(hits[0].matches).toEqual([0, 1, 2]);
    // customer_address_id 只能靠 c…r…e 的子序列命中，档位更低，排在后面
    expect(names(hits)).toContain('customer_address_id');
    expect(hits.find((h) => h.column.name === 'customer_address_id')!.score).toBeLessThan(hits[0].score);
  });

  it('大小写不敏感（CRE / Cre 与 cre 同结果）', () => {
    expect(names(rankColumns(COLS, 'CRE'))).toEqual(names(rankColumns(COLS, 'cre')));
    expect(names(rankColumns(COLS, 'Cre'))).toEqual(names(rankColumns(COLS, 'cre')));
  });

  it('子串命中（非前缀：ated → created_at）', () => {
    const hits = rankColumns(COLS, 'ated');
    expect(names(hits)).toEqual(['created_at']);
    expect(hits[0].matches).toEqual([3, 4, 5, 6]);
  });

  it('query 首尾空格被 trim 后照常命中', () => {
    expect(names(rankColumns(COLS, '  status  '))).toEqual(['status']);
  });

  it('前缀排在子串前面', () => {
    const list = [col('xcreated_at'), col('created_at')];
    expect(names(rankColumns(list, 'cre'))).toEqual(['created_at', 'xcreated_at']);
  });

  it('命中下标是原字符串下标（子串偏移正确，可直接切片高亮）', () => {
    const hits = rankColumns([col('customer_address_id')], 'address');
    expect(hits[0].matches).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect('customer_address_id'.slice(9, 16)).toBe('address');
  });

  it('短名字在同档内优先（更"像"目标列）', () => {
    const list = [col('xlongname'), col('x')];
    expect(names(rankColumns(list, 'x'))).toEqual(['x', 'xlongname']);
  });
});

describe('rankColumns · 首字母缩写', () => {
  it('ca 命中 created_at（词首 c + a）', () => {
    const hits = rankColumns(COLS, 'ca');
    expect(names(hits)).toContain('created_at');
    const hit = hits.find((h) => h.column.name === 'created_at')!;
    expect(hit.matches).toEqual([0, 8]); // c 在词首 0，a 在词首 8（下划线后）
  });

  it('缩写下标都落在词首上（customer_address_id 的 cai）', () => {
    const hits = rankColumns([col('customer_address_id')], 'cai');
    expect(hits).toHaveLength(1);
    expect(hits[0].matches).toEqual([0, 9, 17]);
    expect([0, 9, 17].map((i) => 'customer_address_id'[i]).join('')).toBe('cai');
  });

  it('驼峰也算词首（customerAddressId 的 cai）', () => {
    const hits = rankColumns([col('customerAddressId')], 'cai');
    expect(hits[0].matches).toEqual([0, 8, 15]);
  });

  it('缩写档位高于子序列档位（同为可命中列时缩写列在前）', () => {
    // discount_rate 只能靠子序列命中（c…a 都非词首），created_at 是缩写命中
    const list = [col('discount_rate'), col('created_at')];
    const hits = rankColumns(list, 'ca');
    expect(names(hits)[0]).toBe('created_at');
    const sub = hits.find((h) => h.column.name === 'discount_rate')!;
    expect(sub.score).toBeLessThan(400); // 落在子序列档
    expect(sub.matches).toEqual([3, 10]);
  });

  it('query 比词数多时不算缩写，退回子序列', () => {
    const hits = rankColumns([col('created_at')], 'ca_t');
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeLessThan(400);
  });
});

describe('rankColumns · 模糊子序列', () => {
  it('子序列命中（crdat → created_at）', () => {
    const hits = rankColumns(COLS, 'crdat');
    expect(names(hits)).toEqual(['created_at']);
  });

  it('子序列命中下标升序且能拼回 query', () => {
    const name = 'customer_address_id';
    const hits = rankColumns([col(name)], 'csad');
    const idx = hits[0].matches;
    expect(idx.length).toBe(4);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(idx.map((i) => name[i]).join('')).toBe('csad');
  });

  it('顺序不对（反序）不命中', () => {
    expect(rankColumns([col('created_at')], 'tac')).toEqual([]);
  });

  it('完全匹配不上 → 空数组', () => {
    expect(rankColumns(COLS, 'zzz')).toEqual([]);
  });
});

describe('rankColumns · 排序与截断', () => {
  it('档位严格递减：前缀 > 子串 > 缩写 > 子序列', () => {
    const one = [col('created_at')];
    const prefix = rankColumns(one, 'cre')[0].score;
    const substring = rankColumns(one, 'ated')[0].score;
    const acronym = rankColumns(one, 'ca')[0].score;
    const subsequence = rankColumns(one, 'crdat')[0].score;
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(acronym);
    expect(acronym).toBeGreaterThan(subsequence);
  });

  it('同分按原列序（稳定，不随机换位）', () => {
    const a = [col('xa'), col('xb'), col('xc')];
    const b = [col('xc'), col('xb'), col('xa')];
    expect(names(rankColumns(a, 'x'))).toEqual(['xa', 'xb', 'xc']);
    expect(names(rankColumns(b, 'x'))).toEqual(['xc', 'xb', 'xa']);
  });

  it('显式 limit 截断（按分数从高到低取前 n 条）', () => {
    const many = Array.from({ length: 10 }, (_, i) => col(`x${i}`));
    expect(rankColumns(many, 'x', 3)).toHaveLength(3);
    expect(names(rankColumns(many, 'x', 3))).toEqual(['x0', 'x1', 'x2']);
  });

  it('结果条数不超过列数（limit 大于列数时不补空）', () => {
    expect(rankColumns(COLS, '', 999)).toHaveLength(COLS.length);
  });

  it('纯函数：同样输入两次调用结果完全一致', () => {
    const r1 = rankColumns(COLS, 'ca');
    const r2 = rankColumns(COLS, 'ca');
    expect(r1).toEqual(r2);
    expect(names(r1)).toEqual(names(r2));
  });
});
