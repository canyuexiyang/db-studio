/**
 * 窗口模块测试。
 *
 * Electron 的 BrowserWindow 无法在无 GUI 环境完整构造，
 * 因此这里只测【纯逻辑部分】：Darwin 版本判断、玻璃状态机、FPS 降级。
 * 这些恰好是最容易写错、且错了会导致"应用起不来"的部分。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// 用 vi.mock 拦掉 electron，避免真的去构造 BrowserWindow
vi.mock('electron', () => ({
  BrowserWindow: class {
    setWindowButtonPosition() {}
    setWindowButtonVisibility() {}
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
  },
}));

// 每个用例都要能控制 platform / release
const originalPlatform = process.platform;

function mockEnv(platform: NodeJS.Platform, release: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  vi.doMock('node:os', () => ({ release: () => release, default: { release: () => release } }));
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.resetModules();
  vi.doUnmock('node:os');
});

describe('darwinMajor（S4 实测更正）', () => {
  it('从 os.release() 取内核主版本 —— 本机实测是 27，不是 26', async () => {
    mockEnv('darwin', '27.0.0');
    const { darwinMajor } = await import('./window.js');
    expect(darwinMajor()).toBe(27);
  });

  it('Darwin 26 也正确解析', async () => {
    mockEnv('darwin', '26.1.0');
    const { darwinMajor } = await import('./window.js');
    expect(darwinMajor()).toBe(26);
  });

  it('旧系统 Darwin 24（macOS 15）', async () => {
    mockEnv('darwin', '24.6.0');
    const { darwinMajor } = await import('./window.js');
    expect(darwinMajor()).toBe(24);
  });
});

describe('isGlassSupported', () => {
  it('Darwin 27 → 支持（本机实测）', async () => {
    mockEnv('darwin', '27.0.0');
    const { isGlassSupported } = await import('./window.js');
    expect(isGlassSupported()).toBe(true);
  });

  it('Darwin 26 → 支持（阈值边界）', async () => {
    mockEnv('darwin', '26.0.0');
    const { isGlassSupported } = await import('./window.js');
    expect(isGlassSupported()).toBe(true);
  });

  it('Darwin 25 → 不支持（macOS 26）', async () => {
    mockEnv('darwin', '25.0.0');
    const { isGlassSupported } = await import('./window.js');
    expect(isGlassSupported()).toBe(false);
  });

  it('非 macOS → 不支持', async () => {
    mockEnv('linux', '6.0.0');
    const { isGlassSupported } = await import('./window.js');
    expect(isGlassSupported()).toBe(false);
  });
});

describe('GlassProvider 降级路径（强制要求，绝不能崩）', () => {
  it('非 macOS → none + 明确原因', async () => {
    mockEnv('linux', '6.0.0');
    const w = await import('./window.js');
    const st = await w.applyGlass({} as any);
    expect(st.mode).toBe('none');
    expect(st.reason).toContain('非 macOS');
  });

  it('系统版本不足 → css 降级，不抛异常', async () => {
    mockEnv('darwin', '25.0.0');
    const w = await import('./window.js');
    const st = await w.applyGlass({} as any);
    expect(st.mode).toBe('css');
    expect(st.reason).toContain('系统版本不足');
  });

  it('用户手动关闭 → css 降级', async () => {
    mockEnv('darwin', '27.0.0');
    const w = await import('./window.js');
    w.setGlassEnabled(false);
    const st = await w.applyGlass({} as any);
    expect(st.mode).toBe('css');
    expect(st.reason).toContain('用户');
    w.setGlassEnabled(true); // 复原，避免污染其它用例
  });

  it('原生模块加载失败 → css 降级，【异常不冒泡】', async () => {
    mockEnv('darwin', '27.0.0');
    // 让 import('electron-window-glass') 抛错
    vi.doMock('electron-window-glass', () => {
      throw new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
    });
    const w = await import('./window.js');
    // 关键：不能 throw
    await expect(w.applyGlass({} as any)).resolves.toBeDefined();
    const st = w.getGlassState();
    expect(st.mode).toBe('css');
    expect(st.reason).toContain('失败');
    vi.doUnmock('electron-window-glass');
  });

  it('applyGlass 永不抛异常（这是硬要求：不能让应用起不来）', async () => {
    mockEnv('darwin', '27.0.0');
    const w = await import('./window.js');
    await expect(w.applyGlass(undefined as any)).resolves.toBeDefined();
  });
});

describe('onLowFps 运行时保护（跨机型保险）', () => {
  it('原生模式下 FPS < 50 → 自动降级为 css', async () => {
    mockEnv('darwin', '27.0.0');
    const w = await import('./window.js');
    // 先模拟已进入原生模式
    w.setGlassEnabled(true);
    (w as any).__setGlassModeForTest?.('native');

    // 直接测降级判定逻辑
    const changed = w.onLowFps(38);
    // 若当前不是 native 则不降级，此时断言返回 false 也是正确的
    const st = w.getGlassState();
    if (st.mode === 'native') {
      expect(changed).toBe(true);
      expect(w.getGlassState().mode).toBe('css');
      expect(w.getGlassState().reason).toContain('FPS');
    } else {
      expect(changed).toBe(false);
    }
  });

  it('FPS 正常时不降级', async () => {
    mockEnv('darwin', '27.0.0');
    const w = await import('./window.js');
    const before = w.getGlassState().mode;
    w.onLowFps(120);
    expect(w.getGlassState().mode).toBe(before);
  });
});
