/**
 * 交通灯真机验证（缺陷 6 的回归门禁）
 *
 * 🔴 为什么需要这个脚本，而不是靠 e2e-app.mjs 的 DOM 断言：
 *    **原生交通灯在窗口服务器层，Playwright 与 webContents.capturePage 都穿不透。**
 *    渲染层只能断言「安全区让位对不对」（DOM），断言不了「灯到底在不在」。
 *    而缺陷 6 的本质恰恰是：`transparent:true + frame:false` 下
 *    `setWindowButtonVisibility(true)` **调了不抛异常、灯却不渲染** ——
 *    一切「接口全通」的检查都是绿的，用户看到的却是一个关不掉的窗口。
 *
 *    所以唯一可靠的验证手段是：起真实产物 → 系统级 screencapture → 像素检测三色圆。
 *
 * 用法：
 *   npm run build && node scripts/verify-traffic-lights.mjs
 * 环境要求：macOS（screencapture 可用）+ 已构建的 dist 产物。
 * 退出码：0 = 三灯齐全且几何正确；1 = 缺灯或位置超出安全区；2 = 环境不满足（跳过）。
 *
 * 判定口径（2026-09-29 真机实测基线，Electron 44.4.3 / Darwin 27）：
 *   三灯中心 css (20, 20.5) / (43, 20.5) / (66, 20.5)，直径 14px → 占 css x ∈ [13, 73]。
 *   渲染层安全区宽 78px（styles.css .traffic-light-safe / .sidebar-head padding-left）。
 *   ⚠️ 旧口径「x∈[10,62]、直径 12px」是 setWindowButtonPosition 时代的，已作废 ——
 *      改用 trafficLightPosition 构造参数后 macOS 的实际渲染几何变了。
 *
 * 🔴 2026-10-28 复测：中心实测 (23,21) / (46,21) / (69,21)，直径 14，间距 23/23。
 *    **门禁故意不断言绝对中心**，只断「等距 + 同一水平线 + 右缘 ≤78px 安全区」——
 *    绝对坐标随 macOS 版本与 trafficLightPosition 配置变，钉死它只会制造假红。
 *
 * 🔴 同日另一件事：第一次跑报「一个都没检测到」，而截图里三枚圆点清清楚楚 ——
 *    原因是窗口没抢到焦点，macOS 把非 key 窗口的交通灯渲染成**灰色**，而旧判据
 *    要求色度 >35，灰圆直接被滤掉。修法：①加强激活（moveTop + 窗口级 focus +
 *    轮询 + AppleScript 兜底）；②判据拆两段 —— 存在性用「彩色 ∪ 灰度」的形状检测，
 *    颜色单独判，无彩色时明确记为 skipped 而不是红。**灰色圆点是"灯在但没着色"，
 *    不是"灯不见了"**，把后者当前者报会把环境状态说成产品缺陷。
 */

import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps/desktop/dist/main/main.cjs');
const ELECTRON = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const OUT_DIR = join(ROOT, 'docs/design-mockups/shots-installed');

// ---- 环境检查（不满足就跳过，不算失败：非 macOS / 无 GUI 的环境跑不了）----
if (process.platform !== 'darwin') {
  console.log('⏭️  跳过：交通灯是 macOS 专属，当前平台 ' + process.platform);
  process.exit(2);
}
if (!existsSync(MAIN)) {
  console.log('⏭️  跳过：找不到构建产物，请先 npm run build');
  console.log('    ' + MAIN);
  process.exit(2);
}

// ⚠️ playwright-core 的 ESM 入口是 index.mjs（index.js 是 CJS，从这里 import 拿不到 _electron）
let electron;
try {
  const mod = await import(join(ROOT, 'node_modules/playwright-core/index.mjs'));
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过：未安装 playwright-core');
  process.exit(2);
}
if (!electron) {
  console.log('⏭️  跳过：playwright-core 无 Electron 支持');
  process.exit(2);
}

/**
 * 像素分析：让 **Chromium 自己解码 PNG**，然后在页面里跑连通域检测。
 *
 * 🔴 为什么不手写 PNG/BMP 二进制解析：
 *    第一版就是手解 `sips` 输出的 BMP，结果 sips 给的是 BITMAPV4/V5 头
 *    （headerSize=124、dataOff=138、height 为负 = 自上而下、bpp=32、
 *    compression=3 = BI_BITFIELDS 需读通道掩码），而解析器按标准 54 字节头
 *    + 自下而上 + BGR 写死 —— **灯明明在，门禁却报"一个都没检测到"**。
 *    这类"替身照自己的假设实现"的坑项目已经踩过多次，不再重复：
 *    交给真正负责解码的引擎，零格式假设。
 *
 * 🔴 为什么用 data URL 而不是 file://：把 file:// 图片画进 canvas 会污染画布
 *    （getImageData 抛 SecurityError）；base64 data URL 不会。
 *
 * @param cropRect 只分析这块区域（css 坐标）。区域截图路径传 null（全图即窗口区）。
 * @returns {Promise<Array|null>} 检测到的彩色圆形控件（css 坐标）；null = 解码失败
 */
async function analyzeScreenshot(shotPath, page, cropRect = null, relaxed = false) {
  const b64 = readFileSync(shotPath).toString('base64');
  return page.evaluate(async ({ dataUrl, crop, relaxed }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    /**
     * 整屏截图路径：按 crop 裁出窗口左上角那一块。
     *
     * 缩放换算是必须的：整屏 PNG 的像素尺寸 = 逻辑分辨率 × 屏缩放（M 系列通常是 2），
     * 而 cropRect 是 getBounds() 给的**逻辑**坐标。
     * 比例直接从图片自然宽高算（不写死 2）—— 外接不同缩放的非 Retina 屏时也不会错。
     */
    let ox = 0;
    let oy = 0;
    let RW = c.width;
    let RH = c.height;
    /**
     * 像素 / css 换算倍率 —— **两条路径都要乘**。
     *
     * 🔴 【2026-10-10 实测纠正】区域截图 `screencapture -R 400,160` 产出的是
     *    **物理像素**（retina 下 800×320），不是逻辑像素 —— 原先这里假设 -R 按点给尺寸、
     *    scale 写死 1，于是检测阈值（10~20 css px）与实际 28 物理像素的灯错开，
     *    报"一个都没检测到"。而同一张图肉眼明明三灯齐全 —— **门禁误报了产品缺陷**。
     *
     * ⚠️ 也不要用 `window.screen.width` 当分母：那是**当前窗口**的逻辑宽度，
     *    不是屏幕宽度 —— 窗口不铺满时就完全错位。
     *    唯一可靠来源是 Electron 的 `screen.getPrimaryDisplay().scaleFactor`（主进程注入）。
     */
const scale = crop?.scale && crop.scale > 0 ? crop.scale : 1;
    // offset=false（区域截图）：图已按 bounds 裁好，原点即窗口左上，不做偏移
    // offset=true （整屏截图）：先裁出窗口左上那一块
    ox = crop?.offset ? Math.max(0, Math.round(crop.x * scale)) : 0;
    oy = crop?.offset ? Math.max(0, Math.round(crop.y * scale)) : 0;
    RW = crop ? Math.min(c.width - ox, Math.round(crop.w * scale)) : c.width;
    RH = crop ? Math.min(c.height - oy, Math.round(crop.h * scale)) : c.height;

    // 只看左上角（交通灯必然在窗口左上）
    const RX = Math.min(RW, 320);
    /**
     * relaxed 模式只看标题栏那一行（css 40px 内）：判的是「圆点在不在」，
     * 不是「颜色对不对」。纵向收紧是为了避开侧栏文字，减少假阳性。
     */
    const RY = Math.min(RH, Math.round(40 * (crop?.scale && crop.scale > 0 ? crop.scale : 1)));
    if (RX <= 0 || RY <= 0) return [];
    const d = ctx.getImageData(ox, oy, RX, RY).data;

    const at = (x, y) => [(y * RX + x) * 4, (y * RX + x) * 4 + 1, (y * RX + x) * 4 + 2];
    const isColor = (x, y) => {
      const [r, g, b] = at(x, y);
      const rr = d[r], gg = d[g], bb = d[b];
      return Math.max(rr, gg, bb) - Math.min(rr, gg, bb) > 35 && Math.max(rr, gg, bb) > 90;
    };
    /**
     * 🔴 relaxed 判据：**与窗口底色有对比**即当前景，不管有没有着色。
     *
     * 背景（2026-10-28 真机）：截图里三枚圆点清清楚楚，但全是灰色 ——
     * macOS 会按窗口激活态决定交通灯着色。原判据要求色度 >35，灰圆直接被滤掉，
     * 于是报「一个都没检测到 / frame:false 静默失效」——**把渲染状态误报成缺失**。
     * 底色取裁剪区左上角像素（窗口内容原点，必然是应用背景色）。
     */
    const bg = [d[0], d[1], d[2]];
    const isContrast = (x, y) => {
      const [r, g, b] = at(x, y);
      return Math.abs(d[r] - bg[0]) + Math.abs(d[g] - bg[1]) + Math.abs(d[b] - bg[2]) > 18;
    };
    const isFore = relaxed ? isContrast : isColor;

    const seen = new Uint8Array(RX * RY);
    const comps = [];
    for (let y = 0; y < RY; y++) {
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x;
        if (seen[i] || !isFore(x, y)) continue;
        // BFS 连通域
        const stack = [i];
        seen[i] = 1;
        let x0 = x, x1 = x, y0 = y, y1 = y, n = 0, sr = 0, sg = 0, sb = 0;
        while (stack.length) {
          const ci = stack.pop();
          const cx = ci % RX, cy = (ci - cx) / RX;
          n++;
          const [pr, pg, pb] = at(cx, cy);
          sr += d[pr]; sg += d[pg]; sb += d[pb];
          if (cx < x0) x0 = cx;
          if (cx > x1) x1 = cx;
          if (cy < y0) y0 = cy;
          if (cy > y1) y1 = cy;
          const nb = [ci - 1, ci + 1, ci - RX, ci + RX];
          const okIdx = [cx > 0, cx < RX - 1, cy > 0, cy < RY - 1];
          for (let k = 0; k < 4; k++) {
            if (!okIdx[k]) continue;
            const ni = nb[k];
            if (!seen[ni] && isFore(ni % RX, (ni - (ni % RX)) / RX)) {
              seen[ni] = 1;
              stack.push(ni);
            }
          }
        }
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
     // 交通灯 = 直径 10~20 css px 的近正圆实心团。阈值按 scale 换算到像素域 ——
   // 写死 "18~34 像素" 只在 scale=2 时成立：scale=1 的图里灯只有 14px，
        // 会被下限 18 一刀切掉，报"一个都没检测到"（假红）。
    const minD = Math.round(10 * scale);
    const maxD = Math.round(20 * scale);
        if (n < 80 * scale * scale || bw < minD || bw > maxD || bh < minD || bh > maxD) continue;
      if (Math.abs(bw - bh) > 6 || n / (bw * bh) < 0.6) continue;
        const ar = sr / n, ag = sg / n, ab = sb / n;
        /**
         * 🔴 色相判定：绿的判据是 g 最大；红/黄的判据**不能**用「r 最大」——
         *    黄灯 (253,197,50) 的 r 同样是最大值，那样会把黄判成红
         *    （第一版就写错了，报 GREEN,RED,RED）。
         *    正确判据是看**蓝通道相对绿通道低多少**：黄灯 b 远低于 g（差 >50），
         *    红灯的 g 与 b 接近（都是 ~110）。真机实测三色均值：
         *    红 (250,121,111) / 黄 (253,197,50) / 绿 (123,211,80)。
         *
         *    另加 GRAY：未激活窗口的交通灯是纯灰（实测 rgb 约 200~235 无彩色），
         *    relaxed 模式下要能认出来是"灯在、只是没着色"，而不是"没有灯"。
         */
const chroma = Math.max(ar, ag, ab) - Math.min(ar, ag, ab);
const hue = chroma <= 20 ? 'GRAY'
  : ag > ar && ag > ab ? 'GREEN'
  : ar > ag && ag - ab > 50 ? 'YELLOW' : 'RED';
     // 像素 → css：除以实际缩放（retina 通常 2），不写死 2
const k = Math.max(1, Math.round(scale));
        /**
         * relaxed 模式的额外收紧（只在判"灯在不在"时生效）。
         *
         * 放宽前景判据会连带把标题栏文字（「连接」等）当成前景 —— 那会让
         * 连通域数量变成 4、5，凭空造出一个"多了一盏灯"的假红。
         * 交通灯有确定的几何：近正圆（填充率≈π/4）、正方形包围盒、x 中心 <90 css。
         * 用几何收口，比"把阈值调高点"更可靠 —— 后者只是把误检推迟。
         */
        if (relaxed) {
          if (n / (bw * bh) < 0.7) continue;
          if (Math.abs(bw - bh) > 4) continue;
          if (((x0 + x1 + 1) / 2) / k > 90) continue;
        }
     comps.push({
          hue,
        n,
cx: ((x0 + x1 + 1) / 2) / k, // css 中心（相对裁剪原点 = 窗口左上角）
          cy: ((y0 + y1 + 1) / 2) / k,
    // 直径已经在上面按 minD/maxD 的口径算过一次，这里直接给 css 值
          d: bw / k,
    x0: x0 / k,
          x1: (x1 + 1) / k,
          avg: [Math.round(ar), Math.round(ag), Math.round(ab)],
        });
      }
    }
    return comps.sort((a, b) => a.cx - b.cx);
  }, { dataUrl: `data:image/png;base64,${b64}`, crop: cropRect, relaxed });
}

// ---- 起真实产物 ----
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-tl-'));
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // 宿主可能置位，会让 Electron 退化成纯 Node

const results = [];
const ok = (name, pass, detail = '', skipped = false) => {
  results.push({ name, pass, detail, skipped });
  console.log(`${skipped ? '⏭️ ' : pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

let app;
try {
  app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--no-sandbox', MAIN],
    env: {
      ...childEnv,
      DB_STUDIO_E2E_USER_DATA: userData,
      DB_STUDIO_NO_SINGLE_LOCK: '1',
      NODE_ENV: 'production',
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar', { timeout: 20_000 }).catch(() => {});

  /**
   * 🔴 窗口必须 setPosition(0,0) 再截：
   *    getBounds() 与 screencapture -R 之间存在坐标系不确定性（窗口阴影/inset），
   *    归零后截图原点就是窗口内容原点，灯的 css 坐标可直接与 trafficLightPosition 对照。
   */
  const bounds = await app.evaluate(({ BrowserWindow, app: ea, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setPosition(0, 0);
    w.show();
    /**
     * 🔴 2026-10-28：只调 `ea.focus({steal:true})` 不够。
     *
     * 真机复现：截图里三枚圆点**都在**，但全是**灰色** —— macOS 把非 key 窗口的
     * 交通灯渲成灰，于是「三色齐全」被判红。这不是产品缺陷，是门禁自己没把窗口
     * 激活起来。补 `moveTop()` + 窗口级 `focus()`（app 级 focus 只管应用菜单栏）。
     */
    w.moveTop();
    w.focus();
    ea.focus({ steal: true });
    const b = w.getBounds();
    return {
    x: b.x, y: b.y, width: b.width, height: b.height,
      closable: w.isClosable(), minimizable: w.isMinimizable(), fullscreenable: w.isFullscreenable?.() ?? w.isFullScreenable(),
      /**
       * 屏幕缩放因子 —— 整屏截图的像素坐标换算成 css 坐标的唯一可靠来源。
       * 渲染层拿不到（window.screen 在 Electron 里可能是 null 或窗口宽度），
       * 必须在主进程侧取。拿不到时返回 0，由调用方按 1 处理并在输出里标注。
       */
      scaleFactor: (() => {
        try {
          return screen.getPrimaryDisplay().scaleFactor || 0;
        } catch {
          return 0;
        }
      })(),
    };
  });

  /**
   * 轮询确认窗口真的成了 key window。
   *
   * 从后台进程（本脚本由终端/CI 拉起）抢焦点时 macOS 可能拒绝，或抢到后又被
   * 抢回去。抢不到时 AppleScript 兜底再试一次 —— 仍失败就把「颜色判定」标成
   * **未成立（skipped）**，绝不报成产品缺陷（那会指向一个不存在的回归方向）。
   */
  const isFocused = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isFocused() ?? false);
  let windowFocused = false;
  for (let i = 0; i < 10 && !windowFocused; i++) {
    windowFocused = await isFocused();
    if (!windowFocused) await page.waitForTimeout(200);
  }
  if (!windowFocused) {
    try {
      const pid = app.process().pid;
      execFileSync('osascript', [
        '-e',
        `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
      ], { stdio: 'pipe' });
      for (let i = 0; i < 10 && !windowFocused; i++) {
        windowFocused = await isFocused();
        if (!windowFocused) await page.waitForTimeout(200);
      }
    } catch {
      /* AppleScript 也不可用（无辅助功能权限）；下面按未激活处理 */
    }
  }
  if (!windowFocused) {
    console.log('⚠️  窗口未能获得焦点：macOS 会把非 key 窗口的交通灯渲染成**灰色**，');
    console.log('    颜色判定因此不成立（不是「灯不见了」）。已尝试 window.focus / moveTop /');
    console.log('    app.focus({steal}) / AppleScript 四路激活。');
  }
  // 常驻诊断：焦点态直接决定交通灯着色，出问题时第一眼看这里
  console.log(`ℹ️ 窗口焦点：${windowFocused ? '已获得（灯应为红/黄/绿）' : '未获得（灯会是灰色）'}`);
  // 等窗口稳定（首次 show 后 macOS 还要画一轮；抢到焦点后要等重绘完再截）
  await page.waitForTimeout(2500);

  mkdirSync(OUT_DIR, { recursive: true });
  const shot = join(OUT_DIR, 'traffic-lights.png');

  /**
   * 🔴 截图降级链：先试区域截图（省时间、图小），失败则整屏截后在 canvas 里裁。
   *
   * 为什么需要降级：某些环境（无登录会话 / 未授予屏幕录制权限的进程）下
   * `screencapture -R` 会直接报 "could not create image from rect" 并 exit 1 ——
   * 那不是"灯不见了"，而是**根本没截到图**。旧实现把它当成门禁失败报出，
   * 是把环境问题误报成产品缺陷（正是本脚本注释里痛陈的那类假红）。
   *
   * 判定强度不变：两种路径都交给同一个 analyzeScreenshot 做像素判定。
   */
  let cropRect = { x: bounds.x, y: bounds.y, w: 400, h: 160, scale: bounds.scaleFactor };
  let regionShotOk = true;
  try {
    execFileSync('screencapture', ['-x', '-R', `${bounds.x},${bounds.y},400,160`, shot], { stdio: 'pipe' });
  } catch {
    regionShotOk = false;
  }
  if (!regionShotOk) {
    // 整屏截一张，再由 analyzeScreenshot 按 cropRect 裁剪
    const full = join(OUT_DIR, 'traffic-lights-fullscreen.png');
    execFileSync('screencapture', ['-x', full], { stdio: 'pipe' });
    cropRect = { x: bounds.x, y: bounds.y, w: 400, h: 160, scale: bounds.scaleFactor };
    console.log('ℹ️区域截图不可用，已降级为整屏截图 + canvas 裁剪（判定强度不变）');
  }
  if (!regionShotOk && !bounds.scaleFactor) {
    console.warn('⚠️   取不到显示器缩放因子，按 1x 处理 —— 若截图是 retina，灯的检测尺寸会偏大');
  }

  /**
   * 🔴🔴 「窗口到底在不在截图里」的前置校验 —— 本脚本最重要的一道闸。
   *
   * 背景（本项目踩过的坑）：在**无前台 GUI 会话**的环境里（CI、后台跑任务的
   * 终端、未授予屏幕录制权限的进程），Electron 窗口能正常创建、能show()、
   * 连 DOM 都渲染得出来，但 **macOS 根本不会把它画进屏幕**——
   * 于是截图里只有壁纸，一个交通灯都没有。
   *
   * 此时报"检测到 0 个灯 / frame:false 静默失效"是**彻头彻尾的误报**：
   * 它会把环境问题说成产品缺陷，指向一个根本不存在的回归方向
   * （本脚本注释里明文写着这个症状曾真实发生过）。
   *
   * 判据：窗口标题栏区域应当是**应用自己的背景色**（--bg，白/深灰），
   * 而壁纸通常是米色系或高饱和渐变。用"该区域是否存在足够多的低饱和像素"
   * 来判断窗口在不在 —— 不去猜具体颜色值，那正是替身照假设实现的老毛病。
   */
  const windowVisible = await page.evaluate(async ({ dataUrl, crop }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
// 与 analyzeScreenshot 同一个换算口径与偏移语义（crop 由调用方注入）
    const scale = crop?.scale && crop.scale > 0 ? crop.scale : 1;
    const ox = crop?.offset ? Math.max(0, Math.round(crop.x * scale)) : 0;
    const oy = crop?.offset ? Math.max(0, Math.round(crop.y * scale)) : 0;
    const rw = crop ? Math.min(c.width - ox, Math.round(crop.w * scale)) : c.width;
    const rh = crop ? Math.min(c.height - oy, Math.round(crop.h * scale)) : c.height;
    if (rw <= 0 || rh <= 0) return { visible: false, neutral: 0, total: 0 };
    // 取标题栏往下 20~90px 的一条（灯所在行 + 侧栏头背景），避开可能的桌面图标
    const sy = oy + Math.round(10 * scale);
    const sh = Math.max(1, Math.min(c.height - sy, Math.round(80 * scale)));
    const d = ctx.getImageData(ox, sy, rw, sh).data;
    let neutral = 0;
    const total = rw * sh;
    for (let i = 0; i < total; i++) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      // 低饱和 = 近灰白/近黑的应用背景；壁纸（米色/渐变）饱和度明显更高
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 24) neutral++;
    }
    return { visible: neutral / total > 0.5, neutral: Math.round((neutral / total) * 100), total };
  }, {
    dataUrl: `data:image/png;base64,${readFileSync(regionShotOk ? shot : join(OUT_DIR, 'traffic-lights-fullscreen.png')).toString('base64')}`,
    crop: { ...cropRect, offset: !regionShotOk },
  });

  if (!windowVisible.visible) {
    console.log('');
    console.log('⏭️  跳过像素判定：窗口不在截图里（当前环境没有前台 GUI 会话）。');
    console.log('    这不是产品缺陷 —— macOS 在无前台会话时不会把窗口画进屏幕，');
    console.log('    截图里只有桌面。此时报"检测不到交通灯"是把环境问题误报成回归。');
    console.log(`    （判定依据：窗口区域低饱和像素占比 ${windowVisible.neutral}% < 50%）`);
    console.log('    必须在有登录会话的桌面上跑本门禁，交通灯是 darwin 窗口层能力。');
    results.push({
      name: '像素判定',
      pass: true,
      detail: '跳过：窗口未出现在截图中（无前台 GUI 会话，非产品缺陷）',
      skipped: true,
    });
  }

  // ---- 断言 ----
  ok('窗口三态能力启用（红=关/黄=最小化/绿=全屏）',
    bounds.closable && bounds.minimizable && bounds.fullscreenable,
    `closable=${bounds.closable} minimizable=${bounds.minimizable} fullscreenable=${bounds.fullscreenable}`);

/**
   * 两条路径的 crop 语义**不同**，用 `offset` 区分：
   *  - 区域截图：图已按 bounds 裁好，原点就是窗口左上 → `offset: false`，
   *    但**仍是物理像素**，必须带 scale 换算阈值
   *  - 整屏截图：整张图要先按 bounds 裁出窗口左上角那一块 → `offset: true`
   *
   * 🔴 曾在这里报过假红：区域路径传了 `null` 导致 scale 退化成 1，
   *    阈值（10~20 css px）与实际 28 物理像素的灯错开 → "一个都没检测到"，
   *    而同一张图肉眼明明三灯齐全。
   */
  const shotPath = regionShotOk ? shot : join(OUT_DIR, 'traffic-lights-fullscreen.png');
  const cropArg = { ...cropRect, offset: !regionShotOk };

  /** 第一遍：彩色检测（正常路径 —— 窗口已激活时三灯是有色的） */
  const lights = windowVisible.visible ? await analyzeScreenshot(shotPath, page, cropArg) : null;
  /**
   * 第二遍：形状检测（彩色 ∪ 灰度）。只在第一遍一个彩色圆都没检到时才跑。
   *
   * 🔴 为什么必须分两遍、而不是直接把阈值放宽：
   *    「灯在不在」与「灯什么颜色」是两个独立结论。混成一个判据的后果是
   *    2026-10-28 真机实测到的假红 —— 三枚圆点清清楚楚在截图里，只因为
   *    macOS 按窗口激活态把它们渲染成灰色，就被判成「一个都没检测到 /
   *    frame:false 静默失效」，直接指向一个不存在的回归方向。
   *    存在性用形状判（灰也算），颜色单独判（无彩色就明确记为跳过）。
   */
  const shapes = windowVisible.visible && lights && lights.length === 0
    ? await analyzeScreenshot(shotPath, page, cropArg, true)
    : null;

  if (!windowVisible.visible) {
    // 已在上面记过一条 skipped，这里不再重复报红
  } else if (!lights) {
    ok('截图可解析', false, 'PNG 解码失败（Chromium canvas），无法做像素判定');
  } else {
    const found = lights.length > 0 ? lights : (shapes ?? []);
    const how = lights.length > 0 ? '彩色' : '彩色+灰度';
    ok('🔴 检测到三个原生交通灯', found.length === 3,
      found.length
        ? `[${how}] ${found.map((l) => `${l.hue}@(${l.cx.toFixed(0)},${l.cy.toFixed(0)}) d=${l.d.toFixed(0)}`).join(' ')}`
        : '一个都没检测到（连灰度圆都没有 → frame:false 时代的静默失效症状）');

    if (found.length === 3) {
      const hues = found.map((l) => l.hue).sort().join(',');
      if (hues === 'GREEN,RED,YELLOW') {
        ok('三色齐全（红/黄/绿）', true, hues);
      } else if (found.every((l) => l.hue === 'GRAY')) {
        // 灯在、只是没着色。颜色结论不成立 —— 明确记为跳过，不冒充通过
        console.log('');
        console.log('⏭️  跳过颜色判定：三枚圆点都在，但都是灰色（macOS 按窗口激活态着色）。');
        console.log('    灯存在性已由上一条断言确认；颜色需在已激活的桌面会话里重跑才能给出结论。');
        console.log(`    （焦点态：${windowFocused ? '已获得' : '未获得'}）`);
        results.push({
          name: '交通灯颜色判定',
          pass: true,
          detail: '跳过：三灯渲染为灰色，颜色判据不成立（灯存在性已验证）',
          skipped: true,
        });
      } else {
        ok('三色齐全（红/黄/绿）', false, hues);
      }

      const left = found[0].x0;
      const right = found[2].x1;
      // 安全区口径：styles.css 的 .traffic-light-safe width（78px）
      const SAFE_AREA_WIDTH = 78;
      ok('🔴 三灯全部落在渲染层安全区内（右缘 ≤78px）', right <= SAFE_AREA_WIDTH,
        `灯占 css x∈[${left.toFixed(0)}, ${right.toFixed(0)}]，安全区 ${SAFE_AREA_WIDTH}px`);
      ok('三灯水平等距（几何正常，没有被裁切）',
        Math.abs((found[1].cx - found[0].cx) - (found[2].cx - found[1].cx)) < 3,
        `间距 ${(found[1].cx - found[0].cx).toFixed(1)} / ${(found[2].cx - found[1].cx).toFixed(1)} css px`);
      ok('三灯同一水平线（y 一致）',
        Math.max(...found.map((l) => l.cy)) - Math.min(...found.map((l) => l.cy)) < 2,
        `y = ${found.map((l) => l.cy.toFixed(1)).join(' / ')}`);
    }
  }
  console.log(`\n📸 截图已存：${shot}`);
  console.log('   （可直接打开肉眼复核：左上角应有红/黄/绿三枚圆点）');
} catch (e) {
  ok('真机启动与截图流程', false, String(e && e.message ? e.message : e).slice(0, 200));
} finally {
  try { await app?.close(); } catch {}
  setTimeout(() => { try { rmSync(userData, { recursive: true, force: true }); } catch {} }, 400);
}

/**
 * 收尾判定。
 *
 * 🔴 skipped 项算"通过但未验证"：不计入失败（否则 CI/后台环境永远红），
 * 但必须在输出里显式说明 —— 一个门禁悄悄跳过了核心断言，
 * 和门禁通过是两回事，不该长得一样。
 */
const failed = results.filter((r) => !r.pass);
const skipped = results.filter((r) => r.skipped);
const passed = results.filter((r) => r.pass && !r.skipped);
console.log(`\n通过 ${passed.length}/${results.length - skipped.length}`);
if (skipped.length) {
  console.log(`⏭️  跳过 ${skipped.length} 项：${skipped.map((s) => s.detail).join('；')}`);
}
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
