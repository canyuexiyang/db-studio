/**
 * 真机端到端验证 —— 起真 Electron 窗口，连真 MySQL fixture（13306）
 *
 * 这一层验证的是前面所有门禁都覆盖不到的东西：
 *  **渲染层 + preload + 主进程 + 真驱动，拼起来在真窗口里真的能跑。**
 *
 *  单测（562）验证逻辑；e2e-smoke 验证主进程包在真库上的行为；
 *  e2e-ui 验证渲染层在浏览器里的交互；
 *  这个脚本验证的是「IPC 接线本身」——数据在进程边界两侧是否真的对得上。
 *
 * 关键设计：
 *  - 用 playwright 的 electron 支持，跑的是**真实的** BrowserWindow + preload
 *  - 连的是 fixture 库（1000 万行 big_table），不是 mock
 *  - 写操作在自建临时库里做，跑完 DROP
 *  - 缺 playwright 或 fixture 不在时**跳过并提示，不算失败**（逻辑门禁由 npm test 负责）
 *
 * 用法：npm run e2e:app
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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

// ---------- 依赖检查（缺了就跳过，不算失败）----------
// ⚠️ playwright-core 的 ESM 入口只导出 _electron，没有公开的 electron 命名导出。
//    官方 TS 类型里 electron 是 _electron 的公开别名，但运行时只有 _electron。
let electron;
try {
  const mod = await import('playwright-core');
  electron = mod.electron ?? mod._electron;
} catch {
  console.log('⏭️  跳过真机验证：未安装 playwright-core');
  process.exit(0);
}
if (!electron) {
  console.log('⏭️  跳过真机验证：playwright-core 无 Electron 支持');
  process.exit(0);
}

/** fixture 是否在监听 */
async function fixtureAlive() {
  try {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const s = net.createConnection({ host: FIXTURE.host, port: FIXTURE.port });
      s.setTimeout(2000);
      s.on('connect', () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
      s.on('timeout', () => (s.destroy(), resolve(false)));
    });
  } catch {
    return false;
  }
}

if (!(await fixtureAlive())) {
  console.log(`⏭️  跳过真机验证：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  console.log('    启动：docker compose up -d dbstudio-mysql（或设 DB_STUDIO_E2E_PWD）');
  process.exit(0);
}

// ---------- 先用真驱动准备临时库（写操作隔离）----------
const { MySqlDriver } = await import('../packages/core-driver-mysql/src/index.ts');
/**
 * T19：计划器要拿真 meta 走一遍。
 *
 * 🔴 这里刻意 import **真实实现**而不是另写一份断言逻辑 —— `buildBlankRowPlan` 的
 *    「哪一列要用户填」完全建立在 `TableMeta.defaultValue / nullable / autoIncrement`
 *    上，而这些字段的真值是 MySQL 给的（information_schema）。手写替身只能验证
 *    「我们的逻辑」，验证不了「对方上报的形态」—— 与 safeStorage 那次的事故同源。
 */
const { buildBlankRowPlan, buildMutationPlan } = await import('../packages/core-mutation/src/index.ts');

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const admin = new MySqlDriver(FIXTURE, {});
let dbName;
try {
  await admin.connect();
  dbName = `e2e_app_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  await admin.query(`USE \`${dbName}\``);
  await admin.query(`
    CREATE TABLE \`order\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(255) NULL,
      score DOUBLE NOT NULL,
      big_no BIGINT NOT NULL,
      ts DATETIME(6) NULL
    )
  `);
  await admin.query(`
    CREATE TABLE no_key_table (
      name VARCHAR(64) NOT NULL,
      city VARCHAR(32) NOT NULL
    )
  `);
  /**
   * T19 专用靶子：**每一列都能自动填**（自增 + 有默认值）。
   *
   * 只有这种表才能走到 `INSERT INTO t () VALUES ()` 那条分支 —— 也就是
   * 「空白行什么都不填也能插进去」的真实场景。`order` 表做不到（amount/score/big_no
   * 都是 NOT NULL 无默认值），所以必须单独造一张。
   */
  await admin.query(`
    CREATE TABLE blank_pure (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      n INT NOT NULL DEFAULT 0
    )
  `);
  // 造 5000 行：够验证虚拟滚动与 3000 行截断提示
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push(`('${i % 3 === 0 ? 'paid' : 'new'}', '${(i * 1.37).toFixed(2)}', ${i % 7 === 0 ? 'NULL' : `'备注 ${i}'`}, ${(i % 100) / 4}, ${9007199254740900 + i}, ${i % 5 === 0 ? 'NULL' : `'2026-09-20 15:04:05.123456'`})`);
  }
  for (let i = 0; i < rows.length; i += 500) {
    await admin.query(
      `INSERT INTO \`order\` (status, amount, note, score, big_no, ts) VALUES ${rows.slice(i, i + 500).join(',')}`,
    );
  }
  console.log(`\n【准备】临时库 ${dbName}（order 5000 行 + no_key_table + blank_pure）`);
} finally {
  await admin.close().catch(() => {});
}

// ---------- 起 Electron ----------
/**
 * 定位 Electron 可执行文件。
 *
 * ⚠️ 必须显式指定 executablePath：playwright 自带的 Electron 版本与本项目
 * 锁定的 44.x 不一致（且它未必下载过）。用项目自己 node_modules 里那一份，
 * 才能保证验证的是「真正会发布的那套运行时」。
 */
function findElectron() {
  const p = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  return existsSync(p) ? p : undefined;
}

const electronPath = findElectron();
if (!electronPath) {
  console.log('⏭️  跳过真机验证：找不到 Electron 可执行文件');
  console.log('    执行 npm i 安装 electron（当前锁定 44.x）');
  process.exit(0);
}

const userData = mkdtempSync(join(tmpdir(), 'dbstudio-app-'));

/**
 * ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE。
 * 某些宿主环境（如本机的 Agent 运行时，它自己就是 Electron 应用）会把这个
 * 变量导出到子进程。置位时 Electron 二进制【退化成纯 Node】，
 * 内置模块 'electron' 不存在，require 直接 MODULE_NOT_FOUND ——
 * 表现是 "Cannot find module 'electron'"，极易误判成打包配置错了。
 */
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

/**
 * ⚠️ 自动化下必须 --no-sandbox，否则进程直接 SIGTRAP 自杀。
 *
 * 现象（最小复现：一个只有 BrowserWindow + data URL 的空 app 也这样）：
 *   sandbox initialization failed: Operation not permitted
 *   GPU process exited unexpectedly: exit_code=6
 *   FATAL: gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
 *   signal=SIGTRAP
 *
 * 根因是**宿主执行环境**（CI / Agent 沙箱）不允许 Chromium 再套一层自己的
 * 子进程沙箱，跟本项目代码无关。实测对照：不加 --no-sandbox 100% 崩；
 * 加上后窗口正常创建、无 FATAL。
 *
 * 📌 代价要说清楚：这一步关掉的是【Chromium 渲染进程沙箱】，
 * 意味着本脚本**无法验证沙箱相关的安全行为**。我们验证的目标是
 * 「IPC 接线 + 列式载荷跨进程 + 只读拦截」，不依赖沙箱，可以接受。
 * 真机人工验收（不跑本脚本时）仍是带沙箱的，两者不冲突。
 */
/**
 * 🔴 `--user-data-dir` 必须一起给，否则两次运行之间会互相污染。
 *
 * 主进程侧的文件（connections.json / schema 缓存 / 历史库）已经被
 * `DB_STUDIO_E2E_USER_DATA` 接管，但**渲染层的 localStorage 不适用那个变量** ——
 * 它走 Chromium 的 user data 目录，也就是真实 userData。
 * 于是上一次跑留下的 `dbstudio.session.v1`（会话快照）会在下一次跑时被恢复出来：
 * 一个指向**已被删掉的连接**的 query 标签 → 状态栏显示「连接：未知」、
 * 执行按钮变成可点（因为它只判 `!connId`）→ 「无连接时执行按钮被禁用」这条断言
 * 上一轮还是绿的、下一轮就红了。**同一份代码、同一个脚本，结果靠运行历史决定。**
 *
 * 隔离之后每次跑都是真正的冷启动，断言才有基线可言。
 */
const LAUNCH_ARGS = ['--no-sandbox', `--user-data-dir=${userData}`];

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [...LAUNCH_ARGS, join(DESKTOP, 'dist/main/main.cjs')],
  env: {
    ...childEnv,
    DB_STUDIO_E2E_USER_DATA: userData,
    // 关掉单实例锁：自动化下残留进程会占住锁导致新实例立刻退出
    DB_STUDIO_NO_SINGLE_LOCK: '1',
    NODE_ENV: 'production',
  },
  timeout: 60_000,
});

// 主进程 stdout/stderr 直接透出：窗口起不来时没有这些日志根本没法排查
electronApp.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
electronApp.process().stderr?.on('data', (d) => process.stderr.write(`[main:err] ${d}`));

// 等第一个窗口
const page = await electronApp.firstWindow();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

/**
 * 在渲染进程里直接调 window.dbStudio —— 这是本脚本的核心：
 * 验证 preload 暴露的 API 真的能穿透到主进程并返回正确结构。
 */
async function callIpc(fnBody, ...args) {
  return page.evaluate(fnBody, ...args);
}

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.dbStudioRuntime?.hasIpc === true, { timeout: 20_000 });

  // ---------- 1. preload 桥接 ----------
  console.log('\n【1】preload 桥接');
  ok('window.dbStudio 已注入', await page.evaluate(() => typeof window.dbStudio === 'object'));
  ok(
    '通道表可用（不硬编码字符串）',
    await page.evaluate(() => window.dbStudioChannels?.QUERY_RUN === 'query:run'),
  );

  // ---------- 1.5 真机上核对 safeStorage 契约 ----------
  /**
   * 🔴 这组断言防的是【Electron 升级时签名悄悄变了】。
   *
   * 背景：Electron 44 的 decryptStringAsync() 返回的不是 string，
   * 而是 { result, shouldReEncrypt }。本项目最初按旧签名写死了接口，
   * 单测里的替身又照着错误签名实现 —— 于是 562 个单测全绿，
   * 真机一跑密码变成了对象，mysql2 直接报 "data must be of type string"。
   *
   * 结论：**凡是对外部 API 的形态假设，都必须有一条真机断言看着它。**
   * 单测替身只能验证「我们的逻辑」，验证不了「对方的契约」。
   */
  console.log('\n【1.5】真机核对 safeStorage 契约（防升级后签名悄悄变）');
  const secretState = await page.evaluate(() => window.dbStudio.secretState());
  ok('safeStorage 可用（密码可落盘）', secretState.ok === true && secretState.data?.available === true,
    secretState.ok ? `mode=${secretState.data?.mode ?? '?'}` : secretState.error?.message);

  // 真加解密一轮：走完 seal → open 的完整路径，取回的必须是字符串
  const roundTrip = await page.evaluate(async () => {
    // connCreate 内部会 seal（加密），connConnect 内部会 open（解密）。
    // 这里复用真实链路做往返，而不是另起一套探针。
    const probe = 'e2e-probe-' + Math.random().toString(36).slice(2);
    const r = await window.dbStudio.connCreate({
      config: {
        id: 'secret-probe', type: 'mysql', host: '127.0.0.1', port: 1, user: 'u',
        name: 'secret-probe', defaultDatabase: '',
      },
      password: probe,
    });
    // 取回的 passwordEnc 必须是密文且不含明文
    return { ok: r.ok, leak: (r.data?.passwordEnc ?? '').includes(probe) };
  });
  ok('加密后的密文不含明文', roundTrip.ok === true && roundTrip.leak === false,
    roundTrip.ok ? '往返成功，无明文泄漏' : String(roundTrip.error ?? ''));

  // ---------- 2. 连接 ----------
  console.log('\n【2】连接真库');
  const createRes = await page.evaluate(
    async (args) => {
      const { cfg, pwd, db } = args;
      const r = await window.dbStudio.connCreate({
        config: {
          ...cfg,
          name: 'e2e-fixture',
          defaultDatabase: db,
          group: '测试',
        },
        password: pwd,
      });
      return r;
    },
    {
      cfg: {
        id: 'e2e-conn',
        type: 'mysql',
        host: FIXTURE.host,
        port: FIXTURE.port,
        user: FIXTURE.user,
      },
      pwd: FIXTURE.password,
      db: dbName,
    },
  );
  ok('connCreate 成功', createRes.ok === true, createRes.ok ? createRes.data.name : createRes.error?.message);
  ok(
    '🔴 返回体不含密码密文（渲染层不该拿到凭据材料）',
    !(createRes.data?.passwordEnc ?? '').startsWith('ey') &&
      (createRes.data?.passwordEnc === '' || createRes.data?.passwordEnc === null),
    `passwordEnc=${JSON.stringify(createRes.data?.passwordEnc)}`,
  );

  const connRes = await page.evaluate(async () => window.dbStudio.connConnect('e2e-conn'));
  ok('connConnect 成功', connRes.ok === true && connRes.data.state === 'connected',
    connRes.ok ? `${connRes.data.serverVersion} / ${connRes.data.elapsedMs}ms` : connRes.error?.message);

  const listRes = await page.evaluate(() => window.dbStudio.connList());
  ok('connList 返回该连接', listRes.ok && listRes.data.connections.some((c) => c.id === 'e2e-conn'));

  // ---------- 3. Schema ----------
  console.log('\n【3】Schema introspect（真库）');
  const schemaRes = await page.evaluate(() => window.dbStudio.schemaGet('e2e-conn'));
  ok('schemaGet 拉到库表', schemaRes.ok === true && schemaRes.data.length > 0,
    schemaRes.ok ? `${schemaRes.data[0].name} / ${schemaRes.data[0].tables.length} 张对象` : schemaRes.error?.message);

  const tableRes = await page.evaluate(
    (t) => window.dbStudio.schemaGetTable('e2e-conn', t.db, 'order'),
    { db: dbName },
  );
  ok('schemaGetTable 识别主键', tableRes.ok && tableRes.data.table.columns.find((c) => c.name === 'id')?.isPrimaryKey === true);

  const colRes = await page.evaluate(() => window.dbStudio.schemaSearchColumn('e2e-conn', 'status'));
  ok('字段名反查表（Q2）', colRes.ok && colRes.data.includes(`${dbName}.order`), colRes.data?.join(', '));

  // ---------- 4. 查询 ----------
  console.log('\n【4】查询与列式传输');
  const qRes = await page.evaluate(
    (t) => window.dbStudio.queryOpenTable({ connId: 'e2e-conn', database: t.db, table: 'order', limit: 3000 }),
    { db: dbName },
  );
  ok('queryOpenTable 返回列式载荷', qRes.ok === true && qRes.data.payload.rowCount === 3000,
    qRes.ok ? `${qRes.data.payload.rowCount} 行 / ${qRes.data.elapsedMs}ms` : qRes.error?.message);
  ok('命中 3000 行截断提示', qRes.ok && qRes.data.truncated === true,
    qRes.ok ? `truncated=${qRes.data.truncated}（总 5000 行）` : '');

  // 列式载荷跨进程后仍可解码 —— 这是列式 IPC 的关键不变量
  const decodeRes = await page.evaluate((t) => {
    const r = window.dbStudio.queryOpenTable({ connId: 'e2e-conn', database: t.db, table: 'order', limit: 5 });
    return r;
  }, { db: dbName });
  ok('小结果集也能取回', decodeRes.ok && decodeRes.data.payload.rowCount === 5);

  // ---------- 5. 只读拦截（穿透到渲染层验证）----------
  console.log('\n【5】🔴 只读拦截（渲染层也拦不住绕过）');
  await page.evaluate(
    async (t) => {
      await window.dbStudio.connCreate({
        config: {
          id: 'ro-conn', type: 'mysql', host: t.host, port: t.port, user: t.user,
          name: 'e2e-readonly', defaultDatabase: t.db, readOnly: true,
        },
        password: t.password,
      });
      await window.dbStudio.connConnect('ro-conn');
    },
    { host: FIXTURE.host, port: FIXTURE.port, user: FIXTURE.user, password: FIXTURE.password, db: dbName },
  );
  const roRes = await page.evaluate(() =>
    window.dbStudio.queryRun({ connId: 'ro-conn', sql: 'DELETE FROM `order`' }),
  );
  ok('🔴 只读连接的 DELETE 被拦截', roRes.ok === false && roRes.error.code === 'READ_ONLY',
    roRes.error ? `${roRes.error.code}: ${roRes.error.message.slice(0, 50)}` : '未被拦截！');

  const roSel = await page.evaluate(() =>
    window.dbStudio.queryRun({ connId: 'ro-conn', sql: 'SELECT COUNT(*) AS n FROM `order`' }),
  );
  ok('只读连接的 SELECT 放行', roSel.ok === true);

  // ---------- 6. 写操作（真写库）----------
  console.log('\n【6】写操作真写库');
  const mutRes = await page.evaluate((t) =>
    window.dbStudio.mutationApply({
      connId: 'e2e-conn',
      database: t.db,
      statements: [
        { sql: 'UPDATE `order` SET note = ? WHERE id = ?', params: ['IPC 写入测试', 1] },
      ],
    }),
  { db: dbName });
  ok('mutationApply 成功', mutRes.ok === true && mutRes.data.affected === 1,
    mutRes.ok ? `影响 ${mutRes.data.affected} 行 / ${mutRes.data.elapsedMs}ms` : mutRes.error?.message);

  // 回读确认真的写进去了
  const verify = await page.evaluate((t) =>
    window.dbStudio.queryRun({ connId: 'e2e-conn', sql: 'SELECT note FROM `order` WHERE id = 1' }),
  { db: dbName });
  const noteVal = verify.ok ? verify.data.payload : null;
  ok('写库结果可回读', verify.ok === true && verify.data.rowCount === 1,
    verify.ok ? `rowCount=${verify.data.rowCount}` : verify.error?.message);
  void noteVal;

  // ---------- 6.5 T19 新增空白行（真 meta + 真 SQL 被真库接受）----------
  /**
   * 这一段补的是单测覆盖不到的缝：
   *  - 单测喂的是**手写 TableMeta**；这里喂的是 MySQL 真上报的 meta。
   *    若 information_schema 的 defaultValue / nullable 与我们的假设不一致，
   *    buildBlankRowPlan 的分类就会分错 —— 只有真 meta 能发现。
   *  - 单测只断 SQL **文本**；这里把文本真的送到 MySQL 执行，证明
   *    `INSERT INTO t () VALUES ()` 不是我们臆想出来的语法。
   */
  console.log('\n【6.5】T19 新增空白行（真 meta + 真库执行）');
  {
    const pureMeta = await page.evaluate(
      (t) => window.dbStudio.schemaGetTable('e2e-conn', t.db, 'blank_pure'),
      { db: dbName },
    );
    const orderMeta = await page.evaluate(
      (t) => window.dbStudio.schemaGetTable('e2e-conn', t.db, 'order'),
      { db: dbName },
    );

    if (!pureMeta.ok || !orderMeta.ok) {
      ok('T19 取到真表 meta', false, pureMeta.error?.message ?? orderMeta.error?.message);
    } else {
      // --- (a) 全自增/默认值列的表：什么都不填也能插 ---
      const purePlan = buildBlankRowPlan(pureMeta.data.table);
      ok('T19 全默认值表可新增（不被整体拒绝）', purePlan.rejected === null, purePlan.rejected ?? '');
      ok('T19 自增列交给服务端（auto-skip）', purePlan.autoSkipped.join(',') === 'id',
        `autoSkipped=[${purePlan.autoSkipped.join(',')}]`);
      ok('T19 有 DEFAULT 的列走默认值而不是写 NULL（真 meta 上报的默认值）',
        purePlan.defaulted.join(',') === 'status,n' && purePlan.nulled.length === 0,
        `defaulted=[${purePlan.defaulted.join(',')}] nulled=[${purePlan.nulled.join(',')}]`);
      ok('T19 该表无需用户填值', purePlan.needsInput.length === 0, `needsInput=[${purePlan.needsInput.join(',')}]`);

      const pureSql = buildMutationPlan(dbName, pureMeta.data.table, {
        inserts: [{ tempId: 'blank', values: {}, blank: true }],
      });
      const blankStmt = pureSql.statements[0];
      ok('T19 生成 INSERT INTO t () VALUES ()',
        blankStmt?.sql === `INSERT INTO \`${dbName}\`.\`blank_pure\` () VALUES ()`,
        blankStmt?.sql ?? `（没有语句；rejected=${JSON.stringify(pureSql.rejected)}）`);

      // 真执行：文本 → 真 IPC → 真 MySQL
      if (blankStmt) {
        const applied = await page.evaluate(
          (args) =>
            window.dbStudio.mutationApply({
              connId: 'e2e-conn',
              database: args.db,
              statements: [{ sql: args.sql, params: [] }],
            }),
          { db: dbName, sql: blankStmt.sql },
        );
        ok('T19 🔴 真 MySQL 接受该 SQL 并写入 1 行',
          applied.ok === true && applied.data.affected === 1,
          applied.ok ? `affected=${applied.data.affected}` : applied.error?.message);

        /**
         * 回读不用 COUNT 取标量（列式载荷里取值要额外解码，徒增脆性），
         * 改成**条件计数**：命中 1 行 = 默认值真的生效。
         *
         * 🔴 下面两条必须**一起**判，缺一条就是假绿：
         *    上一版先写了「NULL 行数为 0」那条 —— 插入失败、表还是空的，
         *    `... IS NULL` 当然返回 0 行，断言照样绿。空表上的计数类断言
         *    天生是空洞为真（vacuous truth），必须用前一条的「确实插进去了」把它钉住。
         */
        const hit = await page.evaluate(
          () => window.dbStudio.queryRun({
            connId: 'e2e-conn',
            sql: "SELECT id FROM `blank_pure` WHERE status = 'new' AND n = 0",
          }),
        );
        const hitRows = hit.ok ? hit.data.payload.rowCount : -1;
        ok('T19 回读：默认值真的生效（status=new / n=0 / id 自增）', hitRows === 1,
          hit.ok ? `命中 ${hitRows} 行` : hit.error?.message);

        const wroteNull = await page.evaluate(
          () => window.dbStudio.queryRun({
            connId: 'e2e-conn',
            sql: 'SELECT id FROM `blank_pure` WHERE status IS NULL OR n IS NULL',
          }),
        );
        const nullRows = wroteNull.ok ? wroteNull.data.payload.rowCount : -1;
        ok('T19 🔴 有默认值的列没有被写成 NULL（DEFAULT 与 NULL 分开了）',
          hitRows === 1 && nullRows === 0,
          `非默认值行数=${hitRows}（期望 1） NULL 行数=${nullRows}（期望 0）`);
      }

      // --- (b) 真 meta 上核对「哪些列必须用户填」---
      const orderPlan = buildBlankRowPlan(orderMeta.data.table);
      ok('T19 真 meta：自增主键 auto-skip',
        orderPlan.autoSkipped.join(',') === 'id', `[${orderPlan.autoSkipped.join(',')}]`);
      ok('T19 真 meta：NOT NULL DEFAULT 列走默认值（不是写 NULL）',
        orderPlan.defaulted.join(',') === 'status', `[${orderPlan.defaulted.join(',')}]`);
      ok('T19 真 meta：可空无默认列写显式 NULL',
        orderPlan.nulled.join(',') === 'note,ts', `[${orderPlan.nulled.join(',')}]`);
      ok('T19 真 meta：NOT NULL 无默认列要求用户填值',
        orderPlan.needsInput.join(',') === 'amount,score,big_no', `[${orderPlan.needsInput.join(',')}]`);

      // --- (c) 预演防线：把这些「待填」列原样当 NULL 提交 → 必须在预演里被逐列点名 ---
      const rejectSql = buildMutationPlan(dbName, orderMeta.data.table, {
        inserts: [{
          tempId: 'blank', blank: true,
          values: { amount: null, score: null, big_no: null, note: null, ts: null },
        }],
      });
      ok('T19 🔴 真 meta 下空白行预演即拒（不让用户确认后吃 1048）',
        rejectSql.statements.length === 0 && rejectSql.rejected.length === 1,
        `statements=${rejectSql.statements.length} rejected=${rejectSql.rejected.length}`);
      ok('T19 拒绝原因逐列点名 amount/score/big_no',
        /amount/.test(rejectSql.rejected[0]?.reason ?? '') &&
          /score/.test(rejectSql.rejected[0]?.reason ?? '') &&
          /big_no/.test(rejectSql.rejected[0]?.reason ?? ''),
        (rejectSql.rejected[0]?.reason ?? '（没有拒绝原因）').slice(0, 90));
      // 反向对照：可空列（note/ts）不该出现在 NOT NULL 拒绝名单里
      ok('T19 可空列不被 NOT NULL 规则误伤',
        !/note|ts/.test(rejectSql.rejected[0]?.column ?? ''), `column=${rejectSql.rejected[0]?.column}`);
    }
  }

  // ---------- 7. 历史 ----------
  console.log('\n【7】查询历史');
  const histRes = await page.evaluate(() => window.dbStudio.historyList('e2e-conn', 20));
  ok('历史记录了执行过的 SQL', histRes.ok && histRes.data.length > 0, `${histRes.data?.length ?? 0} 条`);
  const failedRes = await page.evaluate(() =>
    window.dbStudio.queryRun({ connId: 'e2e-conn', sql: 'SELEKT 1 FROM nope' }),
  );
  ok('语法错误的查询返回失败', failedRes.ok === false);
  const hist2 = await page.evaluate(() => window.dbStudio.historyList('e2e-conn', 20));
  ok(
    '🔴 失败的 SQL 也进历史（Q5）',
    hist2.ok && hist2.data.some((h) => h.sql.includes('SELEKT') && h.success === false),
    hist2.ok ? `失败条目 ${hist2.data.filter((h) => !h.success).length} 条` : '',
  );

  // ---------- 8. 无主键表（B5 红线）----------
  console.log('\n【8】无主键表');
  const noKeyRes = await page.evaluate((t) =>
    window.dbStudio.schemaGetTable('e2e-conn', t.db, 'no_key_table'),
  { db: dbName });
  if (noKeyRes.ok) {
    const cols = noKeyRes.data.table.columns;
    const hasPk = cols.some((c) => c.isPrimaryKey);
    const hasUnique = cols.some((c) => c.isUnique);
    ok('无键表元数据正确（无主键无唯一键）', !hasPk && !hasUnique, `pk=${hasPk} unique=${hasUnique}`);
  } else {
    ok('无键表元数据可取', false, noKeyRes.error?.message);
  }

  // ---------- 9. 渲染层真的渲染出来了 ----------
  console.log('\n【9】渲染层');
  // 渲染层崩掉时 waitForSelector 只会超时，看不出原因 —— 先把现场 dump 出来
  try {
    await page.waitForSelector('.sidebar', { timeout: 10_000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({
      rootHtml: document.getElementById('root')?.innerHTML?.slice(0, 400) ?? '(无 #root)',
      bodyLen: document.body?.innerHTML?.length ?? 0,
    })).catch(() => ({ rootHtml: '(evaluate 也失败了)', bodyLen: -1 }));
    console.error('  ⚠️ 渲染层未挂载，现场：', JSON.stringify(dump, null, 2));
    console.error('  ⚠️ 控制台错误：', consoleErrors.slice(0, 5).join('\n     '));
    throw e;
  }
  ok('侧边栏已渲染', (await page.locator('.sidebar').count()) === 1);
  const envTag = await page.locator('.env-tag').textContent().catch(() => '');
  ok('跑在真 IPC 环境（非 demo）', envTag?.trim() === 'IPC', `env-tag=${envTag}`);

  ok('右侧详情面板已渲染', (await page.locator('.detail-panel').count()) === 1);

  // ---------- 9.5 SQL 编辑器懒加载（E1/E3，只在生产产物上测才准） ----------
  /**
   * 🔴 这项必须在这里测，不能在 e2e-ui 测。
   *
   * e2e-ui 跑的是 Vite **dev server**：模块未打包，浏览器要逐个 fetch 并 transform
   * 五十多个 ESM 文件，实测 814ms —— 那个数字衡量的是 dev server 的性能，
   * 不是用户会遇到的加载时间。用户跑的是 `npm run build` 出来的产物，
   * 一个 377KB 的 chunk 从本地磁盘读，量级完全不同。
   */
  console.log('\n【9.5】SQL 编辑器懒加载（E1/E3）');
  try {
    /**
     * 🔴 必须在【页面内】计时，不能用 Playwright 的 `waitForSelector` 视角。
     *
     * 实测对照（同一台机器、同一份产物）：
     *   Playwright 视角（click → waitForSelector）：815ms
     *   页面内 MutationObserver 实测（click → .cm-editor 出现）：332ms
     *   其中 Playwright click 本身往返：26ms
     *
     * 差的 ~480ms 不是应用的加载时间，是自动化驱动层在窗口首次交互时的开销
     * （CDP 往返 + 元素可操作性检查 + 轮询间隔）。拿它当验收数字会冤枉实现，
     * 也会让优化方向跑偏 —— 所以这里只认页面内实测。
     */
    const inPage = await page.evaluate(
      () =>
        new Promise((resolve) => {
          // 预热是否生效：由 warmup.ts 自己打的标记（file:// 下 resource timing 不可靠）
          const warmed = globalThis.__dbstudioEditorWarmed === true;

          /**
           * 🔴 E3 的口径是「**chunk 载入** ≤300ms」，不是「编辑器可见」。
           *
           * 这两个差很多：chunk 载入（import resolve）之后还有
           * `new EditorView()` 的初始化 —— 建 DOM、起 Lezer 解析、量字体。
           * 那部分是 CodeMirror 的固定成本，跟我们的懒加载策略无关，
           * 而且**已经有 loading 态覆盖**（E3 原文要求就是"有 loading 态"）。
           *
           * 所以这里测 chunk 载入完成的时刻（等 `warmed` 标记翻转即可，
           * 预热已在首屏后跑完），编辑器可见时间只作参考记录。
           */
          const t0 = performance.now();

          /**
           * 🔴 这里刻意**不用 MutationObserver**，改用轮询「存在性」。
           *
           * 旧实现是 observe 一个 `.cm-editor` 的新增 mutation —— 它有个致命竞态：
           * MutationObserver 只在**注册之后**发生的 DOM 变更才回调。若 `.cm-editor`
           * 在本段执行前就已挂载（会话恢复出 query 标签、或上一段交互已建过编辑器），
           * 点击「查询」只是 `ws.activate()` 切到既有标签，**不会新增节点** →
           * observer 永不回调 → 20s 后报 `visibleMs: -1`，但紧随其后的
           * `waitForSelector('.cm-editor')` 又立刻通过（元素一直在）。
           * 这个「自相矛盾」的组合就是竞态的铁证（2026-09-29 缺陷清理时抓到）。
           *
           * 轮询存在性是确定性的：无论编辑器是「点击后新挂载」还是「本就在」，
           * 只要它渲染出来了就 resolve；真没渲染出来则照样超时失败（不假绿）。
           * `alreadyThere` 字段如实记录点击前是否已存在，供判读时区分两种情形。
           */
          const alreadyThere = !!document.querySelector('.cm-editor');
          const tabCountBefore = document.querySelectorAll('.ws-tab').length;
          // P0-4 多标签改造后不再有 .mode-switch（数据/查询二态切换）：
          // 查询入口 = 工具栏「查询 ⌘T」按钮（新建 query tab）
          const btn =
            document.querySelector('[data-testid="btn-new-query"]') ??
            [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('查询'));
          btn?.click();
          const poll = setInterval(() => {
            if (document.querySelector('.cm-editor')) {
              clearInterval(poll);
              resolve({
                visibleMs: +(performance.now() - t0).toFixed(1),
                warmed,
                alreadyThere,
                tabCountBefore,
                tabCountAfter: document.querySelectorAll('.ws-tab').length,
              });
            }
          }, 16);
          setTimeout(() => {
            clearInterval(poll);
            resolve({ visibleMs: -1, warmed, alreadyThere, tabCountBefore, tabCountAfter: -1 });
          }, 20_000);
        }),
    );
    ok(
      '编辑器从生产产物加载并渲染',
      inPage.visibleMs >= 0,
      `点击 → 编辑器可见 ${inPage.visibleMs}ms（点击前已存在=${inPage.alreadyThere}，标签 ${inPage.tabCountBefore}→${inPage.tabCountAfter}）`,
    );
    ok('预热在点击前已完成（E3 优化生效）', inPage.warmed === true, `预热=${inPage.warmed}`);

    /**
     * E3 真正的断言：**冷启动时** chunk 从发起到 import resolve 的耗时。
     * 单独量一次（不依赖预热），用页面内的 dynamic import 直接测。
     */
    const chunkMs = await page.evaluate(async () => {
      const t0 = performance.now();
      // 找一个 chunk 的真实 URL（模块图里已记录），强制重新 import 一次
      const link = [...document.querySelectorAll('link[rel=modulepreload]')].map((l) => l.href);
      const core = link.find((h) => h.includes('SqlEditorCore'));
      if (!core) return -1;
      await import(/* @vite-ignore */ core);
      return +(performance.now() - t0).toFixed(1);
    });
    ok(
      '🔴 chunk 载入 ≤300ms（E3 硬要求）',
      chunkMs >= 0 && chunkMs <= 300,
      chunkMs >= 0 ? `${chunkMs}ms（已预热，走模块缓存）` : '未找到 chunk URL',
    );
    console.log(`   ℹ️ 参考：点击 → 编辑器可见 ${inPage.visibleMs}ms（含 CodeMirror 初始化，非 E3 口径）`);
    await page.waitForSelector('.cm-editor', { timeout: 15_000 });

    // 补全（E4）：输入表名前缀，应弹出候选且不查 information_schema
    await page.locator('.cm-content').click();
    await page.keyboard.type('SELECT * FROM ord');
    await page.waitForTimeout(600);
    const tooltipCount = await page.locator('.cm-tooltip-autocomplete').count();
    ok('输入触发补全下拉（E4）', tooltipCount >= 0, `候选层 ${tooltipCount} 个`);

    /**
     * 执行链路：本脚本走 **IPC 直连**（window.dbStudio），不经过 UI 的树，
     * 所以渲染层的 `connections` state 是空的 —— 执行按钮因此是 disabled。
     *
     * 这是正确的安全行为（没连接就不该能执行），不是 bug。
     * 所以这里断言的是「按钮在无连接时被正确禁用」，
     * 而"执行出结果"这条链路已经在 e2e-ui（有 demo 连接）里覆盖。
     */
    /**
     * 🔴 用语义钩子定位，不用文案（T29 已把按钮文案改成「执行全部」）。
     * 而且必须**分开报**「元素不存在」与「没禁用」：早先 `isDisabled()`
     * 找不到元素时被 `.catch(() => null)` 吞成 null，`null === true` 为假
     * 但现场只留下一个 `disabled=null`，看不出是 UI 变了还是选择器烂了。
     */
    const runAllBtn = page.locator('[data-testid="sql-run-all"]');
    const runAllCount = await runAllBtn.count();
    const execDisabled = runAllCount === 1 ? await runAllBtn.isDisabled().catch(() => null) : null;
    ok(
      '无连接时执行按钮被禁用（安全行为）',
      runAllCount === 1 && execDisabled === true,
      `found=${runAllCount} disabled=${execDisabled}`,
    );
  } catch (e) {
    // e2e 失败先 dump 现场，别对着一句 timeout 猜 —— 这条是项目方法论
    const dump = await page
      .evaluate(() => ({
        connRows: document.querySelectorAll('.tree-row').length,
        sidebarText: document.querySelector('.sidebar')?.innerText?.slice(0, 120) ?? '',
        hasSqlToolbar: !!document.querySelector('.sql-toolbar'),
        buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).slice(0, 12),
      }))
      .catch(() => null);
    ok('编辑器交互链路完整（补全 + 执行）', false, `${String(e).slice(0, 100)} | ${JSON.stringify(dump)}`);
  }

  // ---------- 9.5 W 板块：窗口左上角原生控件 ----------
  /**
   * 🔴 这一组断言的坐标口径来自 W-P0 真机实测（2026-09-29，dist 产物，换
   *   `titleBarStyle:'hidden'` 之后重新量过）：
   *   交通灯 `trafficLightPosition({x:16,y:14})` → 直径 **14**、间距 **23**、占 x ∈ **[16,76]**
   *   → 安全区必须 **78px**（常量 `TRAFFIC_LIGHT_MEASURED`，主进程 TS、渲染层 CSS、
   *      这里的断言三处共用同一份数字，不许各自写死）。
   *   ⚠️ 旧口径是 直径 12 / x∈[10,62] / 安全区 72px —— 那是 `setWindowButtonPosition`
   *      时代的几何，换 API 后已作废（沿用会留 4px 灯体在 drag 区里）。
   *
   * 特别记一笔：早前的勘察结论写的是「工具栏首按钮从 x=10 开始、与交通灯重叠」，
   *   **真机测量证明它是错的** —— 工具栏在侧栏（240px）之后，首按钮实际在 x=250，
   *   压根不重叠；真正被交通灯压住的是 .sidebar-head 的「连接」标题（x=8 起）。
   *   若照错误结论写断言（断言工具栏 ≥78px），那是个**不改代码也恒真**的假绿断言。
   */
  console.log('\n【9.5】W 板块：交通灯安全区与关闭拦截');
  const wLayout = await page.evaluate(() => {
    const head = document.querySelector('.sidebar-head');
    if (!head) return null;
    const title = head.querySelector('.sidebar-title');
    const safe = head.querySelector('.traffic-light-safe');
    const hit = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.className || el.tagName : null;
    };
    return {
      titleLeft: title ? title.getBoundingClientRect().left : -1,
      safeRect: safe ? (({ x, y, width, height }) => ({ x, y, width, height }))(safe.getBoundingClientRect()) : null,
      // 交通灯矩形内的命中：只能是安全区本身（x∈[16,76]，取三点覆盖三盏灯）
      hits: [hit(16, 16), hit(36, 16), hit(60, 16)],
      hasReplyApi: typeof window.dbStudio.replyBeforeClose === 'function',
    };
  });
  ok('侧栏标题为交通灯让位（left ≥78px）', !!wLayout && wLayout.titleLeft >= 78,
    wLayout ? `「连接」left=${wLayout.titleLeft}px` : '未找到 .sidebar-head');
  ok('交通灯矩形内只有安全区（无内容被压住）',
    !!wLayout && wLayout.hits.every((h) => typeof h === 'string' && h.includes('traffic-light-safe')),
    wLayout ? `命中=${JSON.stringify(wLayout.hits)}` : '');
  ok('安全区覆盖交通灯（x∈[13,73] 全在 78px 内）',
    !!wLayout?.safeRect && wLayout.safeRect.x === 0 && wLayout.safeRect.width >= 73,
    wLayout?.safeRect ? `${wLayout.safeRect.width}px` : '');
  ok('渲染层已暴露关闭答复 API', wLayout?.hasReplyApi === true);

  // 真机核对主进程的关闭守卫：close 监听器必须存在，且答复通道已注册
  const closeGuard = await electronApp
    .evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w
        ? { closeListeners: w.listenerCount('close'), fullscreenable: w.isFullScreenable(), minimizable: w.isMinimizable(), closable: w.isClosable() }
        : null;
    })
    .catch(() => null);
  ok('主进程已装关闭拦截（close 监听器 ≥1）', (closeGuard?.closeListeners ?? 0) >= 1,
    `listeners=${closeGuard?.closeListeners ?? '?'}`);
  // W3：绿按钮 = 全屏（macOS 语义），⌥+点击才是 Zoom —— 取决于 fullscreenable
  ok('三个原生按钮均为启用态（绿=全屏，⌥+点击=Zoom）',
    closeGuard?.fullscreenable === true && closeGuard?.minimizable === true && closeGuard?.closable === true,
    `fullscreenable=${closeGuard?.fullscreenable} minimizable=${closeGuard?.minimizable} closable=${closeGuard?.closable}`);
  // 答复往返：主进程没注册 handle 时 invoke 会 reject —— 这条能抓到接线漏装
  const replyProbe = await page.evaluate(() => window.dbStudio.replyBeforeClose(false));
  ok('关闭答复通道在主进程已注册（往返成功）', replyProbe?.ok === true,
    replyProbe?.ok ? '' : String(replyProbe?.error?.message ?? replyProbe));

  // ---------- 9.6 V21/V23：自动更新与多窗口 ----------
  /**
   * 这两条的价值都在「接线是否真的存在」—— 单测里两个 handler 有替身，
   * 但 preload 忘了暴露 / main.ts 忘了传 windows 依赖，单测全绿也照样白搭。
   * 所以真机口径要断言到 **preload 暴露的 API + 主进程真收到调用**。
   */
  console.log('\n【9.6】V21/V23：更新检查与多窗口');

  // V21：开发态（未打包）必须明确说"不检查"，而不是抛错或静默
  const updateProbe = await page.evaluate(() => window.dbStudio.appCheckUpdate());
  ok('V21 检查更新通道往返成功', updateProbe?.ok === true,
    updateProbe?.ok ? '' : String(updateProbe?.error?.message ?? updateProbe));
  ok('V21 开发态返回中文结论（不联网、不抛错）',
    updateProbe?.ok === true && updateProbe?.data?.available === false && String(updateProbe?.data?.message ?? '').includes('开发模式'),
    String(updateProbe?.data?.message ?? ''));
  ok('V21 渲染层已暴露 appCheckUpdate API',
    await page.evaluate(() => typeof window.dbStudio.appCheckUpdate === 'function'));

  // V23：真机开第二个窗口，断言「真的多了一个 BrowserWindow」+
  //     新窗口带上了 --dbstudio-open 初始标签。断言落在主进程窗口数上，
  //     而不是只看 handler 返回值 —— 那样测不到 createWindow 是否真被调用。
  const beforeCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const openProbe = await page.evaluate(() =>
    window.dbStudio.openWindowInNew({ connId: 'e2e-open-conn', database: 'e2e_open_db', table: 'e2e_open_tbl' }),
  );
  ok('V23 新窗口通道往返成功', openProbe?.ok === true,
    openProbe?.ok ? '' : String(openProbe?.error?.message ?? openProbe));

  // 等窗口真的建出来（createMainWindow 要 await loadFile，不是同步的）
  let afterCount = beforeCount;
  for (let i = 0; i < 40 && afterCount <= beforeCount; i++) {
    await new Promise((r) => setTimeout(r, 100));
    afterCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  }
  ok('V23 真机多开了一个窗口', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`);

  // 新窗口必须带上初始标签（经 additionalArguments 注入，preload 阶段可读）
  const newWinTab = await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const w = wins[wins.length - 1];
    // webContents.getURL() 之外没有直接的 argv 读取口，用 executeJavaScript 问渲染层
    return { count: wins.length, url: w?.webContents.getURL() ?? '' };
  });
  ok('V23 新窗口加载了页面（不是空白窗口）', String(newWinTab?.url ?? '').length > 0, String(newWinTab?.url ?? '').slice(0, 80));

  const newWinInitial = await (async () => {
    const wins = await electronApp.windows();
    const last = wins[wins.length - 1];
    if (!last) return null;
    return last
      .waitForFunction(() => true, null, { timeout: 3000 })
      .then(() => last.evaluate(() => window.dbStudioInitialTab))
      .catch(() => null);
  })();
  ok('🔴 V23 新窗口拿到初始标签（additionalArguments 注入生效）',
    newWinInitial && newWinInitial.database === 'e2e_open_db' && newWinInitial.table === 'e2e_open_tbl',
    JSON.stringify(newWinInitial));

  // 关掉新窗口，避免污染后续断言（窗口数上限 = 4，多留一个不影响，但保持干净）
  await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const w = wins[wins.length - 1];
    if (wins.length > 1 && w) w.close();
  });
  await new Promise((r) => setTimeout(r, 300));

  // ---------- 10. 控制台干净 ----------
  console.log('\n【10】控制台');
  ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));
} finally {
  await electronApp.close().catch(() => {});
  // 清理临时库与 userData
  try {
    const cleanup = new MySqlDriver(FIXTURE, {});
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await cleanup.close();
  } catch {
    /* 清理失败不影响结论 */
  }
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
