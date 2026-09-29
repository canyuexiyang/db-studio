/**
 * 编辑器内核的纯逻辑单测（S1 / V16 / S3 / S4 / S2 主题判定）。
 *
 * ⚠️ 项目里没有 jsdom（根 vitest.config.ts 未配 environment），所以这里**只测
 *    纯函数**：不建 EditorView、不碰 DOM。CodeMirror 的模块本身可以在 node 下
 *    import（探测过：@codemirror/view 的浏览器特性检测是带 typeof 保护的），
 *    所以直接引 SqlEditorCore 取这些导出是安全的。
 *
 * 断言纪律：每条都断言「改坏实现就变红」的那一个具体产物，不写恒真断言。
 * 命名纪律：每个 it 的名字都写清【场景 → 期望 → 为什么】，方便回看时判断
 *    这条断言到底是约束还是凑数。
 */

import { describe, it, expect } from 'vitest';
import type { ColumnMeta, DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';
import type { SqlDiagnostic } from '@dbstudio/core-sql-editor/lint';
import {
  LINT_DEBOUNCE_MS,
  columnDetail,
  filterPartialDiagnostics,
  findDatabaseByName,
  findTableByName,
  formatTargetOf,
  hoverInfoAt,
  isTablePosition,
  looksCompleteStatement,
  readTheme,
} from './SqlEditorCore';

// ---------- 造数据 ----------

function col(name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'int',
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
    ...extra,
  };
}

function table(name: string, columns: ColumnMeta[] = [], extra: Partial<TableMeta> = {}): TableMeta {
  return {
    name,
    kind: 'table',
    comment: null,
    estimatedRows: null,
    engine: 'InnoDB',
    collation: 'utf8mb4_general_ci',
    columns,
    ...extra,
  };
}

const SCHEMA: DatabaseMeta[] = [
  {
    name: 'shop',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [
      table('orders', [
        col('id', { isPrimaryKey: true, autoIncrement: true, nullable: false }),
        col('status', { dataType: 'varchar(16)', isUnique: true }),
        col('amount', { dataType: 'decimal(12,2)' }),
      ], { comment: '订单表', estimatedRows: 1234 }),
      table('users', [col('id', { isPrimaryKey: true })]),
    ],
  },
  {
    name: 'crm',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [table('orders', [col('ticket', { dataType: 'text' })])],
  },
];

function diag(from: number, to: number, rule: SqlDiagnostic['rule'] = 'unknown-table'): SqlDiagnostic {
  return { from, to, severity: 'warning', message: '测试诊断', rule };
}

// ===========================================================================
// S1 格式化目标定位
// ===========================================================================

describe('S1 formatTargetOf', () => {
  it('有选区时作用于选区原文，且【原样返回不 trim】—— 外层一动就破坏 core 的幂等', () => {
    const doc = 'xx SELECT 1 yy';
    const t = formatTargetOf(doc, { from: 2, to: 12 });
    expect(t).toEqual({ from: 2, to: 12, text: ' SELECT 1 ' });
  });

  it('无选区时作用于光标所在语句，from/to 是语句在文档中的真实偏移', () => {
    const doc = 'SELECT 1;\nSELECT 2;\n';
    const t = formatTargetOf(doc, { from: 12, to: 12 });
    expect(t?.text).toBe('SELECT 2');
    expect(t?.from).toBe(10);
    expect(t?.to).toBe(18);
  });

  it('光标落在两条语句之间的空白里时给后一条（正在写的那条）', () => {
    const doc = 'SELECT 1;\n\n\nSELECT 2';
    const t = formatTargetOf(doc, { from: 11, to: 11 });
    expect(t?.text).toBe('SELECT 2');
  });

  it('选区是纯空白时返回 null —— 调用方据此提示「没有可格式化的内容」', () => {
    expect(formatTargetOf('SELECT 1 ', { from: 8, to: 9 })).toBeNull();
  });

  it('空文档返回 null，不抛异常', () => {
    expect(formatTargetOf('', { from: 0, to: 0 })).toBeNull();
  });
});

// ===========================================================================
// V16 语句完整性判定
// ===========================================================================

describe('V16 looksCompleteStatement', () => {
  it('刚敲下 `SELECT ` 判为未完成 —— 这是任务书点名的「不许满屏红线」场景', () => {
    expect(looksCompleteStatement('SELECT ')).toBe(false);
    expect(looksCompleteStatement('SELECT')).toBe(false);
  });

  it('以关键字 / 运算符 / 左括号收尾都判为未完成', () => {
    expect(looksCompleteStatement('SELECT * FROM')).toBe(false);
    expect(looksCompleteStatement('SELECT * FROM orders WHERE')).toBe(false);
    expect(looksCompleteStatement('SELECT * FROM orders WHERE id =')).toBe(false);
    expect(looksCompleteStatement('SELECT * FROM orders WHERE id IN (')).toBe(false);
    expect(looksCompleteStatement('SELECT a,')).toBe(false);
  });

  it('标识符 / 数字 / 闭合字符串 / `)` / `*` 收尾判为完成', () => {
    expect(looksCompleteStatement('SELECT * FROM orders')).toBe(true);
    expect(looksCompleteStatement('SELECT *')).toBe(true);
    expect(looksCompleteStatement('SELECT 1')).toBe(true);
    expect(looksCompleteStatement("SELECT 'a'")).toBe(true);
    expect(looksCompleteStatement('SELECT COUNT(1)')).toBe(true);
    expect(looksCompleteStatement('DELETE FROM orders')).toBe(true);
  });

  it('未闭合字符串判为未完成 —— 用户还在打引号里的值', () => {
    expect(looksCompleteStatement("SELECT 'a")).toBe(false);
  });

  it('ASC/DESC/NULL 这类收尾关键字算完成，否则 ORDER BY id DESC 会被永久压制', () => {
    expect(looksCompleteStatement('SELECT * FROM orders ORDER BY id DESC')).toBe(true);
    expect(looksCompleteStatement('SELECT * FROM orders WHERE x IS NULL')).toBe(true);
  });

  it('空白 / 纯注释判为未完成', () => {
    expect(looksCompleteStatement('   ')).toBe(false);
    expect(looksCompleteStatement('-- 说明')).toBe(false);
  });
});

describe('V16 filterPartialDiagnostics', () => {
  it('语句已以分号结尾 → 一条都不压制（用户明确写完了）', () => {
    const sql = 'SELECT * FROM ordres;';
    const kept = filterPartialDiagnostics(sql, 5, [diag(14, 20)]);
    expect(kept).toHaveLength(1);
  });

  it('语句看起来写完了（无分号）→ 不压制，否则单语句文档永远不会有诊断', () => {
    const sql = 'SELECT * FROM ordres';
    const kept = filterPartialDiagnostics(sql, 19, [diag(14, 20)]);
    expect(kept).toHaveLength(1);
  });

  it('语句没写完 → 压掉落在这条语句内的诊断（宁可漏报）', () => {
    const sql = 'SELECT * FROM ';
    const kept = filterPartialDiagnostics(sql, 14, [diag(0, 6, 'missing-table'), diag(7, 13, 'missing-table')]);
    expect(kept).toHaveLength(0);
  });

  it('压制只作用于光标所在的那条语句，别的语句照常报', () => {
    // 第二条语句的 span 是 [22,35)（末尾空格被 trimEnd 掉）
    const sql = 'SELECT * FROM ordres;\nSELECT * FROM ';
    const kept = filterPartialDiagnostics(sql, 34, [diag(14, 20), diag(29, 35, 'missing-table')]);
    expect(kept.map((d) => d.from)).toEqual([14]);
  });

  it('没有诊断时原样返回空数组，不做无谓分配', () => {
    expect(filterPartialDiagnostics('SELECT 1', 0, [])).toEqual([]);
  });

  it('防抖窗口落在任务书要求的 250~400ms 区间内', () => {
    expect(LINT_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    expect(LINT_DEBOUNCE_MS).toBeLessThanOrEqual(400);
  });
});

// ===========================================================================
// S3 补全位置判定与 schema 定位
// ===========================================================================

describe('S3 isTablePosition', () => {
  it('FROM / INSERT INTO / UPDATE 之后是表位置', () => {
    expect(isTablePosition('SELECT * FROM ', 14)).toBe(true);
    expect(isTablePosition('INSERT INTO ', 12)).toBe(true);
    expect(isTablePosition('UPDATE ', 7)).toBe(true);
    expect(isTablePosition('DELETE FROM ', 12)).toBe(true);
  });

  it('`FROM a, b` 的 b 也是表位置 —— 判据要跳过逗号与标识符往前找关键字', () => {
    expect(isTablePosition('SELECT * FROM orders, ', 23)).toBe(true);
  });

  it('`SELECT a, b` 的 b 不是表位置', () => {
    expect(isTablePosition('SELECT a, ', 10)).toBe(false);
  });

  it('WHERE 之后是列位置，不是表位置', () => {
    expect(isTablePosition('SELECT * FROM orders WHERE ', 27)).toBe(false);
  });

  it('认不出（空文档 / 光标在 0）时返回 false —— 退回通用补全，不硬猜', () => {
    expect(isTablePosition('', 0)).toBe(false);
  });
});

describe('S3 findTableByName / findDatabaseByName', () => {
  it('当前库优先：同名表命中当前库那一份（shop.orders 而不是 crm.orders）', () => {
    const hit = findTableByName(SCHEMA, 'shop', 'orders');
    expect(hit?.database).toBe('shop');
    expect(hit?.table.columns.map((c) => c.name)).toContain('status');
  });

  it('没有库上下文时按库顺序取第一个，且大小写不敏感', () => {
    expect(findTableByName(SCHEMA, null, 'ORDERS')?.database).toBe('shop');
  });

  it('找不到的名字返回 null，不抛异常', () => {
    expect(findTableByName(SCHEMA, 'shop', 'nope')).toBeNull();
    expect(findTableByName(SCHEMA, 'shop', '')).toBeNull();
  });

  it('库名查找大小写不敏感', () => {
    expect(findDatabaseByName(SCHEMA, 'CRM')?.name).toBe('crm');
    expect(findDatabaseByName(SCHEMA, 'nope')).toBeNull();
  });
});

// ===========================================================================
// S4 hover（纯内存，绝不 IPC）
// ===========================================================================

describe('S4 hoverInfoAt', () => {
  it('hover 表名 → 表的属性表（估算行数 / 引擎 / 字段数都有）', () => {
    const sql = 'SELECT * FROM orders';
    const info = hoverInfoAt(SCHEMA, 'shop', sql, 17); // 落在 orders 上
    expect(info?.title).toBe('orders');
    expect(info?.subtitle).toBe('shop');
    const labels = (info?.facts ?? []).map((f) => f.label);
    expect(labels).toContain('引擎');
    expect(labels).toContain('字段数');
    expect(labels).toContain('估算行数');
    expect(labels).toContain('注释');
  });

  it('hover `别名.字段` → 解析到真实表的字段（S3 别名感知，不是猜的）', () => {
    const sql = 'SELECT o.status FROM orders o';
    const pos = sql.indexOf('status') + 1;
    const info = hoverInfoAt(SCHEMA, 'shop', sql, pos);
    expect(info?.title).toBe('orders.status');
    expect((info?.facts ?? []).find((f) => f.label === '类型')?.value).toBe('VARCHAR(16)');
  });

  it('hover 裸字段 → 在本语句上下文表里找到它', () => {
    const sql = 'SELECT amount FROM orders';
    const pos = sql.indexOf('amount') + 1;
    const info = hoverInfoAt(SCHEMA, 'shop', sql, pos);
    expect(info?.title).toBe('orders.amount');
  });

  it('hover 关键字返回 null —— 不给 SELECT 弹一个空 tooltip', () => {
    expect(hoverInfoAt(SCHEMA, 'shop', 'SELECT 1', 1)).toBeNull();
  });

  it('hover 完全未知的名字返回 null（不打库、不猜）', () => {
    expect(hoverInfoAt(SCHEMA, 'shop', 'SELECT zzz FROM orders', 9)).toBeNull();
  });

  it('无 schema 时返回 null —— 连接还没加载完时不弹空提示', () => {
    expect(hoverInfoAt([], null, 'SELECT * FROM orders', 17)).toBeNull();
  });
});

describe('S4 columnDetail 短标记', () => {
  it('主键 + 自增 + NOT NULL 的列给 PK/NN/AI（顺序与 core 一致）', () => {
    const d = columnDetail(col('id', { isPrimaryKey: true, autoIncrement: true, nullable: false }), null);
    expect(d).toBe('int · PK NN AI');
  });

  it('无标记的普通列只给类型', () => {
    expect(columnDetail(col('amount', { dataType: 'decimal(12,2)' }), null)).toBe('decimal(12,2)');
  });

  it('没有类型信息时只给标记，不留空的连接符', () => {
    expect(columnDetail(col('id', { dataType: '', isPrimaryKey: true }), null)).toBe('PK');
  });
});

// ===========================================================================
// S2 主题判定
// ===========================================================================

describe('S2 readTheme', () => {
  it('node 环境（无 document）退到浅色，不抛异常', () => {
    expect(readTheme()).toBe('light');
  });
});
