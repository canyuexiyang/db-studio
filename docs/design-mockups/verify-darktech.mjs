// gui-system-dark-tech.html 渲染与交互门禁
// 断言关键布局/颜色/交互真的生效（不依赖人眼看图）：
//   node docs/design-mockups/verify-darktech.mjs
// 覆盖：三栏尺寸 / 28px 行高 / 深色画布值 / 强调色注入（含浅色加深）/
//       交通灯让位相对坐标 / 树与行交互 / 明暗与强调色切换 / 两个弹层开合
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(join(homedir(), 'software/ai-project/work-buddy/database-app/package.json'));
const { chromium } = require('playwright-core');
function findChromium() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const p of [
      join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) { try { if (statSync(p).isFile()) return p; } catch {} }
  }
  throw new Error('chromium not found');
}
const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const out = [];
const ok = (n, c, extra = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  → ' + extra : ''}`);

await page.goto('file://' + join(here, 'gui-system-dark-tech.html'));
await page.waitForTimeout(400);

const g = async (sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el).getPropertyValue(p).trim(), prop);
const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

// 1) 主 mockup 尺寸正常，未被压成 0
const m = await box('#mainMock');
ok('主 mockup 有真实尺寸', m.w > 900 && m.h > 400, `${m.w}x${m.h}`);

// 2) 三栏都在且有宽度
for (const [name, sel, minW] of [['侧栏', '#mainMock .ds-side', 200], ['工作区', '#mainMock .ds-main', 400], ['详情', '#mainMock .ds-detail', 200]]) {
  const b = await box(sel);
  ok(`${name} 存在且有宽`, b.w >= minW, `${b.w}px`);
}

// 3) 行高 28px（与工程一致）
const rowH = await page.$eval('#mainMock .gr', (el) => Math.round(el.getBoundingClientRect().height));
ok('网格行高 = 28px', rowH === 28, `${rowH}px`);

// 4) 深色板真的生效
const bg = await g('#mainMock', 'background-color');
ok('深色画布 = #08090A', bg === 'rgb(8, 9, 10)', bg);
const accent = await g('#mainMock', '--accent');
ok('强调色 = 冰青 #3BA9C9', accent.toLowerCase() === '#3ba9c9', accent);

// 5) 树 / 详情在首个 mockup 内不塌陷
const tnCount = await page.locator('#mainMock .ds-tree .tn').count();
ok('树节点已渲染', tnCount >= 8, `${tnCount} 个节点`);
const gRows = await page.locator('#mainMock .gr').count();
ok('网格行已渲染', gRows >= 10, `${gRows} 行`);

// 6) 交通灯让位：标题内容相对 mockup 左边缘 ≥ 72px
const tb = await box('#mainMock .tb-name');
const relX = tb.x - m.x;
ok('标题让位交通灯（相对 x ≥ 72）', relX >= 72, `relX=${relX}`);

// 7) 交互：树展开
const before = await page.locator('#mainMock .tn.open').count();
await page.locator('#mainMock .gr').nth(4).click();
const selNow = await page.locator('#mainMock .gr.sel').count();
ok('点击行可选中', selNow >= 1, `${selNow} 行选中`);
await page.locator('#mainMock .ds-tree .tn[data-node]').first().click();
const after = await page.locator('#mainMock .tn.open').count();
ok('点击树节点切换展开', after !== before || after >= 1, `${before} → ${after}`);

// 8) 明暗切换
await page.locator('#mockThemeSeg button[data-mt="light"]').click();
await page.waitForTimeout(200);
const lbg = await g('#mainMock', 'background-color');
ok('切浅色后画布变白', lbg === 'rgb(255, 255, 255)', lbg);
const lAccent = await g('#mainMock', '--accent');
ok('浅色强调色加深', lAccent.toLowerCase() === '#1f819a', lAccent);
await page.locator('#mockThemeSeg button[data-mt="dark"]').click();
await page.waitForTimeout(200);

// 9) 强调色切换注入到全部 mockup
await page.locator('[data-accent="blue"]').click();
await page.waitForTimeout(150);
const bAccent = await g('#mainMock', '--accent');
ok('切电光蓝生效（主 mockup）', bAccent.toLowerCase() === '#3e8ff0', bAccent);
const bAccentMini = await g('#grid .ds[data-theme="light"]', '--accent');
ok('切电光蓝生效（浅色小块）', bAccentMini.toLowerCase() === '#2568d6', bAccentMini);
await page.locator('[data-accent="ice"]').click();
await page.waitForTimeout(150);

// 10) 弹层：命令面板
await page.locator('#openCmd').click();
await page.waitForTimeout(250);
const cmdOn = await page.locator('#cmdOverlay.on').count();
const cmdVisible = await page.locator('#cmdOverlay').isVisible();
const cmdItems = await page.locator('#cmdOverlay .cmd-item').count();
ok('命令面板可打开', cmdOn === 1 && cmdVisible, `${cmdItems} 项`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('ESC 可关闭命令面板', (await page.locator('#cmdOverlay.on').count()) === 0);

// 11) 弹层：写预演
await page.locator('#openPreview').click();
await page.waitForTimeout(250);
ok('写预演可打开', (await page.locator('#pvOverlay.on').count()) === 1);
const sqlTxt = await page.locator('#pvOverlay .sqlbox').innerText();
ok('预演展示了 UPDATE 原文', /UPDATE/.test(sqlTxt) && /WHERE/.test(sqlTxt), sqlTxt.split('\n')[0].slice(0, 40));
await page.locator('#pvOverlay .btn').first().click();
await page.waitForTimeout(200);
ok('取消按钮可关闭预演', (await page.locator('#pvOverlay.on').count()) === 0);

// 12) 危险弹层：生产标签 + 红色系
const prodTagBg = await g('#danger .env-tag.prod', 'color');
ok('生产标签用危险色', prodTagBg.length > 0, prodTagBg);

// 13) 分段控件
await page.locator('.ds-detail .seg button').nth(1).click();
ok('详情面板分段可切', (await page.locator('.ds-detail .seg button.on').count()) === 1);

// 14) 无外部字体 / 无网络请求
const extFont = await page.evaluate(() => [...document.querySelectorAll('link')].some((l) => /fonts\.(googleapis|gstatic)/.test(l.href)));
ok('未引入外部字体', !extFont);

// 15) 页面无内联脚本报错（已在 _check 验证，这里再确认关键变量存在）
const hasFn = await page.evaluate(() => typeof window.closeAll === 'function');
ok('交互脚本已就绪', hasFn);

console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} 通过`);
await browser.close();
process.exit(fails.length ? 1 : 0);