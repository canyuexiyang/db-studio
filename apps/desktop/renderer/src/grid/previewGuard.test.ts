import { describe, it, expect } from 'vitest';
import { hasWhereClause, leadingKeyword, previewRequiresText } from './previewGuard';

describe('leadingKeyword', () => {
  it('跳过 -- 注释行取首关键字', () => {
    expect(leadingKeyword('-- 更新 users 第 3 行\nUPDATE `users` SET a = ?')).toBe('update');
    expect(leadingKeyword('--DELETE 是描述不是语句\n--第二行\nDELETE FROM t')).toBe('delete');
  });

  it('只有注释 / 空串时返回空串（不抛错）', () => {
    expect(leadingKeyword('-- 只有注释')).toBe('');
    expect(leadingKeyword('')).toBe('');
  });
});

describe('hasWhereClause', () => {
  it('大小写不敏感', () => {
    expect(hasWhereClause('UPDATE t SET a = 1 WHERE id = 2')).toBe(true);
    expect(hasWhereClause('update t set a = 1 where id = 2')).toBe(true);
  });

  it('无 WHERE 时为 false —— 这是「全表覆盖」的信号', () => {
    expect(hasWhereClause('UPDATE t SET a = 1')).toBe(false);
  });
});

describe('previewRequiresText（P0-5 第三层判定）', () => {
  const del = { sql: 'DELETE FROM `order_db`.`orders` WHERE `id` = ?', kind: 'delete' as const };
  const updWhere = { sql: 'UPDATE `order_db`.`orders` SET `a` = ? WHERE `id` = ?', kind: 'update' as const };
  const updNoWhere = { sql: 'UPDATE `order_db`.`orders` SET `a` = 1', kind: 'update' as const };
  const ins = { sql: 'INSERT INTO `order_db`.`orders` (`a`) VALUES (?)', kind: 'insert' as const };

  it('生产连接上删行 → 必须输表名', () => {
    expect(previewRequiresText([del], { isProduction: true, tableName: 'orders' })).toBe('orders');
  });

  it('生产连接上的无 WHERE UPDATE → 必须输表名', () => {
    expect(previewRequiresText([updNoWhere], { isProduction: true, tableName: 'orders' })).toBe('orders');
  });

  it('生产连接上的带 WHERE UPDATE / INSERT → 不升级（不加无谓摩擦）', () => {
    expect(previewRequiresText([updWhere], { isProduction: true, tableName: 'orders' })).toBeNull();
    expect(previewRequiresText([ins], { isProduction: true, tableName: 'orders' })).toBeNull();
  });

  it('非生产连接 → 一律不升级（即使混着 DELETE）', () => {
    expect(previewRequiresText([del, updNoWhere], { isProduction: false, tableName: 'orders' })).toBeNull();
  });

  it('kind 缺失时按 SQL 首关键字推断', () => {
    expect(
      previewRequiresText([{ sql: '-- 删除\nDELETE FROM `t` WHERE `id` = ?' }], {
        isProduction: true,
        tableName: 't',
      }),
    ).toBe('t');
  });

  it('表名未知（空串）时不升级 —— 输空串等于没有门槛', () => {
    expect(previewRequiresText([del], { isProduction: true, tableName: '' })).toBeNull();
  });

  it('空语句清单 → 不升级', () => {
    expect(previewRequiresText([], { isProduction: true, tableName: 'orders' })).toBeNull();
  });
});
