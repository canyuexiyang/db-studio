/**
 * v0.6.0：连续 INSERT 合并 —— **类型出口**。
 *
 * ## 为什么是薄封装而不是实现
 *
 * 本包有一条既有的强约定（见 index.ts 顶部）：
 * **实现全在 ./runtime.cjs（CJS），TS 侧只提供带类型的 ESM 出口**。
 * 原因很硬：utilityProcess 里的 worker（import-worker.cjs / sql-script-worker.cjs）
 * 不经 vite 构建，`require('@dbstudio/core-import')` 走 package.json 的 main
 * 直达 runtime.cjs —— worker 拿不到 .ts。
 *
 * 若把实现写在 .ts 里，就变成两份代码：worker 用 CJS 版、单测用 TS 版。
 * 两者一旦漂移，就是"测试全绿、真机慢好几倍"或更糟的"测试全绿、真机丢数据"。
 * 所以这里**只做转发**，实现仍在 runtime.cjs。
 *
 * index.test.ts 里有「CJS 与 ESM 行为一致」的对照断言守着这条线。
 */

import type { InsertShape } from './insert-merge-types.js';

const runtime = require('./runtime.cjs') as {
  parseInsertShape(sql: string): InsertShape;
  canMergeWith(prev: InsertShape, next: InsertShape): boolean;
  mergeTwoInsert(prevSql: string, prevShape: InsertShape, nextShape: InsertShape): string;
  MERGED_INSERT_MAX_ROWS: number;
  MERGED_INSERT_MAX_BYTES: number;
};

export const parseInsertShape = runtime.parseInsertShape;
export const canMergeWith = runtime.canMergeWith;
export const mergeTwoInsert = runtime.mergeTwoInsert;
export const MERGED_INSERT_MAX_ROWS = runtime.MERGED_INSERT_MAX_ROWS;
export const MERGED_INSERT_MAX_BYTES = runtime.MERGED_INSERT_MAX_BYTES;