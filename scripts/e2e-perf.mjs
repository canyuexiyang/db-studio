/**
 * 真库性能验证 —— 用 S5 fixture 的 1000 万行 big_table
 *
 * 对齐 PRD §7 性能预算里"当前阶段可验"的两条：
 *   - 表首屏 ≤1000ms
 *   - 结果首行渲染（这里测"列式编码 + 首屏可视区解码"）≤500ms
 *
 * 运行：node scripts/e2e-perf.mjs
 */

import { MySqlDriver } from '../packages/core-driver-mysql/src/index.js';
import { encodeColumnar, ColumnarReader, columnarByteLength } from '../packages/core-ipc-codec/src/index.js';

const CRED = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
  database: 'bench',
};

const ROWS = 3000; // PRD §6.3.1 快速打开默认加载量
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)] ?? 0;

const driver = new MySqlDriver(CRED, {});
await driver.connect();
console.log(`服务端 ${driver.serverVersion}\n`);

// ---- 元数据 ----
const dbs = await driver.introspect(['bench']);
const big = dbs[0].tables.find((t) => t.name === 'big_table');
console.log(`big_table：约 ${big.estimatedRows?.toLocaleString()} 行 / ${big.columns.length} 列`);

// ---- 表首屏（含服务端查询 + 列式编码 + 首屏解码）----
const samples = { query: [], encode: [], firstPaint: [], total: [] };

for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  const q = await driver.query(`SELECT * FROM big_table LIMIT ${ROWS}`);
  const t1 = performance.now();

  const types = q.fields.map((f) => big.columns.find((c) => c.name === f.name)?.dataType);
  const p = encodeColumnar(q.rows, q.fields.map((f) => f.name), types);
  const t2 = performance.now();

  // 首屏可视区：1200px 高 / 28px 行高 ≈ 43 行 + 上下缓冲
  const reader = new ColumnarReader(p);
  reader.decodeRowRange(0, 60);
  const t3 = performance.now();

  samples.query.push(t1 - t0);
  samples.encode.push(t2 - t1);
  samples.firstPaint.push(t3 - t2);
  samples.total.push(t3 - t0);
}

const report = (label, arr, budget) => {
  const p50 = pct(arr, 0.5);
  const ok = p50 <= budget;
  console.log(
    `${ok ? '✅' : '❌'} ${label.padEnd(22)} P50=${p50.toFixed(1)}ms  预算 ${budget}ms  (min=${Math.min(...arr).toFixed(1)} max=${Math.max(...arr).toFixed(1)})`,
  );
  return ok;
};

console.log('\n【表首屏分解】（5 次采样）');
const okQuery = report('服务端查询', samples.query, 1000);
const okEncode = report('列式编码', samples.encode, 500);
const okPaint = report('首屏可视区解码', samples.firstPaint, 500);
const okTotal = report('端到端总耗时', samples.total, 1000);

// ---- 排序（服务端执行，PRD §6.3.3）----
const sortT = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  await driver.query('SELECT id, name, amount FROM big_table ORDER BY id DESC LIMIT 3000');
  sortT.push(performance.now() - t);
}
const okSort = report('带索引排序', sortT, 1500);

// ---- 只解可视区的可扩展性 ----
console.log('\n【只解可视区：与结果集大小无关】');
for (const n of [3000, 30000, 100000]) {
  const q = await driver.query(`SELECT id, name, status, amount FROM big_table LIMIT ${n}`);
  const p = encodeColumnar(q.rows, ['id', 'name', 'status', 'amount']);
  const reader = new ColumnarReader(p);

  const t = performance.now();
  reader.decodeRowRange(0, 60); // 首屏永远只解 60 行
  const dt = performance.now() - t;

  console.log(
    `  结果集 ${String(n).padStart(6)} 行 → 编码体积 ${(columnarByteLength(p) / 1024).toFixed(1)} KB，首屏解码 ${dt.toFixed(3)}ms`,
  );
}

// ---- 全量物化对照（证明"不要全量解析"）----
const q100k = await driver.query('SELECT id, name, status, amount FROM big_table LIMIT 100000');
const p100k = encodeColumnar(q100k.rows, ['id', 'name', 'status', 'amount']);
const tMat = performance.now();
const reader100k = new ColumnarReader(p100k);
reader100k.decodeAll();
console.log(`\n  对照：10 万行【全量物化】耗时 ${(performance.now() - tMat).toFixed(1)}ms（首屏只解可视区是 0.0x ms 级）`);

await driver.close();

const allOk = okQuery && okEncode && okPaint && okTotal && okSort;
console.log(`\n${'='.repeat(60)}`);
console.log(allOk ? '性能预算全部达标 ✅' : '存在未达标项 ❌');
process.exit(allOk ? 0 : 1);
