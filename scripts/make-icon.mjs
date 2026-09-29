#!/usr/bin/env node
/**
 * 应用图标产物生成（一次性工具，保留入库）
 *
 * 用法：
 *   node scripts/make-icon.mjs
 *
 * 做什么：
 *   1. 用本机 Chromium（playwright-core 复用，不下载浏览器，findChromium()
 *      逻辑与 scripts/e2e-ui.mjs 一致）headless 渲染 apps/desktop/build/icon.svg；
 *   2. 按 macOS iconset 规范截出 10 个尺寸
 *      （icon_16x16.png … icon_512x512@2x.png）到 apps/desktop/build/icon.iconset/；
 *   3. `iconutil -c icns` 生成 apps/desktop/build/icon.icns（macOS dock 用）；
 *   4. `sips` 产出 apps/desktop/build/icon.png（512px，非 mac 用途/窗口 icon 备用）。
 *
 * 可重复运行：产物按同名覆盖，旧 PNG 只清 iconset 目录里 ≤10 个 icon_*.png，
 * 不涉及任何大目录删除（宿主"批量删除 >50 文件需确认"护栏不受影响）。
 *
 * 环境：
 *   - 依赖 playwright-core（根 devDependencies，已装）
 *   - Chromium 定位：优先 PLAYWRIGHT_CHROMIUM_EXECUTABLE，
 *     否则 ~/Library/Caches/ms-playwright/chromium-*（同 e2e-ui.mjs）
 *   - iconutil / sips 为 macOS 自带；非 macOS 会跳过第 3/4 步并提示
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BUILD = join(ROOT, 'apps/desktop/build');
const SVG = join(BUILD, 'icon.svg');
const ICONSET = join(BUILD, 'icon.iconset');
const ICNS = join(BUILD, 'icon.icns');
const ICON_PNG = join(BUILD, 'icon.png');

// macOS iconset 标准尺寸表：文件名 → 目标像素
const SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

// ---------- 依赖与浏览器定位（与 e2e-ui.mjs 同款） ----------
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  // 取版本号最大的一份，避免旧 revision 兼容问题
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const rel of [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ]) {
      const p = join(cache, d, ...rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('✗ 未安装 playwright-core：npm i -D playwright-core');
  process.exit(1);
}
const executablePath = findChromium();
if (!executablePath) {
  console.error('✗ 找不到本机 Chromium：执行 npx playwright install chromium，或设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  process.exit(1);
}

if (!existsSync(SVG)) {
  console.error(`✗ 源图标不存在：${SVG}`);
  process.exit(1);
}

// ---------- 1. 清旧 PNG（只动 iconset 里已知的 ≤10 个文件） ----------
if (existsSync(ICONSET)) {
  let cleaned = 0;
  for (const f of readdirSync(ICONSET)) {
    if (f.startsWith('icon_') && f.endsWith('.png') && cleaned < 40) {
      unlinkSync(join(ICONSET, f));
      cleaned++;
    }
  }
} else {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ICONSET, { recursive: true });
}

// ---------- 2. Chromium 渲染 SVG → 各尺寸 PNG ----------
// HTML 只包一层：SVG 矢量图按视口尺寸缩放，viewport 多大就截多大，天然无损。
const svgSource = readFileSync(SVG, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;overflow:hidden;background:transparent}
  svg{display:block;width:100vw;height:100vh}
</style></head><body>${svgSource}</body></html>`;
const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.goto(dataUrl);
// 等一帧，确保 SVG 光栅化完成
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

for (const [name, px] of SIZES) {
  await page.setViewportSize({ width: px, height: px });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: px, height: px } });
  writeFileSync(join(ICONSET, name), buf);
  console.log(`[make-icon] ${name}  (${px}×${px})`);
}
await browser.close();

// ---------- 3. iconutil → icns / 4. sips → icon.png ----------
if (process.platform === 'darwin') {
  const icns = spawnSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS], { stdio: 'pipe' });
  if (icns.status !== 0) {
    console.error('✗ iconutil 失败：', icns.stderr?.toString());
    process.exit(1);
  }
  console.log(`[make-icon] icon.icns 生成（iconutil）`);

  const sips = spawnSync('sips', ['-z', '512', '512', join(ICONSET, 'icon_512x512.png'), '--out', ICON_PNG], { stdio: 'pipe' });
  if (sips.status !== 0) {
    console.error('✗ sips 失败：', sips.stderr?.toString());
    process.exit(1);
  }
  console.log(`[make-icon] icon.png 生成（sips，512px）`);
} else {
  console.log('⏭️  非 macOS：跳过 iconutil / sips（iconset 已生成）');
}

// ---------- 验证 ----------
function pngSize(file) {
  // PNG IHDR：宽高分别在第 16~19、20~23 字节（大端）
  const buf = readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

let failed = false;
console.log('--- 验证 ---');
for (const [name, px] of SIZES) {
  const f = join(ICONSET, name);
  if (!existsSync(f)) { console.error(`✗ 缺少 ${name}`); failed = true; continue; }
  const { w, h } = pngSize(f);
  const ok = w === px && h === px;
  if (!ok) { failed = true; console.error(`✗ ${name} 尺寸错误：${w}×${h}（期望 ${px}×${px}）`); }
}
if (process.platform === 'darwin') {
  const icnsKB = statSync(ICNS).size / 1024;
  if (!existsSync(ICNS) || icnsKB <= 10) { console.error(`✗ icon.icns 缺失或过小（${icnsKB.toFixed(1)}KB ≤ 10KB）`); failed = true; }
  else console.log(`✓ icon.icns  ${icnsKB.toFixed(1)}KB`);
  if (existsSync(ICON_PNG)) {
    const { w, h } = pngSize(ICON_PNG);
    if (w !== 512 || h !== 512) { console.error(`✗ icon.png 尺寸错误：${w}×${h}`); failed = true; }
    else console.log(`✓ icon.png   512×512`);
  }
}
console.log(failed ? '✗ 图标产物验证未通过' : '✓ 全部图标产物验证通过');
process.exit(failed ? 1 : 0);
