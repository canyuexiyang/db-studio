'use strict';
// S3 导出核心：只用 exceljs stream.xlsx.WorkbookWriter（禁止 workbook.xlsx.writeFile）
// 逐行 addRow().commit()，不构造样式对象。两种模式：
//   mode='default'    -> 流式默认配置（对齐公开基准，useSharedStrings 走 exceljs 默认 true）
//   mode='sharedOff'  -> 优化开关 useSharedStrings:false + useStyles:false
const ExcelJS = require('exceljs');
const fs = require('node:fs');

// 确定性 PRNG（xorshift32），保证每次跑数据一致、文件体积可比
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure').split(' ');

// 12 列，贴近真实混合类型：字符串/整数/小数/日期/NULL/少量长文本（PRD D3 导入口径一致）
function makeRowGen(seed) {
  const rng = makeRng(seed);
  let i = 0;
  return function nextRow() {
    const id = i++;
    const name = 'user_' + id + '_' + Math.floor(rng() * 1e6).toString(36);
    const intVal = Math.floor(rng() * 1e9);
    const decVal = Math.round(rng() * 1e6) / 100;            // 2 位小数
    const days = Math.floor(rng() * 3650);
    const ms = Math.floor(rng() * 86400000);
    const d = new Date(Date.UTC(2020, 0, 1) + days * 86400000 + ms);
    const dateStr = d.toISOString().slice(0, 19).replace('T', ' '); // 日期走字符串
    const maybeNull = (id % 37 === 0) ? null : ('tag_' + Math.floor(rng() * 1000)); // ~2.7% NULL
    const status = ['active', 'inactive', 'pending', 'banned'][Math.floor(rng() * 4)];
    const shortText = 'note:' + Math.floor(rng() * 1e5);
    let longText = '';
    if (id % 50 === 0) {                                     // 偶尔长文本（几百字符）
      let s = '';
      for (let k = 0; k < 45; k++) s += WORDS[Math.floor(rng() * WORDS.length)] + ' ';
      longText = s.trim();
    }
    const dec2 = Math.round(rng() * 1e8) / 100;
    const special = 'v' + Math.floor(rng() * 100) + '\t"x,<y> & ' + Math.floor(rng() * 10); // 含特殊字符
    const int2 = Math.floor(rng() * 1e7);
    return [id, name, intVal, decVal, dateStr, maybeNull, status, shortText, longText, dec2, special, int2];
  };
}

// 单次导出，返回 { timeMs, peakRss, fileBytes }
function runExport(opts) {
  return new Promise((resolve, reject) => {
    const { rows, mode, outPath } = opts;
    let peak = 0;
    const sampler = setInterval(() => {
      const r = process.memoryUsage().rss;
      if (r > peak) peak = r;
    }, 25);

    const wopts = { filename: outPath };
    if (mode === 'sharedOff') { wopts.useSharedStrings = false; wopts.useStyles = false; }
    // mode==='default' 不传任何选项 -> exceljs 流式默认配置（useSharedStrings 默认 true）

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter(wopts);
    const ws = wb.addWorksheet('data');
    ws.columns = [
      { header: 'id', width: 12 },
      { header: 'name', width: 24 },
      { header: 'int_val', width: 14 },
      { header: 'dec_val', width: 14 },
      { header: 'created_at', width: 22 },
      { header: 'tag', width: 12 },
      { header: 'status', width: 12 },
      { header: 'short_text', width: 18 },
      { header: 'long_text', width: 40 },
      { header: 'amount', width: 14 },
      { header: 'special', width: 18 },
      { header: 'counter', width: 14 },
    ];

    const gen = makeRowGen(12345);
    const start = process.hrtime.bigint();
    for (let k = 0; k < rows; k++) {
      const row = gen();
      ws.addRow(row).commit();
    }
    ws.commit();

    wb.commit().then(() => {
      clearInterval(sampler);
      const end = process.hrtime.bigint();
      const timeMs = Number(end - start) / 1e6;
      let fileBytes = 0;
      try { fileBytes = fs.statSync(outPath).size; } catch (e) {}
      resolve({ timeMs, peakRss: peak, fileBytes });
    }).catch(reject);
  });
}

module.exports = { runExport, makeRowGen, makeRng, WORDS };
