/**
 * 导入/导出 UI 级自测 —— 驱动打包产物走完导出(4 格式)与导入(4 步向导)全流程。
 *
 * 与 e2e:transfer 的区别：那个脚本直接调 TransferManager 验证 worker；
 * 这个脚本验证的是 **UI 弹窗 → IPC → utilityProcess → 文件落盘 → 数据可回读**
 * 的完整链路，包括树右键直接对"未打开的表"导出/导入的新路径。
 *
 * 原生对话框通过 DB_STUDIO_E2E_TRANSFER_DIR / DB_STUDIO_E2E_IMPORT_FILE 两个
 * 测试接缝绕过（见 ipc-handlers.ts，与 DB_STUDIO_E2E_USER_DATA 同族口径）。
 *
 * 用法：node scripts/e2e-transfer-ui.mjs
 *   DB_STUDIO_INSTALLED_APP=... 可指定被测 .app（默认 /Applications/DB Studio.app）
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.DB_STUDIO_INSTALLED_APP ?? '/Applications/DB Studio.app';
const BIN = join(APP, 'Contents/MacOS/DB Studio');
const DB_NAME = 'transfer_ui';
const TBL = 'items';
const CONN_NAME = '导出导入自测';

if (!existsSync(BIN)) {
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
let csvPath;
try {
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${DB_NAME}\``);
  await admin.query(`CREATE TABLE \`${TBL}\` (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'new',
    note VARCHAR(255) NULL,
    created_at DATETIME(6) NULL
  )`);
  await admin.query(`INSERT INTO \`${TBL}\` (name, amount, status, note, created_at) VALUES
    ('数据甲', 10.50, 'paid', '中文备注甲', '2026-09-26 09:00:00.000001'),
    ('数据乙', 20.00, 'new', NULL, NULL),
    ('数据丙', 30.25, 'paid', '', '2026-09-25 08:00:00.123456'),
    ('数据丁', 40.00, 'refunded', '备注丁', '2026-09-24 07:00:00.000000'),
    ('数据戊', 50.75, 'paid', NULL, '2026-09-23 06:00:00.000000'),
    ('数据己', 60.10, 'new', '备注己', '2026-09-22 05:00:00.000000')`);
  console.log(`【准备】fixture 库 ${DB_NAME}.${TBL}（6 行，含中文/NULL/微秒）`);
} finally {
  await admin.close().catch(() => {});
}

// 导入用 CSV：3 行有效 + 1 行金额非法（应被校验拦下，不写入）
const tmp = mkdtempSync(join(tmpdir(), 'dbstudio-xfer-'));
const exportDir = join(tmp, 'out');
/** P1-10：失败明细 CSV 的落盘目录（FILE_SAVE_BINARY 的 e2e 接缝） */
const saveDir = join(tmp, 'saved');
const { mkdirSync } = await import('node:fs');
mkdirSync(exportDir, { recursive: true });
csvPath = join(tmp, 'import-items.csv');
writeFileSync(
  csvPath,
  'name,amount,note,created_at\n' +
    '导入甲,11.50,中文备注甲,2026-09-26 12:00:00\n' +
    '导入乙,22.00,,2026-09-26 13:00:00\n' +
    '导入丙,33.33,备注丙,\n' +
    '导入坏,abc,坏行,2026-09-26 14:00:00\n',
  'utf8',
);

// ---------- 起被测应用（一次性 userData + 测试接缝） ----------
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-xfer-user-'));
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.DB_STUDIO_E2E_USER_DATA = userData;
childEnv.DB_STUDIO_E2E_TRANSFER_DIR = exportDir;
childEnv.DB_STUDIO_E2E_SAVE_DIR = saveDir;
childEnv.DB_STUDIO_E2E_IMPORT_FILE = csvPath;
childEnv.DB_STUDIO_NO_SINGLE_LOCK = '1';

const electronApp = await electron.launch({
  executablePath: BIN,
  args: ['--no-sandbox'],
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

async function exportViaModal(format) {
  await page.locator('[data-testid="btn-export"]').click();
  await page.waitForSelector('[data-testid="export-modal"]', { timeout: 10_000 });
  await page.locator(`[data-testid="export-format-${format}"]`).check();
  await page.locator('[data-testid="export-start"]').click();
  await page.waitForSelector('[data-testid="export-done"]', { timeout: 30_000 });
  const text = await page.locator('[data-testid="export-done"]').innerText();
  await page.locator('.export-modal footer button', { hasText: '关闭' }).click();
  await page.waitForTimeout(300);
  return text;
}

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar', { timeout: 20_000 });

  // ---------- 1. UI 建连接并连接 ----------
  await page.locator('[data-testid="btn-new-connection"]').click();
  await page.waitForSelector('.connection-editor', { timeout: 15_000 });
  await page.locator('.ce-field', { hasText: '连接名' }).locator('input').fill(CONN_NAME);
  await page.locator('.ce-field', { hasText: /^主机/ }).first().locator('input').fill(FIXTURE.host);
  await page.locator('.ce-field', { hasText: '端口' }).locator('input').fill(String(FIXTURE.port));
  await page.locator('.ce-field', { hasText: '用户名' }).locator('input').fill(FIXTURE.user);
  await page.locator('.ce-secret input').first().fill(FIXTURE.password);
  await page.locator('.connection-editor footer button.primary').click();
  await page.waitForSelector('.connection-editor', { state: 'detached', timeout: 10_000 });
  const connRow = page.locator('.tree-row', { hasText: CONN_NAME }).first();
  await connRow.click();
  let dbsReady = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    dbsReady = (await page.locator('.tree-row', { hasText: DB_NAME }).count()) > 0;
    if (dbsReady) break;
  }
  ok('连接建立且库自动展开', dbsReady);

  // ---------- 2. 打开 items 表 ----------
  await page.locator('.tree-row', { hasText: DB_NAME }).first().click();
  await page.waitForTimeout(400);
  const kindRow = page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^表$/ }) }).first();
  await kindRow.locator('.tree-caret').click();
  await page.waitForTimeout(400);
  const itemsRow = page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${TBL}$`) }) }).first();
  await itemsRow.dblclick();
  await page.waitForSelector('.grid-row', { timeout: 15_000 });
  ok('表已打开（网格有数据）', true);

  // ---------- 3. 工具栏导出 × 4 格式 ----------
  for (const f of ['xlsx', 'csv', 'json', 'sql']) {
    const doneText = await exportViaModal(f);
    ok(`导出 ${f} 完成`, /导出完成/.test(doneText), doneText.replace(/\n/g, ' ').slice(0, 40));
  }

  // 文件落盘与内容抽检
  const csvFile = join(exportDir, `${TBL}.csv`);
  const jsonFile = join(exportDir, `${TBL}.json`);
  const sqlFile = join(exportDir, `${TBL}.sql`);
  const xlsxFile = join(exportDir, `${TBL}.xlsx`);
  ok('CSV 文件落盘', existsSync(csvFile) && statSync(csvFile).size > 50);
  if (existsSync(csvFile)) {
    const csv = readFileSync(csvFile, 'utf8');
    ok('CSV 含 6 行数据且中文无损', (csv.match(/\n/g) ?? []).length >= 7 && /数据甲/.test(csv),
      `${(csv.match(/\n/g) ?? []).length} 行`);
  }
  if (existsSync(jsonFile)) {
    const arr = JSON.parse(readFileSync(jsonFile, 'utf8'));
    ok('JSON 可解析且 6 条记录', Array.isArray(arr) && arr.length === 6, `${arr.length ?? '?'} 条`);
  }
  if (existsSync(sqlFile)) {
    const sql = readFileSync(sqlFile, 'utf8');
    ok('SQL 导出含 INSERT', /INSERT INTO/i.test(sql), sql.slice(0, 60).replace(/\n/g, ' '));
  }
  ok('XLSX 文件落盘', existsSync(xlsxFile) && statSync(xlsxFile).size > 500);

  // ---------- 3.5 P0-1：选区快照导出（网格选 2 行 → 只写这 2 行，不重查） ----------
  {
    const gutter = page.locator('.grid-row .gd-rowno');
    await gutter.nth(0).click();
    await page.keyboard.down('Shift');
    await gutter.nth(1).click();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="btn-export"]').click();
    await page.waitForSelector('[data-testid="export-modal"]', { timeout: 10_000 });
    const selHint = await page.locator('[data-testid="export-scope-hint-selection"]').innerText();
    ok('选区范围选项可用且行数正确（2 行）', /2 行/.test(selHint), selHint);
    const colScopeDisabled = await page.locator('[data-testid="export-only-visible-columns"]').isDisabled();
    ok('仅可见列已可用（网格上报了可见列）', colScopeDisabled === false, 'disabled=' + colScopeDisabled);
    await page.locator('[data-testid="export-scope-selection"]').check();
    await page.locator('[data-testid="export-format-csv"]').check();
    await page.locator('[data-testid="export-start"]').click();
    await page.waitForSelector('[data-testid="export-done"]', { timeout: 30_000 });
    const selDoneText = await page.locator('[data-testid="export-done"]').innerText();
    await page.locator('.export-modal footer button', { hasText: '关闭' }).click();
    await page.waitForTimeout(300);
    ok('选区快照导出完成且报告 2 行', /2 行/.test(selDoneText), selDoneText.replace(/\n/g, ' ').slice(0, 40));
    // 🔴 核心断言：文件里就是 2 行（表头 + 2），不是重查出来的 6 行。
    //    真重查的话这里会是 7 行 —— 这是「快照被偷偷降级成重查」的唯一防线。
    const selCsv = existsSync(csvFile) ? readFileSync(csvFile, 'utf8') : '';
    const selLines = selCsv.split('\n').filter((l) => l !== '');
    ok('选区快照 CSV = 表头 + 2 数据行（未重查整表）', selLines.length === 3, `${selLines.length} 行`);
  }

  // ---------- 4. 树右键导出（未经过工具栏的同链路） ----------
  await itemsRow.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
  ok('表节点右键菜单出现', true);
  const menuLabels = await page.locator('.ctx-item .ctx-label').allInnerTexts();
  ok('表级右键含 打开/设计/导出/导入/清空/删除', /打开表/.test(menuLabels.join()) && /设计表/.test(menuLabels.join()) &&
     /导出数据/.test(menuLabels.join()) && /导入数据/.test(menuLabels.join()) &&
     /清空表/.test(menuLabels.join()) && /删除表/.test(menuLabels.join()), menuLabels.join('/'));
  await page.locator('.ctx-item', { hasText: '导出数据…' }).click();
  await page.waitForSelector('[data-testid="export-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="export-start"]').click();
  await page.waitForSelector('[data-testid="export-done"]', { timeout: 30_000 });
  await page.locator('.export-modal footer button', { hasText: '关闭' }).click();
  ok('树右键导出全链路走通', true);
  await page.waitForTimeout(300);

  // ---------- 5. 树右键导入（4 步向导） ----------
  await itemsRow.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
  await page.locator('.ctx-item', { hasText: '导入数据…' }).click();
  await page.waitForSelector('[data-testid="import-modal"]', { timeout: 10_000 });
  await page.locator('[data-testid="import-pick-file"]').click();
  await page.waitForSelector('[data-testid="import-mapping"]', { timeout: 15_000 });
  ok('导入 Step2 列映射出现（自动映射）', true);
  // 自动映射应把 name/amount/note/created_at 都对上
  const mappingText = await page.locator('[data-testid="import-mapping"]').innerText();
  ok('列映射自动对齐', /name/.test(mappingText) && /amount/.test(mappingText), '');

  /**
   * P1-10：编码 / 分隔符控件。
   *
   * 关键不是"控件在"，而是**改了真的会重新解析**：只验存在性的话，
   * 一个 onChange 什么都没干的 <select> 也能过。所以这里改一次分隔符，
   * 断言列数从 4 塌成 1，再改回来 —— 而且映射必须**原样保留**
   * （用户手调过的对应关系不能因为换个分隔符就被清空）。
   */
  {
    const encSel = page.locator('[data-testid="import-encoding"]');
    const delimSel = page.locator('[data-testid="import-delimiter"]');
    ok('Step2 编码控件存在且预选 UTF-8', (await encSel.count()) === 1 && (await encSel.inputValue()) === 'utf8', '');
    ok('Step2 分隔符控件存在且预选逗号', (await delimSel.inputValue()) === ',', '');
    const hint = await page.locator('[data-testid="import-encoding-hint"]').innerText().catch(() => '');
    ok('显示编码自动探测结论', /自动探测/.test(hint), hint.replace(/\n/g, ' ').slice(0, 40));

    const colCount = () => page.locator('[data-testid="import-mapping"] tbody tr').count();
    const before = await colCount();
    await delimSel.selectOption(';');
    await page.waitForTimeout(800);
    const after = await colCount();
    ok('🔴 改分隔符 → 真的重新解析（列数 4 → 1）', before === 4 && after === 1, `${before} → ${after}`);

    await delimSel.selectOption(',');
    await page.waitForTimeout(800);
    const back = await colCount();
    const mapped = await page.evaluate(
      () => [...document.querySelectorAll('[data-testid="import-mapping"] select')].filter((n) => n.value).length,
    );
    ok('改回逗号 → 列数恢复且映射原样保留', back === 4 && mapped === 4, `列 ${back} / 已映射 ${mapped}`);
  }
  await page.locator('[data-testid="import-next-3"]').click();
  await page.waitForTimeout(300);
  const previewText = await page.locator('[data-testid="import-preview"]').innerText().catch(() => '');
  ok('Step3 预览渲染', previewText.length > 0, '');
  await page.locator('[data-testid="import-next-4"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-testid="import-confirm"]').click();
  await page.waitForSelector('[data-testid="import-done"]', { timeout: 60_000 });
  const doneText = await page.locator('[data-testid="import-done"]').innerText();
  ok('🔴 导入 3 行有效 + 1 行非法被拦', /已插入 3 行/.test(doneText) && /1 行校验未通过/.test(doneText),
    doneText.replace(/\n/g, ' ').slice(0, 80));

  /**
   * P1-10：失败明细导出 CSV。
   * `issuesToCsv` 早就实现并有单测，却一直没有调用方 —— 用户只能把「1 行校验未通过」
   * 手抄出去。这里验的是**落盘内容**：带 UTF-8 BOM（Excel 中文不乱码）+
   * 表头 + 那一行的物理行号（含表头偏移，本文件坏行是第 5 行）。
   * 落盘路径走 `DB_STUDIO_E2E_SAVE_DIR` 接缝，不弹原生保存框。
   */
  {
    await page.locator('[data-testid="import-issues-csv"]').click();
    await page.waitForTimeout(1200);
    const files = existsSync(saveDir) ? readdirSync(saveDir).filter((f) => f.includes('导入失败明细')) : [];
    ok('失败明细 CSV 已落盘', files.length === 1, files.join(',') || '(无)');
    if (files.length === 1) {
      const raw = readFileSync(join(saveDir, files[0]), 'utf8');
      ok('🔴 CSV 带 UTF-8 BOM（Excel 打开中文不乱码）', raw.charCodeAt(0) === 0xfeff, `首字符 U+${raw.charCodeAt(0).toString(16)}`);
      const lines = raw.replace(/^\ufeff/, '').trim().split('\n');
      ok('CSV 表头正确', lines[0] === 'file_row,column,reason', lines[0]);
      ok('坏行的物理行号与原因都在', lines.length === 2 && lines[1].startsWith('5,'), lines[1]?.slice(0, 60) ?? '(无)');
    }
  }
  await page.locator('.import-modal footer button', { hasText: '关闭' }).click();

  // ---------- 6. 回读真库核对 ----------
  // ⚠️ MySqlDriver 的 rows 是【数组形态】（rowsAsArray，R10 列式口径），按列下标取值
  const verify = new MySqlDriver(FIXTURE, {});
  try {
    await verify.connect();
    await verify.query(`USE \`${DB_NAME}\``);
    const cnt = await verify.query(`SELECT COUNT(*) AS n FROM \`${TBL}\``);
    const n = Number(cnt.rows[0]?.[0] ?? 0);
    ok('🔴 回读真库：6 + 3 = 9 行', n === 9, `实际 ${n} 行`);
    const zh = await verify.query(`SELECT note, status FROM \`${TBL}\` WHERE name = '导入甲'`);
    ok('🔴 导入的中文数据无损', zh.rows[0]?.[0] === '中文备注甲', JSON.stringify(zh.rows[0]));
    ok('未映射列走表默认值（status=new）', zh.rows[0]?.[1] === 'new', JSON.stringify(zh.rows[0]));
  } finally {
    await verify.close().catch(() => {});
  }

  ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));
} catch (e) {
  // 失败现场 dump，别对着一句 timeout 猜
  const dump = await page
    .evaluate(() => ({
      modal: document.querySelector('.modal')?.textContent?.slice(0, 200) ?? null,
      banner: document.querySelector('.banner')?.textContent?.slice(0, 200) ?? null,
      tree: document.querySelector('.tree')?.textContent?.slice(0, 120) ?? null,
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
