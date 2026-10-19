/**
 * 安装包真机验收 —— 驱动 /Applications/DB Studio.app（真实打包产物 + 真实 userData）
 *
 * 与 e2e-app.mjs 的区别：那个脚本用仓库内 Electron + 一次性临时 userData 验证 IPC 接线；
 * 这个脚本模拟「真实用户第一次坐下来用装好的应用」：
 *   新建连接（逐键中文输入）→ 测试连接（真库）→ 保存 → 单击连接 → 展开库 → 选中表
 *   → 打开网格 → 拖动分栏 → 新建查询执行 SQL → 删除测试连接（收尾不污染）。
 *
 * 用法：node scripts/verify-installed.mjs
 * 环境变量：
 *   DB_STUDIO_INSTALLED_APP  被测 .app 路径（默认 /Applications/DB Studio.app）
 *   VERIFY_SKIP_DELETE=1     收尾不删除测试连接（保留给用户肉眼复核）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.DB_STUDIO_INSTALLED_APP ?? '/Applications/DB Studio.app';
const BIN = join(APP, 'Contents/MacOS/DB Studio');
const FIXTURE = { host: '127.0.0.1', port: 13306, user: 'root', password: 'dbstudio_local_2026' };
const CONN_NAME = '真机验证-中文';

if (!existsSync(BIN)) {
  console.log(`⏭️  跳过：找不到已安装应用 ${BIN}`);
  process.exit(0);
}

let chromium;
try {
  const mod = await import('playwright-core');
  chromium = mod.chromium;
} catch {
  console.log('⏭️  跳过：未安装 playwright-core');
  process.exit(0);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ⚠️ 不设 DB_STUDIO_E2E_USER_DATA：走真实 userData（用户实际的数据目录）。
// 单实例锁保持开启：真机上就是单实例。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// ⚠️ 宿主的 NODE_OPTIONS 注入（node-language-shim.cjs，IDE 沙箱专用）对打包应用无意义，
//    会触发 Electron 的 "Most NODE_OPTIONs are not supported in packaged apps" ERROR 噪音
//    （真机验收输出里容易被误读成被测应用的问题）。清掉，让被测环境等价于用户双击启动。
delete childEnv.NODE_OPTIONS;

/**
 * 启动方式：手动 spawn + CDP 直连（connectOverCDP）。
 *
 * 🔴 为什么不用 playwright 的 electron.launch：实测（2026-09-27，macOS 27 +
 *    Electron 44.4.3 打包产物）它的 target 自动附加机制会把 Chromium 网络
 *    服务杀成 crash-restart 死循环，file:// 页面永远加载不出来，firstWindow
 *    60s 超时；而【手动拉起同一进程】完全健康（窗口正常、页面 target 正常、
 *    零崩溃）。仓库内 Electron（e2e-app.mjs）走 electron.launch 无此问题，
 *    是打包 bundle 特有的组合行为。connectOverCDP 只连 browser 端点、不做
 *    自动附加，绕开整类问题。
 */
const { spawn } = await import('node:child_process');
const child = spawn(BIN, ['--no-sandbox', '--remote-debugging-port=0'], {
  env: childEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.on('exit', (code) => console.log(`[main] 进程退出：code=${code}`));

/** 从 stderr 解析 DevTools 的 browser 端 ws 地址（--remote-debugging-port=0 时系统分配） */
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('30s 内未等到 DevTools ws 地址（应用可能没起来）')), 30_000);
  child.stderr.on('data', (d) => {
    process.stderr.write(`[main:err] ${d}`);
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

/**
 * 🔴 冷启动窗口：拿到 ws 地址 ≠ 握手可用。
 *
 * 现场（2026-09-29，0.5.0 刚覆盖安装完的**第一次**跑）：stderr 已打印 DevTools 地址、
 * HTTP `/json/version` 也返回 200，但 `connectOverCDP` 卡在 `<ws connecting>` 直到 30s 超时；
 * 同一份脚本、同一个包，**第二次**跑就 22/22 全绿。
 *
 * 也就是说「HTTP 端点 200」和「ws 握手成功」之间有一个冷启动窗口（首次启动要建
 * userData、初始化窗口/玻璃效果，主线程没空完成握手）。不加固的后果很坏：
 * 每次装完新包第一次验收都会红一次，而它长得完全像「新包有缺陷」。
 *
 * 对策：先轮询 HTTP 端点探活，再带重试地 connectOverCDP（每次失败都重新建连）。
 */
const httpEndpoint = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');

/**
 * 🔴 现场诊断（2026-10-18）：`connectOverCDP` 报 "Timeout 20000ms exceeded" 时，
 * 早先只打一行超时，三种完全不同的原因长得一模一样：
 *   a) HTTP 端点不通（进程在但 DevTools 服务没起）；
 *   b) HTTP 通、ws 握手被拒（主线程忙/协议不匹配）；
 *   c) 握手通、但**没有 page target**（窗口没建出来）。
 * 三者处置完全不同（改启动参数 / 看主线程 / 看窗口创建），所以先把事实打出来。
 */
async function dumpDevToolsState(tag) {
  // 🔴 每个请求都要自带超时：后端不响应时（锁屏/主线程卡住）裸 fetch 会一直挂着，
  //    诊断代码本身变成新的卡点 —— 那是我们刚刚踩过的坑。
  const signal = () => AbortSignal.timeout(3000);
  const version = await fetch(`${httpEndpoint}/json/version`, { signal: signal() })
    .then(async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
    .catch((e) => `失败: ${String(e.message).split('\n')[0]}`);
  const targets = await fetch(`${httpEndpoint}/json/list`, { signal: signal() })
    .then(async (r) => {
      const txt = await r.text();
      try {
        const arr = JSON.parse(txt);
        return `HTTP ${r.status} targets=${arr.length} types=${JSON.stringify(arr.map((t) => t.type))} urls=${JSON.stringify(arr.map((t) => String(t.url).slice(0, 40)))}`;
      } catch {
        return `HTTP ${r.status} 非 JSON: ${txt.slice(0, 120)}`;
      }
    })
    .catch((e) => `失败: ${String(e.message).split('\n')[0]}`);
  console.log(`[cdp:${tag}] ${httpEndpoint}`);
  console.log(`[cdp:${tag}] /json/version → ${version}`);
  console.log(`[cdp:${tag}] /json/list → ${targets}`);
}

let browser = null;
for (let attempt = 1; attempt <= 3 && !browser; attempt++) {
  // 探活：端点能答 200 才开始握手
  let alive = false;
  for (let i = 0; i < 40; i++) {
    // 单次 3s 超时：连不上时快速失败，别让 40 次轮询变成十几分钟的静默等待
    alive = await fetch(`${httpEndpoint}/json/version`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!alive) {
    console.log(`[cdp] 探活 20s 未通过（第 ${attempt} 次）`);
    await dumpDevToolsState('probe-fail');
    continue;
  }
  try {
    browser = await chromium.connectOverCDP(wsUrl, { timeout: 20_000 });
  } catch (e) {
    console.log(`[cdp] 第 ${attempt} 次连接失败：${String(e.message).split('\n')[0]}`);
    await dumpDevToolsState(`fail${attempt}`);
    if (attempt === 3) throw e;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const context = browser.contexts()[0] ?? (await browser.newContext());
let page = context.pages()[0] ?? null;
for (let i = 0; i < 50 && !page; i++) {
  await new Promise((r) => setTimeout(r, 200));
  page = context.pages()[0] ?? null;
}
if (!page) throw new Error('CDP 已连接但等不到页面 target');
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
// 本脚本只会遇到 window.confirm（删除确认）—— 全局统一接受，避免 once 处理器重复 accept
page.on('dialog', (d) => void d.accept().catch(() => {}));

// ---------- 0. 版本号一致性：装进 /Applications 的版本必须等于根 package.json ----------
/**
 * 🔴 版本号只有一个来源：根 `package.json` 的 `version`（electron-builder 把它写进
 *    Info.plist 的 CFBundleShortVersionString）。升了版本号却没重打包 / 没覆盖安装，
 *    界面上完全看不出来 —— 只能靠这条断言第一个红。
 *    放在最前面：版本不对时后面的行为断言都不必看。
 */
try {
  const { execFileSync } = await import('node:child_process');
  const installed = execFileSync(
    'defaults',
    ['read', join(APP, 'Contents/Info.plist'), 'CFBundleShortVersionString'],
    { encoding: 'utf8' },
  ).trim();
  const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  ok(
    '🔴 已安装版本 = package.json 版本（版本号升级已进包）',
    installed === declared,
    `installed=${installed} declared=${declared}`,
  );
} catch (e) {
  ok('🔴 已安装版本 = package.json 版本（版本号升级已进包）', false, String(e?.message ?? e));
}

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar', { timeout: 20_000 });
  ok('已安装应用启动并渲染主界面', true, APP);

  const envTag = (await page.locator('.env-tag').textContent().catch(() => '') ?? '').trim();
  ok('跑在真 IPC 环境', envTag === 'IPC', `env-tag=${envTag}`);

  // ---------- 0. 清理上一轮残留的同名测试连接（重跑幂等） ----------
  for (let i = 0; i < 5; i++) {
    const stale = page.locator('.tree-row', { hasText: CONN_NAME }).first();
    if ((await stale.count()) === 0) break;
    await stale.hover();
    await page.locator(`[data-testid="btn-del-conn-${CONN_NAME}"]`).first().click();
    await page.waitForTimeout(800);
  }

  // ---------- 1. 新建连接对话框：中文逐键输入 + 焦点稳定 ----------
  await page.locator('[data-testid="btn-new-connection"]').click();
  await page.waitForSelector('.connection-editor', { timeout: 15_000 });
  ok('新建连接弹窗打开', true);

  // 逐键输入中文（delay 模拟真人；旧缺陷下每次按键整树重挂，字符丢失/焦点飞走）
  const nameInput = page.locator('.ce-field', { hasText: '连接名' }).locator('input');
  await nameInput.click();
  await page.keyboard.type(CONN_NAME, { delay: 70 });
  const nameVal = await nameInput.inputValue();
  ok('🔴 连接名中文逐键输入完整（IME 不再被打断）', nameVal === CONN_NAME, JSON.stringify(nameVal));

  // 焦点稳定：在主机框逐键输入后，焦点必须仍在主机框（先全选替换预填值，真实用户习惯）
  const hostInput = page.locator('.ce-field', { hasText: /^主机/ }).first().locator('input');
  await hostInput.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type(FIXTURE.host, { delay: 40 });
  const focusField = await page.evaluate(
    () => document.activeElement?.closest('.ce-field')?.getAttribute('data-field') ?? '(none)',
  );
  ok('🔴 主机框打字后焦点不被吸回连接名', focusField === 'host', `focus=${focusField}`);
  const hostVal = await hostInput.inputValue();
  ok('主机值完整', hostVal === FIXTURE.host, hostVal);

  await page.locator('.ce-field', { hasText: '端口' }).locator('input').fill(String(FIXTURE.port));
  await page.locator('.ce-field', { hasText: '用户名' }).locator('input').fill(FIXTURE.user);
  await page.locator('.ce-secret input').first().fill(FIXTURE.password);
  await page.waitForTimeout(300);

  // ---------- 2. 测试连接（真库） ----------
  await page.locator('.connection-editor footer button', { hasText: '测试连接' }).click();
  await page.waitForSelector('.ce-issues.ok, .ce-issues.error', { timeout: 15_000 });
  const testMsg = await page.locator('.ce-issues.ok, .ce-issues.error').last().innerText();
  ok('测试连接对真库返回成功', /连接成功/.test(testMsg), testMsg.slice(0, 60));

  // ---------- 3. 保存 → 树里出现新连接 ----------
  await page.locator('.connection-editor footer button.primary').click();
  // 🔴 超时时先 dump 弹窗现场（有无「保存失败：」红字），别对着一句 timeout 猜
  try {
    await page.waitForSelector('.connection-editor', { state: 'detached', timeout: 20_000 });
  } catch {
    const dump = await page
      .evaluate(() => {
        const modal = document.querySelector('.connection-editor');
        return {
          issues: [...document.querySelectorAll('.connection-editor .ce-issues')].map((n) => n.textContent),
          modalTail: modal?.textContent?.slice(-260) ?? null,
        };
      })
      .catch(() => null);
    console.error('❌ 保存后弹窗未关闭，现场：', JSON.stringify(dump));
    throw new Error('保存后弹窗未关闭（现场已打印）');
  }
  ok('保存后弹窗关闭', true);
  await page.waitForTimeout(600);
  const newConnRow = page.locator('.tree-row', { hasText: CONN_NAME }).first();
  ok('新连接出现在连接树', (await newConnRow.count()) > 0);

  // ---------- 3.5 🔴 回归（用户反馈 2026-09-26）：右键新建查询后【直接执行】——
  // 树上的库表列表可能来自磁盘快照，会话并未真正建立；执行必须自动握手，
  // 而不是甩一句「连接未建立」。
  {
    await newConnRow.click({ button: 'right' });
    await page.waitForSelector('.ctx-menu', { timeout: 5_000 });
    await page.locator('.ctx-item', { hasText: '新建查询' }).click();
    await page.waitForSelector('.cm-editor >> visible=true', { timeout: 15_000 });
    // 🔴 限定可见 pane：会话恢复带回的隐藏查询 tab 里也有同款 DOM，泛匹配会点到隐藏元素
    await page.locator('.cm-editor:visible .cm-content').first().click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1 AS ok_col;');
    await page.waitForTimeout(200);
    // 语义钩子（文案会随 T29 演进，别再绑死「▶ 执行 ⌘R」）
    await page.locator('[data-testid="sql-run-all"]:visible').last().click();
    await page.waitForSelector('.sql-message >> visible=true', { timeout: 20_000 });
    await page.waitForTimeout(400);
    const runMsg = await page.locator('.sql-message:visible').last().innerText();
    const errBanner = await page.locator('.sql-results:visible .banner.warn').allInnerTexts().catch(() => []);
    ok('🔴 右键新建查询后直接执行：自动建立连接不报「连接未建立」',
      /1 行/.test(runMsg) && !/连接未建立/.test(errBanner.join(' ')),
      `${runMsg.replace(/\n/g, ' ').slice(0, 30)}${errBanner.join(' ').slice(0, 60)}`);

    // 结果页签可关闭（用户反馈 2026-09-26）
    const tabsBefore = await page.locator('[data-testid="sql-result-tabs"] .sql-tab').count();
    await page.locator('[data-testid^="sql-result-close-"]:visible').last().click();
    await page.waitForTimeout(250);
    const tabsAfter = await page.locator('[data-testid="sql-result-tabs"] .sql-tab').count();
    ok('结果页签可关闭', tabsBefore >= 1 && tabsAfter === tabsBefore - 1, `${tabsBefore} → ${tabsAfter}`);
  }

  // ---------- 4. 单击连接 → 连接成功 → 自动展开库 ----------
  await newConnRow.click();
  await page.waitForSelector('.tree-row .tree-label:visible', { timeout: 500 }).catch(() => {});
  // 等握手 + schema 拉取完成（连接状态点变绿 + 库节点出现）
  let dbsVisible = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    dbsVisible = (await page.locator('.tree-row', { hasText: 'verify_ui' }).count()) > 0;
    if (dbsVisible) break;
  }
  ok('🔴 单击连接节点即完成握手且库自动展开', dbsVisible, 'verify_ui 库节点可见');

  // ---------- 5. 单击库 → 展开 → 双击表打开网格 ----------
  // ⚠️ 定位必须限定在 verify_ui 子树内（按 DOM 顺序取其后代行）：
  // 真实 userData 里有用户自己的连接，树展开记忆会让其他连接的
  // 「表」类别行也在 DOM 里，泛匹配 .first() 会点错行。
  const dbRow = page.locator('.tree-row', { hasText: 'verify_ui' }).first();
  await dbRow.click();
  await page.waitForTimeout(400);

  /** 在 verify_ui 子树内按标签精确找行,返回 DOM 下标(-1=没有)。泛匹配会误中用户其他连接的同名行 */
  const findRowIdxInVerifySubtree = (label) =>
    page.evaluate((lbl) => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const dbIdx = rows.findIndex((r) => r.textContent?.includes('verify_ui'));
      if (dbIdx < 0) return -1;
      const hit = rows.slice(dbIdx + 1).find((r) => r.querySelector('.tree-label')?.textContent?.trim() === lbl);
      return hit ? rows.indexOf(hit) : -1;
    }, label);

  const kindIdx = await findRowIdxInVerifySubtree('表');
  ok('单击库节点展开出「表/视图」类别', kindIdx >= 0);
  if (kindIdx >= 0) {
    await page.locator('.tree-row').nth(kindIdx).locator('.tree-caret').click();
    await page.waitForTimeout(400);
  }

  const orderIdx = await findRowIdxInVerifySubtree('order');
  ok('表节点可见', orderIdx >= 0);
  if (orderIdx < 0) throw new Error('verify_ui.order 节点不可见，后续断言无意义');
  await page.locator('.tree-row').nth(orderIdx).dblclick();
  await page.waitForSelector('.grid-row', { timeout: 15_000 });
  ok('🔴 双击表节点网格载入数据', (await page.locator('.grid-row').count()) > 0,
    `${await page.locator('.grid-row').count()} 行`);
  // 中文数据保真：第一行 customer 列应显示「顾小美」
  const firstCellText = await page.locator('.grid-row').first().innerText();
  ok('中文数据在网格中正确显示（含 NULL 区分）', /顾小美/.test(firstCellText), firstCellText.replace(/\n/g, ' ').slice(0, 40));

  // ---------- 6. 拖动分栏调整宽度 ----------
  const sbBefore = await page.evaluate(() => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0);
  const r1 = await page.locator('.panel-resizer').first().boundingBox();
  await page.mouse.move(r1.x + r1.width / 2, r1.y + 300);
  await page.mouse.down();
  await page.mouse.move(r1.x + r1.width / 2 + 70, r1.y + 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const sbAfter = await page.evaluate(() => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0);
  ok('🔴 拖动分隔条加宽侧栏（真实鼠标事件）', sbAfter > sbBefore + 50, `${sbBefore} → ${sbAfter}`);
  // 拖回去，避免留下一个怪布局
  const r2 = await page.locator('.panel-resizer').first().boundingBox();
  await page.mouse.move(r2.x + r2.width / 2, r2.y + 300);
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.width / 2 - (sbAfter - sbBefore), r2.y + 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  // ---------- 7. 新建查询 → 执行 SQL → 出结果 ----------
  // ⚠️ 3.5 已留了一个查询 tab:所有编辑器定位必须限定到【当前可见 pane】,
  // 否则 .cm-editor 命中隐藏 pane 里的第一个,waitForSelector(visible) 永远等不到
  const activePane = page.locator('.ws-tab-pane:not(.hidden)');
  await page.keyboard.press('Meta+t');
  await page.waitForSelector('.ws-tab-pane:not(.hidden) .cm-editor', { timeout: 15_000 });
  await activePane.locator('.cm-content').click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('SELECT customer, amount, note FROM `order` LIMIT 3;');
  await page.waitForTimeout(300);
  const editorDump = await activePane.locator('.cm-content').innerText().catch(() => '(读取失败)');
  console.log(`   ℹ️ 编辑器实际内容: ${JSON.stringify(editorDump.slice(0, 120))}`);
  await activePane.locator('[data-testid="sql-run-all"]').click();
  await activePane.locator('.sql-message').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  const msg = await activePane.locator('.sql-message').innerText();
  // 失败时把错误横幅原文抓出来，别对着一句"执行失败"猜
  const errDetail = await activePane
    .locator('.sql-results .banner.warn')
    .allInnerTexts()
    .catch(() => []);
  ok('SQL 编辑器对真库执行返回结果', /行|成功/.test(msg) && !/失败/.test(msg),
    `${msg.replace(/\n/g, ' ').slice(0, 50)}${/失败/.test(msg) ? ' | ' + errDetail.join(' ').slice(0, 200) : ''}`);
  const resultText = (await page.locator('.app').innerText().catch(() => ''));
  ok('查询结果含中文数据（数据保真）', /顾小美/.test(resultText), '');

  // ---------- 8. 控制台干净 ----------
  ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));

  // ---------- 收尾：删除测试连接（不污染真实 userData） ----------
  if (process.env.VERIFY_SKIP_DELETE === '1') {
    console.log('ℹ️ VERIFY_SKIP_DELETE=1，保留测试连接供肉眼复核');
  } else {
    const del = page.locator(`[data-testid="btn-del-conn-${CONN_NAME}"]`);
    await newConnRow.hover();
    await page.waitForTimeout(200);
    await del.click();
    await page.waitForTimeout(800);
    const gone = (await page.locator('.tree-row', { hasText: CONN_NAME }).count()) === 0;
    ok('删除测试连接（收尾不污染）', gone);
    if (!gone) {
      await newConnRow.hover();
      await page.locator(`[data-testid="btn-del-conn-${CONN_NAME}"]`).click().catch(() => {});
      await page.waitForTimeout(800);
      ok('删除测试连接（重试）', (await page.locator('.tree-row', { hasText: CONN_NAME }).count()) === 0);
    }
  }
} finally {
  // connectOverCDP 的 close 只断开连接不杀应用；进程由我们自己收
  await browser.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name);
  process.exit(1);
}
