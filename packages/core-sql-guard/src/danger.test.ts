import { describe, it, expect } from 'vitest';
import { classifyDanger } from './index.js';

describe('classifyDanger（危险操作分级）', () => {
  it('普通 SELECT → none', () => {
    const r = classifyDanger('SELECT * FROM t WHERE id = 1');
    expect(r.level).toBe('none');
  });

  it('带 WHERE 的 UPDATE/DELETE → none', () => {
    expect(classifyDanger("UPDATE t SET a = 1 WHERE id = 2").level).toBe('none');
    expect(classifyDanger('DELETE FROM t WHERE id = 3').level).toBe('none');
  });

  it('无 WHERE 的 UPDATE → confirm', () => {
    const r = classifyDanger('UPDATE t SET a = 1');
    expect(r.level).toBe('confirm');
    expect(r.reason).toContain('UPDATE');
    expect(r.reason).toContain('全部行');
    expect(r.statements.length).toBe(1);
  });

  it('无 WHERE 的 DELETE → confirm', () => {
    const r = classifyDanger('DELETE FROM t');
    expect(r.level).toBe('confirm');
    expect(r.reason).toContain('DELETE');
    expect(r.requireName).toBe('t');
  });

  it('TRUNCATE → confirm + requireName=表名', () => {
    const r = classifyDanger('TRUNCATE TABLE orders');
    expect(r.level).toBe('confirm');
    expect(r.requireName).toBe('orders');
    expect(r.reason).toContain('清空全表');
  });

  it('DROP TABLE → confirm + requireName=表名', () => {
    const r = classifyDanger('DROP TABLE `orders`');
    expect(r.level).toBe('confirm');
    expect(r.requireName).toBe('orders');
  });

  it('DROP DATABASE → 直接 danger（最高级）', () => {
    const r = classifyDanger('DROP DATABASE mydb');
    expect(r.level).toBe('danger');
    expect(r.requireName).toBe('mydb');
    expect(r.reason).toContain('整个库');
  });

  it('带库名前缀的表名只取表名部分', () => {
    const r = classifyDanger('DELETE FROM app_db.orders');
    expect(r.requireName).toBe('orders');
  });

  it('多语句中混一条危险语句 → 只列那一条', () => {
    const r = classifyDanger('SELECT 1; TRUNCATE TABLE t2; SELECT 2');
    expect(r.level).toBe('confirm');
    expect(r.statements.length).toBe(1);
    expect(r.statements[0]).toContain('TRUNCATE');
  });

  it('解析失败 → none（不误报；只读拦截是 checkReadOnly 的职责）', () => {
    const r = classifyDanger('this is not sql at all');
    expect(r.level).toBe('none');
  });

  it('注释里的 DROP 不误报', () => {
    const r = classifyDanger('SELECT 1 -- DROP TABLE t');
    expect(r.level).toBe('none');
  });

  it('INSERT → none（导入/写入不在危险清单）', () => {
    expect(classifyDanger("INSERT INTO t (a) VALUES (1)").level).toBe('none');
  });

  it('ALTER → none（表设计器有自己的确认流）', () => {
    expect(classifyDanger('ALTER TABLE t ADD COLUMN x int').level).toBe('none');
  });
});
