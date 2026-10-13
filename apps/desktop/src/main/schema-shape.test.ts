/**
 * schemaShapeChanged 的断言纪律（沿用 AGENTS.md §验证方法论）：
 *
 * 1. **每条断言先问「此刻基线是什么」** —— 只写"相同则 false"的恒真断言等于没测。
 *    下面每条都配一个**错误输入**用例（多一张表 / 换类别 / 少一个库），
 *    确认它在错误输入上会红，否则断言本身有问题。
 * 2. **不许用同一份数据造before/after** —— 那是"照被测代码的假设实现替身"的变体。
 */

import { describe, it, expect } from 'vitest';
import { schemaShapeChanged } from './schema-shape';
import type { DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';

function table(name: string, kind: TableMeta['kind'] = 'table'): TableMeta {
  return {
    name,
    kind,
    comment: null,
    estimatedRows: null,
    engine: 'InnoDB',
    collation: null,
    columns: [],
  };
}

function db(name: string, tables: TableMeta[]): DatabaseMeta {
  return { name, charset: 'utf8mb4', collation: 'utf8mb4_general_ci', tables };
}

describe('schemaShapeChanged', () => {
  it('完全相同（两次 introspect 的同一份库）→ 无变化', () => {
    const a = [db('shop', [table('orders'), table('users')])];
    // 独立构造的第二份，不是同一个引用 —— 排除"引用相同所以相等"这种假绿
    const b = [db('shop', [table('orders'), table('users')])];
    expect(schemaShapeChanged(a, b)).toBe(false);
  });

  it('🔴 错误输入：多了一张新表 → 必须报变化（若此条红了说明上面那条是恒真）', () => {
    const before = [db('shop', [table('orders')])];
    const after = [db('shop', [table('orders'), table('payments')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });

  it('🔴 错误输入：新增一个库 → 必须报变化', () => {
    const before = [db('shop', [table('orders')])];
    const after = [db('shop', [table('orders')]), db('crm', [table('leads')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });

  it('🔴 错误输入：同名的表换了类别（表 → 视图）→ 必须报变化', () => {
    const before = [db('shop', [table('v_user', 'table')])];
    const after = [db('shop', [table('v_user', 'view')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });

  it('🔴 错误输入：少了一张表（被删）→ 必须报变化', () => {
    const before = [db('shop', [table('orders'), table('legacy_log')])];
    const after = [db('shop', [table('orders')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });

  it('不因统计值抖动而报变化（TABLE_ROWS 是估算值，不能算进指纹）', () => {
    const before = [db('shop', [{ ...table('orders'), estimatedRows: 1000 }])];
    const after = [db('shop', [{ ...table('orders'), estimatedRows: 1042 }])];
    expect(schemaShapeChanged(before, after)).toBe(false);
  });

  it('before 为 null（首次快照兜底）且有内容 → 报变化', () => {
    expect(schemaShapeChanged(null, [db('shop', [table('orders')])])).toBe(true);
  });

  it('两边都空→ 无变化（不该因为"空对空"推一轮渲染）', () => {
    expect(schemaShapeChanged([], [])).toBe(false);
    expect(schemaShapeChanged(null, null)).toBe(false);
  });

  it('顺序变化也算变化（树按顺序渲染，重排对用户可见）', () => {
    const before = [db('shop', [table('a'), table('b')])];
    const after = [db('shop', [table('b'), table('a')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });

  it('库名与表名恰好互为前缀/含分隔符字符时不会误判相同', () => {
    // 分隔符选的是控制字符，标识符里不可能出现 —— 这条守住"指纹不会撞车"
    const before = [db('a', [table('b')])];
    const after = [db('ab', [table('b')])];
    expect(schemaShapeChanged(before, after)).toBe(true);
  });
});