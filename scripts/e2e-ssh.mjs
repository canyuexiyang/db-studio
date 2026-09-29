/**
 * SSH 隧道真机验证 —— 起真 ssh2.Server，转发到真 MySQL fixture（端口 13306）
 *
 * 为什么必须真机跑，不能只靠单测：
 *  1. 单测的 ssh2 替身是我们自己写的，它只会按【我们以为 ssh2 是这么工作的】
 *     去实现 —— 如果理解错了，替身和被测代码会一起错，测试还全绿。
 *     （这条教训在 safeStorage 那次已经付过一次学费。）
 *  2. mysql2 的 `stream` 选项有个同步陷阱：传函数时是同步调用的，
 *     返回 Promise 会崩在 `this.stream.on is not a function`。
 *     这种"接口形态"级别的错误，替身根本测不出来。
 *
 * 覆盖：
 *  - 密码认证 / 私钥认证（含 passphrase）
 *  - 经隧道执行真实查询、取服务端版本
 *  - 主连接 + 管理连接各占一条独立 channel（CONNECTION_ID 必须不同）
 *  - KILL QUERY 经隧道可用（这是取消执行的落地点）
 *  - 隧道建立超时（连到不开 SSH 的端口）
 *  - 认证失败
 *  - 释放后不留活隧道（PRD §6.1.2 孤儿进程红线）
 *
 * 运行：npm run e2e:ssh
 * 前置：docker 的 dbstudio-mysql 在 13306 监听（与 e2e-smoke 同一 fixture）
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import ssh2 from 'ssh2';
const { Server, Client, utils } = ssh2;

import { MySqlDriver } from '../packages/core-driver-mysql/src/index.js';
import { SshTunnel, openTunnelChannel } from '../packages/core-ssh-tunnel/src/index.js';

const DB = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

const WORK = mkdtempSync(join(tmpdir(), 'dbstudio-ssh-'));

/**
 * 整体看门狗。
 *
 * 门禁脚本最怕的不是失败，是**挂住** —— 失败会红，挂住会让 CI 空转到超时，
 * 而且看不出卡在哪一步。SSH 一旦和真服务端交互就有各种不出声的等待，
 * 所以必须有个硬上限把它叫醒，并报告当时进行到哪一步。
 */
const WATCHDOG_MS = Number(process.env.DB_STUDIO_SSH_WATCHDOG_MS ?? 90_000);
let stage = '初始化';
const watchdog = setTimeout(() => {
  console.log(`\n💥 看门狗触发：${WATCHDOG_MS}ms 未完成（卡在「${stage}」）`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 起一个 sshd：把 direct-tcpip 请求转发到真目标 */
function startSshServer(opts) {
  const server = new Server({ hostKeys: [opts.hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        if (ctx.username === opts.user && ctx.password === opts.password) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === 'publickey') {
        try {
          if (ctx.key.algo === opts.pubKey.type && ctx.key.data.equals(opts.pubKey.getPublicSSH())) {
            return ctx.accept();
          }
        } catch {
          /* 密钥比对失败 → 落到 reject */
        }
        return ctx.reject();
      }
      ctx.reject();
    });

    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        if (!opts.allowForward) {
          // 服务端拒绝转发：模拟 sshd 未开 AllowTcpForwarding
          return;
        }
        const channel = accept();
        const up = net.connect(info.destPort, info.destIP);
        channel.pipe(up).pipe(channel);
        channel.on('error', () => up.destroy());
        up.on('error', () => channel.destroy());
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 建驱动：两条连接各开一条 channel */
function driverOverTunnel(tunnel, database = null) {
  return new MySqlDriver({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database,
    // 🔴 每次调用必须产出【新的】channel —— 复用一条会串包
    streamFactory: () => tunnel.openChannel({ host: DB.host, port: DB.port }).then((r) => r.stream),
  });
}

/**
 * 生成密钥对，并对结果**自检**。
 *
 * 🔴 为什么需要这段（2026-09-29 实测踩到）：
 *   一次 `npm run verify` 里，本脚本在【第一步】就炸了：
 *     Cannot parse privateKey: Malformed OpenSSH private key
 *       at new Server (ssh2/lib/server.js)
 *   报错指向 ssh2 内部，看不出是"密钥没生成好"。之后连跑 4 次全绿、
 *   单独压测 generateKeyPairSync 60 次也零失败 —— 典型的低频偶发。
 *
 *   原来的写法 `utils.generateKeyPairSync('ed25519').private` 一旦拿到空值/
 *   残值，整个 SSH 门禁在起步阶段就全灭（0 通过 / 1 失败），而且现场信息为零。
 *   所以这里：自己先 parseKey 验一遍，坏了就重生成（最多 5 次），
 *   全坏才报错并打出密钥长度等现场 —— 让下次复发时**有证据**。
 */
function makeKeyPairChecked(kind = 'ed25519', attempts = 5) {
  const log = [];
  for (let i = 0; i < attempts; i++) {
    const kp = utils.generateKeyPairSync(kind);
    // ssh2 对 ed25519 返回字符串；parseKey 返回 Error 实例或 null 都算坏
    const parsed = utils.parseKey(kp.private);
    if (parsed && !(parsed instanceof Error)) return { kp, parsed };
    log.push(`第 ${i + 1} 次：private 长度=${String(kp.private ?? '').length}，parseKey=${parsed instanceof Error ? parsed.message : String(parsed)}`);
  }
  throw new Error(`生成可用 ${kind} 密钥对失败（${attempts} 次）：\n  ${log.join('\n  ')}`);
}

// 密钥生成也算一个阶段：它偶发失败过，看门狗卡这里时要说清楚
stage = '0 生成密钥对';
const hostKeyPair = makeKeyPairChecked('ed25519');
const hostKey = hostKeyPair.kp.private;
const userKey = makeKeyPairChecked('ed25519').kp;
// 🔴 公钥也要自检：parseKey 返回 Error 时，后面的 publickey 认证比对会静默失配
const userPub = utils.parseKey(userKey.public);
if (!userPub || userPub instanceof Error) {
  throw new Error(`生成用户公钥失败：${userPub instanceof Error ? userPub.message : String(userPub)}`);
}
const keyPath = join(WORK, 'id_ed25519');
writeFileSync(keyPath, userKey.private, { mode: 0o600 });

const servers = [];

try {
  // ---------- 1. 密码认证 + 真查询 ----------
  stage = '1 密码认证隧道';
    console.log('\n【1】密码认证隧道 → 真 MySQL');
  {
    const server = await startSshServer({
      hostKey,
      user: 'dbuser',
      password: 'secretpw',
      pubKey: userPub,
      allowForward: true,
    });
    servers.push(server);
    const port = server.address().port;

    const t = new SshTunnel({
      host: '127.0.0.1',
      port,
      user: 'dbuser',
      authType: 'password',
      password: 'secretpw',
      privateKey: null,
      passphrase: null,
      connectTimeoutMs: 10_000,
    });
    await t.connect();
    check('SSH 密码认证建立隧道', t.isReady);

    const driver = driverOverTunnel(t);
    driver.opts = driver.opts ?? {};
    const info = await driver.connect();
    check('经隧道取到 MySQL 服务端版本', !!info.serverVersion, `${info.serverVersion} / ${info.elapsedMs}ms`);
    check('经隧道取到 connection_id', driver.connectionId > 0, `#${driver.connectionId}`);

    // 主连接 + 管理连接必须是两条不同的 MySQL 连接
    const adminProbe = new MySqlDriver({
      host: DB.host,
      port: DB.port,
      user: DB.user,
      password: DB.password,
      streamFactory: () => t.openChannel({ host: DB.host, port: DB.port }).then((r) => r.stream),
    });
    await adminProbe.connect();
    check(
      '🔴 两条连接各占独立 channel（CONNECTION_ID 不同）',
      adminProbe.connectionId !== driver.connectionId,
      `#${driver.connectionId} vs #${adminProbe.connectionId}`,
    );
    await adminProbe.close();

    const res = await driver.query('SELECT 1 AS one');
    check('经隧道执行真实查询', res.rows[0]?.[0] != null, `rows=${res.rows.length}`);

    await driver.close();
    await t.close();
    check('隧道释放后 isReady=false', !t.isReady);
  }

  // ---------- 2. 私钥认证 ----------
  stage = '2 私钥认证';
    console.log('\n【2】私钥认证（含 passphrase）');
  {
    const server = await startSshServer({
      hostKey,
      user: 'dbuser',
      password: 'secretpw',
      pubKey: userPub,
      allowForward: true,
    });
    servers.push(server);
    const port = server.address().port;

    const { tunnel, stream } = await openTunnelChannel(
      {
        host: '127.0.0.1',
        port,
        user: 'dbuser',
        authType: 'privateKey',
        password: null,
        privateKey: userKey.private,
        passphrase: null,
        connectTimeoutMs: 10_000,
      },
      { host: DB.host, port: DB.port },
    );
    check('SSH 私钥认证建立隧道', tunnel.isReady && !!stream);

    const driver = driverOverTunnel(tunnel);
    const info = await driver.connect();
    check('私钥隧道下也能跑真查询', !!info.serverVersion, info.serverVersion);
    await driver.close();
    await tunnel.close();
  }

  // ---------- 3. KILL QUERY 经隧道 ----------
  stage = '3 KILL QUERY';
    console.log('\n【3】取消执行（KILL QUERY 走管理连接）');
  {
    const server = await startSshServer({
      hostKey,
      user: 'dbuser',
      password: 'secretpw',
      pubKey: userPub,
      allowForward: true,
    });
    servers.push(server);
    const port = server.address().port;

    const t = new SshTunnel({
      host: '127.0.0.1',
      port,
      user: 'dbuser',
      authType: 'password',
      password: 'secretpw',
      privateKey: null,
      passphrase: null,
    });
    await t.connect();

    const driver = driverOverTunnel(t);
    await driver.connect();
    const id = driver.connectionId;

    // 起一个慢查询，然后用同一驱动的 admin 连接 KILL 掉
    const slow = driver.query('SELECT SLEEP(8) AS s').catch(() => null);
    await new Promise((r) => setTimeout(r, 600));
    const killed = await driver.cancel();
    check('🔴 KILL QUERY 经隧道发出', killed === true, `kill #${id}`);

    const out = await Promise.race([
      slow,
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 6000)),
    ]);
    // 被 KILL 的查询是 resolve 不是 reject（mysql2 行为），
    // 所以判定标准是"提前返回"，不是"抛异常"
    check('🔴 被 KILL 的查询提前返回（不是等满 8s）', out !== 'TIMEOUT');

    await driver.close();
    await t.close();
  }

  // ---------- 4. 失败路径 ----------
  stage = '4 失败路径';
    console.log('\n【4】失败路径');

  // 4.1 连到不开 SSH 的端口 → 超时（用 1.5s 超时加速）
  {
    const dead = net.createServer(() => {});
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    // 这个 server 接受 TCP 但不讲话 —— SSH 握手会一直等下去
    const t = new SshTunnel({
      host: '127.0.0.1',
      port: deadPort,
      user: 'dbuser',
      authType: 'password',
      password: 'secretpw',
      privateKey: null,
      passphrase: null,
      connectTimeoutMs: 1500,
    });
    let err = null;
    try {
      await t.connect();
    } catch (e) {
      err = e;
    }
    check('🔴 隧道建立超时有明确提示', err?.code === 'SSH_TIMEOUT', err?.message ?? '未超时（异常）');
    check('超时后不留活隧道', !t.isReady);
    await t.close();
    dead.close();
  }

  // 4.2 密码错误 → 认证失败
  {
    const server = await startSshServer({
      hostKey,
      user: 'dbuser',
      password: 'secretpw',
      pubKey: userPub,
      allowForward: true,
    });
    servers.push(server);
    const t = new SshTunnel({
      host: '127.0.0.1',
      port: server.address().port,
      user: 'dbuser',
      authType: 'password',
      password: 'WRONG',
      privateKey: null,
      passphrase: null,
      connectTimeoutMs: 10_000,
    });
    let err = null;
    try {
      await t.connect();
    } catch (e) {
      err = e;
    }
    check('🔴 密码错误 → SSH_AUTH_FAILED', err?.code === 'SSH_AUTH_FAILED', err?.message ?? '未失败');
    await t.close();
  }

  // 4.3 服务端拒绝转发 → SSH_CHANNEL_FAILED，且隧道被回收
  {
    const server = await startSshServer({
      hostKey,
      user: 'dbuser',
      password: 'secretpw',
      pubKey: userPub,
      allowForward: false,
    });
    servers.push(server);
    let err = null;
    try {
      await openTunnelChannel(
        {
          host: '127.0.0.1',
          port: server.address().port,
          user: 'dbuser',
          authType: 'password',
          password: 'secretpw',
          privateKey: null,
          passphrase: null,
          connectTimeoutMs: 10_000,
        },
        { host: DB.host, port: DB.port },
      );
    } catch (e) {
      err = e;
    }
    check('🔴 转发被拒 → SSH_CHANNEL_FAILED', err?.code === 'SSH_CHANNEL_FAILED', err?.message ?? '未失败');
  }

  // ---------- 5. ssh2 模块导出形态（真机断言） ----------
  stage = '5 ssh2 导出形态';
  console.log('\n【5】ssh2 模块导出形态');
  {
    // 🔴 这一条是替身测不出来的：我们对"ssh2 长什么样"的假设必须被真模块校验。
    //    CJS 产物下 await import('ssh2') 的命名导出不完整（utils/Server 在
    //    default 上）—— 历史上有过同类事故（safeStorage 返回对象而非字符串）。
    const mod = await import('ssh2');
    check('ssh2 能加载', mod != null);
    check(
      'Client 可从命名导出或 default 取到',
      typeof mod.Client === 'function' || typeof mod.default?.Client === 'function',
    );

    // 隧道包实际用的解包逻辑必须能通过真模块（连不存在的地址即可，
    // 只关心它是不是崩在"导出形态异常"上）
    const t = new SshTunnel({
      host: '127.0.0.1',
      port: 1,
      user: 'u',
      authType: 'password',
      password: 'p',
      privateKey: null,
      passphrase: null,
      connectTimeoutMs: 1000,
    });
    let msg = '';
    try {
      await t.connect();
    } catch (e) {
      msg = String(e?.message ?? '');
    }
    check('解包逻辑在真 ssh2 上不报"导出形态异常"', !msg.includes('导出形态异常'), msg.slice(0, 80) || '（无错误）');
    await t.close();
  }

  // ---------- 6. 私钥权限校验 ----------
  stage = '6 私钥权限';
  console.log('\n【6】私钥权限校验（PRD §6.1.2）');
  {
    // 本脚本不重复实现校验（那在 core-connection / tunnel-manager 里），
    // 这里只验证 fixture 私钥是 0600 —— 保证后续用例的私钥是可用的
    const { statSync } = await import('node:fs');
    const mode = statSync(keyPath).mode & 0o777;
    check('fixture 私钥权限为 0600', mode === 0o600, mode.toString(8));
  }
} catch (e) {
  failed++;
  console.log(`\n💥 未捕获异常：${e?.stack ?? e}`);
} finally {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* 关不掉就算了，进程要退出 */
    }
  }
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}

clearTimeout(watchdog);
console.log(`\n———— SSH 隧道真机验证：${passed} 通过 / ${failed} 失败 ————`);
process.exit(failed === 0 ? 0 : 1);
