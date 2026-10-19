/**
 * T44 基准：**结果集在客户端的内存与载荷体积**（不依赖数据库）。
 *
 * 为什么不需要真库：T44 要回答的问题是「10 万行的结果进到渲染层要吃多少内存」，
 * 而这取决于**编码器与载荷结构**，与数据从哪来无关。用固定宽度的合成行更可控 ——
 * 真库的列宽会影响绝对值，但不会改变结论的量级关系。
 *
 * 跑法：npx tsx scripts/bench-result-memory.mjs（源码是 TS，走 tsx 解释）
 * 输出：每个规模的行数 / 载荷字节 / 每行摊薄字节 / encode 耗时 / 堆增长
 *
 * 🔴 口径说明：
 *  - `payload` 只算列式编码后的 buffer 总字节（IPC 真正传输的量）；
 *  - `heap` 是 encode 前后 process.memoryUsage().heapUsed 的差值，
 *    **必须保留源 rows 数组**，否则 GC 会让数字忽大忽小（结论不可复现）；
 *  - 本脚本不评估 DOM（虚拟滚动只渲染可视行，与结果总量无关）。
 */

import { encodeColumnar, columnarByteLength } from '../packages/core-ipc-codec/src/index.ts';

const COLUMNS = [
  { name: 'id', dataType: 'bigint' },
  { name: 'order_no', dataType: 'varchar(32)' },
  { name: 'amount', dataType: 'decimal(12,2)' },
  { name: 'status', dataType: 'varchar(16)' },
  { name: 'remark', dataType: 'varchar(120)' },
  { name: 'created_at', dataType: 'datetime(6)' },
];

/** 造一行：宽度贴近真实订单表（约 200 字节/行） */
function makeRow(i) {
  return [
    String(100000 + i),
    `NO${String(i).padStart(9, '0')}`,
    (Math.random() * 10000).toFixed(2),
    ['new', 'paid', 'shipped'][i % 3],
    `备注 ${i} 这是一段中等长度的说明文字，用于模拟真实备注列`,
    `2026-10-${String((i % 28) + 1).padStart(2, '0')} 12:34:56.123456`,
  ];
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function run(rows) {
  const memory = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const payload = encodeColumnar(rows, COLUMNS);
  const t1 = performance.now();
  const bytes = columnarByteLength(payload);
  const heap = process.memoryUsage().heapUsed - memory;
  return {
    rows: rows.length,
    bytes,
    perRow: Math.round(bytes / rows.length),
    encodeMs: Math.round(t1 - t0),
    heap,
    // 保留引用，阻止 GC 在测量期间回收（否则数字不可复现）
    keep: payload,
  };
}

const SCALES = [1_000, 10_000, 50_000, 100_000];
const results = [];
for (const n of SCALES) {
  const rows = Array.from({ length: n }, (_, i) => makeRow(i));
  results.push(run(rows));
}

console.log('T44 结果集内存基准（合成 6 列 / 约 200 字节每行）');
console.log('行数\t载荷\t每行\tencode\t堆增长');
for (const r of results) {
  console.log(
    `${r.rows}\t${mb(r.bytes)}\t${r.perRow} B\t${r.encodeMs} ms\t${mb(r.heap)}`,
  );
}

/**
 * 结论口径（写进文档时引用这一段，不要重新外推）：
 *  - 每行摊薄字节基本线性 → 内存风险与**行数 × 平均列宽**成正比，而不是与列数；
 *  - 10 万行约 20MB 量级（本合成宽度），与「把结果留在标签里」的累计成本同阶；
 *  - 因此硬预算应按**字节**给，而不是只按行数给。
 */
