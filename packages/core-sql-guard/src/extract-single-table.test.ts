/**
 * extractSingleTable 单测（A12 查询结果写回的目标检测）
 *
 * 设计原则：保守启发式 —— 漏放（返回 null）只是少一个编辑入口，
 * 误放（把 JOIN/聚合结果标成单表）会让用户编辑到错误映射的行。
 * 所以这组测试的重心是「所有可疑形态都必须返回 null」。
 */

import { describe, expect, it } from 'vitest';
import { extractSingleTable } from './index.js';

describe('extractSingleTable —— 单表 SELECT 识别', () => {
  it('裸表 SELECT * → 命中，database 为 null', () => {
    expect(extractSingleTable('SELECT * FROM users')).toEqual({ database: null, table: 'users' });
  });

  it('带库前缀 → database 解析出来', () => {
    expect(extractSingleTable('SELECT id, name FROM mydb.users WHERE id = 1')).toEqual({
      database: 'mydb',
      table: 'users',
    });
  });

  it('ORDER BY / LIMIT 不影响判定', () => {
    expect(extractSingleTable('SELECT id FROM users ORDER BY id DESC LIMIT 10')).toEqual({
      database: null,
      table: 'users',
    });
  });

  it('反引号表名与库名', () => {
    expect(extractSingleTable('SELECT * FROM `my-db`.`order`')).toEqual({
      database: 'my-db',
      table: 'order',
    });
  });

  it('别名不影响命中', () => {
    expect(extractSingleTable('SELECT u.id FROM users AS u WHERE u.id > 1')).toEqual({
      database: null,
      table: 'users',
    });
  });
});

describe('extractSingleTable —— 可疑形态全部拒绝（fail-closed）', () => {
  it('JOIN 两表 → null', () => {
    expect(extractSingleTable('SELECT * FROM a JOIN b ON a.id = b.id')).toBeNull();
  });

  it('逗号连接 → null', () => {
    expect(extractSingleTable('SELECT * FROM a, b')).toBeNull();
  });

  it('聚合函数 → null', () => {
    expect(extractSingleTable('SELECT COUNT(*) FROM users')).toBeNull();
    expect(extractSingleTable('SELECT MAX(id) FROM users')).toBeNull();
  });

  it('派生表（子查询作为 FROM）→ null', () => {
    expect(extractSingleTable('SELECT * FROM (SELECT id FROM users) x')).toBeNull();
  });

  it('DISTINCT / GROUP BY / HAVING → null', () => {
    expect(extractSingleTable('SELECT DISTINCT id FROM users')).toBeNull();
    expect(extractSingleTable('SELECT id FROM users GROUP BY id')).toBeNull();
    expect(extractSingleTable('SELECT id FROM users GROUP BY id HAVING id > 1')).toBeNull();
  });

  it('CTE（WITH）→ null', () => {
    expect(extractSingleTable('WITH t AS (SELECT 1) SELECT * FROM t')).toBeNull();
  });

  it('算术表达式列 → null', () => {
    expect(extractSingleTable('SELECT price * 2 AS p FROM items')).toBeNull();
  });

  it('非 SELECT / 多语句 / 解析失败 → null', () => {
    expect(extractSingleTable('UPDATE users SET id = 1')).toBeNull();
    expect(extractSingleTable('SELECT 1; SELECT 2')).toBeNull();
    expect(extractSingleTable('SHOW TABLES')).toBeNull();
    expect(extractSingleTable('')).toBeNull();
  });
});
