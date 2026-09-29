// 编排 E1/E2/E3（必要时 E4）各跑 3 次，取 P50，写 raw/*.json 并打印汇总。
// 用法: node run-all.mjs            -> 跑 E1/E2/E3
//       node run-all.mjs --e4       -> 额外跑 E4（仅当 E3>60s 才应传）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RUNS = 3;
const DO_E4 = process.argv.includes('--e4');
const rawDir = join(process.cwd(), 'raw');
mkdirSync(rawDir, { recursive: true });

const scenarios = [
  { name: 'E1', rows: 100000, mode: 'default' },
  { name: 'E2', rows: 1000000, mode: 'default' },
  { name: 'E3', rows: 1000000, mode: 'sharedOff' },
];
if (DO_E4) scenarios.push({ name: 'E4', rows: 1000000, mode: 'e4' });

function runOnce(rows, mode, outPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['bench.mjs', String(rows), mode, outPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('bench failed (code ' + code + '): ' + err));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { reject(new Error('parse: ' + e.message + ' raw=' + out)); }
    });
  });
}

function p50(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const results = {};
for (const sc of scenarios) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const outPath = `/tmp/s3_${sc.name}_run${i + 1}.xlsx`;
    const r = await runOnce(sc.rows, sc.mode, outPath);
    runs.push(r);
    try { unlinkSync(outPath); } catch (e) {} // 测完即删，不留产物
  }
  const p50time = p50(runs.map((r) => r.timeMs));
  const p50mem = p50(runs.map((r) => r.peakRss));
  const fileBytes = runs[0].fileBytes; // 数据确定，体积稳定，取一次
  results[sc.name] = {
    rows: sc.rows, mode: sc.mode,
    runs: runs.map((r) => ({ timeMs: r.timeMs, peakRss: r.peakRss, fileBytes: r.fileBytes })),
    p50timeMs: p50time, p50PeakRss: p50mem,
    fileBytes, fileMB: +(fileBytes / 1048576).toFixed(2),
  };
  writeFileSync(join(rawDir, sc.name.toLowerCase() + '.json'), JSON.stringify(results[sc.name], null, 2));
  console.log(`${sc.name}: rows=${sc.rows} mode=${sc.mode} | P50=${(p50time / 1000).toFixed(1)}s | peak=${(p50mem / 1048576).toFixed(1)}MB | file=${results[sc.name].fileMB}MB`);
}

const e2 = results.E2.p50timeMs / 1000;
const e3 = results.E3.p50timeMs / 1000;
console.log(`\nE2=${e2.toFixed(1)}s  E3=${e3.toFixed(1)}s`);
if (e3 <= 30) console.log('DECISION: E3<=30s -> 保留原预算「100万行<=30s」');
else if (e3 <= 60) console.log('DECISION: 30<E3<=60s -> 落定口径①「100万行<=60s」；E4 非必须，未做');
else console.log('DECISION: E3>60s -> 需 E4 手写 XML+zip 验证能否压到 60s 内');
if (existsSync('/tmp/s3_bench')) { try { unlinkSync('/tmp/s3_bench'); } catch (e) {} }
