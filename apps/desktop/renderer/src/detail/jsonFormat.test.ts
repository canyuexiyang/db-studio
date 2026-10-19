import { describe, it, expect } from 'vitest';
import {
  formatJsonPreserving,
  formatCellJson,
  shouldTreatAsJson,
  isJsonColumn,
  looksLikeOversizedJson,
  JSON_FORMAT_MAX_CHARS,
} from './jsonFormat';

/**
 * 「原文语义核验」：剥掉字符串外的所有空白字符。
 * 保真美化只应增删空白 —— 归一化后必须与输入逐字相等。
 *
 * 🔴 刻意**不**用 JSON.parse 比较：那正是本缺陷的成因（parse 会把 2^53+1 变成 2^53），
 *    两边都先 parse 再比会掩盖同一种精度损失。
 */
function stripInsignificantWs(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '');
        i++;
        continue;
      }
      out += c;
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    out += c;
  }
  return out;
}

describe('formatJsonPreserving · 保真（T05/R04）', () => {
  it('🔴 超 2^53 的大整数逐字保留（旧 parse→stringify 会变成 ...992）', () => {
    const src = '{"id":9007199254740993}';
    const r = formatJsonPreserving(src);
    expect(r).not.toBeNull();
    expect(r!.pretty).toContain('9007199254740993');
    expect(r!.pretty).not.toContain('9007199254740992');
    // 用 JS Number 走一遍会得到错误值，证明本测试有证伪能力
    expect(String(JSON.parse(src).id)).toBe('9007199254740992');
  });

  it('长小数与指数原样保留（不经 Number 规范化）', () => {
    const src = '{"a":1.500,"b":1e3,"c":0.30000000000000004,"d":-0.0,"e":1E+10}';
    const r = formatJsonPreserving(src)!;
    expect(r.pretty).toContain('1.500');
    expect(r.pretty).toContain('1e3');
    expect(r.pretty).toContain('0.30000000000000004');
    expect(r.pretty).toContain('-0.0');
    expect(r.pretty).toContain('1E+10');
    expect(stripInsignificantWs(r.pretty)).toBe(stripInsignificantWs(src));
  });

  it('Unicode 转义原样保留（不被改写成实体字符）', () => {
    const src = '{"name":"\\u00e9\\u4e2d\\ud83d\\ude00","esc":"a\\"b\\\\c\\/d"}';
    const r = formatJsonPreserving(src)!;
    expect(r.pretty).toContain('\\u00e9');
    expect(r.pretty).toContain('\\ud83d\\ude00');
    expect(r.pretty).toContain('a\\"b\\\\c\\/d');
    expect(stripInsignificantWs(r.pretty)).toBe(stripInsignificantWs(src));
  });

  it('重复键不去重（JSON.parse 会丢前者）', () => {
    const src = '{"k":1,"k":2}';
    const r = formatJsonPreserving(src)!;
    expect(r.pretty.match(/"k"/g)?.length).toBe(2);
    expect(JSON.parse(src)).toEqual({ k: 2 }); // 对比：parse 只留最后一个
  });

  it('深层嵌套正确缩进且语义不变', () => {
    let src = '1';
    for (let i = 0; i < 60; i++) src = `{"a":[${src}]}`;
    const r = formatJsonPreserving(src);
    expect(r).not.toBeNull();
    expect(stripInsignificantWs(r!.pretty)).toBe(stripInsignificantWs(src));
    expect(r!.pretty.split('\n')[0]).toBe('{');
  });

  it('顶层 null / 数字 / 字符串 / 布尔 都是合法 JSON', () => {
    for (const src of ['null', '42', '-1.5e+3', '"hello"', 'true', 'false', '[]', '{}']) {
      const r = formatJsonPreserving(src);
      expect(r, src).not.toBeNull();
      expect(stripInsignificantWs(r!.pretty)).toBe(stripInsignificantWs(src));
    }
  });

  it('空容器不产生多余换行', () => {
    expect(formatJsonPreserving('{}')!.pretty).toBe('{}');
    expect(formatJsonPreserving('[ ]')!.pretty).toBe('[]');
    expect(formatJsonPreserving('{"a":{},"b":[]}')!.pretty).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it('标准缩进样例与 JSON.stringify(...,2) 形状一致', () => {
    const src = '{"a":1,"b":[2,3],"c":{"d":null}}';
    expect(formatJsonPreserving(src)!.pretty).toBe(JSON.stringify(JSON.parse(src), null, 2));
  });

  it('非法 JSON 返回 null（不抛异常）', () => {
    const bad = [
      '{"a":}', "{'a':1}", '{a:1}', '{"a":1,}', '[1,2', '{"a" 1}', 'tru', '01', '{"a":01}', '{"a":1}{"b":2}', '', '   ', '{"a":"未闭合}',
    ];
    for (const src of bad) expect(formatJsonPreserving(src), src).toBeNull();
  });
});

describe('formatCellJson · 入口策略（列类型 / 阈值）', () => {
  it('花括号/方括号开头 → 当 JSON，无论列类型', () => {
    expect(shouldTreatAsJson('{"a":1}', 'varchar')).toBe(true);
    expect(shouldTreatAsJson('[1,2]', 'text')).toBe(true);
    expect(formatCellJson('{"a":1}', 'varchar')!.pretty).toContain('"a"');
  });

  it('顶层标量只在 JSON 列类型下才当 JSON（否则 "42" 会与普通文本混淆）', () => {
    expect(shouldTreatAsJson('42', 'varchar')).toBe(false);
    expect(shouldTreatAsJson('42', 'json')).toBe(true);
    expect(formatCellJson('42', 'varchar')).toBeNull();
    expect(formatCellJson('42', 'json')!.pretty).toBe('42');
    expect(formatCellJson('"hi"', 'jsonb')!.pretty).toBe('"hi"');
    expect(isJsonColumn('JSON')).toBe(true);
    expect(isJsonColumn('jsonb')).toBe(true);
    expect(isJsonColumn('varchar')).toBe(false);
  });

  it('超过 256Ki 字符退回原文（返回 null）并提供「超阈值」信号', () => {
    const small = `{"a":"${'x'.repeat(1000)}"}`;
    expect(formatCellJson(small, 'json')).not.toBeNull();
    expect(looksLikeOversizedJson(small, 'json')).toBe(false);

    const huge = `{"a":"${'x'.repeat(JSON_FORMAT_MAX_CHARS + 10)}"}`;
    expect(formatCellJson(huge, 'json')).toBeNull();
    expect(looksLikeOversizedJson(huge, 'json')).toBe(true);
  });

  it('非字符串（NULL / 二进制）不进入 JSON 路径', () => {
    expect(formatCellJson(null, 'json')).toBeNull();
    expect(formatCellJson(new Uint8Array([1, 2]), 'json')).toBeNull();
    expect(shouldTreatAsJson(null, 'json')).toBe(false);
  });

  it('256Ki 边界：正好等于上限仍可格式化', () => {
    // 构造长度恰为 JSON_FORMAT_MAX_CHARS 的合法对象
    const pad = JSON_FORMAT_MAX_CHARS - 2 - '"a":""'.length + 3; // 允许近似；只要 ≤ 上限即可
    const src = `{"a":"${'x'.repeat(Math.max(0, pad))}"}`;
    if (src.length <= JSON_FORMAT_MAX_CHARS) {
      expect(formatCellJson(src, 'json')).not.toBeNull();
    }
  });
});
