/**
 * V5 偏好设置纯逻辑单测。
 *
 * 重点覆盖两条易错路径：
 *  1. localStorage 里残留畸形值 → 逐字段回退默认（不是整份丢弃）；
 *  2. patch 合并语义 —— 只改一项时其它项保持不动。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFS_STORAGE_KEY,
  loadPreferences,
  savePreferences,
  patchPreferences,
  SHORTCUT_HINTS,
} from './preferences';

/** 内存版 localStorage 替身（jsdom 无默认实现时也可用） */
function installMemoryStorage() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mock, configurable: true });
  return store;
}

beforeEach(() => {
  installMemoryStorage();
});

describe('loadPreferences', () => {
  it('无持久化数据时返回默认值', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('返回的默认值应是【新对象】（避免调用方误改污染常量）', () => {
    const a = loadPreferences();
    a.rowHeight = 'loose';
    expect(DEFAULT_PREFERENCES.rowHeight).toBe('standard');
  });

  it('畸形 JSON → 回退默认，不抛异常', () => {
    localStorage.setItem(PREFS_STORAGE_KEY, '{ not json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('单字段非法 → 只回退该字段，保留其它有效字段', () => {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ rowHeight: 'huge', confirmCloseDirty: false, telemetryEnabled: true }),
    );
    const p = loadPreferences();
    expect(p.rowHeight).toBe('standard'); // 非法 → 回退
    expect(p.confirmCloseDirty).toBe(false); // 有效 → 保留
    expect(p.telemetryEnabled).toBe(true);
  });

  it('类型错误的字段同样逐项回退', () => {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ rowHeight: 'compact', confirmCloseDirty: 'yes', telemetryEnabled: 1 }),
    );
    const p = loadPreferences();
    expect(p.rowHeight).toBe('compact');
    expect(p.confirmCloseDirty).toBe(true); // 非 boolean → 回退默认
    expect(p.telemetryEnabled).toBe(false);
  });
});

describe('savePreferences / patchPreferences', () => {
  it('保存后可原样读回', () => {
    const next = { rowHeight: 'loose' as const, confirmCloseDirty: false, telemetryEnabled: true };
    savePreferences(next);
    expect(loadPreferences()).toEqual(next);
  });

  it('patch 只改一项，其它项保持不动', () => {
    const base = { rowHeight: 'compact' as const, confirmCloseDirty: true, telemetryEnabled: false };
    const merged = patchPreferences(base, { telemetryEnabled: true });
    expect(merged).toEqual({ rowHeight: 'compact', confirmCloseDirty: true, telemetryEnabled: true });
    expect(loadPreferences().telemetryEnabled).toBe(true); // 已落盘
  });

  it('localStorage 写入失败静默（不抛）', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
      configurable: true,
    });
    expect(() => savePreferences(DEFAULT_PREFERENCES)).not.toThrow();
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('SHORTCUT_HINTS', () => {
  it('快捷键一览含 V5 新增的 ⌘, 且无重复键位', () => {
    const keys = SHORTCUT_HINTS.map((h) => h.keys);
    expect(keys).toContain('⌘,');
    expect(new Set(keys).size).toBe(keys.length);
  });
});