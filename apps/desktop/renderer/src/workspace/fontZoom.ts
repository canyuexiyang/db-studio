/**
 * F2 字体缩放（渲染侧纯逻辑，无 React/Electron 依赖）。
 *
 * 步进是离散档位而不是连续值：用户按 ⌘= / ⌘- 的意图是"换一档"，
 * 离散档位让"放大两次再缩小两次"精确回到原点，不会积累浮点误差。
 *
 * localStorage 读写全部 try/catch：隐私模式/配额满时静默降级，
 * 缩放是体验增强，不值得为它打扰用户（与树展开记忆同口径）。
 */

/** 缩放档位（相对默认字号的倍率） */
export const FONT_ZOOM_STEPS: readonly number[] = [0.85, 1, 1.15, 1.3];

/** 硬边界：localStorage 里出现越界/畸形值时按此收敛 */
export const FONT_ZOOM_MIN = 0.8;
export const FONT_ZOOM_MAX = 1.4;

export const FONT_ZOOM_STORAGE_KEY = 'dbstudio.fontZoom.v1';

export type FontZoomDir = 'in' | 'out' | 'reset';

/**
 * 计算下一档缩放。
 *  - 'in'/'out'：在档位表上移动一格；已到顶/底就停在当前档（不越界、不绕圈）。
 *  - 'reset'：回到 1。
 *  - cur 本身越界（外部改坏）时先收敛到 [MIN, MAX] 再找档。
 */
export function nextZoom(cur: number, dir: FontZoomDir): number {
  if (dir === 'reset') return 1;
  const clamped = Math.min(FONT_ZOOM_MAX, Math.max(FONT_ZOOM_MIN, cur));
  if (dir === 'in') {
    const next = FONT_ZOOM_STEPS.find((s) => s > clamped + 1e-9);
    return next ?? FONT_ZOOM_STEPS[FONT_ZOOM_STEPS.length - 1];
  }
  const prev = [...FONT_ZOOM_STEPS].reverse().find((s) => s < clamped - 1e-9);
  return prev ?? FONT_ZOOM_STEPS[0];
}

/** 读持久化的缩放值；没有/损坏/越界返回 null（调用方保持默认 1） */
export function loadFontZoom(): number | null {
  try {
    const raw = localStorage.getItem(FONT_ZOOM_STORAGE_KEY);
    if (!raw) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    if (v < FONT_ZOOM_MIN || v > FONT_ZOOM_MAX) return null;
    return v;
  } catch {
    return null;
  }
}

/** 持久化缩放值；写失败静默（只影响下次启动的默认值） */
export function saveFontZoom(zoom: number): void {
  try {
    localStorage.setItem(FONT_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // 同上：静默降级
  }
}

/**
 * 应用到页面：zoom 在 body 上，一次设置全局生效（网格/编辑器/树全覆盖）。
 * Electron 渲染层支持 CSS zoom；demo 浏览器下同样可用。
 */
export function applyFontZoom(zoom: number): void {
  document.body.style.zoom = String(zoom);
}
