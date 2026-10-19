import { describe, it, expect } from 'vitest';
import type { ColumnMeta, TableMeta } from '@dbstudio/core-schema-cache';
import {
  resolveEditability,
  NO_LOCATE_KEY_MESSAGE,
  READ_ONLY_CONN_MESSAGE,
} from './editability.js';

function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'int',
    nullable: false,
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

function table(columns: ColumnMeta[]): TableMeta {
  return {
    name: 'orders',
    kind: 'table',
    comment: null,
    estimatedRows: null,
    engine: 'InnoDB',
    collation: null,
    columns,
  };
}

const WITH_PK = table([col('id', { isPrimaryKey: true }), col('note')]);
const WITHOUT_KEY = table([col('a'), col('b')]);

describe('resolveEditability（T14）', () => {
  it('有定位键 + 非只读连接 → 可写', () => {
    const r = resolveEditability(WITH_PK, false);
    expect(r).toEqual({ locatable: true, writable: true, reason: 'ok', message: '' });
  });

  it('🔴 有定位键 + 只读连接 → locatable 仍为 true，但 writable=false 且原因指向连接', () => {
    const r = resolveEditability(WITH_PK, true);
    // 关键：两项必须**分开**
    expect(r.locatable).toBe(true);
    expect(r.writable).toBe(false);
    expect(r.reason).toBe('read-only-conn');
    expect(r.message).toBe(READ_ONLY_CONN_MESSAGE);
  });

  it('无定位键 + 非只读连接 → 不可写，原因指向表结构（不是连接）', () => {
    const r = resolveEditability(WITHOUT_KEY, false);
    expect(r.locatable).toBe(false);
    expect(r.writable).toBe(false);
    expect(r.reason).toBe('no-locate-key');
    expect(r.message).toBe(NO_LOCATE_KEY_MESSAGE);
  });

  it('🔴 无定位键 + 只读连接 → 原因取「表结构」而不是「只读连接」', () => {
    // 两种原因同时成立时，表结构问题是更根本的（换连接也解决不了）
    const r = resolveEditability(WITHOUT_KEY, true);
    expect(r.reason).toBe('no-locate-key');
    expect(r.locatable).toBe(false);
  });

  it('反例：无激活表（null/undefined）一律不可写，且不得抛异常', () => {
    for (const t of [null, undefined]) {
      const r = resolveEditability(t, false);
      expect(r.writable).toBe(false);
      expect(r.locatable).toBe(false);
      expect(r.reason).toBe('no-locate-key');
    }
    // 只读连接 + 无激活表：仍然走「无定位键」分支（没有表谈不上可写）
    expect(resolveEditability(null, true).writable).toBe(false);
  });

  it('反例：唯一键（非主键）也算有定位键', () => {
    const uniq = table([col('code', { isUnique: true }), col('v')]);
    expect(resolveEditability(uniq, false).writable).toBe(true);
    expect(resolveEditability(uniq, true).reason).toBe('read-only-conn');
  });
});
