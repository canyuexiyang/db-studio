import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const here = import.meta.dirname;

/**
 * Preload 构建 —— 输出必须是 **CommonJS**。
 *
 * ⚠️ sandbox:true 时 ESM preload 会加载失败（评审 §2.1），
 *    所以 format 固定 'cjs'，别改成 'es'。
 *
 * preload 只 require electron 与通道常量表，不引任何 core-* 包 ——
 * 它是安全边界，依赖越少越好。
 */
export default defineConfig({
  // 显式 root：从仓库根执行时，默认 root 是 cwd，
  // outDir 会被解析到【仓库根/dist】而不是 apps/desktop/dist。
  root: here,
  build: {
    outDir: 'dist/preload',
    // 🔴 同 vite.main.config.ts：关掉自动清空，避开宿主"批量删除需确认"护栏
    //    （阈值 50，按单个 turn 累计）。preload 入口名写死、每次覆盖，不清空安全。
    emptyOutDir: false,
    ssr: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      input: resolve(here, 'src/preload/preload.cjs'),
      output: {
        format: 'cjs',
        entryFileNames: 'preload.cjs',
      },
      external: ['electron'],
    },
  },
});
