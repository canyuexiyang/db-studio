import { describe, it, expect } from 'vitest';
import {
  buildMutationPlan,
  buildDuplicateRowPlan,
  buildUpdate,
  interpretResult,
  isComparableColumn,
  isEditable,
  locateColumns,
  locateStrategy,
  normalizeValue,
  previewSql,
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

/** 有主键的标准表 */
function pkTable(over: Partial<TableMeta> = {}): TableMeta {
  return {
    name: 'order',
    kind: 'table',
    comment: null,
    estimatedRows: 100,
    engine: 'InnoDB',
    collation: null,
    columns: [
      col('id', { dataType: 'bigint unsigned', isPrimaryKey: true, autoIncrement: true, nullable: false }),
      col('status', { dataType: 'varchar(16)', nullable: false, defaultValue: 'new' }),
      col('amount', { dataType: 'decimal(12,2)', nullable: false }),
      col('note', { dataType: 'text' }),
      col('score', { dataType: 'double' }),
    ],
    ...over,
  };
}

/** 无主键无唯一键 —— 必须只读 */
function noKeyTable(): TableMeta {
  return {
    name: 'no_key_table',
    kind: 'table',
    comment: null,
    estimatedRows: 50120,
    engine: 'InnoDB',
    collation: null,
    columns: [col('name'), col('city'), col('amount', { dataType: 'decimal(12,2)' })],
  };
}

/** 复合唯一键表 */
function compositeUniqueTable(): TableMeta {
  const t: TableMeta = {
    name: 'pair',
    kind: 'table',
    comment: null,
    estimatedRows: 10,
    engine: 'InnoDB',
    collation: null,
    columns: [
      col('a', { dataType: 'int', nullable: false }),
      col('b', { dataType: 'int', nullable: false }),
      col('v', { dataType: 'varchar(32)' }),
    ],
  };
  (t as TableMeta & { uniqueGroups?: string[][] }).uniqueGroups = [['a', 'b']];
  return t;
}

function edits(over: Partial<EditWithLocate>[]): EditWithLocate[] {
  return over.map((e) => ({
    rowId: '1',
    locate: 'pk' as const,
    column: 'status',
    oldValue: 'new',
    newValue: 'paid',
    locateValues: [1],
    ...e,
  }));
}

describe('行定位策略（B5 红线的技术前提）', () => {
  it('有主键 → pk，可编辑', () => {
    expect(locateStrategy(pkTable())).toBe('pk');
    expect(isEditable(pkTable())).toBe(true);
  });

  it('无主键无唯一键 → none，网格只读', () => {
    expect(locateStrategy(noKeyTable())).toBe('none');
    expect(isEditable(noKeyTable())).toBe(false);
  });

  it('单列唯一键 → unique，可编辑', () => {
    const t = pkTable({
      columns: [
        col('email', { dataType: 'varchar(128)', isUnique: true, nullable: false }),
        col('name'),
      ],
    });
    expect(locateStrategy(t)).toBe('unique');
    expect(isEditable(t)).toBe(true);
    expect(locateColumns(t).map((c) => c.name)).toEqual(['email']);
  });

  it('复合唯一键整组参与定位（单列会过约束）', () => {
    const t = compositeUniqueTable();
    expect(locateStrategy(t)).toBe('unique');
    expect(locateColumns(t).map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('主键优先于唯一键', () => {
    const t = pkTable({ columns: [col('id', { isPrimaryKey: true }), col('email', { isUnique: true })] });
    expect(locateColumns(t).map((c) => c.name)).toEqual(['id']);
  });
});

describe('只提交被编辑的单元格（头号红线）', () => {
  it('SET 列表只含 dirty 列，其他列根本不出现在 SQL 里', () => {
    const stmt = buildUpdate('db', pkTable(), edits([{ column: 'status', oldValue: 'new', newValue: 'paid' }]));
    expect(stmt.sql).toBe('UPDATE `db`.`order` SET `status` = ? WHERE `id` = ? AND `status` = ?');
    expect(stmt.sql).not.toContain('`amount`');
    expect(stmt.sql).not.toContain('`note`');
    expect(stmt.params).toEqual(['paid', 1, 'new']);
  });

  it('同一行多个 dirty 列合并为一条 UPDATE，仍只 SET 这两列', () => {
    const stmt = buildUpdate(
      'db',
      pkTable(),
      edits([
        { column: 'status', oldValue: 'new', newValue: 'paid' },
        { column: 'amount', oldValue: '10.00', newValue: '20.00' },
      ]),
    );
    expect(stmt.sql).toContain('SET `status` = ?, `amount` = ?');
    expect(stmt.sql).not.toContain('`note`');
    expect(stmt.sql).not.toContain('`score`');
    expect(stmt.params).toEqual(['paid', '20.00', 1, 'new', '10.00']);
  });

  it('无唯一键的表直接拒绝，不生成任何 SQL', () => {
    expect(() =>
      buildUpdate('db', noKeyTable(), [
        {
          rowId: 'x',
          locate: 'none',
          column: 'city',
          oldValue: 'a',
          newValue: 'b',
          locateValues: [],
        },
      ]),
    ).toThrow(/无主键\/唯一键/);
  });

  it('无唯一键的表整轮保存被拒，进 rejected 而非 statements', () => {
    const plan = buildMutationPlan('db', noKeyTable(), {
      updates: [
        [
          { rowId: 'x', locate: 'none', column: 'city', oldValue: 'a', newValue: 'b', locateValues: [] },
        ],
      ],
    });
    expect(plan.statements).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toContain('无主键/唯一键');
  });

  it('不允许直接改主键列', () => {
    expect(() =>
      buildUpdate('db', pkTable(), edits([{ column: 'id', oldValue: 1, newValue: 2 }])),
    ).toThrow(/主键/);
  });

  it('未知列直接报错，不生成畸形 SQL', () => {
    expect(() =>
      buildUpdate('db', pkTable(), edits([{ column: 'ghost', oldValue: 1, newValue: 2 }])),
    ).toThrow(/不存在/);
  });

  it('缺少定位原值时报错（没有 WHERE 的 UPDATE 是灾难）', () => {
    expect(() =>
      buildUpdate('db', pkTable(), [
        { rowId: '1', locate: 'pk', column: 'status', oldValue: 'a', newValue: 'b' },
      ]),
    ).toThrow(/缺少定位列原值/);
  });

  it('复合唯一键生成复合 WHERE', () => {
    const t = compositeUniqueTable();
    const stmt = buildUpdate('db', t, [
      { rowId: 'a:1|b:2', locate: 'unique', column: 'v', oldValue: 'x', newValue: 'y', locateValues: [1, 2] },
    ]);
    expect(stmt.sql).toContain('WHERE `a` = ? AND `b` = ? AND `v` = ?');
    expect(stmt.params).toEqual(['y', 1, 2, 'x']);
  });
});

describe('冲突检测（不覆盖他人改动）', () => {
  it('WHERE 带被编辑列的原值', () => {
    const stmt = buildUpdate('db', pkTable(), edits([{ column: 'status', oldValue: 'new', newValue: 'paid' }]));
    expect(stmt.sql).toContain('AND `status` = ?');
    expect(stmt.params[stmt.params.length - 1]).toBe('new');
  });

  it('浮点列原值不进 WHERE（浮点比较不可靠，会产生假冲突）', () => {
    const stmt = buildUpdate('db', pkTable(), edits([{ column: 'score', oldValue: 1.5, newValue: 2.5 }]));
    expect(stmt.sql.split(' WHERE ')[1]).toBe('`id` = ?');
    expect(stmt.params).toEqual([2.5, 1]);
  });

  it('TEXT 列原值不进 WHERE', () => {
    const stmt = buildUpdate('db', pkTable(), edits([{ column: 'note', oldValue: 'a', newValue: 'b' }]));
    expect(stmt.sql).not.toContain('AND `note`');
  });

  it('原值是 NULL 时用 IS NULL（= NULL 永远为假）', () => {
    const stmt = buildUpdate('db', pkTable(), edits([{ column: 'note', oldValue: null, newValue: 'x' }]));
    // SET 里当然有 note，但 WHERE 里不该有（text 不可比较）
    expect(stmt.sql.split(' WHERE ')[1]).toBe('`id` = ?');
    // 定位列为 NULL 的场景：构造一个 id 为 NULL 的行
    const t = pkTable();
    const stmt2 = buildUpdate('db', t, [
      { rowId: '', locate: 'pk', column: 'status', oldValue: 'new', newValue: 'paid', locateValues: [null] },
    ]);
    expect(stmt2.sql).toContain('WHERE `id` IS NULL AND `status` = ?');
  });

  it('isComparableColumn 排除浮点/JSON/二进制/文本', () => {
    expect(isComparableColumn(col('x', { dataType: 'double' }))).toBe(false);
    expect(isComparableColumn(col('x', { dataType: 'json' }))).toBe(false);
    expect(isComparableColumn(col('x', { dataType: 'blob' }))).toBe(false);
    expect(isComparableColumn(col('x', { dataType: 'text' }))).toBe(false);
    expect(isComparableColumn(col('x', { dataType: 'varchar(64)' }))).toBe(true);
    expect(isComparableColumn(col('x', { dataType: 'int' }))).toBe(true);
    expect(isComparableColumn(col('x', { dataType: 'decimal(12,2)' }))).toBe(true);
  });

  it('affectedRows=0 → 冲突，不覆盖', () => {
    const r = interpretResult(0);
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') expect(r.reason).toContain('affectedRows=0');
  });

  it('affectedRows=1 → 成功', () => {
    const r = interpretResult(1);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.affectedRows).toBe(1);
  });

  it('affectedRows>1 → 中止整轮（定位缺陷，绝不能继续）', () => {
    const r = interpretResult(3);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.reason).toContain('已中止');
  });
});

describe('新增行与删除', () => {
  it('INSERT 只含显式列，自增主键留空由服务端生成', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'new1', values: { id: null, status: 'new', amount: '1.00' } }],
    });
    expect(plan.statements[0].sql).toBe('INSERT INTO `db`.`order` (`status`, `amount`) VALUES (?, ?)');
    expect(plan.statements[0].params).toEqual(['new', '1.00']);
    expect(plan.statements[0].refId).toBe('new1');
  });

  it('显式写入的 NULL 是用户意图，保留', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'n', values: { status: null, amount: '1.00' } }],
    });
    expect(plan.statements[0].sql).toContain('`status`');
    expect(plan.statements[0].params).toEqual([null, '1.00']);
  });

  it('不存在的列被忽略（防止脏数据进 SQL）', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'n', values: { status: 'a', ghost: 'x' } }],
    });
    expect(plan.statements[0].sql).toBe('INSERT INTO `db`.`order` (`status`) VALUES (?)');
  });

  it('空新增行进 rejected', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'n', values: { id: null } }],
    });
    expect(plan.statements).toHaveLength(0);
    expect(plan.rejected[0].reason).toContain('没有任何有效列值');
  });

  it('DELETE 带主键定位', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      deletes: [{ rowId: '1', locate: 'pk', locateValues: [1] }],
    });
    expect(plan.statements[0].sql).toBe('DELETE FROM `db`.`order` WHERE `id` = ?');
    expect(plan.statements[0].params).toEqual([1]);
  });

  it('无唯一键表的删除同样被拒', () => {
    const plan = buildMutationPlan('db', noKeyTable(), {
      deletes: [{ rowId: 'x', locate: 'none', locateValues: [] }],
    });
    expect(plan.statements).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
  });
});

describe('整轮计划的失败隔离', () => {
  it('同行里校验失败的单元格进 rejected，该行其余有效单元格照常提交', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      updates: [
        edits([
          { column: 'amount', oldValue: '1', newValue: 'abc', invalid: { reason: '不是合法数字' } },
          { column: 'note', oldValue: 'a', newValue: 'b' },
        ]),
      ],
    });
    // amount 被拒，note 仍提交 —— 且 SET 里绝不含 amount
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).not.toContain('`amount`');
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toBe('不是合法数字');
  });

  it('另一行的有效改动不受本行失败影响', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      updates: [
        edits([{ column: 'amount', oldValue: '1', newValue: 'bad', invalid: { reason: '类型不匹配' } }]),
        edits([{ column: 'status', oldValue: 'new', newValue: 'paid' }]),
      ],
    });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toContain('`status`');
    expect(plan.rejected).toHaveLength(1);
  });

  it('执行顺序：UPDATE → DELETE → INSERT（新增行最后）', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'n', values: { status: 'a' } }],
      deletes: [{ rowId: '1', locate: 'pk', locateValues: [1] }],
      updates: [edits([{ column: 'status', oldValue: 'a', newValue: 'b' }])],
    });
    expect(plan.statements.map((s) => s.kind)).toEqual(['update', 'delete', 'insert']);
  });

  it('预览 SQL 可逐条查看（红线 2：写操作必须可预览）', () => {
    const plan = buildMutationPlan('db', pkTable(), {
      updates: [edits([{ column: 'status', oldValue: 'new', newValue: 'paid' }])],
    });
    const lines = previewSql(plan);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('UPDATE');
    expect(plan.statements[0].description).toContain('更新');
  });

  it('空输入返回空计划，不抛异常', () => {
    const plan = buildMutationPlan('db', pkTable(), {});
    expect(plan.statements).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });
});

describe('防注入与值归一化', () => {
  it('表名含反引号被转义', () => {
    const t = pkTable({ name: 'or`der' });
    const stmt = buildUpdate('db', t, edits([{ column: 'status', oldValue: 'a', newValue: 'b' }]));
    expect(stmt.sql).toContain('`db`.`or``der`');
  });

  it('值永不拼进 SQL 文本，全是 ? 占位', () => {
    const stmt = buildUpdate(
      'db',
      pkTable(),
      edits([{ column: 'status', oldValue: "'; DROP TABLE x; --", newValue: "'; DROP TABLE x; --" }]),
    );
    expect(stmt.sql).not.toContain('DROP TABLE');
    expect(stmt.sql.match(/\?/g)).toHaveLength(3);
  });

  it('布尔归一化为 1/0（MySQL 无原生 bool）', () => {
    expect(normalizeValue(true)).toBe(1);
    expect(normalizeValue(false)).toBe(0);
  });

  it('Date 原样传给驱动（不手工格式化，避免时区事故）', () => {
    const d = new Date('2026-09-21T00:00:00Z');
    expect(normalizeValue(d)).toBe(d);
  });

  it('undefined 归一化为 null', () => {
    expect(normalizeValue(undefined)).toBe(null);
  });

  it('空字符串保持空字符串（不是 NULL）', () => {
    expect(normalizeValue('')).toBe('');
  });
});

describe('skipConflictCheck（仅覆盖模式）', () => {
  it('去掉原值条件，只留定位列', () => {
    const plan = buildMutationPlan(
      'db',
      pkTable(),
      { updates: [edits([{ column: 'status', oldValue: 'new', newValue: 'paid' }])] },
      { skipConflictCheck: true },
    );
    expect(plan.statements[0].sql).toBe('UPDATE `db`.`order` SET `status` = ? WHERE `id` = ?');
    expect(plan.statements[0].params).toEqual(['paid', 1]);
  });
});

describe('复制行计划（A4：⌘D 插入复制行）', () => {
  /** 非自增主键表（业务编码做主键） */
  function codeKeyTable(): TableMeta {
    return {
      name: 'dict',
      kind: 'table',
      comment: null,
      estimatedRows: 12,
      engine: 'InnoDB',
      collation: null,
      columns: [
        col('code', { dataType: 'varchar(32)', isPrimaryKey: true, nullable: false }),
        col('label', { dataType: 'varchar(64)', nullable: false }),
        col('sort', { dataType: 'int' }),
      ],
    };
  }

  it('无主键/唯一键的表整体拒绝', () => {
    const plan = buildDuplicateRowPlan(noKeyTable(), ['a', 'b', 1]);
    expect(plan.rejected).toContain('只读');
    expect(plan.edits).toHaveLength(0);
  });

  it('自增主键表：主键列 auto-skip 留空，其余列原样复制', () => {
    const t = pkTable();
    const plan = buildDuplicateRowPlan(t, [7, 'active', '9.90', '备注', 3.5]);
    expect(plan.rejected).toBeNull();
    expect(plan.needsInput).toHaveLength(0);
    expect(plan.autoSkipped).toEqual(['id']);
    const idEdit = plan.edits[0];
    expect(idEdit).toMatchObject({ col: 0, column: 'id', value: null, kind: 'auto-skip' });
    // 其余列按位复制
    expect(plan.edits[1]).toMatchObject({ col: 1, column: 'status', value: 'active', kind: 'copy' });
    expect(plan.edits[2]).toMatchObject({ col: 2, column: 'amount', value: '9.90', kind: 'copy' });
    expect(plan.edits[4]).toMatchObject({ col: 4, column: 'score', value: 3.5, kind: 'copy' });
  });

  it('非自增主键表：主键列留空待填并给原因，其余列复制', () => {
    const plan = buildDuplicateRowPlan(codeKeyTable(), ['A01', '标签一', 1]);
    expect(plan.rejected).toBeNull();
    expect(plan.needsInput).toEqual(['code']);
    const pkEdit = plan.edits[0];
    expect(pkEdit.kind).toBe('needs-input');
    expect(pkEdit.value).toBeNull();
    expect(pkEdit.reason).toContain('撞唯一键');
    expect(plan.edits[1].value).toBe('标签一');
    expect(plan.edits[2].value).toBe(1);
    // 汇总文案提醒用户填主键
    expect(plan.summary).toContain('code');
  });

  it('复制行落库走 INSERT 预演：自增列被剔除', () => {
    const dup = buildDuplicateRowPlan(pkTable(), [7, 'active', '9.90', null, 3.5]);
    const plan = buildMutationPlan('db', pkTable(), {
      inserts: [{ tempId: 'dup-0', values: Object.fromEntries(dup.edits.map((e) => [e.column, e.value])) }],
    });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('INSERT INTO `db`.`order` (`status`, `amount`, `note`, `score`) VALUES (?, ?, ?, ?)');
    expect(plan.rejected).toHaveLength(0);
  });

  it('非自增主键留空保存 → 预演 rejected 给出可读理由（不让用户确认后吃数据库报错）', () => {
    const dup = buildDuplicateRowPlan(codeKeyTable(), ['A01', '标签一', 1]);
    // 用户还没填主键就点保存：needs-input 列仍是 null
    const plan = buildMutationPlan('db', codeKeyTable(), {
      inserts: [{ tempId: 'dup-0', values: Object.fromEntries(dup.edits.map((e) => [e.column, e.value])) }],
    });
    expect(plan.statements).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toContain('主键列 code');
  });

  it('非自增主键补填后可正常 INSERT', () => {
    const values = { code: 'A02', label: '标签一', sort: 1 };
    const plan = buildMutationPlan('db', codeKeyTable(), { inserts: [{ tempId: 'dup-0', values }] });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('INSERT INTO `db`.`dict` (`code`, `label`, `sort`) VALUES (?, ?, ?)');
    expect(plan.statements[0].params).toEqual(['A02', '标签一', 1]);
  });

  it('自增主键完全缺省（粘贴路径）不受影响', () => {
    const plan = buildMutationPlan('db', pkTable(), { inserts: [{ tempId: 'p', values: { status: 'a' } }] });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].kind).toBe('insert');
  });
});
