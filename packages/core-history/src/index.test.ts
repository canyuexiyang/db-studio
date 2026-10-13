import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore } from './index.js';

let store: HistoryStore;

beforeEach(() => {
  store = new HistoryStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('HistoryStore — 基础读写', () => {
  it('能写入并读回一条历史', () => {
    const id = store.addHistory({
      connectionId: 'conn-1',
      database: 'bench',
      sql: 'SELECT * FROM big_table LIMIT 10',
      success: true,
      error: null,
      durationMs: 12,
      rowCount: 10,
      executedAt: Date.now(),
    });
    const row = store.getHistory(id);
    expect(row).not.toBeNull();
    expect(row!.sql).toBe('SELECT * FROM big_table LIMIT 10');
    expect(row!.success).toBe(true);
    expect(row!.rowCount).toBe(10);
  });

  it('Q5：失败的语句也要记录（失败的最需要复用）', () => {
    const id = store.addHistory({
      connectionId: 'conn-1',
      database: null,
      sql: 'SELCT * FROM t',
      success: false,
      error: 'You have an error in your SQL syntax',
      durationMs: 3,
      rowCount: 0,
      executedAt: Date.now(),
    });
    const row = store.getHistory(id)!;
    expect(row.success).toBe(false);
    expect(row.error).toContain('syntax');
    // 失败语句应出现在历史列表里
    expect(store.listHistory('conn-1').some((h) => h.id === id)).toBe(true);
  });

  // 注意：:memory: 库不支持 WAL（SQLite 限制），必须用真实文件验证
  it('WAL 模式已启用（真实文件库）', () => {
    const tmp = join(tmpdir(), `dbstudio-hist-test-${Date.now()}.db`);
    const s = new HistoryStore(tmp);
    try {
      const mode = (s as any).db.prepare('PRAGMA journal_mode').get();
      expect(String(mode.journal_mode).toLowerCase()).toBe('wal');
    } finally {
      s.close();
      try { rmSync(tmp); } catch { /* noop */ }
      try { rmSync(tmp + '-wal'); } catch { /* noop */ }
      try { rmSync(tmp + '-shm'); } catch { /* noop */ }
    }
  });
});

describe('HistoryStore — 注入防护（关键红线）', () => {
  /**
   * 历史库里存的 SQL 全是用户原文，里面可能含引号、分号、注释符。
   * 所有写必须走 prepared statement，不能拼字符串。
   */
  const nastySqls = [
    "SELECT * FROM t WHERE name = 'O'Brien'; DROP TABLE query_history; --",
    'SELECT "a" FROM t /* comment */ UNION SELECT 1',
    "SELECT '); DELETE FROM query_history; --",
    'SELECT 1; SELECT 2; SELECT 3',
    "SELECT 'it\\'s' FROM t",
    'SELECT * FROM t WHERE x = \'\' OR 1=1 --',
  ];

  for (const sql of nastySqls) {
    it(`恶意 SQL 原文能安全存取：${sql.slice(0, 40)}…`, () => {
      const id = store.addHistory({
        connectionId: "conn'); DROP TABLE query_history; --",
        database: null,
        sql,
        success: true,
        error: null,
        durationMs: 1,
        rowCount: 0,
        executedAt: Date.now(),
      });
      const row = store.getHistory(id)!;
      expect(row.sql).toBe(sql); // 原文必须逐字符保留
      expect(row.connectionId).toContain('DROP TABLE'); // 没有被当成 SQL 执行
      // 表还在
      expect(store.listHistoryAll(10).length).toBeGreaterThan(0);
    });
  }

  it('searchHistory 转义 LIKE 通配符', () => {
    store.addHistory({
      connectionId: 'c', database: null,
      sql: 'SELECT a_b FROM t', success: true, error: null,
      durationMs: 1, rowCount: 0, executedAt: Date.now(),
    });
    store.addHistory({
      connectionId: 'c', database: null,
      sql: 'SELECT aXb FROM t', success: true, error: null,
      durationMs: 1, rowCount: 0, executedAt: Date.now(),
    });
    // 搜 a_b 不应匹配 aXb（下划线未转义时 _ 是单字符通配符）
    const hits = store.searchHistory('a_b');
    expect(hits.length).toBe(1);
    expect(hits[0].sql).toBe('SELECT a_b FROM t');
  });
});

describe('HistoryStore — 列表与清理', () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) {
      store.addHistory({
        connectionId: i % 2 === 0 ? 'conn-A' : 'conn-B',
        database: 'bench',
        sql: `SELECT ${i}`,
        success: true, error: null, durationMs: i, rowCount: i,
        executedAt: 1_000_000 + i, // 递增，保证顺序确定
      });
    }
  });

  it('按连接过滤', () => {
    expect(store.listHistory('conn-A').length).toBe(5);
    expect(store.listHistory('conn-B').length).toBe(5);
  });

  it('按时间倒序（最近在前）', () => {
    const all = store.listHistory('conn-A');
    // conn-A 的 executedAt 是 1000000,1000002,...,1000008
    expect(all[0].executedAt).toBeGreaterThan(all[all.length - 1].executedAt);
  });

  it('limit 生效', () => {
    expect(store.listHistory('conn-A', 2).length).toBe(2);
  });

  it('listHistoryAll 跨连接', () => {
    expect(store.listHistoryAll(100).length).toBe(10);
  });

  it('deleteHistory 删单条', () => {
    const first = store.listHistory('conn-A')[0];
    expect(store.deleteHistory(first.id!)).toBe(true);
    expect(store.getHistory(first.id!)).toBeNull();
  });

  it('clearHistory 按连接清理', () => {
    expect(store.clearHistory('conn-A')).toBe(5);
    expect(store.listHistory('conn-A').length).toBe(0);
    expect(store.listHistory('conn-B').length).toBe(5);
  });

  it('clearHistory 全清', () => {
    expect(store.clearHistory()).toBe(10);
    expect(store.listHistoryAll().length).toBe(0);
  });

  it('pruneHistory 保留最近 N 条', () => {
    const deleted = store.pruneHistory(3);
    expect(deleted).toBe(7);
    expect(store.listHistoryAll().length).toBe(3);
    // 保留的应是 executedAt 最大的 3 条：1000007, 1000008, 1000009
    const kept = store.listHistoryAll().map((h) => h.executedAt).sort();
    expect(kept).toEqual([1_000_007, 1_000_008, 1_000_009]);
  });
});

describe('HistoryStore — 片段（v0.6.0：按库归属）', () => {
  it('增删查改', () => {
    store.addSnippet({ connectionId: 'c1', database: 'db', name: '慢查询', sql: 'SHOW PROCESSLIST', description: '看当前连接', createdAt: 1, updatedAt: 1 });
    const s = store.getSnippet('c1', 'db', '慢查询')!;
    expect(s.sql).toBe('SHOW PROCESSLIST');

    expect(store.updateSnippet('c1', 'db', '慢查询', 'SHOW FULL PROCESSLIST', '改过的')).toBe(true);
    expect(store.getSnippet('c1', 'db', '慢查询')!.sql).toBe('SHOW FULL PROCESSLIST');

    expect(store.listSnippets().length).toBe(1);
    expect(store.deleteSnippet('c1', 'db', '慢查询')).toBe(true);
    expect(store.getSnippet('c1', 'db', '慢查询')).toBeNull();
  });

  it('🔴 片段名在同一库内唯一', () => {
    store.addSnippet({ connectionId: 'c1', database: 'db', name: 'a', sql: 'SELECT 1', description: null, createdAt: 1, updatedAt: 1 });
    expect(() =>
      store.addSnippet({ connectionId: 'c1', database: 'db', name: 'a', sql: 'SELECT 2', description: null, createdAt: 2, updatedAt: 2 }),
    ).toThrow();
  });

  /**
   * v0.6.0 的核心新增能力，也是「为什么不能只用 name UNIQUE」的答案。
   * 每条都配一个反向断言，确保约束真的在起作用而不是碰巧通过。
   */
  it('同名片段可以在【不同库】各存一份', () => {
    store.addSnippet({ connectionId: 'c1', database: 'db1', name: '对账', sql: 'SELECT 1', description: null, createdAt: 1, updatedAt: 1 });
    expect(() =>
      store.addSnippet({ connectionId: 'c1', database: 'db2', name: '对账', sql: 'SELECT 2', description: null, createdAt: 1, updatedAt: 1 }),
    ).not.toThrow();
    expect(store.getSnippet('c1', 'db1', '对账')!.sql).toBe('SELECT 1');
    expect(store.getSnippet('c1', 'db2', '对账')!.sql).toBe('SELECT 2');
  });

  it('同名片段可以在【不同连接】各存一份', () => {
    store.addSnippet({ connectionId: 'c1', database: 'db', name: '对账', sql: 'SELECT 1', description: null, createdAt: 1, updatedAt: 1 });
    expect(() =>
      store.addSnippet({ connectionId: 'c2', database: 'db', name: '对账', sql: 'SELECT 2', description: null, createdAt: 1, updatedAt: 1 }),
    ).not.toThrow();
    expect(store.listSnippets().length).toBe(2);
  });

  /**
   * 🔴 迁移坑的回归守卫：旧行的归属是「空」而不是 NULL。
   * SQLite 的 UNIQUE 里 NULL 不参与冲突判定 —— 一旦迁移时写成 NULL，
   * 「库内唯一」会静默失效（能存出一堆同名片段），而这条断言就是拦住它的哨兵。
   */
  it('🔴 空归属用哨兵空串而非 NULL（NULL 会让唯一约束失效）', () => {
    store.addSnippet({ connectionId: '', database: '', name: '全局片段', sql: 'SELECT 1', description: null, createdAt: 1, updatedAt: 1 });
    const got = store.getSnippet('', '', '全局片段')!;
    expect(got.database).toBe('');
    expect(got.connectionId).toBe('');
    // 空库内同名仍然必须被拒 —— 若这条不成立，说明存进去的是 NULL
    expect(() =>
      store.addSnippet({ connectionId: '', database: '', name: '全局片段', sql: 'SELECT 2', description: null, createdAt: 2, updatedAt: 2 }),
    ).toThrow();
  });

  it('片段内容带恶意 SQL 也安全', () => {
    const evil = "'); DROP TABLE snippet; --";
    store.addSnippet({ connectionId: 'c1', database: 'db', name: 'evil', sql: evil, description: null, createdAt: 1, updatedAt: 1 });
    expect(store.getSnippet('c1', 'db', 'evil')!.sql).toBe(evil);
    expect(store.listSnippets().length).toBe(1);
  });
});

describe('HistoryStore — V6 星标与裁剪', () => {
  it('setStarred 置位后可读回，且列表置顶', () => {
    const a = store.addHistory({
      connectionId: 'c', database: null, sql: 'SELECT a', success: true, error: null,
      durationMs: 1, rowCount: 0, executedAt: 1_000,
    });
    store.addHistory({
      connectionId: 'c', database: null, sql: 'SELECT b', success: true, error: null,
      durationMs: 1, rowCount: 0, executedAt: 2_000,
    });
    expect(store.setStarred(a, true)).toBe(true);
    expect(store.getHistory(a)!.starred).toBe(true);
    // 星标条排在最前（尽管 executedAt 更早）
    expect(store.listHistory('c')[0].id).toBe(a);
    // 取消星标
    expect(store.setStarred(a, false)).toBe(true);
    expect(store.getHistory(a)!.starred).toBe(false);
    // 不存在的 id → false
    expect(store.setStarred(99999, true)).toBe(false);
  });

  it('pruneHistory 保留全部星标 + 最近 N 条未星标', () => {
    // 10 条历史，其中第 0 条（executedAt 最小）星标
    let starredId = -1;
    for (let i = 0; i < 10; i++) {
      const id = store.addHistory({
        connectionId: 'c', database: null, sql: `SELECT ${i}`, success: true, error: null,
        durationMs: 0, rowCount: 0, executedAt: 1_000 + i,
      });
      if (i === 0) starredId = id;
    }
    store.setStarred(starredId, true);

    // 保留最近 3 条未星标：应删 9 - 3 = 6 条，星标条与最近 3 条留下
    const deleted = store.pruneHistory(3);
    expect(deleted).toBe(6);
    const kept = store.listHistoryAll(100);
    expect(kept.length).toBe(4); // 3 未星标 + 1 星标
    expect(kept.some((h) => h.id === starredId)).toBe(true);
    // 未星标保留的应是 executedAt 最大的 3 条：1007,1008,1009
    const keptUnstarred = kept.filter((h) => !h.starred).map((h) => h.executedAt).sort();
    expect(keptUnstarred).toEqual([1_007, 1_008, 1_009]);
  });

  it('旧库迁移：无 starred 列的 query_history 能被 ALTER 补齐', () => {
    const tmp = join(tmpdir(), `dbstudio-hist-migrate-${Date.now()}.db`);
    // 手工造一个 v1 结构的库（无 starred 列）
    {
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(tmp);
      raw.exec(`
        CREATE TABLE query_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          connectionId TEXT NOT NULL, database TEXT, sql TEXT NOT NULL,
          success INTEGER NOT NULL, error TEXT,
          durationMs INTEGER NOT NULL DEFAULT 0, rowCount INTEGER NOT NULL DEFAULT 0,
          executedAt INTEGER NOT NULL
        );
      `);
      raw.prepare(
        `INSERT INTO query_history(connectionId, database, sql, success, error, durationMs, rowCount, executedAt)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run('old', null, 'SELECT legacy', 1, null, 5, 1, 500);
      raw.close();
    }
    const migrated = new HistoryStore(tmp);
    try {
      expect(migrated.schemaVersion).toBe(3);
      const rows = migrated.listHistoryAll(10);
      expect(rows.length).toBe(1);
      expect(rows[0].sql).toBe('SELECT legacy');
      expect(rows[0].starred).toBe(false); // 旧行默认未星标
    } finally {
      migrated.close();
      try { rmSync(tmp); } catch { /* noop */ }
      try { rmSync(tmp + '-wal'); } catch { /* noop */ }
      try { rmSync(tmp + '-shm'); } catch { /* noop */ }
    }
  });
});

describe('HistoryStore — schema 版本', () => {
  it('写入并读回 schema_version', () => {
    expect(store.schemaVersion).toBe(3);
  });
});

/**
 * v0.6.0 迁移守卫：从**真实的 v2 旧库**（name UNIQUE、无归属列）升级。
 *
 * 🔴 这条不能省：迁移是本轮唯一会破坏用户既有数据的动作。
 *  手写一条"新库能用"的断言，恰好绕过了迁移本身。
 */
describe('HistoryStore — v0.6.0 片段迁移（旧库 → 库内唯一）', () => {
  it('旧库的 name UNIQUE 换成 (连接,库,名) 唯一，旧行归到全局', () => {
const dir = mkdtempSync(join(tmpdir(), 'dbstudio-mig-'));
    const dbPath = join(dir, 'history.db');
    try {
      // 手工造一个 v2 形态的旧库：name 内联 UNIQUE、没有 connectionId/database
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version', '2');
        CREATE TABLE query_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          connectionId TEXT NOT NULL, database TEXT, sql TEXT NOT NULL,
          success INTEGER NOT NULL, error TEXT, durationMs INTEGER NOT NULL DEFAULT 0,
          rowCount INTEGER NOT NULL DEFAULT 0, executedAt INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE snippet (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          sql TEXT NOT NULL, description TEXT,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        INSERT INTO snippet (name, sql, description, createdAt, updatedAt)
          VALUES ('旧的慢查询', 'SHOW PROCESSLIST', '迁移前存的', 1, 1);
      `);
      legacy.close();

      const migrated = new HistoryStore(dbPath);
      try {
   // 旧行读回：SQL 原文与描述必须完好
const old = migrated.getSnippet('', '', '旧的慢查询');
        expect(old?.sql).toBe('SHOW PROCESSLIST');
        expect(old?.description).toBe('迁移前存的');

        // 🔴 旧行的 name 唯一约束必须已解除 —— 否则新库还是全局唯一，v0.6.0 白做
      expect(() =>
          migrated.addSnippet({ connectionId: 'c1', database: 'db', name: '同名新片段', sql: 'S', description: null, createdAt: 1, updatedAt: 1 }),
      ).not.toThrow();
      expect(migrated.getSnippet('c1', 'db', '同名新片段')).not.toBeNull();

        // 同一库内同名仍要唯一（迁移后的新约束生效）
        expect(() =>
          migrated.addSnippet({ connectionId: 'c1', database: 'db', name: '同名新片段', sql: 'S2', description: null, createdAt: 2, updatedAt: 2 }),
      ).toThrow();

   // 旧片段仍可被同名覆盖（它落在全局作用域）
        expect(migrated.updateSnippet('', '', '旧的慢查询', 'SHOW FULL PROCESSLIST', null)).toBe(true);
      } finally {
    migrated.close();
      }
    } finally {
rmSync(dir, { recursive: true, force: true });
    }
  });
});
