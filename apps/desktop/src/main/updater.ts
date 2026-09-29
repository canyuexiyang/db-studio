/**
 * V21 自动更新（electron-updater）
 *
 * 为什么现在才做、以及为什么是这个形态：
 *  这是 v1.0 就认下的长期欠账（F3）。DB Studio 是**自用单机工具**，
 *  没有发布通道、没有签名证书，所以这里刻意做成「半自动」：
 *
 *   - ✅ 启动后**静默检查**（只在打包产物里跑，开发态不跑，否则每次 npm start 都去联网）
 *   - ✅ 发现新版本 → 弹原生对话框，由用户决定去不去下载
 *   - ❌ **不自动下载、不自动安装** —— 没有 ad-hoc 重签链路时，
 *      自动替换 .app 会因为签名校验失败而启动不了，那比不更新更糟。
 *      真正启用自动安装需要：发布通道（GitHub Releases / 对象存储）
 *      + ad-hoc 重签脚本，两者就绪后把 `autoDownload` 打开即可。
 *
 * 🔴 三条硬约束：
 *  1. **绝不阻塞启动**：检查是后台发起的，失败静默（自用工具不该因为
 *     更新服务器不可达就弹错误框）。
 *  2. **失败一律降级为"没有更新"** —— 用户看到的是「已是最新」而不是一堆英文堆栈。
 *  3. **开发态不联网**：`app.isPackaged === false` 时直接返回不可用。
 */

import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';

export interface UpdateCheckResult {
  /** 当前版本 */
  currentVersion: string;
  /** 远端最新版本；拿不到为 null */
  latestVersion: string | null;
  hasUpdate: boolean;
  /** 给用户看的中文结论（直接 toast/对话框都合适） */
  message: string;
  /** 更新是否可用（开发态 / 无发布通道时为 false） */
  available: boolean;
}

/** 一次启动只弹一次框 —— 否则「启动检查 + 手动检查」会连弹两次 */
let promptedThisSession = false;

/**
 * 手动检查（菜单「检查更新…」/ 命令面板）。
 * 与启动检查的区别：手动检查**一定要给回执**（用户主动点了，不回话等于没反应）。
 */
export async function checkForUpdate(win: BrowserWindow | null): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();

  // 开发态（npm start）：electron-updater 在没有 publish 配置时会抛
  // "Cannot find module" 或配置缺失错误，必须挡在这一层
  if (!app.isPackaged) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      message: '开发模式不检查更新（仅打包产物参与）',
      available: false,
    };
  }

  try {
    // ⚠️ 必须动态 import：electron-updater 是 ESM/CJS 混合包，
    //    静态 import 在 CJS 主进程产物里会把它拖进启动路径（冷启动红线）。
    const { autoUpdater } = await import('electron-updater');

    // 只查不装：下载与安装由用户确认后再走 downloadUpdate()
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    const info = await autoUpdater.checkForUpdates();
    const latest = info?.updateInfo?.version ?? null;
    if (!latest) {
      return { currentVersion, latestVersion: null, hasUpdate: false, message: '已是最新版本', available: true };
    }
    const hasUpdate = isNewer(latest, currentVersion);
    if (!hasUpdate) {
      return { currentVersion, latestVersion: latest, hasUpdate: false, message: '已是最新版本', available: true };
    }

    // 有更新：手动触发时弹框，启动期静默检查时只回结果（不重复弹）
    if (!promptedThisSession && win && !win.isDestroyed()) {
      promptedThisSession = true;
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['以后再说', '前往下载'],
        defaultId: 1,
        cancelId: 0,
        title: '发现新版本',
        message: `DB Studio ${latest} 已发布`,
        detail: `当前版本 ${currentVersion}。\n\n自动安装尚未启用（需要发布通道与重签链路），点击「前往下载」将打开下载页面。`,
      });
      if (response === 1) {
        const url = releaseUrl(latest);
        if (url) {
          const { shell } = await import('electron');
          await shell.openExternal(url);
        }
      }
    }
    return {
      currentVersion,
      latestVersion: latest,
      hasUpdate: true,
      message: `发现新版本 ${latest}`,
      available: true,
    };
  } catch (e: unknown) {
    // 没有 publish 配置 / 断网 / 仓库没有 release：都不是用户能处理的问题
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      message: '检查更新失败（未配置发布通道或网络不可达）',
      available: false,
    };
  }
}

/** 启动后的静默检查：失败静默，有更新才弹一次 */
export function scheduleStartupCheck(getWindow: () => BrowserWindow | null, delayMs = 4000): void {
  if (!app.isPackaged) return;
  // 延后到窗口稳定之后再查 —— 与「不阻塞首屏」同口径（冷启动红线）
  setTimeout(() => {
    void checkForUpdate(getWindow()).catch(() => {
      /* 启动检查失败必须静默：用户没主动要，不该被打扰 */
    });
  }, delayMs).unref?.();
}

/** 语义化版本比较（只比三段数字，忽略 prerelease 后缀） */
function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return latest !== current;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 下载页：只在真的配了发布地址时才给链接，绝不猜 URL */
function releaseUrl(version: string): string | null {
  const base = process.env.DB_STUDIO_RELEASE_URL;
  if (!base) return null;
  // 配的是基址（如 https://example.com/dbstudio/releases）时按 tag 拼；
  // 已经带了 tag 的完整地址则原样用，避免拼出 .../v1.2.0/v1.2.0
  return base.includes('/tag/') || base.includes('/download/') ? base : `${base}/tag/v${version}`;
}
