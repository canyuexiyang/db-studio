// 单次导出基准：跑一个场景一次，输出 JSON 到 stdout。
// 用法: node bench.mjs <rows> <mode:default|sharedOff> <outPath>
// 每次单独进程跑，保证峰值 RSS 采样干净（不被上次运行的 GC 残留污染）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runExport } = require('./export-core.cjs');

const rows = parseInt(process.argv[2], 10);
const mode = process.argv[3] || 'default';
const outPath = process.argv[4] || `/tmp/s3_bench_${rows}_${mode}.xlsx`;

const res = await runExport({ rows, mode, outPath });
process.stdout.write(JSON.stringify({ rows, mode, ...res }) + '\n');
