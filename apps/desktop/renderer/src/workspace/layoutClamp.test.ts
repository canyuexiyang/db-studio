import { describe, expect, it } from 'vitest';
import {
  clampLayoutJoint,
  clampW,
  SIDEBAR_W,
  DETAIL_W,
  WORKSPACE_MIN_W,
} from './layoutClamp';

describe('clampW', () => {
  it('落在区间内不变、越界收到边界、小数四舍五入', () => {
    expect(clampW(300, 180, 520)).toBe(300);
    expect(clampW(50, 180, 520)).toBe(180);
    expect(clampW(9999, 180, 520)).toBe(520);
    expect(clampW(300.6, 180, 520)).toBe(301);
  });
});

describe('clampLayoutJoint —— P1-6 面板宽度联合约束', () => {
  const winMin = 900; // window.ts 的最小窗口宽

  it('窗口够宽时两栏各取自身上限，互不干扰', () => {
    const r = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, 1600);
    expect(r).toEqual({ sidebarW: 520, detailW: 600 });
  });

  it('🔴 反例靶子：最小窗口 + 两栏都想要最大 → 工作区不被压成 0', () => {
    const r = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, winMin);
    // 旧实现会原样返回 520+600=1120 > 900，工作区 = 900-1120 = -220（塌成 0）
    expect(r.sidebarW + r.detailW).toBeLessThanOrEqual(winMin - WORKSPACE_MIN_W);
    expect(winMin - r.sidebarW - r.detailW).toBeGreaterThanOrEqual(WORKSPACE_MIN_W);
  });

  it('优先收详情面板，侧栏尽量保留（工作区是主战场、详情是辅助）', () => {
    // win=900 → budget=580。侧栏 240 时详情可留 340，侧栏完全不必让位。
    const r = clampLayoutJoint({ sidebarW: 240, detailW: 600 }, 900);
    expect(r.sidebarW).toBe(240); // 侧栏没被牺牲
    expect(r.detailW).toBe(340); // 详情被收到刚好够用
    expect(r.sidebarW + r.detailW).toBeLessThanOrEqual(900 - WORKSPACE_MIN_W);
  });

  it('🔴 真实最小窗口 + 两栏都最大：工作区正好保住 WORKSPACE_MIN_W', () => {
    const r = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, 900);
    // budget=580：详情先降到自身 min(220)，侧栏再从 520 让到 360
    expect(r).toEqual({ sidebarW: 360, detailW: 220 });
    expect(900 - r.sidebarW - r.detailW).toBe(WORKSPACE_MIN_W);
  });

  it('详情收到自身 min 仍不够时，才回头收侧栏', () => {
    const r = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, 700);
    expect(r.detailW).toBe(DETAIL_W.min); // 详情已到下限
    expect(r.sidebarW).toBeLessThan(520); // 侧栏被迫让位
    expect(r.sidebarW).toBeGreaterThanOrEqual(SIDEBAR_W.min);
  });

  it('任何情况下两栏都不低于各自 min（不会把面板收到看不见）', () => {
    for (const winW of [900, 800, 700, 600, 500, 400]) {
      const r = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, winW);
      expect(r.sidebarW).toBeGreaterThanOrEqual(SIDEBAR_W.min);
      expect(r.detailW).toBeGreaterThanOrEqual(DETAIL_W.min);
    }
  });

  it('窗口宽非法（0/负/NaN）时原样返回，不瞎收', () => {
    const input = { sidebarW: 500, detailW: 500 };
    expect(clampLayoutJoint(input, 0)).toEqual(input);
    expect(clampLayoutJoint(input, -100)).toEqual(input);
    expect(clampLayoutJoint(input, NaN)).toEqual(input);
  });

  it('幂等：收口一次后再收口结果不变（resize 反复触发不抖动）', () => {
    const once = clampLayoutJoint({ sidebarW: 520, detailW: 600 }, 900);
    const twice = clampLayoutJoint(once, 900);
    expect(twice).toEqual(once);
  });
});
