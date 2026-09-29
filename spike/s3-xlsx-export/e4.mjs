// E4 备选实现：手写 sheet XML（inline string，不用 sharedStrings）+ archiver 流式 zip。
// 仅在 E3 仍 >60s 时才启用（本 spike 中 E3 预计落在 30~60s，故默认不做）。
// 代价：失去样式能力（导出场景可接受）。仍逐行流式写，内存应保持低位。
import archiver from 'archiver';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeRowGen } = require('./export-core.cjs');

function colLetter(idx) { // 0-based -> A, B, ... L
  let s = ''; idx++;
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 用 async 迭代器喂 Readable，archiver 以背压方式读取，内存不会因缓冲爆炸
function sheetStream(rows) {
  const gen = makeRowGen(12345);
  return Readable.from((async function* () {
    yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
    yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    for (let r = 0; r < rows; r++) {
      const row = gen();
      let cells = '';
      for (let c = 0; c < 12; c++) {
        const v = row[c];
        const ref = colLetter(c) + (r + 1);
        if (v === null || v === undefined) cells += `<c r="${ref}"/>`;
        else if (typeof v === 'number') cells += `<c r="${ref}"><v>${v}</v></c>`;
        else cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
      }
      yield `<row r="${r + 1}">${cells}</row>`;
    }
    yield '</sheetData></worksheet>';
  })());
}

function runE4(rows, outPath) {
  return new Promise((resolve, reject) => {
    let peak = 0;
    const sampler = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 25);
    const start = process.hrtime.bigint();

    const out = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    const done = new Promise((res, rej) => { out.on('close', res); archive.on('error', rej); });
    archive.pipe(out);

    archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>', { name: '[Content_Types].xml' });

    archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>', { name: '_rels/.rels' });

    archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets></workbook>', { name: 'xl/workbook.xml' });

    archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>', { name: 'xl/_rels/workbook.xml.rels' });

    archive.append(sheetStream(rows), { name: 'xl/worksheets/sheet1.xml' });

    archive.finalize();
    done.then(() => {
      clearInterval(sampler);
      const end = process.hrtime.bigint();
      const timeMs = Number(end - start) / 1e6;
      let fileBytes = 0; try { fileBytes = fs.statSync(outPath).size; } catch (e) {}
      resolve({ timeMs, peakRss: peak, fileBytes });
    }).catch(reject);
  });
}

// 若作为脚本直接运行：node e4.mjs <rows> <outPath>
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = parseInt(process.argv[2], 10) || 1000000;
  const outPath = process.argv[3] || '/tmp/s3_e4.xlsx';
  const r = await runE4(rows, outPath);
  process.stdout.write(JSON.stringify({ name: 'E4', rows, ...r }) + '\n');
}
