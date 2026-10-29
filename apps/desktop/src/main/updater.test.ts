/**
 * T45：检查更新四态单测。
 *
 * 为什么值得单测：这个功能的失败形态全是「说了假话」——
 *  · 没接发布通道却回「已是最新」（旧实现 catch 里就这么干）；
 *  · 断网和配置缺失混为一谈，用户不知道该重试还是该补配置。
 * 四态必须能被区分，且每一条的中文结论要能对上处置动作。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = {
  packaged: true,
  version: '0.6.1',
  updaterImpl: null as null | (() => Promise<unknown>),
  /** 对话框返回值：0=知道了（默认），1=打开下载页 */
  dialogResponse: 0,
};

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockState.packaged;
    },
    getVersion: () => mockState.version,
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: mockState.dialogResponse })),
  },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: () => {
        if (!mockState.updaterImpl) throw new Error('updater mock 未设置');
        return mockState.updaterImpl();
      },
    };
  },
}));

import { checkForUpdate, hasUpdateConfig, releaseBaseUrl } from './updater.js';

let resourcesDir = '';
const originalResourcesPath = process.resourcesPath;

function useResourcesPath(p: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    value: p,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  resourcesDir = mkdtempSync(join(tmpdir(), 'dbstudio-updater-'));
  useResourcesPath(resourcesDir);
  mockState.packaged = true;
  mockState.version = '0.6.1';
  mockState.updaterImpl = null;
  delete process.env.DB_STUDIO_RELEASE_URL;
});

afterEach(() => {
  rmSync(resourcesDir, { recursive: true, force: true });
  useResourcesPath(originalResourcesPath ?? '');
  delete process.env.DB_STUDIO_RELEASE_URL;
});

describe('hasUpdateConfig', () => {
  it('目录里没有 app-update.yml 时判为未配置', () => {
    expect(hasUpdateConfig(resourcesDir)).toBe(false);
  });

  it('有 app-update.yml 时判为已配置', () => {
    writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\n');
    expect(hasUpdateConfig(resourcesDir)).toBe(true);
  });

  it('路径不存在不抛异常，判为未配置', () => {
    expect(hasUpdateConfig(join(resourcesDir, 'nope', 'deeper'))).toBe(false);
  });
});

describe('releaseBaseUrl', () => {
  it('默认指向本仓库的 GitHub Releases', () => {
    expect(releaseBaseUrl()).toBe('https://github.com/canyuexiyang/db-studio/releases');
  });

  it('环境变量写了自建通道就用它', () => {
    process.env.DB_STUDIO_RELEASE_URL = ' https://example.com/db/releases ';
    expect(releaseBaseUrl()).toBe('https://example.com/db/releases');
  });

  it('环境变量是空白串时回落默认值', () => {
    process.env.DB_STUDIO_RELEASE_URL = '   ';
    expect(releaseBaseUrl()).toBe('https://github.com/canyuexiyang/db-studio/releases');
  });
});

describe('checkForUpdate 四态', () => {
  it('开发态：unconfigured，且不谎称已是最新', async () => {
    mockState.packaged = false;
    const r = await checkForUpdate(null);
    expect(r.state).toBe('unconfigured');
    expect(r.available).toBe(false);
    expect(r.message).not.toContain('已是最新');
  });

  it('打包但缺 app-update.yml：unconfigured，且给出手动查看入口', async () => {
    const r = await checkForUpdate(null);
    expect(r.state).toBe('unconfigured');
    expect(r.message).toContain('未配置发布通道');
    expect(r.message).not.toContain('已是最新');
    expect(r.downloadUrl).toBe('https://github.com/canyuexiyang/db-studio/releases');
  });

  it('已配置且远端更新：update', async () => {
    writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\n');
    mockState.updaterImpl = async () => ({ updateInfo: { version: '0.7.0' } });
    const r = await checkForUpdate(null);
    expect(r.state).toBe('update');
    expect(r.hasUpdate).toBe(true);
    expect(r.latestVersion).toBe('0.7.0');
    expect(r.downloadUrl).toContain('/tag/v0.7.0');
  });

  it('已配置且版本相同：latest', async () => {
    writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\n');
    mockState.updaterImpl = async () => ({ updateInfo: { version: '0.6.1' } });
    const r = await checkForUpdate(null);
    expect(r.state).toBe('latest');
    expect(r.hasUpdate).toBe(false);
    expect(r.message).toBe('已是最新版本');
  });

  it('已配置但检查抛错：failed，带原始原因首行，不与 unconfigured 混同', async () => {
    writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\n');
    mockState.updaterImpl = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED\n    at somewhere');
    };
    const r = await checkForUpdate(null);
    expect(r.state).toBe('failed');
    expect(r.hasUpdate).toBe(false);
    expect(r.message).toContain('检查更新失败');
    expect(r.message).toContain('ERR_INTERNET_DISCONNECTED');
    expect(r.message).not.toContain('\n');
    // 负向对照：failed 不能借「未配置」的说法，两者处置不同
    expect(r.message).not.toContain('未配置发布通道');
  });

  it('远端没给版本号：按 latest 处理但保留 available（能连上）', async () => {
    writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\n');
    mockState.updaterImpl = async () => ({ updateInfo: { version: null } });
    const r = await checkForUpdate(null);
    expect(r.state).toBe('latest');
    expect(r.available).toBe(true);
  });
});

/**
 * 发布通道的「仓库身份」必须三处一致（0.7.3 修过的 typo 不许复发）。
 *
 * 起因：`electron-builder.yml` 的 `publish.owner` 曾误写成 `canyuexiang`
 * （真实账号 `canyuexiyang`，少一个 y）。后果不是报错，而是**沉默的错误**：
 * 产物里的 `app-update.yml` 指向一个 404 的仓库，应用内「检查更新」永远 failed，
 * 而 release 页本身是好的（手工验证 URL 走的是另一个账号），所以没人会发现。
 *
 * 这里用 `package.json.repository` 当第二证据源：两处必须指同一个 owner/repo。
 */
describe('发布通道仓库身份一致性', () => {
  const root = process.cwd();
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    repository?: { url?: string };
  };
  const owner = /^\s*owner:\s*(\S+)\s*$/m.exec(yml)?.[1];
  const repo = /^\s*repo:\s*(\S+)\s*$/m.exec(yml)?.[1];

  it('package.json 声明了 repository（否则没有第二证据源可比）', () => {
    expect(pkg.repository?.url).toMatch(/github\.com\/[^/]+\/db-studio\.git$/);
  });

  it('publish.owner/repo 与 repository 完全一致', () => {
    expect(owner).toBeTruthy();
    expect(repo).toBe('db-studio');
    expect(pkg.repository?.url).toContain(`${owner}/${repo}`);
  });

  it('应用内回退的 releaseBaseUrl 指向同一仓库', () => {
    expect(releaseBaseUrl()).toBe(`https://github.com/${owner}/${repo}/releases`);
  });
});
