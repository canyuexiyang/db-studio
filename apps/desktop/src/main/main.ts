/**
 * 应用入口（主进程）
 *
 * 启动顺序刻意这么排 —— 每一条都有依据，别随手调：
 *  1. app.whenReady() 后**立刻**建窗口并 loadURL。
 *     ⚠️ 不要为了等 safeStorage 初始化而阻塞窗口（PRD §7.2）。
 *     凭据子系统的探测是异步的，慢一点无所谓，窗口晚 200ms 出来才是灾难。
 *  2. 驱动懒加载：mysql2 只有真的连库时才 require（S2：冷启动真实瓶颈在
 *     应用首屏 JS 体积，但能省的还是省）。
 *  3. IPC handler 在窗口创建【之前】注册 —— 渲染层一加载就可能发请求，
 *     晚注册会出现"channel not found"。
 *  4. 玻璃降级路径已内置 try/catch，绝不冒泡（低于 Darwin 26 会抛异常）。
 *
 * 退出前必须 closeAll()，否则连接句柄泄漏会让进程退不干净。
 */

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { join } from 'node:path';

import { createMainWindow, getGlassState, installCloseGuard, registerCloseGuardIpc } from './window.js';
import { scheduleStartupCheck } from './updater.js';
import { WindowManager } from './window-manager.js';
import { installAppMenu } from './menu.js';
import { ConnectionStore } from './connection-store.js';
import { SessionRegistry } from './session-registry.js';
import { registerIpcHandlers, EVENT_CONN_STATE } from './ipc-handlers.js';
import { SshTunnelManager } from './tunnel-manager.js';
import { TransferManager } from './transfer-manager.js';
import { SchemaCache } from '@dbstudio/core-schema-cache';
import { HistoryStore } from '@dbstudio/core-history';
import { SecretStore } from '@dbstudio/core-secret';

/**
 * 产物目录。
 * 主进程以 CJS 输出（Electron 的 ESM 入口不提供命名导出），
 * 所以这里用 __dirname 而非 import.meta.url。
 */
const HERE = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** userData 目录：连接配置 / schema 缓存 / 历史库都在这里 */
function userDataDir(): string {
  // 测试可覆盖到临时目录，避免 e2e 污染真实用户数据
  return process.env.DB_STUDIO_E2E_USER_DATA || app.getPath('userData');
}

let mainWindow: BrowserWindow | null = null;

/**
 * 单一实例锁：自用工具，开两个窗口只会互相抢连接。
 *
 * ⚠️ 自动化测试必须能绕过它（DB_STUDIO_NO_SINGLE_LOCK=1）。
 *    否则连续跑 e2e 时，上一轮残留的进程会占住锁，
 *    新实例直接 app.quit() 退出 —— 表现为 Playwright
 *    报 "Target page has been closed"，极难定位。
 */
const singleLock = process.env.DB_STUDIO_NO_SINGLE_LOCK !== '1';

if (singleLock && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (singleLock) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(boot).catch((e) => {
    console.error('[dbstudio] 启动失败：', e);
    app.quit();
  });
}

async function boot(): Promise<void> {
  const dataDir = userDataDir();

  // ---- 子系统（顺序无关，都不阻塞窗口）----
  const secrets = new SecretStore(safeStorage as any);
  // 刻意不 await：凭据探测不该挡住首屏。窗口先出来，探测完了自己更新状态。
  void secrets.init().then((s) => {
    console.log(`[dbstudio] safeStorage: ${s.mode}${s.reason ? ' — ' + s.reason : ''}`);
  });

  const connections = new ConnectionStore(dataDir, secrets);
  const cache = new SchemaCache(dataDir);
  const history = new HistoryStore(join(dataDir, 'history.db'));

  /**
   * SSH 隧道管理器。
   *
   * 构造**不加载 ssh2** —— 只有真的去连一条开了隧道的连接时才懒加载
   * （评审 §5.1）。没开隧道的用户永远不为 SSH 付启动成本。
   */
  const tunnels = new SshTunnelManager({
    credentials: (cfg) => connections.sshCredentialsFor(cfg),
  });
  const sessions = new SessionRegistry(cache, undefined, tunnels);

  /**
   * 导入导出管理器（utilityProcess worker 生命周期）。
   * worker 文件不经 vite 构建，由 scripts/copy-workers.mjs 原样拷贝到 dist。
   */
  const transfers = new TransferManager({ connections, sessions, getWindow: () => mainWindow });

  /**
   * V23 多窗口管理器。
   *
   * 🔴 关键：新窗口**必须复用 createMainWindow**（而不是自己 new BrowserWindow）——
   *    否则玻璃、交通灯定位、关闭守卫这些形态会在第二个窗口上悄悄缺失，
   *    属于最难发现的那类缺陷（第一个窗口一切正常）。
   *
   * 关闭守卫在 createWindow 里逐窗口安装；询问通道由 registerCloseGuardIpc 全局装一次。
   */
  const windows = new WindowManager({
    here: HERE,
    createWindow: async (opts) => {
      const paths = windows.paths();
      const win = await createMainWindow({
        preloadPath: paths.preloadPath,
        htmlPath: paths.htmlPath,
        devUrl: process.env.DB_STUDIO_DEV_URL,
        initialTab: opts.initialTab,
        title: opts.title,
      });
      installCloseGuard(win);
      return win;
    },
  });

  /**
   * 密钥轮换回调（Electron 44 safeStorage 语义）。
   *
   * 系统密钥轮换后，旧密文仍能解出明文，但它停留在【被轮换掉的旧密钥】上。
   * 收到通知就把该连接的密码用新密钥重新加密落盘，让密文跟上轮换。
   *
   * 不阻塞：轮换是低频事件，落盘失败只记日志，绝不影响用户继续用。
   * 明文仅在回调内存里出现，不写进日志。
   */
  secrets.onReencryptNeeded = (oldCipherBase64, plain) => {
    void (async () => {
      try {
        const newCipher = await secrets.encrypt(plain);
        await connections.replaceCipher(oldCipherBase64, newCipher);
        console.log('[dbstudio] safeStorage 密钥已轮换，密文已重新加密');
      } catch (e: any) {
        // 落盘失败不该打断使用：下次解密仍会再次触发轮换通知
        console.error('[dbstudio] 密文轮换失败（不影响使用）：', String(e?.message ?? e));
      }
    })();
  };

  // ---- IPC：必须在窗口创建前注册 ----
  registerCloseGuardIpc(ipcMain); // W 板块：关闭询问通道【全局注册一次】

  registerIpcHandlers({
    ipcMain,
    connections,
    sessions,
    history,
    secrets,
    transfers,
    getWindow: () => mainWindow,
    windows,
  });

  // ---- D1：连接状态变化推送（断线横幅的信号源） ----
  // ① 自动重连的密码供给器：现取现用、绝不留存明文（与握手同口径）。
  //    不接它自动重连会因无凭据停在 failed，横幅的手动重连仍可用。
  sessions.setPasswordProvider((id) => connections.passwordFor(id));
  // ② 每次状态迁移都推给渲染层（断线/失败带 lastError，供横幅展示原因）。
  //    ⚠️ V23 起走 windows.broadcast —— 只推 mainWindow 的话，
  //    第二个窗口的连接横幅永远不会更新（"另一个窗口已连接，这个还写着连接中"）。
  sessions.setOnStateChange((id, state, lastError) => {
    windows.broadcast(EVENT_CONN_STATE, { id, state, lastError });
  });

  // ---- 窗口 ----
  // ⚠️ 产物路径：主进程在 dist/main/，preload 在 dist/preload/，
  //    渲染层在 renderer/dist/（vite 的默认输出目录）。
  //    这三段相对关系不能靠猜 —— 猜错的表现是窗口白屏 + ERR_FAILED，
  //    而且因为 loadFile 失败是 reject 出来的，日志很难看懂。
  const devUrl = process.env.DB_STUDIO_DEV_URL;
  mainWindow = await createMainWindow({
    preloadPath: join(HERE, '../preload/preload.cjs'),
    htmlPath: join(HERE, '../../renderer/dist/index.html'),
    devUrl,
  });

  console.log(`[dbstudio] 玻璃模式：${getGlassState().mode}${getGlassState().reason ? ' — ' + getGlassState().reason : ''}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // V23：主窗口也登记进管理器 —— 它算进「窗口数上限」也参与 broadcast。
  // 不登记的话：开 3 个新窗口后管理器只数到 3，上限形同虚设（实际已 4 个）。
  windows.register(mainWindow);

  // W 板块：原生红按钮的关闭拦截（脏标签不能被静默丢弃）。
  // ⚠️ 必须在 installAppMenu 之前装好：菜单里的「关闭窗口」也走同一条 close 路径。
  installCloseGuard(mainWindow);

  // V21：启动后静默检查更新（只在打包产物里跑；失败静默、绝不阻塞首屏）
  scheduleStartupCheck(() => mainWindow);

  // F1 macOS 原生菜单：窗口建好后再装。菜单项点击只经 EVENT_MENU_COMMAND
  // 转发给渲染层分派（见 menu.ts），不影响这里的 boot 顺序与退出清理语义。
  installAppMenu(() => mainWindow);

  // ---- 退出清理 ----
  const shutdown = async (): Promise<void> => {
    // 先杀导入导出 worker（它们握着独立 DB 连接）
    try {
      transfers.cancelAll();
    } catch {
      // 退出路径上不再尝试恢复
    }
    try {
      await sessions.closeAll();
    } catch {
      // 退出路径上不再尝试恢复
    }
    try {
      history.close();
    } catch {
      // 同上
    }
  };

  app.on('before-quit', () => {
    void shutdown();
  });
  app.on('window-all-closed', () => {
    void shutdown().finally(() => app.quit());
  });
}

export { boot };
