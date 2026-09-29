/**
 * S2 冷启动测量驱动器
 *
 * 负责：
 *  1. 记录进程 exec 时刻（S2_EXEC_TS），传给 app 校准冷启动起点
 *  2. 每组跑 5 次，取第 2 次及以后（PRD §7.2：首次受 Gatekeeper 影响不计入）
 *  3. 输出 P50 与阶段分解
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, 'app');
const OUT_DIR = path.join(ROOT, 'raw');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ELECTRON = process.env.ELECTRON_BIN
  || path.join(ROOT, '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const RUNS = Number(process.env.RUNS || 5);
const MODE = process.env.COLD_MODE || 'C2';
const PACKAGED = process.env.PACKAGED_APP || '';

function p50(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runOnce(i) {
  return new Promise((resolve) => {
    const resultFile = path.join(OUT_DIR, `${MODE}_${i}.json`);
    const execTs = Date.now();

    const target = PACKAGED || ELECTRON;
    const args = PACKAGED ? [] : [APP_DIR];

    // ELECTRON_RUN_AS_NODE 必须从 env 里删除（设为空字符串仍会被判为"已设置"，
    // 导致 Electron 以纯 Node 模式运行而不启动窗口）
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.COLD_MODE = MODE;
    env.S2_RESULT = resultFile;
    env.S2_EXEC_TS = String(execTs);
    env.ELECTRON_NO_ATTACH_CONSOLE = '1';

    const child = spawn(target, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => {});

    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);

    child.on('close', () => {
      clearTimeout(timer);
      let data = null;
      if (fs.existsSync(resultFile)) {
        try { data = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* noop */ }
      }
      resolve(data);
    });
  });
}

console.log(`S2 冷启动测量 — mode=${MODE} runs=${RUNS}${PACKAGED ? ' (packaged)' : ''}`);
console.log(`Electron: ${PACKAGED || ELECTRON}\n`);

const all = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await runOnce(i);
  if (r) {
    const wall = r.wall_from_exec_ms;
    const boot = r.boot_ms;
    all.push({ i, wall, boot, marks: r.marks, breakdown: r.breakdown });
    console.log(`  run#${i}: wall=${wall ?? 'n/a'}ms  process=${boot.toFixed(0)}ms  eager=${r.marks.eager_require_ms?.toFixed(0) ?? '-'}ms`);
  } else {
    console.log(`  run#${i}: 未拿到结果`);
  }
  await new Promise((r) => setTimeout(r, 1200)); // 间隔，避免互相干扰
}

// PRD §7.2：取第二次及以后
const valid = all.slice(1).filter((x) => x.wall != null);
if (valid.length === 0) {
  console.log('\n未获取到有效数据');
  process.exit(1);
}

const walls = valid.map((x) => x.wall);
const boots = valid.map((x) => x.boot);

console.log(`\n=== ${MODE} 结果（第 2 次及以后，n=${valid.length}）===`);
console.log(`wall (exec→可交互): 每次=${walls.map(Math.round).join(', ')}ms`);
console.log(`  P50 = ${Math.round(p50(walls))}ms`);
console.log(`进程内计时 P50 = ${Math.round(p50(boots))}ms`);

// 阶段分解（取中位那次）
const med = valid[Math.floor(valid.length / 2)];
console.log('\n阶段分解（中位次）:');
for (const [k, v] of Object.entries(med.breakdown || {})) {
  console.log(`  ${k}: ${v == null ? 'n/a' : Math.round(v) + 'ms'}`);
}

fs.writeFileSync(
  path.join(OUT_DIR, `${MODE}-summary.json`),
  JSON.stringify({ mode: MODE, packaged: !!PACKAGED, runs: RUNS, all, p50_wall: p50(walls), p50_boot: p50(boots) }, null, 2)
);
console.log(`\n已写入 raw/${MODE}-summary.json`);
