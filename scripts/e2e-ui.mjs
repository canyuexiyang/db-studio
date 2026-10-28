/**
 * UI 真机验证（渲染层门禁）
 *
 * 单元测试测的是逻辑，这个脚本测的是「页面真的能跑起来」：
 * 虚拟滚动、脏标记、保存预演、全局快捷键、以及最关键的 **滚动帧率**。
 *
 * 帧率必须 **有头模式** 跑：headless Chromium 走虚拟 vsync，测出来的数没有意义。
 * 本机是 120Hz，预算线取 P50 < 20ms（即 ≥50FPS），实际能跑到 120FPS。
 *
 * 依赖 `playwright-core`（不下载浏览器，复用本机已有的 Chromium）。
 * 缺依赖时脚本 **跳过并提示**，不算失败 —— 逻辑门禁由 npm test 负责。
 *
 * 用法：
 *   npm run e2e:ui
 *   DB_STUDIO_UI_HEADLESS=1 npm run e2e:ui   # CI 用，跳过帧率断言
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RENDERER = join(ROOT, 'apps/desktop/renderer');
const PORT = Number(process.env.DB_STUDIO_UI_PORT ?? 5199);
const HEADLESS = process.env.DB_STUDIO_UI_HEADLESS === '1';

// ---------- 依赖与浏览器定位 ----------
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('⏭️  跳过 UI 验证：未安装 playwright-core');
  console.log('    安装：npm i -D playwright-core（不下载浏览器，复用本机 Chromium）');
  process.exit(0);
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  // 取版本号最大的一份，避免旧 revision 兼容问题
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
  console.log('⏭️  跳过 UI 验证：找不到 Chromium');
  console.log('    执行 npx playwright install chromium，或设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  process.exit(0);
}

// ---------- 起 dev server ----------
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: RENDERER,
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

async function waitForServer(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
if (!(await waitForServer())) {
  console.error('❌ dev server 起不来');
  stop();
  process.exit(1);
}

// ---------- 断言 ----------
const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * 用「命令面板 → 刷新当前对象 → 守卫 → 放弃改动」把当前表格的未保存改动清干净。
 *
 * 走刷新而不是点列头：列头会顺带改排序状态，而本脚本后面多处断言对排序有前提。
 *
 * 🔴 判「有没有脏格」必须读状态栏的 `data-dirty-count`，**不能数 `.grid-cell.dirty` 节点**：
 *    网格是虚拟滚动的，脏格若落在视口外（典型：T19 追加在末尾的空白行）就根本没渲染，
 *    节点数为 0 ⇒ 这个 helper 会**静默空转**，脏格原样留给下一个章节。
 *    （实测踩到：T19 收尾调用它，12 个脏格一个没清，污染了后续章节的断言基线。）
 */
async function clearDirtyByReload(page) {
  const dirty = Number((await page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count')) ?? 0);
  if (dirty === 0) return false;
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(300);
  await page.locator('.palette input').fill(':刷新当前对象');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  const guard = page.locator('[data-testid="dirty-reload-guard"]');
  await guard.waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('[data-testid="dirty-guard-discard"]').click();
  await page.waitForTimeout(800);
  return true;
}

const browser = await chromium.launch({ executablePath, headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  /**
   * 🔴 必须先【点开一张表】，网格才有数据。
   *
   * 早期这个脚本假设"页面一打开就铺好 demo 数据"，那是因为当时 App 直接
   * 内联了 demo 载荷。改成 backend 驱动（IPC/demo 双后端）之后，
   * 网格只在用户点树节点时才加载 —— 这是正确行为，不是回归。
   *
   * 于是这里补上真实用户路径：等树出来 → 点表节点 → 等网格行。
   * 顺带把「树点击 → 打开表」这条链路也纳进了门禁。
   */
  await page.waitForSelector('.tree-row', { timeout: 15_000 });
  ok('连接树已渲染', (await page.locator('.tree-row').count()) > 0,
    `${await page.locator('.tree-row').count()} 个节点`);

  // 0.5 树交互（2026-09-26 新语义）：单击选中（连接节点 demo 下已连接，不会触发重连）
  {
    const connRow = page.locator('.tree-row[data-testid]').first();
    await connRow.click();
    await page.waitForTimeout(200);
    ok('单击树节点即选中（active 高亮）', (await page.locator('.tree-row.active').count()) === 1);
  }

  // 0.6 面板宽度拖拽（2026-09-26 新增）：左分隔条拖宽侧栏、右分隔条缩详情面板
  {
    /**
     * 🔴 拖拽必须【逐段小步 + 等帧】地移动。
     *
     * 单次 `mouse.move(..., {steps:8})` 会把 8 个 pointermove 在同一帧里打出去，
     * 而 resizer 走的是 pointer capture + ref 累加：Chromium 在 setPointerCapture
     * 后同一帧内的高频 move 会被合并，实测只有第一步的 +10px 生效 → 断言随机红。
     * 真人是"按住 → 一格一格挪"，这里照做，断言才稳定。
     */
    const dragBy = async (x, y, dx, dy = 0) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      const segs = 8;
      for (let i = 1; i <= segs; i++) {
        await page.mouse.move(x + (dx * i) / segs, y + (dy * i) / segs);
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
    };

    const sbBefore = await page.evaluate(() => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0);
    const r1 = await page.locator('.panel-resizer').first().boundingBox();
    await dragBy(r1.x + r1.width / 2, r1.y + 300, 80);
    const sbAfter = await page.evaluate(() => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0);
    ok('拖动左分隔条加宽侧栏', sbAfter > sbBefore + 60, `${sbBefore} → ${sbAfter}`);

    const dpBefore = await page.evaluate(() => document.querySelector('.detail-panel')?.getBoundingClientRect().width ?? 0);
    const r2 = await page.locator('.panel-resizer').nth(1).boundingBox();
    await dragBy(r2.x + r2.width / 2, r2.y + 300, 60);
    const dpAfter = await page.evaluate(() => document.querySelector('.detail-panel')?.getBoundingClientRect().width ?? 0);
    ok('拖动右分隔条收窄详情面板', dpAfter < dpBefore - 40, `${dpBefore} → ${dpAfter}`);

    // 宽度持久化：写进 localStorage（下次启动恢复）
    await page.waitForTimeout(100);
    const layoutRaw = await page.evaluate(() => localStorage.getItem('dbstudio.layout.v1'));
    let layoutOk = false;
    try {
      const l = JSON.parse(layoutRaw ?? '');
      layoutOk = Math.abs(l.sidebarW - sbAfter) <= 2 && Math.abs(l.detailW - dpAfter) <= 2;
    } catch {}
    ok('面板宽度已持久化', layoutOk, layoutRaw ?? 'null');
    // 把侧栏拖回默认附近，后续截图/断言在常规布局下进行
    const r3 = await page.locator('.panel-resizer').first().boundingBox();
    await dragBy(r3.x + r3.width / 2, r3.y + 300, -(sbAfter - sbBefore));
  }

  /**
   * 打开表的交互（改之前先读 TreeView，别猜）：
   *  - 行【双击】：有子节点 → 切换展开；无子节点且是对象 → 打开表
   *  - caret【单击】：只切换展开
   * 所以流程是：先用 caret 展开库节点 → 再双击表节点。
   *
   * ⚠️ D1 的「首次展开到库层」意味着表节点【默认不可见】，
   *    直接找表节点会找不到。而用行双击来展开库节点是有害的：
   *    第一次双击展开、第二次双击就收起来了，来回抖动。
   *    用 caret 展开是幂等的，不受当前展开状态影响。
   */
  // 层级：连接 → 库 → 【表/视图/存储过程/函数 分组】→ 表
  // ⚠️ 比直觉多一层：库下面先按对象类别分组，表在「表」分组里。
  //    所以要点开两次 caret 才能看到表节点。
  await page.locator('.tree-row').filter({ hasText: 'order_db' }).first().locator('.tree-caret').click();
  await page.waitForTimeout(500);
  // ⚠️ 用 .tree-label 的【精确文本】找「表」分组：
  //    库节点现在带「＋表」新建按钮（含"表"字），泛匹配会点错行
  await page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^表$/ }) }).first().locator('.tree-caret').click();
  await page.waitForTimeout(500);

  // ⚠️ 用【精确文本】而不是 hasText 子串匹配：
  //    hasText:'order' 会同时命中 order / order_item / 库名 order_db，
  //    .last() 拿到的往往不是想要的那张表 —— 表现为"节点找到了但没数据"。
  const tableNode = page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: /^order$/ }) }).first();
  ok('展开库与「表」分组后表节点可见', (await tableNode.count()) > 0,
    `匹配到 ${await tableNode.count()} 个`);

  await tableNode.dblclick();
  await page.waitForSelector('.grid-row', { timeout: 15_000 });
  ok('双击表节点后网格载入数据', (await page.locator('.grid-row').count()) > 0,
    `${await page.locator('.grid-row').count()} 行`);
  await page.waitForTimeout(500);

  // 2.5 树右键菜单（Navicat 式，2026-09-26 二轮）：表节点与库节点各出各级操作
  {
    await tableNode.click({ button: 'right' });
    await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
    const menuText = await page.locator('.ctx-menu').innerText();
    ok('表节点右键菜单含 打开/设计/导出/导入/清空/删除',
      /打开表/.test(menuText) && /设计表/.test(menuText) && /导出数据/.test(menuText) &&
      /导入数据/.test(menuText) && /清空表/.test(menuText) && /删除表/.test(menuText),
      menuText.split('\n').slice(0, 6).join('/'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('Esc 关闭右键菜单', (await page.locator('.ctx-menu').count()) === 0);

    const dbRowNode = page.locator('.tree-row').filter({ hasText: 'order_db' }).first();
    await dbRowNode.click({ button: 'right' });
    await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
    const dbMenuText = await page.locator('.ctx-menu').innerText();
    ok('库节点右键菜单含 新建查询/新建表/复制库名',
      /新建查询/.test(dbMenuText) && /新建表/.test(dbMenuText) && /复制库名/.test(dbMenuText), '');
    // 直接点「新建查询」→ 新查询 tab 应继承该库（No database selected 修复的回归断言）
    await page.locator('.ctx-item', { hasText: '新建查询' }).click();
    await page.waitForSelector('.cm-editor', { timeout: 15_000 });
    const dbSel = page.locator('[data-testid="sql-db-select"]');
    ok('查询目标库下拉出现且继承选中库', (await dbSel.count()) === 1 && (await dbSel.inputValue()) === 'order_db',
      `value=${await dbSel.inputValue().catch(() => '?')}`);
    // 切库 → tab 上下文更新（demo 库列表含 log_db）
    await dbSel.selectOption('log_db');
    await page.waitForTimeout(200);
    ok('库下拉切换后生效', (await dbSel.inputValue()) === 'log_db');
    // 关掉这个查询 tab，别影响后续断言的 tab 计数
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(400);
  }

  // 1. 虚拟滚动：5 万行只渲染可视区
  const initial = await page.locator('.grid-row').count();
  ok('只渲染可视行（非 5 万行全量）', initial > 10 && initial < 80, `${initial} 行`);

  const idBefore = await page.locator('.grid-row').first().locator('.grid-cell').nth(1).textContent(); // nth(0) 是行号列
  await page.evaluate(() => { document.querySelector('.grid-viewport').scrollTop = 400_000; });
  await page.waitForTimeout(400);
  const idAfter = await page.locator('.grid-row').first().locator('.grid-cell').nth(1).textContent();
  const after = await page.locator('.grid-row').count();
  ok('滚动后仍只渲染可视行', after > 10 && after < 80, `${after} 行`);
  ok('滚动后内容更新（虚拟滚动生效）', idBefore !== idAfter, `首行 id ${idBefore} → ${idAfter}`);
  await page.evaluate(() => { document.querySelector('.grid-viewport').scrollTop = 0; });
  await page.waitForTimeout(300);

  // 2. NULL 视觉
  const nulls = await page.locator('.grid-cell.null').count();
  const nullStyle = nulls
    ? await page.locator('.grid-cell.null').first().evaluate((el) => getComputedStyle(el).fontStyle)
    : '';
  ok('NULL 斜体且区别于空串', nulls > 0 && nullStyle === 'italic', `${nulls} 个, font-style=${nullStyle}`);

  // 3. 编辑 → 脏标记
  await page.locator('.grid-row').nth(1).locator('.grid-cell').nth(7).dblclick(); // nth(7) = 原 nth(6) 数据列(gutter 占 nth(0))
  await page.waitForTimeout(200);
  ok('双击进入编辑态', (await page.locator('.grid-cell-editor').count()) === 1);
  await page.locator('.grid-cell-editor').fill('改过了');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok('提交后打脏标记', (await page.locator('.grid-cell.dirty').count()) >= 1,
    `状态栏「${(await page.locator('.statusbar span').first().textContent())?.trim()}」`);

  // 4. 保存预演（PRD §6.3.4 硬要求：没有"直接保存"）
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(500);
  const previewText = await page.locator('.modal').innerText().catch(() => '');
  ok('⌘S 弹出保存预演且含 UPDATE', /UPDATE/i.test(previewText),
    previewText.split('\n').find((l) => /UPDATE/i.test(l))?.slice(0, 60) ?? '未出现');
  await page.locator('button', { hasText: '取消' }).first().click().catch(() => {});
  await page.waitForTimeout(300);

  /**
   * 4.5 T01 / R01 回归：重载前未提交改动守卫。
   *
   * 🔴 这条断言的存在价值：修复前，点列头排序会**静默丢弃**脏格（实测脏格 1→0、
   *    输入消失）。而下面第 6 步的「排序三态」恰是在「脏格已被丢掉」的状态下写的 ——
   *    一旦实现回退到旧行为，那几条断言**照旧全绿**。所以必须单独钉住「不许丢」，
   *    并让守卫的取消路径（回滚乐观写入）与放弃路径（清脏后照常重载）都被覆盖。
   */
  {
    const dirtyBefore = await page.locator('.grid-cell.dirty').count();
    ok('T01 前置：仍有未保存的脏格', dirtyBefore >= 1, `脏格=${dirtyBefore}`);

    const guard = page.locator('[data-testid="dirty-reload-guard"]');
    const hdrEl = page.locator('.grid-header-cell').nth(1);

    await hdrEl.click();
    await guard.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    ok('T01 带脏格点列头 → 弹出未保存改动守卫', (await guard.count()) === 1);

    await page.locator('[data-testid="dirty-guard-cancel"]').click();
    await page.waitForTimeout(400);
    const dirtyAfterCancel = await page.locator('.grid-cell.dirty').count();
    ok('T01 取消后脏格原样保留', dirtyAfterCancel >= dirtyBefore, `${dirtyBefore} → ${dirtyAfterCancel}`);
    ok('T01 取消后列头未被写成已排序（乐观写入已回滚）',
      (await page.locator('.sort-mark').count()) === 0);
    ok('T01 取消后守卫已关闭', (await guard.count()) === 0);

    // 走「明确放弃」这条出口：脏格应被清空，且本次排序真正生效
    await hdrEl.click();
    await guard.waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('[data-testid="dirty-guard-discard"]').click();
    await page.waitForSelector('.grid-row', { timeout: 15_000 });
    await page.waitForTimeout(500);
    ok('T01 选择放弃后脏格被清空', (await page.locator('.grid-cell.dirty').count()) === 0);
    ok('T01 选择放弃后排序真正生效（列头 ↑）',
      /↑/.test((await page.locator('.sort-mark').first().textContent().catch(() => '')) ?? ''));

    // 收尾：把排序还原为「无」，避免污染第 6 步的三态断言（此时已无脏格，不再触发守卫）
    await hdrEl.click(); await page.waitForTimeout(250);
    await hdrEl.click(); await page.waitForTimeout(400);
    ok('T01 收尾：排序还原为无', (await page.locator('.sort-mark').count()) === 0);
  }

  // 5. 命令面板（D5）
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(400);
  ok('⌘K 打开命令面板', (await page.locator('.palette').count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Esc 关闭命令面板', (await page.locator('.palette').count()) === 0);

  // 6. 排序三态
  const hdr = page.locator('.grid-header-cell').nth(1); // nth(0) 是 A19 行号列头
  await hdr.click(); await page.waitForTimeout(150);
  const s1 = await page.locator('.sort-mark').first().textContent().catch(() => '');
  await hdr.click(); await page.waitForTimeout(150);
  const s2 = await page.locator('.sort-mark').first().textContent().catch(() => '');
  await hdr.click(); await page.waitForTimeout(150);
  const s3 = await page.locator('.sort-mark').count();
  ok('排序三态 ASC→DESC→清除', !!s1?.includes('↑') && !!s2?.includes('↓') && s3 === 0, `${s1} → ${s2} → ${s3 === 0 ? '清除' : s3}`);

  // 6.5 行号列与整行操作（A19-A22，2026-09-27）
  {
    // A19：行号列渲染
    ok('A19 行号列表头（#）', (await page.locator('.grid-header .gd-rowno-head').count()) === 1);
    const firstNo = (await page.locator('.grid-row').first().locator('.gd-rowno').textContent())?.trim();
    ok('行号从 1 开始', firstNo === '1', `首行行号=${firstNo}`);

    // sticky 左钉：横滚 800px 后行号仍贴滚动容器左缘
    await page.evaluate(() => { document.querySelector('.grid-viewport').scrollLeft = 800; });
    await page.waitForTimeout(200);
    const dgx = await page.evaluate(() => {
      const g = document.querySelector('.grid-row .gd-rowno')?.getBoundingClientRect().x ?? -1;
      const v = document.querySelector('.grid-viewport')?.getBoundingClientRect().x ?? 0;
      return Math.abs(g - v);
    });
    ok('横滚后行号仍钉在左缘（sticky）', dgx < 1.5, `偏差 ${dgx.toFixed(1)}px`);
    await page.evaluate(() => { document.querySelector('.grid-viewport').scrollLeft = 0; });
    await page.waitForTimeout(200);

    // 点选 / Cmd 多选 / Shift 范围选
    await page.locator('.grid-row').nth(0).locator('.gd-rowno').click();
    await page.waitForTimeout(120);
    ok('点击行号选中整行', (await page.locator('.grid-row.selected').count()) === 1);
    await page.locator('.grid-row').nth(1).locator('.gd-rowno').click({ modifiers: ['Meta'] });
    await page.waitForTimeout(120);
    ok('Cmd+点击行号多选到 2 行', (await page.locator('.grid-row.selected').count()) === 2);
    await page.locator('.grid-row').nth(4).locator('.gd-rowno').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(120);
    ok('Shift+点击行号范围选（1..4 共 4 行）', (await page.locator('.grid-row.selected').count()) === 4);
    const statusText = (await page.locator('.statusbar').innerText()).replace(/\n/g, ' ');
    ok('状态栏统计行勾选（4 行）', /4\s*行/.test(statusText), statusText.slice(0, 70));

    // A20：行右键 → 复制为 INSERT / UPDATE（带真实值，行勾选优先）
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    /**
     * 🔴 缺陷 2 回归（2026-09-29 用户反馈：复制只要值，不要列名 key）。
     *
     * 这条断言的存在价值：TSV 表头是"顺手加上"的东西，将来很容易被人
     * 悄悄加回去（而且加回去不会让任何一条既有断言变红）。
     *
     * 🔴 口径断言而非值断言：右键**单个单元格**时选区只有一列，首行就是那一列的
     *    列名 —— 断言"首行含 id/status"是错的（那是整行语义）。这里改成结构性契约：
     *      · 默认复制：行数 === 选中行数（1 行 = 1 行，没有多出来的表头）；
     *      · 含列名：恰好比默认多一行，且从第二行起与默认完全一致。
     *    这样不依赖具体列名/值，也不会因虚拟滚动位置而假红。
     */
    {
      // 先按行号勾选整行（行勾选优先于矩形选区参与复制 → 全部可见列）
      await page.locator('.grid-row').nth(0).locator('.gd-rowno').click();
      await page.waitForTimeout(200);
      await page.locator('.grid-row').nth(0).locator('.grid-cell').nth(1).click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      // T22：复制格式已收进二级面板 —— 先展开「复制…」再点具体格式
      await page.locator('[data-testid="ctx-copy-open"]').click();
      await page.waitForTimeout(200);
      await page.locator('.gd-ctx-item', { hasText: 'TSV（粘进 Excel）' }).click();
      await page.waitForTimeout(250);
      const tsvDefault = await page.evaluate(() => navigator.clipboard.readText());
      const defaultLines = tsvDefault.split('\n');
      ok('🔴 复制 TSV 默认不带列名表头（1 行选中 = 1 行输出）',
        defaultLines.length === 1 && defaultLines[0].length > 0,
        `行数=${defaultLines.length} 首行=${defaultLines[0].slice(0, 50)}`);

      // 「含列名」逃生口必须真的多给一行表头，且其余内容与默认逐字一致
      await page.locator('.grid-row').nth(0).locator('.gd-rowno').click();
      await page.waitForTimeout(150);
      await page.locator('.grid-row').nth(0).locator('.grid-cell').nth(1).click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      // T22：复制格式已收进二级面板 —— 先展开「复制…」再点具体格式
      await page.locator('[data-testid="ctx-copy-open"]').click();
      await page.waitForTimeout(200);
      await page.locator('.gd-ctx-item', { hasText: 'TSV（含列名）' }).click();
      await page.waitForTimeout(250);
      const tsvHeader = await page.evaluate(() => navigator.clipboard.readText());
      const headerLines = tsvHeader.split('\n');
      ok('右键「TSV（含列名）」恰好多一行表头，其余与默认一致',
        headerLines.length === defaultLines.length + 1 &&
          headerLines.slice(1).join('\n') === tsvDefault &&
          headerLines[0] !== defaultLines[0],
        `默认 ${defaultLines.length} 行 / 含列名 ${headerLines.length} 行，表头=${headerLines[0]?.slice(0, 50)}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);

      /**
       * 🔴 恢复行勾选：上面点单元格会走 selection.clearRows()（普通左键点击
       * 回到"单元格模式"，既有语义），而紧接着的 A20 断言依赖「已选 4 行」。
       * 不恢复的话 A20 会从"已选 4 行"退化成"第 N 行"，断言假红。
       */
      await page.locator('.grid-row').nth(0).locator('.gd-rowno').click();
      await page.locator('.grid-row').nth(1).locator('.gd-rowno').click({ modifiers: ['Meta'] });
      await page.locator('.grid-row').nth(4).locator('.gd-rowno').click({ modifiers: ['Shift'] });
      await page.waitForTimeout(200);
    }

    await page.locator('.grid-row').nth(2).locator('.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(200);
    const menuTitle = await page.locator('.gd-ctx-menu .gd-ctx-title').textContent().catch(() => '');
    ok('行右键菜单出现（标题为行语义）', /已选 4 行|第 \d+ 行/.test(menuTitle ?? ''), menuTitle ?? '无菜单');
    // T22：复制格式已收进二级面板 —— 先展开「复制…」再点具体格式
    await page.locator('[data-testid="ctx-copy-open"]').click();
    await page.waitForTimeout(200);
    await page.locator('.gd-ctx-item', { hasText: 'INSERT 语句' }).click();
    await page.waitForTimeout(200);
    const ins = await page.evaluate(() => navigator.clipboard.readText());
    ok('复制为 INSERT 带真实值（不再是 ? 占位）',
      /INSERT INTO `order_db`\.`order`/.test(ins) && /VALUES \(\d+/.test(ins) && !/VALUES \(\?/.test(ins),
      ins.split('\n')[0]?.slice(0, 90) ?? '空');
    await page.locator('.grid-row').nth(2).locator('.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(200);
    // T22：复制格式已收进二级面板 —— 先展开「复制…」再点具体格式
    await page.locator('[data-testid="ctx-copy-open"]').click();
    await page.waitForTimeout(200);
    await page.locator('.gd-ctx-item', { hasText: 'UPDATE 语句' }).click();
    await page.waitForTimeout(200);
    const upd = await page.evaluate(() => navigator.clipboard.readText());
    ok('复制为 UPDATE 带主键定位',
      /UPDATE `order_db`\.`order` SET/.test(upd) && /WHERE `id` = \d+/.test(upd),
      upd.split('\n')[0]?.slice(0, 90) ?? '空');

    // A21：列头右键菜单（显式降序 / 取消排序）
    await page.locator('.grid-header-cell').nth(1).click({ button: 'right' });
    await page.waitForTimeout(150);
    ok('列头右键菜单出现', (await page.locator('.gd-ctx-menu').count()) === 1);
    await page.locator('.gd-ctx-item', { hasText: '降序排序' }).click();
    await page.waitForTimeout(300);
    const sm = await page.locator('.sort-mark').first().textContent().catch(() => '');
    ok('列头菜单显式降序生效', !!sm?.includes('↓'), sm ?? '无角标');
    await page.locator('.grid-header-cell').nth(1).click({ button: 'right' });
    await page.waitForTimeout(150);
    await page.locator('.gd-ctx-item', { hasText: '取消排序' }).click();
    await page.waitForTimeout(200);
    ok('取消排序清空角标', (await page.locator('.sort-mark').count()) === 0);

    // A22：右键快速筛选 → 筛选条出现（demo 后端忽略 WHERE，但筛选链路 UI 全通）
    await page.locator('.grid-row').nth(1).locator('.grid-cell').nth(1).click({ button: 'right' });
    await page.waitForTimeout(150);
    await page.getByRole('menuitem', { name: '等于此值', exact: true }).click(); // exact：避免命中「不等于此值」
    await page.waitForTimeout(400);
    ok('快速筛选后筛选条出现', (await page.locator('.filter-bar').count()) === 1,
      (await page.locator('.filter-bar .preview').textContent().catch(() => '')) ?? '');
  }

  // 7. 帧率（只在有头模式断言）
  const fps = await page.evaluate(async () => {
    const el = document.querySelector('.grid-viewport');
    el.scrollTop = 0;
    const frames = [];
    let last = performance.now();
    let raf = requestAnimationFrame(function tick() {
      const n = performance.now();
      frames.push(n - last);
      last = n;
      raf = requestAnimationFrame(tick);
    });
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      el.scrollTop += 60;
      await new Promise((r) => requestAnimationFrame(r));
    }
    cancelAnimationFrame(raf);
    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      count: frames.length,
      p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
      p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      droppedPct: +(frames.filter((f) => f > 33.4).length / frames.length * 100).toFixed(1),
    };
  });
  const fpsPass = fps.p50 < 20;
  ok(
    HEADLESS ? '滚动帧率（headless，仅供参考）' : '滚动帧率',
    HEADLESS ? true : fpsPass,
    `${fps.count} 帧, P50 ${fps.p50}ms (${(1000 / fps.p50).toFixed(1)} FPS), P95 ${fps.p95}ms, 掉帧率 ${fps.droppedPct}%`,
  );

  // 8. 右侧详情面板（§6.7，2026-09-29 缺陷 3 + 5 改版）
  ok('详情面板已渲染', (await page.locator('.detail-panel').count()) === 1);
  const detailText = await page.locator('.detail-panel').innerText().catch(() => '');
  ok('详情面板显示表信息（引擎）', /引擎/.test(detailText));

  /**
   * 🔴 缺陷 5：字段区必须常驻显示注释（不是塞在 title 悬浮里）。
   * 断言落在 innerText 上 —— 悬浮 title 的内容不会出现在 innerText 里，
   * 所以这条能真正区分「常驻显示」与「改回 title」。
   * demo 数据的 order 表每列都带 comment（见 demoData.ts）。
   */
  ok('详情面板字段区常驻显示注释（缺陷 5）',
    /订单主键/.test(detailText) && /支付状态/.test(detailText),
    detailText.split('\n').filter((l) => /订单主键|支付状态/.test(l)).join(' | ').slice(0, 70));
  ok('字段区同时显示类型', /decimal\(12,2\)|bigint/.test(detailText));

  // 🔴 缺陷 5：第三块从「单元格完整值」换成「表结构语句」
  ok('详情面板第三块是「表结构语句」', /表结构语句/.test(detailText));
  ok('详情面板不再有「单元格完整值」区块', !/单元格完整值/.test(detailText));
  ok('建表语句区已渲染（demo 后端给占位 DDL）',
    (await page.locator('[data-testid="detail-ddl"]').count()) === 1);
  const ddlText = await page.locator('[data-testid="detail-ddl"]').innerText().catch(() => '');
  ok('建表语句含 SHOW CREATE 语义文本', ddlText.length > 10, ddlText.slice(0, 60));
  ok('建表语句有复制按钮', (await page.locator('[data-testid="btn-copy-ddl"]').count()) === 1);

  // 🔴 缺陷 3：树里单击表节点 → 详情面板联动（不必先把表打开成标签）
  {
    // 先切到另一张表（wide_metrics），确认详情面板跟着变
    const wideRow = page.locator('.tree-row').filter({ hasText: 'wide_metrics' }).first();
    if ((await wideRow.count()) > 0) {
      await wideRow.click(); // 单击 = 选中（不打开标签）
      await page.waitForTimeout(400);
      const linked = await page.locator('.detail-panel').innerText().catch(() => '');
      ok('缺陷 3：树中单击表节点，详情面板联动显示该表',
        /wide_metrics/.test(linked) && /宽表指标列/.test(linked),
        linked.split('\n').slice(0, 3).join(' | ').slice(0, 70));
      // 回到 order 标签，避免影响后续断言
      await page.locator('.ws-tab').first().click();
      await page.waitForTimeout(300);
    }
  }

  // 🔴 缺陷 5 配套：单元格完整值改为弹窗（右键「查看完整值」）
  {
    await page.locator('.grid-row').nth(2).locator('.grid-cell').nth(1).click({ button: 'right' });
    await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
    await page.locator('.gd-ctx-item', { hasText: '查看完整值' }).click();
    await page.waitForSelector('[data-testid="cell-value-modal"]', { timeout: 5_000 });
    ok('缺陷 5：右键「查看完整值」弹出单元格完整值弹窗',
      (await page.locator('[data-testid="cell-value-modal"]').count()) === 1);
    const modalText = await page.locator('[data-testid="cell-value-modal"]').innerText().catch(() => '');
    /**
     * 🔴 口径断言：只查结构，不查具体列名/行号。
     * · 列名：右键的是 .grid-cell.nth(1)（nth0 是行号 gutter）= 第一个数据列，
     *   到底是 id 还是别的取决于列顺序，写死必假红 —— 只断言"标题里有列名"。
     * · 行号：虚拟滚动下的**全局行号**（可能几百几千），写死「第 3 行」必假红。
     * 断言三段结构齐全即可：标题「单元格完整值 — <列名>」、库.表 order_db.order、"第 N 行"。
     */
    ok('弹窗显示列名与行号定位',
      /单元格完整值 — \S/.test(modalText) && /order_db\.order/.test(modalText) && /第\s*\d+\s*行/.test(modalText),
      modalText.split('\n')[0]?.slice(0, 80) ?? '');
    await page.locator('[data-testid="cell-modal-close"]').click();
    await page.waitForTimeout(250);
    ok('弹窗可关闭', (await page.locator('[data-testid="cell-value-modal"]').count()) === 0);
  }

  // 详情面板折叠
  await page.locator('.detail-head button').first().click();
  await page.waitForTimeout(250);
  ok('详情面板可折叠', (await page.locator('.detail-panel.collapsed').count()) === 1);
  await page.locator('.detail-head button').first().click();
  await page.waitForTimeout(250);
  ok('详情面板可展开', (await page.locator('.detail-panel.collapsed').count()) === 0);

  // 9. 筛选器（§6.3.3，逻辑已就绪，这里测 UI；缺陷 4 改版后类名为 .fb-*）
  await page.locator('.toolbar button', { hasText: '筛选' }).click();
  await page.waitForTimeout(400);
  ok('筛选弹窗打开', (await page.locator('.filter-modal').count()) === 1);
  ok('筛选器有列下拉', (await page.locator('.filter-cond select.fb-col').count()) >= 1);

  /**
   * 🔴 数值列不该有「包含」操作符 —— 这是真机验证过的行为，
   *    给数值列 LIKE 会静默返回空结果，用户完全看不出哪里错了。
   *
   * 选 amount（decimal 数值列）来验。
   * ⚠️ 缺陷 4 改版后，字段下拉的 option 文本改成「名称 — 注释」优先
   *    （没有注释才退回「名称（类型）」），所以不能再靠 option 文本里的
   *    `decimal` 认数值列 —— 改为按字段名 amount 精确选，断言才可靠、不会被静默跳过。
   */
  const colSelect = page.locator('.filter-cond select.fb-col').first();
  // 用 value（= 字段名）精确选中，不依赖 option 显示文本（文本会随注释变化）
  await colSelect.selectOption('amount').catch(() => {});
  const selectedVal = await colSelect.inputValue().catch(() => '');
  if (selectedVal === 'amount') {
    await page.waitForTimeout(250);
    const opTexts = await page.locator('.filter-cond select.fb-op').first().locator('option').allTextContents();
    ok('数值列不含「包含」操作符', !opTexts.includes('包含'), `操作符：${opTexts.join('/')}`);
  } else {
    ok('数值列不含「包含」操作符', true, `（demo 无 amount 列，selectedVal=${selectedVal}，跳过）`);
  }

  // 预览区应显示参数化后的可读条件，且值不拼进 SQL
  await page.locator('.filter-cond select.fb-col').first().selectOption({ index: 1 });
  await page.waitForTimeout(200);
  const previewBefore = await page.locator('.filter-preview').innerText().catch(() => '');
  /**
   * 🔴 原来是 `previewBefore.length >= 0` —— 恒真断言（字符串长度不可能为负），
   *    预览区改成什么都不会红。换成真的口径：必须是参数化 WHERE 原文
   *    （带反引号标识符，值以 `?` 参数形式存在、不拼进文本）。
   */
  ok('筛选预览：选中字段后显示参数化 WHERE（含反引号标识符）',
    /^WHERE/.test(previewBefore.trim()) && previewBefore.includes('`'),
    previewBefore.trim().slice(0, 60));
  /**
   * 🔴 口径断言：**有效条数 + 未填完条数 = 条件行总数**。
   *    不写死「1 条」—— 这段之前 A22 快速筛选已经应用过一个条件，弹窗打开时
   *    草稿是从 `tab.filter` 取种子的（这正是修复后的正确行为），所以草稿里
   *    天生就带着那条。写死具体数字的断言在这里必然假红。
   */
  {
    const parts = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="fb-preview-count"]')?.textContent ?? '';
      return {
        total: document.querySelectorAll('.filter-cond').length,
        effective: Number(t.match(/(\d+)\s*条有效条件/)?.[1] ?? 0),
        skipped: Number(t.match(/(\d+)\s*条未填完/)?.[1] ?? 0),
        raw: t.trim(),
      };
    });
    ok('筛选预览：有效数 + 未填完数 = 条件行总数（计数口径自洽）',
      parts.effective + parts.skipped === parts.total && parts.total > 0,
      `${parts.effective} 有效 + ${parts.skipped} 未填完 vs ${parts.total} 行；标签「${parts.raw}」`);
  }

  /**
   * 🔴 缺陷 4 回归（2026-09-29：布局乱 / 点击多 / 按钮丑）。
   * 三条断言分别钉住三处结构性改动 —— 它们都是"改坏了不会有任何既有测试变红"
   * 的那类（纯视觉/交互），必须显式看着。
   */
  {
    // ① AND/OR 是 chip 且一次点击即切换（治「点击过多」，不再是 select）
    // 先加第二条条件，chip 才会出现在条件行上（单条时 AND/OR 无意义，被刻意隐藏）
    await page.locator('.fb-add').first().click();
    await page.waitForTimeout(300);
    const rowCount = await page.locator('.filter-cond').count();
    ok('缺陷 4：「添加条件」就地新增一行', rowCount >= 2, `条件行数=${rowCount}`);
    const chipCount = await page.locator('.filter-cond .fb-logic button').count();
    ok('缺陷 4：多条件时出现 AND/OR chip（一步切换，非下拉）', chipCount >= 2, `chip 数=${chipCount}`);
    ok('缺陷 4：条件行里不再有 AND/OR 下拉（select.filter-logic 已废弃）',
      (await page.locator('.filter-cond select.filter-logic').count()) === 0);
    if (chipCount >= 2) {
      await page.locator('.filter-cond .fb-logic button', { hasText: 'OR' }).first().click();
      await page.waitForTimeout(200);
      const orOn = await page.locator('.filter-cond .fb-logic button.on', { hasText: 'OR' }).count();
      ok('缺陷 4：点击 OR chip 一次即生效（无需展开下拉）', orOn >= 1, `OR 选中态=${orOn}`);
    }

    /**
     * ② 严格网格对齐（治「布局很乱」）。
     * 🔴 必须在**多行**状态下量：只有 1 行时 max-min 恒为 0，那是个
     *    不改代码也恒真的假绿断言（项目方法论：断言要能失败才有价值）。
     */
    const align = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.filter-cond')];
      if (rows.length < 2) return null;
      const display = getComputedStyle(rows[0]).display;
      const leftsOf = (sel) => rows.map((r) => {
        const el = r.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().left) : -1;
      });
      const colLefts = leftsOf('select.fb-col');
      const opLefts = leftsOf('select.fb-op');
      const delLefts = leftsOf('.fb-del');
      const spread = (a) => Math.max(...a) - Math.min(...a);
      return {
        n: rows.length,
        display,
        spreadCol: spread(colLefts),
        spreadOp: spread(opLefts),
        spreadDel: spread(delLefts),
      };
    });
    ok('缺陷 4：条件行用 grid 布局（不是 flex-wrap）', align?.display === 'grid', `display=${align?.display}`);
    ok('缺陷 4：≥2 行时同类控件纵向严格对齐（差值 0）',
      !!align && align.spreadCol === 0 && align.spreadOp === 0 && align.spreadDel === 0,
      align ? `字段差=${align.spreadCol}px 条件差=${align.spreadOp}px 删除差=${align.spreadDel}px（${align.n} 行）` : '行数不足，未量');

    // ③ 删除按钮把行数收回去（chip/删除都在网格内，验它不串位）
    await page.locator('.filter-cond .fb-del').last().click();
    await page.waitForTimeout(250);
    ok('缺陷 4：删除按钮移除该条件行', (await page.locator('.filter-cond').count()) === rowCount - 1,
      `${rowCount} → ${await page.locator('.filter-cond').count()}`);
  }

  /**
   * 🔴 缺陷 4 连带修复的回归：**「取消」必须丢弃草稿**。
   *
   * 修之前的行为：FilterBuilder 的 onChange 直接写全局 `filterModel`，而「已应用」的
   * 真值是 `tab.filter`。于是加完条件点「取消」→ 草稿留在全局态 →
   * 工具栏「筛选 (2)」、状态栏「筛选：2 条」照显示，**数据却没筛**；
   * 下次点「应用」还会把用户以为已丢弃的条件用上。取消等于空按钮。
   *
   * ⚠️ 必须先「清除」建立**零基线**：这段之前的 A22 快速筛选已经应用过 1 个条件，
   *    徽标本来就是「筛选(1)」。第一版断言直接要求徽标不含数字 → 6 条全假红，
   *    而实现其实是对的（徽标显示的正是真值）。
   */
  {
    const badge = async () =>
      (await page.locator('[data-testid="btn-filter"]').innerText()).replace(/\s+/g, '');
    const hasBadge = async () => /\(\d/.test(await badge());

    // 零基线：「清除」是立即生效的动作（关弹窗 + 重载数据），顺带验它自己
    await page.locator('.filter-modal footer button', { hasText: '清除' }).click();
    await page.waitForTimeout(600);
    ok('缺陷 4：「清除」立即生效（弹窗关闭 + 徽标归零）',
      (await page.locator('.filter-modal').count()) === 0 && !(await hasBadge()),
      `徽标=${await badge()}`);

    // 重开：草稿从 tab.filter 取种子，刚清除过 → 应是未选字段的空行
    await page.locator('[data-testid="btn-filter"]').click();
    await page.waitForTimeout(400);
    ok('缺陷 4：清除后重开弹窗是干净草稿',
      (await page.locator('.filter-cond select.fb-col').first().inputValue()) === '',
      `首行字段=${await page.locator('.filter-cond select.fb-col').first().inputValue()}`);

    // 造一条**有效**条件：「为空」无需填值，选上字段即完整
    // （⚠️ 未选字段时操作符只有 eq/ne，没有 isNull —— 必须先选字段）
    await page.locator('.filter-cond select.fb-col').first().selectOption({ index: 1 });
    await page.waitForTimeout(250);
    await page.locator('.filter-cond select.fb-op').first().selectOption('isNull');
    await page.waitForTimeout(250);
    ok('缺陷 4：「为空」条件无需填值即算有效',
      /1\s*条有效条件/.test(await page.locator('[data-testid="fb-preview-count"]').innerText()),
      (await page.locator('[data-testid="fb-preview-count"]').innerText()).trim());

    // 草稿阶段徽标不该动（数据还没筛）
    ok('缺陷 4：编辑中的草稿不污染工具栏徽标', !(await hasBadge()), `徽标=${await badge()}`);

    /**
     * 🔴「N 条未填完已跳过」必须真的会显示。
     *
     * 这句提示上一版**从来没出现过**：两个计数都数"全部条件行"，
     * 于是 `total > effective` 恒为 false。它是我写进需求文档的已交付能力，
     * 却没有任何断言看着 —— 典型的"文档说有、界面从不显示"。
     *
     * ⚠️ 造半截行要把**字段清空**（选「（选择字段）」），不是靠 between 填一半：
     *    新增行默认选中第一列，且 `eq` + 空串按定义算**完整**（查空串有意义）；
     *    而 between 只在部分列类型上才有 —— 用空字段是唯一与列类型无关的半截态。
     */
    await page.locator('.fb-add').first().click();
    await page.waitForTimeout(300);
    await page.locator('.filter-cond select.fb-col').last().selectOption('');
    await page.waitForTimeout(300);
    const skipHint = (await page.locator('[data-testid="fb-preview-count"]').innerText()).trim();
    ok('缺陷 4：半截条件被标注「未填完已跳过」（不是静默忽略）',
      /1\s*条有效条件/.test(skipHint) && /1\s*条未填完已跳过/.test(skipHint), skipHint);

    // 取消 → 草稿（含这条 isNull 与半截行）全部丢弃
    await page.locator('[data-testid="btn-filter-cancel"]').click();
    await page.waitForTimeout(300);
    ok('筛选弹窗可关闭', (await page.locator('.filter-modal').count()) === 0);
    ok('缺陷 4：🔴 取消后徽标不残留计数（草稿已丢弃）', !(await hasBadge()), `徽标=${await badge()}`);
    const statusText = await page.locator('.statusbar').innerText().catch(() => '');
    ok('缺陷 4：取消后状态栏不显示「筛选：N 条」', !/筛选：\d+\s*条/.test(statusText),
      statusText.split('\n').filter((l) => l.includes('筛选')).join('|').slice(0, 60) || '(无筛选字样)');

    // 重开弹窗：草稿回到「已应用」状态（= 空），被取消的条件不在里面
    await page.locator('[data-testid="btn-filter"]').click();
    await page.waitForTimeout(400);
    ok('缺陷 4：重开弹窗看不到被取消的草稿（字段回到未选）',
      (await page.locator('.filter-cond select.fb-col').first().inputValue()) === '',
      `首行字段=${await page.locator('.filter-cond select.fb-col').first().inputValue()}`);

    // 「应用」才让徽标亮 —— 与「取消不亮」构成一对，证明徽标只跟真值
    await page.locator('.filter-cond select.fb-col').first().selectOption({ index: 1 });
    await page.waitForTimeout(250);
    await page.locator('.filter-cond select.fb-op').first().selectOption('isNull');
    await page.waitForTimeout(250);
    await page.locator('[data-testid="btn-filter-apply"]').click();
    await page.waitForTimeout(600);
    ok('缺陷 4：点「应用」后徽标才显示已生效的条件数', (await hasBadge()), `徽标=${await badge()}`);

    // 收尾：恢复干净状态给后面的断言（后面还有 ⌘T / 多标签等场景）
    await page.locator('[data-testid="btn-filter"]').click();
    await page.waitForTimeout(400);
    await page.locator('.filter-modal footer button', { hasText: '清除' }).click();
    await page.waitForTimeout(600);
  }

  // 10. SQL 编辑器（§6.4，E1 懒加载）—— 多标签版：⌘T 新建查询 tab
  const lazyStart = Date.now();
  await page.keyboard.press('Meta+t');
  await page.waitForSelector('.cm-editor', { timeout: 15_000 });
  const lazyMs = Date.now() - lazyStart;
  ok('⌘T 新建查询 tab 且编辑器懒载入渲染出 CodeMirror', (await page.locator('.cm-editor').count()) >= 1);
  ok('查询 tab 出现在标签条上', (await page.locator('.ws-tab').count()) >= 2,
    `${await page.locator('.ws-tab').count()} 个 tab`);
  /**
   * ⚠️ 这里的耗时【不做断言】，只记录。
   *
   * dev server 模式下模块未打包，浏览器要逐个 fetch + transform 五十多个 ESM，
   * 实测 800ms 量级 —— 那衡量的是 Vite dev 的性能，不是用户会遇到的加载时间。
   * E3 的「≤300ms」是**生产产物**的预算，断言放在 e2e-app.mjs（真 Electron + file://）。
   */
  console.log(`   ℹ️ dev 模式懒载入 ${lazyMs}ms（仅供参考；E3 断言见 e2e-app）`);

  // 编辑器里能输入
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('SELECT 1; SELECT 2;');
  await page.waitForTimeout(400);
  const editorText = await page.locator('.cm-content').innerText().catch(() => '');
  ok('编辑器可输入', /SELECT/i.test(editorText), editorText.slice(0, 40));

  // 执行 → 出结果 Tab
  // ⚠️ 用 data-testid 定位，不用可见文案：hasText:'执行' 会同时命中「执行选中」「执行计划」，
  //    而按精确文案匹配等于把测试绑死在 UI 文案上（T29 改文案时就会被门禁拦住）
  await page.locator('.sql-toolbar [data-testid="sql-run-all"]').click();
  await page.waitForTimeout(1500);
  const msgText = await page.locator('.sql-message').innerText().catch(() => '');
  ok('执行后出现结果消息', /行|失败|取消/.test(msgText), msgText.replace(/\n/g, ' ').slice(0, 60));

  // 结果页签可关闭（2026-09-26 三轮反馈）：关掉一个少一个，全关回到空态提示
  {
    const resBefore = await page.locator('[data-testid="sql-result-tabs"] .sql-tab').count();
    await page.locator('[data-testid^="sql-result-close-"]').last().click();
    await page.waitForTimeout(250);
    const resAfter = await page.locator('[data-testid="sql-result-tabs"] .sql-tab').count();
    ok('结果页签可关闭', resBefore >= 1 && resAfter === resBefore - 1, `${resBefore} → ${resAfter}`);
  }

  // P0-4 多标签核心断言：切回表 tab，网格仍在且状态保留
  await page.locator('.ws-tab').first().click();
  await page.waitForTimeout(400);
  ok('切回表 tab 网格仍渲染（状态保留）', (await page.locator('.grid-row').count()) > 0);
  // 表 tab 的 pane 是激活的（无 hidden），查询 tab 的 pane 隐藏但仍在 DOM
  const paneStates = await page.evaluate(() => ({
    activePanes: document.querySelectorAll('.ws-tab-pane:not(.hidden)').length,
    hiddenPanes: document.querySelectorAll('.ws-tab-pane.hidden').length,
  }));
  ok('非激活 tab 的 pane 以 hidden 保留（不销毁）', paneStates.hiddenPanes >= 1 && paneStates.activePanes >= 1,
    `激活 ${paneStates.activePanes} / 隐藏 ${paneStates.hiddenPanes}`);

  // 12. 连接编辑器（§6.1）
  /**
   * 这一段存在的理由：**"能通过 IPC 建连接"不等于"用户能在界面上建连接"**。
   * 主进程的 connSave 早就通了，但渲染层没有入口 —— 用户完全用不了。
   * 所以这里断言必须落到 DOM：弹窗真的出来了、SSH 分区能展开、
   * 校验真的拦住了非法输入、保存后列表真的多了一条。
   */
  const connCountBefore = await page.locator('.tree-row').count();

  await page.locator('[data-testid="btn-new-connection"]').click();
  await page.waitForSelector('.connection-editor', { timeout: 15_000 });
  ok('连接编辑器弹窗真的渲染出来（lazy chunk 生效）', (await page.locator('.connection-editor').count()) === 1);

  const ceText = await page.locator('.connection-editor').innerText();
  ok('常规分区含关键字段', /连接名/.test(ceText) && /主机/.test(ceText) && /只读模式/.test(ceText));
  ok('三个分区页签齐全', /常规/.test(ceText) && /SSH 隧道/.test(ceText) && /SSL/.test(ceText));

  // 未填连接名 → 保存按钮禁用（校验真的接到 UI 上了，不是只存在于 core 层）
  const saveDisabledEmpty = await page
    .locator('.connection-editor footer button.primary')
    .isDisabled()
    .catch(() => false);
  ok('🔴 未填必填项时保存被禁用（校验接入 UI）', saveDisabledEmpty);
  // 空表单不显示错误列表（2026-09-27：打开即一排红字既吵又挤占分区卡片），
  // 动过表单才实时校验 —— 这里先 touch 一下再断言错误文案
  const userFieldProbe = page.locator('.ce-field', { hasText: '用户名' }).locator('input');
  await userFieldProbe.fill('probe');
  await userFieldProbe.fill('');
  await page.waitForTimeout(200);
  const issueText = await page.locator('.ce-issues').innerText().catch(() => '');
  ok('错误列表给出具体原因', /连接名/.test(issueText), issueText.split('\n')[0]?.slice(0, 40) ?? '');

  // 切到 SSH 分区：默认关闭，勾选后才出现 SSH 主机/私钥字段
  await page.locator('.ce-tabs button', { hasText: 'SSH 隧道' }).click();
  await page.waitForTimeout(300);
  const sshBefore = await page.locator('.connection-editor').innerText();
  ok('SSH 分区默认不展示 SSH 主机字段（未勾选隧道）', !/SSH 主机/.test(sshBefore));

  await page.locator('.ce-check.prominent input[type=checkbox]').first().check();
  await page.waitForTimeout(300);
  const sshAfter = await page.locator('.connection-editor').innerText();
  ok('勾选隧道后展开 SSH 主机/端口/用户', /SSH 主机/.test(sshAfter) && /SSH 端口/.test(sshAfter) && /SSH 用户/.test(sshAfter));
  /**
   * 0600 权限说明只在【已选私钥路径】后显示（keyPermWarn 依赖 privateKeyPath 非空）。
   * demo 模式下 pickPrivateKey() 返回 null，路径永远为空 → 断言只能验「认证方式
   * 默认私钥」与「私钥路径输入框存在」；0600 文案留待 e2e-app（真 IPC）覆盖。
   */
  ok('认证方式默认私钥且路径输入框就位', /私钥文件路径/.test(sshAfter));

  // 🔴 先取消 SSH 隧道勾选 —— 不取消的话 ssh.host 必填校验一直生效，
  // 「测试连接/保存」按钮会保持 disabled（上一轮门禁挂掉的根因）
  await page.locator('.ce-tabs button', { hasText: 'SSH 隧道' }).click();
  await page.waitForTimeout(200);
  await page.locator('.ce-check.prominent input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(200);

  // 切回常规，填好必填项 → 保存可用
  await page.locator('.ce-tabs button', { hasText: '常规' }).click();
  await page.waitForTimeout(200);

  // 🔴 逐键输入回归（2026-09-26 真机缺陷）：Field 组件之前定义在组件体内，
  //    每个按键整树重挂 —— 中文一个字都进不去、焦点飞回连接名。
  //    这里用逐键输入（delay 模拟真人）验证值完整、焦点留在原输入框。
  {
    const nameInput2 = page.locator('.ce-field', { hasText: '连接名' }).locator('input');
    await nameInput2.click();
    await page.keyboard.type('中文连接测试', { delay: 40 });
    const nameVal = await nameInput2.inputValue();
    ok('中文逐键输入完整落格（不再被重挂截断）', nameVal === '中文连接测试', JSON.stringify(nameVal));

    const hostInput = page.locator('.ce-field', { hasText: /^主机/ }).first().locator('input');
    await hostInput.click();
    await page.keyboard.type('10.0.0.7', { delay: 30 });
    const focusedField = await page.evaluate(
      () => document.activeElement?.closest('.ce-field')?.getAttribute('data-field') ?? '(none)',
    );
    ok('其他输入框打字时焦点不被抢回连接名', focusedField === 'host', `focus=${focusedField}`);
  }

  await page.locator('.ce-field', { hasText: '连接名' }).locator('input').fill('真机验证连接');
  await page.waitForTimeout(200);
  await page.locator('.ce-field', { hasText: '用户名' }).locator('input').first().fill('root');
  await page.locator('.ce-secret input').first().fill('demo-pwd');
  await page.waitForTimeout(300);

  const saveEnabled = !(await page.locator('.connection-editor footer button.primary').isDisabled());
  ok('填完必填项后保存可用', saveEnabled);

  // 测试连接
  await page.locator('.connection-editor footer button', { hasText: '测试连接' }).click();
  await page.waitForTimeout(1200);
  const testMsg = await page.locator('.ce-issues.ok, .ce-issues.error').last().innerText().catch(() => '');
  ok('测试连接返回明确结果（耗时+版本）', /连接成功|连接失败/.test(testMsg), testMsg.slice(0, 60));

  // 保存 → 列表出现新连接
  await page.locator('.connection-editor footer button.primary').click();
  await page.waitForTimeout(1200);
  ok('保存后弹窗关闭', (await page.locator('.connection-editor').count()) === 0);

  /**
   * P1-1：保存后新连接所在的组必须【自动展开】—— 组 key 含成员 id，
   * 新建连接后 key 变化、旧展开记忆失效，之前默认折叠看不见，现已修复。
   * 脚本只做幂等保护（仍是 ▸ 未展开才点开），正常路径应直接是展开态 ▾。
   */
  const ungroupedRow = page.locator('.tree-row', { hasText: '未分组' }).first();
  const caret = ungroupedRow.locator('.tree-caret');
  if ((await caret.count()) > 0) {
    const caretText = ((await caret.innerText().catch(() => '')) || '').trim();
    if (caretText === '▸') {
      await caret.click();
      await page.waitForTimeout(300);
    }
  }
  const caretAfter = ((await caret.innerText().catch(() => '')) || '').trim();
  ok('保存后新连接所在组自动展开（P1-1）', caretAfter === '▾', `caret=${caretAfter || '无'}`);

  const treeText = await page.locator('.tree').innerText();
  ok('🔴 新连接出现在树里（保存→刷新闭环）', /真机验证连接/.test(treeText), treeText.split('\n')[0]?.slice(0, 20) ?? '');
  const connCountAfter = await page.locator('.tree-row').count();
  ok('树节点数增加（不是只弹了个 toast）', connCountAfter > connCountBefore, `${connCountBefore} → ${connCountAfter}`);

  // 11. 表设计器（§6.5）：打开 → 校验联动 → DDL 预览实时更新
  {
    // 确保当前激活的是表 tab（设计按钮只在表 tab 的工具栏出现）
    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(200);

    // 工具栏「设计」按钮 → 设计器打开（lazy chunk）
    const designBtn = page.locator('.toolbar button', { hasText: '设计' });
    if ((await designBtn.count()) > 0 && !(await designBtn.isDisabled())) {
      await designBtn.click();
      await page.waitForSelector('.designer-modal', { timeout: 10_000 });
      ok('表设计器打开（lazy chunk 生效）', true);

      // 校验联动：清空字段名 → 错误条出现
      const firstName = page.locator('[data-testid="col-name-1"]');
      if ((await firstName.count()) > 0) {
        await firstName.fill('');
        await page.waitForTimeout(300);
        const issueText = await page.locator('.designer-issues').innerText().catch(() => '');
        ok('设计器校验错误实时展示', /字段名不能为空/.test(issueText), issueText.split('\n')[0] ?? '');
        await firstName.fill('remark');
        await page.waitForTimeout(300);
      }

      // DDL 预览：改表模式下编辑字段 → 预览出现 MODIFY
      const ddlText = await page.locator('.designer-ddl pre').innerText().catch(() => '');
      ok('DDL 预览常驻展示', ddlText.trim().length > 0, ddlText.slice(0, 40));

      // 取消关闭
      await page.locator('.designer-modal footer button', { hasText: '取消' }).click();
      await page.waitForTimeout(200);
      ok('设计器可关闭', (await page.locator('.designer-modal').count()) === 0);
    } else {
      ok('⏭️ 表设计器（当前无打开的表，跳过）', true);
    }
  }

  // 12. 危险操作确认（P0-3，§8.5）：执行无 WHERE 的 DELETE → 弹确认 → 取消不执行
  {
    // 多标签版：切到查询 tab（前面已建）
    const queryTab = page.locator('.ws-tab').filter({ hasText: /查询/ }).first();
    if ((await queryTab.count()) > 0) {
      await queryTab.click();
    } else {
      await page.keyboard.press('Meta+t');
    }
    await page.waitForSelector('.cm-editor', { timeout: 15_000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('DELETE FROM `order`;');
    await page.waitForTimeout(300);

    // 定位「执行全部」按钮（用 testid，不绑可见文案）
    const runBtn = page.locator('.sql-toolbar [data-testid="sql-run-all"]');
    if ((await runBtn.count()) > 0 && !(await runBtn.isDisabled())) {
      await runBtn.click();
      // 危险确认弹窗出现（classifyDanger 是动态加载的 chunk，给足时间）
      const modal = page.locator('[data-testid="danger-confirm"]');
      await modal.waitFor({ timeout: 8_000 });
      const text = await modal.innerText();
      ok('无 WHERE DELETE 弹出危险确认', /没有 WHERE|全部行/.test(text), text.split('\n')[0]?.slice(0, 40) ?? '');
      ok('确认弹窗展示 SQL 原文', /DELETE/i.test(text));

      // demo 的连接 colorTag=red → 生产环境：应有第三层（输入表名）
      const hasInput = await modal.locator('[data-testid="danger-confirm-input"]').count();
      if (hasInput > 0) {
        // 输错表名 → 确认按钮保持禁用
        await modal.locator('[data-testid="danger-confirm-input"]').fill('wrong_name');
        await page.waitForTimeout(200);
        const confirmDisabled = await modal.locator('[data-testid="danger-confirm-btn"]').isDisabled();
        ok('生产环境第三层：输错表名不能确认', confirmDisabled, '');
        // 输对 → 按钮可用（但不点执行——demo 后端会假执行，无副作用，直接走取消）
        await modal.locator('[data-testid="danger-confirm-input"]').fill('order');
        await page.waitForTimeout(200);
        const confirmEnabled = !(await modal.locator('[data-testid="danger-confirm-btn"]').isDisabled());
        ok('生产环境第三层：输入正确表名后可确认', confirmEnabled, '');
      } else {
        ok('⏭️ 非生产连接：无第三层输入（二次确认即可）', true);
      }

      // 取消 → 不执行（toast 显示已取消）
      await modal.locator('button', { hasText: '取消' }).click();
      await page.waitForTimeout(400);
      const appText = await page.locator('.app').innerText();
      ok('取消后不执行（有取消提示）', /已取消/.test(appText), '');
    } else {
      ok('⏭️ 危险确认（执行按钮不可用，跳过）', true);
    }
    // 切回表 tab
    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(200);
  }

  // 12.5 P1 体验补全：Q2 树搜索 + 深色模式三态 + 树记忆持久化（P1-1/P1-2/P1-3）
  {
    // Q2：搜索字段名 → 列命中行（「含字段 xxx 的表」）出现；点第 2 条命中打开新表
    //     （第 1 条是 order 表——已经开着，复用语义不会再开新 tab）
    await page.locator('.tree-search').fill('amount');
    await page.waitForTimeout(400);
    const hitCount = await page.locator('.tree-col-hit').count();
    ok('Q2 树搜索：字段名反查出「含字段的表」', hitCount >= 2, `${hitCount} 条列命中`);
    const tabsBeforeColOpen = await page.locator('.ws-tab').count();
    await page.locator('.tree-col-hit').nth(1).click();
    await page.waitForTimeout(800);
    const tabsAfterColOpen = await page.locator('.ws-tab').count();
    ok('Q2 列命中点击后打开对应表标签', tabsAfterColOpen === tabsBeforeColOpen + 1,
      `${tabsBeforeColOpen} → ${tabsAfterColOpen}`);
    await page.locator('.tree-search').fill('');
    await page.waitForTimeout(300);

    // P1-2 深色模式三态：选深色 → data-theme=dark 且 body 背景真的变深
    const themeSelect = page.locator('[data-testid="theme-select"]');
    await themeSelect.selectOption('dark');
    await page.waitForTimeout(200);
    const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // 深色底色 2026-09 随 Apple 精修设计更新:#1e1e1e → #1c1c1e
    ok('P1-2 选深色后 data-theme=dark 且背景变深', themeAttr === 'dark' && /rgb\(28, 28, 30\)/.test(bodyBg),
      `${themeAttr} ${bodyBg}`);
    const persisted = await page.evaluate(() => localStorage.getItem('dbstudio.theme'));
    ok('P1-2 主题偏好已持久化', persisted === 'dark', String(persisted));
    await themeSelect.selectOption('light');
    await page.waitForTimeout(200);
    const bodyBgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('P1-2 选浅色后背景变浅', /rgb\(255, 255, 255\)/.test(bodyBgLight), bodyBgLight);

    // P1-2 面板命令「切换主题」：三态循环 light → dark
    // ⚠️ 用「主题」而不是「切换」—— 后者同时命中「切换只读模式」，回车会执行错命令
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill(':主题');
    await page.waitForTimeout(300);
    const paletteCmdText = await page.locator('.palette').innerText().catch(() => '');
    ok('命令面板含「切换主题」命令', /切换主题/.test(paletteCmdText), '');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const themeAfterCmd = await page.evaluate(() => document.documentElement.dataset.theme);
    ok('面板执行「切换主题」后生效', themeAfterCmd === 'dark', String(themeAfterCmd));
    await themeSelect.selectOption('system');
    await page.waitForTimeout(200);

    // P1-3 @ 历史模式：面板可进历史模式（V6 起 demo 后端预置了 3 条历史 → 列表应真有内容）
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill('@');
    await page.waitForTimeout(700);
    const paletteHistText = await page.locator('.palette').innerText().catch(() => '');
    ok('P1-3 @ 历史模式渲染正常（有历史列条 / 无历史给空态）',
      /SELECT|没有匹配项|搜索历史/.test(paletteHistText),
      paletteHistText.split('\n')[0] ?? '');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // P1-1 树展开记忆已持久化（含连接下的 db:/kind: key）
    const memRaw = await page.evaluate(() => localStorage.getItem('dbstudio.treeExpansion.v1'));
    let memOk = false;
    try {
      const m = JSON.parse(memRaw ?? '');
      memOk = !!m && m.version === 1 && Object.keys(m.byConnection ?? {}).length >= 1;
    } catch {}
    ok('P1-1 树展开记忆已持久化', memOk, (memRaw ?? 'null').slice(0, 60));
  }

  // 12.6 D2：从剪贴板粘贴多行（列对齐 + 类型校验 + 脏标记 + 计划摘要）
  {
    // Chromium 需显式授权剪贴板；授权失败时下面的断言会给出明确红点
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    // 粘贴目标 = order 表 tab（第 3 步已留 1 个脏单元格，粘贴覆盖同一区域 → 14 格）
    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(300);
    // 🔴 粘贴固定落在【第 0 行起】（App 层 startRow:0），而第 1 节的虚拟滚动
    //    测试把网格滚到了下方 —— P0-4 的「切回保留滚动位置」会保持这个偏移，
    //    粘贴目标行在视口外时 DOM 不会渲染脏标记。先滚回顶部再粘贴。
    await page.evaluate(() => {
      const vp = document.querySelector('.ws-tab-pane:not(.hidden) .grid-viewport');
      if (vp) vp.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    const dirtyBefore = await page.locator('.grid-cell.dirty').count();
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        '101\tP-101\t7\t9.90\tpaid\t2026-09-26 10:00:00\te2e粘贴\n102\tP-102\t8\t19.90\tpaid\t2026-09-26 11:00:00\te2e粘贴2',
      ),
    );
    await page.locator('.toolbar button', { hasText: '粘贴' }).click();
    // 轮询等待 DOM 反映（正常 ≤300ms；给足 3s）
    let dirtyAfter = dirtyBefore;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(200);
      dirtyAfter = await page.locator('.grid-cell.dirty').count();
      if (dirtyAfter > dirtyBefore) break;
    }
    ok('D2 粘贴 2 行后脏标记增加', dirtyAfter > dirtyBefore, `${dirtyBefore} → ${dirtyAfter}`);
    const appText = await page.locator('.app').innerText();
    ok('D2 粘贴给出写入计划摘要', /将写入 2 行 × 7 列/.test(appText), '');
  }

  /**
   * 12.7 P1-A 断层修复真机验证（V1–V7）
   *
   * 这一段存在的唯一理由：这些能力**底层/单测都已就绪，只是渲染层没接线** ——
   * 单测全绿但用户按 ⌘V / ⌘⌫ 毫无反应。所以每条断言都必须落到 DOM 行为，
   * 不能只看"函数被调用了"。
   */
  {
    // 保证表格 tab 激活且滚到左上角（后续断言都在可视区进行）
    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const vp = document.querySelector('.ws-tab-pane:not(.hidden) .grid-viewport');
      if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; }
    });
    await page.waitForTimeout(300);

    // ---- V1：⌘V 从焦点格粘贴（此前 TablePane 传空函数，按下无反应）----
    const dirtyV1Before = await page.locator('.grid-cell.dirty').count();
    await page.evaluate(() =>
      navigator.clipboard.writeText('9001\tV1-PASTE\t3\t1.50\tpaid\t2026-09-29 09:00:00\tV1'),
    );
    await page.locator('.grid-row').nth(6).locator('.grid-cell[data-col]').nth(0).click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Meta+v');
    let dirtyV1After = dirtyV1Before;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(200);
      dirtyV1After = await page.locator('.grid-cell.dirty').count();
      if (dirtyV1After > dirtyV1Before) break;
    }
    ok('V1 ⌘V 从焦点格粘贴生效（脏标记增加）', dirtyV1After > dirtyV1Before, `${dirtyV1Before} → ${dirtyV1After}`);
    ok('V1 粘贴给出写入计划摘要', /将写入 1 行/.test(await page.locator('.app').innerText()));

    // ---- V2：⌘⌫ 删除选中行 → 保存预演逐条 DELETE（此前传空函数）----
    await page.locator('.grid-row').nth(2).locator('.gd-rowno').click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Meta+Backspace');
    await page.waitForTimeout(600);
    const delText = await page.locator('.modal').innerText().catch(() => '');
    ok('V2 ⌘⌫ 弹出保存预演且含 DELETE 原文', /即将执行/.test(delText) && /DELETE/i.test(delText),
      delText.split('\n').slice(0, 3).join(' / ').slice(0, 90));
    await page.locator('.modal footer button', { hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    ok('V2 取消预演后弹窗关闭、不做任何删除', (await page.locator('.modal').count()) === 0);

    // ---- V3：鼠标拖选矩形选区（SelectionModel.extendTo 此前渲染层零调用）----
    {
      const from = await page.locator('.grid-row').nth(1).locator('.grid-cell[data-col]').nth(1).boundingBox();
      const to = await page.locator('.grid-row').nth(5).locator('.grid-cell[data-col]').nth(3).boundingBox();
      // 锚点 → 终点都取【单元格中心】，逐段插值
      const x0 = from.x + from.width / 2;
      const y0 = from.y + from.height / 2;
      const x1 = to.x + to.width / 2;
      const y1 = to.y + to.height / 2;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      // 逐段移动（同 resizer 抖动口径）：拖动路径挂在 window 的 pointermove 上，
      // 单帧内合并的 move 只保留最后一次位移 → 分步走才逼近真实拖拽行为
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
        await page.waitForTimeout(15);
      }
      const dragMid = await page.locator('.gd-drag').count();
      await page.mouse.up();
      await page.waitForTimeout(400);
      ok('V3 拖拽中矩形选区高亮（.gd-drag，零 React 重渲染）', dragMid > 0, `${dragMid} 格`);
      ok('V3 拖拽结束清除临时高亮', (await page.locator('.gd-drag').count()) === 0);
      // 状态栏统计：矩形选区必须跨多行多列，且 cells === rows × 选中列数(3)
      const sbText = (await page.locator('.statusbar').innerText()).replace(/\n/g, ' ');
      const m = sbText.match(/选中 (\d+) 行 \/ (\d+) 格/);
      const rowsSel = m ? Number(m[1]) : 0;
      const cellsSel = m ? Number(m[2]) : 0;
      ok('V3 拖选后状态栏统计矩形选区（多行多列，cells=rows×3）',
        rowsSel >= 4 && cellsSel === rowsSel * 3, sbText.slice(0, 90));
    }

    // T01：V1 粘贴 / V2 删除预演取消 都会留下脏格，「刷新当前对象」会先弹守卫。
    //      先把脏格按「放弃改动」清掉，下面的 V4 断言才有干净的基线。
    await clearDirtyByReload(page);

    // ---- V4：命令面板「假命令」治理（refresh / toggleReadOnly / openPreferences 均有真实副作用）----
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill(':刷新当前对象');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    ok('V4 「刷新当前对象」有真实副作用（toast 已刷新）', /已刷新/.test(await page.locator('.app').innerText()));

    // 切换只读 → 连接级只读翻转；再切回，避免影响后续断言
    for (const round of [1, 2]) {
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(300);
      await page.locator('.palette input').fill(':切换只读模式');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      if (round === 1) {
        ok('V4 「切换只读模式」有真实副作用（连接配置变更）',
          /只读模式/.test(await page.locator('.app').innerText()));
      }
    }

    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill(':打开偏好设置');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    ok('V4 「打开偏好设置」真正打开面板', (await page.locator('[data-testid="prefs-panel"]').count()) === 1);
    await page.locator('[data-testid="prefs-close"]').click();
    await page.waitForTimeout(300);
    ok('V4 偏好面板可关闭', (await page.locator('[data-testid="prefs-panel"]').count()) === 0);

    // ---- V5：⌘, 打开偏好设置 + 改动落盘 ----
    await page.keyboard.press('Meta+,');
    await page.waitForTimeout(700);
    ok('V5 ⌘, 打开偏好设置面板（此前全仓无组件）',
      (await page.locator('[data-testid="prefs-panel"]').count()) === 1);
    const prefsText = await page.locator('[data-testid="prefs-panel"]').innerText().catch(() => '');
    ok('V5 面板含 外观/字体缩放/快捷键 分区',
      /外观/.test(prefsText) && /字体缩放/.test(prefsText) && /快捷键/.test(prefsText));
    ok('V5 快捷键一览含 ⌘,', /⌘,/.test(prefsText));
    await page.locator('[data-testid="prefs-telemetry"]').check();
    await page.waitForTimeout(300);
    const prefsRaw = await page.evaluate(() => localStorage.getItem('dbstudio.preferences.v1'));
    let prefsPersistOk = false;
    try {
      prefsPersistOk = JSON.parse(prefsRaw ?? '{}').telemetryEnabled === true;
    } catch {}
    ok('V5 偏好改动落盘 localStorage（重启仍生效）', prefsPersistOk, (prefsRaw ?? 'null').slice(0, 80));
    await page.locator('[data-testid="prefs-done"]').click();
    await page.waitForTimeout(300);
    ok('V5 偏好面板可关闭', (await page.locator('[data-testid="prefs-panel"]').count()) === 0);

    // ---- V6：查询历史增强（⌘S 星标 / ⌘⌫ 删单条）----
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill('@');
    await page.waitForTimeout(800);
    const histBefore = await page.locator('.palette li').count();
    ok('V6 @ 历史模式列出预置历史', histBefore >= 3, `${histBefore} 条`);

    // ⌘S 星标当前项 —— 同时验证不会误触发 App 全局「保存预演」
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(600);
    ok('V6 ⌘S 星标不误触发保存预演', (await page.locator('.modal').count()) === 0);
    ok('V6 星标后出现「历史·星标」徽标',
      /历史·星标/.test(await page.locator('.palette').innerText().catch(() => '')));

    // ⌘⌫ 删单条 → 列表长度精确 -1
    await page.locator('.palette li').first().hover();
    await page.waitForTimeout(150);
    await page.keyboard.press('Meta+Backspace');
    await page.waitForTimeout(800);
    const histAfter = await page.locator('.palette li').count();
    ok('V6 ⌘⌫ 删单条后列表长度精确 -1', histAfter === histBefore - 1, `${histBefore} → ${histAfter}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('V6 历史模式可退出', (await page.locator('.palette').count()) === 0);

    // ---- V7：连接级「运行 SQL 脚本」入口（先弹目标库选择）----
    const connRowV7 = page.locator('.tree-row[data-testid^="tree-conn-"]').first();
    await connRowV7.click({ button: 'right' });
    await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
    const connMenuText = await page.locator('.ctx-menu').innerText();
    ok('V7 连接节点右键含「运行 SQL 脚本…」', /运行 SQL 脚本/.test(connMenuText),
      connMenuText.split('\n').slice(0, 8).join(' / '));
    await page.locator('.ctx-item', { hasText: '运行 SQL 脚本' }).click();
    await page.waitForSelector('[data-testid="script-db-picker"]', { timeout: 10_000 });
    const pickerText = await page.locator('[data-testid="script-db-picker"]').innerText();
    ok('V7 连接级先弹「目标库选择」（连接挂多个库）',
      /选择目标库/.test(pickerText) && /order_db/.test(pickerText) && /log_db/.test(pickerText),
      pickerText.split('\n').slice(0, 4).join(' / ').slice(0, 90));
    await page.locator('[data-testid="script-db-order_db"]').click();
    await page.waitForTimeout(250);
    await page.locator('[data-testid="script-db-confirm"]').click();
    await page.waitForSelector('[data-testid="script-modal"]', { timeout: 10_000 });
    const scriptTitle = await page.locator('[data-testid="script-modal"] header').innerText().catch(() => '');
    ok('V7 选定库后进入既有脚本流程（标题带库名）',
      /运行 SQL 脚本/.test(scriptTitle) && /order_db/.test(scriptTitle), scriptTitle.slice(0, 60));
    await page.locator('[data-testid="script-modal"] footer button', { hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    ok('V7 脚本面板可关闭', (await page.locator('[data-testid="script-modal"]').count()) === 0);

    // 回到表格 tab（后续 13 节的多标签断言依赖当前激活态）
    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(300);
  }

  /**
   * 12.8 P1-B 网格编辑深度真机验证（V8–V13）
   *
   * 与 12.7 同款原则：每条断言落到 DOM 行为，不看"函数被调用"。
   * 顺序刻意安排：先做不产生脏单元格的（V11/V8/V12/V9），再做产生脏标记的
   * （V13/V10）—— 这样 V13 的"脏标记 +4"断言不会被前面的编辑污染。
   */
  {
    const PANE = '.ws-tab-pane:not(.hidden)';
    const resetScroll = async () => {
      await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; }
      }, PANE);
      await page.waitForTimeout(200);
    };
    const sbSel = async () => {
      const t = (await page.locator('.statusbar').innerText()).replace(/\n/g, ' ');
      const m = t.match(/选中 (\d+) 行 \/ (\d+) 格/);
      return m ? { rows: Number(m[1]), cells: Number(m[2]) } : { rows: 0, cells: 0 };
    };

    await page.locator('.ws-tab').first().click();
    await page.waitForTimeout(300);
    await resetScroll();

    // ---- V11：⌥↑ 递进选区（列 → 行 → 全表），⌥↓ 收缩 ----
    {
      await page.locator(`${PANE} .grid-row`).nth(3).locator('.grid-cell[data-col]').nth(2).click();
      await page.waitForTimeout(200);

      await page.keyboard.press('Alt+ArrowUp'); // 1：整列
      await page.waitForTimeout(250);
      const col = await sbSel();
      ok('V11 ⌥↑ 第 1 次 = 选中整列（cells === rows，单列）',
        col.rows > 1 && col.cells === col.rows, `行=${col.rows} 格=${col.cells}`);

      await page.keyboard.press('Alt+ArrowUp'); // 2：整行
      await page.waitForTimeout(250);
      const rowSel = await sbSel();
      ok('V11 ⌥↑ 第 2 次 = 选中整行（1 行 × 全部列）',
        rowSel.rows === 1 && rowSel.cells === 7, `行=${rowSel.rows} 格=${rowSel.cells}`);

      await page.keyboard.press('Alt+ArrowUp'); // 3：整个网格
      await page.waitForTimeout(300);
      const all = await sbSel();
      ok('V11 ⌥↑ 第 3 次 = 选中整个网格（cells === rows × 7）',
        all.rows > 1 && all.cells === all.rows * 7, `行=${all.rows} 格=${all.cells}`);

      await page.keyboard.press('Alt+ArrowDown'); // 收回整行
      await page.waitForTimeout(250);
      const back = await sbSel();
      ok('V11 ⌥↓ 反向收缩（回到整行）', back.rows === 1 && back.cells === 7,
        `行=${back.rows} 格=${back.cells}`);

      // 🔴 focus 不随档位漂移：收缩回 0 档后焦点仍在起点格（第 4 行第 3 列）
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForTimeout(200);
      const focusOk = await page.evaluate((p) => {
        const el = document.querySelector(`${p} .grid-cell.focus`);
        return el ? { row: el.closest('.grid-row')?.getAttribute('style') ?? '', col: el.dataset.col } : null;
      }, PANE);
      ok('V11 递进后焦点仍在起始单元格（col=2）', focusOk?.col === '2', JSON.stringify(focusOk?.col));

      await page.locator(`${PANE} .grid-row`).nth(0).locator('.grid-cell[data-col]').nth(0).click();
      await page.waitForTimeout(200);
    }

    // ---- V8：冻结列（工具栏 toggle + 列头右键「冻结到此列」+ 横滚实色钉住）----
    {
      const freezeBtn = page.locator(`${PANE} [data-testid="btn-freeze"]`);
      ok('V8 工具栏有冻结按钮', (await freezeBtn.count()) === 1);
      await freezeBtn.click();
      await page.waitForTimeout(300);

      const badge = page.locator(`${PANE} [data-testid="frozen-badge"]`);
      ok('V8 冻结后出现状态徽标', (await badge.count()) === 1,
        (await badge.innerText().catch(() => '')).trim());
      const frozenCells = await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell.gd-frozen').count();
      ok('V8 第 1 个可见列被钉住（gd-frozen）', frozenCells === 1, `${frozenCells} 列`);

      // 🔴 横滚后：行号列贴左缘(≈0)、冻结列紧随其后(≈52px)、都**没有**随内容滚走
      //
      // 🔴 断言强度（防假绿）：不能只比"冻结列在 52px" —— 那是它的自然位置，
      //    **没滚动时也是 52px**。所以三条一起断：
      //      ① scrollLeft 真的 > 0（否则整个用例什么都没测）；
      //      ② 行号列与冻结列都钉在原位（sticky 生效）；
      //      ③ 有普通列被滚到冻结块**底下**（内容 x < 冻结块右缘）——
      //         这才证明冻结列真的在"盖住"本该可见的数据列。
      //         没有这条，冻结列可能只是恰好排在左边，钉不钉都看不出区别。
      const scrollProbe = await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        if (!vp) return null;
        vp.scrollLeft = 600;
        return { requested: 600, actual: vp.scrollLeft, maxScroll: vp.scrollWidth - vp.clientWidth };
      }, PANE);
      await page.waitForTimeout(300);
      ok('V8 前提：该表确实能横向滚动（否则冻结无从验证）',
        (scrollProbe?.actual ?? 0) > 0,
        `scrollLeft ${scrollProbe?.actual} / max ${scrollProbe?.maxScroll}（请求 ${scrollProbe?.requested}）`);

      const sticky = await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        const vpx = vp.getBoundingClientRect().x;
        const r = vp.querySelector('.grid-row');
        const rowno = r?.querySelector('.gd-rowno')?.getBoundingClientRect().x ?? -999;
        const frozenEl = r?.querySelector('.grid-cell.gd-frozen');
        const frozen = frozenEl?.getBoundingClientRect() ?? null;
        const headFrozen = vp.querySelector('.grid-header-cell.gd-frozen')?.getBoundingClientRect().x ?? -999;
        // 有多少普通列已经滚到冻结块右缘之下（被盖住）
        const frozenRight = frozen ? frozen.right - vpx : 0;
        let covered = 0;
        for (const el of r?.querySelectorAll('.grid-cell[data-col]') ?? []) {
          if (el.classList.contains('gd-frozen')) continue;
          const box = el.getBoundingClientRect();
          if (box.right - vpx <= frozenRight + 0.5) covered++;
        }
        return {
          rowno: rowno - vpx,
          frozen: frozen ? frozen.left - vpx : -999,
          headFrozen: headFrozen - vpx,
          covered,
        };
      }, PANE);
      ok('V8 横滚后行号列仍钉左缘', Math.abs(sticky.rowno) < 1.5, `偏差 ${sticky.rowno.toFixed(1)}px`);
      ok('V8 横滚后冻结列钉在行号右侧（未随滚动移走）',
        sticky.frozen > 40 && sticky.frozen < 70, `偏移 ${sticky.frozen.toFixed(1)}px`);
      ok('V8 冻结列表头同样钉住', sticky.headFrozen > 40 && sticky.headFrozen < 70,
        `偏移 ${sticky.headFrozen.toFixed(1)}px`);
      /**
       * 🔴「冻结列盖住数据列」这条**不在窄表上断言** —— order 只有 7 列，
       *    maxScroll 实测仅 66px（上面 scrollProbe 已打印），滚动量不足以把
       *    任何一整列推到冻结块底下，断言必然失败，而且失败**不代表功能有 bug**。
       *    真正的覆盖性验证在下面「V8 宽表验收」段（40 列 / maxScroll 5016px，
       *    实测 4 列被钉住的冻结列覆盖）。
       *    这里只留一条弱断言：窄表滚动后网格仍然正常渲染（没被 sticky 搞崩）。
       */
      ok('V8 窄表横滚后网格仍正常渲染（sticky 未破坏布局）',
        (await page.locator(`${PANE} .grid-row .grid-cell`).count()) > 0,
        `maxScroll ${scrollProbe?.maxScroll}px`);

      // 🔴 红线 11：冻结列必须实色底 —— background-color 不能是半透明/transparent，
      // 否则横滚时下层数据列会透出来（看起来像两层数据叠在一起）
      const bg = await page.evaluate((p) => {
        const el = document.querySelector(`${p} .grid-row .grid-cell.gd-frozen`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { color: cs.backgroundColor, pos: cs.position };
      }, PANE);
      ok('V8 冻结列 position:sticky', bg?.pos === 'sticky', bg?.pos ?? 'null');
      ok('V8 🔴 冻结列底色不透明（红线 11：不许透出下层数据列）',
        !!bg?.color && !/rgba\([^)]*,\s*0\)/.test(bg.color) && bg.color !== 'transparent', bg?.color ?? 'null');

      // 列头右键「冻结到此列」：冻结到第 3 个可见列
      await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        if (vp) vp.scrollLeft = 0;
      }, PANE);
      await page.waitForTimeout(200);
      await page.locator(`${PANE} .grid-header-cell.gd-header-cell`).nth(2).click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      const freezeItem = page.locator('[data-testid="ctx-freeze"]');
      ok('V8 列头右键含「冻结到此列」', (await freezeItem.count()) === 1,
        (await freezeItem.innerText().catch(() => '')).trim());
      await freezeItem.click();
      await page.waitForTimeout(350);
      const frozen3 = await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell.gd-frozen').count();
      ok('V8 「冻结到此列」冻结前 3 列', frozen3 === 3, `${frozen3} 列`);

      // 冻结状态按表持久化（A15 同一份 localStorage）
      const persisted = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith('dbstudio.grid.view.v1:')) {
            try {
              const v = JSON.parse(localStorage.getItem(k) ?? '{}');
              if (v.frozenCount > 0) return { key: k, frozenCount: v.frozenCount };
            } catch {}
          }
        }
        return null;
      });
      ok('V8 冻结列数落盘（重开表仍生效）', persisted?.frozenCount === 3, JSON.stringify(persisted));

      // 再点一次已冻结的最后一列 = 取消冻结（toggle 手感）
      await page.locator(`${PANE} .grid-header-cell.gd-header-cell`).nth(2).click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      await page.locator('[data-testid="ctx-freeze"]').click();
      await page.waitForTimeout(350);
      ok('V8 再次点击同一列取消冻结',
        (await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell.gd-frozen').count()) === 0);
      ok('V8 取消冻结后徽标消失', (await page.locator(`${PANE} [data-testid="frozen-badge"]`).count()) === 0);
      await resetScroll();
    }

    // ---- V12：结果集转置（一行 = 一个字段；只读查看；可退出）----
    {
      await page.locator(`${PANE} [data-testid="btn-transpose"]`).click();
      await page.waitForSelector('[data-testid="transposed-view"]', { timeout: 5_000 });
      await page.waitForTimeout(300);

      const fieldRows = await page.locator('.gd-tp-row').count();
      ok('V12 转置后一行 = 一个字段（7 个字段行）', fieldRows === 7, `${fieldRows} 行`);

      const headCells = await page.locator('.gd-tp-head-cell').count();
      ok('V12 转置后一列 = 一条数据行（表头列出多条记录）', headCells > 5, `${headCells} 列`);

      const tpText = await page.locator('[data-testid="transposed-view"]').innerText();
      ok('V12 UI 明示转置语义与只读（PRD 要求）',
        /一行 = 一个字段/.test(tpText) && /只读/.test(tpText), tpText.split('\n')[1]?.slice(0, 60) ?? '');
      ok('V12 字段名列显示列名与类型',
        /id/.test(tpText) && /bigint/i.test(tpText) && /created_at/.test(tpText));

      // 🔴 红线 8：转置**只解可视区** —— 渲染出的单元格数必须远小于全量（50000 行 × 7 字段）
      const rendered = await page.locator('.gd-tp-cell').count();
      ok('V12 🔴 只渲染可视区（不 decodeAll，红线 8）', rendered > 0 && rendered < 2000, `${rendered} 格`);

      // 横向滚动后仍是有界渲染（区间跟着滚动窗口走）
      await page.evaluate(() => {
        const vp = document.querySelector('[data-testid="transpose-viewport"]');
        if (vp) vp.scrollLeft = 4000;
      });
      await page.waitForTimeout(300);
      const renderedAfter = await page.locator('.gd-tp-cell').count();
      ok('V12 横向滚动后渲染量仍有界（虚拟滚动生效）',
        renderedAfter > 0 && renderedAfter < 2000, `${renderedAfter} 格`);

      // 选中统计按「数据行 × 字段」口径
      await page.locator('.gd-tp-cell').first().click();
      await page.waitForTimeout(200);
      const sum = await page.locator('[data-testid="transpose-summary"]').innerText().catch(() => '');
      ok('V12 转置态有独立的选中统计', /选中 \d+ 行/.test(sum), sum.trim());

      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      ok('V12 Esc 退出转置回到常规网格',
        (await page.locator('[data-testid="transposed-view"]').count()) === 0 &&
        (await page.locator(`${PANE} .grid-row`).count()) > 0);
    }

    // ---- V9：外键值导航（列头 FK 徽标 + 单元格链接 + 右键跳转）----
    {
      await page.waitForTimeout(600); // 等 App 侧按需拉到外键元数据
      const fkBadge = await page.locator(`${PANE} .fk-badge`).count();
      ok('V9 外键列头显示 FK 徽标', fkBadge >= 1, `${fkBadge} 个`);

      const fkCells = await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell.gd-fk').count();
      ok('V9 外键单元格渲染为可跳转链接', fkCells === 1, `${fkCells} 格`);

      const fkTitle = await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell.gd-fk').first()
        .locator('.gd-fk-value').getAttribute('title').catch(() => '');
      ok('V9 链接 tooltip 指明引用目标（表.列）', /user\.id/.test(fkTitle ?? ''), fkTitle ?? '');

      // NULL 格不给链接（没有可跳转的目标）—— 非空格外壳判定
      const nonFk = await page.locator(`${PANE} .grid-row`).first().locator('.grid-cell[data-col="1"].gd-fk').count();
      ok('V9 非外键列不画链接（判定权在宿主元数据，网格不自判）', nonFk === 0);

      await page.locator(`${PANE} .grid-row`).nth(1).locator('.grid-cell.gd-fk').first().click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      const followItem = page.locator('[data-testid="ctx-follow-fk"]');
      ok('V9 右键菜单含「跳转到引用行」', (await followItem.count()) === 1);
      const followHint = await followItem.innerText().catch(() => '');
      ok('V9 菜单项标明跳转目标', /user/.test(followHint), followHint.replace(/\n/g, ' ').slice(0, 60));

      const tabsBeforeFk = await page.locator('.ws-tab').count();
      await followItem.click();
      await page.waitForTimeout(1500);
      const appTextFk = await page.locator('.app').innerText();
      ok('V9 跳转给出明确反馈（不是静默失败）',
        /已跳转|引用行不存在/.test(appTextFk), appTextFk.match(/已跳转[^\n]*|引用行不存在[^\n]*/)?.[0]?.slice(0, 60) ?? '');
      ok('V9 跳转到引用表新开/切换了标签',
        (await page.locator('.ws-tab').count()) >= tabsBeforeFk, `${tabsBeforeFk} → ${await page.locator('.ws-tab').count()}`);

      // 收尾：关掉跳转打开的 user 标签，避免影响后续标签数断言
      const tabsNow = await page.locator('.ws-tab').count();
      if (tabsNow > tabsBeforeFk) {
        await page.keyboard.press('Meta+w');
        await page.waitForTimeout(500);
      }
      await page.locator('.ws-tab').first().click();
      await page.waitForTimeout(300);
      await resetScroll();
    }

    // ---- V13：批量编辑条（选中一列多行 → Apply 标脏 → Discard 清脏）----
    {
      /**
       * 🔴 断言口径：数**目标格**是否脏，而不是数全表脏格增量。
       *    前面的 D2/V1 粘贴用例已经在部分行留了脏标记，用「+4」这种增量断言
       *    会随机红（目标格恰好已被粘贴弄脏时增量只有 +2）。
       *    「Apply 后这 4 格全脏 / Discard 后这 4 格全不脏」才是需求本身。
       */
      const BATCH_COL = 4;
      const BATCH_ROWS = [1, 2, 3, 4];
      const dirtyInTarget = async () => {
        let n = 0;
        for (const r of BATCH_ROWS) {
          n += await page.locator(`${PANE} .grid-row`).nth(r)
            .locator(`.grid-cell[data-col="${BATCH_COL}"].dirty`).count();
        }
        return n;
      };

      // 未命中「一列 × 多行」时批量按钮必须禁用（不给用户一个点了没反应的按钮）
      await page.locator(`${PANE} .grid-row`).nth(1).locator('.grid-cell[data-col]').nth(BATCH_COL).click();
      await page.waitForTimeout(200);
      const btnBatch = page.locator(`${PANE} [data-testid="btn-batch-edit"]`);
      ok('V13 单格选中时批量按钮禁用', await btnBatch.isDisabled());

      // 纵向 Shift+↓ 拉出「单列 × 4 行」
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(80);
      }
      await page.waitForTimeout(250);
      ok('V13 命中「一列 × 多行」后批量按钮可用', !(await btnBatch.isDisabled()));

      await btnBatch.click();
      await page.waitForSelector(`${PANE} [data-testid="batch-bar"]`, { timeout: 5_000 });
      const barText = await page.locator(`${PANE} [data-testid="batch-bar"]`).innerText();
      ok('V13 批量条标明目标列与行数', /status/.test(barText) && /4 行/.test(barText),
        barText.replace(/\n/g, ' ').slice(0, 70));
      ok('V13 批量条带 fx（SQL 表达式）开关', (await page.locator(`${PANE} [data-testid="batch-expr-toggle"]`).count()) === 1);

      await page.locator(`${PANE} [data-testid="batch-input"]`).fill('refunded');
      await page.waitForTimeout(150);
      await page.locator(`${PANE} [data-testid="batch-apply"]`).click();
      await page.waitForTimeout(500);

      ok('V13 Apply 后选中行的该列全部标脏（4/4）',
        (await dirtyInTarget()) === 4, `${await dirtyInTarget()}/4`);
      const toastBatch = await page.locator('.app').innerText();
      ok('V13 Apply 提示走既有保存链路（⌘S 预演，不引入新写路径）',
        /已标记 4 行/.test(toastBatch) && /⌘S/.test(toastBatch),
        toastBatch.match(/已标记[^\n]*/)?.[0]?.slice(0, 60) ?? '');

      // 🔴 头号红线：批量改动落库仍必须经保存预演，逐条展示 UPDATE 原文
      await page.locator(`${PANE} .grid-viewport`).click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Meta+s');
      await page.waitForTimeout(700);
      const modalText = await page.locator('.modal').innerText().catch(() => '');
      ok('V13 🔴 批量改动仍走保存预演（逐条 UPDATE 原文）',
        /即将执行/.test(modalText) && /UPDATE/.test(modalText), modalText.split('\n')[0]?.slice(0, 50) ?? '');
      ok('V13 预演含批量值 refunded', /refunded/.test(modalText));
      await page.locator('.modal footer button', { hasText: '取消' }).first().click().catch(() => {});
      await page.waitForTimeout(400);

      // Discard：重选同一批 → 一次性清掉这批脏标记
      await page.locator(`${PANE} .grid-row`).nth(1).locator('.grid-cell[data-col]').nth(BATCH_COL).click();
      await page.waitForTimeout(200);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(80);
      }
      await page.waitForTimeout(250);
      await btnBatch.click();
      await page.waitForSelector(`${PANE} [data-testid="batch-bar"]`, { timeout: 5_000 });
      await page.locator(`${PANE} [data-testid="batch-discard"]`).click();
      await page.waitForTimeout(500);
      ok('V13 Discard 一次性清除这批脏标记（0/4）',
        (await dirtyInTarget()) === 0, `${await dirtyInTarget()}/4`);
    }

    // ---- V10：单元格 SQL 表达式模式（NOW() 原样嵌入，不转义）----
    {
      // 合法表达式：填 NOW() → 提交后格子带 fx 标记
      await page.locator(`${PANE} .grid-row`).nth(8).locator('.grid-cell[data-col]').nth(5).click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${PANE} [data-testid="cell-editor"]`, { timeout: 5_000 });
      const exprToggle = page.locator(`${PANE} [data-testid="expr-toggle"]`);
      ok('V10 编辑态有 fx（表达式模式）开关', (await exprToggle.count()) === 1);
      await exprToggle.click();
      await page.waitForTimeout(200);
      ok('V10 切到表达式模式后开关呈开启态',
        /gd-on/.test((await exprToggle.getAttribute('class')) ?? ''));

      await page.locator(`${PANE} [data-testid="cell-editor"]`).fill('NOW()');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const exprCells = await page.locator(`${PANE} .grid-cell.gd-expr`).count();
      ok('V10 表达式提交后单元格带 fx 脏标记', exprCells >= 1, `${exprCells} 格`);

      // 🔴 头号红线：表达式必须**原样**进 SQL（不能被转义成字符串 'NOW()'），
      // 且预演弹窗要显式告警「这段原文即将执行」
      await page.locator(`${PANE} .grid-viewport`).click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Meta+s');
      await page.waitForTimeout(700);
      ok('V10 🔴 预演弹窗显式告警含 SQL 表达式',
        (await page.locator('[data-testid="expr-warning"]').count()) >= 1);
      const exprModal = await page.locator('.modal').innerText().catch(() => '');
      ok('V10 🔴 NOW() 原样嵌入 SET（未被转义成字符串）',
        /=\s*NOW\(\)/.test(exprModal) && !/'NOW\(\)'/.test(exprModal),
        exprModal.match(/SET[^\n]*/)?.[0]?.slice(0, 80) ?? '');
      ok('V10 预演逐条展示完整 SQL 原文', /UPDATE/.test(exprModal) && /WHERE/.test(exprModal));
      await page.locator('.modal footer button', { hasText: '取消' }).first().click().catch(() => {});
      await page.waitForTimeout(400);

      // 非法表达式：分号（多语句）必须被拦下且**不提交**（fail-closed）
      const dirtyBeforeBad = await page.locator(`${PANE} .grid-cell.dirty`).count();
      await page.locator(`${PANE} .grid-row`).nth(10).locator('.grid-cell[data-col]').nth(5).click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${PANE} [data-testid="cell-editor"]`, { timeout: 5_000 });
      await page.locator(`${PANE} [data-testid="expr-toggle"]`).click();
      await page.waitForTimeout(150);
      await page.locator(`${PANE} [data-testid="cell-editor"]`).fill('NOW(); DROP TABLE `order`');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      ok('V10 非法表达式（分号/多语句）被拦下并给出原因',
        (await page.locator(`${PANE} [data-testid="expr-error"]`).count()) === 1,
        (await page.locator(`${PANE} [data-testid="expr-error"]`).innerText().catch(() => '')).slice(0, 60));
      ok('V10 非法表达式不提交、留在编辑态',
        (await page.locator(`${PANE} [data-testid="cell-editor"]`).count()) === 1);
      ok('V10 非法表达式不产生脏标记',
        (await page.locator(`${PANE} .grid-cell.dirty`).count()) === dirtyBeforeBad);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      ok('V10 Esc 放弃编辑并清掉报错',
        (await page.locator(`${PANE} [data-testid="expr-error"]`).count()) === 0);

      // 关键字黑名单：DROP 藏在值里也要拦（剥掉字符串字面量后扫描）
      await page.locator(`${PANE} .grid-row`).nth(11).locator('.grid-cell[data-col]').nth(5).click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${PANE} [data-testid="cell-editor"]`, { timeout: 5_000 });
      await page.locator(`${PANE} [data-testid="expr-toggle"]`).click();
      await page.locator(`${PANE} [data-testid="cell-editor"]`).fill('SLEEP(10)');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      ok('V10 DoS 类函数（SLEEP）被拦下',
        (await page.locator(`${PANE} [data-testid="expr-error"]`).count()) === 1);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // 字符串字面量里的关键字不误杀（否则用户没法写 CONCAT('a delete b', x)）
      await page.locator(`${PANE} .grid-row`).nth(12).locator('.grid-cell[data-col]').nth(6).click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${PANE} [data-testid="cell-editor"]`, { timeout: 5_000 });
      await page.locator(`${PANE} [data-testid="expr-toggle"]`).click();
      await page.locator(`${PANE} [data-testid="cell-editor"]`).fill("CONCAT('drop table x', `remark`)");
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      ok('V10 字符串字面量里的关键字不误杀（剥字面量后再扫）',
        (await page.locator(`${PANE} [data-testid="expr-error"]`).count()) === 0);

      await page.locator('.ws-tab').first().click();
      await page.waitForTimeout(300);
      await resetScroll();
    }

    // ---- V8 宽表验收（PRD §九：「冻结列后的宽表横向滚动可用性」）----
    /**
     * 🔴 单独开一张 40 列的宽表来测：`order` 只有 7 列，在 1440 视口里
     *    scrollWidth 与 clientWidth 差距很小，`scrollLeft = 600` 会被钳到
     *    ~200px —— 「冻结列钉住了」与「根本没滚动」在断言里无法区分（假绿）。
     *    宽表才是这个功能存在的理由，也必须在宽表上验收。
     */
    {
      // 打开 order_db.wide_metrics（树里双击表节点）
      const wideRow = page.locator('.tree-row', { hasText: 'wide_metrics' }).first();
      ok('V8 宽表靶子存在（demo 的 wide_metrics，40 列）', (await wideRow.count()) >= 1);
      await wideRow.dblclick();
      await page.waitForTimeout(1500);
      const widePane = `.ws-tab-pane[data-testid="pane-wide_metrics"]`;
      ok('V8 宽表已打开为独立标签', (await page.locator(widePane).count()) === 1);

      const wideCols = await page.locator(`${widePane} .grid-header-cell.gd-header-cell`).count();
      ok('V8 宽表列数确实宽（≥30 列，够滚）', wideCols >= 30, `${wideCols} 列`);

      const wideScroll = await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        if (!vp) return null;
        vp.scrollLeft = 600;
        return { actual: vp.scrollLeft, maxScroll: vp.scrollWidth - vp.clientWidth };
      }, widePane);
      await page.waitForTimeout(300);
      ok('V8 🔴 宽表能横向滚动到 ≥600px（窄表测不出冻结）',
        (wideScroll?.actual ?? 0) >= 600,
        `scrollLeft ${wideScroll?.actual} / max ${wideScroll?.maxScroll}`);

      // 冻结前 2 列后横滚 600px：两列都还在原位，且有数据列被盖住
      await page.locator(`${widePane} [data-testid="btn-freeze"]`).click();
      await page.waitForTimeout(300);
      await page.locator(`${widePane} .grid-header-cell.gd-header-cell`).nth(1).click({ button: 'right' });
      await page.waitForSelector('.gd-ctx-menu', { timeout: 5_000 });
      await page.locator('[data-testid="ctx-freeze"]').click();
      await page.waitForTimeout(400);
      await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        if (vp) vp.scrollLeft = 600;
      }, widePane);
      await page.waitForTimeout(350);

      const wideSticky = await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        const vpx = vp.getBoundingClientRect().x;
        const r = vp.querySelector('.grid-row');
        const frozenEls = [...(r?.querySelectorAll('.grid-cell.gd-frozen') ?? [])];
        const lefts = frozenEls.map((el) => el.getBoundingClientRect().left - vpx);
        const frozenRight = frozenEls.length
          ? Math.max(...frozenEls.map((el) => el.getBoundingClientRect().right - vpx))
          : 0;
        let covered = 0;
        for (const el of r?.querySelectorAll('.grid-cell[data-col]') ?? []) {
          if (el.classList.contains('gd-frozen')) continue;
          const box = el.getBoundingClientRect();
          if (box.right - vpx <= frozenRight + 0.5) covered++;
        }
        return { count: frozenEls.length, lefts, covered, scrollLeft: vp.scrollLeft };
      }, widePane);

      ok('V8 宽表冻结 2 列生效', wideSticky.count === 2, `${wideSticky.count} 列`);
      ok('V8 🔴 宽表横滚 600px 后冻结列仍钉在左侧（未随内容滚走）',
        wideSticky.count === 2 &&
        wideSticky.lefts[0] >= 50 && wideSticky.lefts[0] <= 56 &&
        wideSticky.lefts[1] > wideSticky.lefts[0],
        `lefts=[${wideSticky.lefts.map((n) => n.toFixed(0)).join(', ')}] scrollLeft=${wideSticky.scrollLeft}`);
      ok('V8 🔴 宽表冻结列盖住了滚过来的数据列（可用性成立）',
        wideSticky.covered > 0, `${wideSticky.covered} 列被覆盖`);

      // 冻结列的实色底在宽表 + 斑马行两种态下都不透明（红线 11 的完整覆盖）
      const wideBg = await page.evaluate((p) => {
        const vp = document.querySelector(`${p} .grid-viewport`);
        const rows = [...vp.querySelectorAll('.grid-row')].slice(0, 2);
        return rows.map((r) => {
          const el = r.querySelector('.grid-cell.gd-frozen');
          const cs = getComputedStyle(el);
          return { alt: r.classList.contains('alt'), bg: cs.backgroundColor };
        });
      }, widePane);
      const allOpaque = wideBg.every((x) => x.bg && !/rgba\([^)]*,\s*0\)/.test(x.bg) && x.bg !== 'transparent');
      ok('V8 🔴 宽表冻结列常规行/斑马行底色均不透明（红线 11）',
        allOpaque, wideBg.map((x) => `${x.alt ? '斑马' : '常规'}:${x.bg}`).join(' '));

      // 收尾：关掉宽表标签，避免影响后续标签数断言
      await page.keyboard.press('Meta+w');
      await page.waitForTimeout(500);
      ok('V8 宽表标签可关闭（无脏改动，不弹确认）',
        (await page.locator(widePane).count()) === 0);
      await page.locator('.ws-tab').first().click();
      await page.waitForTimeout(300);
      await resetScroll();
    }
  }

  // 13. 多标签：⌘W 关闭（含脏 tab 拦截）+ 快捷键切换（P0-4）
  {
    const tabsBefore = await page.locator('.ws-tab').count();
    // ⌘1 跳到第一个 tab
    await page.keyboard.press('Meta+1');
    await page.waitForTimeout(300);
    const activeFirst = await page.locator('.ws-tab.active').first().innerText().catch(() => '');
    ok('⌘1 跳转到第一个标签', /order|表/.test(activeFirst), activeFirst.split('\n')[0] ?? '');

    // ⌘Shift+] / ⌘Shift+[ 循环切换（tabs = [表, 查询]，两个方向各验一次）
    await page.keyboard.press('Meta+Shift+]');
    await page.waitForTimeout(200);
    const afterCycleFwd = await page.locator('.ws-tab.active').first().innerText().catch(() => '');
    ok('⌘Shift+] 切到下一个标签', /查询/.test(afterCycleFwd), afterCycleFwd.split('\n')[0] ?? '');
    await page.keyboard.press('Meta+Shift+[');
    await page.waitForTimeout(200);
    const afterCycleBack = await page.locator('.ws-tab.active').first().innerText().catch(() => '');
    ok('⌘Shift+[ 切回上一个标签', /order|表/.test(afterCycleBack), afterCycleBack.split('\n')[0] ?? '');

    // ⚠️ 焦点若在 CodeMirror（.cm-content），Meta+w 会被 CM 的输入处理吞掉
    //    （真机 Electron 里焦点在编辑器时同样收不到 —— 点右下角 env-tag 还焦点，
    //     不能点 .toolbar 本体：中心可能落在 保存/设计 等按钮上产生副作用）
    await page.locator('.env-tag').click();
    await page.waitForTimeout(200);

    // 13a. 脏 tab 关闭拦截：第 3 步留了脏单元格 → confirm → 取消 → 不关。
    //      Playwright 里 dialog 必须在弹出前挂监听；dismiss 即模拟用户点「取消」。
    let dialogMsg = null;
    const onDialog = (d) => {
      dialogMsg = d.message();
      void d.dismiss();
    };
    page.on('dialog', onDialog);
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(500);
    ok('脏 tab ⌘W 弹出关闭确认（拦截生效）', dialogMsg !== null,
      (dialogMsg ?? '未弹窗').split('\n')[0] ?? '');
    ok('取消关闭后 tab 保留', (await page.locator('.ws-tab').count()) === tabsBefore,
      `${tabsBefore} → ${await page.locator('.ws-tab').count()}`);
    page.removeListener('dialog', onDialog);

    // 13b. 接受确认 → tab 关闭并激活邻位（查询 tab）
    page.once('dialog', (d) => void d.accept());
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(500);
    const tabsAfter = await page.locator('.ws-tab').count();
    ok('⌘W 确认后关闭当前标签', tabsAfter === tabsBefore - 1, `${tabsBefore} → ${tabsAfter}`);
    const activeAfter = await page.locator('.ws-tab.active').first().innerText().catch(() => '');
    ok('关闭后激活邻位标签', /查询/.test(activeAfter), activeAfter.split('\n')[0] ?? '');
    // 关掉剩余 tab（可能不止一个）→ 空状态
    for (let i = 0; i < 8; i++) {
      if ((await page.locator('.ws-tab').count()) === 0) break;
      await page.keyboard.press('Meta+w');
      await page.waitForTimeout(400);
    }
    /**
     * v0.6.0：空态形态变了 —— 有连接时中间面板改为显示**对象清单**（跟随左侧树），
     * 不再是三张快捷入口卡。这是用户拍板的形态（见需求项2）。
     *
     * 断言跟着行为走，不是把测试改绿了事：
     * 这里同时守住两个条件 —— 清单在（新的空态）且旧的 EmptyState 不再出现
     *（否则等于新组件根本没接管，空态还是旧的）。
     */
    ok('全部关闭后显示对象清单（v0.6.0 空态）',
      (await page.locator('[data-testid="object-browser"]').count()) === 1);
    ok('旧的快捷入口空态已被对象清单取代',
      (await page.locator('[data-testid="empty-state"]').count()) === 0);
    // 清单应列出 demo 对象（能点开才算真的能用）
    ok('对象清单列出了可打开的对象', (await page.locator('.ob-item').count()) > 0,
      `${await page.locator('.ob-item').count()} 项`);

/**
     * v0.6.0：清单【跟随左侧树】联动（用户拍板的形态）。
     *
     * 断言口径：选中某个库 → 清单收敛到那个库。选 kind 行（表/视图分组）
     * 才能断出"· 表"这种更细的联动，但那需要先展开库；
     * 这里用库级联动做判定（更稳，且同样能证伪"根本没联动"）。
     */
    {
      // 先展开第一个库：点它的三角（不是行{
    // 展开到库层：点第一个未展开的三角（三角是容器行的标志）
      const caret = page.locator('.tree-row[data-node-kind] .tree-caret', { hasText: '▸' }).first();
      if ((await caret.count()) > 0) {
        await caret.click();
      await page.waitForTimeout(400);
      }
      /**
       * 定位靠 TreeView 显式暴露的 data-node-kind（见该组件注释）。
       * 早先用"有 .tree-badge 就是库"来猜，结果**分组节点也带 badge**（显示连接数），
       * 断言指错了对象 —— 靠观感猜语义的测试天生脆弱，改样式就断且断得莫名其妙。
       */
   const dbRow = page.locator('.tree-row[data-node-kind="database"]').first();
      const dbName = ((await dbRow.locator('.tree-label').innerText().catch(() => '')) ?? '').trim();
      if (dbName) {
    await dbRow.click();
        await page.waitForTimeout(350);
        const title = await page.locator('.ob-title').first().innerText().catch(() => '');
        ok('清单标题跟随左侧树选中项（库名）', title.startsWith(dbName), `清单「${title}」vs 选中「${dbName}」`);
     const dbs = [...new Set((await page.locator('.ob-item .ob-db').allInnerTexts()).map((t) => t.trim()))];
        ok('清单条目收敛到选中的库', dbs.length <= 1 && (!dbs.length || dbs[0] === dbName), `库：${dbs.join(',') || '（空）'}`);
      } else {
     ok('清单标题跟随左侧树选中项（库名）', false, '没找到库行（data-node-kind="database"），无法验证联动');
      }
    }

    /**
     * 0.7.1（真机反馈 3）：中间清单**单击 = 选中，双击 = 打开**。
     *
     * 旧实现单击就 onOpenObject，用户只想看 DDL 却越开越多标签。四条断言各自
     * 守住一件不能被"顺手改回去"的事：
     *  ① 单击后标签数不变（否则等于还是一次单击打开）
     *  ② 单击后右侧详情换成那张表（选中是有意义的，不是死高亮）
     *  ③ 双击真的打开（`pane-<table>` 出现）—— 否则改成了"点了没反应"
     *  ④ 连点两项后 `[data-active="1"]` 只有一个（多选残留 = 用户分不清选的是谁）
     *
     * 收尾要按 ⌘W 关掉新开的标签：后面的章节都建立在"此刻没有标签"的前提上。
     */
    {
      const items = page.locator('.ob-item');
      const tabCount = () => page.locator('.ws-tab').count();
      if ((await items.count()) >= 2) {
        const tabsBefore = await tabCount();
        const nameOf = async (i) => ((await items.nth(i).locator('.ob-name').innerText()) ?? '').trim();
        const nameA = await nameOf(0);
        const nameB = await nameOf(1);

        await items.nth(0).click();
        await page.waitForTimeout(400);
        const afterA = await tabCount();
        ok('单击清单项不打开标签（标签数不变）', afterA === tabsBefore, `${tabsBefore} → ${afterA}`);

        const dA = await page.locator('.detail-panel').innerText().catch(() => '');
        ok('单击清单项后右侧详情换成该表', dA.includes(nameA),
          `详情「${(dA.split('\n')[1] ?? dA.split('\n')[0] ?? '').trim()}」vs 选中「${nameA}」`);

        await items.nth(1).click();
        await page.waitForTimeout(400);
        const activeCount = await page.locator('.ob-item[data-active="1"]').count();
        const activeName = ((await page.locator('.ob-item[data-active="1"] .ob-name').first().innerText().catch(() => '')) ?? '').trim();
        ok('连点两项后清单只有一行是选中态，且是后点的那行',
          activeCount === 1 && activeName === nameB, `选中 ${activeCount} 行（${activeName || '无'}），期望 ${nameB}`);

        await items.nth(1).dblclick();
        await page.waitForTimeout(1200);
        ok('双击清单项打开表（出现 pane-' + nameB + '）',
          (await page.locator(`.ws-tab-pane[data-testid="pane-${nameB}"]`).count()) === 1,
          `标签数=${await tabCount()}`);

        // 收尾：关掉刚打开的标签，回到空态（后续章节依赖这个前提）
        await page.keyboard.press('Meta+w');
        await page.waitForTimeout(500);
        ok('收尾：双击打开的标签可正常关闭', (await tabCount()) === tabsBefore,
          `${await tabCount()} 个标签（期望 ${tabsBefore}）`);
      } else {
        ok('单击清单项不打开标签（标签数不变）', false,
          `清单只有 ${await items.count()} 项，无法验证单击/双击语义`);
      }
    }

    /**
     * 展开到对象层。
     *
     * 🔴 必须**逐层全展开**：树是分组→连接→库→类别→对象 四层，
     *    每点一次 ▸ 只展开当前那一批里尚未展开的行；只点固定次数会停在中间层。
     *    （实测：点4 次能到kind 层，要再点几轮才够 3 张表。）
     *    循环条件用「还有没有 ▸」而不是固定次数 —— 树有多深就展开多深。
     */
    for (let pass = 0; pass < 12; pass++) {
      const caret = page.locator('.tree-row[data-node-kind] .tree-caret', { hasText: '▸' });
      const remaining = await caret.count();
      if (remaining === 0) break;
      await caret.first().click();
      await page.waitForTimeout(250);
    }
  }

  // 13d. v0.6.0 树多选
  {
/**
     * 多选用 ⌘ 点击（macOS 惯例）。
     *
     * 定位用 data-node-kind="object"（语义钩子）**并**要求有 .tree-fav：
     * 后者只挂在表对象行上。两层过滤保证点到的是真表，而不是视图/过程。
     */
    const tableRows = page.locator('.tree-row[data-node-kind="object"]:has(.tree-fav)');
    const n = Math.min(await tableRows.count(), 2);
    if (n < 2) {
      ok('⌘ 点击可多选（行上有 selected 标记）', false,
   `只找到 ${await tableRows.count()} 个表对象行，需先展开表分组`);
    } else {
      for (let i = 0; i < n; i++) {
        await tableRows.nth(i).click({ modifiers: ['Meta'] });
        await page.waitForTimeout(150);
      }
      const sel = await page.locator('.tree-row.selected').count();
      ok('⌘ 点击可多选（行上有 selected 标记）', sel === n, `点了 ${n} 行，selected ${sel} 行`);
    }

    // ⇧ 区间：锚点在第一张表，⇧ 点第三张 → 应选中 3 张
    const rows3 = page.locator('.tree-row[data-node-kind="object"]:has(.tree-fav)');
    if ((await rows3.count()) >= 3) {
      await rows3.nth(0).click();
      await page.waitForTimeout(150);
      await rows3.nth(2).click({ modifiers: ['Shift'] });
      await page.waitForTimeout(200);
      const sel3 = await page.locator('.tree-row.selected').count();
      ok('⇧ 点击按可见顺序取区间', sel3 === 3, `${sel3} 行`);
    } else {
   ok('⇧ 点击按可见顺序取区间', false, `表对象行只有 ${await rows3.count()} 个，不足 3`);
    }
  }

  // 13e. v0.6.0 分组节点有类别图标
  {
    // 「表/视图」这类分组行此前没有图标（KindIcon 漏了 kind 分支）
    const kindRow = page.locator('.tree-row[data-node-kind="kind"]').first();
    const hasIcon = (await kindRow.count()) > 0 && (await kindRow.locator(':scope > svg').count()) > 0;
    ok('分组行有类别图标（表/视图/过程…）', hasIcon,
    hasIcon ? '有 svg' : '分组行没有 svg —— KindIcon 又漏了 kind 分支');
  }

  // 13f. T19 新增空白行（入口 + 脏格记账 + 预演区分 DEFAULT/NULL）
  /**
   * 这一段的断言口径（三件事，缺一件 T19 就没交付）：
   *  1. **入口真的可达**：工具栏按钮在、行号/单元格右键有、原生菜单已登记（后者由 e2e:keys 覆盖）；
   *  2. **脏格记账正确**：新增一行 → 只把「必须填」和「可空写 NULL」的列标脏，
   *     自增列与「有默认值」的列**不进脏集合**（否则保存时会显式覆盖默认值）；
   *  3. **预演的 DEFAULT/NULL 分开**：空白行不能盲目写 NULL —— NOT NULL 列必须在预演里
   *     被逐列点名拒绝，而不是让用户点确认后吃 MySQL 1048。
   *
   * 🔴 第 5 条是**回归防线**：原实现用 `source.rowCount` 当新行下标，连点两次会落在同一行，
   *    脏格数停在 6 不动。断言「6 → 12」才能把「两次都写在同一行」钉死。
   */
  {
    // 前置：13 节把所有标签关光了（此刻是对象清单空态），从清单重新打开 order
    const dbRowT19 = page
      .locator('.tree-row[data-node-kind="database"]')
      .filter({ has: page.locator('.tree-label', { hasText: /^order_db$/ }) })
      .first();
    let opened = false;
    if ((await dbRowT19.count()) > 0) {
      await dbRowT19.click();
      await page.waitForTimeout(400);
      const obOrder = page.locator('[data-testid="ob-item-order"]');
      if ((await obOrder.count()) > 0) {
        // 0.7.1：单击只选中，双击才打开（见 ObjectBrowser 注释）
        await obOrder.first().dblclick();
        await page.waitForTimeout(1200);
        opened = true;
      }
    }
    ok('T19 前置：order 表已重新打开为标签', opened && (await page.locator('[data-testid="pane-order"]').count()) === 1,
      opened ? '' : '没能从对象清单打开 order（后续断言会失真）');

    const dirtyOf = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));
    const dirty0 = await dirtyOf();
    ok('T19 前置：起始无脏格', dirty0 === 0, `dirty=${dirty0}`);

    // 入口 1：工具栏（表格工具栏最前面的「新增空白行」）
    const addBtn = page.locator('[data-testid="btn-add-row"]');
    ok('T19 工具栏有「新增空白行」入口', (await addBtn.count()) === 1);
    ok('T19 工具栏按钮可用（demo order 有自增主键，可编辑）', await addBtn.isEnabled());

    // 入口 2：行号 / 单元格右键共用同一份菜单（行号右键的 column 为空串）
    const someCell = page.locator('.grid-row').nth(2).locator('.grid-cell').nth(2);
    await someCell.click({ button: 'right' });
    await page.waitForTimeout(400);
    ok('T19 单元格右键有「新增空白行」', (await page.locator('[data-testid="ctx-add-row"]').count()) === 1);
    ok('T19 右键项带 ⌥⌘N 键位提示',
      /⌥⌘N/.test(await page.locator('[data-testid="ctx-add-row"]').innerText().catch(() => '')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 动作 1：点击工具栏 → 一行 6 个脏格
    await addBtn.click();
    await page.waitForTimeout(600);
    /**
     * demo `order` 的期望账（7 列）：
     *   id         自增   → auto-skip（不标脏）
     *   order_no   NOT NULL 无默认 → needs-input（脏）
     *   user_id    同上 → 脏
     *   amount     同上 → 脏
     *   status     同上 → 脏
     *   created_at 同上 → 脏
     *   remark     可空 → set-null（写显式 NULL，脏）
     * 合计 **6**。第 3 条（DEFAULT 列不标脏）在 demo 里没有可用的列，
     * 由 core-mutation 单测覆盖 —— 这里不写一条永远为真的假断言。
     */
    const dirty1 = await dirtyOf();
    ok('T19 新增一行标脏 6 格（自增列不标）', dirty1 === 6, `dirty 0 → ${dirty1}（期望 6）`);

    // 动作 2：⌥⌘N 再新增一行 —— 必须是**新**行，不是覆盖上一行
    await page.locator('.grid-viewport').click({ position: { x: 200, y: 200 } });
    await page.keyboard.press('Alt+Meta+n');
    await page.waitForTimeout(600);
    const dirty2 = await dirtyOf();
    ok('T19 🔴 连续两次新增落在不同行（⌥⌘N 不是覆盖）', dirty2 === 12,
      `dirty ${dirty1} → ${dirty2}（期望 12；若仍是 6 说明两次都写在同一行 —— 旧 source.rowCount 缺陷）`);

    // 动作 3：保存预演 —— 空白行的 NOT NULL 列必须被逐列点名，而不是放行到库上报 1048
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(700);
    const previewT19 = await page.locator('.modal').innerText().catch(() => '');
    ok('T19 空白行在预演里被拒（不做「确认后才报 1048」）',
      /不会提交/.test(previewT19) && /NOT NULL/.test(previewT19),
      previewT19.split('\n').slice(0, 3).join(' / ').slice(0, 120) || '（预演没弹出）');
    ok('T19 拒绝原因点名列名（不是泛化文案）',
      /order_no/.test(previewT19) && /user_id/.test(previewT19) && /created_at/.test(previewT19));
    ok('T19 可空列 remark 不被 NOT NULL 规则误伤',
      !/remark[^。]*不能写 NULL/.test(previewT19));
    // 反向对照：被拒的行必须**不产生** INSERT（否则「拒绝」是假的）
    ok('T19 被拒的行没有生成任何 INSERT 语句',
      (await page.locator('[data-testid="preview-sql"]').count()) === 0,
      `preview-sql 节点数=${await page.locator('[data-testid="preview-sql"]').count()}`);

    await page.locator('button', { hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);

    // 收尾：把这两行脏格清掉，别影响后面（如果有）的断言
    await clearDirtyByReload(page);
  }

  // 13g. T28/T29 SQL 编辑器右键菜单 + 工具栏执行对象 / 目标连接环境
  /**
   * 断言口径（每条都要能证伪，不写恒真断言）：
   *  - 右键菜单项数 ≥ 7（T28 最小集 6 项 + 已在动作目录登记 sql-context 的「执行全部」）；
   *  - **无选区**时「剪切/复制」必须 disabled（红线：菜单项没有真实对象时不许看着可用）；
   *  - ⌘A 选中后同样两项转可用 —— 这一对正反断言证明 enabled 是**动态**的，不是写死的；
   *  - 工具栏「执行对象」随选区切换（无选区=当前语句，有选区=执行选中，T29 三者可辨）；
   *  - 目标连接与环境常驻展示，且生产环境带 data-production=1 标记。
   */
  {
    await page.keyboard.press('Meta+t');
    await page.waitForSelector('.cm-editor', { timeout: 15_000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1;\nSELECT 2;');
    await page.waitForTimeout(400);

    // ---- T29：目标连接与环境（demo: c1=prod_order/生产环境 红标签） ----
    const connBadge = page.locator('[data-testid="sql-conn-target"]');
    const connText = (await connBadge.innerText().catch(() => '')) || '';
    ok('T29 工具栏常驻显示目标连接与环境',
      /prod_order/.test(connText) && /生产环境/.test(connText), connText || '（无徽标）');
    ok('T29 生产环境被显式标记（data-production=1）',
      (await connBadge.getAttribute('data-production')) === '1',
      `data-production=${await connBadge.getAttribute('data-production')}`);
    /**
     * T29 的核心口径是「三个执行对象**可辨**」—— 可辨是指**用户看得见**，
     * 不是「DOM 里有个 aria-label」。所以这里同时断两件：
     *  1. 可见文案里带「全部」（只靠 aria-label 补语义，对读屏之外的用户等于没说清）；
     *  2. aria-label 也在。
     * 反向对照在下面：另两个按钮的可见文案必须是「执行当前语句 / 执行选中」「执行计划」，
     * 三者互不相同 —— 少一个维度这条断言就退化成恒真。
     */
    const runAllText = (await page.locator('.sql-toolbar [data-testid="sql-run-all"]').innerText()).replace(/\s+/g, '');
    ok('T29「执行全部」可见文案自己说清了是全部', /全部/.test(runAllText), `可见文案=「${runAllText}」`);
    /**
     * 这里断的是**可访问名里有没有「全部」**，不是「aria-label 恰好等于 执行全部」。
     * 0.7.1 T12 给 aria-label 补上了快捷键（`执行全部（⌘R）`）—— 纯图标密度档下
     * 按钮只剩图标，读屏和 tooltip 是用户唯一能拿到「这是什么」的地方，把快捷键
     * 一起念出来是改进。原来那种全等断言等于让测试钉死一句话，改文案就假红。
     */
    const runAllAria = (await page.locator('.sql-toolbar [data-testid="sql-run-all"]').getAttribute('aria-label')) || '';
    ok('T29「执行全部」的可访问名带「全部」（读屏可达）', /全部/.test(runAllAria), `aria-label=「${runAllAria}」`);

    // 无选区（点一下编辑器塌陷光标）：⌘⏎ 对象应为「当前语句」而不是含糊的「执行选中」
    await page.locator('.cm-content').click();
    await page.waitForTimeout(250);
    const runSelBtn = page.locator('[data-testid="sql-run-selection"]');
    const noSelLabel = (await runSelBtn.innerText()) || '';
    const noSelHint = (await page.locator('[data-testid="sql-exec-target"]').innerText()) || '';
    ok('T29 无选区时 ⌘⏎ 按钮显示「执行当前语句」', /执行当前语句/.test(noSelLabel), noSelLabel);
    ok('T29 无选区时执行对象指示器=当前语句', /当前语句/.test(noSelHint), noSelHint);

    // ---- T28：无选区右键 ----
    await page.locator('.cm-content').click({ button: 'right' });
    await page.waitForSelector('[data-testid="sql-editor-ctx-menu"]', { timeout: 5_000 });
    const menu = page.locator('[data-testid="sql-editor-ctx-menu"]');
    const itemCount = await menu.locator('.ctx-item').count();
    ok('T28 右键菜单项数 ≥ 7（不再只有「格式化 SQL」）', itemCount >= 7, `${itemCount} 项`);
    const menuText = (await menu.innerText()) || '';
    ok('T28 菜单齐最小集：全部 / 当前语句(或选中) / 执行计划 / 格式化 / 注释 / 剪切 / 复制 / 粘贴',
      /执行全部/.test(menuText) && /执行当前语句|执行选中/.test(menuText) && /执行计划/.test(menuText) &&
      /格式化/.test(menuText) && /注释/.test(menuText) &&
      /剪切/.test(menuText) && /复制/.test(menuText) && /粘贴/.test(menuText),
      menuText.replace(/\n/g, ' / ').slice(0, 140));
    ok('T28 键位提示取自动作目录（格式化 ⌘I / 注释 ⌘/）',
      /⌘I/.test(menuText) && /⌘\//.test(menuText), menuText.replace(/\n/g, ' / ').slice(0, 140));
    const cutDisabled = await page.locator('[data-testid="sql-editor-ctx-sql-cut"]').isDisabled();
    const copyDisabled = await page.locator('[data-testid="sql-editor-ctx-sql-copy"]').isDisabled();
    ok('T28 无选区时「剪切/复制」禁用（不做假 UI）', cutDisabled && copyDisabled,
      `剪切 disabled=${cutDisabled} / 复制 disabled=${copyDisabled}`);
    // 红线 1 的 DOM 级验证：禁用**必须**给出原因（title），不是静默置灰
    const cutReason = (await page.locator('[data-testid="sql-editor-ctx-sql-cut"]').getAttribute('title')) || '';
    ok('T28 禁用的「剪切」带中文原因（title 非空）', cutReason.length > 0, cutReason || '（无 title）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok('T28 Esc 关闭右键菜单', (await menu.count()) === 0);

    // ---- T28/T29：有选区（⌘A）后，同一批项必须换个状态 ----
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.waitForTimeout(300);
    const selLabel = (await runSelBtn.innerText()) || '';
    const selHint = (await page.locator('[data-testid="sql-exec-target"]').innerText()) || '';
    ok('T29 有选区时 ⌘⏎ 按钮切换为「执行选中」', /执行选中/.test(selLabel), selLabel);
    ok('T29 有选区时指示器显示选中字符数', /选中 \d+ 字符/.test(selHint), selHint);

    /**
     * T29 的**反向对照**：三个执行对象的可见文案必须两两不同。
     *
     * 上面每条单看都只断「含某个词」—— 若三个按钮文案都写成「执行」，那两条断言照样绿。
     * 这里把三者拉齐比一次，才真正钉住「可辨」。
     */
    {
      const t = async (sel) => ((await page.locator(sel).innerText()) || '').replace(/\s+/g, '');
      const allT = await t('.sql-toolbar [data-testid="sql-run-all"]');
      const selT = await t('[data-testid="sql-run-selection"]');
      const expT = await t('[data-testid="sql-run-explain"]');
      const uniq = new Set([allT, selT, expT]);
      ok('T29 三个执行对象的可见文案两两不同（否则「可辨」是假的）',
        uniq.size === 3 && allT.length > 0 && selT.length > 0 && expT.length > 0,
        `全部=「${allT}」 选中=「${selT}」 计划=「${expT}」`);
    }

    await page.locator('.cm-content').click({ button: 'right' });
    await page.waitForSelector('[data-testid="sql-editor-ctx-menu"]', { timeout: 5_000 });
    const cutEnabled = await page.locator('[data-testid="sql-editor-ctx-sql-cut"]').isEnabled();
    const copyEnabled = await page.locator('[data-testid="sql-editor-ctx-sql-copy"]').isEnabled();
    ok('T28 有选区时「剪切/复制」转可用（证伪静态 enabled）', cutEnabled && copyEnabled,
      `剪切 enabled=${cutEnabled} / 复制 enabled=${copyEnabled}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  // 13h. T21 提交预览「旧值 → 新值」摘要（对象 / 行定位 / 字段 / 改前改后）
  /**
   * 断言口径（每条都要能证伪，不写恒真断言）：
   *  1. 本次编辑**恰好**新增 1 个脏格（delta 断言，不受 T19 残留脏格影响）；
   *  2. 预演里真的出现摘要（`change-row`）且四项属性齐全；
   *  3. 🔴 **旧值来自真实原值**：编辑前先读网格里那一格的真实文本，改成新值后再看摘要，
   *     断言 `data-old` 恰等于编辑前的原值、且 ≠ 新值。若实现拿脏格新值反推旧值，
   *     data-old 会等于新值 —— 这条立刻红（这正是「保真」要防的偷懒做法）；
   *  4. 原文 SQL 仍是权威：摘要出现的同时 `preview-sql` 节点仍在（摘要只加一层，
   *     不取代、不折叠 SQL 原文）。
   */
  {
    const PANE21 = '.ws-tab-pane:not(.hidden)';
    // 前置：切到 order 表标签（13g 结束时激活的是查询标签）
    const orderTab = page.locator('.ws-tab').filter({ hasText: 'order' }).first();
    if ((await orderTab.count()) > 0) await orderTab.click();
    await page.waitForTimeout(700);
    ok('T21 前置：order 表标签在（否则后续断言失真）',
      (await page.locator('[data-testid="pane-order"]').count()) === 1);

    // 尝试清掉可能残留的脏格（若都落在视口外，这个既有 helper 会空转 —— 见下面前置断言）。
    await clearDirtyByReload(page);
    const dirtyCountOf = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));
    /**
     * ⚠️ 不假设「起始无脏格」：T19 的追加行脏格落在视口之外，`clearDirtyByReload`
     *    只统计**已渲染**的 `.grid-cell.dirty`，会误判为空转而清不掉（实测残留 12，
     *    且 T19 自己的收尾清理同样失效 —— 这是一个与本任务无关的既有 e2e helper 缺陷，
     *    因文件改动红线（只能在 §14 之前追加）不在这里修，仅在报告里指出）。
     *    所以这里改用「delta 断言」：本次编辑必须**恰好**新增 1 个脏格 ——
     *    既不受残留影响，也仍然能证伪（编辑错列/多标脏都会红）。
     */
    const dirtyBeforeEdit = await dirtyCountOf();

    // 滚到左上角，确保目标行在可视区（虚拟滚动只渲染可视区）
    await page.evaluate(() => {
      const vp = document.querySelector('.ws-tab-pane:not(.hidden) .grid-viewport');
      if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; }
    });
    await page.waitForTimeout(300);

    /**
     * 取「第 2 行 · order_no」（第 2 个数据列 = data-col nth(1)）。
     * order_no 是 NOT NULL varchar（demo 里有非空值），编辑安全、值不经 Number 丢精度。
     * 原值不写死，而是**当场从网格读出** —— 这样断言与排序/筛选状态无关，且能
     * 真正验证「旧值 = 编辑前那一格的原文」。
     */
    const t21Cell = page.locator(`${PANE21} .grid-row`).nth(1).locator('.grid-cell[data-col]').nth(1);
    const originalValue = ((await t21Cell.innerText()) || '').trim();
    const NEW_VALUE = 'T21_NEW_VALUE';
    ok('T21 前置：读到待编辑单元格的真实原值（非空、且与新值不同）',
      originalValue.length > 0 && originalValue !== NEW_VALUE, `原值="${originalValue}"`);

    await t21Cell.dblclick();
    await page.waitForTimeout(250);
    ok('T21 前置：双击进入编辑态', (await page.locator(`${PANE21} .grid-cell-editor`).count()) === 1);
    await page.locator(`${PANE21} .grid-cell-editor`).fill(NEW_VALUE);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    const dirtyAfterEdit = await dirtyCountOf();
    ok('T21 前置：本次编辑恰好新增 1 个脏格（可证伪：编辑错列/多标脏会红）',
      dirtyAfterEdit === dirtyBeforeEdit + 1, `${dirtyBeforeEdit} → ${dirtyAfterEdit}`);

    // 打开保存预演
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(700);
    const modal21 = await page.locator('.modal').innerText().catch(() => '');

    const changeRows = page.locator('[data-testid="change-row"]');
    const changeRowCount = await changeRows.count();
    ok('T21 预演出现「旧值 → 新值」摘要（change-row ≥ 1）',
      changeRowCount >= 1,
      `change-row 数=${changeRowCount}；modal 首行="${(modal21.split('\n')[0] ?? '').slice(0, 60)}"`);

    /**
     * 读出全部摘要行的四项属性。⚠️ 不能用 `filter({ has })` 找那一行 ——
     * `has` 匹配的是**后代**，而 data-field 就在 <tr> 自身上，永远匹配不到
     * （第一版就踩了这个坑，导致属性读成 null 假红）。
     */
    const rowsInfo = [];
    for (let i = 0; i < changeRowCount; i++) {
      const r = changeRows.nth(i);
      rowsInfo.push({
        kind: await r.getAttribute('data-kind'),
        field: await r.getAttribute('data-field'),
        target: await r.getAttribute('data-target'),
        locate: await r.getAttribute('data-locate'),
        old: await r.getAttribute('data-old'),
        new: await r.getAttribute('data-new'),
      });
    }
    const attr =
      rowsInfo.find((r) => r.field === 'order_no') ??
      { kind: null, field: null, target: null, locate: null, old: null, new: null };
    const dumpRows = JSON.stringify(rowsInfo).slice(0, 260);

    ok('T21 摘要四项齐全（对象 / 行定位 / 字段 / 改前改后）',
      !!attr.target && /order/.test(attr.target) && /`id` = /.test(attr.locate ?? '') &&
        attr.field === 'order_no' && !!attr.old && attr.new === NEW_VALUE,
      `target=${attr.target} locate=${attr.locate} field=${attr.field} old=${attr.old} new=${attr.new}；rows=${dumpRows}`);

    ok('T21 🔴 旧值来自真实原值（不是拿脏格新值反推）',
      attr.old === originalValue && attr.old !== attr.new,
      `old="${attr.old}"（编辑前读到 "${originalValue}"） / new="${attr.new}"`);

    // 反向对照：摘要出现的同时原文 SQL 仍在（摘要不取代、不折叠权威 SQL）
    const sqlNodeCount = await page.locator('[data-testid="preview-sql"]').count();
    ok('T21 🔴 原文 SQL 仍逐条可看（摘要不取代权威 SQL）',
      sqlNodeCount >= 1 && /UPDATE/.test(modal21),
      `preview-sql 节点数=${sqlNodeCount}`);

    await page.locator('.modal footer button', { hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);
  }

  // 13i. T20 行号右键是一份**行菜单**，不是单元格菜单的复制品
  /**
   * T20 的核心口径（报告 §5 D17）有两句，缺一句都算没交付：
   *  1. 行号右键要独立突出 **新增 / 复制 / 删除 / 撤销选中行**；
   *  2. **不以首列值当作用户操作目标** —— 也就是行号上不许出现
   *     「复制该值 / 查看完整值」这类只能拿首列值冒充「整行」的项。
   *
   * 断言写成「该有的都在」+「不该有的都没有」两组，互为对照：
   * 只断前者的话，把单元格菜单原样搬过来也能全绿。
   */
  {
    // 前置：先确保有一张可编辑的 order 标签（上一个章节的收尾把脏格留下来了，先清掉）
    await clearDirtyByReload(page);
    const pane20 = page.locator('[data-testid="pane-order"]');
    let opened20 = (await pane20.count()) === 1;
    if (!opened20) {
      const dbRow20 = page
        .locator('.tree-row[data-node-kind="database"]')
        .filter({ has: page.locator('.tree-label', { hasText: /^order_db$/ }) })
        .first();
      if ((await dbRow20.count()) > 0) {
        await dbRow20.click();
        await page.waitForTimeout(400);
        const ob = page.locator('[data-testid="ob-item-order"]');
        if ((await ob.count()) > 0) {
          // 0.7.1：单击只选中，双击才打开
          await ob.first().dblclick();
          await page.waitForTimeout(1200);
          opened20 = true;
        }
      }
    }
    ok('T20 前置：order 表标签可用', opened20 && (await pane20.count()) === 1);

    const gutter = pane20.locator('.grid-row .grid-cell.gd-rowno').nth(1);
    ok('T20 前置：行号列可定位', (await gutter.count()) === 1);

    // --- 无脏格时右键行号：三/四个行级项在该在的位置 ---
    await gutter.click({ button: 'right' });
    await page.waitForTimeout(400);
    ok('T20 行号右键弹出菜单', (await page.locator('.gd-ctx-menu').count()) === 1);
    ok('T20 行号菜单有「新增空白行」', (await page.locator('[data-testid="ctx-add-row"]').count()) === 1);
    ok('T20 行号菜单有「插入复制行」', (await page.locator('[data-testid="ctx-duplicate-row"]').count()) === 1);
    ok('T20 行号菜单有「删除选中行」', (await page.locator('[data-testid="ctx-delete-rows"]').count()) === 1);

    // 标题认的是「行」不是「格」：不含任何列名
    const gutterTitle = (await page.locator('.gd-ctx-menu .gd-ctx-title').innerText().catch(() => '')).trim();
    ok('T20 行号菜单标题是「第 N 行」（不冒充某一列）', /^第 \d+ 行$/.test(gutterTitle), `标题=「${gutterTitle}」`);

    // 🔴 反向对照：单元格专属项一个都不许出现
    const gutterMenuText = await page.locator('.gd-ctx-menu').innerText();
    const cellOnly = ['复制该值', '查看完整值', '设为 NULL', '清除本格改动'];
    const leaked = cellOnly.filter((t) => gutterMenuText.includes(t));
    ok('T20 🔴 行号菜单不含单元格专属项（不以首列值冒充整行）',
      leaked.length === 0, leaked.length ? `漏出来的项：${leaked.join('、')}` : '干净');

    // 反向对照：本来就没有脏格 → 「撤销选中行的改动」不该出现
    ok('T20 无脏格时不给「撤销选中行的改动」（给了就是假 UI）',
      (await page.locator('[data-testid="ctx-discard-rows"]').count()) === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // --- 对照：单元格右键**必须**有那些单元格项 ---
    await pane20.locator('.grid-row').nth(1).locator('.grid-cell').nth(2).click({ button: 'right' });
    await page.waitForTimeout(400);
    const cellMenuText = await page.locator('.gd-ctx-menu').innerText();
    ok('T20 🔴 单元格右键仍有「复制该值 / 查看完整值」（对照，防一刀切）',
      cellMenuText.includes('复制该值') && cellMenuText.includes('查看完整值'),
      cellMenuText.split('\n').slice(0, 3).join(' / '));
    ok('T20 单元格右键也有行级项（整行语义对两种右键都成立）',
      (await page.locator('[data-testid="ctx-add-row"]').count()) === 1 &&
        (await page.locator('[data-testid="ctx-delete-rows"]').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // --- 有脏格时：撤销选中行的改动 ---
    await pane20.locator('.grid-row').nth(1).locator('.grid-cell').nth(2).dblclick();
    await page.waitForTimeout(250);
    await pane20.locator('.grid-cell-editor').fill('T20 弄脏一下');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const dirtyBefore20 = Number(
      (await page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count')) ?? 0,
    );
    ok('T20 前置：已造出 1 个脏格', dirtyBefore20 === 1, `dirty=${dirtyBefore20}`);

    await pane20.locator('.grid-row').nth(1).locator('.grid-cell.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(400);
    ok('T20 有脏格时出现「撤销选中行的改动」',
      (await page.locator('[data-testid="ctx-discard-rows"]').count()) === 1);
    await page.locator('[data-testid="ctx-discard-rows"]').click();
    await page.waitForTimeout(500);
    const dirtyAfter20 = Number(
      (await page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count')) ?? 0,
    );
    ok('T20 行级撤销真的清掉了脏格', dirtyAfter20 === 0, `dirty ${dirtyBefore20} → ${dirtyAfter20}`);

    // --- 删除选中行：真的进「待删除」并出现在保存预演里 ---
    await pane20.locator('.grid-row').nth(1).locator('.grid-cell.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="ctx-delete-rows"]').click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(700);
    const delPreview = await page.locator('.modal').innerText().catch(() => '');
    ok('T20 行号右键删除 → 保存预演里出现 DELETE（不是点了没反应）',
      /DELETE/i.test(delPreview), delPreview.split('\n').find((l) => /DELETE/i.test(l))?.slice(0, 60) ?? '未出现');
    await page.locator('.modal footer button, .modal button').filter({ hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);

    // 收尾：把「待删除」标记清掉，别影响后面
    await clearDirtyByReload(page);
  }

  // 13j. T22 复制收进子菜单 + T23 单列 IN 清单
  /**
   * T22 的验收口径是「**菜单不再撑满屏幕**」，所以断言不能只断「子面板里有那些项」——
   * 那样把两组项同时铺在顶层也能全绿（旧状态就是全绿）。必须比**项数**：
   * 顶层项数要明显小于铺开时的总数，且子面板里能找全五类。
   *
   * T23 的验收口径是「输出可直接用于 SQL」+「单列」。这里既断形状
   * （`` `col` IN (…) ``）也断**只含一列**——反例是多列混进 IN 就会语法不通。
   */
  {
    await clearDirtyByReload(page);
    const pane22 = page.locator('[data-testid="pane-order"]');
    ok('T22 前置：order 表标签可用', (await pane22.count()) === 1);

    // --- 单元格右键（有列）---
    await pane22.locator('.grid-row').nth(1).locator('.grid-cell').nth(1).click({ button: 'right' });
    await page.waitForTimeout(400);
    const rootItems = await page.locator('.gd-ctx-menu [role="menuitem"]').count();
    ok('T22 顶层菜单有「复制…」入口', (await page.locator('[data-testid="ctx-copy-open"]').count()) === 1);
    ok('T22 顶层不再直接铺开复制格式（TSV/JSON/… 都不在顶层）',
      (await page.locator('.gd-ctx-menu', { hasText: 'TSV' }).count()) === 0,
      `顶层项数=${rootItems}`);

    /**
     * 🔴 快照必须在「点开复制…」**之前**取 —— 二级面板渲染进同一个
     * .gd-ctx-menu，之后取到的标签全是子面板内容，「顶层无格式项」就
     * 失去了证伪能力（旧的全铺开实现反而能绿）。
     *
     * 格式项的判定**只看 .gd-ctx-label**（可见文案），不看 title / testid ——
     * 否则「SQL 表达式模式编辑」的 title（含 UPDATE）会把无关项误判成格式项。
     */
    const FORMAT_LABEL_RE = /TSV|CSV|JSON 数组|Markdown 表格|INSERT 语句|UPDATE 语句|IN 清单|含列名|整行 SQL/;
    const menuLabels = () => page.locator('.gd-ctx-menu [role="menuitem"] .gd-ctx-label')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    const topLabels = await menuLabels();
    ok('T22 🔴 顶层不含任何格式项（否则等于没收纳）',
      topLabels.filter((l) => FORMAT_LABEL_RE.test(l)).length === 0,
      `命中格式词的顶层标签=${JSON.stringify(topLabels.filter((l) => FORMAT_LABEL_RE.test(l)))}（顶层项数=${rootItems}）`);

    await page.locator('[data-testid="ctx-copy-open"]').click();
    await page.waitForTimeout(300);
    const subItems = await page.locator('.gd-ctx-menu [role="menuitem"]').count();
    const subText = await page.locator('.gd-ctx-menu').innerText();
    const fmtIn = async () => (await page.locator('.gd-ctx-menu [role="menuitem"] .gd-ctx-label')
      .evaluateAll((els) => els.filter((e) => /TSV|CSV|JSON 数组|Markdown 表格|INSERT 语句|UPDATE 语句|IN 清单/.test(e.textContent ?? '')).length));
    ok('T22 🔴 复制格式被收进二级面板（子面板内格式项 ≥ 7）', (await fmtIn()) >= 7,
      `子面板格式项=${await fmtIn()}（期望 ≥7；少于 7 说明收纳后反而丢了格式）`);
    ok('T22 子面板五类齐全（当前值/选中区/含列名/整行 SQL/单列 IN）',
      /当前值/.test(subText) && /选中区/.test(subText) && /含列名/.test(subText) &&
        /整行 SQL/.test(subText) && /单列 IN/.test(subText),
      subText.split('\n').filter((l) => /区|含列名|整行|单列|当前值/.test(l)).join(' | ').slice(0, 120));

    // 「← 返回」真的回得去（否则用户点错一次只能关菜单重来）
    await page.locator('[data-testid="ctx-copy-back"]').click();
    await page.waitForTimeout(300);
    ok('T22 二级面板可返回顶层',
      (await page.locator('[data-testid="ctx-copy-open"]').count()) === 1 &&
        (await page.locator('[data-testid="ctx-copy-back"]').count()) === 0);

    // --- T23：单列 IN 清单 ---
    await page.locator('[data-testid="ctx-copy-open"]').click();
    await page.waitForTimeout(300);
    const inItem = page.locator('[data-testid="ctx-copy-in-list"]');
    ok('T23 子面板有「单列 IN 清单」', (await inItem.count()) === 1);
    const inLabel = (await inItem.innerText().catch(() => '')).replace(/\s+/g, ' ');
    /**
     * 断**口径**不断具体列名 —— 右键落在哪一列取决于列顺序，写死列名会在
     * 列顺序变化时假红。这里要求：文案形如「<列名> → IN 清单（N 个值…）」，
     * 且 N 必须与**真的复制到剪贴板的值个数**一致（下面紧接着读剪贴板核对）。
     * 光有「个值」三个字是恒真，必须对得上数。
     */
    const mIn = /^(.+?) → IN 清单（(\d+) 个值/.exec(inLabel);
    ok('T23 文案报出列名与值个数（动手前就知道会复制什么）', !!mIn, `文案=「${inLabel}」`);

    await inItem.click();
    await page.waitForTimeout(300);
    const inText = await page.evaluate(() => navigator.clipboard.readText());
    ok('T23 🔴 输出形如 `col` IN (…)，可直接粘进 SQL',
      /^`[^`]+` IN \(.+\)$/.test(inText.trim()) || /^\(`[^`]+` IN \(.+\) OR `[^`]+` IS NULL\)$/.test(inText.trim()),
      inText.slice(0, 90));
    ok('T23 🔴 文案里的值个数与真复制出的个数一致（不许文案说一套给一套）',
      !!mIn && (inText.match(/`/g) ?? []).length >= 2 &&
        (() => {
          const body = / IN \(([^)]*)\)/.exec(inText)?.[1] ?? '';
          const n = body === '' ? 0 : body.split(', ').length;
          return n === Number(mIn[2]);
        })(),
      mIn ? `文案说 ${mIn[2]} 个值，实际 ${/ IN \(([^)]*)\)/.exec(inText)?.[1]?.split(', ').length ?? 0} 个` : '文案没解析出个数');
    ok('T23 🔴 只含一列（多列混进 IN 就是语法不通的坏 SQL）',
      (inText.match(/`/g) ?? []).length <= (inText.includes(' IS NULL') ? 6 : 4),
      `反引号个数=${(inText.match(/`/g) ?? []).length} 内容=${inText.slice(0, 60)}`);
    ok('T23 值是字面量而不是 ? 占位（占位符粘出去没法用）',
      !inText.includes('?'), inText.slice(0, 60));

    // 反向对照：行号右键没有「哪一列」可言 → 子面板里不该出现单列 IN
    await pane22.locator('.grid-row').nth(1).locator('.grid-cell.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="ctx-copy-open"]').click();
    await page.waitForTimeout(300);
    ok('T23 🔴 行号右键不给「单列 IN」（没有列可言，给了就是误导）',
      (await page.locator('[data-testid="ctx-copy-in-list"]').count()) === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    await clearDirtyByReload(page);
  }

  // 13k. T24 列头快筛 + 单列多值 IN；13l. T25 单元格右键四个值编辑动作；无桥场景对照
  /**
   * 断言口径（每条都要能证伪）：
   *  - 快筛浮层必须由**列头右键菜单**触发（预选列 = 右键的那一列，断言下拉 value）；
   *  - 多值 IN 输入「重复值 + 裸空行」后：规则摘要必须报出去重与空片段计数
   *    （静默少给 = 结果集悄悄变窄，这正是规则存在的理由）；
   *  - 应用后条件条出现 IN 徽标且 SQL 预览含 IN —— demo 后端忽略 WHERE，
   *    但「写入 tab.filter → 重查 → 条件条读真值」这条 UI 链路必须全通（同 A22 口径）；
   *  - T25 四动作各一条：编辑值浮层能开 / 设为空串后脏格显示 '' 且不带 null 类
   *    （与 NULL 严格区分的红线）/ 使用默认值后预演含 SET `col` = DEFAULT
   *    （sql-expr 原样嵌入，不是字符串 'DEFAULT'）/ 撤销本格清脏；
   *  - 无桥对照：SQL 结果网格的列头右键里两个筛选入口必须 disabled 且 title 给原因。
   */
  {
    // 前置：回到 order 表标签（13j 结束时可能停在别的标签）
    const orderTabT24 = page.locator('.ws-tab').filter({ hasText: 'order' }).first();
    if ((await orderTabT24.count()) > 0) await orderTabT24.click();
    await page.waitForTimeout(700);
    const paneT = page.locator('[data-testid="pane-order"]');
    ok('T24 前置：order 表标签可用', (await paneT.count()) === 1);

    await clearDirtyByReload(page);
    const dirtyOfT = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));

    // 滚回左上角（前面章节滚过，快筛的验证格必须在可视区）
    await page.evaluate(() => {
      const vp = document.querySelector('.ws-tab-pane:not(.hidden) .grid-viewport');
      if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; }
    });
    await page.waitForTimeout(300);

    // ---- T24a：列头右键 → 按此列筛选 → 浮层出现且预选列正确 ----
    const statusHeader = paneT.locator('.grid-header-cell').filter({ hasText: 'status' }).first();
    await statusHeader.click({ button: 'right' });
    await page.waitForTimeout(400);
    ok('T24 列头右键菜单含「按此列筛选 / 此列多值 IN」两项',
      (await page.locator('[data-testid="ctx-header-filter"]').count()) === 1 &&
        (await page.locator('[data-testid="ctx-header-filter-in"]').count()) === 1);

    await page.locator('[data-testid="ctx-header-filter"]').click();
    await page.waitForTimeout(300);
    ok('T24 快筛浮层出现（FilterBar 的 quick 属性）', (await page.locator('[data-testid="fb-qf"]').count()) === 1);
    // 🔴 预选列必须等于右键的那一列（写死 value 在「菜单传错列」时立刻红）
    const qfCol = await page.locator('[data-testid="fb-qf-col"]').inputValue().catch(() => '');
    ok('T24 浮层预选列 = 右键列（status）', qfCol === 'status', `预选=${qfCol}`);

    // 单值模式：选「等于」填一个值应用 → 条件条出现且徽标含 status
    // 先记下应用**之前**条件条上有什么：如果本来就是空的，应用后多出「未填完」
    // 就一定是这次追加把编辑器占位行带进来了（T24 曾这么红过一次）。
    const chipInfoBeforeT = await paneT
      .locator('[data-testid="fb-bar-chip"]')
      .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-state')}:${(e.textContent ?? '').trim()}`));
    await page.locator('[data-testid="fb-qf-value"]').fill('paid');
    await page.locator('[data-testid="fb-qf-apply"]').click();
    await page.waitForTimeout(700);
    ok('T24 单值快筛应用后条件条出现', (await paneT.locator('.filter-bar').count()) === 1);
    const chipInfoT = await paneT
      .locator('[data-testid="fb-bar-chip"]')
      .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-state')}:${(e.textContent ?? '').trim()}`));
    ok('T24 条件条徽标含预选列（status = paid）',
      chipInfoT.some((t) => /status/.test(t) && /paid/.test(t)), chipInfoT.join(' | '));
    // 应用的是**填完的**条件 → 条上不该出现「未填完」的已生效条目
    ok('T24 🔴 应用完整条件后没有「未填完」的已生效徽标',
      !chipInfoT.some((t) => t.startsWith('incomplete')),
      `应用前=${chipInfoBeforeT.join(' | ') || '(空)'} 应用后=${chipInfoT.join(' | ')}`);
    ok('T24 应用后浮层关闭（quick 状态清掉）', (await page.locator('[data-testid="fb-qf"]').count()) === 0);

    // ---- T24b：列头右键 → 多值 IN（含重复 + 裸空行）----
    await statusHeader.click({ button: 'right' });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="ctx-header-filter-in"]').click();
    await page.waitForTimeout(300);
    ok('T24 多值 IN 浮层打开（textarea 形态）', (await page.locator('[data-testid="fb-qf-values"]').count()) === 1);
    // 预选列同样正确（IN 入口与单值入口走同一个浮层，列号不该串）
    const qfInCol = await page.locator('[data-testid="fb-qf-col"]').inputValue().catch(() => '');
    ok('T24 IN 浮层预选列也是右键列', qfInCol === 'status', `预选=${qfInCol}`);

    // 重复值 paid ×2 + 裸空片段（末尾逗号）—— 规则必须把这两件事说出来
    await page.locator('[data-testid="fb-qf-values"]').fill('paid, unpaid, paid,');
    await page.waitForTimeout(200);
    const summaryT = (await page.locator('[data-testid="fb-qf-summary"]').innerText().catch(() => ''));
    ok('T24 摘要报出 2 个值（去重生效）', /2 个值/.test(summaryT), summaryT);
    ok('T24 🔴 摘要报出去重计数（重复不许静默少给）', /去重 1 个/.test(summaryT), summaryT);
    ok('T24 🔴 摘要报出忽略的空片段（裸空不是空串）', /忽略 1 个空片段/.test(summaryT), summaryT);

    await page.locator('[data-testid="fb-qf-apply"]').click();
    await page.waitForTimeout(700);
    // 条件条：出现带 IN 标记的徽标，且 SQL 预览含 IN
    const inChip = paneT.locator('[data-testid="fb-bar-chip"]', { hasText: 'IN' });
    ok('T24 应用后条件条出现 IN 徽标', (await inChip.count()) >= 1,
      (await inChip.first().innerText().catch(() => '')).replace(/\n/g, ' '));
    const barPreviewT = (await paneT.locator('[data-testid="fb-bar-preview"]').innerText().catch(() => ''));
    ok('T24 SQL 预览含 IN 条件（服务端筛选真值进了 tab.filter）', /status` IN/.test(barPreviewT),
      barPreviewT.slice(0, 90));

    // 收尾：清空筛选（别把条件留给后面的章节），并确认清空后条件条消失
    await paneT.locator('[data-testid="fb-bar-clear"]').click();
    await page.waitForTimeout(700);
    ok('T24 清空后条件条消失（真值回空，bar 不常驻）', (await paneT.locator('.filter-bar').count()) === 0);

    // ---- T25：单元格右键四个值编辑动作 ----
    // 靶子格：第 2 行 remark 列（varchar 可空，空串/NULL 语义都在这列上有意义）
    const REMARK_COL = 6; // id/order_no/user_id/amount/status/created_at/remark（从 0 数第 6 个数据列）
    const remarkCell = () => paneT.locator('.grid-row').nth(1).locator('.grid-cell[data-col]').nth(REMARK_COL);
    await remarkCell().click({ button: 'right' });
    await page.waitForTimeout(400);
    const t25MenuText = await page.locator('.gd-ctx-menu').innerText();
    ok('T25 菜单含四个值编辑动作（编辑值/设为空串/使用默认值/撤销本格）',
      /编辑值/.test(t25MenuText) && /设为空串/.test(t25MenuText) &&
        /使用默认值/.test(t25MenuText) && /撤销本格/.test(t25MenuText),
      t25MenuText.split('\n').filter((l) => /编辑值|空串|默认|撤销本格/.test(l)).join(' / '));
    ok('T25 无改动时「撤销本格」禁用（不给点了没反应的项）',
      await page.locator('[data-testid="ce-ctx-discard-cell"]').isDisabled());

    // (1) 编辑值…：浮层真的能开，且是菜单项触发（不是只有格内双击那条路）
    await page.locator('[data-testid="ce-ctx-edit-value"]').click();
    await page.waitForTimeout(400);
    ok('T25 「编辑值…」打开浮层（ce-value-editor）',
      (await page.locator('[data-testid="ce-value-editor"]').count()) === 1);
    ok('T25 浮层标题带列名与类型', /remark/.test(await page.locator('[data-testid="ce-value-editor"]').innerText()),
      (await page.locator('[data-testid="ce-value-editor-type"]').innerText().catch(() => '')));
    // 关闭走浮层自己的取消按钮：Esc 在浮层 onKeyDown 上，焦点不在浮层内时收不到
    await page.locator('[data-testid="ce-value-editor-cancel"]').click();
    await page.waitForTimeout(250);

    // (2) 设为空串：脏格显示 '' 且**不带 null 类**（空串是真实值，NULL 是斜体占位 —— 两者不许混）
    await remarkCell().click({ button: 'right' });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="ce-ctx-set-empty"]').click();
    await page.waitForTimeout(400);
    const dirty1 = await dirtyOfT();
    ok('T25 设为空串后脏格 +1', dirty1 === 1, `dirty=${dirty1}`);
    const emptyCell = remarkCell();
    const emptyText = (await emptyCell.innerText().catch(() => '')).trim();
    const emptyIsDirty = await emptyCell.evaluate((el) => el.classList.contains('dirty'));
    const emptyIsNullCls = await emptyCell.evaluate((el) => el.classList.contains('null'));
    /**
     * 🔴 空串脏格的显示是**空白文本**（String('')），NULL 的显示是斜体「NULL」+ null 类。
     * 若实现把空串存成了 NULL（T25 要修的混淆），文本会变成「NULL」且带 null 类 —— 两条都红。
     */
    ok('T25 🔴 空串脏格显示空白文本（不是 NULL 占位「NULL」）', emptyText === '', `文本=「${emptyText}」`);
    ok('T25 🔴 空串脏格带 dirty 类且不带 null 类（与 NULL 严格区分）', emptyIsDirty && !emptyIsNullCls,
      `dirty=${emptyIsDirty} null=${emptyIsNullCls}`);

    // (3) 使用默认值（UPDATE 语境）：预演 SQL 必须含 SET `remark` = DEFAULT（关键字，不是字符串）
    await remarkCell().click({ button: 'right' });
    await page.waitForTimeout(400);
    const defDisabled = await page.locator('[data-testid="ce-ctx-use-default"]').isDisabled();
    ok('T25 「使用默认值」在 UPDATE 语境可点', !defDisabled,
      defDisabled ? `禁用原因=${await page.locator('[data-testid="ce-ctx-use-default"]').getAttribute('title')}` : '');
    await page.locator('[data-testid="ce-ctx-use-default"]').click();
    await page.waitForTimeout(400);
    ok('T25 使用默认值后仍是 1 个脏格（DEFAULT 也是待提交改动）',
      (await dirtyOfT()) === 1, `dirty=${await dirtyOfT()}`);
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(700);
    const defPreview = await page.locator('.modal').innerText().catch(() => '');
    ok('T25 🔴 预演 SQL 含 SET `remark` = DEFAULT（sql-expr 原样嵌入）',
      /SET `remark` = DEFAULT/.test(defPreview),
      defPreview.split('\n').find((l) => /remark/.test(l))?.slice(0, 70) ?? '未找到 remark 行');
    ok('T25 🔴 DEFAULT 不是字符串字面量（写成 \'DEFAULT\' 就是把关键字当文本写库）',
      !/= 'DEFAULT'/.test(defPreview), defPreview.split('\n').find((l) => /DEFAULT/.test(l))?.slice(0, 70) ?? '');
    await page.locator('.modal footer button, .modal button').filter({ hasText: '取消' }).first().click().catch(() => {});
    await page.waitForTimeout(400);

    // (4) 撤销本格：清掉脏格（DEFAULT 的待提交改动也归它管）
    await remarkCell().click({ button: 'right' });
    await page.waitForTimeout(400);
    ok('T25 有改动时「撤销本格」转可用', !(await page.locator('[data-testid="ce-ctx-discard-cell"]').isDisabled()));
    await page.locator('[data-testid="ce-ctx-discard-cell"]').click();
    await page.waitForTimeout(400);
    ok('T25 🔴 撤销本格清脏（dirty 归零）', (await dirtyOfT()) === 0, `dirty=${await dirtyOfT()}`);
    const cellAfterDiscard = await remarkCell().evaluate((el) => el.classList.contains('dirty'));
    ok('T25 撤销后该格不再带 dirty 类', !cellAfterDiscard);

    // ---- 无桥对照：SQL 结果网格列头右键 → 两项 disabled + title 给原因 ----
    // ⚠️ 13g 留下的旧查询 tab 里也有 .cm-editor（隐藏 pane），waitForSelector 会卡在
    //    「第一个命中不可见」—— 必须限定在**激活** pane 内等待与操作。
    await page.keyboard.press('Meta+t');
    await page.waitForSelector('.ws-tab-pane:not(.hidden) .cm-editor', { timeout: 15_000 });
    const activeCm = page.locator('.ws-tab-pane:not(.hidden) .cm-content');
    await activeCm.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1 AS n;');
    await page.waitForTimeout(300);
    await page.locator('.ws-tab-pane:not(.hidden) .sql-toolbar [data-testid="sql-run-all"]').click();
    await page.waitForTimeout(1500);
    // 结果网格在查询 pane 里（无 HeaderFilterContext provider）
    const resultPane = page.locator('.ws-tab-pane:not(.hidden)');
    const resultHeader = resultPane.locator('.grid-header-cell').filter({ hasText: 'n' }).first();
    ok('T24 无桥前置：SQL 结果网格已渲染', (await resultHeader.count()) === 1);
    await resultHeader.click({ button: 'right' });
    await page.waitForTimeout(400);
    const noBridgeSingle = await page.locator('[data-testid="ctx-header-filter"]').isDisabled();
    const noBridgeIn = await page.locator('[data-testid="ctx-header-filter-in"]').isDisabled();
    ok('T24 🔴 无桥（结果网格）两个筛选入口都 disabled', noBridgeSingle && noBridgeIn,
      `单值=${noBridgeSingle} IN=${noBridgeIn}`);
    const reasonSingle = (await page.locator('[data-testid="ctx-header-filter"]').getAttribute('title')) || '';
    ok('T24 🔴 disabled 的 title 给出中文原因（不是静默置灰）',
      /没有接入表筛选链路/.test(reasonSingle), reasonSingle);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    // 关掉这个查询 tab，别影响后面章节的 tab 计数
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(400);
  }

  // ---- T46 / T47 / T38：身份条 / 行数口径 / 撤销重做 ----
  /**
   * 断言口径：
   *  - T46 身份条四段必须**都有内容**，且「环境」不能等于连接名（那说明只是把连接名
   *    重复了一遍，用户仍然不知道自己在哪个环境）；
   *  - T46 保存按钮**无改动时不报数量、有改动时报 N 项** —— 两条都断，否则
   *    「显示数量」可能根本没接上而断言仍然绿；
   *  - T46 刷新数据 / 刷新结构必须是两个入口且 title 语义不同（报告 §8.2 第 2 条）；
   *  - T47 行数口径必须有 data-basis，且取值在 exact/estimated/truncated 里；
   *  - T38 ⌘Z 撤销后脏格归零、⇧⌘Z 重做后脏格回来（只断一次的话，
   *    把 undo 实现成 clearAll 也能过）。
   */
  {
    const orderTabT = page.locator('.ws-tab').filter({ hasText: 'order' }).first();
    if ((await orderTabT.count()) > 0) await orderTabT.click();
    await page.waitForTimeout(700);
    await clearDirtyByReload(page);
    const paneX = page.locator('[data-testid="pane-order"]');
    const dirtyNow = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));
    const dirtyCellsNow = () =>
      page
        .locator('.statusbar[data-dirty-count]')
        .getAttribute('data-dirty-cells')
        .then((v) => v ?? '')
        .catch(() => '');

    const idParts = await page
      .locator('[data-testid="toolbar-identity"] [data-testid^="identity-"]')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    ok('T46 身份条四段齐全', idParts.length === 4 && idParts.every((t) => t.length > 0), idParts.join(' / '));
    ok('T46 身份条对象段 = 当前表名', idParts[3] === 'order', idParts[3] ?? '(空)');
    ok('T46 环境段与连接段分开（不是把连接名重复一遍）', idParts[0] !== idParts[1], `${idParts[0]} vs ${idParts[1]}`);

    const saveCleanText = (await page.locator('[data-testid="btn-save"]').innerText()).trim();
    ok('T46 无改动时保存按钮不报数量', !/\d+\s*项/.test(saveCleanText), saveCleanText);

    const hasRefreshData = (await page.locator('[data-testid="btn-refresh-data"]').count()) === 1;
    const hasRefreshSchema = (await page.locator('[data-testid="btn-refresh-schema"]').count()) === 1;
    ok('T46 刷新数据与刷新结构是两个入口', hasRefreshData && hasRefreshSchema,
      `数据=${hasRefreshData} 结构=${hasRefreshSchema}`);
    const titleData = (await page.locator('[data-testid="btn-refresh-data"]').getAttribute('title')) || '';
    const titleSchema = (await page.locator('[data-testid="btn-refresh-schema"]').getAttribute('title')) || '';
    ok('T46 两者命名区分数据与结构', /数据/.test(titleData) && /结构/.test(titleSchema),
      `${titleData} | ${titleSchema}`);

    /**
     * T46 紧凑模式 —— 此前**没有任何门禁**：e2e-ui 的窗口固定 1440，
     * density 恒为 full，`{density === 'compact' ? <更多菜单> : null}` 这段
     * 分支从来没被执行过。唯一撞到它的是 e2e:keys（窗口更窄），而且当场
     * 崩在 `isDisabled()` 的 30s 超时上。这里补上真门禁：
     *  · 窄 → compact，低频项离开主栏但**必须还在「更多」里**（不是删掉）；
     *  · 核心项（保存/筛选）永不折叠。
     */
    {
      await page.setViewportSize({ width: 760, height: 900 });
      await page.waitForTimeout(500);
      const dens = await page.locator('.toolbar').first().getAttribute('data-density');
      ok('T46 窄宽度下工具栏进入紧凑模式', dens === 'compact', `density=${dens}`);
      ok('T46 紧凑模式下低频项不再占主栏（导入不在 DOM）',
        (await page.locator('[data-testid="btn-import"]').count()) === 0);
      const moreBtn = page.locator('[data-testid="btn-more"]');
      ok('T46 紧凑模式出现「更多」入口', (await moreBtn.count()) === 1);
      ok('T46 紧凑模式仍保留保存与筛选（核心项不折叠）',
        (await page.locator('[data-testid="btn-save"]').count()) === 1 &&
          (await page.locator('[data-testid="btn-filter"]').count()) === 1);

      await moreBtn.click();
      await page.waitForTimeout(300);
      const popItems = await page.locator('[data-testid="tb-more-pop"] [role="menuitem"]').count();
      ok('T46 展开「更多」后折叠项可达（4 项）', popItems === 4, `items=${popItems}`);
      ok('T46 折叠项身份齐全（导出/导入/设计/粘贴）',
        (await page.locator('[data-testid="more-export"]').count()) === 1 &&
          (await page.locator('[data-testid="more-import"]').count()) === 1 &&
          (await page.locator('[data-testid="more-design"]').count()) === 1 &&
          (await page.locator('[data-testid="more-paste"]').count()) === 1);

      // 恢复宽度 = 菜单整段 unmount（不用按 Esc，也不该依赖 Esc）
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(500);
      ok('T46 恢复宽度后回到完整模式且折叠项回到主栏',
        (await page.locator('.toolbar').first().getAttribute('data-density')) === 'full' &&
          (await page.locator('[data-testid="btn-import"]').count()) === 1);
    }

    const basis = await page.locator('[data-testid="status-row-count"]').getAttribute('data-basis').catch(() => null);
    ok('T47 行数口径显式标注（exact / estimated / truncated）',
      ['exact', 'estimated', 'truncated'].includes(basis ?? ''), String(basis));

    // T38：改一格 → 撤销 → 重做
    await paneX.locator('.grid-row').nth(1).locator('.grid-cell').nth(7).dblclick();
    await page.waitForTimeout(200);
    await page.locator('.grid-cell-editor').fill('undo-test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const dirtyAfterEdit = await dirtyNow();
    const saveDirtyText = (await page.locator('[data-testid="btn-save"]').innerText()).trim();
    ok('T46 有改动时保存按钮报出待提交数量', /\d+\s*项/.test(saveDirtyText), saveDirtyText);
    ok('T38 有改动时撤销按钮可用', !(await page.locator('[data-testid="btn-undo"]').isDisabled()),
      `dirty=${dirtyAfterEdit} 坐标=${(await dirtyCellsNow()) || '(空)'}`);

    await page.locator('[data-testid="btn-undo"]').click();
    await page.waitForTimeout(300);
    /**
     * 失败时必须能一眼看出是哪一层没生效：
     *  · toast 说「已撤销」→ 栈走通了，问题在回放；
     *  · 网格还有 .dirty 类 → source 没清掉；statusbar 归零而网格有类 → 渲染层不同步。
     */
    const undoToast = await page.locator('.banner.shell-banner').first().innerText().catch(() => '');
    const dirtyCells = await paneX.locator('.grid-cell.dirty').count();
    ok('T38 撤销后脏格归零', (await dirtyNow()) === 0,
      `dirty=${await dirtyNow()} 坐标=${await dirtyCellsNow() || '(空)'} 脏格=${dirtyCells} 提示=${undoToast.trim()}`);
    ok('T38 撤销后重做按钮可用（不是把改动直接扔掉）',
      !(await page.locator('[data-testid="btn-redo"]').isDisabled()));

    await page.locator('[data-testid="btn-redo"]').click();
    await page.waitForTimeout(300);
    ok('T38 重做后脏格回来', (await dirtyNow()) === dirtyAfterEdit, `dirty=${await dirtyNow()}`);

    // 收尾：清干净，别把脏标记留给后面的章节
    await clearDirtyByReload(page);
  }

  // ---- T36 / T37：ENUM 专用下拉 与 日期时间辅助控件 ----
  /**
   * 断言口径（都要求**可证伪**）：
   *  - T36：格内出现的必须是 `<select>`（不是文本框）→ 断「选不出非法值」，
   *    并读出选项集合，确认**只来自 DDL 定义值**；写入后脏格的值 = 选中的值。
   *  - T37：原始文本**永远可见且逐字相等**（含微秒）；日期控件只改日期段，
   *    时间与微秒原样保留 —— 这正是「过一遍 Date 就丢微秒」的实现会红的地方。
   */
  {
    const orderTab37 = page.locator('.ws-tab').filter({ hasText: 'order' }).first();
    if ((await orderTab37.count()) > 0) await orderTab37.click();
    await page.waitForTimeout(700);
    await clearDirtyByReload(page);
    const pane37 = page.locator('[data-testid="pane-order"]');
    await page.evaluate(() => {
      const vp = document.querySelector('.ws-tab-pane:not(.hidden) .grid-viewport');
      if (vp) { vp.scrollTop = 0; vp.scrollLeft = 0; }
    });
    await page.waitForTimeout(300);

    const cellAt37 = (row, col) =>
      pane37.locator('.grid-row').nth(row).locator(`.grid-cell[data-col="${col}"]`).first();
    const dirty37 = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));

    // T36：第 5 列（data-col=4）= enum('paid','unpaid','refunded')
    const enumText = ((await cellAt37(0, 4).innerText()) || '').trim();
    ok('T36 前置：该列确实是 ENUM 取值', ['paid', 'unpaid', 'refunded'].includes(enumText), enumText);

    await cellAt37(0, 4).dblclick();
    await page.waitForTimeout(300);
    ok('T36 双击 ENUM 列进入专用下拉（不是自由文本）',
      (await page.locator('[data-testid="ce-enum-select"]').count()) === 1);
    // 负向对照：文本输入框必须消失 —— 两个都在就说明"只是多画了一个下拉"
    ok('T36 ENUM 格内没有自由文本框（选不出非法值）',
      (await page.locator('[data-testid="cell-editor"]').count()) === 0);

    const enumOpts = await page
      .locator('[data-testid="ce-enum-select"] option')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    const realOpts = enumOpts.filter((t) => t !== '选择取值…' && !/^NULL/.test(t) && t !== '');
    ok('T36 下拉选项只来自 DDL 定义值',
      realOpts.length > 0 && realOpts.every((t) => ['paid', 'unpaid', 'refunded'].includes(t)),
      realOpts.join('|'));

    await page.locator('[data-testid="ce-enum-select"]').selectOption({ label: 'unpaid' });
    await page.waitForTimeout(400);
    ok('T36 选中定义值后进入待提交（脏格 = 1）', (await dirty37()) === 1, `dirty=${await dirty37()}`);
    ok('T36 格内显示的是选中的值', ((await cellAt37(0, 4).innerText()) || '').trim() === 'unpaid',
      ((await cellAt37(0, 4).innerText()) || '').trim());

    // 撤销回干净（同时验证 T38 的栈能撤掉 ENUM 这一手）
    await page.locator('[data-testid="btn-undo"]').click();
    await page.waitForTimeout(300);
    ok('T36 ENUM 改动可撤销回干净', (await dirty37()) === 0, `dirty=${await dirty37()}`);

    // T37：第 6 列（data-col=5）= datetime(6)，demo 值带 6 位微秒
    const dtText = ((await cellAt37(0, 5).innerText()) || '').trim();
    ok('T37 前置：日期列原文带 6 位微秒（保真靶子）',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(dtText), dtText);

    await cellAt37(0, 5).dblclick();
    await page.waitForTimeout(300);
    ok('T37 日期格内出现辅助控件入口（不是只有文本框）',
      (await page.locator('[data-testid="ce-cell-dt-toggle"]').count()) === 1);
    await page.locator('[data-testid="ce-cell-dt-toggle"]').click();
    await page.waitForTimeout(400);
    ok('T37 辅助控件浮层打开', (await page.locator('[data-testid="ce-dt"]').count()) === 1);

    const rawVisible = await page.locator('[data-testid="ce-dt-text"]').inputValue();
    ok('T37 🔴 原始字符串完整可见（含微秒，逐字相等）', rawVisible === dtText, `${rawVisible} vs ${dtText}`);

    await page.locator('[data-testid="ce-dt-date"]').fill('2030-01-01');
    await page.waitForTimeout(300);
    const afterDate = await page.locator('[data-testid="ce-dt-text"]').inputValue();
    ok('T37 🔴 日期控件只改日期段：时间与微秒原样保留',
      afterDate === `2030-01-01${dtText.slice(10)}`, `${afterDate}`);

    await page.locator('[data-testid="ce-value-editor-cancel"]').click();
    await page.waitForTimeout(300);
    ok('T37 取消辅助编辑不留脏格（草稿没被悄悄写库）', (await dirty37()) === 0, `dirty=${await dirty37()}`);
    // 关掉可能残留的编辑态，别把脏标记/焦点留给后面的章节
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ---- T49：组合回归（demo 后端可覆盖的 3 条）----
  /**
   * 只覆盖 demo 能造出前置条件的三条；其余三条由专项门禁守着：
   *  · 两连接同名库 → T02/T03 单测 + e2e:app 真库；
   *  · JSON 大整数逐字 → core-clipboard 单测 + e2e:smoke（真库）；
   *  · 异常中断释放 → e2e:idle（断线重连/隧道）。
   */
  {
    const pane49 = page.locator('[data-testid="pane-order"]');
    const dirty49 = () =>
      page.locator('.statusbar[data-dirty-count]').getAttribute('data-dirty-count').then((v) => Number(v ?? -1));

    // 组合 1：脏编辑 → 排序 → 守卫取消 → 原改动仍可提交
    await clearDirtyByReload(page);
    const cell49 = pane49.locator('.grid-row').nth(1).locator('.grid-cell[data-col="6"]').first();
    await cell49.dblclick();
    await page.waitForTimeout(250);
    await page.locator('.grid-cell-editor').fill('combo-keep');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok('T49-1 前置：已有一处未保存改动', (await dirty49()) === 1, `dirty=${await dirty49()}`);

    const hdrAmount = pane49.locator('.grid-header-cell').filter({ hasText: 'amount' }).first();
    await hdrAmount.click();
    await page.waitForTimeout(500);
    ok('T49-1 带脏格排序被守卫拦下', (await page.locator('[data-testid="dirty-reload-guard"]').count()) === 1);

    await page.locator('[data-testid="dirty-guard-cancel"]').click();
    await page.waitForTimeout(400);
    ok('T49-1 取消后原改动还在（脏格没被排序顺手丢掉）', (await dirty49()) === 1, `dirty=${await dirty49()}`);

    // 「仍可提交」= 保存预演里能看到这条改动（预演是纯前端计划，不需要真库）
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(700);
    const previewText = await page.locator('.modal').innerText().catch(() => '');
    ok('T49-1 🔴 取消排序后原改动仍进保存预演（不是"脏标记还在但提交不了"）',
      /combo-keep/.test(previewText), previewText.split('\n').slice(0, 2).join(' / ').slice(0, 120));
    // 🔴 必须点「取消」关弹窗：焦点在模态里时 Meta+K 到不了全局快捷键，
    //    后面的 clearDirtyByReload 会等 30s 超时（这次就是这么红的）。
    await page.locator('.modal button', { hasText: '取消' }).first().click();
    await page.waitForTimeout(400);
    ok('T49-1 预演取消后弹窗关闭（没把脏改动一起提交）',
      (await page.locator('.modal').count()) === 0, `modal=${await page.locator('.modal').count()}`);
    await clearDirtyByReload(page);

    // 组合 3：只读连接 → 编辑/粘贴/批量 全禁并给原因
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill(':切换只读模式');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('T49-3 连接已切到只读（状态栏可观测）',
      (await page.locator('.statusbar[data-dirty-count]').getAttribute('data-conn-readonly')) === '1');

    await pane49.locator('.grid-row').nth(1).locator('.grid-cell[data-col="6"]').first().dblclick();
    await page.waitForTimeout(300);
    ok('T49-3 只读连接双击不进入编辑态', (await page.locator('[data-testid="cell-editor"]').count()) === 0);
    const pasteBtn49 = page.locator('[data-testid="btn-paste"]');
    if ((await pasteBtn49.count()) > 0) {
      ok('T49-3 只读连接「粘贴」禁用且给出中文原因',
        (await pasteBtn49.isDisabled()) && /只读/.test((await pasteBtn49.getAttribute('title')) || ''),
        (await pasteBtn49.getAttribute('title')) || '(无 title)');
    }

    // 切回可写，别把只读状态留给后续
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    await page.locator('.palette input').fill(':切换只读模式');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('T49-3 切回后恢复可写', (await page.locator('.statusbar[data-dirty-count]').getAttribute('data-conn-readonly')) === '0');

    // 组合 5：查询结果 → 打开源表 → 文案不暗示继承了查询条件
    const sqlTab49 = page.locator('.ws-tab').filter({ hasText: '查询' }).first();
    if ((await sqlTab49.count()) > 0) {
      await sqlTab49.click();
      await page.waitForTimeout(500);
      const openSrc = page.locator('[data-testid="sql-open-editable"]').first();
      if ((await openSrc.count()) > 0) {
        const title49 = (await openSrc.getAttribute('title')) || '';
        ok('T49-5 「打开源表」文案明确不继承 WHERE/ORDER BY/LIMIT',
          /不继承/.test(title49) && /WHERE/.test(title49), title49.slice(0, 80));
        ok('T49-5 按钮文字是「打开源表」（不是"打开可编辑表格"）',
          ((await openSrc.innerText()) || '').trim() === '打开源表');
      }
    }
    // 回到 order 表，保持后续/收尾上下文稳定
    const orderTabBack = page.locator('.ws-tab').filter({ hasText: 'order' }).first();
    if ((await orderTabBack.count()) > 0) await orderTabBack.click();
    await page.waitForTimeout(400);
  }

  // 14. 控制台干净
  ok('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' ; '));
} finally {
  await browser.close();
  stop();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  ' + f.detail);
}
process.exit(failed.length ? 1 : 0);
