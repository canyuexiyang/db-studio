/**
 * 运行 SQL 脚本 UI 级自测 —— 驱动打包产物走完「选脚本 → 扫描摘要 → 确认 →
 * 流式执行 → schema 刷新 → 回读真库」全链路（库/表级别导入脚本）。
 *
 * 覆盖用户场景：删掉库下所有表后，导入一份包含建表 + 数据的完整 .sql 脚本。
 * 同时回归：连接编辑器新布局（分区表单 + 保存并连接）、库级与表级两个入口、
 * 遇错停止模式的失败统计。
 *
 * 原生对话框通过 DB_STUDIO_E2E_SCRIPT_FILES（换行分隔的多文件队列，按
 * 选择顺序依次消费）绕过 —— 见 ipc-handlers.ts，与 IMPORT_FILE 同族口径。
 *
 * 用法：node scripts/e2e-script-ui.mjs
 *   DB_STUDIO_INSTALLED_APP=... 可指定被测 .app（默认 /Applications/DB Studio.app）
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.DB_STUDIO_INSTALLED_APP ?? '/Applications/DB Studio.app';
const BIN = join(APP, 'Contents/MacOS/DB Studio');
const DB_NAME = 'script_ui';
const CONN_NAME = '脚本自测';

// DB_STUDIO_USE_DIST=1（或没有安装版）→ 用 dist 产物 + 本地 Electron 启动
//（与 e2e-app.mjs 同款：npm run build 之后即可回归，不必先打 .app）
const USE_DIST = process.env.DB_STUDIO_USE_DIST === '1' || !existsSync(BIN);

if (!USE_DIST && !existsSync(BIN)) {
  console.log(`⏭️  跳过：找不到被测应用 ${BIN}`);
  process.exit(0);
}

let electron;
try {
  const mod = await import('playwright-core');
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过：未安装 playwright-core');
  process.exit(0);
}

// ---------- 准备 fixture 库（真库，跑完好删） ----------
const { MySqlDriver } = await import('../packages/core-driver-mysql/src/index.ts');
const FIXTURE = { host: '127.0.0.1', port: 13306, user: 'root', password: 'dbstudio_local_2026' };

const admin = new MySqlDriver(FIXTURE, {});
try {
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${DB_NAME}\``);
  await admin.query(`CREATE TABLE \`legacy\` (id INT PRIMARY KEY, tag VARCHAR(16))`);
  await admin.query(`INSERT INTO \`legacy\` VALUES (1, 'old')`);
  console.log(`【准备】fixture 库 ${DB_NAME}（含旧表 legacy，将被脚本重建）`);
} finally {
  await admin.close().catch(() => {});
}

const tmp = mkdtempSync(join(tmpdir(), 'dbstudio-script-'));
// 脚本 1：mysqldump 风格（注释 + 条件注释 + DROP/CREATE/INSERT）—— 好脚本，3 条语句
const goodScript = join(tmp, 'rebuild.sql');
writeFileSync(
  goodScript,
  `-- 脚本重建测试（含中文注释；分号在注释里 ; 不分割）\n` +
    `/*!40101 SET NAMES utf8mb4 */;\n` +
    `DROP TABLE IF EXISTS \`legacy\`;\n` +
    `# 行注释也支持\n` +
    `CREATE TABLE \`items\` (\n` +
    `  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n` +
    `  name VARCHAR(64) NOT NULL,\n` +
    `  price DECIMAL(12,2) NOT NULL,\n` +
    `  created_at DATETIME(6) NULL\n` +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n` +
    `INSERT INTO \`items\` (name, price, created_at) VALUES\n` +
    `  ('商品甲', 12.50, '2026-09-27 10:00:00.000001'),\n` +
    `  ('商品;乙', 99.99, NULL);\n`,
  'utf8',
);
// 脚本 2：1 条好 + 1 条坏 —— 停止模式应停在失败处（executed=1, failed=1, aborted）
const badScript = join(tmp, 'broken.sql');
writeFileSync(
  badScript,
  `CREATE TABLE \`t_ok\` (id INT PRIMARY KEY);\n` +
    `INSERT INTO \`不存在的表\` VALUES (1);\n` +
    `CREATE TABLE \`t_never\` (id INT);\n`,
  'utf8',
);

// ---------- 起被测应用（一次性 userData + 测试接缝） ----------
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-script-user-'));
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.DB_STUDIO_E2E_USER_DATA = userData;
childEnv.DB_STUDIO_E2E_SCRIPT_FILES = `${goodScript}\n${badScript}`;
childEnv.DB_STUDIO_NO_SINGLE_LOCK = '1';

const electronApp = await electron.launch({
  executablePath: USE_DIST
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : BIN,
  args: USE_DIST ? ['--no-sandbox', join(ROOT, 'apps/desktop/dist/main/main.cjs')] : ['--no-sandbox'],
  env: childEnv,
  timeout: 60_000,
});
const page = await electronApp.firstWindow();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => void d.accept().catch(() => {}));

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** 库级入口：右键库节点 → 运行 SQL 脚本 → 选文件 → 摘要 → 确认 → 完成 */
async function runScriptViaDbNode() {
  await page.locator('.tree-row', { hasText: DB_NAME }).first().click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
  await page.locator('.ctx-item', { hasText: '运行 SQL 脚本…' }).click();
  await page.waitForSelector('[data-testid="script-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="script-pick-file"]').click();
  await page.waitForSelector('[data-testid="script-confirm"]', { timeout: 30_000 });
  const stats = await page.locator('[data-testid="script-stats"]').innerText();
  await page.locator('[data-testid="script-confirm-run"]').click();
  await page.waitForSelector('[data-testid="script-done"]', { timeout: 60_000 });
  const done = await page.locator('[data-testid="script-done"]').innerText();
  await page.locator('[data-testid="script-finish"]').click();
  await page.waitForSelector('[data-testid="script-modal"]', { state: 'detached', timeout: 5_000 });
  return { stats, done };
}

/**
 * V7 连接级入口：右键【连接节点】→ 运行 SQL 脚本 →（连接挂多库时先选库）→ 既有流程。
 *
 * 连接名以 CONN_NAME 定位（本脚本自建的连接）。返回是否弹过目标库选择器。
 */
async function runScriptViaConnNode() {
  await page.locator('.tree-row', { hasText: CONN_NAME }).first().click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
  const menu = await page.locator('.ctx-item .ctx-label').allInnerTexts();
  const hasEntry = /运行 SQL 脚本/.test(menu.join());
  await page.locator('.ctx-item', { hasText: '运行 SQL 脚本…' }).click();

  // 真库连接必然可见多个库（information_schema/mysql/script_ui…）→ 选择器应弹出。
  // 显式选中 script_ui 再下一步，验证「选定库 → 进入既有流程」这条接线。
  let picked = false;
  let pickerText = '';
  const picker = page.locator('[data-testid="script-db-picker"]');
  try {
    await picker.waitFor({ state: 'visible', timeout: 5_000 });
    picked = true;
    pickerText = await picker.innerText();
    await page.locator(`[data-testid="script-db-${DB_NAME}"]`).click();
    await page.locator('[data-testid="script-db-confirm"]').click();
  } catch {
    // 单库直通：脚本弹窗应已在等待
  }
  await page.waitForSelector('[data-testid="script-modal"]', { timeout: 10_000 });
  const title = await page.locator('[data-testid="script-modal"] header').innerText().catch(() => '');
  // 直接取消 —— 连接级入口的断言是「能进到脚本流程」，不重复执行脚本
  await page.locator('[data-testid="script-modal"] footer button', { hasText: '取消' }).first().click().catch(() => {});
  await page.waitForSelector('[data-testid="script-modal"]', { state: 'detached', timeout: 5_000 }).catch(() => {});
  return { hasEntry, picked, pickerText, title };
}

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar', { timeout: 20_000 });

  // ---------- 1. 新建连接（顺带回归连接编辑器新布局） ----------
  await page.locator('[data-testid="btn-new-connection"]').click();
  await page.waitForSelector('.connection-editor', { timeout: 15_000 });
  // 新布局的分区卡片：连接信息 / 组织 / 连接选项
  const sections = await page.locator('.connection-editor .ce-section-title').allInnerTexts();
  ok('连接编辑器分区布局（连接信息/组织/连接选项）', /连接信息/.test(sections.join()) && /组织/.test(sections.join()) && /连接选项/.test(sections.join()), sections.join('/'));
  await page.locator('.ce-field', { hasText: '连接名' }).locator('input').fill(CONN_NAME);
  await page.locator('.ce-field', { hasText: /^主机/ }).first().locator('input').fill(FIXTURE.host);
  await page.locator('.ce-field', { hasText: '端口' }).locator('input').fill(String(FIXTURE.port));
  await page.locator('.ce-field', { hasText: '用户名' }).locator('input').fill(FIXTURE.user);
  await page.locator('.ce-secret input').first().fill(FIXTURE.password);
  // 「保存并连接」：保存后立即握手（TablePlus 式保存即连）
  const btnTexts = await page.locator('.connection-editor footer button').allInnerTexts();
  ok('footer 含「保存并连接」', /保存并连接/.test(btnTexts.join()), btnTexts.join('/'));
  await page.locator('.connection-editor footer button.primary').click();
  await page.waitForSelector('.connection-editor', { state: 'detached', timeout: 10_000 });
  const connRow = page.locator('.tree-row', { hasText: CONN_NAME }).first();
  await connRow.click();
  let live = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    live = (await page.locator('.tree-row', { hasText: DB_NAME }).count()) > 0;
    if (live) break;
  }
  ok('保存并连接：连接建立且库自动展开', live);

  // ---------- 2. 库级入口：好脚本（DROP 旧表 + 建新表 + 写数据） ----------
  // 4 条语句：条件注释 SET（session）+ DROP legacy（DDL）+ CREATE items（DDL）+ INSERT（DML）
  const r1 = await runScriptViaDbNode();
  ok('扫描摘要：4 条语句（DDL 2 / DML 1 / 其他 1）', /4/.test(r1.stats) && /2/.test(r1.stats) && /1/.test(r1.stats), r1.stats.replace(/\n/g, ' ').slice(0, 60));
  ok('🔴 脚本执行 4 条全部成功', /已执行 4 条/.test(r1.done), r1.done.replace(/\n/g, ' ').slice(0, 60));

  // ---------- 3. schema 刷新：树出现新表 items（legacy 已被脚本删除） ----------
  // 库行默认折叠：先展开 script_ui，再看「表」类别层
  await page.locator('.tree-row', { hasText: DB_NAME }).first().click();
  await page.waitForTimeout(400);
  let itemsVisible = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    itemsVisible = (await page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^items$/ }) }).count()) > 0;
    if (itemsVisible) break;
    // 「表」类别层若还折叠，点它的 caret 展开（库行的下一个兄弟行）
    const kindRow = page.locator('.tree-row', { hasText: DB_NAME }).first().locator('xpath=following-sibling::div[1]');
    if ((await kindRow.locator('.tree-caret').innerText().catch(() => '')) === '▸') {
      await kindRow.locator('.tree-caret').click();
    }
  }
  ok('完成后 schema 自动刷新：新表 items 出现在树里', itemsVisible);
  const legacyGone = (await page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^legacy$/ }) }).count()) === 0;
  ok('脚本删除的 legacy 不再出现', legacyGone);

  // ---------- 4. 表级入口：坏脚本（遇错停止模式） ----------
  // 右键新表 items → 运行 SQL 脚本…（脚本对所在库执行；第二条语句必失败）
  await page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^items$/ }) }).first().click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
  const tableMenu = await page.locator('.ctx-item .ctx-label').allInnerTexts();
  ok('表级右键含「运行 SQL 脚本…」', /运行 SQL 脚本/.test(tableMenu.join()), tableMenu.join('/'));
  await page.locator('.ctx-item', { hasText: '运行 SQL 脚本…' }).click();
  await page.waitForSelector('[data-testid="script-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="script-pick-file"]').click();
  await page.waitForSelector('[data-testid="script-confirm"]', { timeout: 30_000 });
  await page.locator('[data-testid="script-confirm-run"]').click();
  await page.waitForSelector('[data-testid="script-done"]', { timeout: 60_000 });
  const done2 = await page.locator('[data-testid="script-done"]').innerText();
  ok('🔴 停止模式：第 1 条成功后失败即止（executed=1）', /已执行 1 条/.test(done2) && /中途失败已停止/.test(done2), done2.replace(/\n/g, ' ').slice(0, 80));
  await page.locator('[data-testid="script-finish"]').click();
  await page.waitForSelector('[data-testid="script-modal"]', { state: 'detached', timeout: 5_000 });

  // ---------- 4.5 V7 连接级入口：右键连接节点 →（多库时先选目标库）→ 既有脚本流程 ----------
  {
    const r = await runScriptViaConnNode();
    ok('V7 连接节点右键含「运行 SQL 脚本…」', r.hasEntry);
    ok('V7 连接级先弹目标库选择器（真库挂多库）', r.picked, r.pickerText.split('\n').slice(0, 3).join(' / ').slice(0, 70));
    ok('V7 选定库后进入既有脚本流程（标题带库名）',
      /运行 SQL 脚本/.test(r.title) && r.title.includes(DB_NAME), r.title.slice(0, 50));
  }

  // ---------- 5. 回读真库核对（保真三件套抽两项：中文 + 微秒） ----------
  // ⚠️ MySqlDriver 的 rows 是【数组形态】（rowsAsArray，R10 列式口径），按列下标取值
  const verify = new MySqlDriver(FIXTURE, {});
  try {
    await verify.connect();
    await verify.query(`USE \`${DB_NAME}\``);
    const legacy = await verify.query(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='legacy'`);
    ok('🔴 legacy 已被脚本 DROP', Number(legacy.rows[0]?.[0] ?? 1) === 0);
    const cnt = await verify.query('SELECT COUNT(*) FROM `items`');
    ok('🔴 items 2 行（脚本 INSERT 落库）', Number(cnt.rows[0]?.[0] ?? 0) === 2, `实际 ${cnt.rows[0]?.[0]}`);
    const zh = await verify.query("SELECT price, created_at FROM `items` WHERE name = '商品甲'");
    ok('🔴 中文与带分号数据无损', zh.rows.length === 1 && Number(zh.rows[0]?.[0]) === 12.5, JSON.stringify(zh.rows[0]));
    const us = await verify.query("SELECT created_at FROM `items` WHERE name = '商品甲'");
    ok('🔴 DATETIME(6) 微秒保真', String(us.rows[0]?.[0] ?? '').endsWith('000001'), String(us.rows[0]?.[0]));
    const never = await verify.query(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='t_never'`);
    ok('🔴 停止模式：失败后的语句未执行（t_never 不存在）', Number(never.rows[0]?.[0] ?? 1) === 0);
  } finally {
    await verify.close().catch(() => {});
  }

  ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));
} catch (e) {
  // 失败现场 dump，别对着一句 timeout 猜
  const dump = await page
    .evaluate(() => ({
      modal: document.querySelector('.modal')?.textContent?.slice(0, 240) ?? null,
      banner: document.querySelector('.banner')?.textContent?.slice(0, 200) ?? null,
      tree: document.querySelector('.tree')?.textContent?.slice(0, 160) ?? null,
    }))
    .catch(() => null);
  console.error('❌ 异常：', String(e).slice(0, 200));
  console.error('   现场：', JSON.stringify(dump));
  process.exitCode = 1;
} finally {
  await electronApp.close().catch(() => {});
  // 清理 fixture 库与临时目录（KEEP_FIXTURE=1 时保留现场供人工排查）
  if (process.env.KEEP_FIXTURE !== '1') {
    try {
      const cleanup = new MySqlDriver(FIXTURE, {});
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await cleanup.close();
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  } else {
    console.log(`ℹ️ KEEP_FIXTURE=1：保留 ${DB_NAME} 与 ${tmp}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name);
  process.exit(1);
}
