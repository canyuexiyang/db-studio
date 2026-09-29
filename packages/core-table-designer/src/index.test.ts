import { describe, it, expect } from 'vitest';
import {
  newTableDesign,
  emptyColumn,
  emptyIndex,
  emptyForeignKey,
  validateDesign,
  buildCreateTable,
  buildAlterStatements,
  designFromTableMeta,
  parseDataType,
  typeSupportsLength,
  typeSupportsScale,
  type TableDesign,
  type DesignColumn,
} from './index.js';

const col = (over: Partial<DesignColumn> = {}): DesignColumn => ({ ...emptyColumn(), ...over });

describe('newTableDesign', () => {
  it('预置 id 主键列', () => {
    const d = newTableDesign('t1');
    expect(d.columns).toHaveLength(1);
    expect(d.columns[0].name).toBe('id');
    expect(d.columns[0].isPrimaryKey).toBe(true);
    expect(d.columns[0].autoIncrement).toBe(true);
    expect(d.columns[0].unsigned).toBe(true);
    expect(d.tableName).toBe('t1');
  });
});

describe('validateDesign', () => {
  it('空表名校验', () => {
    const d = newTableDesign('');
    const issues = validateDesign(d);
    expect(issues.some((i) => i.field === 'tableName' && i.level === 'error')).toBe(true);
  });

  it('非法表名字符', () => {
    const d = newTableDesign('1-bad name');
    expect(validateDesign(d).some((i) => i.field === 'tableName')).toBe(true);
  });

  it('字段重名校验', () => {
    const d = newTableDesign('t');
    d.columns.push(col({ name: 'id' }));
    expect(validateDesign(d).some((i) => i.message.includes('重复'))).toBe(true);
  });

  it('主键不能 NULL', () => {
    const d = newTableDesign('t');
    d.columns[0].nullable = true;
    expect(validateDesign(d).some((i) => i.message.includes('不能为 NULL'))).toBe(true);
  });

  it('非整数不能自增', () => {
    const d = newTableDesign('t');
    d.columns[0].type = 'varchar';
    d.columns[0].autoIncrement = true;
    expect(validateDesign(d).some((i) => i.message.includes('只有整数类型可以自增'))).toBe(true);
  });

  it('两个自增字段被拒', () => {
    const d = newTableDesign('t');
    // id 已是自增；再加一个自增 sid → 两个
    d.columns.push(col({ name: 'sid', type: 'int', autoIncrement: true }));
    expect(validateDesign(d).some((i) => i.message.includes('一个自增'))).toBe(true);
  });

  it('小数位不能超长度', () => {
    const d = newTableDesign('t');
    d.columns.push(col({ name: 'price', type: 'decimal', length: '5', scale: '7' }));
    expect(validateDesign(d).some((i) => i.message.includes('小数位不能超过'))).toBe(true);
  });

  it('索引引用不存在字段被拒', () => {
    const d = newTableDesign('t');
    const idx = emptyIndex();
    idx.columns.push({ column: 'nope', prefixLength: '' });
    d.indexes.push(idx);
    expect(validateDesign(d).some((i) => i.message.includes('不存在的字段'))).toBe(true);
  });

  it('外键字段数量不一致被拒', () => {
    const d = newTableDesign('t');
    const fk = emptyForeignKey();
    fk.columns = ['id'];
    fk.refTable = 'other';
    fk.refColumns = ['a', 'b'];
    d.foreignKeys.push(fk);
    expect(validateDesign(d).some((i) => i.message.includes('数量必须一致'))).toBe(true);
  });

  it('合法设计无 error', () => {
    const d = newTableDesign('orders');
    d.columns.push(col({ name: 'name', type: 'varchar', length: '64', nullable: false, comment: '名称' }));
    const issues = validateDesign(d).filter((i) => i.level === 'error');
    expect(issues).toEqual([]);
  });
});

describe('buildCreateTable', () => {
  it('生成完整 CREATE TABLE（主键 + 索引 + 外键 + 表注释）', () => {
    const d = newTableDesign('orders');
    d.comment = '订单表';
    d.columns.push(col({ name: 'name', type: 'varchar', length: '64', nullable: false, comment: "it's" }));

    const idx = emptyIndex();
    idx.columns.push({ column: 'name', prefixLength: '10' });
    d.indexes.push(idx);

    const fk = emptyForeignKey();
    fk.columns = ['id'];
    fk.refTable = 'users';
    fk.refColumns = ['id'];
    fk.onDelete = 'CASCADE';
    d.foreignKeys.push(fk);

    const r = buildCreateTable('db', d);
    expect(r.sql).toBeTruthy();
    expect(r.sql).toContain('CREATE TABLE `db`.`orders`');
    expect(r.sql).toContain('`id` bigint UNSIGNED NOT NULL AUTO_INCREMENT');
    expect(r.sql).toContain('PRIMARY KEY (`id`)');
    expect(r.sql).toContain('`name` varchar(64) NOT NULL');
    expect(r.sql).toContain("COMMENT 'it''s'"); // 单引号转义
    expect(r.sql).toContain('INDEX `idx_name` (`name`(10))'); // 前缀长度
    expect(r.sql).toContain('FOREIGN KEY (`id`) REFERENCES `db`.`users` (`id`) ON DELETE CASCADE');
    expect(r.sql).toContain("COMMENT='订单表'");
    expect(r.sql!.trimEnd().endsWith(';')).toBe(true);
  });

  it('校验失败返回 null + issues', () => {
    const d = newTableDesign(''); // 无表名
    const r = buildCreateTable('db', d);
    expect(r.sql).toBeNull();
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('数值默认值不加引号，字符串加引号，函数不加', () => {
    const d = newTableDesign('t');
    d.columns[0].isPrimaryKey = false;
    d.columns[0].autoIncrement = false;
    d.columns.push(
      col({ name: 'cnt', type: 'int', defaultValue: '5', nullable: true }),
      col({ name: 'label', type: 'varchar', length: '16', defaultValue: 'abc', nullable: true }),
      col({ name: 'created', type: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP', nullable: true }),
    );
    const r = buildCreateTable('db', d);
    expect(r.sql).toContain('`cnt` int NULL DEFAULT 5');
    expect(r.sql).toContain("`label` varchar(16) NULL DEFAULT 'abc'");
    expect(r.sql).toContain('`created` timestamp NULL DEFAULT CURRENT_TIMESTAMP');
  });
});

describe('buildAlterStatements', () => {
  const original = {
    columns: [
      { name: 'id', dataType: 'bigint unsigned', nullable: false, defaultValue: null, comment: null, isPrimaryKey: true, isUnique: false, autoIncrement: true, charset: null, collation: null },
      { name: 'name', dataType: 'varchar(64)', nullable: false, defaultValue: null, comment: null, isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null },
      { name: 'legacy', dataType: 'int', nullable: true, defaultValue: null, comment: null, isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null },
    ],
  };

  function baseDesign(): TableDesign {
    const d = designFromTableMeta('t', {
      comment: null,
      engine: 'InnoDB',
      collation: null,
      columns: original.columns,
    });
    return d;
  }

  it('无改动 → 空 diff', () => {
    const d = baseDesign();
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements).toEqual([]);
    expect(diff.summary).toEqual([]);
  });

  it('新增字段 → ADD COLUMN', () => {
    const d = baseDesign();
    d.columns.push(col({ name: 'remark', type: 'varchar', length: '255', nullable: true }));
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements).toHaveLength(1);
    expect(diff.statements[0]).toContain('ADD COLUMN `remark` varchar(255) NULL');
    expect(diff.summary[0]).toContain('新增字段 remark');
  });

  it('删除字段 → DROP COLUMN', () => {
    const d = baseDesign();
    d.columns = d.columns.filter((c) => c.name !== 'legacy');
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements.some((s) => s.includes('DROP COLUMN `legacy`'))).toBe(true);
  });

  it('改类型 → MODIFY', () => {
    const d = baseDesign();
    const name = d.columns.find((c) => c.name === 'name')!;
    name.length = '128';
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements.some((s) => s.includes('MODIFY') && s.includes('varchar(128)'))).toBe(true);
  });

  it('改可空 → MODIFY', () => {
    const d = baseDesign();
    const name = d.columns.find((c) => c.name === 'name')!;
    name.nullable = true;
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements.some((s) => s.includes('MODIFY') && s.includes('NULL'))).toBe(true);
  });

  it('主键变化 → DROP PRIMARY KEY + ADD PRIMARY KEY', () => {
    const d = baseDesign();
    const id = d.columns.find((c) => c.name === 'id')!;
    id.isPrimaryKey = false;
    const name = d.columns.find((c) => c.name === 'name')!;
    name.isPrimaryKey = true;
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements.some((s) => s.includes('DROP PRIMARY KEY'))).toBe(true);
    expect(diff.statements.some((s) => s.includes('ADD PRIMARY KEY (`name`)'))).toBe(true);
  });

  it('新增索引 → ADD INDEX', () => {
    const d = baseDesign();
    const idx = emptyIndex();
    idx.kind = 'unique';
    idx.columns.push({ column: 'name', prefixLength: '' });
    d.indexes.push(idx);
    const diff = buildAlterStatements('db', 't', original, d);
    expect(diff.statements.some((s) => s.includes('ADD UNIQUE INDEX `idx_name` (`name`)'))).toBe(true);
  });

  it('新增外键 → ADD CONSTRAINT', () => {
    const d = baseDesign();
    const fk = emptyForeignKey();
    fk.columns = ['id'];
    fk.refTable = 'users';
    fk.refColumns = ['id'];
    d.foreignKeys.push(fk);
    const diff = buildAlterStatements('db', 't', original, d);
    expect(
      diff.statements.some((s) => s.includes('ADD CONSTRAINT') && s.includes('FOREIGN KEY (`id`) REFERENCES `db`.`users`')),
    ).toBe(true);
  });
});

describe('designFromTableMeta / parseDataType', () => {
  it('bigint unsigned → unsigned 标志 + 无长度', () => {
    const d = designFromTableMeta('t', {
      comment: '备注',
      engine: 'InnoDB',
      collation: 'utf8mb4_general_ci',
      columns: [
        { name: 'id', dataType: 'bigint unsigned', nullable: false, defaultValue: null, comment: null, isPrimaryKey: true, isUnique: false, autoIncrement: true, charset: null, collation: null },
      ],
    });
    expect(d.columns[0].type).toBe('bigint');
    expect(d.columns[0].unsigned).toBe(true);
    expect(d.columns[0].length).toBe('');
    expect(d.tableName).toBe('t');
    expect(d.comment).toBe('备注');
  });

  it('decimal(12,2) → length=12 scale=2', () => {
    const p = parseDataType('decimal(12,2)');
    expect(p).toEqual({ base: 'decimal', length: '12', scale: '2' });
  });

  it('varchar(64) → length=64', () => {
    expect(parseDataType('varchar(64)')).toEqual({ base: 'varchar', length: '64', scale: '' });
  });
});

describe('类型工具', () => {
  it('typeSupportsLength', () => {
    expect(typeSupportsLength('varchar')).toBe(true);
    expect(typeSupportsLength('int')).toBe(false);
    expect(typeSupportsLength('decimal')).toBe(true);
  });
  it('typeSupportsScale', () => {
    expect(typeSupportsScale('decimal')).toBe(true);
    expect(typeSupportsScale('varchar')).toBe(false);
  });
});

describe('typeDefaultLength', () => {
  it('varchar 默认 255，timestamp 无长度，decimal 10', async () => {
    const { typeDefaultLength } = await import('./index.js');
    expect(typeDefaultLength('varchar')).toBe('255');
    expect(typeDefaultLength('timestamp')).toBe('');
    expect(typeDefaultLength('decimal')).toBe('10');
    expect(typeDefaultLength('bigint')).toBe('');
  });
});
