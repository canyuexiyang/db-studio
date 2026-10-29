import { describe, it, expect } from 'vitest';
import { RECENT_TABLES_LIMIT, recordTableUsed, tableMemoryKey } from './recentTables';

describe('tableMemoryKey', () => {
  it('连接/库/表三段拼键 —— 两连接同名表不串', () => {
    expect(tableMemoryKey('c1', 'db', 'users')).toBe('c1:db:users');
    expect(tableMemoryKey('c2', 'db', 'users')).not.toBe(tableMemoryKey('c1', 'db', 'users'));
  });
});

describe('recordTableUsed', () => {
  it('写入时间戳且不修改入参（纯函数）', () => {
    const before: Record<string, number> = { 'c1:db:users': 100 };
    const next = recordTableUsed(before, 'c1:db:orders', 200);
    expect(next['c1:db:orders']).toBe(200);
    expect(before['c1:db:orders']).toBeUndefined();
  });

  it('重复打开同一张表 → 更新为最新时间（不是保留第一次）', () => {
    const next = recordTableUsed({ 'c1:db:users': 100 }, 'c1:db:users', 500);
    expect(next['c1:db:users']).toBe(500);
    expect(Object.keys(next)).toHaveLength(1);
  });

  it('超过上限按最旧淘汰，且只淘汰一条', () => {
    const map: Record<string, number> = {};
    for (let i = 0; i < 3; i++) map[`k${i}`] = i + 1;
    const next = recordTableUsed(map, 'k3', 99, 3);
    expect(Object.keys(next)).toHaveLength(3);
    expect(next.k0).toBeUndefined(); // 最旧
    expect(next.k1).toBe(2);
    expect(next.k3).toBe(99);
  });

  it('默认上限是 300（防止 localStorage 无限膨胀）', () => {
    expect(RECENT_TABLES_LIMIT).toBe(300);
  });
});
