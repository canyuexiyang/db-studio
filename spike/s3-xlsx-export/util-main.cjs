'use strict';
// Electron 主进程：验证 export worker 在 utilityProcess 里能跑起来、能被 kill。
// 复用根目录 Electron 44.4.3（../../node_modules/electron）。
//   Test A: fork 一个 worker 跑完 10万行，记录「fork -> 结束」总耗时 + 结果。
//   Test B: fork 一个 worker 跑 100万行，中途 kill()，验证进程确实消亡、无残留。
const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const worker = path.join(__dirname, 'util-worker.cjs');

function forkAndRun(rows, mode, outPath) {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(worker, [], {
      serviceName: 's3-export-test',
      env: { ROWS: String(rows), MODE: mode, OUT: outPath },
    });
    const forkAt = Date.now();
    let settled = false;
    child.on('message', (m) => {
      if (m.type === 'done') {
        settled = true;
        resolve({ ok: true, totalMs: Date.now() - forkAt, timeMs: m.timeMs, peakRss: m.peakRss, fileBytes: m.fileBytes, pid: child.pid });
      } else if (m.type === 'error') {
        settled = true;
        resolve({ ok: false, error: m.message });
      }
    });
    child.on('exit', (code, sig) => { if (!settled) resolve({ ok: false, exitCode: code, exitSig: sig }); });
  });
}

function forkAndKill(rows, mode, outPath, killAfterMs) {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(worker, [], {
      serviceName: 's3-export-kill',
      env: { ROWS: String(rows), MODE: mode, OUT: outPath },
    });
    const forkAt = Date.now();
    const pid = child.pid;
    let exitCode = null, exitSig = null, exited = false;
    child.on('exit', (code, sig) => { exited = true; exitCode = code; exitSig = sig; });
    // 轮询存活，确认在 kill 之前确实是活着的
    let aliveSeen = false;
    const poll = setInterval(() => {
      try { process.kill(pid, 0); aliveSeen = true; } catch (e) { aliveSeen = false; }
    }, 200);
    setTimeout(() => {
      clearInterval(poll);
      const aliveBefore = (() => { try { process.kill(pid, 0); return true; } catch (e) { return false; } })();
      child.kill(); // 真取消：kill() 整个 utilityProcess
      setTimeout(() => {
        let stillAlive = false;
        try { process.kill(pid, 0); stillAlive = true; } catch (e) { stillAlive = false; }
        const fileExisted = fs.existsSync(outPath);
        try { fs.unlinkSync(outPath); } catch (e) {}
        resolve({
          forkToKillMs: Date.now() - forkAt, pid,
          aliveBeforeKill: aliveBefore, everAlive: aliveSeen,
          stillAliveAfterKill: stillAlive,
          fileExisted, killedCleanly: !stillAlive,
          childExitCode: exitCode, childExitSig: exitSig, childExitedBeforeKill: exited,
        });
        app.quit();
      }, 800);
    }, killAfterMs);
  });
}

app.whenReady().then(async () => {
  try {
    console.log('--- Test A: complete export in utilityProcess ---');
    const a = await forkAndRun(100000, 'default', '/tmp/s3_util_complete.xlsx');
    console.log(JSON.stringify({ test: 'complete', ...a }));

    console.log('--- Test B: kill mid-export ---');
    const b = await forkAndKill(1000000, 'default', '/tmp/s3_util_kill.xlsx', 2500);
    console.log(JSON.stringify({ test: 'kill', ...b }));
  } catch (e) {
    console.error('UTIL_TEST_ERROR', e);
    app.quit();
  }
});
