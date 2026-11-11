/**
 * 三栏布局的宽度约束（纯逻辑，单测钉住）。
 *
 * 0.8.0（P1-6）：从 App.tsx 抽出，原因是「两栏各自 clamp」在窄窗口下会把中间
 * 工作区压成 0，必须加**联合**约束；这段计算要能被单测覆盖（造不出真实窗口
 * 拖拽的边界，正是项目方法论里「逻辑下沉纯函数」的典型场景）。
 */

export interface LayoutState {
  sidebarW: number;
  detailW: number;
}

export const SIDEBAR_W = { min: 180, max: 520, def: 240 };
export const DETAIL_W = { min: 220, max: 600, def: 280 };

/**
 * 中间工作区必须永远留得住的最小宽度。
 *
 * 🔴 两侧面板各自独立 clamp（sidebar ≤520 + detail ≤600 = 1120px），而窗口最小宽
 *    只有 900px（`window.ts`）—— 两个面板都拖到最大、再把窗口缩到最小时，中间
 *    工作区会被压成 0，网格/编辑器整个消失且拖不回来（宽度还持久化了，重开仍复现）。
 */
export const WORKSPACE_MIN_W = 320;

export const clampW = (w: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(w)));

/**
 * 联合收口：在给定窗口宽下，把两栏总宽压到「至少给工作区留 WORKSPACE_MIN_W」。
 * 优先收详情面板（它是辅助信息，工作区是主战场），仍不够再收侧栏；各自不小于自身 min。
 * 拖拽与窗口 resize 共用同一口径。
 *
 * winW 非法（NaN/0/负）时原样返回 —— 拿不到窗口宽就不瞎收，避免把面板压没。
 */
export function clampLayoutJoint(layout: LayoutState, winW: number): LayoutState {
  if (!Number.isFinite(winW) || winW <= 0) return layout;
  const budget = Math.max(0, winW - WORKSPACE_MIN_W);
  let sidebarW = clampW(layout.sidebarW, SIDEBAR_W.min, SIDEBAR_W.max);
  let detailW = clampW(layout.detailW, DETAIL_W.min, DETAIL_W.max);
  if (sidebarW + detailW > budget) {
    detailW = clampW(budget - sidebarW, DETAIL_W.min, DETAIL_W.max);
    if (sidebarW + detailW > budget) {
      sidebarW = clampW(budget - detailW, SIDEBAR_W.min, SIDEBAR_W.max);
    }
  }
  return { sidebarW, detailW };
}
