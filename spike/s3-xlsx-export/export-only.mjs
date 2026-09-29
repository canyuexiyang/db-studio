// 只测导出（不读回），用 /usr/bin/time -l 拿纯导出的 maximum RSS
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require_ = createRequire(import.meta.url);
const { ZipArchive } = require_('archiver');

const COLS = 12;
const ROWS = Number(process.env.ROWS || 1000000);

function makeRow(i) {
  const r = new Array(COLS);
  r[0] = i;
  r[1] = 'user_' + i + '@example.com';
  r[2] = 'name_' + (i % 100000);
  r[3] = (i % 5 === 0) ? null : i * 1.37;
  r[4] = new Date(Date.UTC(2020, 0, 1) + i * 1000);
  r[5] = ['active', 'pending', 'closed', 'archived'][i % 4];
  r[6] = i % 1000;
  r[7] = 'city_' + (i % 300);
  r[8] = (i % 7 === 0) ? null : 'note ' + i;
  r[9] = i % 2 === 0;
  r[10] = (i % 11 === 0) ? 'x'.repeat(400) : 's' + i;
  r[11] = i * 3 % 100000;
  return r;
}

const ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const clean = (s) => String(s).replace(ILLEGAL, '').slice(0, 32767);
const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function colName(n) {
  let s = '';
  n = n + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const file = path.join(os.tmpdir(), 's3-only.xlsx');

await new Promise((resolve, reject) => {
  const out = fs.createWriteStream(file);
  const archive = new ZipArchive({ zlib: { level: 1 } });
  out.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(out);

  archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', { name: '[Content_Types].xml' });
  archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', { name: '_rels/.rels' });
  archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>', { name: 'xl/workbook.xml' });
  archive.append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', { name: 'xl/_rels/workbook.xml.rels' });

  const ss = new PassThrough();
  archive.append(ss, { name: 'xl/worksheets/sheet1.xml' });

  (async () => {
    ss.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
    ss.write('<row r="1">');
    for (let c = 0; c < COLS; c++) {
      ss.write('<c r="' + colName(c) + '1" t="inlineStr"><is><t>col_' + c + '</t></is></c>');
    }
    ss.write('</row>');
    const buf = [];
    for (let i = 0; i < ROWS; i++) {
      const row = makeRow(i);
      const rn = i + 2;
      let s = '<row r="' + rn + '">';
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        const ref = colName(c) + rn;
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') s += '<c r="' + ref + '"><v>' + v + '</v></c>';
        else if (typeof v === 'boolean') s += '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
        else if (v instanceof Date) {
          const serial = (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
          s += '<c r="' + ref + '"><v>' + serial.toFixed(10) + '</v></c>';
        } else s += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + clean(xmlEsc(v)) + '</t></is></c>';
      }
      s += '</row>';
      buf.push(s);
      if (buf.length >= 1000) { ss.write(buf.join('')); buf.length = 0; }
    }
    if (buf.length) ss.write(buf.join(''));
    ss.write('</sheetData></worksheet>');
    ss.end();
  })();
  archive.finalize();
});

console.log('E4 export only rows=' + ROWS + ' size=' + (fs.statSync(file).size / 1024 / 1024).toFixed(1) + 'MB');
fs.unlinkSync(file);
