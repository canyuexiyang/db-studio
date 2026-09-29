// S5 核心 benchmark：列式 ArrayBuffer 编码 vs JSON 对照 + 端到端首屏链路 + 数据正确性抽查
// 运行: node bench-ipc.mjs   (依赖 mysql2，已在本地安装)
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// §4.4 固定连接参数（直接决定数据正确性）
const POOL_CFG = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: 'dbstudio_local_2026',
  database: 'bench',
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  dateStrings: true,
  timezone: 'local',
  jsonStrings: true,
  multipleStatements: false,
  rowsAsArray: true,
  connectionLimit: 4,
  waitForConnections: true,
};

// MySQL 协议 FIELD_TYPE 常量
const FT = { DECIMAL:0, TINY:1, SHORT:2, LONG:3, FLOAT:4, DOUBLE:5, NULL:6,
  TIMESTAMP:7, LONGLONG:8, INT24:9, DATE:10, TIME:11, DATETIME:12, YEAR:13,
  VARCHAR:15, BIT:16, JSON:245, NEWDECIMAL:246, BLOB:252, VAR_STRING:253, STRING:254, GEOMETRY:255 };

function classify(typeCode) {
  if (typeCode === FT.LONGLONG) return { kind: 'num', sub: 'bigint' };
  if (typeCode === FT.FLOAT)    return { kind: 'num', sub: 'f32' };
  if (typeCode === FT.DOUBLE)   return { kind: 'num', sub: 'f64' };
  if (typeCode === FT.TINY || typeCode === FT.SHORT || typeCode === FT.LONG || typeCode === FT.INT24)
    return { kind: 'num', sub: 'i32' };
  return { kind: 'str' };
}

// ---- 列式编码（§2.2 ColumnarPayload 形态）----
function encodeColumnar(rows, fields) {
  const rowCount = rows.length, colCount = fields.length;
  const cols = [], buffers = [];
  const columns = fields.map(f => ({ name: f.name, typeCode: f.columnType }));
  for (let c = 0; c < colCount; c++) {
    const cl = classify(fields[c].columnType);
    const nullMask = new Uint8Array(rowCount);
    if (cl.kind === 'num') {
      const Ctor = cl.sub === 'bigint' ? BigInt64Array
                 : cl.sub === 'f32'    ? Float32Array
                 : cl.sub === 'f64'    ? Float64Array
                 : Int32Array;
      const ta = new Ctor(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = rows[r][c];
        if (v === null || v === undefined) { nullMask[r] = 1; ta[r] = 0; }
        else { nullMask[r] = 0; ta[r] = (cl.sub === 'bigint') ? BigInt(v) : v; }
      }
      cols.push({ kind: 'num', sub: cl.sub, num: ta, nullMask });
      buffers.push(ta.buffer, nullMask.buffer);
    } else {
      const offsets = new Uint32Array(rowCount + 1);
      const enc = new TextEncoder();
      let cur = 0; const chunks = [];
      for (let r = 0; r < rowCount; r++) {
        const v = rows[r][c];
        if (v === null || v === undefined) { nullMask[r] = 1; offsets[r + 1] = cur; continue; }
        nullMask[r] = 0;
        const b = enc.encode(String(v));
        chunks.push(b); cur += b.length; offsets[r + 1] = cur;
      }
      const utf8 = new Uint8Array(cur); let p = 0;
      for (const b of chunks) { utf8.set(b, p); p += b.length; }
      cols.push({ kind: 'str', offsets, utf8, nullMask });
      buffers.push(offsets.buffer, utf8.buffer, nullMask.buffer);
    }
  }
  return { rowCount, columns, buffers, _cols: cols };
}

function decodeColumnar(payload, start, end) {
  const { _cols: cols } = payload;
  const dec = new TextDecoder();
  const out = [];
  for (let r = start; r < end; r++) {
    const row = new Array(cols.length);
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      if (col.nullMask[r]) { row[c] = null; continue; }
      if (col.kind === 'num') row[c] = col.num[r];
      else row[c] = dec.decode(col.utf8.subarray(col.offsets[r], col.offsets[r + 1]));
    }
    out.push(row);
  }
  return out;
}

function encodeJsonSize(rows) {
  const s = JSON.stringify(rows);
  return { json: s, size: Buffer.byteLength(s) };
}

const p50 = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- 单场景：对照测量 ----
async function runScenario(pool, sql, label, iter = 7) {
  const [warmRows, warmFields] = await pool.query(sql);
  if (!warmRows.length) throw new Error(`empty result for ${label} (seed not ready?)`);
  const fields = warmFields;
  const runs = [];
  for (let i = 0; i < iter; i++) {
    let t = performance.now();
    const [rows] = await pool.query(sql);
    const qMs = performance.now() - t;

    t = performance.now(); const col = encodeColumnar(rows, fields); const encMs = performance.now() - t;
    const sizeCol = col.buffers.reduce((a, b) => a + b.byteLength, 0);
    t = performance.now(); decodeColumnar(col, 0, rows.length); const decFullMs = performance.now() - t;
    const n40 = Math.min(40, rows.length);
    t = performance.now(); decodeColumnar(col, 0, n40); const dec40Ms = performance.now() - t;

    // 保守"无 transferList"克隆代价（真实 IPC 用 transferList 为零拷贝，仅作对比）
    t = performance.now(); structuredClone(col.buffers); const cloneColMs = performance.now() - t;

    t = performance.now(); const { json, size: sizeJson } = encodeJsonSize(rows); const jsonEncMs = performance.now() - t;
    t = performance.now(); JSON.parse(json); const jsonDecMs = performance.now() - t;
    t = performance.now(); structuredClone(json); const cloneJsonMs = performance.now() - t;

    runs.push({ qMs, encMs, sizeCol, decFullMs, dec40Ms, cloneColMs, jsonEncMs, sizeJson, jsonDecMs, cloneJsonMs });
  }
  const agg = (k) => p50(runs.map(r => r[k]));
  return {
    label, rows: warmRows.length, columns: fields.map(f => ({ name: f.name, typeCode: f.columnType })),
    p50: {
      qMs: agg('qMs'), encMs: agg('encMs'), sizeColMB: agg('sizeCol') / 1048576,
      decFullMs: agg('decFullMs'), dec40Ms: agg('dec40Ms'), cloneColMs: agg('cloneColMs'),
      jsonEncMs: agg('jsonEncMs'), sizeJsonMB: agg('sizeJson') / 1048576,
      jsonDecMs: agg('jsonDecMs'), cloneJsonMs: agg('cloneJsonMs'),
    },
    _runs: runs,
  };
}

// ---- 连接获取耗时（warm pool）----
async function measureConnect(pool, iter = 7) {
  const xs = [];
  for (let i = 0; i < iter; i++) {
    const t = performance.now();
    const c = await pool.getConnection();
    const ms = performance.now() - t;
    c.release();
    xs.push(ms);
  }
  return p50(xs);
}

// ---- 数据正确性抽查（§八 红线）----
async function correctness(pool) {
  const ids = ['9007199254740993', '9007199254740994', '9007199254740995'];
  const [rows, fields] = await pool.query(
    'SELECT * FROM big_table WHERE id IN (?,?,?) ORDER BY id', ids);
  const idx = {}; fields.forEach((f, i) => idx[f.name] = i);
  const byId = {};
  for (const r of rows) { byId[String(r[idx.id])] = r; }
  const get = (id, col) => byId[id] ? byId[id][idx[col]] : undefined;

  const results = {};
  // 1) BIGINT > 2^53 精确
  const bigId = get('9007199254740993', 'id');
  const enc = encodeColumnar(rows, fields);
  const dec = decodeColumnar(enc, 0, rows.length);
  const decodedBigId = String(dec[0][idx.id]);
  results.bigint_precision = {
    raw: String(bigId), decoded: decodedBigId,
    pass: String(bigId) === '9007199254740993' && decodedBigId === '9007199254740993',
  };
  // 2) DATETIME(6) 微秒不丢
  const ca = get('9007199254740993', 'created_at');
  results.datetime_micro = { raw: ca, pass: ca === '2026-09-21 12:34:56.123456' };
  // 3) JSON 内大整数不被二次解析
  const pl = get('9007199254740993', 'payload');
  results.json_bigint = { raw: pl, pass: typeof pl === 'string' && pl.includes('9007199254740993') && !pl.includes('9007199254740992') };
  // 4) DECIMAL 保持字符串、无浮点尾数
  const amt = get('9007199254740993', 'amount');
  results.decimal_string = { raw: amt, pass: amt === '1234567890.12' && typeof amt === 'string' };
  // 5) nullMask：deleted_at 应为 NULL（第 1、3 行为 NULL，第 2 行有值）
  const del1 = get('9007199254740993', 'deleted_at');
  const del2 = get('9007199254740994', 'deleted_at');
  results.nullmask = { row1: del1, row2: del2, pass: del1 === null && del2 !== null };
  return results;
}

async function main() {
  const pool = mysql.createPool(POOL_CFG);
  const RESULT = { meta: { ts: new Date().toISOString(), env: { node: process.version, mysql: '8.0' } } };

  console.log('== connect / server exec ==');
  RESULT.connectMs = await measureConnect(pool);

  console.log('== scenario LIMIT 3000 (表首屏) ==');
  RESULT.s3000 = await runScenario(pool, 'SELECT * FROM big_table LIMIT 3000', 'LIMIT 3000');

  console.log('== scenario LIMIT 10000 (结果首行渲染) ==');
  RESULT.s10000 = await runScenario(pool, 'SELECT * FROM big_table LIMIT 10000', 'LIMIT 10000');

  console.log('== scenario ORDER BY created_at DESC LIMIT 3000 (排序) ==');
  RESULT.sort = await runScenario(pool, 'SELECT * FROM big_table ORDER BY created_at DESC LIMIT 3000', 'ORDER BY created_at');

  // 补充：更大结果集，观察 JSON 全量解析 vs 列式只解可视区的发散趋势（佐证列式架构理由）
  console.log('== scalability LIMIT 200000 ==');
  RESULT.s200k = await runScenario(pool, 'SELECT * FROM big_table LIMIT 200000', 'LIMIT 200000', 5);
  console.log('== scalability LIMIT 500000 ==');
  RESULT.s500k = await runScenario(pool, 'SELECT * FROM big_table LIMIT 500000', 'LIMIT 500000', 5);

  console.log('== correctness ==');
  RESULT.correctness = await correctness(pool);

  // ---- 预算判定 ----
  const c = RESULT.connectMs;
  const e3000 = RESULT.s3000.p50;
  const e10000 = RESULT.s10000.p50;
  const esort = RESULT.sort.p50;

  // 表首屏 ≤1000ms：connect + 服务端执行 + 列式编码 + (IPC零拷贝transfer≈0) + 解码可视区40行
  const total3000 = c + e3000.qMs + e3000.encMs + e3000.dec40Ms;
  // 首行渲染 ≤500ms（不含查询本身）：列式编码 + 解码40行（transfer 零拷贝≈0）
  const render10000 = e10000.encMs + e10000.dec40Ms;
  // 排序 ≤1500ms：服务端执行 + 编码 + 解码40行
  const totalSort = esort.qMs + esort.encMs + esort.dec40Ms;

  RESULT.verdicts = {
    firstScreen1000ms: { value: +total3000.toFixed(1), budget: 1000, reachable: total3000 <= 1000 },
    firstRowRender500ms: { value: +render10000.toFixed(1), budget: 500, reachable: render10000 <= 500, note: '含列式编码+解码40行；transfer零拷贝≈0' },
    sort1500ms: { value: +totalSort.toFixed(1), budget: 1500, reachable: totalSort <= 1500 },
  };
  RESULT.columnarVsJson = {
    limit3000: {
      sizeMB: { columnar: +e3000.sizeColMB.toFixed(3), json: +e3000.sizeJsonMB.toFixed(3), savedMB: +(e3000.sizeJsonMB - e3000.sizeColMB).toFixed(3) },
      encodeMs: { columnar: +e3000.encMs.toFixed(3), json: +e3000.jsonEncMs.toFixed(3), savedMs: +(e3000.jsonEncMs - e3000.encMs).toFixed(3) },
      decodeMs: { columnarFull: +e3000.decFullMs.toFixed(3), jsonFull: +e3000.jsonDecMs.toFixed(3),
                  columnar40: +e3000.dec40Ms.toFixed(4), jsonMustParseAll: +e3000.jsonDecMs.toFixed(3) },
    },
    limit10000: {
      sizeMB: { columnar: +e10000.sizeColMB.toFixed(3), json: +e10000.sizeJsonMB.toFixed(3), savedMB: +(e10000.sizeJsonMB - e10000.sizeColMB).toFixed(3) },
      encodeMs: { columnar: +e10000.encMs.toFixed(3), json: +e10000.jsonEncMs.toFixed(3) },
      decodeMs: { columnarFull: +e10000.decFullMs.toFixed(3), jsonFull: +e10000.jsonDecMs.toFixed(3), columnar40: +e10000.dec40Ms.toFixed(4) },
    },
  };

  await pool.end();
  fs.mkdirSync('raw', { recursive: true });
  fs.writeFileSync('raw/bench-raw.json', JSON.stringify(RESULT, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  console.log('\n===== SUMMARY =====');
  console.log('connect(ms):', RESULT.connectMs.toFixed(3));
  console.log('LIMIT 3000  size MB  col/json:', e3000.sizeColMB.toFixed(3), '/', e3000.sizeJsonMB.toFixed(3), ' enc ms:', e3000.encMs.toFixed(3), '/', e3000.jsonEncMs.toFixed(3), ' dec40 ms:', e3000.dec40Ms.toFixed(4));
  console.log('LIMIT 10000 size MB  col/json:', e10000.sizeColMB.toFixed(3), '/', e10000.sizeJsonMB.toFixed(3));
  console.log('表首屏 total(ms):', total3000.toFixed(1), '->', RESULT.verdicts.firstScreen1000ms.reachable ? '可达' : '不可达');
  console.log('首行渲染(ms):', render10000.toFixed(1), '->', RESULT.verdicts.firstRowRender500ms.reachable ? '可达' : '不可达');
  console.log('排序 total(ms):', totalSort.toFixed(1), '->', RESULT.verdicts.sort1500ms.reachable ? '可达' : '不可达');
  console.log('correctness:', Object.fromEntries(Object.entries(RESULT.correctness).map(([k, v]) => [k, v.pass])));
  console.log('raw written -> raw/bench-raw.json');
}

main().catch(e => { console.error('BENCH FAILED:', e); process.exit(1); });
