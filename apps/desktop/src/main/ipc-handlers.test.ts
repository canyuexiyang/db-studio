/**
 * IPC handler 测试 —— 用假的 ipcMain 收集 handler，直接调它们。
 *
 * 这里测的不是 Electron 本身，而是三条契约：
 *  1. 每个 handler 都返回 IpcResult —— 异常绝不冒到 ipcRenderer
 *     （冒过去渲染侧只能收到 "Error invoking remote method"，毫无信息量）
 *  2. 错误码可被渲染层区分（NOT_CONNECTED / READ_ONLY / NOT_FOUND ...）
 *  3. 查询无论成败都进历史（Q5：失败的才是最需要复用的）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * electron 替身。
 *
 * 🔴 为什么必须有：本文件测的 handler 里有两条真的会碰 electron API ——
 *    V21 的 checkForUpdate 要读 `app.isPackaged` / `app.getVersion()`，
 *    私钥选择要开 `dialog.showOpenDialog`。不替身的话前者直接 TypeError
 *    被 wrap 收敛成 INTERNAL（看起来像"handler 有 bug"，其实是测试环境缺件）。
 *
 * app.isPackaged = false 是**刻意选的口径**：它就是「开发态」，
 * 而 V21 的核心契约正是"开发态不联网、返回中文结论"。
 */
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test', getPath: () => '/tmp' },
  // 无 GUI 会话里 showOpenDialog 弹不出来 —— 替身返回"用户取消"，
  // 与 ipc-handlers 里 try/catch 收敛成 null 的降级路径同口径
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  BrowserWindow: { fromWebContents: () => null },
}));

import { registerIpcHandlers } from './ipc-handlers.js';
import { ConnectionStore } from './connection-store.js';
import { SessionRegistry, type DriverLike, type DriverFactory } from './session-registry.js';
import { TransferManager, type ForkFn } from './transfer-manager.js';
import { WindowManager } from './window-manager.js';
import { registerCloseGuardIpc } from './window.js';
import { IPC, ERROR_CODES } from '../shared/ipc-channels.js';
import { SchemaCache } from '@dbstudio/core-schema-cache';
import { HistoryStore } from '@dbstudio/core-history';
import { SecretStore, type SafeStorageLike } from '@dbstudio/core-secret';
import { defaultConnectionConfig, type ConnectionConfig } from '@dbstudio/core-connection';
import type { DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';
import type { QueryResult, ForeignKeyMeta, ReferencedValueQuery, ReferencedValueLookup } from '@dbstudio/core-driver-mysql';

// ---------- 替身 ----------

class FakeSafeStorage implements SafeStorageLike {
  isEncryptionAvailable() {
    return true;
  }
  encryptString(plain: string) {
    return Buffer.from('s4lt:' + plain, 'utf8');
  }
  decryptString(enc: Buffer) {
    return Buffer.from(enc).toString('utf8').replace(/^s4lt:/, '');
  }
}

class FakeDriver implements DriverLike {
  connectionId = 7;
  serverVersion: string | null = null;
  /**
   * 记录所有到达驱动的 SQL。
   * V10 的结构校验断言靠它证明「被拒的语句一条都没执行」——
   * 只看返回的 IpcResult 不足以区分「前置拒绝」与「执行后失败」。
   */
  readonly calls: { sql: string; values: unknown[] }[] = [];
  handler: (sql: string) => QueryResult = () => ({
    rows: [],
    fields: [],
    affectedRows: 0,
    insertId: null,
    elapsedMs: 1,
  });
  throwOn: ((sql: string) => string | null) | null = null;
  introspectResult: DatabaseMeta[] = [];

  async connect() {
    this.serverVersion = '8.4.0-fake';
    return { serverVersion: '8.4.0-fake', elapsedMs: 2 };
  }
  async query(sql: string, _values: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ sql, values: _values });
    const msg = this.throwOn?.(sql);
    if (msg) throw new Error(msg);
    return this.handler(sql);
  }
  async introspect() {
    return this.introspectResult;
  }
  /** v0.6.0：刷新路径会先问可见库清单（本文件的测试不触达，按 introspectResult 作答） */
  async listDatabases() {
    return this.introspectResult.map((d) => d.name);
  }
  // C2/C9：DriverLike 扩展出的元数据能力（本文件的测试不触达，给空实现保编译）
  async showCreateObject(_database: string, _name: string, _kind: string): Promise<string> {
    return '';
  }
  async getTableInfo(_database: string, _table: string): Promise<null> {
    return null;
  }
  /**
   * V9：外键与候选值。
   * 🔴 这两个是**有测试触达**的（见「V9 外键导航 handler」段），
   * 所以做成可编程替身而不是空实现 —— 空实现会让「handler 是否正确透传/降级」
   * 测不出来，等于只测了编译通过。
   */
  foreignKeysResult: ForeignKeyMeta[] = [];
  foreignKeysThrow: Error | null = null;
  readonly foreignKeysCalls: { database: string; table: string }[] = [];
  referencedResult: ReferencedValueLookup = { items: [], truncated: false };
  readonly referencedCalls: ReferencedValueQuery[] = [];

  async listForeignKeys(database: string, table: string): Promise<ForeignKeyMeta[]> {
    this.foreignKeysCalls.push({ database, table });
    if (this.foreignKeysThrow) throw this.foreignKeysThrow;
    return this.foreignKeysResult;
  }
  async lookupReferencedValues(o: ReferencedValueQuery): Promise<ReferencedValueLookup> {
    this.referencedCalls.push(o);
    return this.referencedResult;
  }
  async cancel() {
    return true;
  }
  async close() {
    this.serverVersion = null;
  }
}

/** 假的 ipcMain：把 handler 收进 map，测试直接调 */
class FakeIpcMain {
  readonly handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) {
    this.handlers.set(channel, fn);
  }
  /** 按通道调用，模拟渲染侧 invoke */
  call(channel: string, ...args: unknown[]): Promise<any> {
    const h = this.handlers.get(channel);
    if (!h) return Promise.reject(new Error(`No handler for ${channel}`));
    return Promise.resolve(h(null, ...args));
  }
}

/**
 * 假窗口 —— 只实现 WindowManager 真正用到的那几个成员。
 *
 * ⚠️ 刻意用**真的 WindowManager** 而不是再写一个替身类：
 *    替身照着被测代码的假设实现，只会跟被测代码一起错。
 *    窗口上限（MAX_WINDOWS）这类判定必须被真的执行到才算测过。
 */
class FakeWin {
  destroyed = false;
  readonly sent: { channel: string; payload: unknown }[] = [];
  webContents = {
    send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }),
  };
  isDestroyed() {
    return this.destroyed;
  }
  on(_evt: string, _cb: () => void) {}
  close() {
    this.destroyed = true;
  }
}

const TABLE: TableMeta = {
  name: 'order',
  kind: 'table',
  comment: null,
  estimatedRows: 100,
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
};

let dir: string;
let ipc: FakeIpcMain;
let driver: FakeDriver;
let connections: ConnectionStore;
let sessions: SessionRegistry;
let history: HistoryStore;
let pushed: { channel: string; payload: unknown }[] = [];
/** V23：真实 WindowManager + 可控的 createWindow 替身（记录被要求打开的初始标签） */
let windows: WindowManager;
let openedWindows: { initialTab: { connId: string; database: string; table: string } | null; title?: string }[];
let aliveWindows: FakeWin[];

function cfg(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return defaultConnectionConfig({
    id: 'c1',
    name: 'test',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    ...over,
  });
}

function factory(): DriverFactory {
  return () => driver;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dbstudio-ipc-'));
  driver = new FakeDriver();
  driver.introspectResult = [
    { name: 'app_db', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', tables: [TABLE] },
  ];
  pushed = [];

  const secrets = new SecretStore(new FakeSafeStorage());
  await secrets.init();
  connections = new ConnectionStore(dir, secrets);
  sessions = new SessionRegistry(new SchemaCache(dir), factory());
  history = new HistoryStore(join(dir, 'history.db'));

  ipc = new FakeIpcMain();

  // V23：真 WindowManager（不是替身）—— 窗口上限、broadcast 范围都要真的执行到
  openedWindows = [];
  aliveWindows = [];
  windows = new WindowManager({
    here: '/fake/dist/main',
    createWindow: async (opts) => {
      openedWindows.push(opts);
      const w = new FakeWin();
      aliveWindows.push(w);
      return w as any;
    },
  });

  // 假 fork：worker 永远不会真的跑（这里测的是 handler 契约，不是导出本身）
  const fakeFork: ForkFn = () => ({
    kill: () => true,
    on: () => {},
    postMessage: () => {},
  });
  const transfers = new TransferManager({
    connections,
    sessions,
    getWindow: () => null,
    fork: fakeFork,
  });

  registerIpcHandlers({
    ipcMain: ipc as any,
    connections,
    sessions,
    history,
    secrets,
    transfers,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (ch: string, p: unknown) => pushed.push({ channel: ch, payload: p }) },
    }) as any,
    windows,
    makeDriver: factory(),
  });

  /**
   * 关闭询问通道（W 板块）。
   *
   * ⚠️ 必须在这里补上 —— 它由 registerCloseGuardIpc 注册（**全局一次**，
   *    不能放在 registerIpcHandlers 里：多窗口下每个窗口都会调
   *    installCloseGuard，但 ipcMain.handle 重复注册会抛
   *    "second handler"）。所以这里按真实 boot 顺序（main.ts）两个都调，
   *    「所有通道都注册了」才是对**实际启动组合**的断言，而不是对半个 boot。
   */
  registerCloseGuardIpc(ipc as any);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 契约 ----------

describe('IPC handler 契约', () => {
  it('所有声明的通道都注册了 handler（漏注册会在渲染侧静默失败）', () => {
    for (const ch of Object.values(IPC)) {
      expect(ipc.handlers.has(ch), `通道 ${ch} 未注册 handler`).toBe(true);
    }
  });

  it('🔴 handler 绝不抛异常，一律返回 IpcResult', async () => {
    // 故意制造各种失败：不存在的连接、未连接、非法 SQL
    const cases: Promise<any>[] = [
      ipc.call(IPC.CONN_CONNECT, { id: '不存在' }),
      ipc.call(IPC.SCHEMA_GET, '不存在'),
      ipc.call(IPC.QUERY_RUN, { connId: '不存在', sql: 'SELECT 1' }),
      ipc.call(IPC.MUTATION_APPLY, { connId: '不存在', database: 'd', statements: [] }),
      ipc.call(IPC.CONN_DELETE, '不存在'),
    ];
    const results = await Promise.all(cases);
    for (const r of results) {
      expect(r).toHaveProperty('ok');
      expect(typeof r.ok).toBe('boolean');
    }
  });

  it('未连接时查询返回 NOT_CONNECTED（渲染层据此提示"请先连接"）', async () => {
    const r = await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'SELECT 1' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it('连接不存在的 id 返回 NOT_FOUND', async () => {
    const r = await ipc.call(IPC.CONN_CONNECT, { id: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

// ---------- 连接 ----------

describe('连接 handler', () => {
  it('connList 返回连接与状态', async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    const r = await ipc.call(IPC.CONN_LIST);
    expect(r.ok).toBe(true);
    expect(r.data.connections).toHaveLength(1);
    expect(r.data.states['c1'].state).toBe('idle');
  });

  it('🔴 connList 不泄露密码（明文和密文都不出主进程）', async () => {
    await connections.save({ config: cfg(), password: 'topsecret' });
    const r = await ipc.call(IPC.CONN_LIST);
    const raw = JSON.stringify(r);
    expect(raw).not.toContain('topsecret');
    // 密文同样不该出主进程：渲染层只需要知道"有没有存密码"
    expect(raw).not.toContain(Buffer.from('s4lt:topsecret').toString('base64'));
    // 但仍要能区分"已保存密码"与"未保存"
    expect(r.data.connections[0].passwordEnc).toBe('');
    expect(r.data.connections[0].promptEveryTime).toBe(false);
  });

  it('未保存密码的连接仍显示为 null（而非空串，语义要清楚）', async () => {
    await connections.save({ config: cfg(), password: 'x', promptEveryTime: true });
    const r = await ipc.call(IPC.CONN_LIST);
    expect(r.data.connections[0].passwordEnc).toBeNull();
    expect(r.data.connections[0].promptEveryTime).toBe(true);
  });

  it('🔴 connCreate 返回的也不含密文', async () => {
    const r = await ipc.call(IPC.CONN_CREATE, { config: cfg(), password: 'topsecret' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(Buffer.from('s4lt:topsecret').toString('base64'));
    // 但确实存进去了
    expect(await connections.passwordFor('c1')).toBe('topsecret');
  });

  it('connConnect 成功并推送状态事件', async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    const r = await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
    expect(r.ok).toBe(true);
    expect(r.data.state).toBe('connected');
    expect(r.data.serverVersion).toBe('8.4.0-fake');
    expect(pushed.some((p) => p.channel === 'event:connState')).toBe(true);
  });

  it('promptEveryTime 连接未传密码 → 明确报错而不是拿空密码去试', async () => {
    await connections.save({ config: cfg(), password: 'x', promptEveryTime: true });
    const r = await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('每次手动输入密码');
  });

  it('connTest 失败时 ok=true 但带 message（测试失败是预期结果，不是 handler 异常）', async () => {
    driver.throwOn = () => null; // connect 正常
    const origConnect = driver.connect.bind(driver);
    driver.connect = async () => {
      throw new Error('Access denied');
    };
    const r = await ipc.call(IPC.CONN_TEST, { config: cfg(), password: 'bad' });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(false);
    expect(r.data.message).toContain('Access denied');
    driver.connect = origConnect;
  });

  it('connTest 成功返回服务端版本', async () => {
    const r = await ipc.call(IPC.CONN_TEST, { config: cfg(), password: 'pwd' });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.serverVersion).toBe('8.4.0-fake');
  });

  it('connDelete 会先断开活动连接', async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
    const r = await ipc.call(IPC.CONN_DELETE, 'c1');
    expect(r.ok).toBe(true);
    expect(r.data).toBe(true);
    expect(connections.get('c1')).toBeNull();
  });
});

// ---------- 查询与历史 ----------

describe('查询与历史', () => {
  beforeEach(async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
  });

  it('queryRun 返回列式载荷', async () => {
    driver.handler = () => ({
      rows: [
        ['1', 'a'],
        ['2', null],
      ],
      fields: [
        { name: 'id', type: 8 },
        { name: 'title', type: 253 },
      ],
      affectedRows: 0,
      insertId: null,
      elapsedMs: 3,
    });
    const r = await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'SELECT * FROM `order`' });
    expect(r.ok).toBe(true);
    expect(r.data.payload.rowCount).toBe(2);
    expect(r.data.rowCount).toBe(2);
  });

  it('🔴 查询失败也要进历史（Q5：失败的才是最需要复用的）', async () => {
    driver.throwOn = () => 'You have an error in your SQL syntax';
    const r = await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'SELEKT 1' });
    expect(r.ok).toBe(false);

    const list = history.listHistory('c1', 10);
    expect(list).toHaveLength(1);
    expect(list[0].sql).toBe('SELEKT 1');
    expect(list[0].success).toBe(false);
    expect(list[0].error).toContain('SQL syntax');
  });

  it('成功的查询进历史并记录行数与耗时', async () => {
    driver.handler = () => ({
      rows: [['1']],
      fields: [{ name: 'id', type: 8 }],
      affectedRows: 0,
      insertId: null,
      elapsedMs: 5,
    });
    await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'SELECT id FROM `order`' });
    const list = history.listHistory('c1', 10);
    expect(list[0].success).toBe(true);
    expect(list[0].rowCount).toBe(1);
    expect(list[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('queryOpenTable 走 buildOpenTableSql（带 LIMIT 与服务端排序）', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [{ name: 'id', type: 8 }],
      affectedRows: 0,
      insertId: null,
      elapsedMs: 1,
    });
    const r = await ipc.call(IPC.QUERY_OPEN_TABLE, {
      connId: 'c1',
      database: 'app_db',
      table: 'order',
      limit: 10,
      orderBy: [{ column: 'id', direction: 'ASC' }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.truncated).toBe(false);
  });

  it('🔴 只读连接的写查询被拦（UI 置灰不算数，这里才是安全层）', async () => {
    await ipc.call(IPC.CONN_DISCONNECT, 'c1');
    await connections.save({ config: cfg({ readOnly: true }), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });

    const r = await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'DELETE FROM `order`' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.READ_ONLY);
  });

  it('historySearch 能搜到执行过的语句', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 0,
      insertId: null,
      elapsedMs: 1,
    });
    await ipc.call(IPC.QUERY_RUN, { connId: 'c1', sql: 'SELECT * FROM user_profile' });
    const r = await ipc.call(IPC.HISTORY_SEARCH, { keyword: 'user_profile' });
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
  });
});

// ---------- 写操作 ----------

describe('写操作 handler', () => {
  beforeEach(async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
  });

  it('mutationApply 成功返回影响行数', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 2,
      insertId: null,
      elapsedMs: 1,
    });
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET title=? WHERE id=?', params: ['x', 1] }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.affected).toBe(2);
  });

  // ---------- T08 / R15：逐条预期行数契约 ----------

  it('🔴 T08：expect=one 但命中 0 行 → 冲突、整批回滚、committed=false', async () => {
    driver.handler = () => ({
      rows: [],
      fields: [],
      affectedRows: 0,
      insertId: null,
      elapsedMs: 1,
    });
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET title=? WHERE id=?', params: ['x', 1], expect: 'one', kind: 'update' }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.outcome).toBe('conflict');
    expect(r.data.committed).toBe(false);
    expect(r.data.affected).toBe(0);
    expect(r.data.conflicts).toHaveLength(1);
    expect(r.data.conflicts[0].actual).toBe(0);
    expect(r.data.conflicts[0].index).toBe(0);
    // 必须真的回滚（只看返回值不足以区分「没执行」与「执行后回滚」）
    expect(driver.calls.some((c) => /ROLLBACK/i.test(c.sql))).toBe(true);
  });

  it('🔴 T08：命中多行 → ambiguous（定位缺陷，绝不能继续）', async () => {
    driver.handler = () => ({ rows: [], fields: [], affectedRows: 3, insertId: null, elapsedMs: 1 });
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET title=? WHERE id=?', params: ['x', 1], expect: 'one', kind: 'update' }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.outcome).toBe('ambiguous');
    expect(r.data.conflicts[0].actual).toBe(3);
  });

  it('🔴 T08：多语句「前面成功、后面冲突」→ 整批回滚，先成功的也撤销', async () => {
    let seen = 0;
    driver.handler = (sql) => {
      const isUpdate = /^UPDATE/i.test(sql.trim());
      if (isUpdate) seen++;
      return {
        rows: [],
        fields: [],
        // 第 1 条 UPDATE 命中 1 行（成功），第 2 条命中 0 行（冲突）
        affectedRows: isUpdate ? (seen === 1 ? 1 : 0) : 0,
        insertId: null,
        elapsedMs: 1,
      };
    };
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [
        { sql: 'UPDATE `order` SET a=? WHERE id=?', params: [1, 1], expect: 'one', kind: 'update' },
        { sql: 'UPDATE `order` SET b=? WHERE id=?', params: [2, 2], expect: 'one', kind: 'update' },
      ],
    });
    expect(r.data.outcome).toBe('conflict');
    expect(r.data.conflicts[0].index).toBe(1);
    // 冲突前已执行 1 条 —— 它也被回滚了（不是「提交了一部分」）
    expect(r.data.conflicts[0].executedBefore).toBe(1);
    expect(driver.calls.some((c) => /COMMIT/i.test(c.sql))).toBe(false);
    expect(driver.calls.some((c) => /ROLLBACK/i.test(c.sql))).toBe(true);
  });

  it('🔴 T08：mode=ddl 时 DROP 命中 0 行**不算冲突**（DROP IF EXISTS 已删表就是 0）', async () => {
    driver.handler = () => ({ rows: [], fields: [], affectedRows: 0, insertId: null, elapsedMs: 1 });
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      mode: 'ddl',
      statements: [{ sql: 'DROP TABLE IF EXISTS `tmp_x`', params: [] }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.outcome).toBe('ok');
    expect(r.data.committed).toBe(true);
  });

  it('🔴 T08/p0：grid-write 入口拒绝 DDL（表达式防线不能为 DDL 开口子）', async () => {
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'DROP TABLE `tmp_x`', params: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.VALIDATION);
    expect(driver.calls.some((c) => /START TRANSACTION/i.test(c.sql))).toBe(false);
  });

  it('🔴 T08/p0：ddl 入口只放行 DDL，不允许偷跑 SELECT/INSERT', async () => {
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      mode: 'ddl',
      statements: [{ sql: 'INSERT INTO `t` (a) VALUES (1)', params: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.VALIDATION);
  });

  it('🔴 T08/p0：ddl 入口仍禁止多语句拼接', async () => {
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      mode: 'ddl',
      statements: [{ sql: 'DROP TABLE `a`; DROP TABLE `b`', params: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.VALIDATION);
  });

  it('🔴 只读连接在 handler 层再拦一次（纵深防御）', async () => {
    await ipc.call(IPC.CONN_DISCONNECT, 'c1');
    await connections.save({ config: cfg({ readOnly: true }), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });

    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET title=? WHERE id=?', params: ['x', 1] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.READ_ONLY);
  });

  it('写操作失败时返回错误而非崩溃', async () => {
    driver.throwOn = (sql) => (sql.includes('UPDATE') ? 'Duplicate entry' : null);
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      // ⚠️ 必须带 WHERE：本用例要测「驱动层报错 → IpcResult 包装」，
      // 无 WHERE 的 UPDATE 会被 V10 的 AST 结构校验前置拒绝（VALIDATION，
      // 根本走不到驱动），那就测不到想测的错误传播路径。
      statements: [{ sql: 'UPDATE `order` SET title=1 WHERE id=2', params: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('Duplicate entry');
  });

  // ---------- V10：写语句结构兜底（handler 层同样能观察到） ----------

  it('🔴 无 WHERE 的 UPDATE 在 handler 层被拒（VALIDATION，不到达驱动）', async () => {
    const before = driver.calls.length;
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET title=1', params: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.VALIDATION);
    expect(r.error.message).toContain('WHERE');
    expect(driver.calls.length).toBe(before);
  });

  it('🔴 表达式值（NOW()）走正常写链路放行，不被误拦', async () => {
    driver.handler = () => ({ rows: [], fields: [], affectedRows: 1, insertId: null, elapsedMs: 1 });
    const r = await ipc.call(IPC.MUTATION_APPLY, {
      connId: 'c1',
      database: 'app_db',
      statements: [{ sql: 'UPDATE `order` SET created_at = NOW() WHERE id = ?', params: [1] }],
    });
    expect(r.ok).toBe(true);
    expect(r.data.affected).toBe(1);
  });
});

// ---------- V9：外键导航 handler ----------

describe('V9 外键导航 handler', () => {
  beforeEach(async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
  });

  it('返回外键列表（复合外键的列顺序原样透传，不重排）', async () => {
    driver.foreignKeysResult = [
      {
        constraintName: 'fk_order_user',
        columns: ['user_id'],
        referencedDatabase: 'app_db',
        referencedTable: 'user',
        referencedColumns: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      {
        constraintName: 'fk_compound',
        columns: ['a', 'b'],
        referencedDatabase: 'app_db',
        referencedTable: 'other',
        referencedColumns: ['x', 'y'],
        onDelete: null,
        onUpdate: null,
      },
    ];
    const r = await ipc.call(IPC.SCHEMA_GET_FOREIGN_KEYS, { connId: 'c1', database: 'app_db', table: 'order' });
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
    // 🔴 顺序即语义：错位会让「本表第1列 = 引用表第2列」，跳转定位到错误的行
    expect(r.data[1].columns).toEqual(['a', 'b']);
    expect(r.data[1].referencedColumns).toEqual(['x', 'y']);
    expect(driver.foreignKeysCalls).toEqual([{ database: 'app_db', table: 'order' }]);
  });

  it('没有外键 → 空数组（不是错误）', async () => {
    driver.foreignKeysResult = [];
    const r = await ipc.call(IPC.SCHEMA_GET_FOREIGN_KEYS, { connId: 'c1', database: 'app_db', table: 'order' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('🔴 表不存在/无权限 → 降级为空数组，不冒泡成「打开表失败」', async () => {
    driver.foreignKeysThrow = Object.assign(new Error("Table 'app_db.nope' doesn't exist"), {
      code: 'ER_NO_SUCH_TABLE',
    });
    const r = await ipc.call(IPC.SCHEMA_GET_FOREIGN_KEYS, { connId: 'c1', database: 'app_db', table: 'nope' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('候选值：透传 keyword/limit，返回 items + truncated', async () => {
    driver.referencedResult = {
      items: [
        { value: '1', label: '张三' },
        { value: '2', label: '李四' },
      ],
      truncated: true,
    };
    const r = await ipc.call(IPC.SCHEMA_GET_REFERENCED_VALUES, {
      connId: 'c1',
      database: 'app_db',
      table: 'user',
      valueColumn: 'id',
      displayColumn: 'name',
      keyword: '张',
      limit: 200,
    });
    expect(r.ok).toBe(true);
    expect(r.data.items).toHaveLength(2);
    expect(r.data.truncated).toBe(true);
    expect(driver.referencedCalls[0]).toMatchObject({
      database: 'app_db',
      table: 'user',
      valueColumn: 'id',
      displayColumn: 'name',
      keyword: '张',
      limit: 200,
    });
  });

  it('候选值：displayColumn/keyword 缺省 → 归一为 null（驱动层不判 undefined）', async () => {
    const r = await ipc.call(IPC.SCHEMA_GET_REFERENCED_VALUES, {
      connId: 'c1',
      database: 'app_db',
      table: 'user',
      valueColumn: 'id',
    });
    expect(r.ok).toBe(true);
    expect(driver.referencedCalls[0].displayColumn).toBeNull();
    expect(driver.referencedCalls[0].keyword).toBeNull();
  });

  it('🔴 候选值拿不到时**不降级**：错误要冒泡（用户点了下拉就必须给原因）', async () => {
    // 与外键列表的降级刻意相反：静默返回空列表 = 「点了没反应」，
    // 正是 V1-V7 那轮要修的头号缺陷形态。
    const r = await ipc.call(IPC.SCHEMA_GET_REFERENCED_VALUES, {
      connId: '不存在',
      database: 'app_db',
      table: 'user',
      valueColumn: 'id',
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.NOT_CONNECTED);
  });
});

// ---------- Schema 与诊断 ----------

describe('Schema 与诊断', () => {
  beforeEach(async () => {
    await connections.save({ config: cfg(), password: 'pwd' });
    await ipc.call(IPC.CONN_CONNECT, { id: 'c1' });
  });

  it('schemaGetTable 返回表元数据（网格靠它判可编辑性）', async () => {
    const r = await ipc.call(IPC.SCHEMA_GET_TABLE, { connId: 'c1', database: 'app_db', table: 'order' });
    expect(r.ok).toBe(true);
    expect(r.data.table.columns[0].isPrimaryKey).toBe(true);
  });

  it('表不存在 → NOT_FOUND', async () => {
    const r = await ipc.call(IPC.SCHEMA_GET_TABLE, { connId: 'c1', database: 'app_db', table: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('schemaSearchColumn 按字段名反查表', async () => {
    const r = await ipc.call(IPC.SCHEMA_SEARCH_COLUMN, { connId: 'c1', column: 'title' });
    expect(r.ok).toBe(true);
    expect(r.data).toContain('app_db.order');
  });

  it('appDiagnostics 返回内存与活动连接数', async () => {
    const r = await ipc.call(IPC.APP_DIAGNOSTICS);
    expect(r.ok).toBe(true);
    expect(r.data.liveConnections).toBe(1);
    expect(typeof r.data.memMb).toBe('number');
  });

  it('secretState 返回凭据子系统状态', async () => {
    const r = await ipc.call(IPC.SECRET_STATE);
    expect(r.ok).toBe(true);
    expect(r.data.available).toBe(true);
  });

  // ---------- V21 / V23：两个「应用级」handler ----------

  it('V21：appCheckUpdate 在开发态返回 available=false 与中文说明（不联网）', async () => {
    const r = await ipc.call(IPC.APP_CHECK_UPDATE);
    expect(r.ok).toBe(true);
    expect(r.data.available).toBe(false);
    // 开发态必须给中文结论，不能是英文堆栈
    expect(r.data.message).toContain('开发模式');
  });

  it('V23：appOpenWindow 把库表名透传给窗口管理器', async () => {
    const r = await ipc.call(IPC.APP_OPEN_WINDOW, { connId: 'c1', database: 'app_db', table: 'order' });
    expect(r.ok).toBe(true);
    expect(r.data.opened).toBe(true);
    expect(openedWindows).toHaveLength(1);
    expect(openedWindows[0].initialTab).toEqual({ connId: 'c1', database: 'app_db', table: 'order' });
    // 标题也带上库表名，窗口列表/自动化可辨认
    expect(openedWindows[0].title).toBe('app_db.order');
  });

  it('V23：缺字段时按「空窗口」打开，而不是报错', async () => {
    const r = await ipc.call(IPC.APP_OPEN_WINDOW, { connId: 'c1' });
    expect(r.ok).toBe(true);
    expect(openedWindows[0].initialTab).toBeNull();
  });

  it('🔴 V23：窗口数达上限 → 失败并带中文原因（绝不静默失败）', async () => {
    // 先占满上限（MAX_WINDOWS = 4）
    for (let i = 0; i < 4; i++) await ipc.call(IPC.APP_OPEN_WINDOW, { connId: 'c1', database: 'd', table: 't' });
    const before = openedWindows.length;
    const r = await ipc.call(IPC.APP_OPEN_WINDOW, { connId: 'c1', database: 'd', table: 't' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.VALIDATION);
    expect(r.error.message).toContain('最多同时打开');
    expect(openedWindows.length).toBe(before); // 没有多开
  });

  it('导出：不存在的连接返回 NOT_FOUND（不再返回 NOT_IMPLEMENTED，已实现）', async () => {
    const r = await ipc.call(IPC.EXPORT_START, {
      connId: 'no-such-conn',
      format: 'csv',
      outputPath: '/tmp/x.csv',
      database: 'app_db',
      table: 'order',
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('导入：只读连接在 handler 层被拦（纵深防御，同 mutationApply）', async () => {
    await connections.save({
      config: cfg({ id: 'ro1', name: 'ro', readOnly: true }),
      password: 'pw',
    });
    const r = await ipc.call(IPC.IMPORT_START, {
      connId: 'ro1',
      filePath: '/tmp/nonexistent.csv',
      format: 'csv',
      hasHeader: true,
      database: 'app_db',
      table: 'order',
      mapping: [],
      columns: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(ERROR_CODES.READ_ONLY);
  });
});

// ---------- 文件选择：私钥不越 IPC 边界 ----------

describe('file:pickPrivateKey', () => {
  /**
   * 这条红线值得单独一个 describe：
   * 私钥**内容**一旦越过 IPC 进渲染进程，任何 XSS 或依赖包投毒都能把它带出去。
   * 所以这里只能返回路径 —— 读文件与权限校验都在主进程 tunnel-manager 里做。
   */
  it('🔴 只返回路径，不返回私钥内容', async () => {
    // 测试环境的 getWindow 是替身；无真实 dialog 时 handler 应安全返回 null
    const r = await ipc.call(IPC.FILE_PICK_PRIVATE_KEY);
    expect(r.ok).toBe(true);
    // 无论返回值是 null 还是路径，都绝不能包含 PEM 内容
    const raw = JSON.stringify(r);
    expect(raw).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(raw).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('返回类型是 string 或 null（不返回 File/Object）', async () => {
    const r = await ipc.call(IPC.FILE_PICK_PRIVATE_KEY);
    expect(['string', 'object']).toContain(typeof r.data);
    if (typeof r.data === 'object') expect(r.data).toBeNull();
  });
});
