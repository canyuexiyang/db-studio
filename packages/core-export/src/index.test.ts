import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ExportTask,
  sanitizeCell,
  dateToExcelSerial,
  columnName,
  csvRow,
  excelWriterOptions,
  markdownEscapeCell,
  toMarkdownTable,
  XLSX_MAX_CELL_CHARS,
} from './index.js';

describe('sanitizeCell（PRD Q6：超长文本与非法字符）', () => {
  it('超长文本截断到 32767 并标记 truncated', () => {
    const long = 'x'.repeat(XLSX_MAX_CELL_CHARS + 500);
    const r = sanitizeCell(long);
    expect(String(r.value).length).toBe(XLSX_MAX_CELL_CHARS);
    expect(r.truncated).toBe(true);
  });

  it('未超长不截断', () => {
    const r = sanitizeCell('hello');
    expect(r.value).toBe('hello');
    expect(r.truncated).toBe(false);
  });

  it('清除 XML 非法控制字符（否则 xlsx 损坏打不开）', () => {
    const evil = 'a\x00b\x08c\x0Bd\x1Fe';
    const r = sanitizeCell(evil);
    expect(r.value).toBe('abcde');
    expect(r.truncated).toBe(true); // 有清理发生
  });

  it('保留合法空白（Tab/LF/CR 是 XML 合法字符）', () => {
    const r = sanitizeCell('a\tb\nc\rd');
    expect(r.value).toBe('a\tb\nc\rd');
  });

  it('数字/布尔/Date 原样保留（不能被字符串化）', () => {
    expect(sanitizeCell(42).value).toBe(42);
    expect(sanitizeCell(0).value).toBe(0);
    expect(sanitizeCell(true).value).toBe(true);
    expect(sanitizeCell(false).value).toBe(false);
    const d = new Date();
    expect(sanitizeCell(d).value).toBe(d);
  });

  it('null/undefined → null（空单元格）', () => {
    expect(sanitizeCell(null).value).toBeNull();
    expect(sanitizeCell(undefined).value).toBeNull();
  });

  it('NaN/Infinity 转字符串（Excel 无法表示）', () => {
    expect(sanitizeCell(NaN).value).toBe('NaN');
    expect(sanitizeCell(Infinity).value).toBe('Infinity');
  });
});

describe('dateToExcelSerial', () => {
  it('1899-12-30 是 0', () => {
    expect(dateToExcelSerial(new Date(Date.UTC(1899, 11, 30)))).toBe(0);
  });

  it('1900-01-01 是 2', () => {
    expect(dateToExcelSerial(new Date(Date.UTC(1900, 0, 1)))).toBe(2);
  });

  it('2020-01-01 是 43831', () => {
    expect(Math.round(dateToExcelSerial(new Date(Date.UTC(2020, 0, 1))))).toBe(43831);
  });
});

describe('columnName（A1 列名）', () => {
  it('0-25 → A-Z', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
  });

  it('26+ 进位', () => {
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
  });

  it('三位数', () => {
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });
});

describe('csvRow（RFC 4180）', () => {
  it('普通值逗号连接', () => {
    expect(csvRow([1, 'a', true])).toBe('1,a,true');
  });

  it('含逗号加引号', () => {
    expect(csvRow(['a,b'])).toBe('"a,b"');
  });

  it('含引号转义为双引号', () => {
    expect(csvRow(['say "hi"'])).toBe('"say ""hi"""');
  });

  it('含换行加引号', () => {
    expect(csvRow(['a\nb'])).toBe('"a\nb"');
  });

  it('null → 空', () => {
    expect(csvRow([null, undefined, 'x'])).toBe(',,x');
  });

  it('Date 转 ISO', () => {
    const d = new Date(Date.UTC(2020, 0, 1));
    expect(csvRow([d])).toBe('2020-01-01T00:00:00.000Z');
  });

  it('注入防护：SQL 片段按文本原样输出，不被执行', () => {
    // 不含逗号/引号/换行 → 按 RFC 4180 无需加引号，原样输出
    const evil = "'); DROP TABLE t; --";
    expect(csvRow([evil])).toBe("'); DROP TABLE t; --");
  });

  it('含逗号的 SQL 片段加引号包裹（不会被 CSV 解析器拆列）', () => {
    const evil = "1, 'x'); DROP TABLE t; --";
    expect(csvRow([evil])).toBe("\"1, 'x'); DROP TABLE t; --\"");
  });
});

describe('excelWriterOptions（S3 实测强制项）', () => {
  it('强制 useSharedStrings:false + useStyles:false', () => {
    const o = excelWriterOptions('/tmp/a.xlsx');
    expect(o.useSharedStrings).toBe(false);
    expect(o.useStyles).toBe(false);
    expect(o.filename).toBe('/tmp/a.xlsx');
  });
});

describe('toMarkdownTable（E1）', () => {
  const cols = [{ name: 'id' }, { name: 'name' }];

  it('表头行 + |---| 分隔行 + 值行', () => {
    const md = toMarkdownTable(cols, [
      [1, 'alice'],
      [2, 'bob'],
    ]);
    expect(md).toBe('| id | name |\n| --- | --- |\n| 1 | alice |\n| 2 | bob |');
  });

  it('NULL 用 options.nullText（默认 \\N）', () => {
    expect(toMarkdownTable(cols, [[1, null]])).toBe('| id | name |\n| --- | --- |\n| 1 | \\N |');
    expect(toMarkdownTable(cols, [[1, null]], { nullText: '(空)' })).toBe(
      '| id | name |\n| --- | --- |\n| 1 | (空) |',
    );
    // 显式空串 = 旧 CSV 行为（NULL 导出为空单元格）
    expect(toMarkdownTable(cols, [[1, null]], { nullText: '' })).toBe('| id | name |\n| --- | --- |\n| 1 |  |');
  });

  it('竖线转义 \\|，不破表', () => {
    expect(markdownEscapeCell('a|b')).toBe('a\\|b');
    expect(toMarkdownTable(cols, [['x|y', 'z']])).toBe('| id | name |\n| --- | --- |\n| x\\|y | z |');
  });

  it('换行转 <br>（\\n / \\r\\n / \\r 三种形态）', () => {
    expect(markdownEscapeCell('a\nb')).toBe('a<br>b');
    expect(markdownEscapeCell('a\r\nb')).toBe('a<br>b');
    expect(markdownEscapeCell('a\rb')).toBe('a<br>b');
  });

  it('列名同样转义（列名也可能含竖线）', () => {
    const md = toMarkdownTable([{ name: 'a|b' }], [['v']]);
    expect(md).toBe('| a\\|b |\n| --- |\n| v |');
  });

  it('空结果集只剩表头与分隔行', () => {
    expect(toMarkdownTable(cols, [])).toBe('| id | name |\n| --- | --- |');
  });

  it('Date 转 ISO（与 csvRow 同口径）', () => {
    const d = new Date(Date.UTC(2020, 0, 1));
    expect(toMarkdownTable(cols, [[d, 'x']])).toBe(
      '| id | name |\n| --- | --- |\n| 2020-01-01T00:00:00.000Z | x |',
    );
  });
});

describe('ExportTask — 取消是真取消', () => {
  function makeTask() {
    const t = new ExportTask('job-1', '/tmp/out.xlsx');
    const child: any = new EventEmitter();
    child.pid = 12345;
    let killed = false;
    child.kill = () => { killed = true; return true; };
    t.attach(child);
    return { t, child, wasKilled: () => killed };
  }

  it('cancel 调用底层 kill()', () => {
    const { t, wasKilled } = makeTask();
    expect(t.cancel()).toBe(true);
    expect(wasKilled()).toBe(true);
    expect(t.isCancelled).toBe(true);
  });

  it('重复 cancel 不重复 kill', () => {
    const { t } = makeTask();
    t.cancel();
    expect(t.cancel()).toBe(false);
  });

  it('未 attach 时 cancel 安全返回 false', () => {
    const t = new ExportTask('job-x', '/tmp/x');
    expect(t.cancel()).toBe(false);
  });

  it('进度/完成/错误回调按 jobId 过滤', () => {
    const { t, child } = makeTask();
    let progress = 0, done: any = null, err: any = null;
    t.onProgress((n) => { progress = n; });
    t.onDone((r) => { done = r; });
    t.onError((m) => { err = m; });

    // 别的 job 的消息应被忽略
    child.emit('message', { type: 'progress', jobId: 'other', rowsWritten: 999 });
    expect(progress).toBe(0);

    child.emit('message', { type: 'progress', jobId: 'job-1', rowsWritten: 100, elapsedMs: 5 });
    expect(progress).toBe(100);

    child.emit('message', { type: 'done', jobId: 'job-1', rowsWritten: 200, elapsedMs: 10, bytes: 42 });
    expect(done.rowsWritten).toBe(200);

    child.emit('message', { type: 'error', jobId: 'job-1', message: 'boom', fatal: true });
    expect(err).toBe('boom');
  });

  it('kill 异常时安全返回 false', () => {
    const t = new ExportTask('job-y', '/tmp/y');
    const child: any = new EventEmitter();
    child.pid = 1;
    child.kill = () => { throw new Error('already dead'); };
    t.attach(child);
    expect(t.cancel()).toBe(false);
    expect(t.isCancelled).toBe(true);
  });
});
