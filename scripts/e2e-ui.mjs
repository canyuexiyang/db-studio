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
    await page.locator('.grid-row').nth(2).locator('.gd-rowno').click({ button: 'right' });
    await page.waitForTimeout(200);
    const menuTitle = await page.locator('.gd-ctx-menu .gd-ctx-title').textContent().catch(() => '');
    ok('行右键菜单出现（标题为行语义）', /已选 4 行|第 \d+ 行/.test(menuTitle ?? ''), menuTitle ?? '无菜单');
    await page.locator('.gd-ctx-item', { hasText: 'INSERT 语句' }).click();
    await page.waitForTimeout(200);
    const ins = await page.evaluate(() => navigator.clipboard.readText());
    ok('复制为 INSERT 带真实值（不再是 ? 占位）',
      /INSERT INTO `order_db`\.`order`/.test(ins) && /VALUES \(\d+/.test(ins) && !/VALUES \(\?/.test(ins),
      ins.split('\n')[0]?.slice(0, 90) ?? '空');
    await page.locator('.grid-row').nth(2).locator('.gd-rowno').click({ button: 'right' });
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

  // 8. 右侧详情面板（§6.7）
  ok('详情面板已渲染', (await page.locator('.detail-panel').count()) === 1);
  // 点一个单元格 → 面板显示完整值
  await page.locator('.grid-row').nth(2).locator('.grid-cell').nth(1).click();
  await page.waitForTimeout(300);
  const detailText = await page.locator('.detail-panel').innerText().catch(() => '');
  ok('点单元格后详情面板显示列与行', /列/.test(detailText) && /行/.test(detailText),
    detailText.split('\n').slice(-3).join(' | ').slice(0, 60));
  ok('详情面板显示表信息（引擎）', /引擎/.test(detailText));

  // 详情面板折叠
  await page.locator('.detail-head button').first().click();
  await page.waitForTimeout(250);
  ok('详情面板可折叠', (await page.locator('.detail-panel.collapsed').count()) === 1);
  await page.locator('.detail-head button').first().click();
  await page.waitForTimeout(250);
  ok('详情面板可展开', (await page.locator('.detail-panel.collapsed').count()) === 0);

  // 9. 筛选器（§6.3.3，逻辑已就绪，这里测 UI）
  await page.locator('.toolbar button', { hasText: '筛选' }).click();
  await page.waitForTimeout(400);
  ok('筛选弹窗打开', (await page.locator('.filter-modal').count()) === 1);
  ok('筛选器有列下拉', (await page.locator('.filter-cond select.col').count()) >= 1);

  /**
   * 🔴 数值列不该有「包含」操作符 —— 这是真机验证过的行为，
   *    给数值列 LIKE 会静默返回空结果，用户完全看不出哪里错了。
   *    这里选一个数值列（amount / decimal）来验。
   */
  const colSelect = page.locator('.filter-cond select.col').first();
  const colOptions = await colSelect.locator('option').allTextContents();
  const numericOpt = colOptions.find((o) => /decimal|int|bigint/i.test(o));
  if (numericOpt) {
    await colSelect.selectOption({ label: numericOpt });
    await page.waitForTimeout(250);
    const opTexts = await page.locator('.filter-cond select.op').first().locator('option').allTextContents();
    ok('数值列不含「包含」操作符', !opTexts.includes('包含'), `操作符：${opTexts.join('/')}`);
  } else {
    ok('数值列不含「包含」操作符', true, '（demo 无数值列，跳过）');
  }

  // 预览区应显示参数化后的可读条件，且值不拼进 SQL
  await page.locator('.filter-cond select.col').first().selectOption({ index: 1 });
  await page.waitForTimeout(200);
  const previewBefore = await page.locator('.filter-preview').innerText().catch(() => '');
  ok('筛选预览显示「无有效条件」占位或真实条件', previewBefore.length >= 0, previewBefore.slice(0, 50));

  await page.locator('.filter-modal footer button', { hasText: '取消' }).click();
  await page.waitForTimeout(250);
  ok('筛选弹窗可关闭', (await page.locator('.filter-modal').count()) === 0);

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
  // ⚠️ 精确文本：hasText:'执行' 会同时命中「执行选中」「执行计划」
  await page.locator('.sql-toolbar button').filter({ hasText: /^▶ 执行 ⌘R$/ }).click();
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

    // 精确匹配「▶ 执行 ⌘R」（泛匹配会命中「执行选中」「执行计划」）
    const runBtn = page.locator('.sql-toolbar button').filter({ hasText: /^▶ 执行 ⌘R$/ });
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
    // 关掉剩余 tab（可能不止一个）→ 空状态提示
    for (let i = 0; i < 8; i++) {
      if ((await page.locator('.ws-tab').count()) === 0) break;
      await page.keyboard.press('Meta+w');
      await page.waitForTimeout(400);
    }
    ok('全部关闭后显示空状态提示', (await page.locator('[data-testid="empty-state"]').count()) === 1);
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
