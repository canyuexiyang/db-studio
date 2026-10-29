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
  runAlterStatements,
  describeAlterFailure,
  remainingAlterCount,
  type AlterRunFailure,
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

/**
 * P1-12：ALTER 批量执行的失败语义。
 *
 * MySQL 的 DDL 隐式提交，一批 ALTER 中途失败时前几条**已经落库**且无法回滚。
 * 旧实现只 toast 一句错误就完事，用户再点一次保存会把已成功的语句重跑一遍
 * （ADD COLUMN 重复 → 1060）。下面钉住的就是修复所需的两个事实：
 *  ① 失败后**不许继续执行**后续语句（否则错误定位会指向后面那条）；
 *  ② `executed` 必须精确，它是「重拉结构 → 重建 diff」的唯一依据。
 */
describe('runAlterStatements（P1-12）', () => {
  const stmts = [
    'ALTER TABLE `db`.`t` ADD COLUMN `a` INT',
    'ALTER TABLE `db`.`t` ADD COLUMN `b` INT',
    'ALTER TABLE `db`.`t` ADD COLUMN `c` INT',
  ];

  it('全部成功：executed = 总条数', async () => {
    const seen: string[] = [];
    const r = await runAlterStatements(stmts, async (sql) => {
      seen.push(sql);
    });
    expect(r).toEqual({ ok: true, executed: 3, total: 3 });
    expect(seen).toEqual(stmts);
  });

  it('🔴 第 2 条失败后立刻停止，第 3 条不许被执行', async () => {
    const seen: string[] = [];
    const r = await runAlterStatements(stmts, async (sql, i) => {
      if (i === 1) throw new Error("Duplicate column name 'b'");
      seen.push(sql);
    });
    expect(r.ok).toBe(false);
    if (r.ok) return; // 类型收窄
    expect(seen).toEqual([stmts[0]]); // 只有第 1 条真的跑了
    expect(r.failure.executed).toBe(1);
    expect(r.failure.failedAt).toBe(2); // 1 基序号，给人看的
    expect(r.failure.total).toBe(3);
    expect(r.failure.sql).toBe(stmts[1]); // 原文要能回显给用户
    expect(r.failure.message).toContain('Duplicate column name');
  });

  it('第一条就失败：executed = 0（结构一行没动）', async () => {
    const r = await runAlterStatements(stmts, async () => {
      throw new Error('boom');
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.executed).toBe(0);
    expect(r.failure.failedAt).toBe(1);
    expect(remainingAlterCount(r.failure)).toBe(3);
  });

  it('非 Error 抛出也要有 message（不能变成 undefined 文案）', async () => {
    const r = await runAlterStatements(['x'], async () => {
      throw 'table is locked'; // eslint-disable-line no-throw-literal
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.message).toBe('table is locked');
  });

  it('失败报告同时说清「已执行」与「失败于」', () => {
    const f: AlterRunFailure = { executed: 2, failedAt: 3, total: 5, sql: 'ALTER ...', message: 'err' };
    const line = describeAlterFailure(f);
    expect(line).toContain('已执行 2 条');
    expect(line).toContain('第 3 条失败');
    expect(line).toContain('共 5 条');
    expect(line).toContain('err');
    // 剩余条数 = 总数 - 已执行（重建 diff 后应正好等于它）
    expect(remainingAlterCount(f)).toBe(3);
  });

  it('空语句集：成功且 0 条（不抛也不误报失败）', async () => {
    const r = await runAlterStatements([], async () => {
      throw new Error('不该被调用');
    });
    expect(r).toEqual({ ok: true, executed: 0, total: 0 });
  });
});
