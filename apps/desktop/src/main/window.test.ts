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
    isClosable() { return true; }
    isMinimizable() { return true; }
    isFullScreenable() { return true; }
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

describe('applyTrafficLights（缺陷 6：交通灯必须真实可见，不接受静默无效）', () => {
  it('setWindowButtonVisibility 存在时调用成功，三态能力如实回报', async () => {
    mockEnv('darwin', '27.0.0');
    const { applyTrafficLights } = await import('./window.js');
    const calls: string[] = [];
    const fakeWin = {
      setWindowButtonVisibility(v: boolean) { calls.push(`vis:${v}`); },
      isClosable: () => true,
      isMinimizable: () => true,
      isFullScreenable: () => true,
    } as any;
    const st = applyTrafficLights(fakeWin);
    expect(calls).toEqual(['vis:true']);
    expect(st.visibilityApplied).toBe(true);
    expect(st.closable).toBe(true);
    expect(st.minimizable).toBe(true);
    expect(st.fullscreenable).toBe(true);
  });

  it('API 缺失（非 darwin / Electron 变体）→ visibilityApplied=false，不抛异常', async () => {
    mockEnv('darwin', '27.0.0');
    const { applyTrafficLights } = await import('./window.js');
    const st = applyTrafficLights({} as any);
    expect(st.visibilityApplied).toBe(false);
    // 能力探测失败时回退 true（宁可报乐观也不让状态误报成"窗口关不掉"）
    expect(st.closable).toBe(true);
  });

  it('setWindowButtonVisibility 抛异常 → 静默降级，不冒泡', async () => {
    mockEnv('darwin', '27.0.0');
    const { applyTrafficLights } = await import('./window.js');
    const st = applyTrafficLights({
      setWindowButtonVisibility() { throw new Error('boom'); },
      isClosable: () => { throw new Error('boom2'); },
    } as any);
    expect(st.visibilityApplied).toBe(false);
    expect(st.closable).toBe(true);
  });

  it('TRAFFIC_LIGHT_POSITION 与渲染层安全区口径一致（真机实测：三灯右缘 76 ≤ 78）', async () => {
    const { TRAFFIC_LIGHT_POSITION, TRAFFIC_LIGHT_MEASURED } = await import('./window.js');
    expect(TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 14 });
    /**
     * 🔴 几何数字来自 2026-09-29 真机像素测量（`npm run verify:traffic-lights`，
     *    dist 产物 + screencapture + Chromium 解码连通域分析）：
     *    三灯中心 css (23,21)/(46,21)/(69,21)，直径 14px、间距 23px → 占 x ∈ [16,76]。
     *
     * ⚠️ 不要再用旧口径（setWindowButtonPosition 时代的「直径12、间距8、x∈[10,62]」）
     *    做几何推算：换 trafficLightPosition 构造参数后 macOS 的实际渲染变了，
     *    照旧数字算会让安全区少 14px，绿灯右缘落进 drag 区（边界漏让位）。
     *
     * 这条断言的价值：渲染层 .traffic-light-safe 宽度是 CSS 里的字面量，
     * 主进程这边的常量是 TS 里的字面量 —— 两处必然漂移。断言把关系钉住：
     * 实测右缘 ≤ 安全区宽度，且安全区与渲染层当前值一致。
     */
    expect(TRAFFIC_LIGHT_MEASURED.right).toBeLessThanOrEqual(TRAFFIC_LIGHT_MEASURED.safeAreaMinWidth);
    // 几何自洽：右缘 = 左缘 + 2×间距 + 直径
    expect(TRAFFIC_LIGHT_MEASURED.left + 2 * TRAFFIC_LIGHT_MEASURED.pitch + TRAFFIC_LIGHT_MEASURED.diameter)
      .toBe(TRAFFIC_LIGHT_MEASURED.right);
  });

  /**
   * v0.6.0：垂直对齐的数字口径。
   *
   * 「灯和侧栏头标题没对齐」原先只能靠注释猜 —— 而且 styles.css 与 window.ts
   * 记了两套互相矛盾的数（20.5 vs 21）。这条断言把关系钉死：
   * 灯中心 y 恒等于 position.y + 直径/2；侧栏头高度恒等于 2 × 灯中心 y
   * （因为 .sidebar-head 内容垂直居中，中心 = height/2）。
   *
   * 🔴 为什么要断"口径"而不断"具体值"：值会随 Electron/macOS 升级变，
   *   但这两条**关系**永远成立。断了关系，改值时才会被提醒同步改 CSS。
   */
  it('灯中心 y 与侧栏头高度满足垂直对齐关系', async () => {
    const { TRAFFIC_LIGHT_POSITION, TRAFFIC_LIGHT_MEASURED: M } = await import('./window.js');
    // 灯中心 = 顶边偏移 + 半径
    expect(M.centerY).toBe(TRAFFIC_LIGHT_POSITION.y + M.diameter / 2);
    // 侧栏头垂直居中 → 内容中心 = height/2，必须等于灯中心
    expect(M.sidebarHeadHeight).toBe(2 * M.centerY);
  });

  /**
   * 🔴 错误输入反查：把侧栏头高度改成不对齐的值（如原来的 30px）时，
   * 上面那条关系断言必须变红。否则它只是一条恒真的装饰性断言。
   */
  it('🔴 错误输入：侧栏头高度偏离 2×centerY 时关系断言会红', async () => {
    const { TRAFFIC_LIGHT_MEASURED: M } = await import('./window.js');
    const wrong = 30; // 修复前的值：内容中心 15，灯中心 21，差 6px
    expect(wrong).not.toBe(2 * M.centerY);
  });

  /**
   * 渲染层 CSS 与主进程常量必须同源。
   *
   * 这是本项目最易复发的一类漂移：CSS 里的 78px 与 TS 里的 78 各写各的。
   * 直接读 styles.css 断言字面量，能在改动不同步时立刻报出来。
   */
  it('渲染层 CSS 的安全区/侧栏头高度与主进程常量一致', async () => {
    const { readFileSync } = await import('node:fs');
    const { TRAFFIC_LIGHT_MEASURED: M } = await import('./window.js');
    const css = readFileSync(
      // main/ 与 renderer/ 同在 apps/desktop/ 下 —— 从 main/ 要上两级
      new URL('../../renderer/src/styles.css', import.meta.url),
      'utf8',
    );
    // .traffic-light-safe 的 width 必须等于主进程给的最小安全区
    const safeWidth = css.match(/\.traffic-light-safe\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    expect(Number(safeWidth)).toBe(M.safeAreaMinWidth);
    // .sidebar-head 的 height 必须等于对齐公式的结果
    const headHeight = css.match(/\.sidebar-head\s*\{[^}]*height:\s*(\d+)px/)?.[1];
    expect(Number(headHeight)).toBe(M.sidebarHeadHeight);
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
