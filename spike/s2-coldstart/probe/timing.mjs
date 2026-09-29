// 冷启动计时核心：以 process 启动为 0 点，分解各阶段耗时。
// 主进程用 performance.now()（起点 ≈ process 启动），并交叉记录
// process.getCreationTime()（OS 进程创建时刻，绝对 ms）与编排脚本传入的 SPAWN_TS。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow, ipcMain } from 'electron';

const HERE = import.meta.dirname;
// 打包后 import.meta.dirname 落在 app.asar 内，不能往只读 asar 里写文件。
// 统一由编排脚本通过 RAW_DIR 指到真实可写目录；缺省回退到源码外的 raw。
const RAW = process.env.RAW_DIR
  ? path.resolve(process.env.RAW_DIR)
  : (fs.existsSync(HERE) && !HERE.includes('.asar')
      ? path.join(HERE, '..', 'raw')
      : path.join(os.tmpdir(), 's2-coldstart-raw'));
try { fs.mkdirSync(RAW, { recursive: true }); } catch {}

const GROUP = process.env.GROUP || 'C2';
const RUN = process.env.RUN_ID || '0';
const SPAWN_TS = Number(process.env.SPAWN_TS || 0);

// 文件日志（后台/打包启动时 stdout 不可回传终端）
const logFile = path.join(RAW, `run-${GROUP}-${RUN}.log`);
try { fs.writeFileSync(logFile, ''); } catch {}
const log = (...a) => {
  const s = a.map(String).join(' ');
  console.log(s);
  try { fs.appendFileSync(logFile, s + '\n'); } catch {}
};

// 计时基准
const CREATION = process.getCreationTime(); // 绝对时刻：OS 创建进程（≈exec）
const marks = { moduleTop: performance.now() }; // 模块首行 ≈ process 启动后极短

// 关闭沙箱（本环境无 Seatbelt 权限，否则 GPU 进程崩溃）
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function computePhases() {
  // performance.now() 起点 ≈ 进程启动（exec），因此各段可直接相加 = exec→可交互。
  return {
    execToModuleTop: +(marks.moduleTop).toFixed(1), // 进程 exec → 模块首行（Electron/Node 运行时初始化 + 加载入口模块）
    moduleTopToWhenReady: +(marks.whenReady - marks.moduleTop).toFixed(1),
    whenReadyToWindow: +(marks.windowCreated - marks.whenReady).toFixed(1),
    windowToDidFinishLoad: +(marks.didFinishLoad - marks.windowCreated).toFixed(1),
    didFinishLoadToPaint: +(marks.firstPaint - marks.didFinishLoad).toFixed(1),
    totalExecToInteractive: +(marks.firstPaint).toFixed(1),
  };
}

function startApp({ label }) {
  app.whenReady().then(() => {
    marks.whenReady = performance.now();
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    marks.windowCreated = performance.now();
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      try { app.focus({ steal: true }); } catch {}
    });
    const keepFront = setInterval(() => {
      try { win.focus(); app.focus({ steal: true }); } catch {}
    }, 400);
    win.once('closed', () => clearInterval(keepFront));

    win.webContents.once('did-finish-load', () => {
      marks.didFinishLoad = performance.now();
    });
    ipcMain.once('probe:first-paint', () => {
      marks.firstPaint = performance.now();
      finish();
    });
    // C1（朴素）：渲染进程首帧前同步加载 CodeMirror（模拟不做懒加载）
    const search = GROUP === 'C1' ? '?eager=1' : '';
    win.loadFile(path.join(HERE, 'index.html'), search ? { search } : undefined);
  });

  const hardKill = setTimeout(() => {
    log(`[S2 ${GROUP}] SAFETY TIMEOUT 60s — 强制退出`);
    process.exit(2);
  }, 60000);
  hardKill.unref();
}

function finish() {
  const nowAbs = Date.now();
  const out = {
    group: GROUP,
    run: RUN,
    label: 'DB Studio cold-start probe',
    sysinfo: {
      electron: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      darwin: os.release(),
    },
    creationEpoch: CREATION,
    spawnTs: SPAWN_TS || null,
    spawnToCreationMs: SPAWN_TS ? +(CREATION - SPAWN_TS).toFixed(1) : null,
    // 两个独立口径交叉验证 exec→可交互：
    totalFromPerf: +(marks.firstPaint).toFixed(1), // 主口径（process 启动起算，含运行时初始化）
    totalFromSpawn: SPAWN_TS ? +(nowAbs - SPAWN_TS).toFixed(1) : null, // 外部 spawn 起算（交叉验证）
    phases: computePhases(),
    marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +v.toFixed(1)])),
  };
  const f = path.join(RAW, `coldstart-${GROUP}-${RUN}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  log(`[S2 ${GROUP}#${RUN}] DONE total(perf)=${out.totalFromPerf}ms total(spawn)=${out.totalFromSpawn}ms -> ${f}`);
  setTimeout(() => { try { app.quit(); } catch {} }, 200);
}

export { startApp };
