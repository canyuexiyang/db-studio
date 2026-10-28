/**
 * 门禁：SQL 工具栏「任何宽度下按钮尺寸一致 + 文字不折行」（REQ-0.7.1 需求 2）
 *
 * ## 为什么要单独一道门禁
 *
 * 真机截图（iShot_2026-10-26_23.29.44.png）里 9 个按钮**全部**折行成两行、
 * 高度参差。这种缺陷单测抓不到（单测没有布局引擎），人工看截图又容易"看着还行"
 * 就放过 —— 所以把可证伪的口径写成断言：
 *
 *  ① **高度去重后只剩 1 种**（`new Set(heights).size === 1`）—— 这是"大小不一"的
 *     唯一严格口径。旧实现必然失败（≥3 种高度），所以它真的能红。
 *  ② **没有文字折行**：每个按钮 `scrollHeight <= clientHeight + 1`。
 *  ③ **三段式密度真的生效**：面板 ≥900 显示快捷键 / 620–900 隐藏快捷键 / <620 只剩图标。
 *  ④ **图标态仍可访问**：每个按钮至少有 aria-label 或 title（否则纯图标 = 猜谜）。
 *
 * ## 为什么用真 Chromium 而不是真 Electron
 *
 * 被判定的 CSS 是**容器查询**，输入只有"面板自身的 inline-size"—— 与宿主是
 * Electron 还是 Chromium 无关。用渲染层 dev server 跑，能免掉 Electron 冷启动、
 * CDP 连不上（屏幕锁定时必现）这些与被测对象无关的翻车点，且四档宽度可以精确设定。
 * 真机观感另由打包后的人工验收覆盖（见 docs/RELEASES.md）。
 *
 * 运行：npm run verify:toolbar-fit
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RENDERER = join(ROOT, 'apps/desktop/renderer');
const PORT = Number(process.env.DB_STUDIO_FIT_PORT ?? 5201);

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('⏭️  跳过工具栏自适应验证：未安装 playwright-core');
  process.exit(0);
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const rel of [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ]) {
      const p = join(cache, d, ...rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const executablePath = findChromium();
if (!executablePath) {
  console.log('⏭️  跳过工具栏自适应验证：找不到 Chromium');
  process.exit(0);
}

// ---------- dev server ----------
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: RENDERER,
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch { /* 已退出 */ } };
process.on('exit', stop);

async function waitForServer(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
if (!(await waitForServer())) {
  console.error('❌ dev server 起不来');
  stop();
  process.exit(1);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * 四档窗口宽度。为什么是这四个：
 *  1080 / 1280 / 1512 = 真机常见的三种窗口（13" 默认、半屏、全屏）
 *  2560 = 外接 2K 全屏
 * 面板宽度 ≈ 窗口宽度 − 左树 240 − 右详情 240 − 分隔条，所以四档**恰好覆盖
 * 三段式密度的三个区间**（<620 / 620–900 / ≥900），不是随手挑的漂亮数字。
 */
const WIDTHS = [1080, 1280, 1512, 2560];

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const t0 = Date.now();
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tree-row', { timeout: 15_000 });

  // ⌘T 新建查询标签 → SQL 编辑器（含 .sql-toolbar）挂载
  await page.keyboard.press('Meta+t');
  await page.waitForSelector('.sql-toolbar', { timeout: 15_000 });

  /** 读一次布局实况。全部用 getBoundingClientRect / scroll* —— 这些是布局引擎的答案 */
  const measure = () =>
    page.evaluate(() => {
      const panel = document.querySelector('.sql-editor');
      const tb = document.querySelector('.sql-toolbar');
      if (!panel || !tb) return null;
      const btns = [...tb.querySelectorAll('button')];
      const kbd = tb.querySelector('.sql-btn-kbd');
      const label = tb.querySelector('.sql-btn-label');
      const cs = (el) => (el ? getComputedStyle(el) : null);
      return {
        panelWidth: Math.round(panel.getBoundingClientRect().width),
        toolbarHeight: Math.round(tb.getBoundingClientRect().height),
        rowHeight: Math.round(parseFloat(cs(tb).rowGap) || 0),
        heights: btns.map((b) => Math.round(b.getBoundingClientRect().height * 10) / 10),
        wraps: btns
          .map((b) => ({ id: b.dataset.testid ?? b.textContent?.trim() ?? '?', over: b.scrollHeight - b.clientHeight }))
          .filter((x) => x.over > 1),
        accessible: btns.filter((b) => !(b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()).length,
        kbdShown: kbd ? cs(kbd).display !== 'none' : null,
        labelShown: label ? cs(label).display !== 'none' : null,
        btnCount: btns.length,
      };
    });

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400); // 等一轮布局 + 容器查询重算
    const m = await measure();
    if (!m) {
      ok(`${width}px：工具栏可测量`, false, '.sql-editor / .sql-toolbar 不在 DOM');
      continue;
    }

    const uniq = new Set(m.heights);
    ok(`${width}px：所有按钮高度一致（这才能证伪"大小不一"）`,
      uniq.size === 1 && m.btnCount >= 6,
      `面板 ${m.panelWidth}px / ${m.btnCount} 个按钮，高度 ${[...uniq].join(', ')}px`);

    /**
     * 🔴 「有没有折行」不能只看 `scrollHeight <= clientHeight`。
     *
     * 实测过（把工具栏临时退回旧实现跑这道门禁）：旧代码在 1512px 下 9 个按钮
     * 高度分别是 83/121/45/64/102px —— 明确折了行，但 `scrollHeight === clientHeight`
     * 全部照样通过，因为 `height: auto` 的按钮会**长高**去容纳折行文本，不产生溢出。
     * 所以折行的真正判据是**高度本身**：单行按钮不可能超过令牌高度（26px）。
     */
    const h = m.heights[0] ?? 0;
    ok(`${width}px：按钮是单行高度（折行会让 button 长高）`, h >= 24 && h <= 28,
      `实测 ${h}px（令牌 26px；折行时实测可达 83/121px）`);

    ok(`${width}px：按钮内容没有被裁切（无 overflow）`, m.wraps.length === 0,
      m.wraps.length ? `溢出：${m.wraps.map((w) => `${w.id}(+${w.over}px)`).join(', ')}` : 'scrollHeight === clientHeight');

    // 密度分级：三段式。阈值按**面板宽度**判，与 CSS 容器查询同源
    const want = m.panelWidth >= 900 ? 'full' : m.panelWidth >= 620 ? 'no-kbd' : 'icon-only';
    const got = m.kbdShown === false ? (m.labelShown === false ? 'icon-only' : 'no-kbd') : m.labelShown === false ? 'icon-only' : 'full';
    ok(`${width}px：密度档位符合三段式（期望 ${want}）`, got === want,
      `实际 ${got}（面板 ${m.panelWidth}px，kbd=${m.kbdShown} label=${m.labelShown}）`);

    ok(`${width}px：图标态下按钮仍有可访问名（aria-label / title）`, m.accessible === 0,
      m.accessible === 0 ? '' : `${m.accessible} 个按钮既无 aria-label 也无 title`);
  }

  /**
   * 最后一条：把窗口拉回 1512，断言**快捷键文字确实重新出现** ——
   * 只验证"窄时消失"不够：如果 CSS 写错成永久 display:none，上面每条也都能绿。
   */
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.waitForTimeout(400);
  const back = await measure();
  ok('拉宽后快捷键文字回来了（证明不是永久隐藏）', back && back.kbdShown === true && back.labelShown === true,
    back ? `面板 ${back.panelWidth}px kbd=${back.kbdShown} label=${back.labelShown}` : '测不到');

  ok('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  ok('未捕获异常', false, e instanceof Error ? e.message : String(e));
} finally {
  await browser.close().catch(() => {});
  stop();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} 工具栏自适应验证：${results.length - failed.length}/${results.length} 通过（${Date.now() - t0}ms）`);
process.exit(failed.length === 0 ? 0 : 1);
