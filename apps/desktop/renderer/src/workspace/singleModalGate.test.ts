import { describe, expect, it } from 'vitest';
import { SingleModalGate } from './singleModalGate';

describe('SingleModalGate（#79 单槽位模态并发收口）', () => {
  it('空闲时可占用，占用后 busy 为 true', () => {
    const g = new SingleModalGate<string>();
    expect(g.busy).toBe(false);
    expect(g.tryAcquire(() => {})).toBe(true);
    expect(g.busy).toBe(true);
  });

  it('🔴 核心靶子：已占用时第二次 tryAcquire 必须失败（不许覆盖先来的）', () => {
    const g = new SingleModalGate<string>();
    const first: string[] = [];
    const second: string[] = [];
    expect(g.tryAcquire((d) => first.push(d))).toBe(true);
    // 旧实现（单槽位直接赋值）会让这一步覆盖 first 的 resolver → first 永远不落定
    expect(g.tryAcquire((d) => second.push(d))).toBe(false);
    expect(g.busy).toBe(true);
  });

  it('release 交还的是**先来的**那个 resolver（证明没被顶掉）', () => {
    const g = new SingleModalGate<string>();
    const first: string[] = [];
    const second: string[] = [];
    g.tryAcquire((d) => first.push(d));
    g.tryAcquire((d) => second.push(d)); // 被拒
    const r = g.release();
    r?.('save');
    expect(first).toEqual(['save']); // 先来的拿到决定
    expect(second).toEqual([]); // 后来的没被登记
    expect(g.busy).toBe(false);
  });

  it('release 后可以再次占用（模态关闭后能开下一个）', () => {
    const g = new SingleModalGate<string>();
    g.tryAcquire(() => {});
    g.release();
    expect(g.tryAcquire(() => {})).toBe(true);
  });

  it('release 幂等：重复释放、空释放都返回 null 不抛', () => {
    const g = new SingleModalGate<string>();
    expect(g.release()).toBeNull(); // 从未占用
    g.tryAcquire(() => {});
    expect(g.release()).not.toBeNull();
    expect(g.release()).toBeNull(); // 重复释放
  });

  it('对照：并发两次 → 只有一个能占用（不会两个都成功）', () => {
    const g = new SingleModalGate<number>();
    const results = [
      g.tryAcquire(() => {}),
      g.tryAcquire(() => {}),
      g.tryAcquire(() => {}),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});