import { describe, it, expect } from 'vitest';
import { fillParams, countPlaceholders } from './fillParams';

describe('fillParams · 只替换代码位置的占位符（T06/R07）', () => {
  it('普通占位符按序回填，字符串参数加引号、NULL/数字原样', () => {
    expect(fillParams('UPDATE t SET a = ?, b = ?, c = ? WHERE id = ?', ['x', null, 5, 9]))
      .toBe(`UPDATE t SET a = 'x', b = NULL, c = 5 WHERE id = 9`);
  });

  it('🔴 字符串字面量里的 ? 不被当占位符（旧实现会多吃一个参数）', () => {
    const sql = `UPDATE t SET note = 'why?' WHERE id = ?`;
    expect(fillParams(sql, [7])).toBe(`UPDATE t SET note = 'why?' WHERE id = 7`);
    // 旧实现 `/\?/g` 会得到 `note = 'why7'` 之类错位 —— 断言参数没被错位消费
    expect(countPlaceholders(sql)).toBe(1);
  });

  it('🔴 反引号标识符里的 ? 不被替换', () => {
    const sql = 'SELECT `col?x` FROM t WHERE id = ?';
    expect(fillParams(sql, [1])).toBe('SELECT `col?x` FROM t WHERE id = 1');
    expect(countPlaceholders(sql)).toBe(1);
  });

  it('双引号标识符/字符串里的 ? 不被替换', () => {
    const sql = 'SELECT "a?b" FROM t WHERE id = ?';
    expect(fillParams(sql, [2])).toBe('SELECT "a?b" FROM t WHERE id = 2');
  });

  it('字符串里的二次引号转义不会被提前闭合', () => {
    const sql = `UPDATE t SET a = 'it''s ? here' WHERE id = ?`;
    expect(fillParams(sql, [3])).toBe(`UPDATE t SET a = 'it''s ? here' WHERE id = 3`);
  });

  it('字符串里的反斜线转义不会提前闭合', () => {
    const sql = `UPDATE t SET a = 'x\\'?y' WHERE id = ?`;
    expect(fillParams(sql, [4])).toBe(`UPDATE t SET a = 'x\\'?y' WHERE id = 4`);
  });

  it('行注释 -- 与 # 里的 ? 不被替换', () => {
    expect(fillParams('-- 说明：这里有 ? 个\nSELECT ?', ['v'])).toBe('-- 说明：这里有 ? 个\nSELECT \'v\'');
    expect(fillParams('# 说明 ?\nSELECT ?', ['v'])).toBe("# 说明 ?\nSELECT 'v'");
  });

  it('`--` 紧跟数字（5--3）不被误当注释', () => {
    const sql = 'SELECT 5--3, ?';
    // 若把 --3 当注释，后面的 ? 会被吞掉
    expect(countPlaceholders(sql)).toBe(1);
    expect(fillParams(sql, [8])).toBe('SELECT 5--3, 8');
  });

  it('块注释里的 ? 不被替换', () => {
    expect(fillParams('/* ? ? */ SELECT ?', [1])).toBe('/* ? ? */ SELECT 1');
  });

  it('字符串值的单引号按 SQL 规则翻倍', () => {
    expect(fillParams('UPDATE t SET a = ?', ["O'Brien"])).toBe(`UPDATE t SET a = 'O''Brien'`);
  });

  it('二进制参数渲染为 X\'..\'', () => {
    expect(fillParams('INSERT INTO t VALUES (?)', [new Uint8Array([0xde, 0xad])])).toBe("INSERT INTO t VALUES (X'DEAD')");
  });

  it('占位符多于参数时保留 ?（让不一致可见，不悄悄填 NULL）', () => {
    expect(fillParams('SELECT ? , ?', [1])).toBe('SELECT 1 , ?');
  });

  it('占位符数量统计与真实绑定一致（典型 UPDATE 全字段）', () => {
    const sql = 'UPDATE `order_db`.`t` SET `a` = ?, `b` = ? WHERE `id` = ?';
    expect(countPlaceholders(sql)).toBe(3);
    expect(fillParams(sql, [1, 2, 3])).toBe('UPDATE `order_db`.`t` SET `a` = 1, `b` = 2 WHERE `id` = 3');
  });
});
