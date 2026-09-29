// 将 style-preview.html 按 4 种风格截图为 PNG
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(join(homedir(), 'software/ai-project/work-buddy/database-app/package.json'));
const { chromium } = require('playwright-core');

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const p of [
      join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      try { if (statSync(p).isFile()) return p; } catch {}
    }
  }
  throw new Error('chromium not found');
}

const here = dirname(fileURLToPath(import.meta.url));
const styles = [
  ['apple',    'E-Apple原生精修'],
  ['wechat',   'F-微信风'],
  ['mist',     'G-晨雾清新'],
  ['cream',    'H-奶油柔光'],
];

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 840 }, deviceScaleFactor: 2 });
await page.goto('file://' + join(here, 'style-preview.html'));
for (const [style, label] of styles) {
  await page.evaluate((s) => { document.body.dataset.style = s; document.documentElement.dataset.style = s; }, style);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(here, `style-${style}.png`) });
  console.log('shot:', label, `style-${style}.png`);
}
await browser.close();
