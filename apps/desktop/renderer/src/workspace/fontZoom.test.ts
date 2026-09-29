/**
 * F2 字体缩放纯逻辑测试（档位推进 + localStorage 持久化降级）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  nextZoom,
  loadFontZoom,
  saveFontZoom,
  FONT_ZOOM_STEPS,
  FONT_ZOOM_MIN,
  FONT_ZOOM_MAX,
  FONT_ZOOM_STORAGE_KEY,
} from './fontZoom';

describe('nextZoom：档位推进', () => {
  it('reset 永远回到 1（任意输入）', () => {
    expect(nextZoom(1.3, 'reset')).toBe(1);
    expect(nextZoom(0.85, 'reset')).toBe(1);
    expect(nextZoom(NaN, 'reset')).toBe(1);
  });

  it('放大：沿档位逐级上升', () => {
    expect(nextZoom(1, 'in')).toBe(1.15);
    expect(nextZoom(1.15, 'in')).toBe(1.3);
  });

  it('缩小：沿档位逐级下降', () => {
    expect(nextZoom(1, 'out')).toBe(0.85);
    expect(nextZoom(1.15, 'out')).toBe(1);
  });

  it('到顶/到底停在当前档（clamp 语义，不绕圈不越界）', () => {
    expect(nextZoom(1.3, 'in')).toBe(1.3);
    expect(nextZoom(0.85, 'out')).toBe(0.85);
  });

  it('越界输入先收敛到 [0.8, 1.4] 再找档', () => {
    expect(nextZoom(1.4, 'in')).toBe(1.3); // 1.4 之上没有档 → 最大档
    expect(nextZoom(0.8, 'out')).toBe(0.85); // 0.8 之下没有档 → 最小档
    expect(nextZoom(2, 'out')).toBe(1.3);
    expect(nextZoom(0.5, 'in')).toBe(0.85);
  });

  it('往返无浮点误差：档位集合自洽', () => {
    let z = 1;
    for (let i = 0; i < FONT_ZOOM_STEPS.length; i++) z = nextZoom(z, 'in');
    expect(z).toBe(1.3);
    for (let i = 0; i < FONT_ZOOM_STEPS.length; i++) z = nextZoom(z, 'out');
    expect(z).toBe(0.85);
    expect(nextZoom(z, 'reset')).toBe(1);
    // 档位都在硬边界内
    for (const s of FONT_ZOOM_STEPS) {
      expect(s).toBeGreaterThanOrEqual(FONT_ZOOM_MIN);
      expect(s).toBeLessThanOrEqual(FONT_ZOOM_MAX);
    }
  });
});

// ---- localStorage 持久化 ----

/** 最小 localStorage 替身（Node 环境没有；返回底层 Map 便于直接塞损坏数据） */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal('localStorage', fake);
  return store;
}

let store: Map<string, string> | null = null;

beforeEach(() => {
  store = stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store = null;
});

describe('loadFontZoom / saveFontZoom', () => {
  it('写入后能读回', () => {
    saveFontZoom(1.15);
    expect(loadFontZoom()).toBe(1.15);
    expect(store!.get(FONT_ZOOM_STORAGE_KEY)).toBe('1.15');
  });

  it('没有记录返回 null', () => {
    expect(loadFontZoom()).toBeNull();
  });

  it('损坏数据返回 null（不抛异常）', () => {
    store!.set(FONT_ZOOM_STORAGE_KEY, 'not-a-number');
    expect(loadFontZoom()).toBeNull();
  });

  it('越界值返回 null（外部改坏的防御）', () => {
    store!.set(FONT_ZOOM_STORAGE_KEY, '99');
    expect(loadFontZoom()).toBeNull();
    store!.set(FONT_ZOOM_STORAGE_KEY, '0.1');
    expect(loadFontZoom()).toBeNull();
  });

  it('localStorage 抛异常时静默降级（隐私模式/配额满）', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(loadFontZoom()).toBeNull();
    expect(() => saveFontZoom(1.15)).not.toThrow();
  });
});
