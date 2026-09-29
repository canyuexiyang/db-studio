import { describe, it, expect } from 'vitest';
import {
  ColumnarReader,
  TypeCode,
  columnarByteLength,
  encodeColumnar,
  inferTypeCode,
  isNumericDataType,
  materialize,
  safeToNumber,
  typeCodeName,
} from './index.js';

function roundTrip(rows: unknown[][], fields: string[]) {
  const p = encodeColumnar(rows, fields);
  return { p, reader: new ColumnarReader(p) };
}

describe('类型推断', () => {
  it('全 NULL 列 → NULL 码（不占数据 buffer）', () => {
    expect(inferTypeCode([null, null])).toBe(TypeCode.NULL);
  });

  it('纯数字 → F64', () => {
    expect(inferTypeCode([1, 2.5, null])).toBe(TypeCode.F64);
  });

  it('纯字符串 → STR', () => {
    expect(inferTypeCode(['a', null])).toBe(TypeCode.STR);
  });

  it('Date → DATE', () => {
    expect(inferTypeCode([new Date()])).toBe(TypeCode.DATE);
  });

  it('布尔 → BOOL', () => {
    expect(inferTypeCode([true, false])).toBe(TypeCode.BOOL);
  });

  it('Buffer → BIN', () => {
    expect(inferTypeCode([Buffer.from([1, 2])])).toBe(TypeCode.BIN);
  });

  it('数字与布尔混合 → F64（不丢信息）', () => {
    expect(inferTypeCode([1, true])).toBe(TypeCode.F64);
  });

  it('数字与字符串混合 → 降级 STR（保真优先于紧凑）', () => {
    expect(inferTypeCode([1, 'a'])).toBe(TypeCode.STR);
  });

  it('typeCodeName 可读', () => {
    expect(typeCodeName(TypeCode.STR)).toBe('STR');
    expect(typeCodeName(999)).toBe('UNKNOWN(999)');
  });
});

describe('编解码保真', () => {
  it('数字往返', () => {
    const { reader } = roundTrip([[1], [2.5], [null]], ['n']);
    expect(reader.decodeCell(0, 0)).toBe(1);
    expect(reader.decodeCell(1, 0)).toBe(2.5);
    expect(reader.decodeCell(2, 0)).toBe(null);
  });

  it('字符串往返含中文与 emoji', () => {
    const rows = [['张三'], ['订单'], ['🚀'], [null]];
    const { reader } = roundTrip(rows, ['name']);
    expect(reader.decodeCell(0, 0)).toBe('张三');
    expect(reader.decodeCell(1, 0)).toBe('订单');
    expect(reader.decodeCell(2, 0)).toBe('🚀');
    expect(reader.decodeCell(3, 0)).toBe(null);
  });

  it('红线：NULL 与空字符串必须严格区分（PRD §6.3.4）', () => {
    const { reader } = roundTrip([[''], [null]], ['v']);
    expect(reader.isNull(0, 0)).toBe(false);
    expect(reader.decodeCell(0, 0)).toBe('');
    expect(reader.isNull(1, 0)).toBe(true);
    expect(reader.decodeCell(1, 0)).toBe(null);
    // 二者不相等
    expect(reader.decodeCell(0, 0)).not.toBe(reader.decodeCell(1, 0));
  });

  it('BIGINT 原文以字符串保存，不丢精度（>2^53）', () => {
    const big = '9007199254740993'; // 2^53 + 1，转 Number 会变 9007199254740992
    const { reader } = roundTrip([[big]], ['id']);
    // 原样保留为字符串，没有被写成 Number
    expect(typeof reader.decodeCell(0, 0)).toBe('string');
    expect(reader.decodeCell(0, 0)).toBe(big);
    // 对照：若走数值路径就会退化成 9007199254740992，这正是要避免的
    expect(Number(big)).toBe(9007199254740992);
    expect(reader.decodeCell(0, 0)).not.toBe(String(Number(big)));
  });

  it('DATETIME(6) 微秒原文保存（dateStrings 的产物，不能被 Date 吞掉）', () => {
    const raw = '2026-09-20 15:04:05.123456';
    const { reader } = roundTrip([[raw]], ['ts']);
    expect(reader.decodeCell(0, 0)).toBe(raw);
  });

  it('JSON 大整数不被解析，保留原文', () => {
    const json = '{"id":9007199254740993}';
    const { reader } = roundTrip([[json]], ['payload']);
    expect(reader.decodeCell(0, 0)).toBe(json);
  });

  it('布尔往返', () => {
    const { reader } = roundTrip([[true], [false], [null]], ['ok']);
    expect(reader.decodeCell(0, 0)).toBe(true);
    expect(reader.decodeCell(1, 0)).toBe(false);
    expect(reader.decodeCell(2, 0)).toBe(null);
  });

  it('Date 往返为 Date 对象', () => {
    const d = new Date('2026-09-21T00:00:00.000Z');
    const { reader } = roundTrip([[d]], ['t']);
    const got = reader.decodeCell(0, 0) as Date;
    expect(got instanceof Date).toBe(true);
    expect(got.getTime()).toBe(d.getTime());
  });

  it('二进制往返且返回拷贝（写入不污染共享内存）', () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const { reader } = roundTrip([[bytes]], ['blob']);
    const got = reader.decodeCell(0, 0) as Uint8Array;
    expect([...got]).toEqual([1, 2, 3, 255]);
    got[0] = 99;
    expect([...(reader.decodeCell(0, 0) as Uint8Array)]).toEqual([1, 2, 3, 255]);
  });

  it('多列混合类型的完整往返', () => {
    const rows = [
      [1, 'a', true, null],
      [2, null, false, 3.5],
    ];
    const { reader } = roundTrip(rows, ['id', 'name', 'flag', 'score']);
    expect(reader.decodeRow(0)).toEqual([1, 'a', true, null]);
    expect(reader.decodeRow(1)).toEqual([2, null, false, 3.5]);
  });

  it('空结果集不崩', () => {
    const { p, reader } = roundTrip([], ['a', 'b']);
    expect(p.rowCount).toBe(0);
    expect(reader.decodeAll()).toEqual([]);
    expect(reader.columnCount).toBe(2);
  });

  it('越界访问返回 null，不抛异常', () => {
    const { reader } = roundTrip([[1]], ['a']);
    expect(reader.decodeCell(99, 0)).toBe(null);
    expect(reader.decodeCell(-1, 0)).toBe(null);
  });
});

describe('只解可视区（本模块存在的理由）', () => {
  it('decodeRowRange 只解请求的那些格', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i, `row-${i}`]);
    const { reader } = roundTrip(rows, ['id', 'name']);

    const before = reader.stats.cellsDecoded;
    const visible = reader.decodeRowRange(100, 130);
    expect(visible).toHaveLength(30);
    expect(visible[0]).toEqual([100, 'row-100']);
    // 只解了 30 行 × 2 列 = 60 格，没有偷偷全量解码
    expect(reader.stats.cellsDecoded - before).toBe(60);
  });

  it('反复滚动同一区域不会重复建视图（视图按列缓存）', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    const { reader } = roundTrip(rows, ['id']);
    reader.decodeRowRange(0, 40);
    const afterFirst = reader.stats.viewsCreated;
    for (let s = 0; s < 300; s += 40) reader.decodeRowRange(s, s + 40);
    expect(reader.stats.viewsCreated).toBe(afterFirst);
  });

  it('单列投影：只解指定列', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i, `n${i}`, `x${i}`]);
    const { reader } = roundTrip(rows, ['a', 'b', 'c']);
    const before = reader.stats.cellsDecoded;
    const col1 = reader.decodeRowRange(0, 10, [1]);
    expect(col1[0]).toEqual(['n0']);
    expect(reader.stats.cellsDecoded - before).toBe(10);
  });

  it('materialize 明确是全量物化（导出路径用，网格渲染不要用）', () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i]);
    const { p, reader } = roundTrip(rows, ['id']);
    const all = materialize(p);
    expect(all).toHaveLength(50);
    expect(reader.stats.cellsDecoded).toBe(0); // 新 reader，统计独立
  });

  it('bufferCounts 与实际 buffer 数一致（transfer 后能正确还原）', () => {
    const { p } = roundTrip(
      [
        [1, 'a', true, null],
        [2, 'bb', false, null],
      ],
      ['n', 's', 'b', 'z'],
    );
    expect(p.bufferCounts.reduce((a, b) => a + b, 0)).toBe(p.buffers.length);
    // NULL 列 0 个 buffer；F64/BOOL 各 2 个；STR 3 个
    expect(p.bufferCounts).toEqual([2, 3, 2, 0]);
  });
});

describe('体积诊断', () => {
  it('columnarByteLength 统计所有 buffer', () => {
    const { p } = roundTrip([
      [1, 'hello'],
      [2, 'world'],
    ], ['n', 's']);
    expect(columnarByteLength(p)).toBe(
      p.buffers.reduce((s, b) => s + b.byteLength, 0),
    );
    expect(columnarByteLength(p)).toBeGreaterThan(0);
  });

  it('全 NULL 列不占数据 buffer', () => {
    const { p } = roundTrip([[null], [null]], ['z']);
    expect(p.buffers).toHaveLength(0);
    expect(columnarByteLength(p)).toBe(0);
  });
});

describe('R10 字符串化数值的还原（真库实测暴露）', () => {
  it('R10 下 INT 也是字符串，按列定义还原为数值', () => {
    const { reader } = encodeWithTypes([['1'], ['2']], ['qty'], ['int']);
    expect(reader.typeCode(0)).toBe(TypeCode.F64);
    expect(reader.decodeCell(0, 0)).toBe(1);
    expect(reader.decodeCell(1, 0)).toBe(2);
  });

  it('BIGINT 超 2^53 即使声明为数值也保持字符串（不丢精度优先）', () => {
    const { reader } = encodeWithTypes(
      [['9007199254740993']],
      ['big_no'],
      ['bigint unsigned'],
    );
    expect(reader.decodeCell(0, 0)).toBe('9007199254740993');
    expect(typeof reader.decodeCell(0, 0)).toBe('string');
  });

  it('DECIMAL 保持字符串（避免浮点误差）', () => {
    const { reader } = encodeWithTypes([['10.00']], ['amount'], ['decimal(12,2)']);
    expect(reader.decodeCell(0, 0)).toBe('10.00');
  });

  it('bigint unsigned 带括号写法也能识别', () => {
    expect(isNumericDataType('bigint(20) unsigned')).toBe(true);
    expect(isNumericDataType('int(11)')).toBe(true);
    expect(isNumericDataType('varchar(64)')).toBe(false);
    expect(isNumericDataType('datetime(6)')).toBe(false);
  });

  it('不传列定义时按运行时类型推断（R10 下退化为字符串，符合预期）', () => {
    const { reader } = encodeWithTypes([['1'], ['2']], ['qty'], undefined);
    expect(reader.typeCode(0)).toBe(TypeCode.STR);
    expect(reader.decodeCell(0, 0)).toBe('1');
  });

  it('safeToNumber 对非规范写法返回 null（不静默失真）', () => {
    expect(safeToNumber('1.50')).toBe(null); // String(1.5) === '1.5' ≠ '1.50'
    expect(safeToNumber('007')).toBe(null);
    expect(safeToNumber('42')).toBe(42);
    expect(safeToNumber('abc')).toBe(null);
  });

  it('数值列中的 NULL 不参与还原', () => {
    const { reader } = encodeWithTypes([['1'], [null]], ['qty'], ['int']);
    expect(reader.decodeCell(0, 0)).toBe(1);
    expect(reader.decodeCell(1, 0)).toBe(null);
    expect(reader.isNull(1, 0)).toBe(true);
  });
});

function encodeWithTypes(rows: unknown[][], fields: string[], types: (string | undefined)[] | undefined) {
  const p = encodeColumnar(rows, fields, types);
  return { p, reader: new ColumnarReader(p) };
}
