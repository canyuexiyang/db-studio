/**
 * V10 SQL 表达式模式单测（2026-09-29，P1-B）
 *
 * 三个层面：
 *  1. validateSqlExpression：结构校验（引号/括号闭合、分号、注释、关键字黑名单）
 *  2. buildUpdate / buildMutationPlan：表达式原样嵌入 SET / VALUES，
 *     字面量仍走 ? 绑定（参数位不错位）
 *  3. 与既有红线的相容性：冲突检测 WHERE、skipConflictCheck、只读表拒绝
 */
import { describe, it, expect } from 'vitest';
import {
  validateSqlExpression,
  normalizeSqlExpression,
  SQL_EXPR_MAX_LENGTH,
  buildUpdate,
  buildMutationPlan,
  MutationError,
  type EditWithLocate,
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

function pkTable(): TableMeta {
  return {
    name: 'order',
    kind: 'table',
    comment: null,
    estimatedRows: 100,
    engine: 'InnoDB',
    collation: null,
    columns: [
      col('id', { dataType: 'bigint unsigned', isPrimaryKey: true, autoIncrement: true, nullable: false }),
      col('status', { dataType: 'varchar(16)', nullable: false }),
      col('amount', { dataType: 'decimal(12,2)', nullable: false }),
      col('created_at', { dataType: 'datetime', nullable: false }),
    ],
  };
}

function edit(over: Partial<EditWithLocate> = {}): EditWithLocate {
  return {
    rowId: '1',
    locate: 'pk',
    column: 'created_at',
    oldValue: '2026-01-01 00:00:00',
    newValue: 'NOW()',
    valueKind: 'sql-expr',
    locateValues: [1],
    ...over,
  };
}

// ---------- 结构校验 ----------

describe('V10 validateSqlExpression（结构校验）', () => {
  it('常见合法表达式通过', () => {
    for (const expr of [
      'NOW()',
      'NOW(6)',
      'UUID()',
      'CURRENT_TIMESTAMP',
      'amount * 2',
      'amount + 1.5',
      'CONCAT(status, "-done")',
      'IF(amount > 100, 1, 0)',
      '(SELECT MAX(id) FROM `user`)',
      "COALESCE(note, 'x')",
      '-amount',
      'JSON_SET(meta, "$.a", 1)',
    ]) {
      const r = validateSqlExpression(expr);
      expect(r.ok, `${expr} → ${r.reason}`).toBe(true);
    }
  });

  it('字符串字面量里的分号/关键字不误杀（剥掉字面量再扫）', () => {
    expect(validateSqlExpression("CONCAT('a; b', status)").ok).toBe(true);
    expect(validateSqlExpression("CONCAT('drop table x', status)").ok).toBe(true);
    expect(validateSqlExpression("IF(x = '--', 1, 2)").ok).toBe(true);
  });

  it('拒绝：空 / 非字符串 / 超长', () => {
    expect(validateSqlExpression('').ok).toBe(false);
    expect(validateSqlExpression('   ').ok).toBe(false);
    expect(validateSqlExpression(null).ok).toBe(false);
    expect(validateSqlExpression(42).ok).toBe(false);
    // ⚠️ 长度是 trim 之后判的：纯空白填充不算超长（那只是排版），要用真实内容撑
    expect(validateSqlExpression('NOW()' + ' '.repeat(SQL_EXPR_MAX_LENGTH)).ok).toBe(true);
    const long = 'CONCAT(' + 'a'.repeat(SQL_EXPR_MAX_LENGTH) + ')';
    const r = validateSqlExpression(long);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('过长');
  });

  it('拒绝：分号（多语句是最短的攻击路径）', () => {
    const r = validateSqlExpression('NOW(); DROP TABLE `order`');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('分号');
  });

  it('拒绝：注释（-- / # / 块注释都能藏任意内容）', () => {
    expect(validateSqlExpression('NOW() -- x').ok).toBe(false);
    expect(validateSqlExpression('NOW() # x').ok).toBe(false);
    expect(validateSqlExpression('NOW() /* x */').ok).toBe(false);
  });

  it('拒绝：未闭合的引号与括号', () => {
    const q = validateSqlExpression("CONCAT('abc");
    expect(q.ok).toBe(false);
    expect(q.reason).toContain('引号');
    const p = validateSqlExpression('CONCAT(a, b');
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('括号');
    expect(validateSqlExpression('a, b)').ok).toBe(false);
  });

  it('拒绝：写/权限/DoS 关键字（词边界，大小写不敏感）', () => {
    for (const expr of [
      'DROP TABLE x',
      'delete from t',
      'Update t set a=1',
      'GRANT ALL ON *.*',
      'CALL proc()',
      'SLEEP(10)',
      'BENCHMARK(1000000, MD5(1))',
      'LOAD_FILE("/etc/passwd")',
      'x INTO OUTFILE "/tmp/a"',
    ]) {
      const r = validateSqlExpression(expr);
      expect(r.ok, expr).toBe(false);
    }
  });

  it('关键字用词边界匹配：deleted_at / updates 这类列名不误杀', () => {
    expect(validateSqlExpression('deleted_at + 1').ok).toBe(true);
    expect(validateSqlExpression('CONCAT(updates, "x")').ok).toBe(true);
    expect(validateSqlExpression('settings_note').ok).toBe(true);
  });

  it('normalizeSqlExpression 只 trim，不转义（转义会把它变回字符串字面量）', () => {
    expect(normalizeSqlExpression('  NOW()  ')).toBe('NOW()');
    expect(normalizeSqlExpression("CONCAT('a', b)")).toBe("CONCAT('a', b)");
  });

  it('双写引号转义不误判为未闭合', () => {
    // MySQL 里 '' 表示一个字面单引号、`` 表示一个字面反引号，都不是「闭合后又开」
    expect(validateSqlExpression("CONCAT('it''s', x)").ok).toBe(true);
    expect(validateSqlExpression('`order`.amount * 2').ok).toBe(true);
    expect(validateSqlExpression('CONCAT("a""b", y)').ok).toBe(true);
  });
});

// ---------- SQL 构造：UPDATE ----------

describe('V10 buildUpdate（表达式原样嵌入 SET）', () => {
  it('单表达式列：SET 无占位符，WHERE 参数不错位', () => {
    const stmt = buildUpdate('shop', pkTable(), [edit()]);
    expect(stmt.sql).toBe(
      'UPDATE `shop`.`order` SET `created_at` = NOW() WHERE `id` = ? AND `created_at` = ?',
    );
    // 参数 = WHERE 定位值 + 冲突检测原值（SET 段不占位）
    expect(stmt.params).toEqual([1, '2026-01-01 00:00:00']);
    expect(stmt.hasSqlExpr).toBe(true);
    expect(stmt.setParamCount).toBe(0);
    expect(stmt.description).toContain('SQL 表达式');
  });

  it('表达式与字面量混排：? 位与 params 逐一对应', () => {
    const stmt = buildUpdate('shop', pkTable(), [
      edit({ column: 'status', newValue: 'paid', valueKind: 'literal', oldValue: 'new' }),
      edit({ column: 'amount', newValue: 'amount * 2', valueKind: 'sql-expr', oldValue: 10 }),
      edit({ column: 'created_at', newValue: 'NOW()', valueKind: 'sql-expr', oldValue: null }),
    ]);
    expect(stmt.sql).toContain('`status` = ?');
    expect(stmt.sql).toContain('`amount` = amount * 2');
    expect(stmt.sql).toContain('`created_at` = NOW()');
    // SET 段只有 status 一个占位 → setParamCount = 1
    expect(stmt.setParamCount).toBe(1);
    // params[0] = SET 的 'paid'，其后才是 WHERE 的定位与冲突检测值
    expect(stmt.params[0]).toBe('paid');
    expect(stmt.params).toContain(1);
  });

  it('valueKind 缺省 = literal，既有行为分毫不动（回归守卫）', () => {
    const stmt = buildUpdate('shop', pkTable(), [
      { rowId: '1', locate: 'pk', column: 'status', oldValue: 'new', newValue: 'paid', locateValues: [1] },
    ]);
    expect(stmt.sql.startsWith('UPDATE `shop`.`order` SET `status` = ? WHERE')).toBe(true);
    expect(stmt.hasSqlExpr).toBeFalsy();
  });

  it('非法表达式在构造阶段就被拒（fail-closed，不产半截 SQL）', () => {
    expect(() => buildUpdate('shop', pkTable(), [edit({ newValue: 'NOW(); DROP TABLE x' })])).toThrow(MutationError);
    expect(() => buildUpdate('shop', pkTable(), [edit({ newValue: 42 as unknown as string })])).toThrow(/必须是文本/);
  });

  it('skipConflictCheck 与表达式共存：WHERE 参数起点用 setParamCount，不错位', () => {
    const plan = buildMutationPlan(
      'shop',
      pkTable(),
      {
        updates: [[
          edit({ column: 'status', newValue: 'paid', valueKind: 'literal', oldValue: 'new' }),
          edit(),
        ]],
      },
      { skipConflictCheck: true },
    );
    expect(plan.statements).toHaveLength(1);
    const stmt = plan.statements[0];
    // 冲突检测的原值条件被剥掉，只剩定位列
    expect(stmt.sql).not.toContain('AND `status` = ?');
    expect(stmt.sql).toContain('WHERE `id` = ?');
    // params = SET 的 'paid' + WHERE 定位的 1 —— 表达式列不占位
    expect(stmt.params).toEqual(['paid', 1]);
  });
});

// ---------- SQL 构造：INSERT ----------

describe('V10 buildMutationPlan INSERT（表达式原样进 VALUES）', () => {
  it('字面量 ? 与表达式原样混排；列名与值一一对应', () => {
    const plan = buildMutationPlan('shop', pkTable(), {
      inserts: [
        {
          tempId: '9',
          values: { status: 'new', amount: 10, created_at: 'NOW()' },
          valueKinds: { created_at: 'sql-expr' },
        },
      ],
    });
    expect(plan.rejected).toEqual([]);
    const stmt = plan.statements[0];
    expect(stmt.sql).toBe(
      'INSERT INTO `shop`.`order` (`status`, `amount`, `created_at`) VALUES (?, ?, NOW())',
    );
    expect(stmt.params).toEqual(['new', 10]);
    expect(stmt.hasSqlExpr).toBe(true);
  });

  it('表达式被拒时该列整体退出（列数与值数保持匹配，不产 Column count 错）', () => {
    const plan = buildMutationPlan('shop', pkTable(), {
      inserts: [
        {
          tempId: '9',
          values: { status: 'new', created_at: 'NOW(); DROP TABLE x' },
          valueKinds: { created_at: 'sql-expr' },
        },
      ],
    });
    // created_at 进 rejected，status 照常插入
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].column).toBe('created_at');
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('INSERT INTO `shop`.`order` (`status`) VALUES (?)');
  });

  it('valueKinds 缺省 = 全部字面量（粘贴/复制行等既有调用方零改动）', () => {
    const plan = buildMutationPlan('shop', pkTable(), {
      inserts: [{ tempId: '9', values: { status: 'new', amount: 5 } }],
    });
    expect(plan.statements[0].sql).toContain('VALUES (?, ?)');
    expect(plan.statements[0].hasSqlExpr).toBeFalsy();
  });

  it('无主键表：表达式改动同样被拒（红线：isEditable 判定不受 valueKind 影响）', () => {
    const noKey: TableMeta = { ...pkTable(), columns: [col('a'), col('b')] };
    const plan = buildMutationPlan('shop', noKey, {
      updates: [[edit({ column: 'a', locateValues: [] })]],
    });
    expect(plan.statements).toHaveLength(0);
    expect(plan.rejected[0].reason).toContain('只读');
  });
});
