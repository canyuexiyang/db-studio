import { describe, it, expect } from 'vitest';
import {
  cellToDisplay,
  serializeCopy,
  parseClipboard,
  validateCellText,
  planPasteFromText,
  toMutationInput,
  baseType,
  isNumericType,
  isTemporalType,
  enumValues,
  charMaxLength,
  DEFAULT_MAX_PASTE_ROWS,
  COPY_FORMATS,
  rowsFromSelection,
  formatNeedsTableContext,
  sqlLiteral,
} from './index.js';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';

function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
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
  };
}

describe('单元格展示', () => {
  it('NULL 与空串必须可区分', () => {
    expect(cellToDisplay(null)).toBe('NULL');
    expect(cellToDisplay('')).toBe('');
    expect(cellToDisplay(undefined)).toBe('NULL');
  });

  it('布尔显示为 1/0（MySQL 语义）', () => {
    expect(cellToDisplay(true)).toBe('1');
    expect(cellToDisplay(false)).toBe('0');
  });

  it('二进制显示为长度摘要，不把字节塞进剪贴板', () => {
    expect(cellToDisplay(new Uint8Array(48))).toBe('(二进制 48 B)');
  });

  it('日期格式化到秒', () => {
    expect(cellToDisplay(new Date('2026-09-20T15:04:05.123Z'))).toBe('2026-09-20 15:04:05');
  });
});

describe('复制序列化', () => {
  const columns = ['id', 'name', 'note'];
  const rows = [
    [1, '张三', 'a'],
    [2, '含\t制表符', 'b,c'],
    [3, null, ''],
  ];

  it('TSV：含制表符的字段被转义，可直接粘进 Excel', () => {
    const t = serializeCopy({ format: 'tsv', columns, rows });
    expect(t.split('\n')[0]).toBe('id\tname\tnote');
    expect(t.split('\n')[2]).toBe('2\t"含\t制表符"\tb,c');
  });

  it('CSV：含逗号的字段加引号', () => {
    const t = serializeCopy({ format: 'csv', columns, rows });
    expect(t.split('\n')[2]).toBe('2,含\t制表符,"b,c"');
  });

  it('引号内部翻倍', () => {
    const t = serializeCopy({ format: 'csv', columns: ['a'], rows: [['他说"你好"']] });
    expect(t.split('\n')[1]).toBe('"他说""你好"""');
  });

  it('JSON：值为 null 序列化为 null', () => {
    const t = serializeCopy({ format: 'json', columns: ['a', 'b'], rows: [[1, null]] });
    expect(JSON.parse(t)).toEqual([{ a: 1, b: null }]);
  });

  it('INSERT：带真实值（文本导出语义），标识符仍 quote', () => {
    const t = serializeCopy({ format: 'insert', columns, rows, database: 'db', table: 't' });
    expect(t).toBe(
      "INSERT INTO `db`.`t` (`id`, `name`, `note`) VALUES (1, '张三', 'a');\n" +
        "INSERT INTO `db`.`t` (`id`, `name`, `note`) VALUES (2, '含\t制表符', 'b,c');\n" +
        'INSERT INTO `db`.`t` (`id`, `name`, `note`) VALUES (3, NULL, \'\');',
    );
  });

  it('INSERT：缺表名 → 空串（静默降级）', () => {
    expect(serializeCopy({ format: 'insert', columns, rows, table: '' })).toBe('');
  });

  it('UPDATE：逐行带值，定位列进 WHERE、SET 排除定位列', () => {
    const t = serializeCopy({
      format: 'update',
      columns: ['id', 'name'],
      rows: [[1, 'x'], [2, "O'Brien"]],
      database: 'db',
      table: 't',
      locateColumns: ['id'],
    });
    expect(t).toBe(
      "UPDATE `db`.`t` SET `name` = 'x' WHERE `id` = 1;\n" +
        "UPDATE `db`.`t` SET `name` = 'O\\'Brien' WHERE `id` = 2;",
    );
  });

  it('UPDATE：定位列不在复制范围内 → 空串（不产出半截 WHERE）', () => {
    expect(
      serializeCopy({
        format: 'update',
        columns: ['name'],
        rows: [['x']],
        database: 'db',
        table: 't',
        locateColumns: ['id'],
      }),
    ).toBe('');
  });

  it('UPDATE 缺定位列 → 返回空串（不能生成无 WHERE 的 UPDATE）', () => {
    expect(serializeCopy({ format: 'update', columns: ['name'], rows: [['x']], database: 'db', table: 't', locateColumns: [] })).toBe('');
  });

  it('行长度不足按 NULL 补齐，不抛异常', () => {
    const t = serializeCopy({ format: 'tsv', columns: ['a', 'b', 'c'], rows: [[1]] });
    expect(t.split('\n')[1]).toBe('1\tNULL\tNULL');
  });

  it('六种格式齐备（A17 加入 markdown）', () => {
    expect(COPY_FORMATS).toEqual(['tsv', 'csv', 'json', 'markdown', 'insert', 'update']);
  });
});

describe('sqlLiteral（复制为 SQL 的值字面量）', () => {
  it('NULL 与空串严格区分（红线 6）', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral('')).toBe(`''`);
  });

  it('BIGINT 原文（字符串形态）带引号导出，MySQL 端精确还原不经 Float64', () => {
    // > 2^53 的整数以字符串到达（codec 保真），带引号导出后隐式转换回精确值
    expect(sqlLiteral('9007199254740993')).toBe(`'9007199254740993'`);
    expect(sqlLiteral(-123)).toBe('-123');
  });

  it('字符串转义：单引号、反斜杠、换行、CR、NUL、Ctrl-Z', () => {
    expect(sqlLiteral("O'Brien")).toBe(`'O\\'Brien'`);
    expect(sqlLiteral('反斜杠\\后续')).toBe(`'反斜杠\\\\后续'`);
    expect(sqlLiteral('a\nb')).toBe(`'a\\nb'`);
    expect(sqlLiteral('a\rb')).toBe(`'a\\rb'`);
    expect(sqlLiteral('a\0b')).toBe(`'a\\0b'`);
    expect(sqlLiteral('a\x1ab')).toBe(`'a\\Zb'`);
  });

  it('数值 / 布尔 / 非有限数', () => {
    expect(sqlLiteral(1.5)).toBe('1.5');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
    expect(sqlLiteral(NaN)).toBe('NULL');
    expect(sqlLiteral(Infinity)).toBe('NULL');
  });

  it('Date → 带毫秒的日期时间字面量', () => {
    expect(sqlLiteral(new Date('2026-09-20T15:04:05.123Z'))).toBe(`'2026-09-20 15:04:05.123'`);
  });

  it('二进制 → X\'hex\'；空二进制 → _binary\'\'（X\'\' 是语法错误）', () => {
    expect(sqlLiteral(new Uint8Array([0xde, 0xad, 0x01]))).toBe(`X'dead01'`);
    expect(sqlLiteral(new Uint8Array(0))).toBe(`_binary''`);
  });
});

describe('rowsFromSelection：行勾选优先', () => {
  const colIdx = [0, 1, 2];
  const valueAt = (r: number, c: number) => r * 10 + c;

  it('有行勾选时优先于矩形选区，整行 × 全部参与列', () => {
    const res = rowsFromSelection({
      ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }],
      focusRow: 0,
      selectedRows: [3, 1],
      rowCount: 10,
      colCount: 3,
      columnIndexes: colIdx,
      valueAt,
    });
    expect(res.rows).toEqual([
      [10, 11, 12],
      [30, 31, 32],
    ]);
    expect(res.columnIndexes).toEqual([0, 1, 2]);
  });

  it('行勾选去重升序、越界钳制', () => {
    const res = rowsFromSelection({
      ranges: [],
      focusRow: 0,
      selectedRows: [5, 1, 5, 99, -1],
      rowCount: 10,
      colCount: 3,
      columnIndexes: colIdx,
      valueAt,
    });
    expect(res.rows).toEqual([
      [10, 11, 12],
      [50, 51, 52],
    ]);
  });

  it('行勾选同样受格数上限约束（截断标记）', () => {
    const res = rowsFromSelection(
      {
        ranges: [],
        focusRow: 0,
        selectedRows: [0, 1, 2],
        rowCount: 10,
        colCount: 3,
        columnIndexes: colIdx,
        valueAt,
      },
      5, // limit: 5 格 → 第 2 行截断
    );
    expect(res.rows.length).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it('无行勾选时维持既有语义（矩形选区 / 聚焦行退化）', () => {
    const range = rowsFromSelection({
      ranges: [{ r0: 1, c0: 1, r1: 2, c1: 1 }],
      focusRow: 0,
      rowCount: 10,
      colCount: 3,
      columnIndexes: colIdx,
      valueAt,
    });
    expect(range.rows).toEqual([[11], [21]]);
    const focus = rowsFromSelection({
      ranges: [],
      focusRow: 4,
      rowCount: 10,
      colCount: 3,
      columnIndexes: colIdx,
      valueAt,
    });
    expect(focus.rows).toEqual([[40, 41, 42]]);
  });
});

describe('剪贴板解析', () => {
  it('TSV（Excel 复制的默认格式）', () => {
    const p = parseClipboard('1\t张三\n2\t李四\n');
    expect(p.source).toBe('tsv');
    expect(p.rows).toEqual([
      ['1', '张三'],
      ['2', '李四'],
    ]);
    expect(p.rowCount).toBe(2);
    expect(p.colCount).toBe(2);
  });

  it('CSV（含引号包裹的逗号与换行）', () => {
    const p = parseClipboard('a,"b,c"\nd,"line1\nline2"\n');
    expect(p.source).toBe('csv');
    expect(p.rows[0]).toEqual(['a', 'b,c']);
    expect(p.rows[1]).toEqual(['d', 'line1\nline2']);
  });

  it('CSV 里连续两个引号表示一个引号', () => {
    const p = parseClipboard('"他说""你好"""\n');
    expect(p.rows[0]).toEqual(['他说"你好"']);
  });

  it('HTML table 优先（Excel/Numbers 同时提供 HTML 与 TSV）', () => {
    const html =
      '<table><tr><td>1</td><td>张三</td></tr><tr><td>2</td><td>李四</td></tr></table>';
    const p = parseClipboard(html);
    expect(p.source).toBe('html');
    expect(p.rows).toEqual([
      ['1', '张三'],
      ['2', '李四'],
    ]);
  });

  it('HTML 实体被还原，标签被剥离', () => {
    const p = parseClipboard('<tr><td>a &amp; b</td><td>&lt;tag&gt;</td></tr>');
    expect(p.rows[0]).toEqual(['a & b', '<tag>']);
  });

  it('行长度不齐时按最宽行补齐空串', () => {
    const p = parseClipboard('1\ta\tb\n2\n');
    expect(p.colCount).toBe(3);
    expect(p.rows[1]).toEqual(['2', '', '']);
  });

  it('空剪贴板 / 纯空白 → 空表，不抛异常', () => {
    expect(parseClipboard('').rowCount).toBe(0);
    expect(parseClipboard('\n\n').rowCount).toBe(0);
    expect(parseClipboard('   ').colCount).toBe(1); // 单列纯空格，是合法的一格
  });

  it('CRLF 统一为 LF', () => {
    const p = parseClipboard('1\ta\r\n2\tb\r\n');
    expect(p.rowCount).toBe(2);
    expect(p.rows[1]).toEqual(['2', 'b']);
  });
});

describe('类型校验', () => {
  it('数值列拒绝非数值', () => {
    const c = col('n', { dataType: 'int' });
    expect(validateCellText('123', c)).toBeNull();
    expect(validateCellText('abc', c)).toMatch(/不是合法数值/);
    expect(validateCellText('1.5', c)).toMatch(/不接受小数/);
    expect(validateCellText('-7', c)).toBeNull();
  });

  it('DECIMAL 允许小数', () => {
    const c = col('amt', { dataType: 'decimal(12,2)' });
    expect(validateCellText('12.34', c)).toBeNull();
    expect(validateCellText('x', c)).toMatch(/不是合法数值/);
  });

  it('日期列拒绝不存在的日期（2026-02-30）', () => {
    const c = col('d', { dataType: 'datetime' });
    expect(validateCellText('2026-09-20 15:04:05', c)).toBeNull();
    expect(validateCellText('2026-02-30 00:00:00', c)).toMatch(/不存在/);
    expect(validateCellText('昨天', c)).toMatch(/不是合法日期时间/);
  });

  it('日期列允许 NOW()', () => {
    expect(validateCellText('NOW()', col('d', { dataType: 'timestamp' }))).toBeNull();
  });

  it('NOT NULL 列拒绝空值与 NULL 字面量', () => {
    const c = col('name', { dataType: 'varchar(64)', nullable: false });
    expect(validateCellText('张三', c)).toBeNull();
    expect(validateCellText('', c)).toMatch(/不允许为 NULL/);
    expect(validateCellText('NULL', c)).toMatch(/不允许为 NULL/);
  });

  it('可空列接受 NULL 字面量', () => {
    const c = col('name');
    expect(validateCellText('NULL', c)).toBeNull();
    expect(validateCellText('\\N', c)).toBeNull();
  });

  it('varchar 超长被拦', () => {
    const c = col('name', { dataType: 'varchar(4)' });
    expect(validateCellText('abcd', c)).toBeNull();
    expect(validateCellText('abcde', c)).toMatch(/超长/);
  });

  it('ENUM 只接受候选值', () => {
    const c = col('status', { dataType: "enum('paid','unpaid')" });
    expect(validateCellText('paid', c)).toBeNull();
    expect(validateCellText('done', c)).toMatch(/可选值/);
  });

  it('类型识别辅助', () => {
    expect(baseType('varchar(64)')).toBe('varchar');
    expect(isNumericType('bigint')).toBe(true);
    expect(isNumericType('int')).toBe(true);
    expect(isNumericType('varchar(10)')).toBe(false);
    expect(isTemporalType('datetime')).toBe(true);
    expect(enumValues("enum('a','b')")).toEqual(['a', 'b']);
    expect(charMaxLength('varchar(64)')).toBe(64);
    expect(charMaxLength('text')).toBeNull();
  });
});

describe('粘贴计划', () => {
  const columns = [col('id', { dataType: 'int', isPrimaryKey: true }), col('name', { dataType: 'varchar(64)' }), col('age', { dataType: 'int' })];
  const target = { startRow: 0, startCol: 0, loadedRows: 100, columns, editable: true };

  it('正常粘贴：全列对齐，产出脏单元格', () => {
    const plan = planPasteFromText('1\t张三\t20\n2\t李四\t30\n', target);
    expect(plan.rejected).toBeNull();
    expect(plan.cells).toHaveLength(6);
    expect(plan.rows).toBe(2);
    expect(plan.cols).toBe(3);
    expect(plan.issues).toHaveLength(0);
    expect(plan.appendedRows).toBe(0);
  });

  it('从中间列起粘贴：按当前列顺序对齐', () => {
    const plan = planPasteFromText('张三\n李四\n', { ...target, startCol: 1 });
    expect(plan.cells.every((c) => c.column === 'name')).toBe(true);
    expect(plan.cells[1].value).toBe('李四');
  });

  it('列数超出剩余列 → 超出部分丢弃并提示，绝不新增列', () => {
    // 从 name 起只剩 name/age 两列；用 20 是为了让 age 这一列通过数值校验
    const plan = planPasteFromText('张三\t20\t李四\t30\n', { ...target, startCol: 1 });
    expect(plan.droppedColumns).toBe(2);
    expect(plan.dropNotice).toMatch(/已丢弃/);
    expect(plan.cells.map((c) => c.column)).toEqual(['name', 'age']);
    expect(plan.cols).toBe(2);
  });

  it('行尾之外 → 追加新行', () => {
    // 第 99 行仍是已加载行（下标 0..99 共 100 行）
    const plan = planPasteFromText('1\ta\t1\n', { ...target, startRow: 99, loadedRows: 100 });
    expect(plan.appendedRows).toBe(0);
    expect(plan.cells[0].isNewRow).toBe(false);

    // 两行：99 是已有行，100 是追加行
    const plan2 = planPasteFromText('1\ta\t1\n2\tb\t2\n', { ...target, startRow: 99, loadedRows: 100 });
    expect(plan2.appendedRows).toBe(1);
    expect(plan2.cells.some((c) => c.isNewRow && c.row === 100)).toBe(true);
  });

  it('类型不匹配的格子被标出且不进入脏单元格', () => {
    const plan = planPasteFromText('1\t张三\tabc\n', target);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0].column).toBe('age');
    expect(plan.cells.some((c) => c.column === 'age')).toBe(false);
    expect(plan.summary).toMatch(/1 处类型不匹配/);
  });

  it('只读表（无主键/唯一键）整体拒绝 —— 红线', () => {
    const plan = planPasteFromText('1\ta\t1\n', { ...target, editable: false });
    expect(plan.rejected).toMatch(/只读/);
    expect(plan.cells).toHaveLength(0);
  });

  it('超过单次上限（默认 1000 行）整体拒绝', () => {
    const many = Array.from({ length: DEFAULT_MAX_PASTE_ROWS + 1 }, (_, i) => `${i}\ta\t1`).join('\n');
    const plan = planPasteFromText(many, target);
    expect(plan.rejected).toMatch(/上限 1000 行/);
  });

  it('空剪贴板被拒', () => {
    expect(planPasteFromText('', target).rejected).toBe('剪贴板为空');
  });

  it('起始列越界被拒', () => {
    const plan = planPasteFromText('a\n', { ...target, startCol: 99 });
    expect(plan.rejected).toMatch(/起始列超出/);
  });

  it('NULL 字面量写为 null', () => {
    const plan = planPasteFromText('1\tNULL\tNULL\n', target);
    expect(plan.cells.filter((c) => c.value === null)).toHaveLength(2);
  });

  it('汇总文案含行列数与新增行数', () => {
    const plan = planPasteFromText('1\ta\t1\n2\tb\t2\n', { ...target, startRow: 99, loadedRows: 100 });
    expect(plan.summary).toMatch(/将写入 2 行 × 3 列/);
    expect(plan.summary).toMatch(/1 行为新追加/);
  });

  it('起始行越界（远大于已加载行）整体被拒，不凭空造出行洞', () => {
    const plan = planPasteFromText('1\ta\t1\n', { ...target, startRow: 5000, loadedRows: 100 });
    expect(plan.rejected).toMatch(/起始行/);
  });
});

describe('粘贴 → mutation 桥接', () => {
  const columns = [col('id', { dataType: 'int', isPrimaryKey: true }), col('name', { dataType: 'varchar(64)' })];
  const target = { startRow: 0, startCol: 0, loadedRows: 2, columns, editable: true };

  it('已有行的改动按行分组，便于合并成单条 UPDATE', () => {
    const plan = planPasteFromText('a\nb\n', { ...target, startCol: 1 });
    const input = toMutationInput(plan);
    expect(input.updates).toHaveLength(2);
    expect(input.updates[0].edits[0]).toMatchObject({ column: 'name', newValue: 'a' });
    expect(input.inserts).toHaveLength(0);
  });

  it('追加行走 INSERT，主键不出现在 values 里（由服务端生成）', () => {
    const plan = planPasteFromText('张三\n', { ...target, startRow: 2, startCol: 1, loadedRows: 2 });
    const input = toMutationInput(plan);
    expect(input.inserts).toHaveLength(1);
    expect(input.inserts[0].values).toEqual({ name: '张三' });
    expect(input.updates).toHaveLength(0);
  });

  it('校验失败的格子不进入写语句', () => {
    const plan = planPasteFromText('123\nnot-a-number\n', {
      ...target,
      startCol: 1,
      columns: [col('id', { isPrimaryKey: true }), col('age', { dataType: 'int' })],
    });
    const input = toMutationInput(plan);
    // 两行都从 startCol=1（age）起，'123' 合法，'not-a-number' 被拦
    expect(input.updates).toHaveLength(1);
    expect(input.updates[0].edits[0].newValue).toBe('123');
  });
});

describe('Markdown 复制（A17）', () => {
  it('表头 + 分隔行 + 值行，NULL 输出 \\N', () => {
    const md = serializeCopy({ format: 'markdown', columns: ['id', 'name'], rows: [[1, '张三'], [2, null]] });
    const lines = md.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('| id | name |');
    expect(lines[1]).toBe('| --- | --- |');
    expect(lines[2]).toBe('| 1 | 张三 |');
    expect(lines[3]).toBe('| 2 | \\N |');
  });

  it('竖线转义 \\|、换行转 <br>（与 core-export 的 toMarkdownTable 同一套规则，各自独立实现）', () => {
    const md = serializeCopy({ format: 'markdown', columns: ['a|b'], rows: [['x\ny']] });
    expect(md).toBe('| a\\|b |\n| --- |\n| x<br>y |');
  });

  it('CRLF 也转 <br>', () => {
    const md = serializeCopy({ format: 'markdown', columns: ['v'], rows: [['a\r\nb']] });
    expect(md.split('\n')[2]).toBe('| a<br>b |');
  });

  it('Date 用 ISO 格式（对齐 toMarkdownTable，与 TSV 的秒级展示刻意不同）', () => {
    const md = serializeCopy({ format: 'markdown', columns: ['t'], rows: [[new Date(Date.UTC(2026, 0, 2, 3, 4, 5))]] });
    expect(md).toContain('2026-01-02T03:04:05');
  });

  it('二进制显示为长度摘要，不产出逗号数字垃圾', () => {
    const md = serializeCopy({ format: 'markdown', columns: ['blob'], rows: [[new Uint8Array(4)]] });
    expect(md.split('\n')[2]).toBe('| (二进制 4 B) |');
  });

  it('INSERT/UPDATE 缺表名 → 空串而不是抛错（网格无表上下文时静默降级）', () => {
    expect(serializeCopy({ format: 'insert', columns: ['id'], rows: [[1]] })).toBe('');
    expect(serializeCopy({ format: 'update', columns: ['id'], rows: [[1]] })).toBe('');
    expect(formatNeedsTableContext('insert')).toBe(true);
    expect(formatNeedsTableContext('tsv')).toBe(false);
  });

  it('INSERT 带库名与表名时用限定名', () => {
    const sql = serializeCopy({ format: 'insert', database: 'shop', table: 'orders', columns: ['id'], rows: [[1]] });
    expect(sql).toContain('`shop`.`orders`');
  });
});

describe('选中区 → 行（rowsFromSelection，⌘C 数据源 A17）', () => {
  /** 3×3 网格，值 = `${row},${col}`，便于断言对位 */
  function grid() {
    return {
      rowCount: 3,
      colCount: 3,
      columnIndexes: [0, 1, 2],
      valueAt: (r: number, c: number) => `${r},${c}`,
    };
  }

  it('矩形选区按块解码，列与每行对齐', () => {
    const res = rowsFromSelection({ ...grid(), ranges: [{ r0: 0, c0: 1, r1: 1, c1: 2 }], focusRow: 0 });
    expect(res.rows).toEqual([
      ['0,1', '0,2'],
      ['1,1', '1,2'],
    ]);
    expect(res.columnIndexes).toEqual([1, 2]);
    expect(res.cells).toBe(4);
    expect(res.truncated).toBe(false);
  });

  it('无选区退化为复制聚焦行（全部参与列）', () => {
    const res = rowsFromSelection({ ...grid(), ranges: [], focusRow: 2 });
    expect(res.rows).toEqual([['2,0', '2,1', '2,2']]);
    expect(res.cells).toBe(3);
  });

  it('隐藏列不参与复制（用户看不见的数据不该进剪贴板）', () => {
    const res = rowsFromSelection({
      ...grid(),
      columnIndexes: [0, 2],
      ranges: [{ r0: 0, c0: 0, r1: 0, c1: 2 }],
      focusRow: 0,
    });
    expect(res.columnIndexes).toEqual([0, 2]);
    expect(res.rows).toEqual([['0,0', '0,2']]);
  });

  it('多重选区取最近一块（矩形语义，与 Excel 复制最后一块一致）', () => {
    const res = rowsFromSelection({
      ...grid(),
      ranges: [
        { r0: 0, c0: 0, r1: 0, c1: 0 },
        { r0: 2, c0: 2, r1: 2, c1: 2 },
      ],
      focusRow: 0,
    });
    expect(res.rows).toEqual([['2,2']]);
  });

  it('超上限截断并如实标记', () => {
    const res = rowsFromSelection({ ...grid(), ranges: [{ r0: 0, c0: 0, r1: 2, c1: 2 }], focusRow: 0 }, 4);
    expect(res.cells).toBe(4);
    expect(res.truncated).toBe(true);
  });

  it('选区越界被钳制到网格边界，不抛异常', () => {
    const res = rowsFromSelection({ ...grid(), ranges: [{ r0: -5, c0: 0, r1: 99, c1: 9 }], focusRow: 0 });
    expect(res.rows).toHaveLength(3);
    expect(res.columnIndexes).toEqual([0, 1, 2]);
  });

  it('空网格 + 无选区 → 空结果', () => {
    const res = rowsFromSelection({ ...grid(), rowCount: 0, ranges: [], focusRow: 2 });
    expect(res.rows).toEqual([]);
  });

  it('选区列与参与列无交集 → 空结果（如全选后仅隐藏列可见的极端情况）', () => {
    const res = rowsFromSelection({
      ...grid(),
      columnIndexes: [1],
      ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }],
      focusRow: 0,
    });
    expect(res.rows).toEqual([]);
  });
});
