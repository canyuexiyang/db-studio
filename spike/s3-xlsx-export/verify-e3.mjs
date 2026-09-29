// E3（exceljs useSharedStrings:false + useStyles:false）读回校验，与 E4 对照类型保真
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const COLS = 12;
const ROWS = Number(process.env.ROWS || 50000);

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

const file = path.join(os.tmpdir(), 's3-verify-e3.xlsx');
const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
  filename: file, useSharedStrings: false, useStyles: false,
});
const ws = wb.addWorksheet('Sheet1');
for (let i = 0; i < ROWS; i++) ws.addRow(makeRow(i)).commit();
ws.commit();
await wb.commit();

console.log('E3 rows=' + ROWS + ' size=' + (fs.statSync(file).size / 1024 / 1024).toFixed(1) + 'MB');

const rb = new ExcelJS.Workbook();
await rb.xlsx.readFile(file);
const sheet = rb.getWorksheet(1);
console.log('读回成功：rowCount=' + sheet.rowCount + ' colCount=' + sheet.columnCount);

const r3 = sheet.getRow(3).values.slice(1);
console.log('row3:', JSON.stringify(r3.map(v => v instanceof Date ? 'Date(' + v.toISOString() + ')' : v)));

const checks = {
  '第0列 int': typeof r3[0] === 'number' && r3[0] === 1,
  '第3列 decimal': typeof r3[3] === 'number',
  '第4列 Date': r3[4] instanceof Date,
  '第9列 boolean': typeof r3[9] === 'boolean',
  '第10列 string': typeof r3[10] === 'string',
};
console.log('类型校验:', JSON.stringify(checks, null, 2));

fs.unlinkSync(file);
console.log('已清理');
