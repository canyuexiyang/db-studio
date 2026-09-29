/**
 * 查询历史与片段存储（本地 SQLite）
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §1.4
 *  - 用 node:sqlite 的 DatabaseSync，零 native 依赖、零重建
 *  - 只用核心 API（DatabaseSync / StatementSync / exec / prepare / run / get / all / iterate）
 *  - 【不碰】createSession / applyChangeset / createTagStore —— 仍在演进（Stability 1.1），
 *    升级 Electron 后 API 可能漂移。这些接口一个都不用。
 *  - 必须 PRAGMA journal_mode=WAL
 *  - 所有写走 prepared statement（防注入 —— 历史库里存的 SQL 全是用户原文，
 *    里面可能含引号、分号、注释符，拼 SQL 字符串必然出事）
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryEntry {
  id?: number;
  /** 连接 ID，用于按连接过滤历史 */
  connectionId: string;
  /** 数据库名（可空，如未选定库） */
  database: string | null;
  /** SQL 原文 —— 用户写的，绝对不能拼进 SQL 字符串 */
  sql: string;
  /** 执行是否成功（Q5：失败语句也要记录，失败的最需要复用） */
  success: boolean;
  /** 错误信息（成功时为 null） */
  error: string | null;
  /** 耗时 ms */
  durationMs: number;
  /** 影响/返回行数 */
  rowCount: number;
  /** 执行时间戳（epoch ms） */
  executedAt: number;
  /** V6：星标（收藏的历史，列表置顶 + 不受自动裁剪影响） */
  starred: boolean;
}

export interface Snippet {
  id?: number;
  /** 片段名 */
  name: string;
  /** SQL 内容 */
  sql: string;
  /** 备注 */
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA_VERSION = 2;

export class HistoryStore {
  private db: DatabaseSync;
  private readonly stmts: Record<string, any> = {};

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);

    // WAL：读写并发，且避免读操作被写阻塞
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');

    this.migrate();
    this.prepareStatements();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        connectionId TEXT NOT NULL,
        database     TEXT,
        sql          TEXT NOT NULL,
        success      INTEGER NOT NULL,
        error        TEXT,
        durationMs   INTEGER NOT NULL DEFAULT 0,
        rowCount     INTEGER NOT NULL DEFAULT 0,
        executedAt   INTEGER NOT NULL,
        starred      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS snippet (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        sql         TEXT NOT NULL,
        description TEXT,
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL
      );
    `);

    // V6 迁移：旧库（schema_version < 2）的 query_history 没有 starred 列。
    // 用 PRAGMA table_info 探测后 ALTER TABLE —— SQLite 的 ADD COLUMN 是常量
    // 默认值，对既有行立即生效（默认 0 = 未星标）。
    const cols = this.db.prepare('PRAGMA table_info(query_history)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'starred')) {
      this.db.exec('ALTER TABLE query_history ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
    }

    // 常用查询路径的索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_conn_time
        ON query_history(connectionId, executedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_history_time
        ON query_history(executedAt DESC);
    `);

    const setVer = this.db.prepare(
      'INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    setVer.run('schema_version', String(SCHEMA_VERSION));
  }

  private prepareStatements(): void {
    this.stmts.insertHistory = this.db.prepare(`
      INSERT INTO query_history
        (connectionId, database, sql, success, error, durationMs, rowCount, executedAt, starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmts.listHistory = this.db.prepare(`
      SELECT id, connectionId, database, sql, success, error, durationMs, rowCount, executedAt, starred
      FROM query_history
      WHERE connectionId = ?
      ORDER BY starred DESC, executedAt DESC
      LIMIT ?
    `);

    this.stmts.listHistoryAll = this.db.prepare(`
      SELECT id, connectionId, database, sql, success, error, durationMs, rowCount, executedAt, starred
      FROM query_history
      ORDER BY starred DESC, executedAt DESC
      LIMIT ?
    `);

    this.stmts.searchHistory = this.db.prepare(`
      SELECT id, connectionId, database, sql, success, error, durationMs, rowCount, executedAt, starred
      FROM query_history
      WHERE sql LIKE ? ESCAPE '\\'
      ORDER BY starred DESC, executedAt DESC
      LIMIT ?
    `);

    this.stmts.getHistory = this.db.prepare(`
      SELECT id, connectionId, database, sql, success, error, durationMs, rowCount, executedAt, starred
      FROM query_history WHERE id = ?
    `);

    this.stmts.deleteHistory = this.db.prepare('DELETE FROM query_history WHERE id = ?');

    this.stmts.setStarred = this.db.prepare('UPDATE query_history SET starred = ? WHERE id = ?');

    this.stmts.clearHistory = this.db.prepare('DELETE FROM query_history');

    this.stmts.clearHistoryByConn = this.db.prepare(
      'DELETE FROM query_history WHERE connectionId = ?',
    );

    /**
     * 保留最近 N 条：防止历史库无限增长。
     *
     * V6：**星标条永不裁剪**（用户显式收藏的不该被自动清掉）。语义是
     * 「保留所有星标 + 最近 N 条未星标」；N 只对未星标部分计数。
     */
    this.stmts.pruneHistory = this.db.prepare(`
      DELETE FROM query_history
      WHERE starred = 0
        AND id NOT IN (
          SELECT id FROM query_history WHERE starred = 0 ORDER BY executedAt DESC LIMIT ?
        )
    `);

    this.stmts.insertSnippet = this.db.prepare(`
      INSERT INTO snippet (name, sql, description, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmts.updateSnippet = this.db.prepare(`
      UPDATE snippet SET sql = ?, description = ?, updatedAt = ?
      WHERE name = ?
    `);

    this.stmts.getSnippet = this.db.prepare(`
      SELECT id, name, sql, description, createdAt, updatedAt
      FROM snippet WHERE name = ?
    `);

    this.stmts.listSnippets = this.db.prepare(`
      SELECT id, name, sql, description, createdAt, updatedAt
      FROM snippet ORDER BY updatedAt DESC
    `);

    this.stmts.deleteSnippet = this.db.prepare('DELETE FROM snippet WHERE name = ?');
  }

  // ---------- 查询历史 ----------

  /**
   * 记录一条执行历史。
   * Q5 决策：失败语句也要记录 —— 失败的才是最需要复用的。
   */
  addHistory(entry: Omit<HistoryEntry, 'id' | 'starred'> & { starred?: boolean }): number {
    const r = this.stmts.insertHistory.run(
      entry.connectionId,
      entry.database ?? null,
      entry.sql,
      entry.success ? 1 : 0,
      entry.error ?? null,
      entry.durationMs ?? 0,
      entry.rowCount ?? 0,
      entry.executedAt ?? Date.now(),
      entry.starred ? 1 : 0,
    );
    return Number(r.lastInsertRowid);
  }

  /** 按连接列出最近历史 */
  listHistory(connectionId: string, limit = 200): HistoryEntry[] {
    return this.stmts.listHistory.all(connectionId, limit).map(this.mapHistory);
  }

  /** 列出全部连接的最近历史（命令面板搜历史用） */
  listHistoryAll(limit = 200): HistoryEntry[] {
    return this.stmts.listHistoryAll.all(limit).map(this.mapHistory);
  }

  /**
   * 按 SQL 片段搜索历史。
   * LIKE 的 % _ \ 已转义 —— 用户搜 `a_b` 不该匹配 `aXb`。
   */
  searchHistory(keyword: string, limit = 100): HistoryEntry[] {
    const escaped = keyword.replace(/[\\%_]/g, (c: string) => '\\' + c);
    return this.stmts.searchHistory.all(`%${escaped}%`, limit).map(this.mapHistory);
  }

  getHistory(id: number): HistoryEntry | null {
    const row = this.stmts.getHistory.get(id);
    return row ? this.mapHistory(row) : null;
  }

  deleteHistory(id: number): boolean {
    return this.stmts.deleteHistory.run(id).changes > 0;
  }

  /** V6：星标/取消星标一条历史。返回是否命中（id 不存在为 false）。 */
  setStarred(id: number, starred: boolean): boolean {
    return this.stmts.setStarred.run(starred ? 1 : 0, id).changes > 0;
  }

  clearHistory(connectionId?: string): number {
    const r = connectionId
      ? this.stmts.clearHistoryByConn.run(connectionId)
      : this.stmts.clearHistory.run();
    return Number(r.changes);
  }

  /** 保留最近 keep 条，其余删除。返回删除条数。 */
  pruneHistory(keep: number): number {
    return Number(this.stmts.pruneHistory.run(keep).changes);
  }

  // ---------- 片段 ----------

  addSnippet(s: Omit<Snippet, 'id'>): number {
    const now = Date.now();
    const r = this.stmts.insertSnippet.run(
      s.name,
      s.sql,
      s.description ?? null,
      s.createdAt ?? now,
      s.updatedAt ?? now,
    );
    return Number(r.lastInsertRowid);
  }

  updateSnippet(name: string, sql: string, description?: string | null): boolean {
    return this.stmts.updateSnippet.run(sql, description ?? null, Date.now(), name).changes > 0;
  }

  getSnippet(name: string): Snippet | null {
    const row = this.stmts.getSnippet.get(name);
    return row ? this.mapSnippet(row) : null;
  }

  listSnippets(): Snippet[] {
    return this.stmts.listSnippets.all().map(this.mapSnippet);
  }

  deleteSnippet(name: string): boolean {
    return this.stmts.deleteSnippet.run(name).changes > 0;
  }

  // ---------- 生命周期 ----------

  get schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    this.db.close();
  }

  // ---------- 内部 ----------

  private mapHistory(row: any): HistoryEntry {
    return {
      id: row.id,
      connectionId: row.connectionId,
      database: row.database ?? null,
      sql: row.sql,
      success: row.success === 1,
      error: row.error ?? null,
      durationMs: row.durationMs,
      rowCount: row.rowCount,
      executedAt: row.executedAt,
      starred: row.starred === 1,
    };
  }

  private mapSnippet(row: any): Snippet {
    return {
      id: row.id,
      name: row.name,
      sql: row.sql,
      description: row.description ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
