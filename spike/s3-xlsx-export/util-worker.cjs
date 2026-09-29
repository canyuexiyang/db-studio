'use strict';
// 在 utilityProcess 中运行的导出 worker。通过 process.parentPort 与父进程通信。
// 注意：Electron 44 中 utilityProcess 子进程的端口挂在 process.parentPort（而非 require('electron').parentPort）。
// 复用 export-core.cjs 的 exceljs 流式导出，证明导出 worker 能在 utilityProcess 里跑起来。
const parentPort = process.parentPort;
const fs = require('node:fs');
const { runExport } = require('./export-core.cjs');

async function main() {
  const rows = parseInt(process.env.ROWS || '100000', 10);
  const mode = process.env.MODE || 'default';
  const outPath = process.env.OUT || '/tmp/s3_util.xlsx';
  parentPort.postMessage({ type: 'ready', pid: process.pid });
  const res = await runExport({ rows, mode, outPath });
  try { fs.unlinkSync(outPath); } catch (e) {} // 测完删除产物
  parentPort.postMessage({ type: 'done', ...res });
}
main().catch((e) => {
  try { parentPort.postMessage({ type: 'error', message: String((e && e.stack) || e) }); } catch (_) {}
});
