/**
 * Spike S3 — 100 万行 xlsx 导出实测
 *
 * 目的：给 PRD §7「导出 100 万行到 xlsx」重新定标（原 ≤30s，R7 已改为待实测）。
 * 约束（TECH-REVIEW §1.5 / §5.3）：
 *   - exceljs 只用 stream.xlsx.WorkbookWriter，禁止 workbook.xlsx.writeFile()
 *   - 逐行 addRow().commit()，不构造样式对象
 *   - 峰值内存需 ≤500MB
 *
 * 场景：
 *   E1 10万行×12列 默认配置
 *   E2 100万行×12列 默认配置
 *   E3 100万行×12列 useSharedStrings:false + useStyles:false
 *   E4 100万行×12列 手写 sheet XML（inline string）+ archiver 流式 zip
 */

import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

// archiver@8 的 package.json 标了 "type":"module" 但实际是 CJS 导出，用 require 加载。
// 且它没有 default 导出，具名导出为 { Archiver, ZipArchive, ... } —— 用 create 或直接取 ZipArchive。
const require_ = createRequire(import.meta.url);
const archiverMod = require_('archiver');
const ZipArchive = archiverMod.ZipArchive || archiverMod;

const OUT_DIR = path.join(os.tmpdir(), 'dbstudio-s3-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const COLS = 12;

// ---------- 假数据生成（贴近真实：混合类型 + 少量长文本 + NULL） ----------
// 不在滚动路径上做对象分配是网格的要求；这里是导出路径，重点是流式不缓冲。
function makeRow(i) {
  const r = new Array(COLS);
  r[0] = i;                                        // int
  r[1] = `user_${i}@example.com`;                  // string
  r[2] = `name_${i % 100000}`;                     // string
  r[3] = (i % 5 === 0) ? null : i * 1.37;           // decimal + NULL
  r[4] = new Date(Date.UTC(2020, 0, 1) + i * 1000); // date
  r[5] = ['active', 'pending', 'closed', 'archived'][i % 4];
  r[6] = i % 1000;
  r[7] = `city_${i % 300}`;
  r[8] = (i % 7 === 0) ? null : `note ${i}`;        // 含 NULL 的字符串
  r[9] = i % 2 === 0;
  r[10] = (i % 11 === 0) ? 'x'.repeat(400) : `s${i}`; // 少量长文本
  r[11] = i * 3 % 100000;
  return r;
}

// ---------- 峰值内存采样 ----------
function startMemSampler() {
  let peak = 0;
  const t = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 50);
  return {
    stop() { clearInterval(t); return peak; },
    peak: () => peak,
  };
}

function p50(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------- exceljs 流式实现 ----------
async function exportExceljs(rows, file, opts = {}) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: file,
    useSharedStrings: opts.useSharedStrings ?? true,
    useStyles: opts.useStyles ?? true,
  });
  const ws = wb.addWorksheet('Sheet1');
  ws.columns = Array.from({ length: COLS }, (_, i) => ({ header: `col_${i}`, width: 14 }));
  for (let i = 0; i < rows; i++) {
    ws.addRow(makeRow(i)).commit();
  }
  ws.commit();
  await wb.commit();
}

// ---------- 手写 sheet XML + archiver 流式 zip ----------
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// 去除 XML 1.0 非法控制字符（PRD Q6：非法字符会让 xlsx 损坏打不开）
const ILLEGAL_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function clean(s) { return String(s).replace(ILLEGAL_XML, '').slice(0, 32767); }

function colName(n) {
  let s = '';
  n = n + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function exportRawXml(rows, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const archive = new ZipArchive({ zlib: { level: 1 } }); // level 1 重速度
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);

    archive.append(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
      { name: '[Content_Types].xml' }
    );
    archive.append(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
      { name: '_rels/.rels' }
    );
    archive.append(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      { name: 'xl/workbook.xml' }
    );
    archive.append(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
      { name: 'xl/_rels/workbook.xml.rels' }
    );

    // sheet XML 用 inline string（t="inlineStr"），不用 sharedStrings
    const sheetStream = new PassThrough();
    archive.append(sheetStream, { name: 'xl/worksheets/sheet1.xml' });

    (async () => {
      sheetStream.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');

      // header
      sheetStream.write('<row r="1">');
      for (let c = 0; c < COLS; c++) {
        sheetStream.write(`<c r="${colName(c)}1" t="inlineStr"><is><t>${clean(`col_${c}`)}</t></is></c>`);
      }
      sheetStream.write('</row>');

      const buf = [];
      for (let i = 0; i < rows; i++) {
        const row = makeRow(i);
        const rn = i + 2;
        let s = `<row r="${rn}">`;
        for (let c = 0; c < COLS; c++) {
          const v = row[c];
          const ref = `${colName(c)}${rn}`;
          if (v === null || v === undefined) {
            continue; // 空单元格
          } else if (typeof v === 'number') {
            s += `<c r="${ref}"><v>${v}</v></c>`;
          } else if (typeof v === 'boolean') {
            s += `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
          } else if (v instanceof Date) {
            // Excel 序列号：days since 1899-12-30
            const serial = (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
            s += `<c r="${ref}"><v>${serial.toFixed(10)}</v></c>`;
          } else {
            s += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${clean(xmlEsc(v))}</t></is></c>`;
          }
        }
        s += '</row>';
        buf.push(s);
        if (buf.length >= 1000) { sheetStream.write(buf.join('')); buf.length = 0; }
      }
      if (buf.length) sheetStream.write(buf.join(''));
      sheetStream.write('</sheetData></worksheet>');
      sheetStream.end();
    })();

    archive.finalize();
  });
}

// ---------- 主流程 ----------
const scenarios = [];
const rows100k = 100_000;
const rows1m = 1_000_000;

const RUNS = Number(process.env.RUNS || 3);
const ONLY = process.env.ONLY; // 可只跑某个场景

function want(id) { return !ONLY || ONLY === id; }

async function runScenario(id, label, fn, rows) {
  if (!want(id)) return;
  const times = [];
  const peaks = [];
  let size = 0;
  for (let k = 0; k < RUNS; k++) {
    const file = path.join(OUT_DIR, `${id}_${k}.xlsx`);
    const mem = startMemSampler();
    const t0 = performance.now();
    await fn(rows, file);
    const dt = performance.now() - t0;
    const peak = mem.stop();
    times.push(dt);
    peaks.push(peak);
    size = fs.statSync(file).size;
    fs.unlinkSync(file); // 测完即删，别留大文件
  }
  scenarios.push({
    id, label, rows,
    p50_ms: Math.round(p50(times)),
    times_ms: times.map(Math.round),
    peak_mem_mb: Math.round(p50(peaks) / 1024 / 1024),
    file_mb: +(size / 1024 / 1024).toFixed(1),
  });
  console.log(`[${id}] ${label} → P50 ${Math.round(p50(times))}ms / peak ${Math.round(p50(peaks) / 1024 / 1024)}MB / ${(size / 1024 / 1024).toFixed(1)}MB`);
}

console.log(`S3 xlsx export bench — runs=${RUNS} · node ${process.version} · ${os.cpus()[0].model}\n`);

await runScenario('E1', '10万行×12列 exceljs 流式默认', (r, f) => exportExceljs(r, f), rows100k);
await runScenario('E2', '100万行×12列 exceljs 流式默认', (r, f) => exportExceljs(r, f), rows1m);
await runScenario('E3', '100万行×12列 exceljs useSharedStrings:false+useStyles:false',
  (r, f) => exportExceljs(r, f, { useSharedStrings: false, useStyles: false }), rows1m);
await runScenario('E4', '100万行×12列 手写 sheet XML + archiver 流式 zip', exportRawXml, rows1m);

fs.mkdirSync(path.join(process.cwd(), 'raw'), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), 'raw', 'export-bench.json'),
  JSON.stringify({ env: { node: process.version, cpu: os.cpus()[0].model, mem_gb: Math.round(os.totalmem() / 1024 ** 3) }, runs: RUNS, scenarios }, null, 2)
);
console.log('\n结果已写入 raw/export-bench.json');
