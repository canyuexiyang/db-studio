/**
 * 真机验证：空闲自动断开 → 下一次操作自动重连出数据（v1.3 缺陷 1 的遗留项）
 *
 * 为什么单靠单测不够：缺陷 1 的根因是「渲染层看不到主进程的状态迁移」，
 * 而 66 项 session-registry 单测全用替身驱动 —— 它们证明不了
 * 「真 MySQL 上，等过 idle 超时之后，再连一次还能查出真数据」。
 * 真机等 10 分钟不现实（门禁里等不起），所以这里把 idleTimeoutMs 调小跑一遍：
 * **真驱动 + 真库 + 真定时器**，只是把 10 分钟压成几秒。
 *
 * 验证的是三件事：
 *  1. 空闲到点状态机真的走到 closed，且**推送**出来（渲染层订阅的就是这条）
 *  2. 资源真释放：驱动被 close（否则白占服务端连接数）
 *  3. 再连一次（= 渲染层 ensureConnection）能出真数据 —— 用户不会看到空表格
 *
 * 隧道场景另验 AGENTS.md §四.7 孤儿隧道红线：idle 释放时隧道必须跟着关，
 * 否则下一次 connect 新建隧道，旧的变孤儿（真 SSH 下就是留一个 ssh 子进程）。
 * 这里用假隧道管理器（forward 到真 MySQL 的 TCP），数据仍是真的。
 *
 * 运行：npm run e2e:idle（tsx）
 * 前置：docker dbstudio-mysql 在 13306 监听；没有就跳过（不算失败）
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

/** 默认 3s：够短到能进门禁，又够长到不会和建连握手抢时间 */
const IDLE_MS = Number(process.env.DB_STUDIO_E2E_IDLE_MS ?? 3000);
const SQL = 'SELECT * FROM `bench`.`big_table` LIMIT 2';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 轮询等待条件成立（定时器是系统时钟，只能等） */
async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`   ⏱️  等待「${label}」超时（${timeoutMs}ms）`);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log(`⏭️  跳过空闲重连真机验证：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

/**
 * 带探针的驱动工厂：真驱动，但记录「造了几个 / 关了几个」。
 * 🔴 只包 close，不改任何行为 —— 探针本身不能改变被测对象的语义
 *    （这是本项目反复踩过的坑：替身照着自己的假设实现，测出来的是替身）。
 */
function spyDriverFactory() {
  const stat = { created: 0, closed: 0 };
  const factory = async (cfg, password, ctx) => {
    const d = await realDriverFactory(cfg, password, ctx);
    stat.created++;
    const rawClose = d.close.bind(d);
    d.close = async () => {
      stat.closed++;
      await rawClose();
    };
    return d;
  };
  return { factory, stat };
}

/**
 * 假隧道管理器：不开真 SSH，直接把字节流 forward 到真 MySQL。
 * 于是「隧道路径」跑的是**真 MySQL 协议与真数据**，只有跳板机那段是替身 ——
 * 要验的是隧道的生命周期（开/关/不孤儿），不是 ssh2 本身（那是 e2e-ssh 的活）。
 */
function fakeTunnelManager() {
  const stat = { opened: 0, closed: 0 };
  const mgr = {
    async open(cfg, target) {
      stat.opened++;
      let closed = false;
      return {
        tunnel: {
          // 幂等：驱动 close 与 registry 兜底各调一次，只认第一次
          async close() {
            if (closed) return;
            closed = true;
            stat.closed++;
          },
        },
        streamFactory: () =>
          new Promise((resolve, reject) => {
            const sock = createConnection({ host: target.host, port: target.port });
            sock.once('connect', () => resolve(sock));
            sock.once('error', reject);
          }),
      };
    },
  };
  return { mgr, stat };
}

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-idle-'));
const cache = new SchemaCache(workDir);
const t0 = Date.now();

try {
  // =====================================================================
  console.log('\n【A】直连：空闲断开 → 重连出数据');
  // =====================================================================
  const spy = spyDriverFactory();
  const reg = new SessionRegistry(cache, spy.factory);

  const pushes = [];
  reg.setOnStateChange((_id, state) => pushes.push(state));

  const cfgA = defaultConnectionConfig({
    id: 'e2e-idle-direct',
    name: 'e2e idle direct',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    idleTimeoutMs: IDLE_MS,
  });

  const first = await reg.connect(cfgA, FIXTURE.password);
  check('A1 连接成功并取到服务端版本', reg.stateOf(cfgA.id) === 'connected' && !!first.serverVersion,
    `${first.serverVersion} / ${first.elapsedMs}ms`);

  const q1 = await reg.runQuery(cfgA.id, SQL);
  check('A2 首查拿到真数据', q1.rowCount > 0, `rowCount=${q1.rowCount}`);

  const wentClosed = await waitFor('空闲超时 → closed', () => reg.stateOf(cfgA.id) === 'closed', IDLE_MS * 4);
  check('A3 空闲到点后状态真的变成 closed', wentClosed, `state=${reg.stateOf(cfgA.id)}`);
  check('A4 closed 被推送出来（渲染层订阅的就是这条）', pushes.includes('closed'),
    `推送序列=${pushes.join('→')}`);
  check('A5 驱动被真释放（不是只推状态机）', spy.stat.closed === 1,
    `created=${spy.stat.created} closed=${spy.stat.closed}`);

  // 断开后直接查：这就是用户看到「表格空白」的现场
  let code = '';
  try {
    await reg.runQuery(cfgA.id, SQL);
  } catch (e) {
    code = e?.code ?? 'UNKNOWN';
  }
  check('A6 断开后不重连直接查会报 NOT_CONNECTED（空表格的成因）', code === 'NOT_CONNECTED', `code=${code}`);

  // 渲染层 ensureConnection 走的就是这一步
  await reg.connect(cfgA, FIXTURE.password);
  check('A7 重连成功', reg.stateOf(cfgA.id) === 'connected', `state=${reg.stateOf(cfgA.id)}`);

  const q2 = await reg.runQuery(cfgA.id, SQL);
  check('A8 重连后查到真数据（不再是空表格）', q2.rowCount === q1.rowCount,
    `rowCount=${q2.rowCount}（首查 ${q1.rowCount}）`);
  check('A9 驱动确属重建而非复用旧连接', spy.stat.created === 2,
    `created=${spy.stat.created}`);

  // =====================================================================
  console.log('\n【B】隧道：空闲释放不得留孤儿隧道（AGENTS §四.7 红线）');
  // =====================================================================
  const spyB = spyDriverFactory();
  const tun = fakeTunnelManager();
  const regB = new SessionRegistry(cache, spyB.factory, tun.mgr);

  const cfgB = defaultConnectionConfig({
    id: 'e2e-idle-tunnel',
    name: 'e2e idle tunnel',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
    idleTimeoutMs: IDLE_MS,
    ssh: { enabled: true, host: '127.0.0.1', port: 22, user: 'fake', authType: 'privateKey', passwordEnc: null, privateKeyPath: null, passphraseEnc: null },
  });

  await regB.connect(cfgB, FIXTURE.password);
  const tq1 = await regB.runQuery(cfgB.id, SQL);
  check('B1 隧道路径连得上且查到真数据', tq1.rowCount > 0, `rowCount=${tq1.rowCount}`);

  const bClosed = await waitFor('隧道会话空闲 → closed', () => regB.stateOf(cfgB.id) === 'closed', IDLE_MS * 4);
  check('B2 隧道会话空闲到点后变 closed', bClosed, `state=${regB.stateOf(cfgB.id)}`);
  // 等一拍：releaseIdleSession 是异步的（定时器回调里 fire-and-forget）
  await waitFor('隧道被关闭', () => tun.stat.closed >= 1, 3000);
  check('B3 隧道随空闲释放被关闭（不留孤儿进程）', tun.stat.closed === 1,
    `opened=${tun.stat.opened} closed=${tun.stat.closed}`);
  check('B4 会话里已无存活隧道句柄', regB.liveTunnelCount() === 0, `live=${regB.liveTunnelCount()}`);

  await regB.connect(cfgB, FIXTURE.password);
  const tq2 = await regB.runQuery(cfgB.id, SQL);
  check('B5 隧道会话重连后查到真数据', regB.stateOf(cfgB.id) === 'connected' && tq2.rowCount === tq1.rowCount,
    `rowCount=${tq2.rowCount}`);
  check('B6 重连开的是新隧道，旧的那条没被重复关', tun.stat.opened === 2 && tun.stat.closed === 1,
    `opened=${tun.stat.opened} closed=${tun.stat.closed}`);

  await regB.disconnect(cfgB.id);
  check('B7 收尾后隧道全部关闭（opened === closed）', tun.stat.opened === tun.stat.closed,
    `opened=${tun.stat.opened} closed=${tun.stat.closed}`);

  await reg.closeAll();
} catch (e) {
  check('未捕获异常', false, e instanceof Error ? `${e.message}` : String(e));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} 空闲重连真机验证：${results.length - failed.length}/${results.length} 通过（${Date.now() - t0}ms，idle=${IDLE_MS}ms）`);
process.exit(failed.length === 0 ? 0 : 1);
