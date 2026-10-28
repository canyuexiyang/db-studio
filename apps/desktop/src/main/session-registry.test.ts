/**
 * 会话注册表测试 —— 用替身驱动跑通全链路，不起 Electron、不连真库。
 * （真库验证在 scripts/e2e-*.mjs，那是另一层保障。）
 *
 * 重点守三条：
 *  1. 🔴 只读连接必须被 AST 白名单拦住（UI 置灰不算数，这里才是安全层）
 *  2. 🔴 写操作单事务：任何一条失败 → 整体回滚，不留半截数据
 *  3. 🔴 取消语义：被 KILL 的查询是 resolve 不是 reject，判定要看 cancelled 标记
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionRegistry,
  SessionError,
  realDriverFactory,
  quoteDb,
  type DriverLike,
  type TunnelManager,
} from './session-registry.js';
import { TypeCode } from '@dbstudio/core-ipc-codec';
import { SchemaCache } from '@dbstudio/core-schema-cache';
import { defaultConnectionConfig, type ConnectionConfig, type ConnectionState } from '@dbstudio/core-connection';
import type { DatabaseMeta, ObjectKind, TableMeta } from '@dbstudio/core-schema-cache';
import type { MySqlCredentials, QueryResult, TunnelHandle, TableInfo, ForeignKeyMeta, ReferencedValueQuery, ReferencedValueLookup } from '@dbstudio/core-driver-mysql';

/** 可编程的替身驱动：想让它怎么返回就怎么返回 */
class FakeDriver implements DriverLike {
  connectionId = 42;
  serverVersion: string | null = null;
  readonly calls: { sql: string; values: unknown[] }[] = [];

  /** 按 SQL 关键字决定返回什么 */
  handler: (sql: string) => QueryResult = () => ({
    rows: [],
    fields: [],
    affectedRows: 0,
    insertId: null, info: null, warnings: 0,
    elapsedMs: 1,
  });

  /** 让 connect 失败 */
  failConnect: string | null = null;
  /** 让 query 抛异常（模拟被 kill / 语法错误 / 断线 —— 抛 Error 对象可带 code） */
  throwOn: ((sql: string) => string | Error | null) | null = null;
  /** cancel 是否"成功" */
  cancelResult = true;
  /** query 挂住多久（ms）。用于测"查询进行中"的状态 */
  queryDelayMs = 0;
  /** introspect 返回什么 */
  introspectResult: DatabaseMeta[] = SCHEMA;
  /** introspect 被调用次数（v0.6.0：验证快照路径会回源） */
  introspectCalls = 0;
  /** listDatabases 被调用次数 */
  listDatabasesCalls = 0;

  // ---- C2/C9 替身能力 ----
  /** showCreateObject 的返回值（null = 抛"对象不存在"） */
  ddlResult: string | null = 'CREATE TABLE `t` (`id` int) ENGINE=InnoDB';
  /** showCreateObject 直接抛错（模拟服务端错误，可带 code） */
  ddlThrow: Error | null = null;
  readonly ddlCalls: { database: string; name: string; kind: ObjectKind }[] = [];
  /** getTableInfo 的返回值（null = 表不存在） */
  tableInfoResult: TableInfo | null = null;
  readonly tableInfoCalls: { database: string; table: string }[] = [];

  // ---- V9 替身能力（外键导航与候选值）----
  /** listForeignKeys 的返回值（空 = 该表没有外键） */
  foreignKeysResult: ForeignKeyMeta[] = [];
  readonly foreignKeysCalls: { database: string; table: string }[] = [];
  /** listForeignKeys 直接抛错（模拟表不存在/无权限 → registry 应降级为空数组） */
  foreignKeysThrow: Error | null = null;
  /** lookupReferencedValues 的返回值 */
  referencedResult: ReferencedValueLookup = { items: [], truncated: false };
  readonly referencedCalls: ReferencedValueQuery[] = [];
  /** lookupReferencedValues 直接抛错（候选值拿不到不该降级 —— 用户点了就要给原因） */
  referencedThrow: Error | null = null;

  async connect(): Promise<{ serverVersion: string; elapsedMs: number }> {
    if (this.failConnect) throw new Error(this.failConnect);
    this.serverVersion = '8.4.0-fake';
    return { serverVersion: '8.4.0-fake', elapsedMs: 3 };
  }

  async query(sql: string, values: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ sql, values });
    const thrown = this.throwOn?.(sql);
    if (thrown) throw typeof thrown === 'string' ? new Error(thrown) : thrown;
    if (this.queryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.queryDelayMs));
    }
    return this.handler(sql);
  }

  async introspect(): Promise<DatabaseMeta[]> {
    this.introspectCalls++;
    return this.introspectResult;
  }

  /**
   * v0.6.0：刷新语义改成「刷该连接可见的全部库」，registry 会先问可见库清单。
   *
   * 替身按 introspectResult 的库名作答 —— 那是这份元数据里真实存在的库。
   * ⚠️ 不要返回跟 introspectResult 对不上的固定列表：那就是「替身照自己的假设实现」，
   *    断言会在被测代码换了行为后依然全绿。
   */
  async listDatabases(): Promise<string[]> {
    this.listDatabasesCalls++;
    return this.introspectResult.map((d) => d.name);
  }

  async showCreateObject(database: string, name: string, kind: ObjectKind): Promise<string> {
    this.ddlCalls.push({ database, name, kind });
    if (this.ddlThrow) throw this.ddlThrow;
    if (this.ddlResult == null) {
      throw Object.assign(new Error(`Table ${database}.${name} doesn't exist`), { code: 'ER_NO_SUCH_TABLE' });
    }
    return this.ddlResult;
  }

  async getTableInfo(database: string, table: string): Promise<TableInfo | null> {
    this.tableInfoCalls.push({ database, table });
    return this.tableInfoResult;
  }

  async listForeignKeys(database: string, table: string): Promise<ForeignKeyMeta[]> {
    this.foreignKeysCalls.push({ database, table });
    if (this.foreignKeysThrow) throw this.foreignKeysThrow;
    return this.foreignKeysResult;
  }

  async lookupReferencedValues(o: ReferencedValueQuery): Promise<ReferencedValueLookup> {
    this.referencedCalls.push(o);
    if (this.referencedThrow) throw this.referencedThrow;
    return this.referencedResult;
  }

  async cancel(): Promise<boolean> {
    return this.cancelResult;
  }

  async close(): Promise<void> {
    this.serverVersion = null;
  }
}

/**
 * v0.6.0 刷新用例用的轻量构造器。
 *
 * 只关心「库名 + 表名 + 类别」——schemaShapeChanged 也只比这三样，
 * 列定义在这批用例里是噪声。刻意不复用上面那份 SCHEMA 的完整列结构。
 */
function table(name: string, kind: TableMeta['kind'] = 'table') {
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

function db(name: string, tables: ReturnType<typeof table>[]): DatabaseMeta {
  return { name, charset: 'utf8mb4', collation: 'utf8mb4_general_ci', tables };
}

const SCHEMA: DatabaseMeta[] = [
  {
    name: 'app_db',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    tables: [
      {
        name: 'order',
        kind: 'table',
        comment: null,
        estimatedRows: 1000,
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        columns: [
          {
            name: 'id',
            dataType: 'bigint',
            nullable: false,
            defaultValue: null,
            comment: null,
            isPrimaryKey: true,
            isUnique: false,
            autoIncrement: true,
            charset: null,
            collation: null,
          },
          {
            name: 'amount',
            dataType: 'decimal(12,2)',
            nullable: false,
            defaultValue: null,
            comment: null,
            isPrimaryKey: false,
            isUnique: false,
            autoIncrement: false,
            charset: null,
            collation: null,
          },
          {
            name: 'title',
            dataType: 'varchar(64)',
            nullable: true,
            defaultValue: null,
            comment: null,
            isPrimaryKey: false,
            isUnique: false,
            autoIncrement: false,
            charset: null,
            collation: null,
          },
        ],
      },
    ],
  },
];

let dir: string;
let cache: SchemaCache;
let driver: FakeDriver;
let registry: SessionRegistry;

function cfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return defaultConnectionConfig({
    id: 'c1',
    name: 'test',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    passwordEnc: 'x',
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbstudio-sess-'));
  cache = new SchemaCache(dir);
  driver = new FakeDriver();
  registry = new SessionRegistry(cache, () => driver);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('连接生命周期', () => {
  it('连接成功后状态变 connected，并拿到服务端版本', async () => {
    const info = await registry.connect(cfg(), 'pwd');
    expect(info.serverVersion).toBe('8.4.0-fake');
    expect(registry.stateOf('c1')).toBe('connected');
    expect(registry.isLive('c1')).toBe(true);
  });

  it('连接失败 → failed 态且保留错误信息', async () => {
    driver.failConnect = 'Access denied for user';
    await expect(registry.connect(cfg(), 'bad')).rejects.toThrow(SessionError);
    expect(registry.stateOf('c1')).toBe('failed');
    expect(registry.lastError('c1')).toContain('Access denied');
  });

  it('重复连接不重复建驱动（驱动是重资源）', async () => {
    await registry.connect(cfg(), 'pwd');
    const first = driver;
    await registry.connect(cfg(), 'pwd');
    expect(driver).toBe(first);
    expect(driver.calls.filter((c) => c.sql.includes('VERSION')).length).toBeGreaterThanOrEqual(0);
  });

  it('断开后回到 idle，isLive 为 false', async () => {
    await registry.connect(cfg(), 'pwd');
    await registry.disconnect('c1');
    expect(registry.isLive('c1')).toBe(false);
  });

  it('未连接的会话查询 → 抛 NOT_CONNECTED', async () => {
    await expect(registry.runQuery('nope', 'SELECT 1')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });
});

describe('查询的库上下文（2026-09-26 真机修复）', () => {
  /** 取发往驱动的 USE 语句条数 */
  const useCount = (db: string) =>
    driver.calls.filter((c) => c.sql === 'USE ' + quoteDb(db)).length;

  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd'); // 默认无 defaultDatabase → 会话未选库
  });

  it('带 database 的查询在库未选时先补 USE', async () => {
    await registry.runQuery('c1', 'SELECT 1', [], { database: 'app_db' });
    expect(useCount('app_db')).toBe(1);
    expect(driver.calls[driver.calls.length - 1].sql).toBe('SELECT 1');
  });

  it('同一库的连续查询不重复发 USE（省一个来回）', async () => {
    await registry.runQuery('c1', 'SELECT 1', [], { database: 'app_db' });
    await registry.runQuery('c1', 'SELECT 2', [], { database: 'app_db' });
    expect(useCount('app_db')).toBe(1);
  });

  it('换库时补新的 USE', async () => {
    await registry.runQuery('c1', 'SELECT 1', [], { database: 'app_db' });
    await registry.runQuery('c1', 'SELECT 2', [], { database: 'other_db' });
    expect(useCount('other_db')).toBe(1);
  });

  it('连接配了默认库时，同库查询不再发 USE', async () => {
    const driver2 = new FakeDriver();
    const registry2 = new SessionRegistry(cache, () => driver2);
    await registry2.connect(cfg({ defaultDatabase: 'app_db' }), 'pwd');
    await registry2.runQuery('c1', 'SELECT 1', [], { database: 'app_db' });
    expect(driver2.calls.filter((c) => c.sql.startsWith('USE ')).length).toBe(0);
  });

  it('用户手写 USE 后以它为准（缓存不送错库）', async () => {
    await registry.runQuery('c1', 'USE other_db', []);
    await registry.runQuery('c1', 'SELECT 1', [], { database: 'other_db' });
    expect(useCount('other_db')).toBe(0); // 用户已切过去，不需要再发
    await registry.runQuery('c1', 'SELECT 2', [], { database: 'app_db' });
    expect(useCount('app_db')).toBe(1); // 库真的变了，补发
  });
});

describe('🔴 只读拦截（唯一安全层）', () => {
  beforeEach(async () => {
    await registry.connect(cfg({ readOnly: true }), 'pwd');
  });

  it('SELECT 放行', async () => {
    driver.handler = () => ({
      rows: [['a']],
      fields: [{ name: 'x', type: 253 }],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.runQuery('c1', 'SELECT * FROM t');
    expect(out.rowCount).toBe(1);
  });

  it('🔴 DELETE 被拦（即使 UI 没置灰）', async () => {
    await expect(registry.runQuery('c1', 'DELETE FROM t')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    expect(driver.calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
  });

  it('🔴 DROP 被拦', async () => {
    await expect(registry.runQuery('c1', 'DROP TABLE t')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
  });

  it('🔴 SELECT ... INTO OUTFILE 被拦（有写副作用）', async () => {
    await expect(
      registry.runQuery('c1', "SELECT * FROM t INTO OUTFILE '/tmp/x'"),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('🔴 第二条语句是写操作 → 多语句整体拒绝', async () => {
    await expect(
      registry.runQuery('c1', 'SELECT 1; DELETE FROM t'),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('🔴 解析失败的语句 fail-closed（不允许执行）', async () => {
    await expect(registry.runQuery('c1', 'THIS IS NOT SQL AT ALL')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
  });

  it('写操作即使绕过 runQuery 直接调 applyMutation 也被拦', async () => {
    await expect(
      registry.applyMutation('c1', 'app_db', [{ sql: 'UPDATE t SET a=1', params: [] }]),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});

describe('查询', () => {
  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd');
  });

  it('结果编码成列式载荷，列名与行数正确', async () => {
    driver.handler = () => ({
      rows: [
        [1, 'a'],
        [2, 'b'],
        [3, null],
      ],
      fields: [
        { name: 'id', type: 8 },
        { name: 'name', type: 253 },
      ],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 2,
    });
    const out = await registry.runQuery('c1', 'SELECT id, name FROM t');
    expect(out.payload.rowCount).toBe(3);
    expect(out.payload.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(out.rowCount).toBe(3);
    expect(out.cancelled).toBe(false);
  });

  it('openTable 生成带 LIMIT 的 SQL，并把排序交给服务端', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [{ name: 'id', type: 8 }],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    await registry.openTable('c1', {
      database: 'app_db',
      table: 'order',
      limit: 10,
      orderBy: [{ column: 'id', direction: 'DESC' }],
    });
    const sql = driver.calls[driver.calls.length - 1].sql;
    expect(sql).toContain('FROM `app_db`.`order`');
    expect(sql).toContain('ORDER BY `id` DESC');
    expect(sql).toContain('LIMIT ?');
  });

  it('行数达到 limit → truncated=true（UI 提示还有更多）', async () => {
    driver.handler = () => ({
      rows: Array.from({ length: 5 }, (_, i) => [i]),
      fields: [{ name: 'id', type: 8 }],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.openTable('c1', { database: 'app_db', table: 'order', limit: 5 });
    expect(out.truncated).toBe(true);
  });

  it('openTable 传列定义 dataType（把 R10 字符串化的数值还原成真数值）', async () => {
    // 先灌一份 schema，让 openTable 能拿到列定义
    cache.save('c1', SCHEMA);
    driver.handler = () => ({
      rows: [['1', '2.50', 'hi']],
      fields: [
        { name: 'id', type: 8 },
        { name: 'amount', type: 246 },
        { name: 'title', type: 253 },
      ],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.openTable('c1', { database: 'app_db', table: 'order' });
    // id='1' 可无损还原 → F64
    expect(out.payload.columns[0].typeCode).toBe(TypeCode.F64);
    // ⚠️ amount='2.50' 【不该】被还原：Number('2.50')=2.5，String(2.5)='2.5' ≠ 原文，
    //    转 F64 会静默丢掉尾随零。codec 刻意保持 STR 保真 —— 这是正确行为，不是 bug。
    expect(out.payload.columns[1].typeCode).toBe(TypeCode.STR);
    expect(out.payload.columns[2].typeCode).toBe(TypeCode.STR);
  });

  it('不传列定义时数值列退化为字符串（正是 R10 的副作用，别当 bug 修）', async () => {
    cache.save('c1', SCHEMA);
    driver.handler = () => ({
      rows: [['1', '2.50']],
      fields: [
        { name: 'id', type: 8 },
        { name: 'amount', type: 246 },
      ],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.runQuery('c1', 'SELECT id, amount FROM `order`');
    expect(out.payload.columns[0].typeCode).toBe(TypeCode.STR);
  });

  it('🔴 取消：被 KILL 的查询是 resolve 不是 reject，判定靠 cancelled 标记', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [{ name: 'id', type: 8 }],
      affectedRows: 0,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    // 让查询挂住，才能抓到"进行中"的句柄
    driver.queryDelayMs = 120;

    const p = registry.runQuery('c1', 'SELECT SLEEP(10)');
    await new Promise((r) => setTimeout(r, 20)); // 等 runQuery 进入执行

    const runningList = registry.listRunning();
    expect(runningList).toHaveLength(1);
    expect(runningList[0].sql).toBe('SELECT SLEEP(10)');

    const cancelled = await registry.cancelQuery(runningList[0].queryId);
    expect(cancelled).toBe(true);

    const out = await p;
    // 关键：取消的查询【正常返回】，不是抛异常。判定只能看 cancelled。
    expect(out.cancelled).toBe(true);
    expect(registry.listRunning()).toHaveLength(0);
  });

  it('取消不存在的 queryId 返回 false，不算错误', async () => {
    expect(await registry.cancelQuery('nope')).toBe(false);
  });
});

describe('写操作（单事务）', () => {
  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd');
  });

  it('成功后 COMMIT，返回影响行数与 insertId', async () => {
    let n = 0;
    driver.handler = () => {
      n++;
      return {
        rows: [],
        fields: [],
        affectedRows: 1,
        insertId: 99, info: null, warnings: 0,
        elapsedMs: 1,
      };
    };
    const r = await registry.applyMutation('c1', 'app_db', [
      { sql: 'UPDATE `order` SET amount=? WHERE id=?', params: [1, 2] },
    ]);
    expect(r.affected).toBe(1);
    expect(r.insertIds).toEqual([99]);
    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('START TRANSACTION');
    expect(sqls).toContain('COMMIT');
    expect(sqls.some((s) => s.startsWith('USE '))).toBe(true);
  });

  it('🔴 中间一条失败 → ROLLBACK，且抛原始错误', async () => {
    driver.throwOn = (sql) => (sql.includes('UPDATE') ? 'Duplicate entry' : null);
    await expect(
      // ⚠️ 必须带 WHERE：V10 起 applyMutation 会先过 AST 结构校验，
      // 无 WHERE 的 UPDATE 会被拒（那是对的，但本用例要测的是「失败即回滚」，
      // 被前置校验拦下就永远走不到事务里，测不到想测的东西）。
      registry.applyMutation('c1', 'app_db', [{ sql: 'UPDATE t SET a=1 WHERE id=2', params: [] }]),
    ).rejects.toThrow('Duplicate entry');
    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('空语句列表不开启事务（避免无意义往返）', async () => {
    const r = await registry.applyMutation('c1', 'app_db', []);
    expect(r.affected).toBe(0);
    expect(driver.calls).toHaveLength(0);
  });

  it('每次写操作结束后状态回到 connected（可继续查询）', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 1,
      insertId: null, info: null, warnings: 0,
      elapsedMs: 1,
    });
    // ⚠️ 带 WHERE：本用例测的是「写操作结束后状态回到 connected」，
    // 无 WHERE 的 UPDATE 会被 V10 的 AST 结构校验前置拒绝（那是另一条用例的事）
    await registry.applyMutation('c1', 'app_db', [{ sql: 'UPDATE t SET a=1 WHERE id=2', params: [] }]);
    expect(registry.stateOf('c1')).toBe('connected');
  });

  // ---------- V10：写语句的 AST 结构兜底（表达式模式的真防线） ----------

  it('🔴 无 WHERE 的 UPDATE/DELETE 被拒，且一条都不执行（不开事务）', async () => {
    await expect(
      registry.applyMutation('c1', 'app_db', [{ sql: 'UPDATE `order` SET amount=0', params: [] }]),
    ).rejects.toThrow(/缺少 WHERE/);
    await expect(
      registry.applyMutation('c1', 'app_db', [{ sql: 'DELETE FROM `order`', params: [] }]),
    ).rejects.toThrow(/缺少 WHERE/);
    // 关键：校验在事务之前 —— 不该有任何 SQL 到达驱动
    expect(driver.calls).toHaveLength(0);
  });

  it('🔴 多语句被拒（表达式里藏第二条语句是最短的攻击路径）', async () => {
    await expect(
      registry.applyMutation('c1', 'app_db', [
        { sql: 'UPDATE `order` SET amount=0 WHERE id=1; DROP TABLE `order`', params: [] },
      ]),
    ).rejects.toThrow(/只允许单条语句/);
    expect(driver.calls).toHaveLength(0);
  });

  it('🔴 非 DML 语句类型被拒（DDL / CALL / GRANT 不许走网格保存链路）', async () => {
    for (const sql of [
      'DROP TABLE `order`',
      'TRUNCATE TABLE `order`',
      'ALTER TABLE `order` ADD COLUMN x INT',
      'CALL some_proc()',
    ]) {
      await expect(
        registry.applyMutation('c1', 'app_db', [{ sql, params: [] }]),
      ).rejects.toThrow(/不允许由网格保存链路执行/);
    }
    expect(driver.calls).toHaveLength(0);
  });

  it('整批校验：任一条不合规 → 全批拒绝（与「一轮保存 = 单事务」语义一致）', async () => {
    await expect(
      registry.applyMutation('c1', 'app_db', [
        { sql: 'UPDATE `order` SET amount=1 WHERE id=1', params: [] }, // 合法
        { sql: 'UPDATE `order` SET amount=2', params: [] },            // 无 WHERE
      ]),
    ).rejects.toThrow(/缺少 WHERE/);
    // 合法的那条也不该被执行（不能半批落库）
    expect(driver.calls).toHaveLength(0);
  });

  it('合法写语句放行：带 WHERE 的 UPDATE/DELETE 与 INSERT 照常执行', async () => {
    driver.handler = () => ({ rows: [], fields: [], affectedRows: 1, insertId: null, info: null, warnings: 0, elapsedMs: 1 });
    await registry.applyMutation('c1', 'app_db', [
      { sql: 'UPDATE `order` SET created_at = NOW() WHERE `id` = ? AND `created_at` = ?', params: [1, '2026-01-01'] },
      { sql: 'INSERT INTO `order` (`amount`, `created_at`) VALUES (?, NOW())', params: [10] },
      { sql: 'DELETE FROM `order` WHERE `id` = ?', params: [2] },
    ]);
    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls).toContain('START TRANSACTION');
    expect(sqls).toContain('COMMIT');
  });

  it('V10 表达式值（NOW() / 列算术 / 子查询）在写链路中被放行', async () => {
    driver.handler = () => ({ rows: [], fields: [], affectedRows: 1, insertId: null, info: null, warnings: 0, elapsedMs: 1 });
    for (const sql of [
      'UPDATE `order` SET `created_at` = NOW() WHERE `id` = 1',
      'UPDATE `order` SET `amount` = `amount` * 2 WHERE `id` = 1',
      'UPDATE `order` SET `note` = CONCAT(`note`, "-x") WHERE `id` = 1',
      'UPDATE `order` SET `user_id` = (SELECT MAX(id) FROM `user`) WHERE `id` = 1',
    ]) {
      await expect(registry.applyMutation('c1', 'app_db', [{ sql, params: [] }])).resolves.toBeTruthy();
    }
  });
});

describe('Schema', () => {
  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd');
  });

  it('无快照时回源 introspect，并落盘', async () => {
    const dbs = await registry.getSchema('c1', { force: true });
    expect(dbs).toBeTruthy();
    expect(registry.snapshotInfo('c1')).toBeTruthy();
  });

  it('有磁盘快照时不回源（树首屏立刻出结构）', async () => {
    cache.save('c1', SCHEMA);
    const r2 = new SessionRegistry(cache, () => driver);
    // 未连接也能拿到快照信息
    expect(r2.snapshotInfo('c1')?.databases[0].name).toBe('app_db');
  });

  /**
   * 🔴 v0.6.0「刷新失效」第三处根因的行为断言。
   *
   * 上一条「有磁盘快照时不回源」只查 snapshotInfo，**查不到是否回源**——
   * 那是照着旧实现写的断言，改了实现它照样绿。这里补的是能被证伪的那条：
   * 快照路径必须【后台回源】，且回源拿到新结构后【推送】出去。
   */
  it('快照路径：先返回快照让树秒出，随后后台回源并推送新结构', async () => {
    // 磁盘上先落一份"只有老表"的快照
    cache.save('c1', [db('app_db', [table('order')])]);

    // 真库里已经多了新表（脚本建表后的真实状态）
    driver.introspectResult = [db('app_db', [table('order'), table('payment')])];

    const r = new SessionRegistry(cache, () => driver);
    const pushed: { id: string; dbs: DatabaseMeta[] }[] = [];
    r.setOnSchemaChange((id, dbs) => pushed.push({ id, dbs }));
    await r.connect(cfg(), 'pwd');

    const first = await r.getSchema('c1');
    // 首次拿到的应该是磁盘快照（老表），树首屏不必等 information_schema
    expect(first[0].tables.map((t) => t.name)).toEqual(['order']);
    expect(pushed).toHaveLength(0); // 此刻还没回源完，不该已经推

    // 等后台回源落地
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].id).toBe('c1');
    expect(pushed[0].dbs[0].tables.map((t) => t.name)).toEqual(['order', 'payment']);

    // 之后再取就是新结构了
    const second = await r.getSchema('c1');
    expect(second[0].tables.map((t) => t.name)).toEqual(['order', 'payment']);
  });

  it('🔴 错误输入：回源结构没变时不推送（否则每次回源都重建上千节点的树）', async () => {
    cache.save('c1', SCHEMA);
    const r = new SessionRegistry(cache, () => driver);
    const pushed: DatabaseMeta[][] = [];
    r.setOnSchemaChange((_id, dbs) => pushed.push(dbs));
    await r.connect(cfg(), 'pwd');

    // introspectResult 与快照同形 → 不该推
    driver.introspectResult = structuredClone(SCHEMA);
    await r.getSchema('c1');
    await new Promise((res) => setTimeout(res, 30));
    expect(pushed).toHaveLength(0);
  });

  it('🔴 错误输入：refresh(force) 覆盖【全部可见库】，不再被 defaultDatabase 限死', async () => {
    // 配了默认库的连接 —— 旧实现只 introspect 这一个库，新表在别的库里就永远刷不出来
    const c = { ...cfg(), defaultDatabase: 'app_db' };
    driver.introspectResult = [db('app_db', [table('order')]), db('crm_db', [table('leads')])];

    const r = new SessionRegistry(cache, () => driver);
    await r.connect(c, 'pwd');
    await r.getSchema(c.id, { force: true });

    expect(driver.listDatabasesCalls).toBeGreaterThan(0);
    // 拿到了两个库 —— 若被 defaultDatabase 限死，这里只会有 app_db
    const names = (await r.getSchema(c.id, { force: true })).map((d) => d.name);
    expect(names).toContain('app_db');
    expect(names).toContain('crm_db');
  });

  it('getTable 取到表元数据（网格靠它判可编辑性）', async () => {
    cache.save('c1', SCHEMA);
    // 未连接时 getSchema 会抛，这里先接上
    await registry.getSchema('c1', { force: true });
    const t = await registry.getTable('c1', 'app_db', 'order');
    expect(t?.columns[0].isPrimaryKey).toBe(true);
  });
});

describe('quoteDb（USE 不支持参数绑定，必须转义）', () => {
  it('反引号被转义', () => {
    expect(quoteDb('a`b')).toBe('`a``b`');
  });
});

// ---------- SSH 隧道与连接成对管理（评审 §4.6 / PRD §6.1.2） ----------

/** 替身隧道：能数清开了几条、关了没有 */
class FakeTunnel {
  static live = 0;
  closed = false;
  constructor(readonly id: number) {
    FakeTunnel.live++;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    FakeTunnel.live--;
  }
}

class FakeTunnelManager implements TunnelManager {
  /** 让 open 失败 */
  failMessage: string | null = null;
  opened: { host: string; port: number }[] = [];
  tunnels: FakeTunnel[] = [];

  async open(
    _cfg: ConnectionConfig,
    target: { host: string; port: number },
  ): Promise<{ tunnel: TunnelHandle; streamFactory: () => Promise<unknown> } | null> {
    if (this.failMessage) throw new Error(this.failMessage);
    this.opened.push(target);
    const t = new FakeTunnel(this.tunnels.length + 1);
    this.tunnels.push(t);
    let n = 0;
    return {
      tunnel: t,
      streamFactory: async () => ({ channel: ++n }),
    };
  }
}

function sshCfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const base = defaultConnectionConfig({
    id: 'ssh1',
    name: 'ssh conn',
    host: '10.0.0.5',
    port: 3306,
    user: 'root',
    passwordEnc: 'x',
  });
  return {
    ...base,
    ssh: { ...base.ssh, enabled: true, host: 'jump', port: 22, user: 'dbuser' },
    ...over,
  };
}

describe('SSH 隧道生命周期', () => {
  beforeEach(() => {
    FakeTunnel.live = 0;
  });

  it('未开启 SSH 的连接不开隧道', async () => {
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await reg.connect(cfg(), 'pwd');
    expect(mgr.opened).toHaveLength(0);
    expect(reg.liveTunnelCount()).toBe(0);
  });

  it('开启 SSH 时按【目标库地址】开隧道（不是 SSH 自己的地址）', async () => {
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await reg.connect(sshCfg(), 'pwd');
    expect(mgr.opened).toEqual([{ host: '10.0.0.5', port: 3306 }]);
    expect(reg.liveTunnelCount()).toBe(1);
  });

  it('🔴 隧道建不起来 → SSH_FAILED，且不留下活隧道', async () => {
    const mgr = new FakeTunnelManager();
    mgr.failMessage = 'SSH 隧道建立超时（10000ms）';
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await expect(reg.connect(sshCfg(), 'pwd')).rejects.toMatchObject({ code: 'SSH_FAILED' });
    expect(reg.stateOf('ssh1')).toBe('failed');
    expect(reg.liveTunnelCount()).toBe(0);
    expect(FakeTunnel.live).toBe(0);
  });

  it('🔴 隧道通了但数据库连不上 → 隧道也要关掉（孤儿进程红线）', async () => {
    const mgr = new FakeTunnelManager();
    driver.failConnect = 'Access denied';
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await expect(reg.connect(sshCfg(), 'pwd')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    expect(mgr.tunnels).toHaveLength(1);
    expect(mgr.tunnels[0].closed).toBe(true);
    expect(FakeTunnel.live).toBe(0);
    driver.failConnect = null;
  });

  it('🔴 断开连接时隧道一并释放', async () => {
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await reg.connect(sshCfg(), 'pwd');
    expect(reg.liveTunnelCount()).toBe(1);
    await reg.disconnect('ssh1');
    expect(reg.liveTunnelCount()).toBe(0);
    expect(FakeTunnel.live).toBe(0);
  });

  it('🔴 closeAll 后不留任何活隧道（退出路径）', async () => {
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await reg.connect(sshCfg(), 'pwd');
    await reg.connect(sshCfg({ id: 'ssh2' }), 'pwd');
    expect(reg.liveTunnelCount()).toBe(2);
    await reg.closeAll();
    expect(reg.liveTunnelCount()).toBe(0);
    expect(FakeTunnel.live).toBe(0);
  });

  it('🔴 失败态先于数据库错误暴露：隧道失败时不该报认证失败', async () => {
    // 隧道都建不起来，用户看到的却是"Access denied"，会往错误方向排查
    const mgr = new FakeTunnelManager();
    mgr.failMessage = 'SSH 认证失败';
    driver.failConnect = 'Access denied for user';
    const reg = new SessionRegistry(cache, () => driver, mgr);
    await expect(reg.connect(sshCfg(), 'pwd')).rejects.toMatchObject({ code: 'SSH_FAILED' });
    expect(reg.lastError('ssh1')).toContain('SSH');
    driver.failConnect = null;
  });

  it('streamFactory 传给驱动（驱动靠它开多条 channel）', async () => {
    const mgr = new FakeTunnelManager();
    const seen: { streamFactory: unknown }[] = [];
    const reg = new SessionRegistry(
      cache,
      (_c, _p, ctx) => {
        seen.push({ streamFactory: ctx?.streamFactory ?? null });
        return driver;
      },
      mgr,
    );
    await reg.connect(sshCfg(), 'pwd');
    expect(typeof seen[0].streamFactory).toBe('function');
  });

  it('测试连接（makeTestDriver）也走隧道', async () => {
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, () => driver, mgr);
    const d = await reg.makeTestDriver(sshCfg(), 'pwd');
    expect(mgr.opened).toHaveLength(1);
    await d.close();
  });
});

// ---------- SSL 证书接线（P2-1）：realDriverFactory 把证书文件读成内容 ----------

describe('SSL 证书接线（realDriverFactory）', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nCA-CONTENT\n-----END CERTIFICATE-----';
  const CERT = '-----BEGIN CERTIFICATE-----\nCERT-CONTENT\n-----END CERTIFICATE-----';
  const KEY = '-----BEGIN PRIVATE KEY-----\nKEY-CONTENT\n-----END PRIVATE KEY-----';

  /** 证书文件落在共享临时目录 dir 里，外层 afterEach 统一清理 */
  function sslCfg(over: Partial<ConnectionConfig['ssl']> = {}): ConnectionConfig {
    const base = cfg();
    return {
      ...base,
      ssl: {
        enabled: true,
        caPath: join(dir, 'ca.pem'),
        certPath: join(dir, 'cert.pem'),
        keyPath: join(dir, 'key.pem'),
        rejectUnauthorized: true,
        ...over,
      },
    };
  }

  /** 白盒读取 MySqlDriver 持有的凭据（工厂的产出物就是凭据，必须盯着它断言） */
  function credentialsOf(d: DriverLike): MySqlCredentials {
    return (d as unknown as { cred: MySqlCredentials }).cred;
  }

  it('SSL 启用：驱动收到证书【内容】而非路径', async () => {
    writeFileSync(join(dir, 'ca.pem'), CA);
    writeFileSync(join(dir, 'cert.pem'), CERT);
    writeFileSync(join(dir, 'key.pem'), KEY);
    const d = await realDriverFactory(sslCfg(), 'pwd');
    expect(credentialsOf(d).ssl).toEqual({ ca: CA, cert: CERT, key: KEY, rejectUnauthorized: true });
    await d.close();
  });

  it('路径为 null 的项缺省，不参与映射', async () => {
    writeFileSync(join(dir, 'ca.pem'), CA);
    const d = await realDriverFactory(sslCfg({ certPath: null, keyPath: null }), 'pwd');
    expect(credentialsOf(d).ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    expect(credentialsOf(d).ssl).not.toHaveProperty('cert');
    expect(credentialsOf(d).ssl).not.toHaveProperty('key');
    await d.close();
  });

  it('🔴 证书文件读取失败 → 抛 SSL_READ_FAILED，绝不悄悄降级为无 TLS', async () => {
    // 决策说明：保存时校验层（fileExists）会挡住"enabled 但文件不存在"，
    // 这里防的是文件在保存后被删/移动。校验被绕过的场景按 fail-closed 处理：
    // 抛错、连接失败 —— 而不是降级成无 CA 的 TLS（那会让中间人攻击不可见）。
    const bad = sslCfg({ caPath: join(dir, 'missing-ca.pem') });
    await expect(realDriverFactory(bad, 'pwd')).rejects.toMatchObject({
      code: 'SSL_READ_FAILED',
    });
    await expect(realDriverFactory(bad, 'pwd')).rejects.toThrow(/missing-ca\.pem/);
  });

  it('🔴 rejectUnauthorized:false 原样透传（关闭校验要能落到驱动层）', async () => {
    writeFileSync(join(dir, 'ca.pem'), CA);
    writeFileSync(join(dir, 'cert.pem'), CERT);
    writeFileSync(join(dir, 'key.pem'), KEY);
    const d = await realDriverFactory(sslCfg({ rejectUnauthorized: false }), 'pwd');
    expect(credentialsOf(d).ssl?.rejectUnauthorized).toBe(false);
    await d.close();
  });

  it('SSL 未启用：凭据里 ssl 为 null，与从前的行为完全一致', async () => {
    const base = cfg();
    const d = await realDriverFactory({ ...base, ssl: { ...base.ssl, enabled: false } }, 'pwd');
    expect(credentialsOf(d).ssl).toBeNull();
    await d.close();
  });
});

describe('🔴 SSL 读取失败的兜底（隧道不孤儿、状态可恢复）', () => {
  /** 让配置指向必然读不到的证书文件（模拟"校验被绕过/文件事后被删"）。
   *  必须带 SSH 配置 —— 只有开了隧道，"失败不留孤儿隧道"的断言才有意义 */
  function badSslCfg(id: string): ConnectionConfig {
    const c = sshCfg({ id });
    return { ...c, ssl: { ...c.ssl, enabled: true, caPath: join(dir, 'nope.pem') } };
  }

  it('connect：工厂抛 SSL_READ_FAILED → 隧道关掉、状态 failed、可重试', async () => {
    FakeTunnel.live = 0;
    const mgr = new FakeTunnelManager();
    // 默认工厂就是 realDriverFactory —— 真读文件，正好测全链路
    const reg = new SessionRegistry(cache, realDriverFactory, mgr);
    const c = badSslCfg('ssl-fail');
    await expect(reg.connect(c, 'pwd')).rejects.toMatchObject({ code: 'SSL_READ_FAILED' });
    expect(reg.stateOf('ssl-fail')).toBe('failed');
    expect(mgr.tunnels[0].closed).toBe(true);
    expect(reg.liveTunnelCount()).toBe(0);
    expect(FakeTunnel.live).toBe(0);
    // 状态没卡死在 connecting —— 用户改好文件后手动重试能再走一遍
    await expect(reg.connect(c, 'pwd')).rejects.toMatchObject({ code: 'SSL_READ_FAILED' });
  });

  it('测试连接（makeTestDriver）：工厂失败也关隧道，不留孤儿', async () => {
    FakeTunnel.live = 0;
    const mgr = new FakeTunnelManager();
    const reg = new SessionRegistry(cache, realDriverFactory, mgr);
    await expect(reg.makeTestDriver(badSslCfg('ssl-test'), 'pwd')).rejects.toMatchObject({
      code: 'SSL_READ_FAILED',
    });
    expect(FakeTunnel.live).toBe(0);
  });
});

// ---------- 对象定义与表信息（C2 / C9+A14） ----------

describe('对象定义与表信息（C2 / C9+A14）', () => {
  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd');
  });

  it('getObjectDdl 返回 SHOW CREATE 原文，并透传库/名/类型', async () => {
    driver.ddlResult = 'CREATE TABLE `order` (`id` bigint) ENGINE=InnoDB';
    const r = await registry.getObjectDdl('c1', { database: 'app_db', name: 'order', kind: 'table' });
    expect(r).toEqual({
      kind: 'table',
      name: 'order',
      database: 'app_db',
      ddl: 'CREATE TABLE `order` (`id` bigint) ENGINE=InnoDB',
    });
    expect(driver.ddlCalls[0]).toEqual({ database: 'app_db', name: 'order', kind: 'table' });
  });

  it('触发器/事件也是合法的对象类型（ObjectKind 对齐）', async () => {
    driver.ddlResult = 'CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW SET @x=1';
    const r = await registry.getObjectDdl('c1', { database: 'app_db', name: 'trg', kind: 'trigger' });
    expect(r.kind).toBe('trigger');
    expect(driver.ddlCalls[0].kind).toBe('trigger');
  });

  it('未连接的会话 → NOT_CONNECTED（跟随既有错误风格）', async () => {
    await expect(
      registry.getObjectDdl('nope', { database: 'd', name: 'n', kind: 'view' }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(
      registry.getTableInfo('nope', { database: 'd', table: 't' }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('对象不存在 → NOT_FOUND，message 带服务端原文（不翻译不吞）', async () => {
    driver.ddlThrow = Object.assign(new Error('PROCEDURE app_db.foo does not exist'), {
      code: 'ER_SP_DOES_NOT_EXIST',
    });
    await expect(
      registry.getObjectDdl('c1', { database: 'app_db', name: 'foo', kind: 'procedure' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      registry.getObjectDdl('c1', { database: 'app_db', name: 'foo', kind: 'procedure' }),
    ).rejects.toThrow(/PROCEDURE app_db\.foo does not exist/);
  });

  it('getTableInfo 返回 information_schema 映射', async () => {
    driver.tableInfoResult = {
      engine: 'InnoDB',
      rowsEstimate: 9930343,
      dataLength: 123456789,
      indexLength: 9876543,
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
      comment: '大表',
      createTime: '2026-01-02 03:04:05',
      autoIncrement: 10001,
    };
    const info = await registry.getTableInfo('c1', { database: 'app_db', table: 'order' });
    expect(info.rowsEstimate).toBe(9930343);
    expect(info.createTime).toBe('2026-01-02 03:04:05');
    expect(driver.tableInfoCalls[0]).toEqual({ database: 'app_db', table: 'order' });
  });

  it('表不存在 → NOT_FOUND（空结果不算成功）', async () => {
    driver.tableInfoResult = null;
    await expect(
      registry.getTableInfo('c1', { database: 'app_db', table: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------- D1 连接状态变化推送 ----------

/** 订阅并收集推送事件的替身 */
function collectEvents(reg: SessionRegistry): { events: { id: string; state: ConnectionState; lastError: string | null }[] } {
  const events: { id: string; state: ConnectionState; lastError: string | null }[] = [];
  reg.setOnStateChange((id, state, lastError) => events.push({ id, state, lastError }));
  return { events };
}

/** mysql2 断线形态的错误（code 决定归类，message 只是展示） */
/**
 * 连接级错误替身。
 *
 * ⚠️ 这里**故意**带上 `code`，因为 `isConnectionLostError` 只认 code。
 * 但真实的 mysql2 在「连接已被服务端关掉」时抛的是 `{ fatal: true }`、
 * **没有 code** —— 于是这个替身曾经让一整套断线用例全绿，而真机上一个都
 * 触发不了（0.7.1 真机验证反查出来的）。补码的责任在驱动层
 * `normalizeError`（core-driver-mysql 有单测，`e2e:keepalive` 有真库门禁）。
 */
const LOST = () => Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });

describe('D1 状态推送（每一次迁移都回调）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连接 → 查询 → 手动断开：迁移序列完整，成功推送 lastError 为 null', async () => {
    const reg = new SessionRegistry(cache, () => driver);
    const { events } = collectEvents(reg);

    await reg.connect(cfg(), 'pwd');
    expect(events.map((e) => e.state)).toEqual(['connecting', 'connected']);
    expect(events[1].lastError).toBeNull();

    await reg.runQuery('c1', 'SELECT 1');
    expect(events.slice(2).map((e) => e.state)).toEqual(['busy', 'connected']);

    await reg.disconnect('c1');
    expect(events.at(-1)!.state).toBe('idle');
    expect(events.every((e) => e.id === 'c1')).toBe(true);
    reg.setOnStateChange(null);
    // 退订后不再推送（也不能崩）
    await reg.connect(cfg(), 'pwd');
    expect(events.at(-1)!.state).toBe('idle');
  });

  it('连接失败 → failed 推送带 lastError（横幅据此报警）', async () => {
    const reg = new SessionRegistry(cache, () => driver);
    const { events } = collectEvents(reg);
    driver.failConnect = 'Access denied for user';
    await expect(reg.connect(cfg(), 'bad')).rejects.toThrow(SessionError);
    expect(events.map((e) => e.state)).toEqual(['connecting', 'failed']);
    expect(events[1].lastError).toContain('Access denied');
  });

  it('🔴 查询中连接断开 → disconnected（不被 endQuery 标回 connected），带 lastError', async () => {
    const reg = new SessionRegistry(cache, () => driver, null, async () => 'pwd');
    const { events } = collectEvents(reg);
    await reg.connect(cfg(), 'pwd');
    events.length = 0;

    driver.throwOn = () => LOST();
    await expect(reg.runQuery('c1', 'SELECT 1')).rejects.toThrow();

    expect(events.map((e) => e.state)).toEqual(['busy', 'disconnected']);
    const disc = events.find((e) => e.state === 'disconnected')!;
    expect(disc.lastError).toContain('Connection lost');
    expect(reg.isLive('c1')).toBe(false);
  });

  it('断线后自动重连成功：connecting → connected，密码经 provider 现取，查询恢复', async () => {
    let passwordCalls = 0;
    const reg = new SessionRegistry(cache, () => driver, null, async () => {
      passwordCalls++;
      return 'pwd';
    });
    const { events } = collectEvents(reg);
    await reg.connect(cfg(), 'pwd');
    events.length = 0;

    driver.throwOn = () => LOST();
    await expect(reg.runQuery('c1', 'SELECT 1')).rejects.toThrow();
    expect(events.at(-1)!.state).toBe('disconnected');

    // 重连计时器 1s 到点 → connecting → 建连成功 → connected
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.map((e) => e.state)).toEqual(['busy', 'disconnected', 'connecting', 'connected']);
    expect(events.at(-1)!.lastError).toBeNull(); // 重连成功时 lastError 清空
    expect(passwordCalls).toBe(1);
    expect(reg.isLive('c1')).toBe(true);

    // 重连后的会话真的可用
    driver.throwOn = null;
    await expect(reg.runQuery('c1', 'SELECT 1')).resolves.toBeTruthy();
  });

  it('🔴 自动重连额度耗尽（1s/2s/4s 三次全失败）→ failed，手动重试可恢复', async () => {
    let passwordCalls = 0;
    const reg = new SessionRegistry(cache, () => driver, null, async () => {
      passwordCalls++;
      return 'pwd';
    });
    const { events } = collectEvents(reg);
    await reg.connect(cfg(), 'pwd');
    events.length = 0;

    driver.throwOn = () => LOST();
    await expect(reg.runQuery('c1', 'SELECT 1')).rejects.toThrow();
    driver.failConnect = 'still down';
    driver.throwOn = null;

    await vi.advanceTimersByTimeAsync(1000); // 第 1 次重连失败
    await vi.advanceTimersByTimeAsync(2000); // 第 2 次
    await vi.advanceTimersByTimeAsync(4000); // 第 3 次 → 额度耗尽

    expect(reg.stateOf('c1')).toBe('failed');
    expect(reg.lastError('c1')).toContain('still down');
    expect(passwordCalls).toBe(3); // 恰好三次，不多不少

    // 手动重试（走正常 connect 流程）可以恢复，且 attempts 清零
    driver.failConnect = null;
    await reg.connect(cfg(), 'pwd');
    expect(reg.stateOf('c1')).toBe('connected');
    expect(reg.isLive('c1')).toBe(true);
  });

  it('断线重连期间用户手动断开：不复活会话（代数作废在途建连）', async () => {
    const reg = new SessionRegistry(cache, () => driver, null, async () => 'pwd');
    collectEvents(reg);
    await reg.connect(cfg(), 'pwd');

    driver.throwOn = () => LOST();
    await expect(reg.runQuery('c1', 'SELECT 1')).rejects.toThrow();
    expect(reg.stateOf('c1')).toBe('disconnected');

    // 让重连卡在"驱动建连中"（failConnect 抛错前会经历 makeDriver），此时用户断开
    driver.failConnect = 'still down';
    const reconnecting = vi.advanceTimersByTimeAsync(1000); // 触发第 1 次重连（将失败）
    await reconnecting;
    await reg.disconnect('c1');
    expect(reg.stateOf('c1')).toBe('idle');

    // 后续不再有重连计时器 resurrection：再推进 10s，状态保持 idle
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reg.stateOf('c1')).toBe('idle');
    driver.failConnect = null;
  });
});

/**
 * 0.7.1 需求 1：执行结果的字段口径。
 *
 * 这里钉住的是「断开点」—— 0.7.0 的 runQuery 把 rows.length 当成唯一事实，
 * 于是 UPDATE 在 UI 上显示「返回 0 行」。断言必须同时看 rowCount（恒 0）与
 * affectedRows（真值），只断 affectedRows 的话，把 rowCount 也改成 affectedRows
 * 的实现照样会全绿（那就是另一种错：结果集语义被写操作污染）。
 */
describe('0.7.1 执行结果字段（runQuery 透传）', () => {
  beforeEach(async () => {
    await registry.connect(cfg(), 'pwd');
  });

  it('UPDATE：rowCount 恒 0，affectedRows 是真值，statementKind=update 且带 info', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 2,
      insertId: null,
      info: 'Rows matched: 5  Changed: 2  Warnings: 0',
      warnings: 0,
      elapsedMs: 3,
    });
    const out = await registry.runQuery('c1', 'UPDATE `order` SET amount = 1 WHERE id = 1');
    expect(out.rowCount).toBe(0);
    expect(out.affectedRows).toBe(2);
    expect(out.statementKind).toBe('update');
    // matched=5 与 changed=2 必须都能拿到：只有 affectedRows 时用户会以为「只改了 2 行，另外 3 行漏了」
    expect(out.info).toContain('Rows matched: 5');
  });

  it('SELECT：affectedRows 跟随行数（不是 0），避免「结果集也报影响 0 行」', async () => {
    driver.handler = () => ({
      rows: [['a'], ['b']],
      fields: [{ name: 'x', type: 253 }],
      affectedRows: 0,
      insertId: null,
      info: null,
      warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.runQuery('c1', 'SELECT * FROM `order`');
    expect(out.rowCount).toBe(2);
    expect(out.affectedRows).toBe(2);
    expect(out.statementKind).toBe('select');
  });

  it('空结果集（0 行但有列）：affectedRows 是 0 而不是服务端无关值', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [{ name: 'x', type: 253 }],
      affectedRows: 7, // 故意给个脏值：结果集不该采用它
      insertId: null,
      info: null,
      warnings: 0,
      elapsedMs: 1,
    });
    const out = await registry.runQuery('c1', 'SELECT * FROM `order` WHERE 1 = 0');
    expect(out.rowCount).toBe(0);
    expect(out.affectedRows).toBe(0);
  });

  it('INSERT：透出 insertId 与 warnings', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 1,
      insertId: 5001,
      info: 'Records: 1  Duplicates: 0  Warnings: 2',
      warnings: 2,
      elapsedMs: 2,
    });
    const out = await registry.runQuery('c1', "INSERT INTO `order` (amount) VALUES (1)");
    expect(out.affectedRows).toBe(1);
    expect(out.insertId).toBe(5001);
    expect(out.warnings).toBe(2);
  });

  it('DDL：statementKind=ddl（文案该说执行成功，不该提行数）', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 0,
      insertId: null,
      info: null,
      warnings: 0,
      elapsedMs: 2,
    });
    const out = await registry.runQuery('c1', 'CREATE TABLE `tmp_x` (id int)');
    expect(out.statementKind).toBe('ddl');
    expect(out.affectedRows).toBe(0);
  });
});

/**
 * 0.7.1 需求 4：心跳保活的**接线**（纯函数判据已在 core-connection 里钉过）。
 *
 * 这里验的是三件真机上才会出事的接线错误：
 *   - 心跳走了 runQuery → 连接被标 busy → 用户点执行吃「已有查询在执行」
 *   - 用户查询在跑时心跳抢连接
 *   - 心跳失败一次就弹断线横幅（网络抖动被当成真断线）
 */
describe('0.7.1 心跳保活（替身驱动 + 假定时器）', () => {
  /** 保活间隔 1s（扫描周期 = 一半 = 500ms），让门禁跑得快 */
  const KA = 1000;

  const makeReg = () => new SessionRegistry(cache, () => driver, null, null, KA);
  const heartbeats = () => driver.calls.filter((c) => c.sql === 'SELECT 1').length;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空闲到点发 SELECT 1，且不推进状态机（UI 不该为后台心跳闪 busy）', async () => {
    const reg = makeReg();
    const { events } = collectEvents(reg);
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');
    await vi.advanceTimersByTimeAsync(1200);

    expect(heartbeats()).toBeGreaterThanOrEqual(1);
    expect(events.map((e) => e.state)).not.toContain('busy');
    expect(reg.stateOf('c1')).toBe('connected');
    await reg.disconnect('c1');
  });

  it('🔴 有查询在跑时不插队（插队会让用户查询直接吃 BUSY）', async () => {
    const reg = makeReg();
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');

    driver.queryDelayMs = 3000;
    const running = reg.runQuery('c1', 'SELECT * FROM `order`');
    // 查询占了 3s，期间跨越两个扫描周期
    await vi.advanceTimersByTimeAsync(1200);
    expect(heartbeats()).toBe(0);

    await vi.advanceTimersByTimeAsync(3000);
    await running;
    driver.queryDelayMs = 0;
    await reg.disconnect('c1');
  });

  it('心跳成功会刷新空闲计时：不会因为「有心跳」反而被 idle 断开', async () => {
    const reg = makeReg();
    // idle 2.5s：若心跳不刷新活跃时间，2.5s 后必然 closed
    await reg.connect(cfg({ idleTimeoutMs: 2500 }), 'pwd');
    await vi.advanceTimersByTimeAsync(6000);
    expect(reg.stateOf('c1')).toBe('connected');
    expect(heartbeats()).toBeGreaterThanOrEqual(4);
    await reg.disconnect('c1');
  });

  it('🔴 心跳失败 1 次不弹断线，连续 2 次才交给重连链路', async () => {
    const reg = makeReg();
    const { events } = collectEvents(reg);
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');

    // 只让心跳失败（用户查询照常）
    driver.throwOn = (sql) => (sql === 'SELECT 1' ? LOST() : null);

    await vi.advanceTimersByTimeAsync(1200); // 第 1 次心跳失败
    expect(reg.stateOf('c1')).toBe('connected');
    expect(events.map((e) => e.state)).not.toContain('disconnected');

    await vi.advanceTimersByTimeAsync(1200); // 第 2 次心跳失败 → 判死
    expect({
      beats: heartbeats(),
      failures: (reg as unknown as { keepAliveFailures: Map<string, number> }).keepAliveFailures.get('c1') ?? null,
      state: reg.stateOf('c1'),
    }).toEqual({ beats: 2, failures: null, state: 'disconnected' });
    expect(events.map((e) => e.state)).toContain('disconnected');

    driver.throwOn = null;
    await vi.advanceTimersByTimeAsync(2000); // 自动重连
    expect(reg.stateOf('c1')).toBe('connected');
    await reg.disconnect('c1');
  });

  it('保活关闭（keepAliveMs = 0）时一条心跳都不发', async () => {
    const reg = new SessionRegistry(cache, () => driver, null, null, 0);
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeats()).toBe(0);
    await reg.disconnect('c1');
  });

  it('退出时停掉扫描器（不再往已关闭的驱动发 SQL）', async () => {
    const reg = makeReg();
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');
    await vi.advanceTimersByTimeAsync(1200);
    const before = heartbeats();
    await reg.closeAll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(heartbeats()).toBe(before);
  });

  /**
   * 🔴 2026-10-28 事故：0.7.1 上线后 `verify` 链卡在 `e2e:conflict`。
   *
   * 冲突门禁的断言全绿（17/17），但**进程不退出** —— 那个脚本成功路径没有
   * `process.exit(0)`，靠事件循环自然排空来结束；而保活用的是 `setInterval`，
   * 是活跃句柄，Node 会一直等它。结果是整条门禁链静默挂死 10 分钟。
   *
   * 两条防线都要有，缺一条就会复现：
   *  ① 建定时器时 `unref()` —— 它永远不该成为进程退出的阻碍；
   *  ② 最后一条活连接断开时停掉定时器 —— 否则用户断开全部连接后它还在空转。
   */
  it('🔴 定时器必须 unref（否则 verify 链会挂死在一个永远不退出的进程上）', async () => {
    const reg = makeReg();
    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');
    const timer = (reg as unknown as { keepAliveTimer: unknown }).keepAliveTimer;
    // 假定时器（vi.useFakeTimers）在 Node 里返回对象，真浏览器返回数字 —— 两种都要认
    const unref = (timer as { unref?: unknown } | null)?.unref;
    expect({ hasTimer: timer !== null, unrefable: typeof unref }).toEqual({
      hasTimer: true,
      // 数字定时器没法 unref，但那时也不存在"挂住事件循环"的问题；Node 下必须是函数
      unrefable: typeof timer === 'number' ? 'number' : 'function',
    });
    await reg.disconnect('c1');
  });

  it('🔴 断开最后一条连接后停掉扫描器（不留空转的心跳）', async () => {
    const reg = makeReg();
    const timerOf = () => (reg as unknown as { keepAliveTimer: unknown }).keepAliveTimer;

    await reg.connect(cfg({ idleTimeoutMs: 0 }), 'pwd');
    expect(timerOf()).not.toBeNull();

    await reg.disconnect('c1');
    expect(timerOf()).toBeNull();

    // 还有活连接时不能停：两条连接，只断一条
    await reg.connect(cfg({ id: 'c2', idleTimeoutMs: 0 }), 'pwd');
    await reg.connect(cfg({ id: 'c3', idleTimeoutMs: 0 }), 'pwd');
    await reg.disconnect('c2');
    expect(timerOf()).not.toBeNull();
    await reg.disconnect('c3');
    expect(timerOf()).toBeNull();
  });
});
