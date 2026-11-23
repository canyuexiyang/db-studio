import { describe, expect, it } from 'vitest';
import { parseMysqlUrl } from './index.js';

describe('parseMysqlUrl（0.10.0 P2-08）', () => {
  it('拆出 host/port/user/password/database', () => {
    expect(parseMysqlUrl('mysql://dev:p%40ss@127.0.0.1:3307/shop')).toEqual({
      host: '127.0.0.1', port: 3307, user: 'dev', password: 'p@ss', database: 'shop',
    });
  });
  it('默认端口 3306，无密码/无库为 null', () => {
    expect(parseMysqlUrl('mysql://root@localhost')).toEqual({
      host: 'localhost', port: 3306, user: 'root', password: null, database: null,
    });
  });
  it('mariadb:// 也接受；非 MySQL 协议拒绝', () => {
    expect(parseMysqlUrl('mariadb://u:p@h:3306/d')?.host).toBe('h');
    expect(parseMysqlUrl('postgres://u:p@h/d')).toBeNull();
    expect(parseMysqlUrl('not a url')).toBeNull();
  });
  it('IPv6 方括号剥掉', () => {
    expect(parseMysqlUrl('mysql://u:p@[::1]:3306/d')?.host).toBe('::1');
  });
});
