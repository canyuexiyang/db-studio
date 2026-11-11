import { describe, expect, it } from 'vitest';
import {
  RESULT_BYTE_BUDGET,
  RESULT_ROW_BUDGET,
  applyResultBudget,
  estimateResultBytes,
} from './result-budget';

function rows(n: number, width = 10): unknown[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: 3 }, (_, c) => `${i}-${c}`.padEnd(width, 'x')));
}

describe('T44 结果预算', () => {
  it('空结果不截断', () => {
    const r = applyResultBudget([]);
    expect(r.truncated).toBe(false);
    expect(r.estimatedBytes).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it('未超预算时原样返回（同一个数组引用，不做无意义复制）', () => {
    const input = rows(10);
    const r = applyResultBudget(input, { rowBudget: 100, byteBudget: 1024 * 1024 });
    expect(r.truncated).toBe(false);
    expect(r.rows).toBe(input);
    expect(r.reason).toBeNull();
  });

  it('超行数 → 从尾部截断，保留前 N 行（ORDER BY 才有意义）', () => {
    const input = rows(50);
    const r = applyResultBudget(input, { rowBudget: 10, byteBudget: 1024 * 1024 * 1024 });
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('rows');
    expect(r.rows).toHaveLength(10);
    expect(r.rows[0]).toBe(input[0]);
    expect(r.receivedRows).toBe(50);
  });

  it('超字节 → 按平均行宽折算保留行数（窄表行数上限更宽）', () => {
    const input = rows(1000, 100); // 每行约 3×200 = 600B
    const r = applyResultBudget(input, { rowBudget: 1_000_000, byteBudget: 60_000 });
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('bytes');
    expect(r.rows.length).toBeLessThan(1000);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('两种上限同时命中时取更严格的那个', () => {
    const input = rows(1000, 100);
    const r = applyResultBudget(input, { rowBudget: 500, byteBudget: 1000_000_000 });
    expect(r.reason).toBe('rows');
    const r2 = applyResultBudget(input, { rowBudget: 500, byteBudget: 60_000 });
    expect(r2.reason).toBe('bytes');
    expect(r2.rows.length).toBeLessThan(500);
  });

  it('二进制按真实字节计（BLOB 不能被当成小值）', () => {
    const small = [[new Uint8Array(10)]];
    const big = [[new Uint8Array(10_000)]];
    expect(estimateResultBytes(big)).toBeGreaterThan(estimateResultBytes(small) * 100);
  });

  /**
   * 🔴 #47 证伪靶子：大值在**后段**时，旧的「前 200 行采样外推」会严重低估。
   *
   * 构造：200 条窄行（每行 3 列 × 10 字符 = 84B）+ 第 201 行一条大 TEXT
   * （50000 字符 = 100008B）。byteBudget = 100000。
   *  - 旧采样：只采样前 200 窄行 → avgPerRow=84 → 外推 84×201≈16884 < 100000
   *    → 判定「不超预算」→ truncated=false（**漏掉**，这正是预算要防的最坏情况）；
   *  - 新累计：全量真实字节 = 16800+100008 = 116808 > 100000 → 必须截断。
   * 断言在旧实现下会红（truncated=false），是这次修复的证伪靶子。
   */
  it('🔴 大值在后段：采样会低估，真实累计必须抓到并截断', () => {
    const narrow = rows(200, 10); // 200 行窄行，各 84B
    const bigTail = [[ 'x'.repeat(50_000) ]]; // 第 201 行，100008B
    const input = [...narrow, ...bigTail];

    const r = applyResultBudget(input, { rowBudget: 1_000_000, byteBudget: 100_000 });

    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('bytes');
    // 保留前 200 窄行，第 201 行（压垮预算的那行）被切掉
    expect(r.rows).toHaveLength(200);
    expect(r.receivedRows).toBe(201);
    // estimatedBytes 是全量真实累计，不是采样外推的 ~16884
    expect(r.estimatedBytes).toBeGreaterThan(100_000);
  });

  it('对照：大值在前段时采样本就能抓到（证明靶子专挑采样的盲区）', () => {
    const bigHead = [[ 'x'.repeat(50_000) ]]; // 100008B 在最前
    const narrow = rows(200, 10);
    const input = [...bigHead, ...narrow];
    const r = applyResultBudget(input, { rowBudget: 1_000_000, byteBudget: 100_000 });
    // 第一行就压垮预算 → 至少保留 1 行、如实截断
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('bytes');
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('单行就超字节预算（巨型 BLOB）：至少留 1 行，但如实标截断', () => {
    const input = [[ new Uint8Array(200_000) ]]; // 单行 200008B > 预算
    const r = applyResultBudget(input, { rowBudget: 1_000_000, byteBudget: 100_000 });
    expect(r.rows).toHaveLength(1); // 无能为力时不返回空，但不静默
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe('bytes');
  });

  it('默认预算与常量一致（防止改常量忘改默认值）', () => {
    const justUnder = rows(RESULT_ROW_BUDGET);
    // 行数正好等于上限不算超
    expect(applyResultBudget(justUnder).truncated).toBe(false);
    const over = rows(RESULT_ROW_BUDGET + 1);
    const r = applyResultBudget(over);
    // 行数超限必然截断（除非先被字节上限卡住）
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeLessThanOrEqual(RESULT_ROW_BUDGET);
    expect(RESULT_BYTE_BUDGET).toBeGreaterThan(0);
  });
});
