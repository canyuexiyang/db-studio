/**
 * 公开素材重截（P2-18g）—— 用**隔离的 user-data-dir** 起真应用、连真 fixture，
 * 重拍 docs/design-mockups/shots-installed/ 下的界面截图。
 *
 * 为什么必须重截：旧素材的状态栏连接名是 `localhost-3306-root-123456`
 * （fixture 的命名习惯把密码写进了名字），公开素材里出现这个字样，
 * 读者会合理地以为截图里的应用"存了明文密码"——观感事故。
 *
 * 🔴 本脚本**绝不触碰**用户真实的 userData（~/Library/Application Support/DB Studio）：
 *    连接是在临时 userData 里用 IPC 现建的，名字是干净的「本地 MySQL 8.0」。
 *    隔离口径与 e2e-app 相同（DB_STUDIO_E2E_USER_DATA + --user-data-dir）。
 *
 * 用法：npm run build 之后 node scripts/reshoot-shots.mjs
 * 覆盖文件：1-main-light / 2-main-dark / 3-connection-editor /
 *          4-tree-connected / 4b-context-menu / 6-sql-editor-db-select
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const OUT = join(ROOT, 'docs/design-mockups/shots-installed');

const FIXTURE = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

let electron;
try {
  const mod = await import('playwright-core');
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过：未安装 playwright-core');
  process.exit(0);
}

// fixture 可达性（连不上的截图是摆拍，宁可不拍）
const net = await import('node:net');
const reachable = await new Promise((resolve) => {
  const s = net.createConnection({ host: FIXTURE.host, port: FIXTURE.port });
  s.once('connect', () => { s.end(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (!reachable) {
  console.log(`⏭️  跳过：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

const electronPath = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(electronPath)) {
  console.log('⏭️  跳过：找不到 Electron 可执行文件');
  process.exit(0);
}
if (!existsSync(join(DESKTOP, 'dist/main/main.cjs'))) {
  console.log('⏭️  跳过：没有构建产物（先 npm run build）');
  process.exit(0);
}

// 造一个像样的演示库（幂等：已存在就重建）
const { MySqlDriver } = await import('../packages/core-driver-mysql/src/index.ts');
const admin = new MySqlDriver(FIXTURE, {});
try {
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS orders_demo');
  await admin.query('CREATE DATABASE orders_demo');
  await admin.query('USE `orders_demo`');
  await admin.query(`CREATE TABLE orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'paid',
    amount DECIMAL(10,2) NOT NULL,
    created_at DATETIME NOT NULL
  )`);
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    const status = i % 3 === 0 ? 'refunded' : i % 5 === 0 ? 'pending' : 'paid';
    rows.push(`('客户 ${String(i).padStart(2, '0')}', '${status}', '${(i * 12.5).toFixed(2)}', '2026-09-${String((i % 28) + 1).padStart(2, '0')} 10:0${i % 10}:00')`);
  }
  await admin.query(`INSERT INTO orders (customer, status, amount, created_at) VALUES ${rows.join(',')}`);
} finally {
  await admin.close().catch(() => {});
}

const userData = mkdtempSync(join(tmpdir(), 'dbstudio-shots-'));
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let app;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', `--user-data-dir=${userData}`, join(DESKTOP, 'dist/main/main.cjs')],
    env: {
      ...childEnv,
      DB_STUDIO_E2E_USER_DATA: userData,
      DB_STUDIO_NO_SINGLE_LOCK: '1',
      NODE_ENV: 'production',
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1052, 620);
  });
  await page.setViewportSize?.({ width: 1052, height: 620 }).catch?.(() => {});

  // 1) 建一条**干净命名**的连接并连上（密码只出现在 IPC 内存里，不落 userData 明文）
  const created = await page.evaluate(async (fixture) => {
    const r = await window.dbStudio.connCreate({
      config: {
        id: 'shots-mysql',
        name: '本地 MySQL 8.0',
        type: 'mysql',
        host: fixture.host,
        port: fixture.port,
        user: fixture.user,
        defaultDatabase: 'orders_demo',
        group: '开发',
        colorTag: 'blue',
        note: null,
        readOnly: false,
        ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
        ssl: { enabled: false, caPath: null, certPath: null, keyPath: null, rejectUnauthorized: true },
        idleTimeoutMs: 7_200_000,
      },
      password: fixture.password,
    });
    return r.ok;
  }, FIXTURE);
  if (!created) throw new Error('连接创建失败');
  const connected = await page.evaluate(async (fixture) => {
    const r = await window.dbStudio.connConnect('shots-mysql', fixture.password);
    return r.ok === true || r.data?.ok === true || r.ok === undefined;
  }, FIXTURE);
  if (!connected) throw new Error('连接失败');

  // 渲染层的连接列表是启动时读的 —— reload 一次让左树看到新连接
  await page.reload();
  await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
  await page.waitForTimeout(1500);

  /**
   * 🔴 树的连接节点有没有 caret 取决于 **schema 快照是否非空**（buildTree 的
   * children 数量决定 hasChildren）。IPC 直连不会写快照，所以要在 IPC 里
   * 显式 schemaRefresh 一次，再 reload 让树带着快照重建 —— 否则连接节点
   * 连展开的箭头都没有，UI 层根本无从触发回源。
   */
  const loadSchemaAndReload = async () => {
    await page.evaluate(async (fixture) => {
      await window.dbStudio.connConnect('shots-mysql', fixture.password).catch(() => {});
      await window.dbStudio.schemaRefresh('shots-mysql');
    }, FIXTURE);
    await page.reload();
    await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
    await page.waitForTimeout(1500);
  };

  /** 点行首 caret 展开一层（caret 单击只切换展开，幂等；行必须可见才点得到） */
  const clickCaret = async (label, exact = false) => {
    const row = exact
      ? page.locator('.tree-row').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${label}$`) }) }).first()
      : page.locator('.tree-row', { hasText: label }).first();
    await row.waitFor({ state: 'visible', timeout: 6_000 });
    const caret = row.locator('.tree-caret').first();
    // 🔴 只在「未展开」时点：caret 单击是切换，对已展开的组再点一下就收起来了
    const title = await caret.getAttribute('title').catch(() => null);
    if (title !== '展开') return;
    await caret.click();
    await page.waitForTimeout(600);
  };

  /**
   * 🔴 用 Electron 自己的 capturePage 出片，不用 Playwright 的 page.screenshot。
   * 实测（深色主题 + 虚拟滚动网格）：page.screenshot 会拿到**过期的合成层** ——
   * DOM 计算样式已经是深色、状态栏也是深色，唯独网格那一大块 contain:paint
   * 层还是主题翻转前的白底。capturePage 走 webContents 的绘制结果，所见即所得。
   */
  const shoot = async (name) => {
    const p = join(OUT, name);
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const img = await w.webContents.capturePage();
      return img.toPNG().toString('base64');
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(p, Buffer.from(b64, 'base64'));
    const kb = Math.round(statSync(p).size / 1024);
    if (kb < 20) throw new Error(`${name} 疑似空白（${kb}KB）`);
    console.log(`📸 ${name}（${kb}KB）`);
  };

  const setTheme = async (theme) => {
    // 主题不走 prefs（那里面只有行高/确认项），是独立的 localStorage 键
    // （App.tsx 的 THEME_KEY = 'dbstudio.theme'）
    await page.evaluate((t) => {
      localStorage.setItem('dbstudio.theme', t);
    }, theme);
    await page.reload();
    await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
    await page.waitForTimeout(1500);
  };

  /** 首次展开连接会触发 schema 回源（快照为空时是网络往返），要给重试机会 */
  const clickCaretRetry = async (label, exact = false) => {
    for (let i = 0; i < 5; i++) {
      try { await clickCaret(label, exact); return; } catch { await page.waitForTimeout(1200); }
    }
    throw new Error(`展开「${label}」失败`);
  };

  const openOrders = async () => {
    // 🔴 顺序不能反：连接挂在「开发」组里，组不展开的话连接行根本不可见
    try { await clickCaret('开发'); } catch { /* 无分组时跳过 */ }
    await clickCaret('本地 MySQL 8.0');
    await clickCaretRetry('orders_demo');
    await clickCaretRetry('表', true); // 精确匹配「表」分组（避免命中「视图/存储过程」）
    const tableRow = page
      .locator('.tree-row')
      .filter({ has: page.locator('.tree-label', { hasText: /^orders$/ }) })
      .first();
    await tableRow.waitFor({ state: 'visible', timeout: 10_000 });
    await tableRow.dblclick();
    await page.waitForTimeout(2000);
  };

  // ---------- 4. 树已连接（先拍：还没开表，界面最干净） ----------
  await loadSchemaAndReload();
  await setTheme('light');
  try { await clickCaret('开发'); } catch { /* 无分组时跳过 */ }
  await clickCaretRetry('orders_demo');
  await shoot('4-tree-connected.png');

  // 4b. 右键菜单
  await clickCaretRetry('表', true); // 精确匹配「表」分组（避免命中「视图/存储过程」）
  const ordersRow = page
    .locator('.tree-row')
    .filter({ has: page.locator('.tree-label', { hasText: /^orders$/ }) })
    .first();
  await ordersRow.waitFor({ state: 'visible', timeout: 10_000 });
  await ordersRow.click({ button: 'right' });
  await page.waitForTimeout(400);
  await shoot('4b-context-menu.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---------- 1. 主界面（浅色，网格有数据） ----------
  await openOrders();
  await shoot('1-main-light.png');

  // ---------- 3. 连接编辑器 ----------
  const connRow = page.locator('.tree-row[data-node-kind="connection"]').first();
  await connRow.click({ button: 'right' });
  await page.waitForTimeout(300);
  await page.locator('.ctx-item', { hasText: '编辑连接…' }).click();
  await page.waitForTimeout(800);
  await shoot('3-connection-editor.png');
  // 关闭编辑器（按按钮，不按 Esc —— 焦点在输入框时 Esc 到不了全局）
  const cancel = page.locator('.modal button', { hasText: '取消' }).first();
  if (await cancel.count()) { await cancel.click(); } else { await page.keyboard.press('Escape'); }
  await page.waitForTimeout(500);

  // ---------- 6. SQL 编辑器（带库下拉） ----------
  await page.keyboard.press('Meta+t');
  await page.waitForTimeout(1000);
  const cm = page.locator('.ws-tab-pane:not(.hidden) .cm-content').first();
  await cm.click();
  // 会话恢复可能带回上次运行的查询标签与残留文本 —— 全选后整段替换
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('SELECT * FROM');
  await page.waitForTimeout(400);
  await shoot('6-sql-editor-db-select.png');

  // ---------- 2. 主界面（深色） ----------
  await setTheme('dark');
  await openOrders();
  // 🔴 主题真的切过去了才允许出片：查 :root 的 data-theme 与行底色。
  //    （第一版这里没守，截出来网格是白的 —— 素材自己都造假就没资格挂文档里。）
  const darkCheck = await page.evaluate(() => {
    const row = document.querySelector('.grid-row');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      rowBg: row ? getComputedStyle(row).backgroundColor : null,
      bodyColor: getComputedStyle(document.body).color,
    };
  });
  console.log('[dark check]', JSON.stringify(darkCheck));
  const chain = await page.evaluate(() => {
    const out = [];
    let el = document.elementFromPoint(600, 300);
    while (el && el !== document.documentElement && out.length < 10) {
      const cs = getComputedStyle(el);
      out.push(`${el.tagName}.${String(el.className).slice(0, 40)} bg=${cs.backgroundColor}`);
      el = el.parentElement;
    }
    return out;
  });
  console.log('[bg chain]', chain.join('\n'));
  if (darkCheck.theme !== 'dark') throw new Error(`深色未生效：data-theme=${darkCheck.theme}`);
  // 🔴 强制重栅格化：Electron 下大块 contain:paint 层在主题翻转后可能出旧纹理
  //    （DOM 计算样式已是深色、截出来的图网格却是白的），滚动一帧逼它重画。
  await page.evaluate(() => {
    const v = document.querySelector('.grid-viewport');
    if (v) v.scrollTop = 60;
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const v = document.querySelector('.grid-viewport');
    if (v) v.scrollTop = 0;
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(300);
  await shoot('2-main-dark.png');

  console.log('\n✅ 素材重截完成：' + OUT);
} catch (e) {
  console.error('❌ 重截失败：', e?.message ?? e);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
