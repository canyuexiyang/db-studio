// DB Studio Spike S1 — 主进程（ESM）：按 --group 构造窗口，跑 FPS 探针，并支持 --gpu / --tl 子探针。
// 用 ESM 是因为 electron-window-glass@1.0.0 仅提供 import 导出（CJS require 会被 ERR_PACKAGE_PATH_NOT_EXPORTED 拒绝）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow, ipcMain } from 'electron';

const ROOT = '/Users/guhui/software/ai-project/work-buddy/database-app';
const HERE = import.meta.dirname;
const RAW_DIR = path.join(HERE, 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

// 文件日志：用 `open`/后台启动时 stdout 无法回传终端，统一写一份到 raw/run.log。
const LOGFILE = path.join(RAW_DIR, 'run.log');
try { fs.writeFileSync(LOGFILE, ''); } catch {}
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); _origLog(s); try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {} };
console.error = (...a) => { const s = a.map(String).join(' '); _origErr(s); try { fs.appendFileSync(LOGFILE, 'ERR ' + s + '\n'); } catch {} };

const argv = process.argv.slice(2);
const getOpt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const GROUP = getOpt('--group');
const MODE = GROUP ? 'fps' : (argv.includes('--gpu') ? 'gpu' : argv.includes('--tl') ? 'tl' : 'fps');

const DARWIN = parseInt(os.release(), 10); // Darwin 内核版本，macOS 27 → 26A428 → 26
const SYSINFO = {
  platform: os.platform(),
  arch: os.arch(),
  darwinRelease: os.release(),
  darwinMajor: DARWIN,
  isGlassSupported: DARWIN >= 26,
  electron: process.versions.electron,
  node: process.versions.node,
  date: new Date().toISOString(),
};

// ---- 玻璃包（ESM import，try/catch 包裹，失败不冒泡） ----
let createWindowGlass = null;
const glassLoad = { loaded: false, error: null, path: null, exports: null };
try {
  const m = await import('electron-window-glass');
  createWindowGlass = m.createWindowGlass;
  glassLoad.loaded = true;
  glassLoad.path = path.join(HERE, 'node_modules', 'electron-window-glass');
  glassLoad.exports = Object.keys(m);
} catch (e) {
  glassLoad.loaded = false;
  glassLoad.error = String((e && e.stack) || e);
}

// 关闭 Chromium / GPU 沙箱：本环境（Bash/CI）无 Seatbelt 权限，否则 GPU 进程崩溃。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function windowConfigFor(group) {
  const base = {
    width: 1100, height: 760, show: false,
    backgroundColor: '#ffffff', vibrancy: undefined,
    transparent: false, frame: true, roundedCorners: true, alwaysOnTop: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  };
  if (group === 'G1' || group === 'G2') {
    return Object.assign({}, base, {
      transparent: true, backgroundColor: '#00000000', roundedCorners: false, frame: false, vibrancy: undefined,
    });
  }
  if (group === 'G3' || group === 'G4') {
    return Object.assign({}, base, { transparent: false, frame: true, vibrancy: undefined });
  }
  return base;
}

function applyGlass(win) {
  const r = { attempted: false, applied: false, error: null, kind: null };
  if (!createWindowGlass) { r.error = 'glass module not loaded'; return r; }
  if (DARWIN < 26) { r.attempted = true; r.error = 'Darwin ' + DARWIN + ' < 26，玻璃 API 不可用（按 PRD 应降级）'; return r; }
  r.attempted = true;
  try {
    const m = createWindowGlass(win, { kind: 'glass' });
    if (m) { r.applied = true; r.kind = m.kind; }
    else { r.error = 'createWindowGlass 返回 null（窗口句柄不可用或系统不支持）'; }
  } catch (e) { r.error = String((e && e.stack) || e); }
  return r;
}

function runFps(group) {
  const cfg = windowConfigFor(group);
  const rows = group === 'G4' ? 100 : 10000;
  const win = new BrowserWindow(cfg);
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  try { win.setPosition(120, 100); } catch {}
  win.once('ready-to-show', () => { win.show(); win.focus(); app.focus({ steal: true }); });
  const keepFront = setInterval(() => { try { win.focus(); app.focus({ steal: true }); } catch {} }, 400);
  win.once('closed', () => clearInterval(keepFront));

  let glassResult = null;
  if (group === 'G1') {
    win.webContents.once('did-finish-load', () => { glassResult = applyGlass(win); });
  }

  win.webContents.on('console-message', () => {});
  win.once('ready-to-show', () => console.log('[S1] window ready-to-show'));
  win.once('show', () => console.log('[S1] window shown'));

  ipcMain.once('probe:ready', () => {
    console.log('[S1] renderer ready — scheduling start in 800ms');
    setTimeout(() => {
      win.webContents.executeJavaScript('if(window.__startProbe){window.__startProbe();console.log("start issued");}else{console.log("NO __startProbe");}')
        .catch((e) => console.log('[S1] start error', String(e)));
    }, 800);
  });
  ipcMain.on('probe:rafcheck', (_e, info) => { console.log('[S1] RAF ' + info.rate1s + 'Hz visibility=' + info.visibility); });
  ipcMain.once('probe:error', (_e, msg) => { console.log('[S1] RENDERER FRAME ERROR: ' + msg); });

  ipcMain.once('probe:report', (_e, payload) => {
    const out = {
      group,
      window: {
        transparent: cfg.transparent, frame: cfg.frame, roundedCorners: cfg.roundedCorners,
        vibrancy: cfg.vibrancy ?? null, backgroundColor: cfg.backgroundColor,
        glassApplied: group === 'G1' ? (glassResult || { attempted: false, applied: false })
                                    : { attempted: false, applied: false, note: 'G2 不加玻璃' },
      },
      rows, cols: 20,
      sysinfo: SYSINFO,
      glassModule: glassLoad,
      result: payload,
    };
    const f = path.join(RAW_DIR, `fps-${group}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log(`[S1] ${group} DONE -> ${f}`);
    console.log(`[S1] ${group} P50=${payload.overall.p50Fps} P95=${payload.overall.p95Fps} dropRate=${payload.rounds[0].dropRate}%`);
    setTimeout(() => { try { win.close(); } catch {} app.quit(); }, 300);
  });

  const q = `?rows=${rows}&cols=20`;
  win.loadFile(path.join(HERE, 'index.html'), { search: q });
  setTimeout(() => {
    win.webContents.executeJavaScript('if(window.__startProbe) window.__startProbe();').catch(() => {});
  }, 1200);
}

async function captureGpuText(win) {
  await new Promise((r) => setTimeout(r, 6000));
  // chrome://gpu 是 SPA，特性状态在 <info-view> 的 shadow DOM；递归收集（含 shadowRoot）文本。
  const expr = `(() => {
    let out = '';
    const walk = (n) => {
      if (n.shadowRoot) out += ' ' + (n.shadowRoot.textContent || '');
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.textContent || '';
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(document);
    return out;
  })()`;
  try { return String(await win.webContents.executeJavaScript(expr)); } catch (e) { return 'ERR ' + String(e); }
}

function runGpu() {
  const mk = (transparent) => new BrowserWindow({
    width: 1100, height: 800, show: true,
    transparent, backgroundColor: transparent ? '#00000000' : '#ffffff',
    roundedCorners: false, frame: !transparent,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  const winOpaque = mk(false);
  winOpaque.setAlwaysOnTop(true, 'screen-saver', 1);
  const winTrans = mk(true);
  winTrans.setAlwaysOnTop(true, 'screen-saver', 1);
  winOpaque.loadURL('chrome://gpu');
  winTrans.loadURL('chrome://gpu');
  setTimeout(async () => {
    const opaqueText = await captureGpuText(winOpaque);
    const transText = await captureGpuText(winTrans);
    let complete = null, basic = null;
    try { complete = await app.getGPUInfo('complete'); } catch (e) { complete = 'ERR ' + String(e); }
    try { basic = await app.getGPUInfo('basic'); } catch (e) { basic = 'ERR ' + String(e); }
    const out = {
      mode: 'gpu', sysinfo: SYSINFO,
      chromeGpuText_opaque: opaqueText,
      chromeGpuText_transparent: transText,
      gpuInfoBasic: basic, gpuInfoComplete: complete,
    };
    const f = path.join(RAW_DIR, 'gpu-chrome.json');
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log(`[S1] GPU probe -> ${f} (opaque text len=${opaqueText.length}, trans text len=${transText.length})`);
    setTimeout(() => { try { winOpaque.close(); } catch {} try { winTrans.close(); } catch {} app.quit(); }, 300);
  }, 2000);
}

function runTrafficLights() {
  const results = { mode: 'tl', sysinfo: SYSINFO, tests: [], note: '' };
  const w1 = new BrowserWindow({
    width: 700, height: 500, show: true, frame: false, transparent: false,
    backgroundColor: '#ffffff', webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  w1.setAlwaysOnTop(true, 'screen-saver', 1);
  const t1 = { config: 'frame:false', methods: {} };
  for (const m of ['setWindowButtonVisibility', 'setWindowButtonPosition']) t1.methods[m] = typeof w1[m] === 'function';
  try {
    if (typeof w1.setWindowButtonVisibility === 'function') w1.setWindowButtonVisibility(true);
    if (typeof w1.setWindowButtonPosition === 'function') w1.setWindowButtonPosition({ x: 16, y: 14 });
    t1.applyResult = 'ok (no throw)';
  } catch (e) { t1.applyResult = 'THROW ' + String(e); }
  results.tests.push(t1);

  let w2 = null;
  const t2 = { config: "frame:true + titleBarStyle:'hiddenInset'", methods: {} };
  try {
    w2 = new BrowserWindow({
      width: 700, height: 500, show: true, frame: true,
      titleBarStyle: 'hiddenInset', backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    w2.setAlwaysOnTop(true, 'screen-saver', 1);
    t2.created = true;
    t2.applyResult = 'ok (constructor accepted titleBarStyle)';
  } catch (e) { t2.created = false; t2.applyResult = 'THROW ' + String(e); }
  results.tests.push(t2);

  const f = path.join(RAW_DIR, 'traffic-lights.json');
  fs.writeFileSync(f, JSON.stringify(results, null, 2));
  console.log(`[S1] TL probe -> ${f}`);
  console.log('[S1] TL: frame:false setWindowButtonPosition=' + t1.methods.setWindowButtonPosition +
              ' setWindowButtonVisibility=' + t1.methods.setWindowButtonVisibility +
              ' | titleBarStyle created=' + (t2.created === true));
  setTimeout(() => { try { w1.close(); } catch {} try { w2 && w2.close(); } catch {} app.quit(); }, 800);
}

app.whenReady().then(() => {
  const hardKill = setTimeout(() => { console.error('[S1] SAFETY TIMEOUT 150s — 强制退出'); process.exit(2); }, 150000);
  hardKill.unref();
  if (MODE === 'gpu') return runGpu();
  if (MODE === 'tl') return runTrafficLights();
  return runFps(GROUP || 'G3');
}).catch((e) => { console.error('[S1] FATAL', e); process.exit(1); });
