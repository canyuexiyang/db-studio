/**
 * 首屏体积门禁（E2 的落地断言）
 *
 * 为什么单独一个脚本而不是靠 `chunkSizeWarningLimit`：
 *   Vite 那个阈值只能警告「单个 chunk 太大」，管不了「CodeMirror 有没有泄漏进首屏」。
 *   而后者才是真正的风险 —— lazy chunk 就算 800KB 也不影响冷启动，
 *   但 CodeMirror 只要漏一个字节进首屏，S2 的 1.5MB 硬约束就开始倒计时。
 *
 * 判据不是体积数字，是**内容**：首屏产物里出现 CodeMirror 的特征串就失败。
 * 这样即使将来换了依赖、改了打包方式，这条断言依然成立。
 *
 * 用法：npm run check:bundle
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'apps/desktop/renderer/dist/assets');

/** S2 硬约束：首屏 ≤1.5MB 未压缩 */
const MAX_FIRST_SCREEN_BYTES = 1_500_000;

/**
 * 首屏产物里**不许出现**的特征串。
 * 每一条都对应一次真实的泄漏场景，不是凑数。
 */
const FORBIDDEN_IN_FIRST_SCREEN = [
  { pattern: 'cm-editor', why: 'CodeMirror 编辑器本体泄漏进首屏（E2：必须 0 字节）' },
  { pattern: 'cm-content', why: 'CodeMirror 视图层泄漏进首屏' },
  { pattern: 'GROUP_CONCAT', why: 'SQL 函数补全表泄漏进首屏（应随 lazy chunk 加载）' },
  { pattern: 'autocompletion', why: '补全扩展泄漏进首屏' },
];

/**
 * 产物不存在就自己构建。
 *
 * 不能要求调用方先跑 build —— `npm run verify` 里本脚本排在 `e2e:app` 之前，
 * 而 build 是 e2e:app 干的事。干净仓库下直接跑 verify 会永远卡在这里。
 */
if (!existsSync(DIST)) {
  console.log('⏳ 产物不存在，先构建渲染层…');
  const r = spawnSync('npm', ['run', 'build:renderer'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('❌ 渲染层构建失败');
    process.exit(1);
  }
}

/**
 * 🔴 只统计 **index.html 实际引用** 的产物，不扫整个 dist 目录。
 *
 * Vite 用内容 hash 命名，每次构建的旧 chunk 会残留在 dist 里。
 * 扫目录会把这些"上一代的 chunk"也算进体积 —— 数字虚高且不可复现。
 * 从 index.html 解析才是"用户真正会加载的东西"。
 */
const html = readFileSync(join(ROOT, 'apps/desktop/renderer/dist/index.html'), 'utf8');
/**
 * lazy chunk 不会出现在 `<script src>` 里 —— 它们只以字符串形式存在于
 * 入口 chunk 的 `import("./SqlEditorCore-xxx.js")` 中。
 * 所以这里退一步：**扫描所有产物文件名，看谁出现在 index.html 或入口 chunk 的文本里**。
 *
 * 🔴 入口 chunk 只取【index.html 直接引用的那个 index-*.js】。
 *    dist 用 emptyOutDir:false（撞宿主批量删除护栏的妥协，见 vite.config.ts），
 *    历代 index-*.js 会残留；扫所有 index 会把上一代的引用链也算进来
 *    —— firstScreen 体积虚高（实测 298KB 被算成 2672KB），数字不可复现。
 */
const htmlScripts = [...html.matchAll(/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]);
const entryChunks = htmlScripts.filter((f) => f.startsWith('index-') && f.endsWith('.js'));
const referenced = new Set(htmlScripts);
for (const f of entryChunks) {
  const txt = readFileSync(join(DIST, f), 'utf8');
  for (const m of txt.matchAll(/([A-Za-z0-9_.-]+\.js)/g)) referenced.add(m[1]);
}

const files = readdirSync(DIST).filter((f) => f.endsWith('.js') && referenced.has(f));
// 首屏 chunk = 入口 index-*.js；其余是 lazy chunk
const firstScreen = files.filter((f) => f.startsWith('index-'));
const lazy = files.filter((f) => !f.startsWith('index-'));

if (firstScreen.length === 0) {
  console.error('❌ index.html 里找不到首屏 chunk（index-*.js）');
  process.exit(1);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. 首屏体积
let total = 0;
for (const f of firstScreen) total += readFileSync(join(DIST, f)).length;
ok(
  '首屏 bundle ≤ 1.5MB（S2 硬约束）',
  total <= MAX_FIRST_SCREEN_BYTES,
  `${(total / 1024).toFixed(1)} KB / ${(MAX_FIRST_SCREEN_BYTES / 1024).toFixed(0)} KB`,
);

// 2. CodeMirror 零泄漏（E2 核心断言）
const firstScreenText = firstScreen.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n');
for (const { pattern, why } of FORBIDDEN_IN_FIRST_SCREEN) {
  ok(`首屏不含 "${pattern}"`, !firstScreenText.includes(pattern), why);
}

// 3. lazy chunk 确实存在且体积在预算内（E2：≤150KB gzip）
//    ⚠️ 预算按【chunk 的身份】分三组管理（2026-09-27 口径修正）：
//     - 编辑器组（含 cm-editor 特征）：CodeMirror 本体/方言/补全 —— E2 红线的
//       原意就是"编辑器 lazy chunk ≤150KB"。早期 lazy 集合恰好只有编辑器相关
//       chunk，"全体 lazy 求和"与"编辑器"等价是巧合；每加一个 lazy 功能弹窗
//       （导出/导入/设计器/脚本…）都会挤爆这条线，但它们与编辑器加载体验无关。
//     - sql-guard 组（JSON_TABLE 特征）：node-sql-parser，体积由上游库决定。
//     - 功能组（其余 lazy chunk）：手写的低频功能弹窗，各自独立按需加载，
//       合并给一个小预算，防止有人把大依赖顺手塞进某个弹窗。
const { gzipSync } = await import('node:zlib');

const EDITOR_MARKER = 'cm-editor';
const GUARD_MARKER = 'JSON_TABLE';
const MAX_EDITOR_GZIP = 150 * 1024;
/**
 * 0.7.2：60 → 64KB。
 * 增量来自本迭代给弹窗补的**真功能**（都是手写代码，没有塞依赖）：
 * P1-12 设计器结构化失败报告块、P1-10 导入编码/分隔符选项、
 * P2-18d 行高三档切换的弹窗侧文案。涨预算必须留理由 —— 这条线的本意是
 * 防"顺手 import 个大库"，不是冻结功能。
 */
const MAX_FEATURE_GZIP = 64 * 1024;
const MAX_GUARD_GZIP = 600 * 1024;

let editorGzipTotal = 0;
let featureGzipTotal = 0;
let guardGzipTotal = 0;
for (const f of lazy) {
  const raw = readFileSync(join(DIST, f));
  const gz = gzipSync(raw).length;
  if (raw.includes(GUARD_MARKER)) {
    guardGzipTotal += gz;
  } else if (raw.includes(EDITOR_MARKER)) {
    editorGzipTotal += gz;
  } else {
    featureGzipTotal += gz;
  }
}
ok(
  'lazy chunk 分成独立文件（动态 import 生效）',
  lazy.length > 0,
  `${lazy.length} 个：${lazy.join(', ')}`,
);
ok(
  '编辑器 lazy chunk ≤ 150KB gzip（E2 红线本意：CodeMirror/方言/补全）',
  editorGzipTotal <= MAX_EDITOR_GZIP,
  `${(editorGzipTotal / 1024).toFixed(1)} KB / ${(MAX_EDITOR_GZIP / 1024).toFixed(0)} KB gzip`,
);
ok(
  `功能弹窗 lazy chunk 合计 ≤ ${MAX_FEATURE_GZIP / 1024}KB gzip（导出/导入/脚本/设计器等，手写代码）`,
  featureGzipTotal <= MAX_FEATURE_GZIP,
  `${(featureGzipTotal / 1024).toFixed(1)} KB / ${(MAX_FEATURE_GZIP / 1024).toFixed(0)} KB gzip`,
);
ok(
  'sql-guard chunk ≤ 600KB gzip（危险分级的 node-sql-parser，非热路径）',
  guardGzipTotal <= MAX_GUARD_GZIP,
  `${(guardGzipTotal / 1024).toFixed(1)} KB gzip`,
);

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  ' + f.detail);
}
process.exit(failed.length ? 1 : 0);
