#!/usr/bin/env node
/**
 * 拷贝 utilityProcess worker 文件到主进程产物目录。
 *
 * 为什么 worker 不走 vite 构建：
 *  - utilityProcess.fork() 在 Electron 44 下加载 CJS 最稳（ESM 路径坑多）
 *  - worker 引了 mysql2 / exceljs / @dbstudio/core-import —— 这些是 external
 *    依赖（主进程产物也是 external），worker 保持同形态才能共享 node_modules 解析
 *  - 拷贝时机：vite build main 之后跑；npm run build 已串联
 *
 * dist/main/main.cjs 旁挂 dist/main/workers/*.cjs —— transfer-manager.ts 的
 * workerPath() 按这个相对关系定位。
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'apps/desktop/src/main/workers');
const destDir = join(root, 'apps/desktop/dist/main/workers');

if (!existsSync(srcDir)) {
  console.error('[copy-workers] 源目录不存在：', srcDir);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let n = 0;
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith('.cjs')) continue;
  copyFileSync(join(srcDir, f), join(destDir, f));
  n++;
  console.log(`[copy-workers] ${f} → dist/main/workers/`);
}

if (n === 0) {
  console.error('[copy-workers] 没有 .cjs 文件可拷贝（src/main/workers/ 为空？）');
  process.exit(1);
}
console.log(`[copy-workers] 完成：${n} 个 worker`);
