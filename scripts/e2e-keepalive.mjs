/**
 * 真机验证：心跳保活真的让连接活着（0.7.1 需求 4）
 *
 * ## 为什么单测不够
 *
 * 单测里的驱动是替身，"心跳发了 SELECT 1" 这件事它能演出 1 万次，但**服务端的
 * wait_timeout 是不是真的被重置了**，只有真 MySQL 知道。而这正是用户报的症状：
 * 「几分钟、十几分钟就连不上了」—— 本地定时器不会说谎，说谎的是"我以为还活着"。
 *
 * ## 三段验证，其中 B 段是证伪臂
 *
 *   【A】服务端 wait_timeout 压到 5s，闲置 20s → 连接仍 connected 且能直接查。
 *   【B】**同样的 5s，但把保活关掉（keepAliveMs = 0）→ 9s 后连接必须死。**
 *        没有 B，A 就是假绿：A 通过也可能只是因为 wait_timeout 根本没生效。
 *   【C】`KILL CONNECTION` 后，两次心跳内应走既有自动重连链路恢复到可查 ——
 *        证明"判死"接的是 autoReconnect，不是直接把连接打成 failed 弹横幅。
 *
 * 全程 idleTimeoutMs = 0（本地永不自动断开），把"本地空闲超时"这个变量隔离掉：
 * A 段活下来只能是心跳的功劳，B 段死掉只能是服务端 wait_timeout 的功劳。
 *
 * 运行：npm run e2e:keepalive
 * 前置：docker dbstudio-mysql 在 13306 监听；没有就跳过（不算失败）
 * 提速：DB_STUDIO_E2E_ALIVE_MS / DB_STUDIO_E2E_DEAD_MS 可调（门禁里用默认值）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import { SessionRegistry, realDriverFactory } from '../apps/desktop/src/main/session-registry.js';
import { SchemaCache } from '../packages/core-schema-cache/src/index.js';
import { defaultConnectionConfig } from '../packages/core-connection/src/index.js';

const FIXTURE = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

/** 心跳间隔。扫描周期 = max(1000, KA/2)，所以 1000 已是最快档 */
const KA_MS = Number(process.env.DB_STUDIO_E2E_KA_MS ?? 1000);
/** 服务端把闲置连接掐掉的时间（秒）—— 压到 5s，让"十几分钟失效"变成几秒内可观测 */
const SERVER_TIMEOUT_S = 5;
/** A 段：保活开着，闲置这么久必须还活着 */
const IDLE_ALIVE_MS = Number(process.env.DB_STUDIO_E2E_ALIVE_MS ?? 20_000);
/** B 段：保活关掉，闲置这么久必须已经死了（> 2× wait_timeout） */
const IDLE_DEAD_MS = Number(process.env.DB_STUDIO_E2E_DEAD_MS ?? 9_000);

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（真定时器，只能等） */
async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  console.log(`   ⏱️  等待「${label}」超时（${timeoutMs}ms）`);
  return false;
}

// ---------- 依赖检查：fixture 不在就跳过，不算失败 ----------
async function fixtureAlive() {
  try {
    return await new Promise((resolve) => {
      const s = createConnection({ host: FIXTURE.host, port: FIXTURE.port });
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
  console.log(`⏭️  跳过心跳保活真机验证：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

/**
 * 带探针的驱动工厂：真驱动，只**计数**不改变行为。
 * 🔴 探针自己不能有语义 —— 之前踩过：替身照着自己的假设实现，测出来的是替身。
 */
function spyDriverFactory() {
  const stat = { created: 0, closed: 0, pings: 0, history: [] };
  const factory = async (cfg, password, ctx) => {
    const d = await realDriverFactory(cfg, password, ctx);
    stat.created++;
    stat.history.push({ connId: cfg.id, driver: d });

    const rawQuery = d.query.bind(d);
    d.query = async (sql, ...rest) => {
      // 只认心跳那条固定文本：用来证明"是心跳救的"，不是别的什么东西
      if (/^\s*SELECT\s+1\s*$/i.test(String(sql))) stat.pings++;
      return rawQuery(sql, ...rest);
    };

    const rawClose = d.close.bind(d);
    d.close = async () => {
      stat.closed++;
      await rawClose();
    };
    return d;
  };
  /** 某条连接最新一次的驱动实例（重连后会换新实例） */
  const latest = (connId) => {
    for (let i = stat.history.length - 1; i >= 0; i--) {
      if (stat.history[i].connId === connId) return stat.history[i].driver;
    }
    return null;
  };
  const createdOf = (connId) => stat.history.filter((h) => h.connId === connId).length;
  return { factory, stat, latest, createdOf };
}

function makeRegistry(spy, keepAliveMs) {
  // passwordProvider 必须给：C 段的自动重连现取现用密码，不给就是"无凭据重连失败"
  return new SessionRegistry(
    new SchemaCache(workDir),
    spy.factory,
    null,
    async () => FIXTURE.password,
    keepAliveMs,
  );
}

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-ka-'));
const t0 = Date.now();

try {
  // =====================================================================
  console.log(`\n【A】服务端 wait_timeout=${SERVER_TIMEOUT_S}s，保活开着，闲置 ${IDLE_ALIVE_MS}ms 仍可查`);
  // =====================================================================
  const spyA = spyDriverFactory();
  const regA = makeRegistry(spyA, KA_MS);
  const pushesA = [];
  regA.setOnStateChange((id, state) => id === 'e2e-ka-alive' && pushesA.push(state));

  const cfgA = defaultConnectionConfig({
    id: 'e2e-ka-alive',
    name: 'e2e keepalive alive',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    // 本地永不自动断开：变量隔离，A 段活下来只能是心跳的功劳
    idleTimeoutMs: 0,
  });

  await regA.connect(cfgA, FIXTURE.password);
  check('A1 连接成功', regA.stateOf(cfgA.id) === 'connected', `state=${regA.stateOf(cfgA.id)}`);

  await regA.runQuery(cfgA.id, `SET SESSION wait_timeout = ${SERVER_TIMEOUT_S}`);
  await regA.runQuery(cfgA.id, `SET SESSION interactive_timeout = ${SERVER_TIMEOUT_S}`);
  const connIdA = spyA.latest(cfgA.id)?.connectionId ?? 0;
  check('A2 服务端会话超时已压到 5s（否则 A 段等于没测）', connIdA > 0, `connectionId=${connIdA}`);

  // 闲置：期间只允许心跳在跑
  await sleep(IDLE_ALIVE_MS);

  check('A3 闲置 20s（4 倍 wait_timeout）后仍 connected', regA.stateOf(cfgA.id) === 'connected',
    `state=${regA.stateOf(cfgA.id)}，推送序列=${pushesA.join('→') || '(无)'}`);
  check('A4 期间从未被推成 disconnected / failed', !pushesA.some((s) => s === 'disconnected' || s === 'failed'),
    `推送序列=${pushesA.join('→') || '(无)'}`);
  // 扫描周期是间隔的一半，所以实测心跳间隔落在 [KA, 1.5×KA]（见 armKeepAlive 注释：
  // 「到点后最迟再过半个周期就发」）—— 断言按 2×KA 起算，别照理想值写。
  check('A5 心跳确实发出去了（不是"碰巧没被掐"）',
    spyA.stat.pings >= Math.floor(IDLE_ALIVE_MS / (2 * KA_MS)) - 1,
    `SELECT 1 次数=${spyA.stat.pings}（设计区间 ${Math.floor(IDLE_ALIVE_MS / (1.5 * KA_MS))}~${Math.floor(IDLE_ALIVE_MS / KA_MS)}）`);
  check('A6 驱动没被重建（保活不该顺手重连）', spyA.createdOf(cfgA.id) === 1,
    `created=${spyA.createdOf(cfgA.id)}`);

  // 关键一步：直接查（用户的下一步操作）
  const qa = await regA.runQuery(cfgA.id, 'SELECT 1 AS ok');
  check('A7 闲置后直接查仍出数据（用户视角"一直挂着也能查"）', qa.rowCount === 1, `rowCount=${qa.rowCount}`);
  check('A8 还是原来那条连接（服务端没踢过我们）',
    spyA.latest(cfgA.id)?.connectionId === connIdA,
    `connectionId=${spyA.latest(cfgA.id)?.connectionId}（原 ${connIdA}）`);

  await regA.closeAll();

  // =====================================================================
  console.log(`\n【B】证伪臂：同样的 wait_timeout=${SERVER_TIMEOUT_S}s，但保活关闭 → 必须真的死`);
  // =====================================================================
  const spyB = spyDriverFactory();
  const regB = makeRegistry(spyB, 0); // keepAliveMs = 0 → 不 arm 扫描器
  const cfgB = defaultConnectionConfig({
    id: 'e2e-ka-off',
    name: 'e2e keepalive off',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    idleTimeoutMs: 0,
  });

  await regB.connect(cfgB, FIXTURE.password);
  await regB.runQuery(cfgB.id, `SET SESSION wait_timeout = ${SERVER_TIMEOUT_S}`);
  await sleep(IDLE_DEAD_MS);

  check('B1 保活关闭时一次心跳都不发', spyB.stat.pings === 0, `SELECT 1 次数=${spyB.stat.pings}`);

  let bCode = '';
  try {
    await regB.runQuery(cfgB.id, 'SELECT 1 AS ok');
  } catch (e) {
    bCode = e?.code ?? 'UNKNOWN';
  }
  // 这一条是整份脚本的"证伪开关"：它红了说明服务端超时没生效，
  // 那么 A 段的全绿就不能证明保活有用
  const LOST_CODES = [
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'ECONNRESET',
    'EPIPE',
    'ER_CLIENT_INTERACTION_TIMEOUT',
  ];
  check('B2 服务端真的把闲置连接掐了（证明 A 段不是假绿）', LOST_CODES.includes(bCode),
    `code=${bCode || '(没报错)'}`);

  await regB.closeAll();

  // =====================================================================
  console.log('\n【C】KILL CONNECTION → 两次心跳内判死 → 自动重连 → 恢复可查');
  // =====================================================================
  const spyC = spyDriverFactory();
  const regC = makeRegistry(spyC, KA_MS);
  const pushesC = [];
  regC.setOnStateChange((id, state) => id === 'e2e-ka-kill' && pushesC.push(state));

  const cfgC = defaultConnectionConfig({
    id: 'e2e-ka-kill',
    name: 'e2e keepalive kill',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    idleTimeoutMs: 0,
  });
  // 杀手连接：另一条独立会话，用它的权限去 KILL，不污染被杀的连接
  const cfgK = defaultConnectionConfig({
    id: 'e2e-ka-killer',
    name: 'e2e keepalive killer',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    idleTimeoutMs: 0,
  });

  await regC.connect(cfgC, FIXTURE.password);
  await regC.connect(cfgK, FIXTURE.password);
  const victimId = spyC.latest(cfgC.id)?.connectionId ?? 0;
  const killerId = spyC.latest(cfgK.id)?.connectionId ?? 0;
  check('C1 受害者与杀手是两条不同连接', victimId > 0 && killerId > 0 && victimId !== killerId,
    `victim=${victimId} killer=${killerId}`);

  const qc1 = await regC.runQuery(cfgC.id, 'SELECT 1 AS ok');
  check('C2 KILL 前可正常查', qc1.rowCount === 1, `rowCount=${qc1.rowCount}`);

  await regC.runQuery(cfgK.id, `KILL CONNECTION ${victimId}`);
  console.log(`   🔪 已 KILL CONNECTION ${victimId}（服务端强制断开，模拟空闲被掐/网络设备回收）`);

  // 两次心跳（≈2s）+ 重连退避（1s）以内应回到 connected 且换了一条服务端连接
  const recovered = await waitFor(
    'KILL 后自动重连恢复',
    () => regC.stateOf(cfgC.id) === 'connected' && (spyC.latest(cfgC.id)?.connectionId ?? 0) !== victimId,
    20_000,
  );
  check('C3 心跳判死后走了自动重连并回到 connected', recovered,
    `state=${regC.stateOf(cfgC.id)}，推送序列=${pushesC.join('→')}`);
  check('C4 中途经过断线态（说明不是原地假装没事）',
    pushesC.includes('disconnected') || pushesC.includes('failed'),
    `推送序列=${pushesC.join('→')}`);
  check('C5 真的换了服务端连接（不是复用死 socket）',
    (spyC.latest(cfgC.id)?.connectionId ?? 0) !== victimId,
    `connectionId=${spyC.latest(cfgC.id)?.connectionId}（原 ${victimId}）`);

  const qc2 = await regC.runQuery(cfgC.id, 'SELECT 1 AS ok');
  check('C6 恢复后立刻可查（用户不用手动重连）', qc2.rowCount === 1, `rowCount=${qc2.rowCount}`);
  check('C7 自动重连只重建了受害者的驱动（杀手那条没被动）',
    spyC.createdOf(cfgC.id) === 2 && spyC.createdOf(cfgK.id) === 1,
    `victim 创建=${spyC.createdOf(cfgC.id)} killer 创建=${spyC.createdOf(cfgK.id)}`);

  await regC.closeAll();
} catch (e) {
  check('未捕获异常', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 心跳保活真机验证：${results.length - failed.length}/${results.length} 通过` +
    `（${Date.now() - t0}ms，ka=${KA_MS}ms，server wait_timeout=${SERVER_TIMEOUT_S}s）`,
);
process.exit(failed.length === 0 ? 0 : 1);
