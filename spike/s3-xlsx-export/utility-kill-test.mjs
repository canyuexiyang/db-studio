/**
 * S3 补充：验证 utilityProcess 可 kill（"真取消"的产品承诺）
 * 用根目录已装好的 Electron 44.4.3 启动，fork 一个执行长任务的 utilityProcess，
 * 中途 kill()，验证：
 *   1. 进程确实被杀掉（exit 事件 + 系统进程消失）
 *   2. 主进程不受影响（继续存活）
 *   3. 输出文件是"半截"（因此产品必须删或标记未完成）
 */
import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 本 Spike 只验证 utilityProcess 的 fork/kill 语义，不需要 GPU。
// 沙箱在脚本化启动下会失败（S1 已踩同坑），关掉以避免 GPU 进程崩溃拖垮主进程。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

const OUT = path.join(os.tmpdir(), 'dbstudio-kill-test.txt');

// utility 侧脚本：不停往文件追加，模拟长导出任务
const WORKER = path.join(os.tmpdir(), 'dbstudio-worker.cjs');
fs.writeFileSync(WORKER, `
const fs = require('fs');
const OUT = process.argv[2];
let n = 0;
const t = setInterval(() => {
  fs.appendFileSync(OUT, 'row-' + (n++) + '\\n');
  if (process.parentPort) process.parentPort.postMessage({ n });
}, 50);
process.on('exit', () => clearInterval(t));
`);

const result = {
  fork_ok: false,
  messages_received: 0,
  kill_ok: false,
  exit_event: null,
  process_gone: null,
  main_alive_after_kill: null,
  partial_file_bytes: null,
  kill_latency_ms: null,
};

app.whenReady().then(async () => {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

  const child = utilityProcess.fork(WORKER, [OUT], {
    stdio: 'pipe',
    serviceName: 'dbstudio-export-probe',
  });

  result.fork_ok = !!child.pid;
  result.pid = child.pid;
  console.log('[main] utilityProcess forked, pid=' + child.pid);

  child.on('message', (msg) => {
    result.messages_received++;
    if (result.messages_received === 1) console.log('[main] 收到首条消息:', JSON.stringify(msg));
  });

  let exitResolve;
  const exitPromise = new Promise((r) => { exitResolve = r; });
  child.on('exit', (code) => {
    result.exit_event = { code };
    console.log('[main] utility exit, code=' + code);
    exitResolve();
  });

  // 让它跑 600ms，产生一些输出
  await new Promise((r) => setTimeout(r, 600));

  const sizeBefore = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  const t0 = Date.now();
  const killed = child.kill();
  result.kill_ok = killed;
  console.log('[main] kill() 返回值=' + killed);

  // 等 exit 事件（最多 3s）
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
  result.kill_latency_ms = Date.now() - t0;

  // 验证进程真的没了
  const gone = !isProcessAlive(child.pid);
  result.process_gone = gone;
  console.log('[main] 进程是否已消失: ' + gone);

  // 主进程是否还活着
  result.main_alive_after_kill = process.pid > 0 && !process.exitCode;
  console.log('[main] 主进程存活: ' + result.main_alive_after_kill);

  result.partial_file_bytes = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  result.messages_received_before_kill = result.messages_received;
  console.log('[main] 半截文件字节数: ' + result.partial_file_bytes + ' (kill 前: ' + sizeBefore + ')');

  // 再等 400ms 看文件是否还在增长（证明真停了）
  const s1 = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  await new Promise((r) => setTimeout(r, 400));
  const s2 = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  result.stopped_writing = (s1 === s2);
  console.log('[main] kill 后是否停止写入: ' + result.stopped_writing + ' (' + s1 + ' → ' + s2 + ')');

  fs.writeFileSync(
    path.join(process.cwd(), 'raw', 'utility-kill.json'),
    JSON.stringify(result, null, 2)
  );
  console.log('\n结果: ' + JSON.stringify(result, null, 2));

  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  if (fs.existsSync(WORKER)) fs.unlinkSync(WORKER);
  app.quit();
});

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = 探活
    return true;
  } catch {
    return false;
  }
}
