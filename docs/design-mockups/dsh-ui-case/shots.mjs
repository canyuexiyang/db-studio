/**
 * 生成案例截图（浅色/深色 × 四个界面）。
 *
 * 用法：node docs/design-mockups/dsh-ui-case/shots.mjs
 * 依赖：playwright-core + 本机 ms-playwright 缓存里的 Chromium。
 * 输出：shots/{workspace,query,palette,preview}-{light,dark}.png（1440×900 @2x）
 *      shots/metrics.json（布局实测值，用于回归对比）
 */

import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(homedir(), 'software/ai-project/work-buddy/database-app');
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');

function findChromium() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const p of [
      join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  throw new Error('找不到 Chromium：请设 PLAYWRIGHT_CHROMIUM_EXECUTABLE 或安装 ms-playwright 缓存');
}

const SHOTS = join(HERE, 'shots');
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const base = `file://${join(HERE, 'index.html')}`;
const routes = ['workspace', 'query', 'palette', 'preview'];
const themes = ['light', 'dark'];
const metrics = [];

for (const theme of themes) {
  for (const route of routes) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${base}?clean=1&theme=${theme}#${route}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);

    const m = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const size = (sel) => {
        const el = document.querySelector(sel);
        return el ? { sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight } : null;
      };
      return {
        theme: document.documentElement.dataset.theme,
        doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        app: box('.app'),
        rail: box('.rail'),
        detail: box('.detail'),
        grid: box('#grid-wrap'),
        row: box('#grid-wrap tbody tr'),
        header: box('#grid-wrap thead th'),
        palette: box('.palette'),
        paletteBody: size('#palette-body'),
        modal: box('.modal'),
        modalBody: size('.modal-body'),
        gridScroll: size('#grid-wrap'),
        detailScroll: size('#detail-body'),
        errors: [],
      };
    });
    m.route = route;
    m.errors = errors;
    metrics.push(m);

    const file = join(SHOTS, `${route}-${theme}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    const kb = Math.round(statSync(file).size / 1024);
    console.log(`✓ ${route.padEnd(9)} ${theme.padEnd(5)} ${kb} KB  doc=${m.doc[0]}×${m.doc[1]}`);
    if (m.doc[0] > 1440 || m.doc[1] > 900) console.log(`  ⚠️ 页面溢出：${m.doc.join('×')}`);
    if (m.errors.length) console.log('  ⚠️ 控制台错误：', m.errors);
    await page.close();
  }
}

await browser.close();
writeFileSync(join(SHOTS, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(`\n完成：${metrics.length} 张截图 + shots/metrics.json`);