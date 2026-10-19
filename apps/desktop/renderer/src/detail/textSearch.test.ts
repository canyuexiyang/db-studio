import { describe, it, expect } from 'vitest';
import { measureText, formatTextMetrics } from './textMetrics';
import { runSearch, findAllMatches, cancelSearch, SEARCH_INITIAL_STATE, DEFAULT_MAX_MATCHES } from './textSearch';

/**
 * T32/T35 共用的查找引擎与文本度量（textMetrics 口径：Unicode 码点）。
 */

describe('measureText · 码点口径（emoji 算 1 个字符）', () => {
  it('代理对只算一个码点，但 UTF-16 长度照实', () => {
    const m = measureText('a😀b');
    expect(m.codePoints).toBe(3);
    expect(m.utf16Units).toBe(4);
  });

  it('空串是 0 行；有内容按行数 +1', () => {
    expect(measureText('')).toEqual({ codePoints: 0, utf16Units: 0, lines: 0 });
    expect(measureText('ab\ncd').lines).toBe(2);
    expect(measureText('ab\r\ncd').lines).toBe(2); // CRLF 算一个换行
    expect(measureText('ab\rcd').lines).toBe(2); // 裸 CR 也算
  });

  it('formatTextMetrics 两个口径都带名字（不让用户猜）', () => {
    const s = formatTextMetrics(measureText('ab'));
    expect(s).toContain('字符（码点）');
    expect(s).toContain('UTF-16');
  });
});

describe('runSearch · 纯文本查找（非正则、可取消）', () => {
  it('基本命中：升序、非重叠', () => {
    const st = findAllMatches('aXbXcXd', { text: 'X' });
    expect(st.matches).toEqual([1, 3, 5]);
    expect(st.done).toBe(true);
    expect(st.cancelled).toBe(false);
  });

  it('🔴 查询串里的正则元字符按字面匹配（new RegExp 缺陷的证伪）', () => {
    const st = findAllMatches('a.c axc a*c', { text: 'a.c' });
    expect(st.matches).toEqual([0]);
  });

  it('大小写：默认不敏感（ASCII 折叠），可开敏感', () => {
    expect(findAllMatches('Ab aB ab', { text: 'ab' }).matches).toEqual([0, 3, 6]);
    expect(findAllMatches('Ab aB ab', { text: 'ab', caseSensitive: true }).matches).toEqual([6]);
  });

  it('空查询：done 且零命中', () => {
    const st = findAllMatches('abc', { text: '' });
    expect(st.done).toBe(true);
    expect(st.matches).toEqual([]);
  });

  it('分块续跑：budget 耗尽挂起，下一轮接着扫', () => {
    const hay = 'ab'.repeat(100);
    let st = runSearch(hay, { text: 'ab' }, SEARCH_INITIAL_STATE, 50);
    expect(st.done).toBe(false);
    expect(st.scanned).toBe(50);
    while (!st.done) {
      st = runSearch(hay, { text: 'ab' }, st, 50);
    }
    expect(st.matches.length).toBe(100);
  });

  it('取消：cancelled=true 后续 runSearch 原样返回', () => {
    const hay = 'x'.repeat(1000);
    let st = runSearch(hay, { text: 'y' }, SEARCH_INITIAL_STATE, 100);
    st = cancelSearch(st);
    expect(st.cancelled).toBe(true);
    const after = runSearch(hay, { text: 'y' }, st, 100);
    expect(after).toBe(st); // 同一引用 = 不再推进
  });

  it('已 done 的状态取消是 no-op（幂等）', () => {
    const st = findAllMatches('abc', { text: 'a' });
    expect(cancelSearch(st)).toBe(st);
  });

  it('命中上限截断：truncated=true 且 done', () => {
    const st = findAllMatches('a'.repeat(100), { text: 'a' }, 10);
    expect(st.matches.length).toBe(10);
    expect(st.truncated).toBe(true);
    expect(st.done).toBe(true);
    expect(DEFAULT_MAX_MATCHES).toBe(5000);
  });
});
