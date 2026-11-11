import { describe, expect, it } from 'vitest';
import { RequestGate } from './requestGate';

describe('RequestGate（#46 并发请求序号）', () => {
  it('begin 单调递增，isCurrent 只认最新序号', () => {
    const g = new RequestGate();
    const s1 = g.begin('t1');
    const s2 = g.begin('t1');
    const s3 = g.begin('t1');
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
    expect(g.isCurrent('t1', s3)).toBe(true);
    expect(g.isCurrent('t1', s1)).toBe(false);
    expect(g.isCurrent('t1', s2)).toBe(false);
  });

  it('🔴 竞态靶子：旧慢新快 —— 旧响应回来时已过期，必须被丢弃', () => {
    const g = new RequestGate();
    // 用户先排序（旧请求 A），随即改筛选（新请求 B）；A 慢、B 快
    const seqA = g.begin('tab'); // A 发起
    const seqB = g.begin('tab'); // B 发起（A 还没回）

    // B 先回：仍是最新 → 允许写入
    expect(g.isCurrent('tab', seqB)).toBe(true);
    // A 后回：已被 B 顶替 → 判过期，调用方据此丢弃 A 的结果，不覆盖 B
    expect(g.isCurrent('tab', seqA)).toBe(false);
  });

  it('对照：没有更新请求时，响应回来仍是当前（不误伤正常单次拉取）', () => {
    const g = new RequestGate();
    const seq = g.begin('solo');
    expect(g.isCurrent('solo', seq)).toBe(true);
  });

  it('不同 key 互相独立（两个 tab 各自拉取不串号）', () => {
    const g = new RequestGate();
    const a1 = g.begin('A');
    const b1 = g.begin('B');
    const a2 = g.begin('A'); // A 又来一次，不该影响 B
    expect(g.isCurrent('A', a2)).toBe(true);
    expect(g.isCurrent('A', a1)).toBe(false);
    expect(g.isCurrent('B', b1)).toBe(true); // B 仍是自己的最新
  });

  it('clear 后该 key 从 1 重新计数，且旧序号不再被判为当前', () => {
    const g = new RequestGate();
    const s = g.begin('gone');
    g.clear('gone');
    expect(g.isCurrent('gone', s)).toBe(false); // 清了之后旧号作废
    expect(g.begin('gone')).toBe(1); // 重新从 1 开始
  });

  it('未知 key 的 isCurrent 恒为 false（没 begin 过就没有"当前"）', () => {
    const g = new RequestGate();
    expect(g.isCurrent('never', 1)).toBe(false);
  });
});
