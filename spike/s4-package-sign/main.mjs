/**
 * S4 — 打包与签名验证的被测应用
 * 关键点：
 *  1. 主进程用 ESM（electron-window-glass 的 exports 只声明 import，require 会 ERR_PACKAGE_PATH_NOT_EXPORTED）
 *  2. GlassProvider 用 try/catch 包住，降级不冒泡到 whenReady
 *  3. 用 os.release() 判 Darwin 内核版本（不解析市场版本号 "27"）
 *  4. 不开 vibrancy（与 transparent 冲突）
 *  5. 交通灯用 setWindowButtonPosition + setWindowButtonVisibility
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 脚本化启动时 macOS 沙箱初始化会失败，导致 GPU 进程崩溃并拖垮主进程。
// 这是测量环境的问题，不影响打包链路本身（S1 已踩同坑，结论一致）。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

const RESULT_PATH = process.env.S4_RESULT || path.join(os.tmpdir(), 's4-result.json');

const result = {
  electron_version: process.versions.electron,
  node_version: process.versions.node,
  chrome_version: process.versions.chrome,
  arch: process.arch,
  platform: process.platform,
  darwin_release: os.release(),
  glass_load: null,
  glass_apply: null,
  traffic_lights: null,
  window_created: false,
  errors: [],
};

// Darwin 内核主版本（实测 Darwin 26 == macOS 27.0）
const darwinMajor = parseInt(os.release().split('.')[0], 10);
result.darwin_major = darwinMajor;

async function loadGlass() {
  try {
    const mod = await import('electron-window-glass');
    result.glass_load = { ok: true, exports: Object.keys(mod) };
    return mod;
  } catch (e) {
    result.glass_load = { ok: false, error: e.code || e.message };
    return null;
  }
}

async function createWindow() {
  // ⚠️ 不能同时开 vibrancy —— 与 transparent 冲突会模糊错乱
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    vibrancy: undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(app.getAppPath(), 'preload.cjs'), // sandbox:true 时 preload 必须 CJS
    },
  });
  result.window_created = true;

  // 交通灯：frame:false 下唯一可用组合
  try {
    const hasPos = typeof win.setWindowButtonPosition === 'function';
    const hasVis = typeof win.setWindowButtonVisibility === 'function';
    let posErr = null;
    try {
      if (hasPos) win.setWindowButtonPosition({ x: 16, y: 14 });
      if (hasVis) win.setWindowButtonVisibility(true);
    } catch (e) { posErr = e.message; }
    result.traffic_lights = {
      setWindowButtonPosition: hasPos,
      setWindowButtonVisibility: hasVis,
      call_error: posErr,
    };
  } catch (e) {
    result.traffic_lights = { error: e.message };
  }

  // GlassProvider.applyTo() —— 必须 try/catch，禁止冒泡到 whenReady
  const glass = await loadGlass();
  if (glass && glass.createWindowGlass && darwinMajor >= 26) {
    try {
      const g = glass.createWindowGlass(win, { kind: 'glass' });
      result.glass_apply = { ok: true, kind: g && g.kind ? g.kind : 'applied' };
    } catch (e) {
      result.glass_apply = { ok: false, error: e.message };
    }
  } else {
    result.glass_apply = { ok: false, reason: !glass ? 'module load failed' : 'darwin < 26' };
  }

  await win.loadFile(path.join(app.getAppPath(), 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (e) {
    result.errors.push('createWindow: ' + e.message);
  }
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log('S4_RESULT=' + JSON.stringify(result, null, 2));
  setTimeout(() => app.quit(), 800);
});
