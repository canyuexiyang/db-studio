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

/**
 * 缺陷 4 改版视图：筛选构建器（Grid 固定列轨 + AND/OR chip + 统一按钮族）。
 *
 * 🔴 必须造出 **≥2 条条件 + 1 个条件组** 再截 —— 单条件时逻辑 chip 不出现
 *    （设计如此：没有连接语义时显示 chip 是噪音），截出来看不出改版重点，
 *    而且「纵向对齐」在单行下无法体现（max-min 恒为 0）。
 */
async function shotFilterBuilder(themeTag) {
  await page.locator('.toolbar button', { hasText: '筛选' }).click();
  await page.waitForSelector('.filter-modal', { timeout: 10000 });
  await page.waitForTimeout(300);

  // 第 2 条条件 + 第 2 个条件组：让 chip、组间连接符、对齐都可见。
  // 🔴 不用 .catch(()=>{}) 吞错：选择器落空会「静默跳过」，截出一张看不出改版的图，
  //    比直接报错危险得多（项目方法论：假绿 > 假红的危害）。
  await page.locator('.fb-add').first().click();
  await page.waitForTimeout(200);
  await page.locator('.fb-actions button', { hasText: '条件组' }).click();
  await page.waitForTimeout(300);
  const groupCount = await page.locator('.filter-group').count();
  if (groupCount < 2) throw new Error(`条件组未新增（实际 ${groupCount} 组）—— 截图会失真，先修选择器`);

  // 填上值，避免满屏「未填完」暖色标记干扰观感（保留一条空值以展示该状态）
  const inputs = page.locator('.filter-cond .fb-input');
  if ((await inputs.count()) > 0) {
    await inputs.first().fill('1000');
    await page.waitForTimeout(200);
  }

  /**
   * 🔴 截图前断言「改版重点真的在画面里」—— 截图脚本最容易出的假绿是
   *    「图生成了，但画的是旧布局 / 空弹窗」。这里钉住缺陷 4 的三个可见证据。
   */
  const fbEvidence = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.filter-cond')];
    const lefts = rows
      .map((r) => r.querySelector('select.fb-col'))
      .filter(Boolean)
      .map((el) => Math.round(el.getBoundingClientRect().left));
    return {
      condRows: rows.length,
      // Grid 布局（不是旧的 flex-wrap）
      isGrid: rows.length > 0 && getComputedStyle(rows[0]).display === 'grid',
      // 同类控件纵向严格对齐（差值 0）—— 「布局很乱」的反面证据
      alignSpread: lefts.length >= 2 ? Math.max(...lefts) - Math.min(...lefts) : -1,
      chips: document.querySelectorAll('.filter-cond .fb-logic button').length,
      preview: document.querySelector('[data-testid="fb-preview"]')?.textContent?.trim() ?? '',
    };
  });
  if (!fbEvidence.isGrid) throw new Error('筛选条件行不是 grid 布局 —— 截到的是旧版样式');
  if (fbEvidence.condRows < 2 || fbEvidence.alignSpread !== 0) {
    throw new Error(`对齐证据不足：条件行 ${fbEvidence.condRows}，字段列左缘差 ${fbEvidence.alignSpread}px`);
  }
  if (fbEvidence.chips < 2) throw new Error(`AND/OR chip 未出现（${fbEvidence.chips} 个）—— 截图看不出改版`);
  console.log(`filter[${themeTag}]:`, JSON.stringify(fbEvidence));

  await page.screenshot({ path: join(here, `verify-filter-${themeTag}.png`) });

  await page.locator('.filter-modal footer button', { hasText: '取消' }).click();
  await page.waitForSelector('.filter-modal', { state: 'detached', timeout: 5000 });
}

/**
 * 缺陷 3/5 改版视图：右侧详情面板（表信息 + 字段两行结构含常驻注释 + 建表语句）。
 *
 * 用**树单击**触发（缺陷 3 的联动路径），不是双击开标签 —— 截图要证明的正是
 * 「不开标签也能看到详情」。选 order 表：它的字段注释最多，两行结构最明显。
 * ⚠️ demo 后端的 DDL 是占位文本（真机 SHOW CREATE 走 IPC），要看真实 DDL 用
 *    scripts/shot-real-ddl.mjs。
 */
async function shotDetailPanel(themeTag) {
  await page.locator('.tree-row', { hasText: /^order$/ }).first().click();
  await page.waitForTimeout(600);
  const panel = page.locator('.detail-panel');
  if ((await panel.count()) === 0) throw new Error('详情面板未渲染 —— 无图可截');

  /**
   * 🔴 断言「树单击真的联动了」+「注释是常驻文本」。
   *    面板本来就可能有内容（之前双击开过 order_item 标签），点击失败也会出一张图
   *    —— 那就是假绿。所以必须确认画的是**刚点的那张表**。
   *    ⚠️ 不能用表名判：`order_db.order` 是 `order_db.order_item` 的子串，
   *       面板首行也是「表信息」而非表名。用 order 表**专属**的字段注释最可靠
   *       （demo 里只有 order 表配了列注释，order_item / user 都没有）。
   *    注释用 **innerText** 判定：塞进 title 属性的内容不进 innerText，
   *    这正是缺陷 5「注释看不见」的技术归因，用它才能区分两种实现。
   */
  const detail = await panel.innerText();
  if (!/订单主键，自增/.test(detail)) {
    throw new Error(`树联动未生效或注释未常驻显示；面板前几行=${detail.split('\n').slice(0, 4).join(' | ').slice(0, 90)}`);
  }
  if (!/表结构语句/.test(detail)) throw new Error('第三块不是建表语句');
  const ddl = await panel.locator('pre.detail-ddl').innerText().catch(() => '');
  if (ddl.trim().length === 0) throw new Error('DDL 正文为空（占位文本也算有内容，空=通道没通）');
  console.log(`detail[${themeTag}]: 注释常驻 ✓ 表结构语句 ✓ DDL ${ddl.length} 字符`);

  await panel.screenshot({ path: join(here, `verify-detail-${themeTag}.png`) });
}

await shotConnectionEditor('light');
await shotScriptModal('light');
await shotFilterBuilder('light');
await shotDetailPanel('light');

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
await shotFilterBuilder('dark');
await shotDetailPanel('dark');

await browser.close();
server.kill('SIGTERM');
console.log('done: verify-{light,dark} / verify-{conn,script,filter,detail}-{light,dark}.png');
process.exit(0);
