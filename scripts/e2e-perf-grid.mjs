/**
 * 网格滚动性能探针 —— 验证「只解可视区」在真数据上真的恒定。
 *
 * 与 S1 的区别：S1 测的是 **DOM 渲染帧率**（需要 Electron + GUI），
 * 这个脚本测的是 **数据层耗时**（解码可视区），不需要 GUI，CI 也能跑。
 *
 * 判据：解码耗时必须与结果集大小**基本无关**。
 * 若随行数线性增长，说明有人偷偷调了 decodeAll / materialize。
 *
 * 运行：node scripts/e2e-perf-grid.mjs（需 fixture 在 13306）
 */

import { MySqlDriver } from '../packages/core-driver-mysql/src/index.js';
import { encodeColumnar, ColumnarReader, columnarByteLength } from '../packages/core-ipc-codec/src/index.js';
import { computeVisibleRange, rowHeightPx } from '../packages/core-grid-view/src/index.js';

const CRED = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
  database: 'bench',
};

const SIZES = [3_000, 30_000, 100_000];
const VIEWPORT = 800; // 视口高度，约 28 行可见
const ROW_H = rowHeightPx('standard');

function p50(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const driver = new MySqlDriver(CRED, { maxExecutionTimeMs: 60_000 });

try {
  await driver.connect();
  console.log(`已连接：${driver.serverVersion}\n`);

  console.log('结果集 | 编码耗时 | 载荷体积 | 首屏解码 | 滚动到底部解码');
  console.log('-'.repeat(72));

  const firstScreen = [];
  const bottomScreen = [];

  for (const n of SIZES) {
    const samples = { encode: [], first: [], bottom: [] };
    let byteLen = 0;

    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await driver.query('SELECT * FROM `big_table` LIMIT ?', [n]);
      const tQuery = performance.now() - t0;

      const t1 = performance.now();
      const payload = encodeColumnar(res.rows, res.fields.map((f) => f.name));
      samples.encode.push(performance.now() - t1 + 0);
      void tQuery;
      byteLen = columnarByteLength(payload);

      const reader = new ColumnarReader(payload);
      const range = computeVisibleRange({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW_H, rowCount: reader.rowCount });

      const t2 = performance.now();
      reader.decodeRowRange(range.start, range.end);
      samples.first.push(performance.now() - t2);

      // 滚到最底部：这是最容易暴露"偷偷全量解码"的位置
      const bottom = computeVisibleRange({
        scrollTop: reader.rowCount * ROW_H,
        viewportHeight: VIEWPORT,
        rowHeight: ROW_H,
        rowCount: reader.rowCount,
      });
      const t3 = performance.now();
      reader.decodeRowRange(bottom.start, bottom.end);
      samples.bottom.push(performance.now() - t3);
    }

    const e = p50(samples.encode);
    const f = p50(samples.first);
    const b = p50(samples.bottom);
    firstScreen.push(f);
    bottomScreen.push(b);

    console.log(
      `${String(n).padStart(7)} | ${e.toFixed(2).padStart(7)}ms | ${(byteLen / 1024).toFixed(0).padStart(6)} KB | ${f.toFixed(3).padStart(7)}ms | ${b.toFixed(3).padStart(7)}ms`,
    );
  }

  console.log('\n判定：');
  const ratio = bottomScreen[bottomScreen.length - 1] / Math.max(firstScreen[0], 1e-6);
  console.log(`  首屏解码 ${firstScreen[0].toFixed(3)}ms → 10万行底部解码 ${bottomScreen[bottomScreen.length - 1].toFixed(3)}ms（倍数 ${ratio.toFixed(1)}×）`);

  // 结果集涨 33 倍，解码耗时涨超过 5 倍就说明不是"只解可视区"
  const ok = ratio < 5 && bottomScreen[bottomScreen.length - 1] < 5;
  console.log(`  ${ok ? '✅ 解码耗时与结果集大小基本无关（只解可视区生效）' : '❌ 解码随行数显著增长，检查是否调了 decodeAll'}`);

  if (!ok) process.exit(1);
} finally {
  await driver.close().catch(() => undefined);
}
