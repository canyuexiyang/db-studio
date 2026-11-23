import { describe, expect, it } from 'vitest';
import { formatResultBytes, resultMetaLabel } from './resultMeta';

describe('resultMetaLabel（0.10.0 P1-06）', () => {
  it('行数 / 截断 / 大小 / 耗时按固定顺序', () => {
    expect(
      resultMetaLabel({ rowsLabel: '1,000 行', bytes: 4 * 1024 * 1024, queryMs: 126.9, truncated: true }),
    ).toBe('1,000 行 · 已截断 · 4.0 MB · 127 ms');
  });

  it('未知大小/耗时不编造 0', () => {
    expect(resultMetaLabel({ rowsLabel: '50 行', bytes: null, queryMs: null, truncated: false })).toBe('50 行');
  });

  it('字节按 1024 进制', () => {
    expect(formatResultBytes(0)).toBe('0 B');
    expect(formatResultBytes(999)).toBe('999 B');
    expect(formatResultBytes(1536)).toBe('1.5 KB');
    expect(formatResultBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});
