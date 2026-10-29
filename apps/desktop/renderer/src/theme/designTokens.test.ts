/**
 * P2-17：样式 token 的守卫测试。
 *
 * 审计原话：「颜色 token 化彻底，但 `font-size` 散写 60+ 处；深色调色板在
 * `:root[data-theme]` 与媒体查询块**双份维护**，改一处漏一处即主题不一致」。
 *
 * 这类问题的共同点是**没有任何编译期信号**：CSS 里少一个 `--bg` 不会报错，
 * 只会让某个角落的背景变成继承色（浅色主题下看起来像"没设计过"）。
 * 所以把它变成门禁：
 *
 *  1. 两个深色块的 token **键集合与取值都必须一致**（双份维护的漂移防线）；
 *  2. `--fs-*` / `--sp-*` 不许是死 token（定义了没人用 = 写了没生效）；
 *  3. 字号棘轮：已收敛的六档不许再出现字面量，其余字面量总数只许降不许升。
 *
 * 用纯文本解析而不是引入 PostCSS：样式表是本仓库自己的文件，
 * 结构稳定（顶层 `:root` + 两个深色块），为它拉一个 CSS 解析器进 devDeps
 * 不划算；也正因为如此，下面每个断言都写明"解析失败要红"，不是静默跳过。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS_PATH = new URL('../styles.css', import.meta.url);
/**
 * 🔴 解析前先剥掉 CSS 注释。
 *
 * 不剥的话，注释里随手写的 `--sp-2: 6px` 会被当成**真声明**：它的取值会一路
 * 吃到下一个 `;`（把后面几行真声明整个吞掉），于是「token 缺失」这种假红出现，
 * 而 fake 出来的 use 又会让「死 token」断言假绿。两头的信号都被注释污染。
 */
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 取 `sel` 之后第一对花括号里的内容（按深度配平，忽略括号内的同名文本） */
function blockAfter(src: string, sel: string): string {
  const at = src.indexOf(sel);
  expect(at, `样式表里找不到选择器：${sel}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at);
  expect(open, `选择器 ${sel} 后面没有 {`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`选择器 ${sel} 的花括号没有闭合`);
}

/** 解析块内所有 `--name: value;` 声明 */
function tokensOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    // 同名 token 在同一个块里出现两次 = 后写的覆盖前面的，这里如实记录后值
    out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return out;
}

const lightBlock = blockAfter(css, ':root {');
const darkAttr = tokensOf(blockAfter(css, ":root[data-theme='dark']"));
const darkMedia = tokensOf(
  blockAfter(blockAfter(css, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme])'),
);

describe('深色模式双份维护（P2-17）', () => {
  it('两个深色块的 token 键集合完全相等', () => {
    const a = [...darkAttr.keys()].sort();
    const b = [...darkMedia.keys()].sort();
    expect(b).toEqual(a);
  });

  /**
   * 🔴 键集合相等还不够：真正的漂移长这样 —— 两处都有 `--border`，
   *    但一处 #323234、另一处忘了改，仍是 #e5e5ea（浅色值）。
   *    媒体查询只在「JS 没写 data-theme」时兜底，所以这种不一致平时看不见，
   *    只在冷启动首帧或主题脚本失败的机器上闪一下。
   */
  it('两个深色块的同名 token 取值逐一相等', () => {
    const diffs: string[] = [];
    for (const [k, v] of darkAttr) {
      const other = darkMedia.get(k);
      if (other !== v) diffs.push(`${k}: ${v} vs ${other ?? '(缺失)'}`);
    }
    expect(diffs).toEqual([]);
  });

  it('深色调色板确实存在（防解析失手后"空对空"通过）', () => {
    expect(darkAttr.size).toBeGreaterThan(10);
    expect(darkAttr.has('--bg')).toBe(true);
    expect(darkMedia.has('--bg')).toBe(true);
  });
});

describe('字号 / 间距 token（P2-17）', () => {
  const light = tokensOf(lightBlock);
  const FS_TOKENS = ['--fs-2xs', '--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg'];
  const SP_TOKENS = ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5'];

  it('字号 token 全部在 :root 定义，且取值就是历史字面量', () => {
    expect(FS_TOKENS.map((t) => light.get(t))).toEqual(['9px', '10px', '11px', '12px', '13px', '14px']);
  });

  it('间距 token 全部在 :root 定义（4/6/8/10/12 五档）', () => {
    expect(SP_TOKENS.map((t) => light.get(t))).toEqual(['4px', '6px', '8px', '10px', '12px']);
  });

  it('没有死 token：每个 --fs-* / --sp-* 至少被引用一次（定义处不算）', () => {
    const dead: string[] = [];
    for (const t of [...FS_TOKENS, ...SP_TOKENS]) {
      const uses = css.split(`var(${t})`).length - 1;
      if (uses === 0) dead.push(t);
    }
    expect(dead).toEqual([]);
  });

  /**
   * 棘轮：已收敛的六档**不许**再以字面量出现（新代码必须用 token）。
   *
   * 这条是「渐进收敛」的守门人：没有它，三个月后新写的 80 个 `font-size: 11px`
   * 会让这次收敛白做，而没有任何门禁会红。
   */
  it('🔴 已收敛的六档字号不再有字面量', () => {
    const literals = [...css.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
    const migrated = literals.filter((v) => ['9px', '10px', '11px', '12px', '13px', '14px'].includes(v));
    expect(migrated).toEqual([]);
  });

  /**
   * 其余一次性档位（8px / 10.5px / 11.5px）允许保留字面量，但**总数只许降**。
   * 基线：171 处收敛之后剩下的 12 处（改小了这个数字就顺手把它调小）。
   */
  it('剩余字面量不增长（棘轮基线 12 处）', () => {
    const count = [...css.matchAll(/font-size:\s*[0-9.]+px/g)].length;
    expect(count).toBeLessThanOrEqual(12);
  });
});
