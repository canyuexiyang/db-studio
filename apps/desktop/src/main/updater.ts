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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  /**
   * T45：四态必须**真实分开**（报告 §5 A02 / R14）。
   *  - `unconfigured`：打包产物里没有 app-update.yml / 没有 publish 配置，**从未接入**；
   *  - `failed`：已配置但这次检查失败（断网 / 404 / 证书）；
   *  - `update`：确实有新版本；
   *  - `latest`：确认已是最新。
   *
   * 🔴 绝不允许把 unconfigured/failed 说成 `latest` —— 「已是最新」是
   *    一个可以被用户当真的结论，而它在这里根本无从得知。
   */
  state: 'unconfigured' | 'failed' | 'update' | 'latest';
  /** 可手动下载的页面地址（未配置时为 GitHub Releases 基址）；null = 连基址都没有 */
  downloadUrl: string | null;
}

/** 一次启动只弹一次框 —— 否则「启动检查 + 手动检查」会连弹两次 */
let promptedThisSession = false;

export interface CheckForUpdateOptions {
  /**
   * 用户主动触发（菜单 / 命令面板）。
   *
   * T45 的「手动下载入口」就挂在这一点上：只有用户主动问了，才该给他
   * 「打开下载页」的按钮。启动期静默检查不能弹（没配置发布通道的工具
   * 每次开机弹一个框是很糟的体验），所以两者必须分开。
   */
  interactive?: boolean;
}

/**
 * 手动检查（菜单「检查更新…」/ 命令面板）。
 * 与启动检查的区别：手动检查**一定要给回执**（用户主动点了，不回话等于没反应），
 * 并且**要给出可执行的下一步**（打开下载页），而不是只报告一个状态。
 */
export async function checkForUpdate(
  win: BrowserWindow | null,
  opts: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
  const interactive = opts.interactive === true;
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
      state: 'unconfigured',
      downloadUrl: releaseBaseUrl(),
    };
  }

  // T45：先判「有没有接入发布通道」，再谈「有没有新版本」。
  // electron-updater 在没有 app-update.yml 时抛的是模块/配置缺失错误，
  // 与「断网」混在同一个 catch 里 → 用户会被告知「检查失败」或「已是最新」，
  // 两种说法都不是事实。
  if (!hasUpdateConfig()) {
    const downloadUrl = releaseBaseUrl();
    if (interactive) await offerManualDownload(win, downloadUrl, '未配置发布通道');
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      message: '未配置发布通道（缺少 app-update.yml），无法自动检查更新；可在 GitHub Releases 手动查看',
      available: false,
      state: 'unconfigured',
      downloadUrl,
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
      return {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        message: '已是最新版本',
        available: true,
        state: 'latest',
        downloadUrl: releaseBaseUrl(),
      };
    }
    const hasUpdate = isNewer(latest, currentVersion);
    if (!hasUpdate) {
      return {
        currentVersion,
        latestVersion: latest,
        hasUpdate: false,
        message: '已是最新版本',
        available: true,
        state: 'latest',
        downloadUrl: releaseBaseUrl(),
      };
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
      state: 'update',
      downloadUrl: releaseUrl(latest) ?? releaseBaseUrl(),
    };
  } catch (e: unknown) {
    // T45：已配置发布通道时失败，必须说「失败」并给出原始原因（截断到一行），
    // 不能笼统地说「未配置」——那是两个不同的处置（重试 vs 去补配置）。
    const raw = e instanceof Error ? e.message : String(e);
    const downloadUrl = releaseBaseUrl();
    if (interactive) await offerManualDownload(win, downloadUrl, '检查更新失败');
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      message: `检查更新失败：${raw.split('\n')[0].slice(0, 160)}`,
      available: false,
      state: 'failed',
      downloadUrl,
    };
  }
}

/**
 * T45「手动下载入口」。
 *
 * 只有用户主动发起检查时才调用 —— 未接入发布通道时，唯一诚实的补救
 * 就是把发布页给他，而不是让他对着「已是最新」干瞪眼。
 */
async function offerManualDownload(
  win: BrowserWindow | null,
  url: string | null,
  reason: string,
): Promise<void> {
  if (!url) return;
  const options = {
    type: 'info' as const,
    buttons: ['知道了', '打开下载页'],
    defaultId: 1,
    cancelId: 0,
    title: '无法自动检查更新',
    message: reason,
    detail: `自动安装尚未启用（需要发布通道与重签链路）。\n可前往发布页手动下载新版本。\n\n${url}`,
  };
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  if (response === 1) {
    const { shell } = await import('electron');
    await shell.openExternal(url);
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

/**
 * T45：发布页基址。
 *
 * 优先环境变量 `DB_STUDIO_RELEASE_URL`（自建通道）；没有就用项目真实的
 * GitHub Releases 地址 —— **不是猜的 URL**，是本仓库的公开地址。
 */
export function releaseBaseUrl(): string {
  const base = process.env.DB_STUDIO_RELEASE_URL;
  return base && base.trim() !== '' ? base.trim() : 'https://github.com/canyuexiyang/db-studio/releases';
}

/**
 * T45：打包产物里是否真的接了发布通道。
 *
 * 判据是 `app-update.yml`（electron-builder 的 `publish:` 产物）——
 * 没有它 electron-updater 无从知道去哪查，这就是「未配置」的可观测事实。
 */
export function hasUpdateConfig(resourcesPath = process.resourcesPath): boolean {
  try {
    return existsSync(join(resourcesPath, 'app-update.yml'));
  } catch {
    return false;
  }
}

/** 下载页：只在真的配了发布地址时才给链接，绝不猜 URL */
function releaseUrl(version: string): string | null {
  const base = process.env.DB_STUDIO_RELEASE_URL;
  if (!base && hasUpdateConfig()) return `${releaseBaseUrl()}/tag/v${version}`;
  if (!base) return null;
  // 配的是基址（如 https://example.com/dbstudio/releases）时按 tag 拼；
  // 已经带了 tag 的完整地址则原样用，避免拼出 .../v1.2.0/v1.2.0
  return base.includes('/tag/') || base.includes('/download/') ? base : `${base}/tag/v${version}`;
}
