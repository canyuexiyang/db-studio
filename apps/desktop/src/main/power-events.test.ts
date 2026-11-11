/**
 * power-events 测试（0.8.0 · P1-8 / #78）。
 *
 * 用内存假事件源驱动 suspend/resume，验证的是**决策逻辑**而非 Electron：
 *  - suspend → 释放全部活连接，返回释放数；
 *  - resume → 不主动重连（返回 0，且不调用任何重连动作）；
 *  - 幂等：释放进行中来第二次 suspend 不叠加；
 *  - 释放抛错不冒泡到事件循环（不变成 unhandledRejection）；
 *  - dispose 摘掉两个监听。
 */

import { describe, it, expect, vi } from 'vitest';
import { installPowerEvents, type PowerEventSource } from './power-events.js';

/** 最小假事件源：记录挂/摘的监听器，供手动触发 */
function fakeSource(): PowerEventSource & {
  fire: (e: 'suspend' | 'resume') => void;
  counts: () => { suspend: number; resume: number };
} {
  const listeners: Record<string, Set<() => void>> = { suspend: new Set(), resume: new Set() };
  return {
    on(event, listener) {
      listeners[event].add(listener);
    },
    removeListener(event, listener) {
      listeners[event].delete(listener);
    },
    fire(event) {
      for (const fn of [...listeners[event]]) fn();
    },
    counts: () => ({ suspend: listeners.suspend.size, resume: listeners.resume.size }),
  };
}

describe('installPowerEvents', () => {
  it('suspend 释放所有活连接，返回释放数', async () => {
    const src = fakeSource();
    const releaseAll = vi.fn(async () => ['c1', 'c2', 'c3']);
    const h = installPowerEvents({ source: src, releaseAll });

    src.fire('suspend');
    // fire 是同步触发 async 回调，这里 await 一个微任务轮让它跑完
    await Promise.resolve();
    await Promise.resolve();

    expect(releaseAll).toHaveBeenCalledTimes(1);
    expect(await h.triggerSuspend()).toBe(3); // 手动触发直接返回释放数
    expect(releaseAll).toHaveBeenCalledTimes(2);
  });

  it('🔴 resume 不主动重连（返回 0，且不调用 releaseAll）', async () => {
    const src = fakeSource();
    const releaseAll = vi.fn(async () => ['c1']);
    const h = installPowerEvents({ source: src, releaseAll });

    src.fire('resume');
    await Promise.resolve();
    const n = await h.triggerResume();

    expect(n).toBe(0);
    // 唤醒路径绝不应触发释放（更没有主动重连动作 —— 设计上就不存在）
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('幂等：释放进行中时第二次 suspend 不叠加', async () => {
    const src = fakeSource();
    let releaseCalls = 0;
    let resolveRelease: (v: string[]) => void = () => {};
    const releaseAll = vi.fn(
      () =>
        new Promise<string[]>((res) => {
          releaseCalls++;
          resolveRelease = res;
        }),
    );
    const h = installPowerEvents({ source: src, releaseAll });

    const first = h.triggerSuspend(); // 挂起中（releaseAll 未 resolve）
    const second = await h.triggerSuspend(); // 重入 → 立即返回 0，不再调 releaseAll
    expect(second).toBe(0);
    expect(releaseCalls).toBe(1);

    resolveRelease(['c1']); // 放行第一次
    expect(await first).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it('释放抛错不冒泡（不变成 unhandledRejection），返回 0', async () => {
    const src = fakeSource();
    const releaseAll = vi.fn(async () => {
      throw new Error('close failed');
    });
    const warn = vi.fn();
    const h = installPowerEvents({ source: src, releaseAll, log: { warn } });

    await expect(h.triggerSuspend()).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('dispose 摘掉 suspend 与 resume 两个监听', () => {
    const src = fakeSource();
    const h = installPowerEvents({ source: src, releaseAll: async () => [] });
    expect(src.counts()).toEqual({ suspend: 1, resume: 1 });
    h.dispose();
    expect(src.counts()).toEqual({ suspend: 0, resume: 0 });
  });

  it('对照：suspend 真的会调 releaseAll，resume 真的不会（证明两条路径不混淆）', async () => {
    const src = fakeSource();
    const releaseAll = vi.fn(async () => ['x']);
    const h = installPowerEvents({ source: src, releaseAll });

    await h.triggerResume();
    expect(releaseAll).toHaveBeenCalledTimes(0);
    await h.triggerSuspend();
    expect(releaseAll).toHaveBeenCalledTimes(1);
  });
});
