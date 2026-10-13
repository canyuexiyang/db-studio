/**
 * 窗口创建 —— 方案 A（整窗原生玻璃 + 内容区不透明）
 *
 * 依据：Spike S1 实测结论（docs/engineering/SPIKE-REPORT-v1.0.md §一）
 *   S1 四组对照 P50 均为 120.5 FPS、掉帧率 0% → B1 冲突不成立 → 采用方案 A，D4 达成
 *
 * 关键约束（每条都有实测依据，改之前先看 S1 报告）：
 *  1. transparent:true + backgroundColor:'#00000000'
 *  2. 【不能同时开 vibrancy】—— 会冲突导致模糊错乱
 *  3. 圆角交给系统（titleBarStyle:'hidden' 保留原生圆角）；
 *     ⛔ 不要加 roundedCorners:false —— 它会把交通灯一起弄没（见第 4 条实测）
 *  4. 交通灯形态：titleBarStyle:'hidden' + trafficLightPosition + setWindowButtonVisibility
 *  5. sandbox:true 时 preload 必须是 CommonJS
 *  6. 系统版本判断用 os.release()（Darwin 内核主版本 >= 26）
 *     ⚠️ S4 实测更正：本机 os.release() 返回 27.0.0（Darwin 27），不是文档原称的 26。
 *        原文把 build 号 26A428 误当成了内核版本号。阈值 >= 26 仍然安全。
 *
 * 🔴 第 4 条【推翻了 S1/S4 的旧结论】—— 推翻依据是 2026-09-29 真机探针（AGENTS.md §八
 *    要求「推翻决策要给实测数据」）。旧写法是 `frame:false` + `setWindowButtonPosition`，
 *    文档与代码注释都声称"frame:false 下唯一可用且不抛异常"。
 *    「不抛异常」是真的，「交通灯可见」是假的 —— 用户真机反馈窗口无法关闭/缩小/放大，
 *    截图左上角确实一片空白。
 *
 *    探针方法：每个窗口形态一个独立 Electron 进程 → screencapture 抓窗口矩形 →
 *    像素检测 macOS 交通灯三色（红 255,95,86 / 黄 254,188,46 / 绿 40,200,64）。
 *    环境：Electron 44.4.3、Darwin 27.0.0、本机 M5 Pro。结果（✅=三灯可见）：
 *
 *    | 形态 | 配置 | 交通灯 |
 *    |---|---|---|
 *    | A（旧） | frame:false + transparent + roundedCorners:false | ❌ 无 |
 *    | B      | frame:false + transparent                       | ❌ 无 |
 *    | D      | frame:false + 不透明                             | ✅ 有 |
 *    | P2     | titleBarStyle:'hidden' + roundedCorners:false    | ❌ 无 |
 *    | P5     | titleBarStyle:'hidden' + transparent + 玻璃 + trafficLightPosition | ✅ 有 |
 *
 *    两条结论：
 *     ① `transparent:true` 必须配 `titleBarStyle:'hidden'` 才有原生交通灯 ——
 *        frame:false 下 Chromium 根本不创建标准窗口按钮视图，setWindowButtonVisibility
 *        调了也不抛异常，属于「静默无效」（最难查的一类）。
 *     ② `roundedCorners:false` 单独就能把灯弄没（P2 vs P1 对照）—— 所以玻璃形态下
 *        不能再用它压圆角，圆角交给系统原生（P5 实测圆角正常、玻璃 applied 成功）。
 *
 *    连带影响：`titleBarStyle:'hidden'` 会保留窗口顶部一条系统拖拽带，
 *    渲染层 `.toolbar` 的 `-webkit-app-region: drag` 与 `.traffic-light-safe`
 *    的 no-drag 让位逻辑照旧生效（见 styles.css W1/W4 注释），不需要额外改动。
 */

import { BrowserWindow } from 'electron';
import type { IpcMain } from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';

import { IPC, EVENT_BEFORE_CLOSE_ASK } from '../shared/ipc-channels.js';

export type GlassMode = 'native' | 'css' | 'none';

/** macOS 26+ 才能用 kind:'glass'。低于此版本请求 glass 会【抛异常】 */
const MIN_DARWIN_FOR_GLASS = 26;

/** 取 Darwin 内核主版本（不要解析市场版本号，也不要用 build 号推断） */
export function darwinMajor(): number {
  // os.release() 形如 "27.0.0" → 27
  return parseInt(release().split('.')[0], 10) || 0;
}

export function isGlassSupported(): boolean {
  return process.platform === 'darwin' && darwinMajor() >= MIN_DARWIN_FOR_GLASS;
}

export interface GlassState {
  mode: GlassMode;
  /** 降级原因（设置页展示） */
  reason: string | null;
}

let glassState: GlassState = { mode: 'none', reason: '尚未初始化' };
let userDisabled = false;

export function getGlassState(): GlassState {
  return { ...glassState };
}

/** 用户手动关闭（设置项） */
export function setGlassEnabled(enabled: boolean): void {
  userDisabled = !enabled;
}

/**
 * GlassProvider —— 降级路径是强制要求（PRD §8.1.1）。
 * 必须同步 try/catch 包住：包在 <26 上抛的是异常，
 * 禁止让异常冒泡到 app.whenReady()，否则应用起不来。
 */
export async function applyGlass(win: BrowserWindow): Promise<GlassState> {
  if (process.platform !== 'darwin') {
    glassState = { mode: 'none', reason: '非 macOS 平台' };
    return glassState;
  }

  if (userDisabled) {
    glassState = { mode: 'css', reason: '用户在设置中关闭了原生玻璃效果' };
    return glassState;
  }

  if (!isGlassSupported()) {
    glassState = {
      mode: 'css',
      reason: `系统版本不足（Darwin ${darwinMajor()} < ${MIN_DARWIN_FOR_GLASS}）`,
    };
    return glassState;
  }

  try {
    // ⚠️ electron-window-glass 是 ESM-only：exports 只声明 import。
    // 用 require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED（S1 与 S4 各自独立复现）。
    const mod = await import('electron-window-glass');
    /**
     * cornerRadius 刻意用库默认值（20），不显式传：
     * `titleBarStyle:'hidden'` 自带原生窗口圆角（实测 css ≈10px），系统会把子视图
     * 裁切到圆角内 —— 玻璃圆角 ≥ 原生圆角即安全（超出部分被裁掉）。
     * 传一个比原生更小的值反而会在四角露出直角玻璃边。
     * 探针 G/P5 变体（hidden + transparent + 默认玻璃）实测圆角正常、三灯齐全。
     */
    mod.createWindowGlass(win, { kind: 'glass' });
    glassState = { mode: 'native', reason: null };
  } catch (e: any) {
    // 降级，绝不冒泡
    glassState = {
      mode: 'css',
      reason: `原生模块加载或应用失败：${String(e?.message ?? e).slice(0, 120)}`,
    };
  }

  return glassState;
}

export interface CreateWindowOptions {
  preloadPath?: string;
  htmlPath?: string;
  devUrl?: string;
  width?: number;
  height?: number;
  /**
   * V23 多窗口：新窗口打开时要自动打开的标签（`--dbstudio-open=<json>` 注入渲染层）。
   *
   * 为什么走 additionalArguments 而不是 IPC 推送：**时序**。
   * 推送给渲染层要求窗口已经 ready，而"窗口该显示哪张表"这件事在
   * 渲染层首次渲染之前就得知道 —— 否则会先闪一个空工作区再跳转。
   * 命令行参数是 preload 阶段就能读到的（process.argv），天然同步。
   * 这也顺手让「从命令行/脚本带表名启动」白送。
   */
  initialTab?: { connId: string; database: string; table: string } | null;
  /** 窗口标题（macOS 下 frame:false 不显示，但窗口列表/自动化会用到） */
  title?: string;
}

/**
 * 交通灯位置（css px）。与渲染层 `.sidebar-head` 的 78px 安全区同源。
 *
 * 🔴 实测几何（2026-09-29，`npm run verify:traffic-lights` 逐像素量出）：
 *    三灯中心 css (23, 21) / (46, 21) / (69, 21)，**直径 14px、间距 23px**
 *    → 整体占据 css x ∈ [16, 76]、y ∈ [14, 28]。
 *    左缘 16 与本常量 x 逐像素吻合（说明构造参数生效，不是系统默认位置）。
 *
 * ⚠️ 不要再用旧口径推算：`setWindowButtonPosition` 时代量的是「直径 12px、
 *    间距 8px、x ∈ [10, 62]」。换成 `trafficLightPosition` 构造参数后 macOS 的
 *    实际渲染尺寸与间距**都变了**，照旧数字算会让安全区少 14px
 *    （76 > 62），绿灯右缘就落在 drag 区里 —— 边界漏让位，最难发现。
 *
 * 🔴 必须走 `trafficLightPosition` **构造参数**，不要用 `setWindowButtonPosition()`：
 *    构造参数在首帧前生效，不会出现「灯先出现在默认位置、再跳到 16,14」的闪动。
 */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;

/**
 * 交通灯实测几何（css px）。
 *
 * 存在的意义：让「安全区够不够宽」这件事**有数字可断言**，而不是靠人记。
 * `verify-traffic-lights.mjs` 门禁与 `window.test.ts` 都引用它 ——
 * 渲染层 `.traffic-light-safe` / `.sidebar-head` 的宽度若小于 RIGHT_EDGE，
 * 就会有灯落在 drag 区（拖拽吞掉 hover，macOS 的 ✕ ─ ＋ 符号失效）。
 */
export const TRAFFIC_LIGHT_MEASURED = {
  /** 单灯直径 */
  diameter: 14,
  /** 相邻灯中心间距 */
  pitch: 23,
  /** 三灯整体左缘 */
  left: 16,
  /** 三灯整体右缘 */
  right: 76,
  /** 渲染层安全区必须 ≥ 此值（styles.css .traffic-light-safe width） */
  safeAreaMinWidth: 78,
  /**
   * v0.6.0：单灯中心相对窗口顶边的 css y。
   *
   * 存在的意义：让「侧栏头标题有没有和交通灯对齐」**有数字可对齐**。
   * 原先是靠注释里两套互相矛盾的口径在猜（window.ts 说 21、styles.css 说 20.5），
   * 而 `.sidebar-head` 高 30px、内容中心在 y=15 —— 灯比内容低约 5.5px，
   * 这就是「没对齐」的成因，不是 CSS 的锅。
   *
   * 🔴 口径统一到本文件（TRAFFIC_LIGHT_MEASURED 一处为准）：
   *   y 中心 = position.y + 直径/2 = 14 + 7 = 21。
   *   styles.css 里那套 20.5 的旧注释已同步订正，别再照它推算。
   */
  centerY: 21,
  /**
   * v0.6.0：侧栏头高度必须 = 2 × centerY = 42px，才能让标题中心落在灯中心上。
   * 渲染层 `.sidebar-head { height: var(--sidebar-head-h) }` 引用同一口径。
   */
  sidebarHeadHeight: 42,
} as const;

export async function createMainWindow(opts: CreateWindowOptions = {}): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
    minWidth: 900,
    minHeight: 600,
    // ---- 方案 A 的窗口形态（S1 实测已验证 FPS 无损失）----
    /**
     * 🔴 titleBarStyle:'hidden'（不是 frame:false）—— 唯一能让「原生玻璃 + 原生交通灯」
     *    同时成立的组合，实测依据见文件头第 4 条的探针对照表。
     *    hidden 的语义是「隐藏标题栏内容但保留窗口控件」，正是我们要的形态。
     */
    titleBarStyle: 'hidden',
    trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
    transparent: true,
    backgroundColor: '#00000000',
    // ⛔ 不要加 roundedCorners:false —— 它会把交通灯一起弄没（探针 P2 无灯）
    // ⚠️ 不要加 vibrancy：与 transparent 冲突会模糊错乱（PRD §8.1 / 评审 §3.2）
    vibrancy: undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: opts.preloadPath ?? join(__dirname, 'preload.cjs'),
      // V23：把"新窗口要打开哪张表"经命令行参数交给 preload（见 CreateWindowOptions.initialTab）。
      // 多窗口下每个窗口各带各的，互不干扰。
      additionalArguments: opts.initialTab
        ? [`--dbstudio-open=${JSON.stringify(opts.initialTab)}`]
        : [],
    },
  });

  /**
   * 交通灯显式置为可见。
   *
   * titleBarStyle:'hidden' 下默认就是可见的，这里再调一次是**防御**：
   * 全屏切换 / 系统偏好「自动隐藏」等路径可能把它藏起来，而窗口关不掉是
   * 用户级事故（本次缺陷 6 的直接后果）。setWindowButtonVisibility 只读不抛，
   * typeof 判空 + try/catch 保留 —— 它是 Electron 的 darwin 专属 API。
   */
  applyTrafficLights(win);

  // 玻璃在窗口创建后应用（try/catch 已内置）
  await applyGlass(win);

  if (opts.devUrl) {
    await win.loadURL(opts.devUrl);
  } else {
    await win.loadFile(opts.htmlPath ?? join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * 让原生交通灯可见（红=关闭 / 黄=最小化 / 绿=全屏，⌥+点击绿=Zoom）。
 *
 * 返回实际结果供启动日志与 e2e 断言 —— 「调了没抛异常」不等于「灯真的在」，
 * 这正是缺陷 6 藏了这么久的原因（旧代码只做了 typeof 判空就以为成了）。
 */
export interface TrafficLightState {
  /** 可见性调用是否执行成功 */
  visibilityApplied: boolean;
  /** 窗口三态能力（绿=全屏取决于 fullscreenable） */
  closable: boolean;
  minimizable: boolean;
  fullscreenable: boolean;
}

export function applyTrafficLights(win: BrowserWindow): TrafficLightState {
  let visibilityApplied = false;
  try {
    if (typeof (win as any).setWindowButtonVisibility === 'function') {
      (win as any).setWindowButtonVisibility(true);
      visibilityApplied = true;
    }
  } catch {
    // 交通灯不可用不影响主流程，静默降级（渲染层仍可 ⌘W/⌘M 走菜单）
  }
  return {
    visibilityApplied,
    closable: safeBool(() => win.isClosable(), true),
    minimizable: safeBool(() => win.isMinimizable(), true),
    fullscreenable: safeBool(() => win.isFullScreenable(), true),
  };
}

function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 关闭拦截（W 板块 W2）—— 让 macOS **原生**红按钮也走「未保存改动」确认。
 *
 * 🔴 为什么必须写这段：原生红/黄/绿按钮是系统控件（titleBarStyle:'hidden' 下由
 *    trafficLightPosition 定位），点击**不产生任何 DOM 事件**，渲染层的
 *    requestCloseTab 根本收不到。
 *    不加拦截时的后果是「有脏改动的标签被静默丢弃」，直接违反保存预演红线
 *    （AGENTS.md §四.1）。这是本板块唯一真正需要写代码的地方 —— W1 是留白、
 *    W3（绿按钮 = 全屏，⌥+点击 = Zoom）由 macOS 提供、W4 是 CSS 让位。
 *
 * 设计取舍：主进程**不自己判断**有没有脏数据（那是渲染层的状态，复制一份就是
 *    两套真相）。改成发一条询问、等渲染层答复 —— 这样原生红按钮、⌘W、
 *    标签上的 × 走的是同一份 beforeCloseTab 逻辑，口径唯一。
 *
 * 兜底：BEFORE_CLOSE_TIMEOUT_MS 内没答复就强制关闭。渲染层崩了或还没挂载时，
 *    不能把用户锁在一个关不掉的窗口里（宁可丢数据也不能卡死，且此时本来也没有
 *    可交互的界面来让用户选择）。
 */
export const BEFORE_CLOSE_TIMEOUT_MS = 3000;

/**
 * V23 多窗口适配：关闭守卫必须**每个窗口一份 resolver**。
 *
 * 为什么不能像单窗口时那样在 installCloseGuard 里直接 handle：
 *  多窗口下 installCloseGuard 会被调用 N 次，而 ipcMain.handle 对同一通道
 *  重复注册会抛 "Attempted to register a second handler" —— 第二个窗口直接建不出来。
 *  所以这里拆成「全局注册一次」+「每窗口装一个」两段，用 WeakMap 关联。
 */
const closeResolvers = new WeakMap<BrowserWindow, (ok: boolean) => void>();

/** 全局只需调一次（主进程 boot 时） */
export function registerCloseGuardIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.APP_BEFORE_CLOSE_REPLY, (event, payload: unknown) => {
    const ok = !!(payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok);
    // 用发起方窗口定位 resolver —— 多窗口下不能靠"当前窗口"这个隐含状态
    const win = BrowserWindow.fromWebContents(event.sender);
    const resolve = win ? closeResolvers.get(win) : undefined;
    if (win) closeResolvers.delete(win);
    resolve?.(ok);
    return { ok: true, data: null };
  });
}

export function installCloseGuard(win: BrowserWindow): void {
  let approved = false; // 渲染层已放行 → 下次 close 不再拦
  let asking = false; // 正在等答复 → 忽略重复触发的 close

  win.on('close', (e) => {
    if (approved || win.isDestroyed()) return;
    e.preventDefault();
    if (asking) return; // 已在等答复：用户又点了一次红按钮，忽略
    asking = true;

    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (timer) clearTimeout(timer);
      asking = false;
      closeResolvers.delete(win);
      if (!ok) return; // 用户反悔：什么都不做，窗口保持原样
      approved = true;
      // 再次 close() 会重新触发本事件，但 approved 已置位 → 直接放行
      if (!win.isDestroyed()) win.close();
    };

    const ask = new Promise<boolean>((resolve) => {
      closeResolvers.set(win, resolve);
      // 兜底：渲染层无应答（崩溃 / 尚未挂载 / 页面卡死）→ 强制放走
      timer = setTimeout(() => {
        closeResolvers.delete(win);
        resolve(true);
      }, BEFORE_CLOSE_TIMEOUT_MS);
    });

    try {
      win.webContents.send(EVENT_BEFORE_CLOSE_ASK, {});
    } catch {
      // 页面已销毁 / 通道不可用 → 直接放行，别把窗口锁死
      finish(true);
      return;
    }
    void ask.then(finish);
  });

  // 窗口销毁时必须清掉残留 resolver，否则 WeakMap 虽不泄漏但 timer 会空转
  win.on('closed', () => {
    closeResolvers.delete(win);
    approved = true; // 已销毁的窗口再收到 close 直接放行
  });
}

/**
 * 运行时 FPS 保护降级（PRD §8.1.1 补充触发条件）。
 * 本机 S1 实测未触发（120.5 FPS），但作为跨机型保险保留。
 */
export function onLowFps(measuredFps: number, threshold = 50): boolean {
  if (glassState.mode === 'native' && measuredFps < threshold) {
    glassState = {
      mode: 'css',
      reason: `FPS 保护：检测到网格滚动 ${measuredFps.toFixed(1)} FPS < ${threshold}，已自动关闭原生玻璃`,
    };
    return true; // 调用方应据此重绘
  }
  return false;
}
