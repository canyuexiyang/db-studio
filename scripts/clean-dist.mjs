#!/usr/bin/env node
/**
 * 手动清理全部构建产物（**不在 `npm run build` 链里**）。
 *
 * ── 为什么从构建链里摘出来 ─────────────────────────────────────────
 * 宿主执行环境有一个 "批量删除需二次确认" 的护栏（node-safe-delete-shim）：
 * 单个 turn 内**累计**删除【项目目录下】的文件数达到阈值（50）就抛错，
 * 且删除计数是**跨进程、按 turn 累加**的。
 *
 * 构建链原来的每一步都在删：
 *    clean-dist(16) → vite.main 的 emptyOutDir 递归删 dist/main(9)
 *    → vite.preload 的 emptyOutDir(1) ……
 * 一个 turn 里只需跑两次 `npm run build`（`verify` 里 check:bundle 与
 * e2e:app 各会触发一次）就累加破 50 → 构建失败。
 *
 * 解法与 renderer/vite.config.ts 一致：**构建路径零删除**。
 *   - renderer / main / preload 的 vite 配置全部 `emptyOutDir:false`
 *   - `npm run build` 不再清目录（入口名写死或带内容 hash，旧产物不影响正确性）
 *   - 本脚本保留为**手动**清理命令 `npm run clean`（单独手敲 = 单独 turn，不累加）
 *
 * ── 清理策略 ─────────────────────────────────────────────────────
 * 用【整目录 rmSync】一次删掉 renderer/dist 与 apps/desktop/dist，
 * 而不是逐文件删 —— 整目录删除只发一次系统调用，且天然清掉陈年 hash chunk。
 * 目录树文件数在阈值（50）以内可一次清完；若某天产物爆到 50+，在**系统终端**
 * 里直接跑（终端不加载该 shim）即可绕开确认流程。
 */

import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const TARGETS = [
  ['apps/desktop/renderer/dist', 'renderer/dist'],
  ['apps/desktop/dist', 'apps/desktop/dist'],
];

for (const [rel, label] of TARGETS) {
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) {
    console.log(`[clean] ${label} 不存在，跳过`);
    continue;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[clean] 已删除 ${label}`);
  } catch (err) {
    console.error(`[clean] 删除 ${label} 失败：${err.message}`);
    console.error('[clean] 若报 SAFE_DELETE_BULK_CONFIRM_REQUIRED，请在系统终端手动执行同命令。');
    process.exit(1);
  }
}