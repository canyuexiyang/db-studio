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
 * @returns {Promise<Array|null>} 检测到的彩色圆形控件（css 坐标）；null = 解码失败
 */
async function analyzeScreenshot(shotPath, page) {
  const b64 = readFileSync(shotPath).toString('base64');
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // 只看左上角（交通灯必然在窗口左上）：retina 2x 下 320x130 足够
    const RX = Math.min(c.width, 320);
    const RY = Math.min(c.height, 130);
    const d = ctx.getImageData(0, 0, RX, RY).data;

    const at = (x, y) => [(y * RX + x) * 4, (y * RX + x) * 4 + 1, (y * RX + x) * 4 + 2];
    const isColor = (x, y) => {
      const [r, g, b] = at(x, y);
      const rr = d[r], gg = d[g], bb = d[b];
      return Math.max(rr, gg, bb) - Math.min(rr, gg, bb) > 35 && Math.max(rr, gg, bb) > 90;
    };

    const seen = new Uint8Array(RX * RY);
    const comps = [];
    for (let y = 0; y < RY; y++) {
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x;
        if (seen[i] || !isColor(x, y)) continue;
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
            if (!seen[ni] && isColor(ni % RX, (ni - (ni % RX)) / RX)) {
              seen[ni] = 1;
              stack.push(ni);
            }
          }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        // 交通灯 = 直径 10~20 css px 的近正圆实心团（retina 下 20~40 px）
        if (n < 80 || bw < 18 || bw > 34 || bh < 18 || bh > 34) continue;
        if (Math.abs(bw - bh) > 6 || n / (bw * bh) < 0.6) continue;
        const ar = sr / n, ag = sg / n, ab = sb / n;
        /**
         * 🔴 色相判定：绿的判据是 g 最大；红/黄的判据**不能**用「r 最大」——
         *    黄灯 (253,197,50) 的 r 同样是最大值，那样会把黄判成红
         *    （第一版就写错了，报 GREEN,RED,RED）。
         *    正确判据是看**蓝通道相对绿通道低多少**：黄灯 b 远低于 g（差 >50），
         *    红灯的 g 与 b 接近（都是 ~110）。真机实测三色均值：
         *    红 (250,121,111) / 黄 (253,197,50) / 绿 (123,211,80)。
         */
        const hue = ag > ar && ag > ab ? 'GREEN' : ar > ag && ag - ab > 50 ? 'YELLOW' : 'RED';
        comps.push({
          hue,
          n,
          cx: (x0 + x1 + 1) / 2 / 2, // css 中心
          cy: (y0 + y1 + 1) / 2 / 2,
          d: bw / 2, // css 直径
          x0: x0 / 2,
          x1: (x1 + 1) / 2,
          avg: [Math.round(ar), Math.round(ag), Math.round(ab)],
        });
      }
    }
    return comps.sort((a, b) => a.cx - b.cx);
  }, `data:image/png;base64,${b64}`);
}

// ---- 起真实产物 ----
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-tl-'));
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // 宿主可能置位，会让 Electron 退化成纯 Node

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
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
  const bounds = await app.evaluate(({ BrowserWindow, app: ea }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setPosition(0, 0);
    w.show();
    ea.focus({ steal: true });
    const b = w.getBounds();
    return {
      x: b.x, y: b.y, width: b.width, height: b.height,
      closable: w.isClosable(), minimizable: w.isMinimizable(), fullscreenable: w.isFullScreenable(),
    };
  });
  // 等窗口稳定（首次 show 后 macOS 还要画一轮）
  await page.waitForTimeout(2500);

  mkdirSync(OUT_DIR, { recursive: true });
  const shot = join(OUT_DIR, 'traffic-lights.png');
  execFileSync('screencapture', ['-x', '-R', `${bounds.x},${bounds.y},400,160`, shot]);

  // ---- 断言 ----
  ok('窗口三态能力启用（红=关/黄=最小化/绿=全屏）',
    bounds.closable && bounds.minimizable && bounds.fullscreenable,
    `closable=${bounds.closable} minimizable=${bounds.minimizable} fullscreenable=${bounds.fullscreenable}`);

  const lights = await analyzeScreenshot(shot, page);
  if (!lights) {
    ok('截图可解析', false, 'PNG 解码失败（Chromium canvas），无法做像素判定');
  } else {
    ok('🔴 检测到三个原生交通灯', lights.length === 3,
      lights.length ? lights.map((l) => `${l.hue}@(${l.cx.toFixed(0)},${l.cy.toFixed(0)}) d=${l.d.toFixed(0)}`).join(' ') : '一个都没检测到（frame:false 时代的静默失效症状）');

    const hues = lights.map((l) => l.hue).sort().join(',');
    ok('三色齐全（红/黄/绿）', hues === 'GREEN,RED,YELLOW', hues || '无');

    if (lights.length === 3) {
      const left = lights[0].x0;
      const right = lights[2].x1;
      // 安全区口径：styles.css 的 .traffic-light-safe width（78px）
      const SAFE_AREA_WIDTH = 78;
      ok('🔴 三灯全部落在渲染层安全区内（右缘 ≤78px）', right <= SAFE_AREA_WIDTH,
        `灯占 css x∈[${left.toFixed(0)}, ${right.toFixed(0)}]，安全区 ${SAFE_AREA_WIDTH}px`);
      ok('三灯水平等距（几何正常，没有被裁切）',
        Math.abs((lights[1].cx - lights[0].cx) - (lights[2].cx - lights[1].cx)) < 3,
        `间距 ${(lights[1].cx - lights[0].cx).toFixed(1)} / ${(lights[2].cx - lights[1].cx).toFixed(1)} css px`);
      ok('三灯同一水平线（y 一致）',
        Math.max(...lights.map((l) => l.cy)) - Math.min(...lights.map((l) => l.cy)) < 2,
        `y = ${lights.map((l) => l.cy.toFixed(1)).join(' / ')}`);
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

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
