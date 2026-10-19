/**
 * T13 —— 真机（真 Electron）五焦点键盘矩阵验收
 *
 * ## 为什么必须是「真 Electron」而不是浏览器 harness
 *
 * `e2e-ui.mjs` 跑在纯 Chromium 里，穿不透两件事：
 *  1. **原生菜单 accelerator** 在 macOS 上由 NSMenu 在 NSApplication 层拦截，
 *     根本不进渲染进程 —— 浏览器 harness 永远看不到这条路径。
 *  2. **真实焦点流转**：React 事件批处理、`autoFocus` 在复用宿主节点时被跳过、
 *     弹窗抢焦点后 Esc 返回原焦点 —— 这些只有真窗口才有意义。
 *
 * ## 诚实边界（不许把「测不到」写成「测过了」）
 *
 * `page.keyboard.*` 走 CDP `Input.dispatchKeyEvent`，**不是** OS 级键盘事件，
 * 所以**原生菜单 accelerator 依然测不到** —— 那部分只能人工按（清单见
 * `docs/engineering/T13-键盘矩阵验收清单.md`，本脚本会在结尾打印待人工项）。
 *
 * 输入法组合期同样无法用 CDP 真实复现（`Input.imeSetComposition` 与
 * `isComposing` 的对应关系在不同 Chromium 版本上不一致），所以这里用
 * **合成 KeyboardEvent（显式 isComposing: true）** 验证我们自己的守卫，
 * 并且成对断言（组合期不提交 / 普通 Enter 提交）—— 只要守卫被删掉，前者立刻红。
 * 真实输入法仍需人工按一遍（清单里单列一行）。
 *
 * ## 断言纪律
 *
 * - 「恰好一个」而不是「至少一个」：唯一响应是 T13 的验收原话。
 * - 每个「不触发」断言都配一个「会触发」的对照，否则断言没有证伪能力。
 *
 * 运行：npm run e2e:keys（如需先构建，用 npm run e2e:keys:build）
 * 前置：docker dbstudio-mysql 在 13306；缺 playwright/Electron/fixture/产物则跳过（不算失败）
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

const results = [];
const skipped = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
/** 显式记录「本脚本覆盖不到的」，不与通过混计 —— 悄悄跳过 ≠ 通过 */
function manual(name, why) {
  skipped.push({ name, why });
  console.log(`🖐  ${name} —— 需人工：${why}`);
}

// ---------- 依赖检查：缺一样就跳过，不算失败 ----------
let electron;
try {
  const mod = await import('playwright-core');
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过键盘矩阵：未安装 playwright-core');
  process.exit(0);
}
if (!electron) {
  console.log('⏭️  跳过键盘矩阵：playwright-core 无 Electron 支持');
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
  console.log(`⏭️  跳过键盘矩阵：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

const electronPath = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(electronPath)) {
  console.log('⏭️  跳过键盘矩阵：找不到 Electron 可执行文件');
  process.exit(0);
}
if (!existsSync(join(DESKTOP, 'dist/main/main.cjs'))) {
  console.log('⏭️  跳过键盘矩阵：尚未 build（dist/main/main.cjs 不存在）');
  process.exit(0);
}

// ---------- 准备真库（写操作隔离在临时库里）----------
const { MySqlDriver } = await import('../packages/core-driver-mysql/src/index.ts');
const admin = new MySqlDriver(FIXTURE, {});
let dbName;
/** T14：只读连接指向的库（表名 ro_orders，避免与 orders 在同名定位上纠缠） */
let dbNameRo;
try {
  await admin.connect();
  dbName = `e2e_keys_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  await admin.query(`USE \`${dbName}\``);
  await admin.query(`
    CREATE TABLE \`orders\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(255) NULL
    )
  `);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push(`('${i % 2 ? 'new' : 'paid'}', ${(i * 1.5).toFixed(2)}, '备注 ${i}')`);
  }
  await admin.query(`INSERT INTO \`orders\` (status, amount, note) VALUES ${rows.join(',')}`);
  /**
   * T14 用的第二个库：表名刻意为 `ro_orders`（与 `orders` 不同名）。
   * 理由：树是扁平序列，两条连接都可能展开同名表 ——「第几个 orders」这种定位
   * 一改脚本顺序就失效。用唯一表名，K9 的定位就与其它段落无关。
   */
  dbNameRo = `${dbName}_ro`;
  await admin.query(`CREATE DATABASE \`${dbNameRo}\``);
  await admin.query(`USE \`${dbNameRo}\``);
  await admin.query(`
    CREATE TABLE \`ro_orders\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      note VARCHAR(255) NULL
    )
  `);
  await admin.query(`INSERT INTO \`ro_orders\` (status, note) VALUES ('new', '只读示例')`);
  console.log(`\n【准备】临时库 ${dbName}（orders 60 行，有主键 ⇒ 可编辑）+ ${dbNameRo}（ro_orders，只读连接用）`);
} finally {
  await admin.close().catch(() => {});
}

// ---------- 预置连接（必须在起应用之前）----------
// 为什么不能建完再 reload：本应用的关闭守卫把 reload 当成关窗，窗口直接没了。
// 详见 scripts/e2e-idle-ui.mjs 的注释。
const userData = mkdtempSync(join(tmpdir(), 'dbstudio-keys-'));
writeFileSync(
  join(userData, 'connections.json'),
  JSON.stringify(
    {
      version: 1,
      connections: [
        {
          id: 'e2e-keys-conn',
          name: 'e2e-keys',
          type: 'mysql',
          host: FIXTURE.host,
          port: FIXTURE.port,
          user: FIXTURE.user,
          passwordEnc: null,
          promptEveryTime: true,
          defaultDatabase: dbName,
          group: null,
          colorTag: null,
          note: null,
          readOnly: false,
          ssh: { enabled: false, host: '', port: 22, user: '', authType: 'privateKey', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
          ssl: { enabled: false, caPath: null, certPath: null, keyPath: null, rejectUnauthorized: true },
        },
        // T14：只读连接 —— 六类写入口应全部禁用并给出原因
        {
          id: 'e2e-keys-ro',
          name: 'e2e-keys-ro',
          type: 'mysql',
          host: FIXTURE.host,
          port: FIXTURE.port,
          user: FIXTURE.user,
          passwordEnc: null,
          promptEveryTime: true,
          defaultDatabase: dbNameRo,
          group: null,
          colorTag: null,
          note: null,
          readOnly: true,
          ssh: { enabled: false, host: '', port: 22, user: '', authType: 'privateKey', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
          ssl: { enabled: false, caPath: null, certPath: null, keyPath: null, rejectUnauthorized: true },
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronApp = await electron.launch({
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

const page = await electronApp.firstWindow();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

/** 标签数 / 脏改动角标 —— 这两条是「唯一响应」的客观计数源 */
const tabCount = () => page.locator('.ws-tab').count();
/** 标签上的脏点：只表示「这个标签脏了」，**不随脏格数增长**（一片标签 ≤ 1 个点） */
const dirtyBadges = () => page.locator('.ws-tab-dirty').count();
/**
 * 脏**单元格**数，从状态栏读。
 *
 * 🔴 断言「改了一格脏格数 +1」必须用这个 —— 用 `.ws-tab-dirty` 会错：
 *    该角标是**标签**上的一个点，同一标签里改 1 格和改 10 格都只显示 1 个点，
 *    `dirtyBadges()+1` 这种断言在同一标签内永远不成立（写断言时踩过）。
 */
const dirtyCells = async () => {
  const t = await page.locator('.statusbar').innerText();
  const m = /脏单元格：(\d+)/.exec(t.replace(/\n/g, ' '));
  return m ? Number(m[1]) : -1;
};
const gridSearch = () => page.locator('.gd-search').count();
const cellEditor = () => page.locator('[data-testid="cell-editor"]').count();

/**
 * 在树里定位「**某条连接、某个库**下的某个对象节点」。
 *
 * 🔴 为什么不能只按表名找（两个坑，都踩过）：
 *  1. 两条连接指向**同一个 MySQL 实例**，MySQL 里「连接可见的库」= 该实例上的全部库 ——
 *     也就是说 `e2e-keys` 同样看得到 `..._ro` 库、看得到 `ro_orders`。
 *     用 `.first()` 会命中**非只读连接**下的那一份，于是「只读」断言全跑错连接。
 *  2. 这台 fixture 上还累积着历史 e2e 跑出来的库，`orders` / `src` 这类通用表名
 *     在几十个库里都有（实测树 287 行）。只按表名找会命中**别的库**里的同名表，
 *     打开的既不是我们的临时表、也不是目标连接 —— 断言绿/红都无意义。
 *
 * 所以按「连接 → 库 → 对象」三级精确定位：靠 `.tree-row` 的
 * `data-node-kind` / `data-node-depth` 语义钩子（不靠观感），逐级收敛。
 */
async function findObjectRow(connName, dbName, tableName) {
  /**
   * 一次 evaluate 取回全部行的 {kind, depth, label}。
   * 🔴 不要逐行 `locator.nth(i).getAttribute()` —— 树有几百行，每行 3 次 CDP
   *    往返，单次定位能跑到几十秒（实测 287 行）。语义钩子照样用，只是批量取。
   */
  const flat = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tree-row')).map((el) => ({
      kind: el.getAttribute('data-node-kind') ?? '',
      depth: Number(el.getAttribute('data-node-depth') ?? -1),
      label: (el.querySelector('.tree-label')?.textContent ?? '').trim(),
    })),
  );
  const idx = locateInFlat(flat, connName, dbName, tableName);
  return idx >= 0 ? page.locator('.tree-row').nth(idx) : null;
}

/**
 * 纯函数版定位（与 DOM 解耦，便于单测）：
 * 「连接 → 库 → 对象」三级收敛，靠 depth 判断子树边界。
 */
export function locateInFlat(flat, connName, dbName, tableName) {
  let connIdx = -1;
  let connDepth = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].kind !== 'connection' || flat[i].label !== connName) continue;
    connIdx = i;
    connDepth = flat[i].depth;
    break;
  }
  if (connIdx < 0) return -1;

  let dbIdx = -1;
  for (let i = connIdx + 1; i < flat.length && flat[i].depth > connDepth; i++) {
    if (flat[i].kind === 'database' && flat[i].label === dbName) {
      dbIdx = i;
      break;
    }
  }
  if (dbIdx < 0) return -1;

  const dbDepth = flat[dbIdx].depth;
  for (let i = dbIdx + 1; i < flat.length && flat[i].depth > dbDepth; i++) {
    if (flat[i].kind === 'object' && flat[i].label === tableName) return i;
  }
  return -1;
}

/** 定位失败时的现场取证：「找不到」必须能看出为什么找不到（连接 + 库层足够定位问题） */
async function dumpTree(tag = '') {
  const flat = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tree-row')).map((el) => ({
      kind: el.getAttribute('data-node-kind') ?? '',
      depth: Number(el.getAttribute('data-node-depth') ?? -1),
      label: (el.querySelector('.tree-label')?.textContent ?? '').trim(),
    })),
  );
  const conns = flat
    .map((f, i) => ({ ...f, i }))
    .filter((f) => f.kind === 'connection')
    .map((f) => `#${f.i} ${f.label}`);
  const dbs = flat.filter((f) => f.kind === 'database').map((f) => f.label);
  console.log(`   [诊断] 树${tag} 共 ${flat.length} 行`);
  console.log(`   [诊断] 连接行：${conns.join(' | ')}`);
  console.log(`   [诊断] 库行(${dbs.length})：${dbs.slice(0, 80).join(' | ')}${dbs.length > 80 ? ' …' : ''}`);
}

/** 展开树：反复点「第一个仍是 ▸ 的 caret」直到没有 —— 单调收敛，不会来回抖 */
async function expandAll() {
  for (let k = 0; k < 500; k++) {
    const caret = page.locator('.tree-row .tree-caret', { hasText: '▸' }).first();
    if ((await caret.count()) === 0) return k;
    await caret.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(30);
  }
  return -1;
}

/** 在指定元素上派发一个「可指定组合状态」的 keydown */
async function dispatchKey(selector, init) {
  return page.evaluate(
    ({ sel, init: i }) => {
      const el = sel === 'window' ? window : document.querySelector(sel);
      if (!el) return false;
      // KeyboardEventInit 里 `isComposing` 是标准字段；keyCode 在 Chromium 里
      // 不接受构造参数，所以只依赖 isComposing（这与 Chromium 真实行为一致）。
      const ev = new KeyboardEvent('keydown', {
        key: i.key,
        code: i.code ?? i.key,
        bubbles: true,
        cancelable: true,
        isComposing: i.isComposing === true,
      });
      el.dispatchEvent(ev);
      return true;
    },
    { sel: selector, init },
  );
}

try {
  await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });
  await page.waitForSelector('.statusbar', { timeout: 10_000 });
  await page.waitForTimeout(800);

  // ---------- K0：建连 + 打开表标签 ----------
  console.log('\n【K0】准备：建连 → 展开树 → 打开可编辑表');
  const c = await page.evaluate((pwd) => window.dbStudio.connConnect('e2e-keys-conn', pwd), FIXTURE.password);
  ok('K0.1 connConnect 成功', c?.ok === true, c?.ok ? '' : String(c?.error?.message ?? ''));

  /**
   * 🔴 这里必须显式拉一次 schema。
   *
   * `connConnect` 只走主进程：连接建立了，但渲染层的 `schemas` 状态还是空的 ——
   * 树只画到「连接」这一层，库/表节点不存在（现场截图：连接已绿、树下一个子节点都没有）。
   * 走 UI 连接时这次 schema 拉取由 `onConnectNode` 顺带做掉，脚本绕过了它，
   * 就得自己补上，否则后续所有「树里选中表」的断言都会因为**前置条件不存在**而失败 ——
   * 那不是被测代码的缺陷，是脚本的准备步骤没做完。
   */
  await page.locator('[data-testid="btn-refresh-schema"]').click();
  await page.waitForTimeout(1500);
  await page.waitForSelector('.tree-row', { timeout: 20_000 });

  /**
   * 展开树必须「循环到没有 ▸ 为止」——固定次数会停在中间层：
   * 连接 → 库 → 分组（表/视图/过程/函数）→ 表，共三层。
   *
   * 🔴 而且**不能按下标正序点**：点完一个节点后新行会插到它后面，
   *    原先 `nth(i+1)` 指向的行已经变了，正序点会把刚展开的节点又收起，
   *    在「展开/收起」之间来回抖，最终可能停在**收起状态**。
   *    改成「反复点第一个仍是 ▸ 的 caret」→ 单调收敛（新露出的行只会排在其后）。
   */
  await expandAll();

  const tableNode = await findObjectRow('e2e-keys', dbName, 'orders');
  if (!tableNode) await dumpTree('定位失败');
  ok('K0.2 展开树后能定位到「e2e-keys → 临时库 → orders」节点', tableNode !== null);
  if (!tableNode) throw new Error('K0 前置条件缺失：树里没有 orders，后续断言无立足点');

  await tableNode.dblclick();
  await page.waitForSelector('.grid-row', { timeout: 20_000 });
  ok('K0.3 双击表节点后网格载入数据', (await page.locator('.grid-row').count()) > 0, `${await page.locator('.grid-row').count()} 行`);
  await page.waitForTimeout(400);
  const statusText = await page.locator('.statusbar').innerText();
  ok('K0.4 打开的是可定位表（状态栏「定位键：有」）', statusText.includes('定位键：有'), statusText.replace(/\n/g, ' '));
  // T14：只读连接下「定位键」与「可写」必须分开表达
  ok('K0.5 非只读连接下「可写：是」且无只读横幅',
    statusText.includes('可写：是') && (await page.locator('[data-testid="readonly-banner"]').count()) === 0,
    statusText.replace(/\n/g, ' '));

  // ---------- K1：焦点在「树」 ----------
  console.log('\n【K1】焦点在树');
  {
    await page.locator('.tree').focus().catch(() => {});
    const before = await tabCount();
    await page.keyboard.press('Meta+t');
    await page.waitForTimeout(500);
    ok('K1.1 树里 ⌘T 恰好新建 1 个查询标签', (await tabCount()) === before + 1, `${before} → ${await tabCount()}`);

    // 关掉，回到表标签，避免污染后面的断言
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(400);
    ok('K1.2 ⌘W 恰好关闭 1 个标签', (await tabCount()) === before, `${await tabCount()}`);

    ok('K1.3 焦点在树时按 ⌘F 不会误开网格查找条（跨层不串）', (await gridSearch()) === 0,
      `gd-search=${await gridSearch()}`);
  }

  // ---------- K2：焦点在「网格」 ----------
  console.log('\n【K2】焦点在网格');
  {
    // 找到并聚焦网格视口
    const viewport = page.locator('.grid-viewport').first();
    await viewport.click({ position: { x: 200, y: 40 } });
    await page.waitForTimeout(200);

    await page.keyboard.press('Meta+f');
    await page.waitForTimeout(300);
    ok('K2.1 网格里 ⌘F 恰好打开 1 条查找栏', (await gridSearch()) === 1, `gd-search=${await gridSearch()}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok('K2.2 再按 Esc 关掉查找栏', (await gridSearch()) === 0);

    await page.keyboard.press('F12');
    await page.waitForTimeout(400);
    ok('K2.3 F12 打开列快速定位浮层',
      (await page.locator('[aria-label="定位列"]').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('K2.4 Esc 关闭列定位浮层', (await page.locator('[aria-label="定位列"]').count()) === 0);

    // ⌥0 设 NULL —— 这条同时验证 T11 的 ⌥0 改键与 T13 的 `e.code` 修正
    //
    // 🔴 必须先点中一个**具体单元格**：只点视口时选区可能停在 (-1,-1)，
    //    `setCellNull(row,col)` 会静默什么都不做，断言就把「脚本没准备」误报成
    //    「改键失效」。点第 4 列（note，可空）最稳 —— 有值、可编辑。
    const nullCell = page.locator('.grid-row').first().locator('.grid-cell').nth(3);
    await nullCell.click();
    await page.waitForTimeout(250);
    const dirtyBefore = await dirtyCells();
    await page.keyboard.press('Alt+0');
    await page.waitForTimeout(400);
    ok('K2.5 ⌥0 设 NULL 生效（脏单元格 +1，且标签出现脏点）',
      (await dirtyCells()) === dirtyBefore + 1 && (await dirtyBadges()) >= 1,
      `脏格 ${dirtyBefore} → ${await dirtyCells()}，标签脏点=${await dirtyBadges()}`);
    // 清掉，避免影响后续
    await page.keyboard.press('Alt+0');
    await page.waitForTimeout(300);
    ok('K2.6 再按 ⌥0 幂等清除本格改动', (await dirtyCells()) === dirtyBefore,
      `脏格=${await dirtyCells()}`);
  }

  // ---------- K3：焦点在「单元格输入」（IME 主战场） ----------
  console.log('\n【K3】焦点在单元格输入框');
  {
    const firstCell = page.locator('.grid-row').first().locator('.grid-cell').nth(1);
    await firstCell.dblclick();
    await page.waitForTimeout(400);
    ok('K3.1 双击进入编辑态（cell-editor 出现）', (await cellEditor()) === 1);

    await page.keyboard.press('Meta+e');
    await page.waitForTimeout(300);
    ok('K3.2 编辑态 ⌘E 切到 SQL 表达式模式',
      (await page.locator('[data-testid="expr-toggle"].gd-on').count()) === 1);
    await page.keyboard.press('Meta+e');
    await page.waitForTimeout(250);
    ok('K3.3 再按 ⌘E 切回字面量模式',
      (await page.locator('[data-testid="expr-toggle"].gd-on').count()) === 0);

    // —— 组合期 Esc 不该退出编辑（这是「回车/Esc 交给输入法」的一半）——
    await dispatchKey('[data-testid="cell-editor"]', { key: 'Escape', isComposing: true });
    await page.waitForTimeout(250);
    ok('K3.4 🔴 组合期 Esc 不退出编辑（取消的是候选词，不是本次编辑）', (await cellEditor()) === 1);

    // 对照：普通 Esc 必须退出 —— 没有这一条，K3.4 可能只是「Esc 根本没用」
    await dispatchKey('[data-testid="cell-editor"]', { key: 'Escape', isComposing: false });
    await page.waitForTimeout(300);
    ok('K3.5 对照：普通 Esc 退出编辑（证明 K3.4 不是恒真）', (await cellEditor()) === 0);

    // —— 组合期 Enter 不该提交 ——
    await firstCell.dblclick();
    await page.waitForTimeout(400);
    const editor = page.locator('[data-testid="cell-editor"]');
    await editor.fill('IME试探');
    await page.waitForTimeout(150);
    // 输入本身就可能让这一格变脏 —— 先记基线，再比「Enter 有没有多做事」
    const dirtyAfterType = await dirtyCells();
    await dispatchKey('[data-testid="cell-editor"]', { key: 'Enter', isComposing: true });
    await page.waitForTimeout(350);
    ok('K3.6 🔴 组合期 Enter 不提交（编辑态仍在、脏格数不增）',
      (await cellEditor()) === 1 && (await dirtyCells()) === dirtyAfterType,
      `editor=${await cellEditor()} 脏格=${await dirtyCells()}（基线 ${dirtyAfterType}）`);

    /**
     * 对照：普通 Enter 必须提交。
     * 🔴 这条**用真实按键**而不是合成事件 —— 合成事件对「提交」这条路径是
     *    另一种输入源，真按键才代表用户实际按下的东西（合成事件只用在
     *    「必须伪造 isComposing」的组合期场景）。
     */
    await editor.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(450);
    ok('K3.7 对照：普通 Enter 提交并退出编辑（证明 K3.6 不是恒真）',
      (await cellEditor()) === 0,
      `editor=${await cellEditor()} 脏格=${await dirtyCells()}`);

    // 收尾：放弃这次脏改动（⌥0 幂等清除不适用文本改动，走「本格撤销」菜单太绕 ——
    // 直接用 Esc 后的右键「撤销本格改动」入口，或重新载入并放弃）
    await page.keyboard.press('Escape').catch(() => {});
    const clearBtn = page.locator('.gd-ctx-item', { hasText: '撤销本格改动' }).first();
    await firstCell.click({ button: 'right' });
    await page.waitForTimeout(300);
    if ((await clearBtn.count()) > 0) {
      await clearBtn.click();
      await page.waitForTimeout(300);
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(200);
  }

  // ---------- K4：焦点在「SQL 编辑器」 ----------
  console.log('\n【K4】焦点在 SQL 编辑器');
  {
    // 新建查询标签并聚焦编辑器
    await page.keyboard.press('Meta+t');
    await page.waitForSelector('.cm-content', { timeout: 20_000 });
    await page.waitForTimeout(500);
    const cm = page.locator('.cm-content').first();
    await cm.click();
    /**
     * 🔴 先清空编辑器再输入。
     *
     * `newQuery()` 会预填 `SELECT * FROM `（方便用户接着写表名），脚本直接 type
     * 就会拼成 `SELECT * FROM SELECT id FROM ...` —— 语法错误。而「结果页签 +1」
     * 依然成立（错误也是页签），所以这个坑只有断言「不是错误页签」时才暴露。
     */
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
    // 必须写全限定名：查询标签的默认库未必是临时库，裸 `orders` 会执行失败
    await page.keyboard.type(`SELECT id FROM \`${dbName}\`.\`orders\``);
    await page.waitForTimeout(300);

    const resultTabsBefore = await page.locator('.sql-tab').count();

    await page.keyboard.press('Meta+r');
    await page.waitForTimeout(2500);
    // 🔴 原断言写成 `afterRun > 0 || resultTabsBefore >= 0` —— 右边恒真，等于没断。
    //    这里只问一件事：**结果页签确实多出来了**（真类名是 `.sql-tab`）。
    const tabsAfterRun = await page.locator('.sql-tab').count();
    const erroredAfterRun = await page.locator('.sql-tab.errored').count();
    ok('K4.1 SQL 里 ⌘R 触发执行（结果页签 +1 且不是错误页签）',
      tabsAfterRun > resultTabsBefore && erroredAfterRun === 0,
      `结果页签 ${resultTabsBefore} → ${tabsAfterRun}，错误页签 ${erroredAfterRun}`);

    // ⌘/ 行注释（不改语义，只看文档文本变化）
    await cm.click();
    await page.keyboard.press('Meta+/');
    await page.waitForTimeout(300);
    const text = await page.locator('.cm-content').first().innerText();
    ok('K4.2 ⌘/ 给当前行加行注释', text.includes('--'), `首行=「${text.split('\n')[0]}」`);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(250);

    // ⌘⏎ 执行选中：先全选，再执行
    await page.keyboard.press('Meta+a');
    const tabsBeforeSel = await page.locator('.sql-tab').count();
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(2000);
    ok('K4.3 ⌘⏎ 执行选中也出结果页签', (await page.locator('.sql-tab').count()) > tabsBeforeSel,
      `结果页签 ${tabsBeforeSel} → ${await page.locator('.sql-tab').count()}`);

    // ⇧⌘X EXPLAIN
    await cm.click();
    await page.keyboard.press('Shift+Meta+x');
    await page.waitForTimeout(2500);
    const explainTabs = await page.locator('.sql-tab-title', { hasText: '执行计划' }).count();
    ok('K4.4 ⇧⌘X 触发执行计划（出现「执行计划」页签，且不是错误页签）',
      explainTabs >= 1 && (await page.locator('.sql-tab.errored').count()) === 0,
      `匹配 ${explainTabs} 个；现有页签=「${(await page.locator('.sql-tab-title').allInnerTexts()).join(' / ')}」`);
  }

  // ---------- K5：焦点在「弹窗」 ----------
  console.log('\n【K5】焦点在弹窗');
  {
    await page.locator('body').click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('[data-testid="prefs-panel"]', { timeout: 10_000 });
    ok('K5.1 ⌘, 打开偏好设置', (await page.locator('[data-testid="prefs-panel"]').count()) === 1);

    // 弹窗开着时 ⌘T 不该在背后开标签（焦点被模态吃掉）
    const tabsWithModal = await tabCount();
    await page.keyboard.press('Meta+t');
    await page.waitForTimeout(400);
    ok('K5.2 🔴 模态打开时 ⌘T 不在背后新建标签', (await tabCount()) === tabsWithModal,
      `${tabsWithModal} → ${await tabCount()}`);

    // 组合期 Esc 不该关弹窗
    await dispatchKey('window', { key: 'Escape', isComposing: true });
    await page.waitForTimeout(300);
    ok('K5.3 🔴 组合期 Esc 不关闭弹窗',
      (await page.locator('[data-testid="prefs-panel"]').count()) === 1);

    // 对照：普通 Esc 关闭
    await dispatchKey('window', { key: 'Escape', isComposing: false });
    await page.waitForTimeout(400);
    ok('K5.4 对照：普通 Esc 关闭弹窗（证明 K5.3 不是恒真）',
      (await page.locator('[data-testid="prefs-panel"]').count()) === 0);
  }

  // ---------- K6：IME 组合期矩阵（其余高危出口） ----------
  console.log('\n【K6】IME 组合期矩阵');
  {
    // 命令面板：Enter 会直接执行高亮命令
    await page.locator('body').click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);
    const paletteOpen = (await page.locator('.palette').count()) > 0;
    ok('K6.1 ⌘K 打开命令面板', paletteOpen);
    if (paletteOpen) {
      const input = page.locator('.palette input').first();
      // 清空输入 = 展示全部候选（面板的条目按当前上下文构建，先不假设某条命令一定在）
      await input.fill('');
      await page.waitForTimeout(300);
      /**
       * 🔴 前置断言：面板里必须真的有候选项。
       *
       * 原版直接断言「标签数不变 / 标签数 +1」—— 可如果候选列表是空的（命令面板
       * 的条目按当前上下文构建），`run()` 本来就什么都不做，于是「组合期不执行」
       * 那条会**永远绿**（假绿），而「普通 Enter 执行」那条**永远红**。
       * 这正是「断言要能证伪」的反面教材，重写时先把前置条件钉住。
       */
      // 🔴 必须排除空态 li ——「没有匹配项」也是 li，计数器会把空列表当成 1 个候选
      const items = await page.locator('.palette li:not(.palette-empty)').count();
      ok('K6.2a 命令面板有**真实**候选项（后续两条断言的前提）', items > 0, `${items} 项`);

      // 组合期 Enter：守卫放行 ⇒ run() 不被调用 ⇒ 面板仍在
      await dispatchKey('.palette input', { key: 'Enter', isComposing: true });
      await page.waitForTimeout(400);
      ok('K6.2 🔴 命令面板里组合期 Enter 不执行高亮命令',
        (await page.locator('.palette').count()) === 1,
        `面板数=${await page.locator('.palette').count()}`);

      // 对照：普通 Enter 必须执行 —— run() 会关闭面板，用「面板消失」当客观判据
      // （比「标签 +1」更稳：不依赖哪个命令被高亮）
      // 🔴 用真实按键：合成事件在「执行命令」这条路径上是另一种输入源
      await input.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      ok('K6.3 对照：普通 Enter 执行命令（面板关闭，证明 K6.2 不是恒真）',
        (await page.locator('.palette').count()) === 0,
        `面板数=${await page.locator('.palette').count()}`);
      // 收尾：关掉可能新建的标签
      await page.keyboard.press('Meta+w').catch(() => {});
      await page.waitForTimeout(300);
    }

    // 保证面板已关：面板开着时 modal-mask 会拦截背景点击（30s 超时）
    if ((await page.locator('.palette').count()) > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }

    // 树：组合期 Backspace 不该发起「删除表」
    await page.locator('.tree').focus().catch(() => {});
    // 用 K0 已精确命中的节点（连接→库→表 三级），不按表名 `.first()` —— 见 findObjectRow 注释
    await tableNode.click();
    await page.waitForTimeout(300);
    await dispatchKey('.tree', { key: 'Backspace', isComposing: true });
    await page.waitForTimeout(500);
    ok('K6.4 🔴 树上组合期 Backspace 不弹出「删除表」确认框',
      (await page.locator('[data-testid="danger-confirm"], .danger-modal').count()) === 0);

    // 对照：普通 Backspace 必须弹（证伪对）
    await dispatchKey('.tree', { key: 'Backspace', isComposing: false });
    await page.waitForTimeout(600);
    const dangerCount = await page.locator('[data-testid="danger-confirm"], .danger-modal').count();
    ok('K6.5 对照：普通 Backspace 弹出危险确认框（证明 K6.4 不是恒真）', dangerCount >= 1,
      `danger=${dangerCount}`);
    if (dangerCount >= 1) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  }

  // ---------- K9：只读连接（T14）----------
  console.log('\n【K9】只读连接：写入口统一禁用 + 给出原因');
  {
    // 清场：前面段落可能留下未关的模态（遮罩会拦住后续所有点击）
    for (let i = 0; i < 5 && (await page.locator('.modal-mask').count()) > 0; i++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    }
    ok('K9.0 进入本段落前界面已无残留模态',
      (await page.locator('.modal-mask').count()) === 0,
      `残留 ${await page.locator('.modal-mask').count()} 个`);

    const rc = await page.evaluate((pwd) => window.dbStudio.connConnect('e2e-keys-ro', pwd), FIXTURE.password);
    ok('K9.1 只读连接已建立', rc?.ok === true, rc?.ok ? '' : String(rc?.error?.message ?? ''));

    // 诊断：渲染层实际看到的连接配置（readOnly 是否传到渲染层）
    const connSeen = await page.evaluate(async () => {
      const r = await window.dbStudio.connList();
      const list = r?.data?.connections ?? r?.connections ?? [];
      return {
        ok: r?.ok,
        conns: list.map((c) => ({ id: c.id, readOnly: c.readOnly })),
        states: r?.data?.states ?? r?.states,
      };
    });
    console.log(`   [诊断] 渲染层连接列表 = ${JSON.stringify(connSeen)}`);

    // 拉一次 schema（该按钮刷新**所有已连接**的连接），让只读连接的库/表进树
    await page.locator('[data-testid="btn-refresh-schema"]').click();
    await page.waitForTimeout(1500);
    // 只读连接的连接行在树尾，直接滚过去再展开（同一套单调展开逻辑）
    const roConnRow = page.locator('.tree-row', { has: page.locator('.tree-label', { hasText: /^e2e-keys-ro$/ }) }).first();
    if ((await roConnRow.count()) > 0) await roConnRow.scrollIntoViewIfNeeded().catch(() => {});
    await expandAll();

    const roTable = await findObjectRow('e2e-keys-ro', dbNameRo, 'ro_orders');
    if (!roTable) await dumpTree('只读连接定位失败');
    ok('K9.2 只读连接子树下能定位到「临时只读库 → ro_orders」节点', roTable !== null);
    if (!roTable) throw new Error('K9 前置条件缺失：只读连接下没有 ro_orders，后续断言无立足点');

    await roTable.dblclick();
    await page.waitForSelector('.grid-row', { timeout: 20_000 });
    /**
     * 🔴 必须确认**开的是那张只读表**。
     *
     * `.grid-row` 在上一张表里早就存在，`waitForSelector` 会立刻返回 ——
     * 若双击没生效，后面所有断言都在**别的表**上跑，红/绿都没有意义。
     */
    await page
      .waitForFunction(
        () => document.querySelector('.ws-tab.active')?.textContent?.includes('ro_orders') ?? false,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(500);
    const activeTabText = (
      (await page.locator('.ws-tab.active').first().innerText().catch(() => '')) ?? ''
    ).replace(/\n/g, ' ');
    /**
     * 🔴 立足点必须断到**连接**上，不能只断表名。
     *
     * 表名在两个连接下都叫 `ro_orders` —— 只断表名的话，就算开的是非只读连接
     * 那一份，断言照样绿，紧接着的只读断言则会全红（现象极具误导性）。
     */
    const activeConnId = await page.locator('.ws-tab.active').first().getAttribute('data-conn-id');
    ok(
      'K9.2b 只读表标签已激活，且归属连接是 e2e-keys-ro（后续断言的立足点）',
      activeTabText.includes('ro_orders') && activeConnId === 'e2e-keys-ro',
      `活动标签=「${activeTabText}」 connId=${String(activeConnId)}`,
    );
    {
      const allTabs = (await page.locator('.ws-tab').allInnerTexts()).map((s) => s.replace(/\n/g, ' '));
      const activeN = await page.locator('.ws-tab.active').count();
      console.log(`   [诊断] 全部标签(${allTabs.length}) = ${JSON.stringify(allTabs)}；.active 命中 ${activeN} 个`);
      const at = page.locator('.ws-tab.active').first();
      console.log(
        `   [诊断] 活动标签 data-conn-id=${await at.getAttribute('data-conn-id')} data-readonly=${await at.getAttribute('data-readonly')}`,
      );
      const sb = page.locator('.statusbar').first();
      console.log(
        `   [诊断] 状态栏 data-conn-id=${await sb.getAttribute('data-conn-id')} data-conn-readonly=${await sb.getAttribute('data-conn-readonly')}`,
      );
      const roNodes = page
        .locator('.tree-row')
        .filter({ has: page.locator('.tree-label', { hasText: /^ro_orders$/ }) });
      console.log(
        `   [诊断] 树中 ro_orders 节点数=${await roNodes.count()}（>1 说明同一实例被两条连接各看到一份）`,
      );
    }

    const banner = page.locator('[data-testid="readonly-banner"]');
    const bannerCount = await banner.count();
    const bannerReason = bannerCount > 0 ? await banner.getAttribute('data-reason') : null;
    ok('K9.3 出现只读横幅，且原因是「只读连接」而不是「无主键」',
      bannerCount === 1 && bannerReason === 'read-only-conn',
      `横幅=${bannerCount} reason=${String(bannerReason)}`);

    const roStatus = (await page.locator('.statusbar').innerText()).replace(/\n/g, ' ');
    ok('K9.4 状态栏分开表达：定位键有 + 可写否（只读连接）',
      roStatus.includes('定位键：有') && roStatus.includes('可写：否') && roStatus.includes('只读连接'),
      roStatus);

    ok('K9.5 工具栏「保存」对该表禁用',
      await page.locator('[data-testid="btn-save"]').isDisabled());

    /**
     * T46：低频操作（导出/导入/设计/粘贴）在**工具栏可用宽度 < 820px** 时会
     * 收进「更多」菜单 —— 此时 `btn-import` 根本不在 DOM 里（不是隐藏，
     * 是没渲染），直接 `isDisabled()` 会等 30s 超时，现场只剩一句
     * "waiting for locator"，看不出到底是 UI 变了还是断言烂了。
     *
     * 这里的口径是「**该动作在只读连接下被禁用**」，与它在主栏还是折叠菜单里
     * 无关。所以先按主栏找，找不到就展开「更多」再找，并把「找到几个」写进
     * 详情 —— 两处都没有时必须红。
     */
    const toolbarAction = async (id) => {
      const direct = page.locator(`[data-testid="btn-${id}"]`);
      if ((await direct.count()) > 0) return { loc: direct, where: '主栏' };
      const more = page.locator('[data-testid="btn-more"]');
      if ((await more.count()) > 0) {
        await more.click();
        await page.waitForTimeout(250);
      }
      return { loc: page.locator(`[data-testid="more-${id}"]`), where: '更多菜单' };
    };

    const imp = await toolbarAction('import');
    const impCount = await imp.loc.count();
    const impDisabled = impCount === 1 ? await imp.loc.isDisabled().catch(() => null) : null;
    ok('K9.6 工具栏「导入」对该表禁用', impCount === 1 && impDisabled === true,
      `位置=${imp.where} found=${impCount} disabled=${impDisabled}`);
    // 收起可能展开的菜单，别把浮层留给后面的断言
    if (imp.where === '更多菜单') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    const roCell = page.locator('.grid-row').first().locator('.grid-cell').nth(1);
    await roCell.dblclick();
    await page.waitForTimeout(400);
    ok('K9.7 只读连接下双击单元格不进入编辑（普通编辑入口已禁）', (await cellEditor()) === 0,
      `editor=${await cellEditor()}`);
    await page.keyboard.press('Escape').catch(() => {});

    await roTable.click({ button: 'right' });
    await page.waitForTimeout(400);
    const dropItem = page.locator('.ctx-item', { hasText: '删除表' }).first();
    const dropCount = await dropItem.count();
    const ctxLabels = (await page.locator('.ctx-item').allInnerTexts()).map((t) => t.trim());
    ok('K9.8 只读连接下树右键「删除表」禁用',
      dropCount > 0 && (await dropItem.isDisabled()),
      `项=${ctxLabels.join(' | ')}`);
    if (dropCount > 0) {
      const tip = await dropItem.getAttribute('title');
      ok('K9.9 禁用项带原因（悬停可见，不是「能点但报错」）', !!tip && tip.includes('只读'), String(tip));
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  // ---------- K7：覆盖不到的原生菜单 accelerator（诚实登记）----------
  console.log('\n【K7】本脚本覆盖不到、必须人工按的项');
  manual('原生菜单 accelerator（⌘N / ⌘S / ⌘W / ⌘K / ⌘, / ⇧⌘R / ⌘0 / ⌃Tab…）',
    'macOS 由 NSMenu 在应用层拦截，CDP 注入的按键不进这条路径');
  manual('真实中文输入法（拼音候选）下的 Enter / Esc / Backspace',
    'CDP 无法真实复现 IME composition；本脚本用合成 isComposing 事件验证守卫，真实 IME 需手按');
  manual('⌘C / ⌘V / ⌘A / ⌘Z 在网格与 SQL 下的表现',
    '报告 §4.2 将其列为「真机待验」；需人工逐格确认与系统 role 的优先级');
  manual('五焦点 × 全命令的完整矩阵',
    '本脚本覆盖五个焦点的代表性命令；完整矩阵见 docs/engineering/T13-键盘矩阵验收清单.md');

  console.log('\n【K8】控制台');
  ok('K8.1 无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));
} catch (e) {
  ok('未捕获异常', false, e instanceof Error ? e.message : String(e));
  try {
    await page.screenshot({ path: '/tmp/e2e-keys-failure.png' });
    console.log('   现场截图：/tmp/e2e-keys-failure.png');
  } catch {
    /* 截图失败不影响结论 */
  }
} finally {
  /**
   * 🔴 收尾必须先关窗，但要**带超时**。
   *
   * 应用有「关闭守卫」：标签里有未保存改动时，渲染层会弹确认而不答复 ——
   * 这是**正确行为**（防误关丢数据），但对自动化就是**永久挂起**：
   * `electronApp.close()` 等不到 `window-all-closed`，脚本卡死、
   * 进而把 `npm run verify` 一起拖住（实测跑完所有断言后仍挂 >5 分钟）。
   * 别为了收尾去改产品行为；这里退一步：给 5 秒体面退出，然后强杀。
   */
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  try {
    if (!electronApp.process()?.killed) electronApp.process()?.kill('SIGKILL');
  } catch {
    /* 进程可能已退出 */
  }
  try {
    const cleanup = new MySqlDriver(FIXTURE, {});
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    if (dbNameRo) await cleanup.query(`DROP DATABASE IF EXISTS \`${dbNameRo}\``);
    await cleanup.close();
  } catch {
    /* 清理失败不影响结论 */
  }
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}（另有 ${skipped.length} 项需人工，未计入）`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
