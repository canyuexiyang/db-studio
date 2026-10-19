import { describe, it, expect } from 'vitest';
import { isImeComposing } from './imeGuard.js';

/**
 * T13：IME 组合期判定的证伪能力。
 *
 * 这组断言的重点是**反例**：如果实现退化成 `return true`（一律当作组合期），
 * 或者退化成只看 `isComposing` 而漏掉 `keyCode === 229`，下面的用例会立刻红。
 */
describe('isImeComposing', () => {
  it('组合中（isComposing=true）判为真', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });

  it('组合期兼容信号（keyCode=229）判为真 —— 部分输入法只给这个', () => {
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: true, keyCode: 229 })).toBe(true);
  });

  it('🔴 反例：普通 Enter（keyCode 13 / isComposing=false）必须判为假', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });

  it('反例：其它键码不得被误判（27=Esc，32=空格，82=R）', () => {
    expect(isImeComposing({ keyCode: 27 })).toBe(false);
    expect(isImeComposing({ keyCode: 32 })).toBe(false);
    expect(isImeComposing({ keyCode: 82 })).toBe(false);
  });

  it('null / undefined 安全（清理阶段事件可能拿不到）', () => {
    expect(isImeComposing(null)).toBe(false);
    expect(isImeComposing(undefined)).toBe(false);
  });

  /**
   * 🔴 React 合成事件：真实字段只在 `nativeEvent` 上。
   *
   * React 的 `SyntheticKeyboardEvent` 不转发 `isComposing`（表层恒为 undefined），
   * 所以只读表层的实现挂在 JSX `onKeyDown` 上时**等于没有守卫**。这组用例是真机
   * e2e 抓到后才补的 —— 上面几条用普通对象构造，永远发现不了这个洞。
   */
  it('🔴 React 合成事件：组合期判定必须读 nativeEvent', () => {
    // React 合成事件表面：没有 isComposing（undefined），keyCode 也是 0
    const synthetic = { key: 'Enter', isComposing: undefined, keyCode: 0, nativeEvent: { isComposing: true, keyCode: 229 } };
    expect(isImeComposing(synthetic)).toBe(true);
    // 只有 nativeEvent.keyCode===229 的部分输入法
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it('🔴 反例：React 合成事件里普通 Enter（nativeEvent.isComposing=false）必须判为假', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeComposing({ nativeEvent: null })).toBe(false);
    expect(isImeComposing({ nativeEvent: {} })).toBe(false);
  });
});
