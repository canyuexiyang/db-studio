/**
 * useEscapeClose 单测（AGENTS.md §八：模态三条退路之 Esc）。
 *
 * 本仓库 vitest 跑在 node，没有 jsdom / react-test-renderer，
 * renderToStaticMarkup 又不执行 useEffect —— 所以这里把 react 的 useEffect
 * 换成一个记录器：直接调用 hook 取得 effect，手动执行 = 挂载，
 * 调用它返回的 cleanup = 卸载；window 用最小事件桩替代。
 * 无需 DOM 即可精确验证「注册 → Escape 触发 → 卸载清理」全生命周期。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEscapeClose } from './useEscapeClose.js';

type Effect = () => (() => void) | void;

// hook 内只用到 useEffect，故 mock 只需提供这一个导出；用 hoisted 数组记录收到的回调。
const hookSpies = vi.hoisted(() => ({
  effects: [] as Effect[],
}));
vi.mock('react', () => ({
  useEffect: (effect: Effect) => {
    hookSpies.effects.push(effect);
  },
}));

type KeyListener = (e: KeyboardEvent) => void;

function makeWindowStub() {
  const listeners = new Set<KeyListener>();
  const addEventListener = vi.fn((_type: string, fn: KeyListener) => {
    listeners.add(fn);
  });
  const removeEventListener = vi.fn((_type: string, fn: KeyListener) => {
    listeners.delete(fn);
  });
  const press = (key: string): KeyboardEvent => {
    let prevented = false;
    const e = {
      key,
      get defaultPrevented() { return prevented; },
      preventDefault() { prevented = true; },
    } as unknown as KeyboardEvent;
    for (const fn of [...listeners]) fn(e);
    return e;
  };
  return { listeners, addEventListener, removeEventListener, press };
}

/** 取最后一次 useEffect 注册的 effect 并执行，模拟「挂载」，返回其 cleanup。 */
function mountEffect(): () => void {
  const effect = hookSpies.effects.at(-1);
  if (!effect) throw new Error('useEscapeClose 没有注册 useEffect');
  const cleanup = effect();
  return typeof cleanup === 'function' ? cleanup : () => {};
}

let win: ReturnType<typeof makeWindowStub>;

beforeEach(() => {
  hookSpies.effects.length = 0;
  win = makeWindowStub();
  vi.stubGlobal('window', {
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useEscapeClose', () => {
  it('挂载后按 Escape 触发 onClose（与遮罩/取消同一处理函数）', () => {
    const onClose = vi.fn();
    useEscapeClose(onClose);
    const cleanup = mountEffect();

    win.press('Escape');

    expect(win.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('非 Escape 按键不触发 onClose、也不被 preventDefault 吞掉', () => {
    const onClose = vi.fn();
    useEscapeClose(onClose);
    const cleanup = mountEffect();

    const e = win.press('Enter');
    win.press('a');
    win.press('ArrowDown');
    win.press('Esc'); // 旧式键名不得误判

    expect(onClose).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    cleanup();
  });

  it('卸载后监听被移除：再按 Escape 不再触发 onClose', () => {
    const onClose = vi.fn();
    useEscapeClose(onClose);
    const cleanup = mountEffect();

    cleanup();
    win.press('Escape');

    expect(win.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(win.listeners.size).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('守卫期 enabled=false 不注册监听、Esc 不关闭', () => {
    const onClose = vi.fn();
    useEscapeClose(onClose, false);
    const cleanup = mountEffect();

    win.press('Escape');

    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });
});
