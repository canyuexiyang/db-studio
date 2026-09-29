/**
 * 真机截图采集 —— 驱动已安装的 DB Studio,采集浅/深主题与关键界面截图。
 * 产出交给人工比对(设计红线:Apple 精修风、无紫色系、图标规范化)。
 * 用法:node scripts/capture-installed.mjs  → 截图输出到 docs/design-mockups/shots-installed/
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/design-mockups/shots-installed');
mkdirSync(OUT, { recursive: true });

const BIN = '/Applications/DB Studio.app/Contents/MacOS/DB Studio';
const electron = (await import('playwright-core')).electron ?? (await import('playwright-core'))._electron;

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// 同 verify-installed.mjs：清掉 IDE 沙箱注入的 NODE_OPTIONS，避免打包应用报无用 ERROR
delete childEnv.NODE_OPTIONS;

const app = await electron.launch({ executablePath: BIN, args: ['--no-sandbox'], env: childEnv, timeout: 60_000 });
const page = await app.firstWindow();
try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.tree-row', { timeout: 20_000 });
  await page.waitForTimeout(600);

  // 1. 主界面(浅色,含连接树)
  await page.screenshot({ path: join(OUT, '1-main-light.png') });

  // 2. 深色主题
  await page.locator('[data-testid="theme-select"]').selectOption('dark');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, '2-main-dark.png') });
  await page.locator('[data-testid="theme-select"]').selectOption('light');
  await page.waitForTimeout(300);

  // 3. 新建连接弹窗
  await page.locator('[data-testid="btn-new-connection"]').click();
  await page.waitForSelector('.connection-editor', { timeout: 15_000 });
  await page.screenshot({ path: join(OUT, '3-connection-editor.png') });
  // 弹窗未保存过 → 直接点取消关闭（无确认框）
  await page.locator('.connection-editor footer button', { hasText: '取消' }).click();
  await page.waitForTimeout(300);

  // 4. 连接并打开表(浅色) —— 若已有可连接节点
  const connRow = page.locator('.tree-row[data-testid]').first();
  if ((await connRow.count()) > 0) {
    await connRow.click();
    await page.waitForTimeout(2500);
    const dbRow = page.locator('.tree-row').filter({ has: page.locator('.tree-label') }).nth(3);
    await page.screenshot({ path: join(OUT, '4-tree-connected.png') });
    // 4.5 库节点右键菜单(Navicat 式)
    const anyDbRow = page.locator('.tree-row').filter({ has: page.locator('.tree-label') }).nth(3);
    if ((await anyDbRow.count()) > 0) {
      await anyDbRow.click({ button: 'right' });
      await page.waitForSelector('.ctx-menu', { timeout: 5_000 }).catch(() => null);
      if ((await page.locator('.ctx-menu').count()) > 0) {
        await page.screenshot({ path: join(OUT, '4b-context-menu.png') });
        await page.keyboard.press('Escape');
      }
    }
    // 打开一张表(如果能看到 verify_ui.order 就打开)
    const orderRow = page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^order$/ }) }).first();
    if ((await orderRow.count()) > 0) {
      await orderRow.dblclick();
      await page.waitForSelector('.grid-row', { timeout: 15_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, '5-grid-data.png') });
    }
    // 6. SQL 编辑器的库下拉(查询 tab)
    await page.keyboard.press('Meta+t');
    await page.waitForSelector('.cm-editor', { timeout: 15_000 }).catch(() => null);
    if ((await page.locator('.cm-editor').count()) > 0) {
      await page.screenshot({ path: join(OUT, '6-sql-editor-db-select.png') });
    }
  }

  console.log('✅ 截图完成:', OUT);
} finally {
  await app.close().catch(() => {});
}
