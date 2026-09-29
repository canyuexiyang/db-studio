// DB Studio Spike S1 — FPS probe renderer (virtual scroll grid)
// 设计约束（PRD §7.1 红线）：滚动热路径禁止对象分配。
// 做法：固定的行 DOM 池（可视区 + 双向缓冲），每帧只改 transform 与 textContent，不新建节点/数组/对象。
'use strict';

const { ipcRenderer } = require('electron');

const ROWS = Number(new URLSearchParams(location.search).get('rows') || 10000);
const COLS = 20;
const ROW_H = 28; // 固定行高
const BUFFER = 8; // 上下各多渲染的行数

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const hud = document.getElementById('hud');

spacer.style.height = (ROWS * ROW_H) + 'px';

// ---- 预生成假数据（一次性，不在滚动路径） ----
// 每行 20 列字符串，预先算好，避免滚动时拼字符串产生分配。
const data = new Array(ROWS);
for (let r = 0; r < ROWS; r++) {
  const row = new Array(COLS);
  for (let c = 0; c < COLS; c++) {
    row[c] = (r * 31 + c * 7) % 100000; // 稳定的伪数据，便于肉眼核对
  }
  data[r] = row;
}

// ---- 固定 DOM 行池（滚动路径复用，零分配） ----
const poolSize = Math.ceil(viewport.clientHeight / ROW_H) + BUFFER * 2;
const pool = new Array(poolSize);
const textPool = []; // 每个单元格的 textNode，预先建好
for (let i = 0; i < poolSize; i++) {
  const el = document.createElement('div');
  el.className = 'row';
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.right = '0';
  el.style.height = ROW_H + 'px';
  const cells = new Array(COLS);
  for (let c = 0; c < COLS; c++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const tn = document.createTextNode('');
    cell.appendChild(tn);
    el.appendChild(cell);
    cells[c] = tn;
  }
  viewport.appendChild(el);
  pool[i] = el;
  textPool[i] = cells;
}

// 当前已挂载的行首索引（用于判断是否需要重排）
let firstRendered = -1;

function render(startRow) {
  if (startRow === firstRendered) return;
  firstRendered = startRow;
  for (let i = 0; i < poolSize; i++) {
    const dataRow = startRow + i;
    const el = pool[i];
    if (dataRow >= 0 && dataRow < ROWS) {
      el.style.display = '';
      el.style.transform = 'translateY(' + (dataRow * ROW_H) + 'px)';
      const src = data[dataRow];
      const tns = textPool[i];
      for (let c = 0; c < COLS; c++) {
        tns[c].nodeValue = src[c];
      }
    } else {
      el.style.display = 'none';
    }
  }
}

// 初始渲染
render(0);

// ---- FPS 采样 + 程序化滚动 ----
// 通过递增 scrollTop 驱动（覆盖整个 ROWS 范围）。每帧记录 rAF timestamp。
const api = {
  ready() { ipcRenderer.send('probe:ready'); },
  report(p) { ipcRenderer.send('probe:report', p); },
};

let running = false;

function runBenchmark() {
  if (running) return;
  running = true;

  const ROUNDS = 5;
  const MIN_FRAMES = 600; // 每轮至少 600 帧
  const maxScroll = Math.max(0, ROWS * ROW_H - viewport.clientHeight);
  const step = maxScroll > 0 ? Math.max(1, Math.ceil(maxScroll / 700)) : 0; // 约 700 帧覆盖全程
  console.log('[bench] START running, ROUNDS=' + ROUNDS + ' MIN_FRAMES=' + MIN_FRAMES + ' maxScroll=' + maxScroll + ' step=' + step);

  const rounds = []; // 每轮: { intervals:Float64Array-ish, frames }
  let roundIdx = 0;
  let intervals = []; // 当前轮帧间隔（毫秒）

  function startRound() {
    intervals = [];
    viewport.scrollTop = 0;
    firstRendered = -1;
    render(0);
  }

  function finishRound() {
    rounds.push(intervals.slice());
  }

  function frame(ts) {
    try {
      if (roundIdx >= ROUNDS) {
        running = false;
        report(rounds);
        return;
      }
      // 记录帧间隔
      if (frame._last !== undefined) {
        const dt = ts - frame._last;
        intervals.push(dt);
      }
      frame._last = ts;
      if (intervals.length % 120 === 1) {
        console.log('[bench] frame#' + intervals.length + ' top=' + Math.round(viewport.scrollTop) + ' round=' + (roundIdx + 1));
      }

      // 推进滚动（覆盖全程；到顶后该轮若帧数达标则结束）
      if (step > 0) {
        let next = viewport.scrollTop + step;
        if (next >= maxScroll) {
          next = maxScroll;
        }
        viewport.scrollTop = next;
        // 重排（基于 scrollTop，纯数值计算，无分配）
        const startRow = Math.floor(viewport.scrollTop / ROW_H) - BUFFER;
        render(startRow < 0 ? 0 : startRow);
      }

      if (intervals.length >= MIN_FRAMES && viewport.scrollTop >= maxScroll) {
        finishRound();
        roundIdx++;
        console.log('[bench] round ' + roundIdx + ' done frames=' + intervals.length);
        if (roundIdx < ROUNDS) {
          startRound();
        }
      }
      requestAnimationFrame(frame);
    } catch (err) {
      console.log('[bench] FRAME ERROR: ' + (err && err.stack || err));
      running = false;
      ipcRenderer.send('probe:error', String(err && err.stack || err));
    }
  }

  startRound();
  requestAnimationFrame(frame);
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function report(rounds) {
  const summary = rounds.map((iv) => {
    const sortedIv = iv.slice().sort((a, b) => a - b);
    const fpsArr = iv.map((d) => 1000 / d);
    const sortedFps = fpsArr.slice().sort((a, b) => a - b);
    const dropped = iv.filter((d) => d > 16.7).length;
    return {
      frames: iv.length,
      p50Fps: Math.round(pct(sortedFps, 50) * 10) / 10,
      p95Fps: Math.round(pct(sortedFps, 95) * 10) / 10,
      meanFps: Math.round((1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)) * 10) / 10,
      minFps: Math.round(Math.min.apply(null, fpsArr) * 10) / 10,
      maxFps: Math.round(Math.max.apply(null, fpsArr) * 10) / 10,
      droppedFrames: dropped,
      dropRate: Math.round((dropped / iv.length) * 1000) / 10,
      totalMs: Math.round(iv.reduce((a, b) => a + b, 0)),
    };
  });
  const payload = {
    rows: ROWS,
    cols: COLS,
    rounds: summary,
    overall: {
      p50Fps: Math.round(pct(summary.map((s) => s.p50Fps).sort((a, b) => a - b), 50) * 10) / 10,
      p95Fps: Math.round(pct(summary.map((s) => s.p95Fps).sort((a, b) => a - b), 50) * 10) / 10,
    },
  };
  hud.textContent = 'DONE rounds=' + rounds.length + ' P50=' + payload.overall.p50Fps;
  if (api && api.report) api.report(payload);
}

// 暴露给 preload/main 的启动钩子
window.__startProbe = runBenchmark;
console.log('renderer loaded; ROWS=' + ROWS + ' poolSize=' + poolSize + ' viewportH=' + viewport.clientHeight);
if (api && api.ready) api.ready();

// rAF 心跳诊断：确认 rAF 是否真的在触发（头号风险——窗口若不在真实屏幕上会被节流到 0）
let rafCount = 0;
function rafHeartbeat() { rafCount++; requestAnimationFrame(rafHeartbeat); }
requestAnimationFrame(rafHeartbeat);
// 每秒上报一次 rAF 速率与可见性，便于判断测量期间窗口是否保持可见
setInterval(() => {
  const rate = Math.round(rafCount / 1);
  ipcRenderer.send('probe:rafcheck', { rafCount, rate1s: rate, visibility: document.visibilityState, hidden: document.hidden });
  rafCount = 0;
}, 1000);
