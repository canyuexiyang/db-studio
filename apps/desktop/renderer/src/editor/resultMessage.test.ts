import { describe, it, expect } from 'vitest';
import { describeRunResult, parseMatchedRows, parseChangedRows, type RunResultFacts } from './resultMessage';

/**
 * 0.7.1 需求 1 的验收：文案口径。
 *
 * 🔴 这批断言的价值全在「反例」上：如果实现退回「只看 rowCount」，
 *    UPDATE 的黑体会变成「已修改 0 行」或「返回 0 行」——下面专挑这两条断言。
 */

function facts(over: Partial<RunResultFacts> = {}): RunResultFacts {
  return {
    statementKind: 'select',
    rowCount: 0,
    affectedRows: 0,
    insertId: null,
    info: null,
    warnings: 0,
    cancelled: false,
    elapsedMs: 12,
    ...over,
  };
}

describe('0.7.1 describeRunResult — SELECT', () => {
  it('结果集说「返回 N 行」，千位加分隔符', () => {
    const t = describeRunResult(facts({ rowCount: 1234, affectedRows: 1234 }));
    expect(t.title).toBe('返回 1,234 行');
    expect(t.detail).toBeNull();
    expect(t.inline).toBe('耗时 12 ms · 返回 1,234 行');
  });

  it('空结果集也是「返回 0 行」—— 这才是 0 行的正确用法', () => {
    expect(describeRunResult(facts({ rowCount: 0 })).title).toBe('返回 0 行');
  });
});

describe('0.7.1 describeRunResult — UPDATE（matched 与 changed 分离）', () => {
  /**
   * 🔴 真实数据形状（2026-10-27 真库实测）：
   *    mysql2 默认带 CLIENT_FOUND_ROWS → affectedRows = **matched**
   *    真实变更数只在 info 的 `Changed:` 里
   * 所以这里的 affectedRows 一律按 matched 给，changed 从 info 取。
   */
  it('全部变化：已修改 2 行，不啰嗦「匹配」', () => {
    const t = describeRunResult(
      facts({ statementKind: 'update', affectedRows: 2, info: 'Rows matched: 2  Changed: 2  Warnings: 0' }),
    );
    expect(t.title).toBe('已修改 2 行');
    expect(t.detail).toBeNull();
  });

  it('部分变化：匹配 5 行 · 2 行有变化（用户要能看出「另 3 行本来就一样」）', () => {
    const t = describeRunResult(
      facts({ statementKind: 'update', affectedRows: 5, info: 'Rows matched: 5  Changed: 2  Warnings: 0' }),
    );
    expect(t.title).toBe('已修改 2 行');
    expect(t.detail).toBe('匹配 5 行 · 2 行有变化');
    expect(t.headline).toBe('已修改 2 行 · 匹配 5 行 · 2 行有变化');
  });

  it('🔴 值未变化：affectedRows=3（matched）但主文案必须是「已修改 0 行」', () => {
    const t = describeRunResult(
      facts({ statementKind: 'update', affectedRows: 3, info: 'Rows matched: 3  Changed: 0  Warnings: 0' }),
    );
    // 反例守卫一：不能拿 affectedRows 当 changed（那会显示「已修改 3 行」＝夸大）
    expect(t.title).toBe('已修改 0 行');
    expect(t.detail).toBe('匹配 3 行 · 值未变化');
    // 反例守卫二：这句里绝不能出现「返回 0 行」（那是 0.7.0 的缺陷原文）
    expect(t.headline).not.toContain('返回 0 行');
  });

  it('真的一行没匹配到：只有「已修改 0 行」，不给匹配次信息', () => {
    const t = describeRunResult(
      facts({ statementKind: 'update', affectedRows: 0, info: 'Rows matched: 0  Changed: 0  Warnings: 0' }),
    );
    expect(t.title).toBe('已修改 0 行');
    expect(t.detail).toBeNull();
  });

  it('服务端没给 info：说「已影响 N 行」（中性措辞），绝不冒充「已修改」', () => {
    const t = describeRunResult(facts({ statementKind: 'update', affectedRows: 4, info: null }));
    expect(t.title).toBe('已影响 4 行');
    expect(t.detail).toBeNull();
    expect(t.title).not.toContain('已修改');
  });
});

describe('0.7.1 describeRunResult — INSERT / DELETE', () => {
  it('INSERT 带自增起始值', () => {
    const t = describeRunResult(facts({ statementKind: 'insert', affectedRows: 1, insertId: 5001 }));
    expect(t.title).toBe('已插入 1 行');
    expect(t.detail).toBe('自增 ID 起始 5,001');
  });

  it('INSERT 无自增（insertId null）不显示空次的「起始 0」', () => {
    const t = describeRunResult(facts({ statementKind: 'insert', affectedRows: 3, insertId: null }));
    expect(t.title).toBe('已插入 3 行');
    expect(t.detail).toBeNull();
  });

  it('批量 INSERT：按影响行数而不是语句数', () => {
    expect(describeRunResult(facts({ statementKind: 'insert', affectedRows: 50 })).title).toBe('已插入 50 行');
  });

  it('DELETE', () => {
    expect(describeRunResult(facts({ statementKind: 'delete', affectedRows: 3 })).title).toBe('已删除 3 行');
  });
});

describe('0.7.1 describeRunResult — DDL 与兜底', () => {
  it('🔴 DDL 说「执行成功」，绝不出现「0 行」', () => {
    const t = describeRunResult(facts({ statementKind: 'ddl', affectedRows: 0 }));
    expect(t.title).toBe('执行成功');
    expect(t.headline).not.toMatch(/\d+\s*行/);
  });

  it('判不出类型的语句说「执行完成」（不给错误口径）', () => {
    expect(describeRunResult(facts({ statementKind: 'other' })).title).toBe('执行完成');
  });

  it('取消：主文案只说已取消，内联带耗时（取消时行数没有意义）', () => {
    const t = describeRunResult(facts({ statementKind: 'update', cancelled: true, elapsedMs: 120 }));
    expect(t.title).toBe('已取消');
    expect(t.inline).toBe('已取消 · 120 ms');
  });
});

describe('0.7.1 describeRunResult — 警告', () => {
  it('INSERT 有警告：自增与警告同时出现在次信息里', () => {
    const t = describeRunResult(facts({ statementKind: 'insert', affectedRows: 1, insertId: 7, warnings: 2 }));
    expect(t.detail).toBe('自增 ID 起始 7 · 2 条警告');
  });

  it('warnings 为 0 不显示', () => {
    expect(describeRunResult(facts({ statementKind: 'delete', affectedRows: 1, warnings: 0 })).detail).toBeNull();
  });
});

describe('0.7.1 parseMatchedRows / parseChangedRows', () => {
  it('标准原文：matched 与 changed 分别取到', () => {
    const info = 'Rows matched: 5  Changed: 2  Warnings: 0';
    expect(parseMatchedRows(info)).toBe(5);
    expect(parseChangedRows(info)).toBe(2);
  });

  it('大小写与多余空格不影响', () => {
    expect(parseMatchedRows('rows matched:   12   changed: 3')).toBe(12);
    expect(parseChangedRows('rows matched:   12   changed: 3')).toBe(3);
  });

  it('没有 info / 没有该字段 → null（不猜）', () => {
    expect(parseMatchedRows(null)).toBeNull();
    expect(parseChangedRows(null)).toBeNull();
    expect(parseMatchedRows('Records: 1  Duplicates: 0')).toBeNull();
    expect(parseChangedRows('Records: 1  Duplicates: 0')).toBeNull();
  });
});
