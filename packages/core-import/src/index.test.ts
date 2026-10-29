import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  parseDelimited,
  sniffDelimiter,
  stripBom,
  sniffEncoding,
  decodeBytes,
  normalizeEncoding,
  guessMapping,
  cellTextToValue,
  buildInsertBatches,
  issuesToCsv,
  normalizeJsonRows,
  jsonCellText,
  filterRetryRows,
} from './index.js';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';

// 🔴 双实现漂移防线：index.ts（ESM re-export）与 runtime.cjs（worker 直接 require）
//    必须是同一份实现 —— 各测一遍关键行为，不一致立刻红。
const require_ = createRequire(import.meta.url);
const runtime = require_('./runtime.cjs');

const C = (over: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name: 'c',
  dataType: 'varchar(64)',
  nullable: true,
  defaultValue: null,
  comment: null,
  isPrimaryKey: false,
  isUnique: false,
  autoIncrement: false,
  charset: null,
  collation: null,
  ...over,
});

describe('parseDelimited', () => {
  it('基础 CSV 解析', () => {
    expect(parseDelimited('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引号包裹：含逗号/换行/引号转义', () => {
    expect(parseDelimited('"a,x","b""q","r\nl"', ',')).toEqual([['a,x', 'b"q', 'r\nl']]);
  });

  it('BOM 剥离', () => {
    expect(stripBom('\ufeffid,name')).toBe('id,name');
    expect(parseDelimited('\ufeffid\n1', ',')).toEqual([['id'], ['1']]);
  });

  it('\r\n 与 \r 换行都按行切', () => {
    expect(parseDelimited('a,b\r\n1,2\ra', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['a'],
    ]);
  });

  it('空字符串不产生空行；末尾换行不产生空行', () => {
    expect(parseDelimited('', ',')).toEqual([]);
    expect(parseDelimited('a\n', ',')).toEqual([['a']]);
  });

  it('TSV 解析（Excel 复制口径）', () => {
    expect(parseDelimited('id\tname\n1\thello', '\t')).toEqual([
      ['id', 'name'],
      ['1', 'hello'],
    ]);
  });

  it('字段中间的引号按字面处理', () => {
    expect(parseDelimited('a"b,c', ',')).toEqual([['a"b', 'c']]);
  });
});

describe('sniffDelimiter', () => {
  it('制表符优先', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('逗号', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('分号兜底', () => {
    expect(sniffDelimiter('a;b;c')).toBe(';');
  });
});

describe('guessMapping', () => {
  it('同名匹配优先，忽略大小写与空白', () => {
    const cols = [C({ name: 'id', dataType: 'bigint' }), C({ name: 'Name' })];
    const r = guessMapping([' ID ', 'name'], cols);
    expect(r.mapping).toEqual(['id', 'Name']);
    expect(r.unmatchedTableColumns).toEqual([]);
  });

  it('无同名列按位置补齐', () => {
    const cols = [C({ name: 'a' }), C({ name: 'b' })];
    const r = guessMapping(['x', 'y'], cols);
    expect(r.mapping).toEqual(['a', 'b']);
    expect(r.notes.some((n) => n.includes('按位置对齐'))).toBe(true);
  });

  it('文件列多于表列 → 多的置 null', () => {
    const cols = [C({ name: 'a' })];
    const r = guessMapping(['a', 'extra'], cols);
    expect(r.mapping).toEqual(['a', null]);
    expect(r.notes.some((n) => n.includes('将被跳过'))).toBe(true);
  });
});

describe('cellTextToValue', () => {
  it('NULL 字面量 → null', () => {
    expect(cellTextToValue('NULL')).toBeNull();
    expect(cellTextToValue('null')).toBeNull();
    expect(cellTextToValue('\\N')).toBeNull();
  });
  it('普通值原样保留', () => {
    expect(cellTextToValue('hello')).toBe('hello');
    expect(cellTextToValue('  spaced  ')).toBe('  spaced  ');
  });
  it('空串 → null（Excel 无法表达 NULL 的约定）', () => {
    expect(cellTextToValue('')).toBeNull();
  });
});

describe('buildInsertBatches', () => {
  const cols = [
    C({ name: 'id', dataType: 'bigint', nullable: false }),
    C({ name: 'name', dataType: 'varchar(64)', nullable: false }),
  ];

  it('生成多值 INSERT，值全 ? 占位', () => {
    const rows = [
      ['id', 'name'],
      ['1', 'a'],
      ['2', 'b'],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    expect(r.totalRows).toBe(2);
    expect(r.insertableRows).toBe(2);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].sql).toBe('INSERT INTO `db`.`t` (`id`, `name`) VALUES (?, ?), (?, ?)');
    // id 是字符串 '1'/'2'（R10 副作用 + cellTextToValue 保留原文）
    expect(r.statements[0].params).toEqual(['1', 'a', '2', 'b']);
    expect(r.invalidRows).toEqual([]);
  });

  it('NULL 字面量转 null 绑定值', () => {
    // name 用 nullable:true 的表结构，NULL 才能通过校验
    const nullable = [
      C({ name: 'id', dataType: 'bigint', nullable: false }),
      C({ name: 'name', dataType: 'varchar(64)', nullable: true }),
    ];
    const rows = [
      ['id', 'name'],
      ['1', 'NULL'],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], nullable, { hasHeader: true });
    expect(r.statements[0].params).toEqual(['1', null]);
  });

  it('类型不合法的整行剔除并报告', () => {
    const rows = [
      ['id', 'name'],
      ['not-a-number', 'a'],
      ['3', 'b'],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    expect(r.insertableRows).toBe(1);
    expect(r.invalidRows).toHaveLength(1);
    expect(r.invalidRows[0].fileRow).toBe(2);
    expect(r.invalidRows[0].column).toBe('id');
    expect(r.invalidRows[0].reason).toContain('bigint');
  });

  it('NOT NULL 空值被拒', () => {
    const rows = [
      ['id', 'name'],
      ['1', ''],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    expect(r.insertableRows).toBe(0);
    expect(r.invalidRows[0].reason).toContain('不允许为 NULL');
  });

  it('按 batchSize 分批', () => {
    const rows = [['id']];
    for (let i = 1; i <= 2500; i++) rows.push([String(i)]);
    const r = buildInsertBatches('db', 't', rows, ['id'], cols.slice(0, 1), { hasHeader: true, batchSize: 1000 });
    expect(r.statements).toHaveLength(3);
    expect(r.statements[0].rowCount).toBe(1000);
    expect(r.statements[2].rowCount).toBe(500);
  });

  it('自增列显式给值也进列清单（导入语义：用户明确给了就写）', () => {
    const autoCols = [
      C({ name: 'id', dataType: 'bigint', autoIncrement: true, nullable: false }),
      C({ name: 'name', dataType: 'varchar(64)' }),
    ];
    const rows = [
      ['id', 'name'],
      ['10', 'x'],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], autoCols, { hasHeader: true });
    expect(r.statements[0].sql).toContain('(`id`, `name`)');
    expect(r.statements[0].params).toEqual(['10', 'x']);
  });

  it('映射为 null 的列不进 INSERT', () => {
    const rows = [
      ['id', 'junk'],
      ['1', 'zzz'],
    ];
    const r = buildInsertBatches('db', 't', rows, ['id', null], cols, { hasHeader: true });
    expect(r.statements[0].sql).toContain('(`id`)');
    expect(r.statements[0].params).toEqual(['1']);
  });
});

describe('issuesToCsv', () => {
  it('导出含表头的 CSV，含逗号的 reason 加引号', () => {
    const csv = issuesToCsv([
      { fileRow: 3, column: 'a', raw: 'x', reason: '列 a 是 bigint，但值 "x" 不是合法数值' },
    ]);
    expect(csv.split('\n')[0]).toBe('file_row,column,reason');
    expect(csv).toContain('3,a,');
  });
});

/**
 * P1-10 编码探测与解码。
 *
 * 这些断言的价值全在**边界**上：真实用户手上的 GBK 文件按 UTF-8 硬读不会报错，
 * 只会静默变成 `�`，然后一路乱码进库。所以：
 *  · 探测必须"严格"，非严格解码永远成功，探测就退化成恒 'utf8'；
 *  · BOM 必须剥掉，否则首列表头带 `\ufeff`，自动映射认不出来。
 */
describe('编码探测与解码（UTF-8 / GBK）', () => {
  /** 「中文」的 GBK 字节（硬编码：这就是旧系统导出文件里真实出现的东西） */
  const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
  const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  it('有 UTF-8 BOM → utf8（BOM 是最可靠的信号，不用猜）', () => {
    expect(sniffEncoding(concat(UTF8_BOM, new TextEncoder().encode('中文')))).toBe('utf8');
  });

  it('纯 UTF-8 中文 → utf8', () => {
    expect(sniffEncoding(new TextEncoder().encode('id,名称\n1,订单'))).toBe('utf8');
  });

  it('GBK 字节 → gbk（严格解码失败才判 gbk，不是"看着不像"）', () => {
    expect(sniffEncoding(GBK_ZHONGWEN)).toBe('gbk');
  });

  it('空文件按 utf8（空输入没有证据，别选一个更窄的编码）', () => {
    expect(sniffEncoding(new Uint8Array())).toBe('utf8');
  });

  it('按 gbk 解码得到中文原文（不是替换字符）', () => {
    expect(decodeBytes(GBK_ZHONGWEN, 'gbk')).toBe('中文');
  });

  it('🔴 解码 utf8 时剥掉 BOM —— 否则首列表头带 \\ufeff，自动映射全错', () => {
    const bytes = concat(UTF8_BOM, new TextEncoder().encode('ID,name'));
    const text = decodeBytes(bytes, 'utf8');
    expect(text).toBe('ID,name');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('强制 utf8 读 GBK 文件：不抛错，但结果里没有原文（UI 靠这个现象提示换编码）', () => {
    const text = decodeBytes(GBK_ZHONGWEN, 'utf8');
    expect(text).not.toBe('中文');
  });

  it('编码字面量归一：GBK/gbk/utf-8 都收，默认 utf8', () => {
    expect(normalizeEncoding('GBK')).toBe('gbk');
    expect(normalizeEncoding(' gbk ')).toBe('gbk');
    expect(normalizeEncoding('utf-8')).toBe('utf8');
    expect(normalizeEncoding(null)).toBe('utf8');
    expect(normalizeEncoding(undefined)).toBe('utf8');
  });

  it('双实现一致：index.ts 与 runtime.cjs 的探测/解码结果相同', () => {
    expect(runtime.sniffEncoding(GBK_ZHONGWEN)).toBe(sniffEncoding(GBK_ZHONGWEN));
    expect(runtime.decodeBytes(GBK_ZHONGWEN, 'gbk')).toBe(decodeBytes(GBK_ZHONGWEN, 'gbk'));
    expect(runtime.utf8BomLength(concat(UTF8_BOM, new Uint8Array([1])))).toBe(3);
    expect(runtime.utf8BomLength(GBK_ZHONGWEN)).toBe(0);
  });
});

describe('双实现一致性（index.ts ↔ runtime.cjs）', () => {
  const cols = [
    C({ name: 'id', dataType: 'bigint', nullable: false }),
    C({ name: 'name', dataType: 'varchar(4)', nullable: false }),
  ];
  const rows = [
    ['id', 'name'],
    ['1', 'ok'],
    ['bad', '超长文本超长'],
  ];

  it('parseDelimited / buildInsertBatches 两份实现行为一致', () => {
    const text = 'a,"b,x"\n1,"has""q"';
    expect(runtime.parseDelimited(text, ',')).toEqual(parseDelimited(text, ','));
    expect(runtime.stripBom('\ufeffx')).toBe(stripBom('\ufeffx'));
    expect(runtime.sniffDelimiter('a,b\tc')).toBe(sniffDelimiter('a,b\tc'));

    const viaRuntime = runtime.buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    const viaEsm = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    expect(viaRuntime).toEqual(viaEsm);
    // 行为抽查：1 行有效；bad 行报 id 非法 + name 超长 2 个 issue
    expect(viaRuntime.insertableRows).toBe(1);
    expect(viaRuntime.invalidRows.length).toBe(2);
    expect(viaRuntime.invalidRows.map((x: { column: string }) => x.column).sort()).toEqual(['id', 'name']);
  });

  it('guessMapping / cellTextToValue 两份实现行为一致', () => {
    const g1 = runtime.guessMapping(['ID', 'x'], cols);
    const g2 = guessMapping(['ID', 'x'], cols);
    expect(g1).toEqual(g2);
    expect(runtime.cellTextToValue('NULL')).toBe(cellTextToValue('NULL'));
    expect(runtime.cellTextToValue('val')).toBe(cellTextToValue('val'));
  });

  it('normalizeJsonRows / jsonCellText / filterRetryRows 两份实现行为一致（E3/E5）', () => {
    const parsed = [{ b: 1, a: 'x' }, { a: 'y', c: true }];
    expect(runtime.normalizeJsonRows(parsed)).toEqual(normalizeJsonRows(parsed));
    expect(runtime.jsonCellText(null)).toBe(jsonCellText(null));
    expect(runtime.filterRetryRows(5, [3, 1, 9])).toEqual(filterRetryRows(5, [3, 1, 9]));
  });
});

describe('normalizeJsonRows（E3）', () => {
  it('对象数组 → 行 + 稳定键序（首对象键序优先，新键按出现顺序追加）', () => {
    const r = normalizeJsonRows([{ b: 1, a: 'x' }, { a: 'y', c: true }, { d: null }]);
    expect(r.keys).toEqual(['b', 'a', 'c', 'd']);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({ b: 1, a: 'x' });
  });

  it('单对象包成 [obj]', () => {
    const r = normalizeJsonRows({ id: 1 });
    expect(r.keys).toEqual(['id']);
    expect(r.rows).toEqual([{ id: 1 }]);
  });

  it('顶层非对象/数组 → 抛中文错误', () => {
    expect(() => normalizeJsonRows(42)).toThrow(/对象/);
    expect(() => normalizeJsonRows('str')).toThrow(/对象/);
    expect(() => normalizeJsonRows(null)).toThrow(/对象/);
  });

  it('空数组 → 抛错', () => {
    expect(() => normalizeJsonRows([])).toThrow(/为空/);
  });

  it('数组混入非对象项 → 抛错并指明位置', () => {
    expect(() => normalizeJsonRows([{ a: 1 }, 'oops'])).toThrow(/第 2 项/);
    expect(() => normalizeJsonRows([[1, 2]])).toThrow(/第 1 项/);
  });

  it('🔴 键序前缀性质：子集（peek 前 N 项）键序必须是全量键序的前缀（映射不错位的根基）', () => {
    const full = [{ a: 1, b: 2 }, { c: 3 }, { b: 4, d: 5 }, { e: 6 }];
    const all = normalizeJsonRows(full).keys;
    const head = normalizeJsonRows(full.slice(0, 2)).keys;
    expect(all.slice(0, head.length)).toEqual(head);
  });
});

describe('jsonCellText（E3）', () => {
  it('null/undefined → 空串（走 validateCellText 的 NULL 口径）', () => {
    expect(jsonCellText(null)).toBe('');
    expect(jsonCellText(undefined)).toBe('');
  });
  it('字符串原样、数字/布尔转字符串', () => {
    expect(jsonCellText('hi')).toBe('hi');
    expect(jsonCellText(12)).toBe('12');
    expect(jsonCellText(true)).toBe('true');
  });
  it('嵌套对象/数组保真为 JSON 文本', () => {
    expect(jsonCellText({ a: 1 })).toBe('{"a":1}');
    expect(jsonCellText([1, 'x'])).toBe('[1,"x"]');
  });
});

describe('filterRetryRows（E5）', () => {
  it('去重 + 升序', () => {
    expect(filterRetryRows(10, [5, 1, 5, 3])).toEqual([1, 3, 5]);
  });
  it('越界与负数忽略', () => {
    expect(filterRetryRows(3, [-1, 0, 2, 3, 99])).toEqual([0, 2]);
  });
  it('非整数忽略；非数组入参返回空', () => {
    expect(filterRetryRows(5, [1.5, Number.NaN, '2', 4])).toEqual([4]);
    expect(filterRetryRows(5, null)).toEqual([]);
    expect(filterRetryRows(5, undefined)).toEqual([]);
    expect(filterRetryRows(5, [])).toEqual([]);
  });
});

describe('buildInsertBatches 的 retryRows 选项（E5）', () => {
  const cols = [
    C({ name: 'id', dataType: 'bigint', nullable: false }),
    C({ name: 'name', dataType: 'varchar(64)', nullable: true }),
  ];
  const rows = [
    ['id', 'name'], // 表头（fileRow 1）
    ['1', 'a'], // ri 0 → fileRow 2
    ['bad', 'b'], // ri 1 → fileRow 3（id 非法）
    ['3', 'c'], // ri 2 → fileRow 4
  ];

  it('只处理指定 0 基数据行，fileRow 仍按原始行号报告', () => {
    const r = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, {
      hasHeader: true,
      retryRows: [1, 2],
    });
    expect(r.totalRows).toBe(3); // 数据行总数仍是全量口径
    expect(r.insertableRows).toBe(1); // ri 2 有效，ri 1 仍非法
    expect(r.statements[0].params).toEqual(['3', 'c']);
    expect(r.invalidRows).toHaveLength(1);
    expect(r.invalidRows[0].fileRow).toBe(3); // 原始行号，不是重跑批次内的位置
  });

  it('空数组/缺省 = 全部行', () => {
    const all = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true, retryRows: [] });
    expect(all.insertableRows).toBe(2);
    const def = buildInsertBatches('db', 't', rows, ['id', 'name'], cols, { hasHeader: true });
    expect(def.insertableRows).toBe(2);
  });

  it('json 语义（hasHeader:false）：0 基下标直接对齐数据行', () => {
    const jsonRows = [
      ['1', 'a'],
      ['bad', 'b'],
      ['3', 'c'],
    ];
    const r = buildInsertBatches('db', 't', jsonRows, ['id', 'name'], cols, {
      hasHeader: false,
      retryRows: [0, 1],
    });
    expect(r.insertableRows).toBe(1);
    expect(r.statements[0].params).toEqual(['1', 'a']);
    expect(r.invalidRows[0].fileRow).toBe(2); // 无表头：fileRow = ri + 1
  });
});

// ---------- 运行 SQL 脚本：流式语句分割（createStatementSplitter） ----------

import { createStatementSplitter, classifyScriptStatement } from './index.js';

/** 按给定块大小流式喂入，产出 [sql, 起始行] */
function splitScript(text: string, chunkSize: number, splitterFn: typeof createStatementSplitter = createStatementSplitter): [string, number][] {
  const out: [string, number][] = [];
  const sp = splitterFn((sql, line) => out.push([sql, line]));
  for (let i = 0; i < text.length; i += chunkSize) sp.push(text.slice(i, i + chunkSize));
  sp.flush();
  return out;
}

describe('createStatementSplitter', () => {
  const runtimeSplit = runtime.createStatementSplitter as typeof createStatementSplitter;

  // 🔴 漂移防线：ESM 出口与 runtime.cjs 行为一致（逐字符喂入是最严格的跨块检验）
  it('runtime.cjs 与 index.ts 逐字符喂入结果一致', () => {
    const text = "INSERT INTO t VALUES ('a;b', 1);\nUPDATE x SET y=2;\n";
    expect(splitScript(text, 1)).toEqual(splitScript(text, 1, runtimeSplit));
  });

  it('基础多语句分割；引号内分号不分割', () => {
    const text = "INSERT INTO t VALUES ('a;b', 1);\nUPDATE x SET y=2;\n";
    expect(splitScript(text, 100)).toEqual([
      ["INSERT INTO t VALUES ('a;b', 1)", 1],
      ['UPDATE x SET y=2', 2],
    ]);
    expect(splitScript(text, 1)).toEqual(splitScript(text, 100));
  });

  it('行注释（-- 与 #）与块注释内的分号不分割', () => {
    const text = '-- comment ; with semi\n# hash ; too\nSELECT 1--2; /* blk ; */ SELECT 9;';
    expect(splitScript(text, 1000)).toEqual([
      ['SELECT 1--2', 3], // 1--2 是双负号表达式，不是注释
      ['SELECT 9', 3],
    ]);
    expect(splitScript(text, 1)).toEqual(splitScript(text, 1000));
  });

  it('条件注释 /*!nnnn ...*/ 是语句内容（mysqldump 头部依赖）', () => {
    const text = '/*!40101 SET NAMES utf8 */;';
    expect(splitScript(text, 100)).toEqual([['/*!40101 SET NAMES utf8 */', 1]]);
    expect(splitScript(text, 1)).toEqual(splitScript(text, 100));
  });

  it('DELIMITER 指令改写分隔符（存储过程脚本）；行中 DELIMITER 不是指令', () => {
    const text = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;\n';
    expect(splitScript(text, 1000)).toEqual([
      ['CREATE PROCEDURE p() BEGIN SELECT 1; END', 2],
      ['SELECT 2', 4],
    ]);
    expect(splitScript(text, 1)).toEqual(splitScript(text, 1000));
    // mysql CLI 语义：DELIMITER 必须独立成行
    const mid = 'SELECT 1//DELIMITER ;\nSELECT 2;';
    expect(splitScript(mid, 5)).toEqual([
      ['SELECT 1//DELIMITER', 1],
      ['SELECT 2', 2],
    ]);
  });

  it('字符串转义：双写引号与反斜杠转义；反引号内只有双写转义', () => {
    expect(splitScript("SELECT 'x''y';", 1)).toEqual([["SELECT 'x''y'", 1]]);
    expect(splitScript("SELECT 'a\\'b;c';", 1)).toEqual([["SELECT 'a\\'b;c'", 1]]);
    expect(splitScript('SELECT `a``b` FROM `t;x`;', 4)).toEqual([['SELECT `a``b` FROM `t;x`', 1]]);
  });

  it('语句起始行号跨注释与空行仍准确；CRLF 行尾', () => {
    const text = '-- header\n\nCREATE TABLE a(\n  id INT\n);\nINSERT INTO a VALUES (1);';
    expect(splitScript(text, 7)).toEqual([
      ['CREATE TABLE a(\n  id INT\n)', 3],
      ['INSERT INTO a VALUES (1)', 6],
    ]);
    expect(splitScript('SELECT 1;\r\nSELECT 2;\r\n', 3)).toEqual([
      ['SELECT 1', 1],
      ['SELECT 2', 2],
    ]);
  });

  it('流式跨块安全：任意块大小结果一致（引号/注释/多字符分隔符）', () => {
    const text = 'DELIMITER //\r\nSELECT 1//\r\nDELIMITER ;\r\nSELECT 2;';
    for (const size of [1, 2, 3, 5, 7, 11, 1000]) {
      expect(splitScript(text, size)).toEqual([
        ['SELECT 1', 2],
        ['SELECT 2', 4],
      ]);
    }
  });

  it('残余语句（无结尾分隔符）在 flush 产出；纯空白/注释不产出', () => {
    expect(splitScript('SELECT 1', 3)).toEqual([['SELECT 1', 1]]);
    expect(splitScript(';;\n  ;\n', 5)).toEqual([]);
    expect(splitScript('-- only comment\n', 5)).toEqual([]);
  });

  it('mysqldump 风格片段端到端', () => {
    const dump = '-- MySQL dump 10.13\n/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nCREATE TABLE `t` (\n  `id` int NOT NULL\n) ENGINE=InnoDB;\nINSERT INTO `t` VALUES (1),(2);\n';
    expect(splitScript(dump, 29)).toEqual([
      ['/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */', 2],
      ['CREATE TABLE `t` (\n  `id` int NOT NULL\n) ENGINE=InnoDB', 3],
      ['INSERT INTO `t` VALUES (1),(2)', 6],
    ]);
  });
});

describe('classifyScriptStatement', () => {
  it('按首词分类；条件注释前缀剥掉再判', () => {
    expect(classifyScriptStatement('/*!40101 SET NAMES utf8 */')).toBe('session');
    expect(classifyScriptStatement('SET NAMES utf8mb4')).toBe('session');
    expect(classifyScriptStatement('USE mydb')).toBe('session');
    expect(classifyScriptStatement('SELECT 1')).toBe('session');
    expect(classifyScriptStatement('CREATE TABLE a (id INT)')).toBe('ddl');
    expect(classifyScriptStatement('DROP TABLE a')).toBe('ddl');
    expect(classifyScriptStatement('TRUNCATE TABLE a')).toBe('ddl');
    expect(classifyScriptStatement('INSERT INTO a VALUES (1)')).toBe('dml');
    expect(classifyScriptStatement('UPDATE a SET x=1')).toBe('dml');
    expect(classifyScriptStatement('DELETE FROM a')).toBe('dml');
  });

  it('DROP DATABASE 单独成类（触发第三层确认）', () => {
    expect(classifyScriptStatement('DROP DATABASE foo')).toBe('drop-db');
    expect(classifyScriptStatement('drop schema `foo`')).toBe('drop-db');
  });
});
