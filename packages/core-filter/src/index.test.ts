import { describe, it, expect } from 'vitest';
import {
  operatorsForColumn,
  suggestMultiSelect,
  enumOptions,
  emptyFilter,
  isFilterEmpty,
  conditionCount,
  nextId,
  parseListInput,
  isConditionComplete,
  textToParam,
  buildWhere,
  filterByCellValue,
  quickFiltersForColumn,
  toOpenTableFilter,
  filterableColumns,
  needsValue,
  isRangeOperator,
  isListOperator,
  OPERATOR_LABELS,
} from './index.js';
import type { ColumnMeta, TableMeta } from '@dbstudio/core-schema-cache';

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

function cond(over: Partial<Parameters<typeof buildWhere>[0]['groups'][0]['conditions'][0]> = {}) {
  return { id: 'c1', column: 'status', operator: 'eq' as const, value: 'paid', ...over };
}

function model(conditions: ReturnType<typeof cond>[], groupOver: Partial<{ id: string; logic: 'AND' | 'OR'; join: 'AND' | 'OR' }> = {}) {
  return { groups: [{ id: 'g1', logic: 'AND' as const, conditions, ...groupOver }] };
}

describe('操作符按字段类型动态变化', () => {
  it('数值字段不给"包含"', () => {
    const ops = operatorsForColumn(col('amount', { dataType: 'decimal(12,2)' }));
    expect(ops).not.toContain('contains');
    expect(ops).toContain('gt');
    expect(ops).toContain('between');
  });

  it('文本字段给包含/开头/结尾/正则', () => {
    const ops = operatorsForColumn(col('name', { dataType: 'varchar(64)' }));
    for (const o of ['contains', 'notContains', 'startsWith', 'endsWith', 'regexp']) {
      expect(ops).toContain(o);
    }
  });

  it('日期字段给范围比较', () => {
    const ops = operatorsForColumn(col('created_at', { dataType: 'datetime' }));
    expect(ops).toContain('gte');
    expect(ops).not.toContain('contains');
  });

  it('BLOB/二进制字段只给 NULL 判定', () => {
    expect(operatorsForColumn(col('data', { dataType: 'blob' }))).toEqual(['isNull', 'isNotNull']);
    expect(operatorsForColumn(col('g', { dataType: 'geometry' }))).toEqual(['isNull', 'isNotNull']);
  });

  it('ENUM 走文本分支（可做包含匹配）', () => {
    expect(operatorsForColumn(col('s', { dataType: "enum('a','b')" }))).toContain('contains');
  });

  it('未知类型给最保守集合', () => {
    expect(operatorsForColumn(col('x', { dataType: 'weird_type' }))).toEqual(['eq', 'ne', 'isNull', 'isNotNull']);
  });

  it('ENUM/SET 建议下拉多选并给出候选值', () => {
    expect(suggestMultiSelect(col('s', { dataType: "enum('a','b')" }))).toBe(true);
    expect(suggestMultiSelect(col('v', { dataType: 'varchar(10)' }))).toBe(false);
    expect(enumOptions(col('s', { dataType: "enum('paid','unpaid')" }))).toEqual(['paid', 'unpaid']);
    expect(enumOptions(col('v', { dataType: 'varchar(10)' }))).toEqual([]);
  });
});

describe('条件模型', () => {
  it('空模型有一行待填条件', () => {
    const m = emptyFilter();
    expect(conditionCount(m)).toBe(1);
    expect(isFilterEmpty(m)).toBe(false);
  });

  it('无条件的模型视为空', () => {
    expect(isFilterEmpty({ groups: [{ id: 'g', logic: 'AND', conditions: [] }] })).toBe(true);
    expect(isFilterEmpty({ groups: [] })).toBe(true);
  });

  it('nextId 不撞已有 id', () => {
    expect(nextId('c', ['c1', 'c2'])).toBe('c3');
    // 有空洞时补最小可用 id，而不是按长度 +1（那会永远跳过洞）
    expect(nextId('c', ['c1', 'c3'])).toBe('c2');
    expect(nextId('c', [])).toBe('c1');
  });

  it('列表输入按逗号与换行拆分', () => {
    expect(parseListInput('a, b\nc,,')).toEqual(['a', 'b', 'c']);
    expect(parseListInput('')).toEqual([]);
  });

  it('完整性判定：为空不需要值，between 需要两个', () => {
    expect(isConditionComplete(cond({ operator: 'isNull' }))).toBe(true);
    // 空串对"等于"有意义（查空串），算已填
    expect(isConditionComplete(cond({ operator: 'eq', value: '' }))).toBe(true);
    expect(isConditionComplete(cond({ operator: 'between', value: '1', value2: '' }))).toBe(false);
    expect(isConditionComplete(cond({ operator: 'in', values: [] }))).toBe(false);
    expect(isConditionComplete(cond({ column: '' }))).toBe(false);
  });

  it('NULL 字面量转为参数 null', () => {
    expect(textToParam('NULL')).toBeNull();
    expect(textToParam('\\N')).toBeNull();
    expect(textToParam('abc')).toBe('abc');
  });

  it('操作符分类辅助', () => {
    expect(needsValue('isNull')).toBe(false);
    expect(needsValue('eq')).toBe(true);
    expect(isRangeOperator('between')).toBe(true);
    expect(isListOperator('in')).toBe(true);
    expect(OPERATOR_LABELS.eq).toBe('等于');
  });
});

describe('WHERE 生成', () => {
  it('单条件：不套多余括号', () => {
    const b = buildWhere(model([cond()]));
    expect(b.sql).toBe('`status` = ?');
    expect(b.params).toEqual(['paid']);
    expect(b.preview).toBe("WHERE `status` = 'paid'");
  });

  it('多条件 AND：加括号', () => {
    const b = buildWhere(
      model([
        cond({ id: 'c1', column: 'status', operator: 'eq', value: 'paid' }),
        cond({ id: 'c2', column: 'amount', operator: 'gt', value: '100', logic: 'AND' }),
      ]),
    );
    expect(b.sql).toBe('(`status` = ? AND `amount` > ?)');
    expect(b.params).toEqual(['paid', '100']);
  });

  it('组内 OR', () => {
    const b = buildWhere(
      model(
        [
          cond({ id: 'c1', column: 'status', operator: 'eq', value: 'paid' }),
          cond({ id: 'c2', column: 'status', operator: 'eq', value: 'unpaid', logic: 'OR' }),
        ],
        { logic: 'OR' },
      ),
    );
    expect(b.sql).toBe('(`status` = ? OR `status` = ?)');
  });

  it('多分组：一层括号，组间用 join 连接', () => {
    const b = buildWhere({
      groups: [
        {
          id: 'g1',
          logic: 'AND',
          conditions: [
            cond({ id: 'c1', column: 'status', operator: 'eq', value: 'paid' }),
            cond({ id: 'c2', column: 'amount', operator: 'gt', value: '100', logic: 'AND' }),
          ],
        },
        {
          id: 'g2',
          logic: 'OR',
          join: 'OR',
          conditions: [
            cond({ id: 'c3', column: 'channel', operator: 'eq', value: 'web' }),
            cond({ id: 'c4', column: 'channel', operator: 'eq', value: 'app', logic: 'OR' }),
          ],
        },
      ],
    });
    expect(b.sql).toBe('(`status` = ? AND `amount` > ?) OR (`channel` = ? OR `channel` = ?)');
    expect(b.params).toEqual(['paid', '100', 'web', 'app']);
  });

  it('LIKE 系列把 % 拼进参数而非拼进 SQL', () => {
    expect(buildWhere(model([cond({ operator: 'contains', value: 'abc' })])).params).toEqual(['%abc%']);
    expect(buildWhere(model([cond({ operator: 'startsWith', value: 'abc' })])).params).toEqual(['abc%']);
    expect(buildWhere(model([cond({ operator: 'endsWith', value: 'abc' })])).params).toEqual(['%abc']);
    expect(buildWhere(model([cond({ operator: 'notContains', value: 'abc' })])).sql).toBe('`status` NOT LIKE ?');
  });

  it('BETWEEN 用两个参数', () => {
    const b = buildWhere(model([cond({ operator: 'between', value: '10', value2: '20' })]));
    expect(b.sql).toBe('`status` BETWEEN ? AND ?');
    expect(b.params).toEqual(['10', '20']);
  });

  it('IN 按候选值数量生成占位符', () => {
    const b = buildWhere(model([cond({ operator: 'in', values: ['a', 'b', 'c'] })]));
    expect(b.sql).toBe('`status` IN (?, ?, ?)');
    expect(b.params).toEqual(['a', 'b', 'c']);
  });

  it('IN 无候选值 → 不生成条件（绝不产出 IN ()）', () => {
    const b = buildWhere(model([cond({ operator: 'in', values: [] })]));
    expect(b.sql).toBe('');
    expect(b.params).toEqual([]);
  });

  it('IS NULL / IS NOT NULL 不带参数', () => {
    expect(buildWhere(model([cond({ operator: 'isNull' })])).sql).toBe('`status` IS NULL');
    expect(buildWhere(model([cond({ operator: 'isNotNull' })])).params).toEqual([]);
  });

  it('NULL 字面量变成参数 null，SQL 仍是 = ?（MySQL 需要 IS NULL 的场合由操作符决定）', () => {
    const b = buildWhere(model([cond({ operator: 'eq', value: 'NULL' })]));
    expect(b.params).toEqual([null]);
    expect(b.preview).toBe('WHERE `status` = NULL');
  });

  it('不完整的条件被静默跳过（用户边填边看）', () => {
    const b = buildWhere(
      model([
        cond({ id: 'c1', column: 'status', operator: 'eq', value: 'paid' }),
        cond({ id: 'c2', column: '', operator: 'eq', value: 'x', logic: 'AND' }),
        cond({ id: 'c3', column: 'amount', operator: 'between', value: '', value2: '', logic: 'AND' }),
      ]),
    );
    expect(b.sql).toBe('`status` = ?');
    expect(b.params).toEqual(['paid']);
  });

  it('空模型 → 空 WHERE，不产出 "WHERE " 这种半截串', () => {
    const b = buildWhere({ groups: [] });
    expect(b.sql).toBe('');
    expect(b.preview).toBe('');
  });

  it('注入面：值里的引号与分号只做参数，不进 SQL 原文', () => {
    const evil = "x'; DROP TABLE t; --";
    const b = buildWhere(model([cond({ value: evil })]));
    expect(b.sql).toBe('`status` = ?');
    expect(b.params).toEqual([evil]);
    expect(b.sql).not.toContain('DROP');
  });

  it('字段名走 quoteIdentifier，反引号被转义', () => {
    const b = buildWhere(model([cond({ column: 'we`ird' })]));
    expect(b.sql).toBe('`we``ird` = ?');
  });

  it('预览里的单引号翻倍（可直接展示给用户）', () => {
    const b = buildWhere(model([cond({ value: "O'Brien" })]));
    expect(b.preview).toBe("WHERE `status` = 'O''Brien'");
  });
});

describe('快捷筛选', () => {
  it('按单元格值筛选：NULL 走 isNull', () => {
    expect(filterByCellValue('status', null)).toMatchObject({ column: 'status', operator: 'isNull' });
    expect(filterByCellValue('status', 'paid')).toMatchObject({ column: 'status', operator: 'eq', value: 'paid' });
    expect(filterByCellValue('n', 0)).toMatchObject({ operator: 'eq', value: '0' });
  });

  it('列头漏斗只给常用条件', () => {
    expect(quickFiltersForColumn(col('name', { dataType: 'varchar(10)' }))).toEqual(['eq', 'contains', 'isNull', 'isNotNull']);
    // 数值字段没有 contains
    expect(quickFiltersForColumn(col('n', { dataType: 'int' }))).toEqual(['eq', 'isNull', 'isNotNull']);
  });

  it('toOpenTableFilter：无有效条件返回 null', () => {
    expect(toOpenTableFilter({ groups: [] })).toBeNull();
    expect(toOpenTableFilter(model([cond()]))).toEqual({ where: '`status` = ?', params: ['paid'] });
  });

  it('filterableColumns 排除二进制列', () => {
    const t: TableMeta = {
      name: 't',
      kind: 'table',
      comment: null,
      estimatedRows: 10,
      engine: 'InnoDB',
      collation: null,
      columns: [col('a'), col('b', { dataType: 'blob' })],
    };
    expect(filterableColumns(t).map((c) => c.name)).toEqual(['a']);
  });
});
