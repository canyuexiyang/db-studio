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

/**
 * 把 CSS 里连续的 `--sql-*` 声明按「处」分组。
 *
 * SQL 语法高亮色板在 `:root` / `[data-theme='dark']` / `@media` 兜底块里各维护
 * 一份（styles.css 约 5250 行），但选择器写法和主色板不一样 —— 主色板用
 * `:root[data-theme='dark']`，这里用 `[data-theme='dark']`，没法复用上面的
 * darkAttr / darkMedia。换个不依赖选择器的口径：相邻两条 --sql-* 声明之间
 * **只有空白**才算同一处，中间夹了 `}` / `{` / 选择器就换一处。
 * 解析失手（分组数不对）下面会直接红，不会静默空对空通过。
 */
function sqlPaletteGroups(src: string): Map<string, string>[] {
  const groups: Map<string, string>[] = [];
  const re = /(--sql-[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const gap = src.slice(lastEnd < 0 ? m.index : lastEnd, m.index);
    if (lastEnd < 0 || !/^\s*$/.test(gap)) groups.push(new Map<string, string>());
    groups[groups.length - 1].set(m[1], m[2].trim().replace(/\s+/g, ' '));
    lastEnd = re.lastIndex;
  }
  return groups;
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

describe('SQL 语法高亮色板（S2）三处维护（P2-17 补盲）', () => {
  const palettes = sqlPaletteGroups(css);

  /**
   * 主色板有深色双份维护门禁，SQL 这套色板此前没人管：三份声明改一处漏一处
   * （或某处手滑写成空值）不会有任何编译期信号，只会让某个 token 在深浅主题里
   * 悄悄变成继承色。口径与主色板一致：键集合、数量、每处取值都要齐全；
   * 键数动态比对，不写死「9」。
   */
  it('🔴 三处 --sql-* 键集合与数量完全一致，且每处每条都有值', () => {
    expect(palettes.length).toBe(3); // :root / [data-theme='dark'] / @media 兜底
    const keySets = palettes.map((p) => [...p.keys()].sort());
    const sizes = palettes.map((p) => p.size);
    for (const s of sizes) expect(s).toBeGreaterThan(0); // 防解析失手后空对空通过
    for (const keys of keySets) expect(keys).toEqual(keySets[0]); // 键集合完全一致
    for (const s of sizes) expect(s).toBe(sizes[0]); // 数量一致（不写死 9）
    for (const p of palettes) for (const v of p.values()) expect(v.length).toBeGreaterThan(0);
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
   * 🔴 棘轮的盲区：`font:` 简写把字号藏在 `font: 11px/1.5 ...` 里，上面的正则
   *    只认 `font-size:`，「六档全清零」一度是假象 —— 审计实测有 35 处从简写
   *    绕过。已全部迁到 `var(--fs-*)`（字号数值没变），这条断言把绕道堵死：
   *    新代码不许再用 `font:` 简写写六档字面量。
   */
  it('🔴 font: 简写里也不许出现已收敛的六档字号字面量', () => {
    const decls = [...css.matchAll(/font:\s*([^;}]+)/g)].map((m) => m[1]);
    const bypass = decls.filter((d) => /\b(9|10|11|12|13|14)px\b/.test(d));
    expect(bypass).toEqual([]);
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

describe('幽灵 token：引用了从未定义的 CSS 变量（P1-8 补盲）', () => {
  /**
   * 🔴 这条门禁的来历：0.8.0 做 P1-8 时给告警块写了 `border-radius: var(--radius-sm)`，
   *    但本仓库的圆角 token 叫 `--r-sm`（没有 `--radius-sm`）。CSS 里**引用未定义的
   *    变量不会报错**，整条声明静默失效 —— 告警块就是没有圆角，肉眼很难发现。
   *    既有的死 token 门禁只查「定义了没人用」，查不出「用了没定义」这个反方向。
   *
   * 两类要分开，因为危害天差地别：
   *  - **无 fallback**（`var(--x)`）：变量缺失 → 整条声明失效 → 真的会坏样式。必须为 0。
   *  - **带 fallback**（`var(--x, 默认)`）：变量缺失也有兜底值 → 渲染不坏，只是「本想
   *    用 token 却拼错/没建」的隐患。设棘轮基线，不许增长。
   */

  /** 全表所有 `--xxx:` 定义处（剥注释后的 css） */
  const defined = new Set<string>();
  for (const m of css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) defined.add(m[1]);

  /**
   * 运行时由 React inline style 注入、不在 styles.css 里定义的 token（合法）。
   * 来源：App.tsx `style={{ '--sidebar-w': …, '--detail-w': … }}`（三栏可拖拽布局）。
   * 新增运行时注入的 token 必须同步登记到这里，否则下面的断言会如实报红提醒。
   */
  const RUNTIME_INJECTED = ['--sidebar-w', '--detail-w'];

  /** 收集所有 `var(--x)`（无 fallback）与 `var(--x, …)`（带 fallback）里未定义的 token */
  function ghosts(withFallback: boolean): Set<string> {
    const out = new Set<string>();
    // 无 fallback：var(--x) 紧跟右括号；带 fallback：var(--x, …)
    const re = withFallback ? /var\(\s*(--[A-Za-z0-9-]+)\s*,/g : /var\(\s*(--[A-Za-z0-9-]+)\s*\)/g;
    for (const m of css.matchAll(re)) {
      const t = m[1];
      if (!defined.has(t) && !RUNTIME_INJECTED.includes(t)) out.add(t);
    }
    return out;
  }

  it('🔴 没有「无 fallback 且未定义」的幽灵 token（这类会静默失效）', () => {
    // 证伪靶子：把任何 var(--r-sm) 改成 var(--radius-sm) 这种拼错名，本断言立即红
    expect([...ghosts(false)].sort()).toEqual([]);
  });

  it('「带 fallback 且未定义」的幽灵 token 不增长（棘轮基线 3：--font-mono/--overlay/--r-md）', () => {
    // 这三个是历史遗留（都带兜底值，渲染不坏），允许暂存但只许减不许增。
    // 想彻底清零就把它们改成已定义的 token（如 --r-md→--r-lg）后把基线调小。
    const g = ghosts(true);
    expect(g.size).toBeLessThanOrEqual(3);
  });
});
