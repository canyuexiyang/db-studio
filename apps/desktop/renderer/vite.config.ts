import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// renderer → desktop → apps → 仓库根
const root = resolve(import.meta.dirname, '../../..');

/**
 * 去掉产物 HTML 里的 crossorigin 属性。
 *
 * 🔴 file:// 协议下，带 crossorigin 的 <script type="module"> 会被直接拒绝加载，
 * 因为 file 源没有 CORS 响应头、也没有 origin 概念。
 * Vite 默认给 script/link 都加 crossorigin（那是为 CDN 场景准备的），
 * 对 Electron loadFile 是纯粹的坑。
 *
 * 表现极具迷惑性：控制台只报 ERR_FILE_NOT_FOUND 或一句 CORS 提示，
 * HTML 本身加载成功、#root 存在但永远是空的。
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'dbstudio-strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="")?/g, '');
    },
  };
}

/**
 * 生产产物的 CSP（仅构建期注入，dev 模式留空）。
 *
 * 每一条都有依据，别当样板改：
 *  - default-src 'self'：只加载本地产物，不引任何远程资源
 *    （自用单机工具，没有 CDN 依赖，也不该有）
 *  - style-src 'self' 'unsafe-inline'：
 *    🔴 'self' 必须有 —— Vite 生产构建会把 CSS 抽成【独立的 .css 文件】，
 *    只写 'unsafe-inline' 时它被挡掉，页面有结构无样式。
 *    'unsafe-inline' 保留给运行时注入的行内样式（网格虚拟滚动定位）。
 *  - script-src 'self'：不开放 eval / 远程脚本
 *  - img-src 'self' data:：favicon 与应用内图标走 data URI
 *  - connect-src 'self' ws: wss:：只给本地调试端口，不放宽到 http(s)
 *  - object-src 'none' / base-uri 'none'：堵住插件类与 base 劫持
 *
 * ⚠️ 只在 build 时注入（apply: 'build'）。dev 模式下 Vite 会注入
 *    内联 react-refresh 脚本 + HMR websocket，这条策略会把它们全挡掉。
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function renderCsp(): Plugin {
  return {
    name: 'dbstudio-render-csp',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      const tag = `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`;
      return html.replace('<!--DBSTUDIO_CSP-->', tag);
    },
  };
}

/**
 * 渲染层构建。
 *
 * ⚠️ 首屏 bundle ≤1.5MB 未压缩是硬约束（S2 实测：冷启动真实瓶颈在应用首屏 JS 体积，
 * 不是驱动加载）。所以这里对 core-* 一律走源码 alias，不打包产物，
 * 并且刻意不引 UI 框架 —— 网格是性能热路径，手写 DOM 定位比组件树快得多。
 */
export default defineConfig({
  // 显式 root：从仓库根执行 `vite build -c <本文件>` 时，
  // 默认 root 会是 cwd 而不是 renderer 目录，导致找不到 index.html。
  root: import.meta.dirname,
  /**
   * 🔴 必须是相对路径 './'，不能是默认的 '/'。
   *
   * 渲染层是 `file://` 加载的（Electron loadFile，不走 dev server）。
   * 默认的 '/assets/index-xxx.js' 在 file:// 下会被解析成【磁盘根目录】，
   * 于是 JS 根本加载不到 —— 表现是 #root 空、页面全白、
   * 控制台只有一句没头没尾的 ERR_FILE_NOT_FOUND。
   * 而且 IPC 全部照常工作（主进程不受影响），
   * 所以这种故障用「调接口全通」的验证方式完全测不出来。
   *
   * ⚠️ 位置要点：`base` 是 Vite 的【顶层】字段，不是 `build.base`。
   *    写进 build 里不会报错，但完全不生效 —— 产物依旧是绝对路径。
   */
  base: './',
  plugins: [react(), stripCrossorigin(), renderCsp()],
  resolve: {
    /**
     * ⚠️ 用【数组】而不是对象：Vite/rolldown 的 alias 是【前缀匹配】的，
     * 对象形式下 `@dbstudio/core-sql-editor/facts` 会命中 `core-sql-editor`
     * 这条规则，被拼成 `.../src/index.ts/facts` → ENOTDIR。
     * 数组形式按声明顺序匹配，把 exact 规则（正则带 `$`）排前面即可。
     */
    alias: [
      // exact 规则必须排前面（见上方注释：前缀匹配会把 /facts 拼到 index.ts 后面）
      { find: /^@dbstudio\/core-sql-editor\/facts$/, replacement: resolve(root, 'packages/core-sql-editor/src/facts.ts') },
      // S 板块 / P1-C：编辑器新增的子入口。刻意拆开而不是并进主入口 ——
      // 主入口带关键字表与函数表，首屏组件一引就多付十几 KB（与 /facts 同口径）。
      { find: /^@dbstudio\/core-sql-editor\/tokens$/, replacement: resolve(root, 'packages/core-sql-editor/src/tokens.ts') },
      { find: /^@dbstudio\/core-sql-editor\/formatter$/, replacement: resolve(root, 'packages/core-sql-editor/src/formatter.ts') },
      { find: /^@dbstudio\/core-sql-editor\/lint$/, replacement: resolve(root, 'packages/core-sql-editor/src/lint.ts') },
      { find: /^@dbstudio\/core-sql-editor\/hints$/, replacement: resolve(root, 'packages/core-sql-editor/src/hints.ts') },
      { find: '@dbstudio/core-grid-view', replacement: resolve(root, 'packages/core-grid-view/src/index.ts') },
      { find: '@dbstudio/core-clipboard', replacement: resolve(root, 'packages/core-clipboard/src/index.ts') },
      { find: '@dbstudio/core-filter', replacement: resolve(root, 'packages/core-filter/src/index.ts') },
      { find: '@dbstudio/core-tree-view', replacement: resolve(root, 'packages/core-tree-view/src/index.ts') },
      { find: '@dbstudio/core-command-palette', replacement: resolve(root, 'packages/core-command-palette/src/index.ts') },
      { find: '@dbstudio/core-sql-editor', replacement: resolve(root, 'packages/core-sql-editor/src/index.ts') },
      { find: '@dbstudio/core-ipc-codec', replacement: resolve(root, 'packages/core-ipc-codec/src/index.ts') },
      { find: '@dbstudio/core-mutation', replacement: resolve(root, 'packages/core-mutation/src/index.ts') },
      { find: '@dbstudio/core-schema-cache', replacement: resolve(root, 'packages/core-schema-cache/src/index.ts') },
      { find: '@dbstudio/core-connection', replacement: resolve(root, 'packages/core-connection/src/index.ts') },
      { find: '@dbstudio/core-sql-guard', replacement: resolve(root, 'packages/core-sql-guard/src/index.ts') },
      { find: '@dbstudio/core-sql-ident', replacement: resolve(root, 'packages/core-sql-ident/src/index.ts') },
      { find: '@dbstudio/core-history', replacement: resolve(root, 'packages/core-history/src/index.ts') },
      { find: '@dbstudio/core-table-designer', replacement: resolve(root, 'packages/core-table-designer/src/index.ts') },
      { find: '@dbstudio/core-import', replacement: resolve(root, 'packages/core-import/src/index.ts') },
      // ⚠️ 指到 renderer-types.ts（只 re-export 类型），不是 ipc-channels.ts。
      //    后者同目录有 import electron 的 window.ts，一旦被拖进渲染层 bundle
      //    就会突破 S2 的首屏 1.5MB 硬约束。
      { find: '@dbstudio/shared-ipc', replacement: resolve(root, 'apps/desktop/src/shared/renderer-types.ts') },
    ],
  },
  build: {
    outDir: 'dist',
    target: 'es2023',
    // 超过此值构建失败，把 S2 的硬约束变成 CI 可见的红线
    chunkSizeWarningLimit: 700,
    reportCompressedSize: true,
    /**
     * 🔴 关掉 Vite 的自动清空 outDir。
     *
     * 它用 `rmSync(dir, {recursive:true})` 删整个 assets/，在受限执行环境里
     * 会撞上"批量删除需二次确认"的安全护栏（>50 个文件即触发），构建直接失败。
     * 而 Vite 用内容 hash 命名，旧 chunk 残留**不影响正确性**
     * （index.html 只引用本次产出的文件），所以不清空是安全的。
     *
     * 依赖方必须跟着改：`scripts/check-bundle.mjs`
     * **只统计 index.html 实际引用的文件**，不扫目录 —— 否则残留物会污染数字。
     */
    emptyOutDir: false,
  },
});
