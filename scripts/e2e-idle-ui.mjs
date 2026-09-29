/**
 * 真机验证：空闲断开后，状态栏是否如实显示「已断开」（v1.3 缺陷 1 的渲染层那一半）
 *
 * 缺陷 1 是两层叠加，另一半（主进程真断开 + 资源真释放 + 重连能出数据）由
 * `scripts/e2e-idle-reconnect.mjs` 在真库上验（16/16）。这一半**只能另起一个脚本**：
 *
 *  1. 状态栏的口径是 `sqlConnId = activeTab?.connId ?? connections[0]?.id`，
 *     而 React 的 `connections` 只在**启动时**读一次 —— 直接调 IPC 建连，
 *     主进程认、渲染层看不见，状态栏根本不会显示它。
 *     （试过在 e2e-app 里建完再 `page.reload()`：本应用的关闭守卫把 reload
 *      当成关窗，窗口直接没了 —— 所以只能在起应用之前预置 `connections.json`。）
 *  2. 预置一条连接会改变 e2e-app 里「无连接时执行按钮被禁用」那条断言的基线
 *     （它依赖「渲染层 connections 为空」这个前提）。改基线不如另起炉灶：
 *     两条断言各自守自己那一半，互不污染。
 *  3. UI 的空闲超时输入框按**分钟**填（最小 1 分钟），门禁等不起 60s，
 *     秒级只能从配置文件下手 —— 这也是这条必须真机跑、塞不进 e2e-ui 的原因。
 *
 * 📌 附带说明：「陈旧会话快照恢复出指向已删连接的标签」这个现场也是在这里抓到的，
 *    但它的守门断言在 `sessionSnapshot.test.ts`（纯函数 `restorePlan`）——
 *    往渲染层 localStorage 预置快照这条真机路径走不通（`addInitScript` 首帧写不进），
 *    硬留一条断言只会得到「注入失败 → 标签本来就是 0 → 恒真」的假绿。
 *
 * 运行：npm run e2e:idle:ui（会先 build）
 * 前置：docker dbstudio-mysql 在 13306 监听；缺 fixture / 缺 Electron / 没 build 就跳过（不算失败）
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');

const FIXTURE = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

/** 默认 3s：真机等 10 分钟进不了门禁，把时钟压到秒级跑同一条链路 */
const IDLE_MS = Number(process.env.DB_STUDIO_E2E_IDLE_MS ?? 3000);

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- 依赖检查：缺一样就跳过，不算失败 ----------
let electron;
try {
  const mod = await import('playwright-core');
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过空闲断开 UI 验证：未安装 playwright-core');
  process.exit(0);
}
if (!electron) {
  console.log('⏭️  跳过空闲断开 UI 验证：playwright-core 无 Electron 支持');
  process.exit(0);
}

const net = await import('node:net');
const fixtureAlive = await new Promise((resolve) => {
  const s = net.createConnection({ host: FIXTURE.host, port: FIXTURE.port });
  s.setTimeout(2000);
  s.on('connect', () => (s.destroy(), resolve(true)));
  s.on('error', () => resolve(false));
  s.on('timeout', () => (s.destroy(), resolve(false)));
});
if (!fixtureAlive) {
  console.log(`⏭️  跳过：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

function findElectron() {
  const p = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  return existsSync(p) ? p : undefined;
}
const electronPath = findElectron();
if (!electronPath) {
  console.log('⏭️  跳过：找不到 Electron 可执行文件');
  process.exit(0);
}
if (!existsSync(join(DESKTOP, 'dist/main/main.cjs'))) {
  console.log('⏭️  跳过：尚未 build（dist/main/main.cjs 不存在）');
  process.exit(0);
}

// ---------- 预置连接（必须在起应用之前）----------
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-idle-ui-'));
writeFileSync(
  join(userData, 'connections.json'),
  JSON.stringify(
    {
      version: 1,
      connections: [
        {
          id: 'e2e-idle-conn',
          name: 'e2e-idle',
          type: 'mysql',
          host: FIXTURE.host,
          port: FIXTURE.port,
          user: FIXTURE.user,
          // 预置配置里写不出 safeStorage 密文，走「每次手输」—— 建连时由脚本传密码
          passwordEnc: null,
          promptEveryTime: true,
          defaultDatabase: null,
          group: null,
          colorTag: null,
          note: null,
          readOnly: false,
          ssh: { enabled: false, host: '', port: 22, user: '', authType: 'privateKey', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
          ssl: { enabled: false, caPath: null, certPath: null, keyPath: null, rejectUnauthorized: true },
          idleTimeoutMs: IDLE_MS,
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

/**
 * ⚠️ 与 e2e-app 同口径：宿主环境若导出了 ELECTRON_RUN_AS_NODE，
 * Electron 会退化成纯 Node，require('electron') 直接 MODULE_NOT_FOUND。
 */
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronApp = await electron.launch({
  executablePath: electronPath,
  // --no-sandbox 的理由见 e2e-app.mjs：自动化宿主不允许 Chromium 再套一层沙箱。
  // --user-data-dir 必须一起给：渲染层 localStorage 不适用 DB_STUDIO_E2E_USER_DATA，
  //   不隔离就会恢复上一次运行留下的会话快照（详见 e2e-app.mjs 同名注释）。
  args: ['--no-sandbox', `--user-data-dir=${userData}`, join(DESKTOP, 'dist/main/main.cjs')],
  env: {
    ...childEnv,
    DB_STUDIO_E2E_USER_DATA: userData,
    DB_STUDIO_NO_SINGLE_LOCK: '1',
    NODE_ENV: 'production',
  },
  timeout: 60_000,
});

try {
  const page = await electronApp.firstWindow();
  await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
  await page.waitForSelector('.statusbar', { timeout: 10_000 });
  await page.waitForTimeout(1200); // 会话恢复是启动后的 effect，给它一拍

  const barText = async () =>
    (await page.locator('.statusbar').innerText().catch(() => '')).replace(/\s+/g, ' ');

  const listRes = await page.evaluate(() => window.dbStudio.connList());
  ok('渲染层启动即读到预置连接（状态栏口径 = connections[0]）',
    listRes?.data?.connections?.[0]?.id === 'e2e-idle-conn',
    `connections[0]=${listRes?.data?.connections?.[0]?.id}`);

  const c1 = await page.evaluate((pwd) => window.dbStudio.connConnect('e2e-idle-conn', pwd), FIXTURE.password);
  await page.waitForTimeout(300); // 状态推送是异步的，给 React 一帧
  const barConnected = await barText();
  ok('连接后状态栏显示「已连接」', c1?.ok === true && barConnected.includes('连接：已连接'), barConnected);

  await page.waitForTimeout(IDLE_MS + 2000);
  const barClosed = await barText();
  ok('🔴 空闲断开后状态栏如实显示「已断开」（渲染层订阅生效）',
    barClosed.includes('连接：已断开'), barClosed);

  const c2 = await page.evaluate((pwd) => window.dbStudio.connConnect('e2e-idle-conn', pwd), FIXTURE.password);
  await page.waitForTimeout(300);
  const barAgain = await barText();
  ok('重连后状态栏回到「已连接」', c2?.ok === true && barAgain.includes('连接：已连接'), barAgain);
} catch (e) {
  ok('未捕获异常', false, e instanceof Error ? e.message : String(e));
} finally {
  await electronApp.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} 空闲断开 UI 验证：${results.length - failed.length}/${results.length} 通过（idle=${IDLE_MS}ms）`);
process.exit(failed.length === 0 ? 0 : 1);
