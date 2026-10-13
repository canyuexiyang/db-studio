import { defineConfig, type Plugin } from 'vite';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = import.meta.dirname;
const root = resolve(here, '../..');

/**
 * 主进程构建（ESM，跑在 Node 里）
 *
 * 要点：
 *  - ssr:true → 按 Node 解析，不注入浏览器 polyfill
 *  - external 掉 electron 与 node 内置模块（它们不能被打进 bundle）
 *  - core-* 走源码 alias：改了包立刻生效，不必先出产物再联调
 *  - ⚠️ mysql2 也要 external：它是 native-ish 的大包，
 *    而且驱动本来就是懒加载的（S2：别把它塞进主进程启动路径）
 */
const CORE_ALIAS: Record<string, string> = {
  /**
   * 🔴 子入口必须排在同名主入口**之前**（键的插入顺序 = 前缀匹配顺序）。
   * 放后面的话 `@dbstudio/core-history` 先命中，会把
   * `@dbstudio/core-history/snippet-name` 拼成
   * `.../src/index.ts/snippet-name` → 构建期UNLOADABLE_DEPENDENCY。
   *
   * ⚠️ 这个坑 typecheck 和单测都发现不了（tsconfig paths 与 vitest alias
   * 各有自己的匹配规则），只有真正 build 才炸 —— 别指望门禁会拦。
   */
  '@dbstudio/core-history/snippet-name': resolve(root, 'packages/core-history/src/snippet-name.ts'),
  '@dbstudio/core-sql-guard': resolve(root, 'packages/core-sql-guard/src/index.ts'),
  '@dbstudio/core-sql-ident': resolve(root, 'packages/core-sql-ident/src/index.ts'),
  '@dbstudio/core-history': resolve(root, 'packages/core-history/src/index.ts'),
  '@dbstudio/core-schema-cache': resolve(root, 'packages/core-schema-cache/src/index.ts'),
  '@dbstudio/core-secret': resolve(root, 'packages/core-secret/src/index.ts'),
  '@dbstudio/core-connection': resolve(root, 'packages/core-connection/src/index.ts'),
  '@dbstudio/core-driver-mysql': resolve(root, 'packages/core-driver-mysql/src/index.ts'),
  '@dbstudio/core-ipc-codec': resolve(root, 'packages/core-ipc-codec/src/index.ts'),
  '@dbstudio/core-mutation': resolve(root, 'packages/core-mutation/src/index.ts'),
  '@dbstudio/core-export': resolve(root, 'packages/core-export/src/index.ts'),
  '@dbstudio/core-grid-view': resolve(root, 'packages/core-grid-view/src/index.ts'),
  '@dbstudio/core-tree-view': resolve(root, 'packages/core-tree-view/src/index.ts'),
};

/**
 * 往产物目录写一份 package.json 标记 CJS。
 *
 * 仓库根 package.json 有 "type": "module"，而主进程产物是 CJS（见下），
 * 缺了这个标记，Node 会按 ESM 解析 .cjs 之外的文件并报错。
 * Electron 主进程目录里放一个 type:commonjs 的 package.json 是标准做法。
 */
function markCjsOutDir(): Plugin {
  return {
    name: 'dbstudio-mark-cjs',
    // 用 emitFile 把标记文件作为【产物的一部分】发射，而不是事后写磁盘。
    // 事后写会有两个坑：
    //  ① closeBundle 时目录已被 emptyOutDir 清理 → 写进去的目录反而把产物挤掉
    //  ② writeBundle 时输出目录可能还没建 → ENOENT
    // 交给 rollup 统一写盘，顺序就没有歧义了。
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'package.json',
        source: JSON.stringify(
          { name: 'dbstudio-main', private: true, type: 'commonjs', main: 'main.cjs' },
          null,
          2,
        ),
      });
    },
  };
}

export default defineConfig({
  // ⚠️ 显式 root：从仓库根执行 `vite build -c <本文件>` 时，
  //    默认 root 是 cwd，outDir 会被解析到【仓库根/dist】而不是 apps/desktop/dist。
  root: here,
  resolve: { alias: CORE_ALIAS },
  plugins: [markCjsOutDir()],
  // ⚠️ 输出必须是 **CJS**。
  //    Electron 的 ESM 入口不提供命名导出 —— `import { app } from 'electron'`
  //    在 ESM 下会直接抛 "does not provide an export named 'app'"。
  //    主进程用 CJS 是 Electron 的标准形态，别为了追 ESM 自找麻烦。
  define: {
    // 主进程需要知道自己的目录（定位 preload 与 renderer 产物）。
    // CJS 下没有 import.meta.url，这里直接注入绝对路径。
    __MAIN_DIR__: JSON.stringify(resolve(here, 'dist/main')),
  },
  build: {
    outDir: 'dist/main',
    /**
     * 🔴 关掉自动清空 outDir —— 与 renderer/vite.config.ts 同一原因。
     *
     * Vite 清空 outDir 用 `rmSync(dir, {recursive:true})`，在受限执行环境里会撞
     * 宿主的"批量删除需确认"护栏（阈值 50 个文件，按【单个 turn 累计】计数）。
     * 而 verify 一个 turn 里会多次触发 build，逐次累加必然破线 → 构建直接失败。
     *
     * 不清空是安全的：入口文件名是【写死的】`main.cjs`（见下 entryFileNames），
     * 每次构建覆盖同名文件；唯一带 hash 的 `assets/runtime-*.cjs` 残留不影响
     * 正确性（新 main.cjs 只引用本次产出的 hash），代价只是目录里多几个 21KB
     * 的陈年 chunk。要彻底清走跑 `npm run clean`（手动，不在构建链里）。
     */
    emptyOutDir: false,
    ssr: true,
    minify: false,
    sourcemap: true,
    target: 'node22',
    rollupOptions: {
      input: resolve(here, 'src/main/main.ts'),
      output: {
        format: 'cjs',
        // ⚠️ ssr:true 会强制 .mjs 后缀（因为根 package.json 是 type:module），
        //    即便 format 是 cjs。必须显式写死文件名，否则产物叫 main.mjs
        //    却装着 CJS 代码，Node 按 ESM 解析直接报错。
        entryFileNames: '[name].cjs',
      },
      external: [
        'electron',
        'mysql2',
        'mysql2/promise',
        // ssh2 必须 external：它在 install 阶段会尝试编译可选原生依赖
        // （cpu-features / nan），打包进 bundle 会丢失这些路径，
        // 而且它会 require 内部 lib/*.js —— 打进去必然找不到。
        // 顺带它也满足"懒加载"：真 sshd 连接时才 require。
        'ssh2',
        /^node:/,
      ],
    },
  },
});
