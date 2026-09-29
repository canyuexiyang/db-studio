/**
 * S2 — 冷启动探针
 *
 * 三组对照：
 *   C1 朴素版：所有依赖（mysql2/pg/ssh2、node:sqlite）在启动路径上同步 require
 *   C2 懒加载版：驱动首次连接时才 await import；node:sqlite 首屏后开；无钥匙串同步调用
 *   C3 打包版：C2 + electron-builder 打包成 .app
 *
 * 埋点：进程 exec → whenReady → 窗口创建 → did-finish-load → 首次 paint
 * 通过环境变量 COLD_MODE 控制模式。
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require_ = createRequire(import.meta.url);

// 脚本化启动时 macOS 沙箱初始化失败会导致 GPU 进程崩溃并 FATAL 退出。
// 这三个开关只是让进程活下来，不参与渲染路径的性能测量（本 Spike 测的是启动链路）。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

const MODE = process.env.COLD_MODE || 'C2';
const RESULT_PATH = process.env.S2_RESULT;

// 进程真正被 exec 的时刻（由外部 shell 写入，精确到 ms）
const EXEC_TS = Number(process.env.S2_EXEC_TS || 0);

const marks = {};
function mark(name) {
  marks[name] = performance.now();
  marks[name + '_abs'] = Date.now();
}

mark('module_load_start');

// ---------- C1：朴素版，启动路径上同步 require 全部重依赖 ----------
if (MODE === 'C1') {
  const t0 = performance.now();
  try { require_('mysql2'); } catch (e) { marks.mysql2_error = e.message; }
  try { require_('pg'); } catch (e) { marks.pg_error = e.message; }
  try { require_('ssh2'); } catch (e) { marks.ssh2_error = e.message; }
  try {
    const { DatabaseSync } = require_('node:sqlite');
    const db = new DatabaseSync(path.join(os.tmpdir(), 's2-c1.db'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE IF NOT EXISTS h(id INTEGER PRIMARY KEY, sql TEXT)');
    db.close();
  } catch (e) { marks.sqlite_error = e.message; }
  marks.eager_require_ms = performance.now() - t0;
}

mark('whenReady_start');

app.whenReady().then(async () => {
  mark('whenReady_done');

  const win = new BrowserWindow({
    width: 900, height: 600,
    show: false, // 先不显示，等 did-finish-load 再 show，避免闪烁干扰
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mark('window_created');

  win.once('ready-to-show', () => { mark('ready_to_show'); });

  await win.loadFile(path.join(app.getAppPath(), 'index.html'));
  mark('did_finish_load');

  // 首次 paint：渲染侧 rAF 后回传，此处用 did-finish-load + 一次 ipc 近似
  // 更严谨的做法：在 renderer 里 requestAnimationFrame 后 ipcRenderer.send
  win.webContents.once('did-finish-load', () => { mark('did_finish_load_evt'); });
  win.webContents.on('paint', () => {
    if (!marks.first_paint) mark('first_paint');
  });

  win.show();
  mark('window_shown');

  // ---------- C2/C3：懒加载 —— 首屏完成后才开历史库 ----------
  if (MODE !== 'C1') {
    // 模拟"首屏渲染完成"之后的延迟加载
    setTimeout(async () => {
      const t0 = performance.now();
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path.join(os.tmpdir(), 's2-lazy.db'));
        db.exec('PRAGMA journal_mode=WAL');
        db.close();
      } catch (e) { marks.sqlite_error = e.message; }
      marks.lazy_sqlite_ms = performance.now() - t0;
    }, 0);
  }

  // 记录总耗时
  setTimeout(() => {
    const total = performance.now();
    const result = {
      mode: MODE,
      exec_ts: EXEC_TS,
      boot_ms: total,
      // 从 exec 到可交互（用 exec_ts 校准，若外部未提供则退化为进程内计时）
      wall_from_exec_ms: EXEC_TS ? (Date.now() - EXEC_TS) : null,
      marks,
      breakdown: {
        'runtime_init(exec→whenReady)': EXEC_TS ? (marks.whenReady_start_abs - EXEC_TS) : null,
        'whenReady→window_created': marks.window_created - marks.whenReady_done,
        'window_created→did_finish_load': marks.did_finish_load - marks.window_created,
        'did_finish_load→first_paint': marks.first_paint ? (marks.first_paint - marks.did_finish_load) : null,
      },
      electron: process.versions.electron,
      node: process.versions.node,
      arch: process.arch,
    };
    if (RESULT_PATH) fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log('S2_RESULT=' + JSON.stringify(result));
    app.quit();
  }, 600);
});
