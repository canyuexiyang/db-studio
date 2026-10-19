import { describe, it, expect } from 'vitest';
import type { TreeNode } from '@dbstudio/core-tree-view';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { collectObjects, collectConnNames, scopeFromActiveKey } from './objectBrowserModel';

/** 造一张表的 TableMeta（测试只关心 name/kind，其余字段给足形状） */
function table(name: string, kind: TableMeta['kind'] = 'table'): TableMeta {
  return { name, kind, columns: [] } as unknown as TableMeta;
}

/** 造「连接 → 库 → kind → 对象」四层子树（与 core-tree-view 的 key 口径一致） */
function connSubtree(connId: string, connName: string, db: string, tables: string[], kind: TableMeta['kind'] = 'table'): TreeNode {
  return {
    key: `conn:${connId}`,
    kind: 'connection',
    label: connName,
    children: [
      {
        key: `db:${connId}:${db}`,
        kind: 'database',
        label: db,
        database: db,
        children: [
          {
            key: `kind:${connId}:${db}:${kind}`,
            kind: 'kind',
            label: '表',
            database: db,
            objectKind: kind,
            badge: tables.length,
            children: tables.map((t) => ({
              key: `obj:${connId}:${db}:${t}`,
              kind: 'object' as const,
              label: t,
              database: db,
              table: table(t, kind),
            })),
          },
        ],
      },
    ],
  };
}

/**
 * T02/R02 场景：两个连接各有一个 `order_db`，且同名表 `users`/`orders`。
 * 旧实现（只比 database）在作用域命中时会返回 4 条并出现重名 —— 本组断言直接钉死。
 */
function twoSameNameDbs(): TreeNode[] {
  return [
    connSubtree('c1', 'prod_order', 'order_db', ['users', 'orders']),
    connSubtree('c2', 'dev_order', 'order_db', ['users', 'orders']),
  ];
}

describe('collectObjects · 作用域按 (connId, database) 归属（T02/R02）', () => {
  it('scope=null 时列全部连接的对象，并带上连接名', () => {
    const out = collectObjects(twoSameNameDbs(), null, null, collectConnNames(twoSameNameDbs()));
    expect(out).toHaveLength(4);
    const names = out.map((o) => `${o.connName}/${o.database}.${o.name}`);
    // 排序：连接名 → 库名 → 类别 → 表名；dev_order 在 prod_order 之前
    expect(names).toEqual([
      'dev_order/order_db.orders',
      'dev_order/order_db.users',
      'prod_order/order_db.orders',
      'prod_order/order_db.users',
    ]);
  });

  it('🔴 选中 c2 的 order_db 时不得混入 c1 的对象（旧实现会返回 4 条）', () => {
    const out = collectObjects(twoSameNameDbs(), { connId: 'c2', database: 'order_db' }, null, {});
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.connId === 'c2')).toBe(true);
    expect(out.every((o) => o.key.startsWith('obj:c2:'))).toBe(true);
  });

  it('🔴 选中 c1 的 order_db 时只列 c1，且无重名条目', () => {
    const out = collectObjects(twoSameNameDbs(), { connId: 'c1', database: 'order_db' }, null, {});
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.key)).toEqual(['obj:c1:order_db:orders', 'obj:c1:order_db:users']);
    const keySet = new Set(out.map((o) => o.key));
    expect(keySet.size).toBe(out.length);
  });

  it('connId 匹配但库名不同 → 不命中', () => {
    const roots = [
      connSubtree('c1', 'prod', 'order_db', ['users']),
      connSubtree('c1', 'prod', 'other_db', ['logs']),
    ];
    const out = collectObjects(roots, { connId: 'c1', database: 'other_db' }, null, {});
    expect(out.map((o) => o.name)).toEqual(['logs']);
  });

  it('onlyKind 过滤在作用域内继续生效', () => {
    const roots = [
      connSubtree('c1', 'prod', 'd1', ['users'], 'table'),
      connSubtree('c1', 'prod', 'd1', ['v_users'], 'view'),
    ];
    const out = collectObjects(roots, { connId: 'c1', database: 'd1' }, 'view', {});
    expect(out.map((o) => o.name)).toEqual(['v_users']);
  });
});

describe('collectConnNames / scopeFromActiveKey', () => {
  it('从连接节点 label 建立 connId → 连接名映射', () => {
    expect(collectConnNames(twoSameNameDbs())).toEqual({ c1: 'prod_order', c2: 'dev_order' });
  });

  it('kind/db 节点 key 反解作用域，其余为 null', () => {
    expect(scopeFromActiveKey('kind:c1:order_db:table')).toEqual({ connId: 'c1', database: 'order_db', onlyKind: 'table' });
    expect(scopeFromActiveKey('db:c1:order_db')).toEqual({ connId: 'c1', database: 'order_db', onlyKind: null });
    expect(scopeFromActiveKey('conn:c1')).toBeNull();
    expect(scopeFromActiveKey(null)).toBeNull();
  });
});
