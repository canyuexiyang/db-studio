// 用 vite dev(demo 后端)打开真实 renderer,点开一张表,截浅色/深色两图
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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
      try { if (statSync(p).isFile()) return p; } catch {}
    }
  }
  throw new Error('chromium not found');
}

const PORT = 5199;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: join(ROOT, 'apps/desktop/renderer'),
  stdio: 'ignore',
});
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });

const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 300));
}

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tree-row', { timeout: 15000 });

// 展开直到目标出现：点行首 caret 切换一次（与 e2e-ui.mjs 同口径）。
// ⚠️ 不能双击行体：容器行的单击即切换展开，双击=两次单击互相抵消。
async function expandUntil(rowText, waitText) {
  for (let i = 0; i < 4; i++) {
    const hit = page.locator('.tree-row', { hasText: waitText }).first();
    if (await hit.count()) return;
    const row = page.locator('.tree-row', { hasText: rowText }).first();
    const caret = row.locator('.tree-caret');
    if (await caret.count()) await caret.click();
    else await row.dblclick();
    await page.waitForTimeout(450);
  }
  throw new Error(`展开失败: ${rowText}`);
}
await expandUntil('prod_order', 'order_db');
await expandUntil('order_db', /表\s*\d/);
const grpText = (await page.locator('.tree-row').filter({ hasText: /表\s*\d/ }).first().textContent()) ?? '';
await expandUntil(grpText.trim().slice(0, 2), 'order_item');
console.log('tree:', JSON.stringify(await page.locator('.tree-row').allTextContents()));
await page.locator('.tree-row', { hasText: 'order_item' }).first().dblclick();
await page.waitForSelector('.grid-row', { timeout: 15000 });
await page.waitForTimeout(600);
console.log('tabs:', JSON.stringify(await page.locator('.ws-tab').allTextContents()));
await page.screenshot({ path: join(here, 'verify-light.png') });

// 连接编辑器（2026-09-27 分区布局）浅色
async function shotConnectionEditor(themeTag) {
  await page.locator('[data-testid="btn-new-connection"]').first().click();
  await page.waitForSelector('.connection-editor', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(here, `verify-conn-${themeTag}.png`) });
  // 未动过表单（touched=false）时取消不弹确认
  await page.locator('.connection-editor footer button', { hasText: '取消' }).click();
  await page.waitForSelector('.connection-editor', { state: 'detached', timeout: 5000 });
}

// 运行 SQL 脚本弹窗（demo 下可到 pick 阶段：选项 + 目标库说明）
async function shotScriptModal(themeTag) {
  const dbRow = page.locator('.tree-row', { hasText: 'order_db' }).first();
  await dbRow.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5000 });
  await page.locator('.ctx-item', { hasText: '运行 SQL 脚本…' }).click();
  await page.waitForSelector('[data-testid="script-modal"]', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(here, `verify-script-${themeTag}.png`) });
  await page.locator('[data-testid="script-modal"] footer button', { hasText: '取消' }).click();
  await page.waitForSelector('[data-testid="script-modal"]', { state: 'detached', timeout: 5000 });
}

await shotConnectionEditor('light');
await shotScriptModal('light');

// 切深色:App 挂载时 data-theme 已写死,直接改属性并等一帧
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
// 强制整帧重绘：headless 合成层在 color-scheme 切换后可能残留旧瓦片（实测），
// 真机 Electron 连续绘制无此问题，这里只是截图口径的对齐手段
await page.evaluate(() => {
  const b = document.body;
  b.style.display = 'none';
  void b.offsetHeight;
  b.style.display = '';
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(here, 'verify-dark.png') });

await shotConnectionEditor('dark');
await shotScriptModal('dark');

await browser.close();
server.kill('SIGTERM');
console.log('done: verify-{light,dark}.png / verify-{conn,script}-{light,dark}.png');
process.exit(0);
