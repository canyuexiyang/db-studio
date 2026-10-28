/**
 * IPC handler 注册 —— 主进程侧的全部能力入口。
 *
 * 三条铁律：
 *  1. **每个 handler 都必须返回 IpcResult**，绝不把异常抛给 ipcRenderer
 *     （抛过去渲染侧只能拿到 "Error invoking remote method" 这种无信息量的串）。
 *  2. **只读拦截只认 AST 白名单**（core-sql-guard）。UI 置灰能被快捷键绕过，
 *     这里才是唯一安全层。连接级 readOnly 在 session-registry 里再兜一次。
 *  3. **密码不进日志、不进历史、不进 IPC 返回值**。明文只在一次 IPC 调用的
 *     内存里出现，加密后立刻丢弃。
 *
 * 依赖全部通过构造函数注入，于是这个文件可以在单测里用内存替身跑通，
 * 不需要起 Electron、不需要真 MySQL。
 */

import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { join } from 'node:path';
import {
  IPC,
  ERROR_CODES,
  type IpcResult,
  type ConnListResult,
  type QueryOutcomeDto,
  type ExportStartRequest,
  type ImportStartRequest,
  type ObjectDdlRequest,
  type TableInfoRequest,
  type ForeignKeysRequest,
  type ForeignKeyDto,
  type ReferencedValuesRequest,
  type ReferencedValuesDto,
  // T41：SQL 文件编辑闭环
  type SqlFileReadResult,
  type SqlFileSaveRequest,
  type SqlFileSaveResult,
} from '../shared/ipc-channels.js';
import { readSqlFile, writeSqlFile, statSqlFile, detectExternalChange } from './sql-file.js';
import type { ConnectionConfig } from '@dbstudio/core-connection';
import type { HistoryStore } from '@dbstudio/core-history';
import { isValidSnippetName, snippetNameTooLongMessage } from '@dbstudio/core-history/snippet-name';
import type { SecretStore } from '@dbstudio/core-secret';
import type { ConnectionStore, SaveConnectionInput } from './connection-store.js';
import type { MutationApplyRequest } from '../shared/ipc-channels.js';
import type { SessionRegistry, QueryOutcome, DriverFactory } from './session-registry.js';
import type { TransferManager } from './transfer-manager.js';
import type { WindowManager } from './window-manager.js';
import { getGlassState, setGlassEnabled, darwinMajor } from './window.js';
import { buildColumnIndex } from '@dbstudio/core-schema-cache';
import { checkReadOnly } from '@dbstudio/core-sql-guard';
import { randomUUID } from 'node:crypto';
import { getObjectDdl, getTableInfo } from './object-meta.js';
// V21：更新检查（函数内部再动态 import electron-updater，避免拖进启动路径）
import { checkForUpdate } from './updater.js';

/** 连接状态变化的推送通道（渲染侧用 dbStudio.on 订阅） */
export const EVENT_CONN_STATE = 'event:connState';
export const EVENT_QUERY_DONE = 'event:queryDone';

/**
 * V6：历史自动裁剪上限。
 *
 * 语义 = 「保留全部星标 + 最近 N 条未星标」（core-history 的 pruneHistory 口径）。
 * 取 1000 是权衡：远大于命令面板单次展示量，又能在长期使用下把 SQLite 控制在
 * 可控体积（每条 SQL 平均几百字节 → 上限约 1MB 量级文本）。
 * ⚠️ 改动此处需同步 docs/product/PRD-v1.2-功能增量.md §一 V6 与 preferences 的相关说明。
 */
export const HISTORY_PRUNE_KEEP = 1000;

export interface HandlerDeps {
  ipcMain: IpcMain;
  connections: ConnectionStore;
  sessions: SessionRegistry;
  history: HistoryStore;
  secrets: SecretStore;
  /** 导入导出管理器（utilityProcess） */
  transfers: TransferManager;
  /** 取主窗口用于推送事件。可能为 null（窗口还没建好） */
  getWindow: () => BrowserWindow | null;
  /** V23：多窗口管理器（开新窗口 / 向所有窗口广播） */
  windows: WindowManager;
  /** 测试用：覆盖驱动工厂 */
  makeDriver?: DriverFactory;
}

/** 带错误码的异常（wrap 会据此填 IpcResult.error.code） */
function codedError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** 把异常收敛成 IpcResult —— 所有 handler 出口都过这里 */
function wrap<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return (async () => {
    try {
      return { ok: true, data: await fn() };
    } catch (e: any) {
      const code = typeof e?.code === 'string' && e.code in ERROR_CODES ? e.code : ERROR_CODES.INTERNAL;
      const message = String(e?.message ?? e);
      // 主进程侧留痕：渲染层只能拿到收敛后的 IpcResult，没有栈就没法排查
      if (process.env.DB_STUDIO_E2E === '1') console.error('[ipc:error]', message, '\n', e?.stack);
      return { ok: false, error: { code, message } };
    }
  })();
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { ipcMain, connections, sessions, history, secrets, transfers, getWindow } = deps;

  const push = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  /**
   * V6：记录一条历史并顺带裁剪。
   *
   * 所有 addHistory 都必须走这里 —— 否则「历史只增不减」（V6 描述的现状缺陷）。
   * 裁剪失败不该影响主流程（历史只是辅助），所以吞异常。
   */
  const recordHistory = (entry: Parameters<HistoryStore['addHistory']>[0]): void => {
    try {
      history.addHistory(entry);
      history.pruneHistory(HISTORY_PRUNE_KEEP);
    } catch {
      // 历史落盘失败不影响查询本身；静默
    }
  };

  // ---------- 连接 ----------

  ipcMain.handle(IPC.CONN_LIST, () =>
    wrap<ConnListResult>(async () => {
      const list = connections.listConnections();
      const states: ConnListResult['states'] = {};
      const schemas: ConnListResult['schemas'] = {};
      const stale: ConnListResult['stale'] = {};

      for (const cfg of list) {
        states[cfg.id] = {
          state: sessions.stateOf(cfg.id),
          lastError: sessions.lastError(cfg.id),
        };
        // 磁盘快照：树首屏靠它立刻出结构，不必等 introspect（PRD §6.2.1）
        const cached = sessions.snapshotInfo(cfg.id);
        if (cached) {
          schemas[cfg.id] = cached.databases;
          stale[cfg.id] = cached.stale;
        }
      }

      return {
        // ⚠️ 剥掉凭据字段：密文虽然解不开，但渲染层【完全不需要】它。
        //    渲染进程是被沙箱隔离但仍可能被注入脚本的一层，
        //    不该持有任何形式的凭据材料 —— 哪怕是密文。
        connections: list.map(stripSecrets),
        states,
        schemas,
        stale,
        secret: {
          available: secrets.canPersist,
          reason: secrets.getState().reason,
        },
      };
    }),
  );

  ipcMain.handle(IPC.CONN_CREATE, (_e, input: SaveConnectionInput) =>
    wrap<ConnectionConfig>(async () => {
      const cfg = input.config;
      if (!cfg.id) cfg.id = randomUUID();
      return stripSecrets(await connections.save({ ...input, config: cfg }));
    }),
  );

  ipcMain.handle(IPC.CONN_UPDATE, (_e, input: SaveConnectionInput) =>
    wrap<ConnectionConfig>(async () => {
      if (!input.config?.id) {
        throw Object.assign(new Error('更新连接必须带 id'), { code: ERROR_CODES.VALIDATION });
      }
      return stripSecrets(await connections.save(input));
    }),
  );

  ipcMain.handle(IPC.CONN_DELETE, (_e, id: string) =>
    wrap<boolean>(async () => {
      await sessions.disconnect(id);
      return connections.remove(id);
    }),
  );

  ipcMain.handle(IPC.CONN_CONNECT, (_e, input: { id: string; password?: string | null }) =>
    wrap(async () => {
      const cfg = connections.get(input.id);
      if (!cfg) {
        throw Object.assign(new Error('连接不存在'), { code: ERROR_CODES.NOT_FOUND });
      }
      // 明文密码优先用本次传入的（promptEveryTime 场景），否则取加密存储里的
      const password = input.password ?? (await connections.passwordFor(input.id));
      if (cfg.promptEveryTime && password == null) {
        throw Object.assign(new Error('该连接设置为每次手动输入密码'), { code: ERROR_CODES.VALIDATION });
      }

      const info = await sessions.connect(cfg, password);
      push(EVENT_CONN_STATE, { id: cfg.id, state: sessions.stateOf(cfg.id) });
      return { state: sessions.stateOf(cfg.id), serverVersion: info.serverVersion, elapsedMs: info.elapsedMs };
    }),
  );

  ipcMain.handle(IPC.CONN_DISCONNECT, (_e, id: string) =>
    wrap<null>(async () => {
      await sessions.disconnect(id);
      push(EVENT_CONN_STATE, { id, state: sessions.stateOf(id) });
      return null;
    }),
  );

  ipcMain.handle(IPC.CONN_TEST, (_e, input: SaveConnectionInput) =>
    wrap(async () => {
      // 测试连接：临时建连，跑完立刻关，不进注册表、不落盘任何凭据
      const cfg = input.config as ConnectionConfig;
      // ⚠️ makeTestDriver 是 async —— SSH 隧道要在建连前先开好。
      //    测试连接必须走隧道，否则"测试通过但真连失败"最难排查。
      const driver = await sessions.makeTestDriver({ ...cfg, id: cfg.id || randomUUID() }, input.password ?? null);
      try {
        const info = await driver.connect();
        return { ok: true, serverVersion: info.serverVersion, elapsedMs: info.elapsedMs, message: null };
      } catch (e: any) {
        // 测试失败是预期内的正常结果 —— 不算 handler 异常，把原因带回给 UI
        return { ok: false, serverVersion: null, elapsedMs: 0, message: String(e?.message ?? e) };
      } finally {
        try {
          await driver.close();
        } catch {
          /* 已断开，忽略 */
        }
      }
    }),
  );

  // ---------- Schema ----------

  ipcMain.handle(IPC.SCHEMA_GET, (_e, connId: string) =>
    wrap(async () => sessions.getSchema(connId)),
  );

  ipcMain.handle(IPC.SCHEMA_REFRESH, (_e, connId: string) =>
    wrap(async () => {
      const dbs = await sessions.getSchema(connId, { force: true });
      const cached = sessions.snapshotInfo(connId);
      return { databases: dbs, capturedAt: cached?.capturedAt ?? null };
    }),
  );

  ipcMain.handle(IPC.SCHEMA_GET_TABLE, (_e, req: { connId: string; database: string; table: string }) =>
    wrap(async () => {
      const table = await sessions.getTable(req.connId, req.database, req.table);
      if (!table) {
        throw Object.assign(new Error(`表 ${req.database}.${req.table} 不存在`), { code: ERROR_CODES.NOT_FOUND });
      }
      const cached = sessions.snapshotInfo(req.connId);
      return {
        database: req.database,
        table,
        fromCache: !sessions.isSchemaLive(req.connId),
        capturedAt: cached?.capturedAt ?? null,
      };
    }),
  );

  ipcMain.handle(IPC.SCHEMA_SEARCH_COLUMN, (_e, req: { connId: string; column: string }) =>
    wrap<string[]>(async () => {
      const dbs = await sessions.getSchema(req.connId);
      const index = buildColumnIndex(dbs);
      return index[req.column.toLowerCase()] ?? [];
    }),
  );

  // 对象定义查看（C2）：实现细节在 object-meta.ts（驱动层 SHOW CREATE 封装）
  ipcMain.handle(IPC.SCHEMA_GET_OBJECT_DDL, (_e, req: ObjectDdlRequest) =>
    wrap(async () => getObjectDdl(sessions, req)),
  );

  // 表信息（C9/A14）：information_schema.TABLES 估算，绝不做全表 COUNT
  ipcMain.handle(IPC.SCHEMA_GET_TABLE_INFO, (_e, req: TableInfoRequest) =>
    wrap(async () => getTableInfo(sessions, req)),
  );

  /**
   * V9：外键列表。
   *
   * 🔴 刻意**不缓存**、不进 introspect：外键只在用户聚焦某个外键单元格时才需要，
   *    给树首屏的批量元数据加一次 KEY_COLUMN_USAGE 查询是纯拖累。
   *    按需单表查；「表不存在/无权限」的降级（返回空数组）在 session 层完成 ——
   *    与 getObjectDdl/getTableInfo 同款分工：handler 只桥接，错误归类在会话层。
   */
  ipcMain.handle(IPC.SCHEMA_GET_FOREIGN_KEYS, (_e, req: ForeignKeysRequest) =>
    wrap<ForeignKeyDto[]>(async () => sessions.getForeignKeys(req.connId, req.database, req.table)),
  );

  /**
   * V9：外键候选值。
   *
   * 🔴 limit 由驱动层的 buildReferencedValuesSql 钳制（≤500），
   *    渲染层传什么值都不会变成全表扫描。
   */
  ipcMain.handle(IPC.SCHEMA_GET_REFERENCED_VALUES, (_e, req: ReferencedValuesRequest) =>
    wrap<ReferencedValuesDto>(async () =>
      sessions.lookupReferencedValues(req.connId, {
        database: req.database,
        table: req.table,
        valueColumn: req.valueColumn,
        displayColumn: req.displayColumn ?? null,
        keyword: req.keyword ?? null,
        limit: req.limit,
      }),
    ),
  );

  // ---------- 查询 ----------

  ipcMain.handle(IPC.QUERY_RUN, (_e, req: { connId: string; sql: string; database?: string | null; queryId?: string | null }) =>
    wrap<QueryOutcomeDto>(async () => {
      const startedAt = Date.now();
      let outcome: QueryOutcome | null = null;
      let failure: string | null = null;

      try {
        // 查询标签所属的库必须传下去：未设默认库的连接上，不带库前缀的
        // 语句靠它在执行前 USE（2026-09-26 真机修复 "No database selected"）
        outcome = await sessions.runQuery(req.connId, req.sql, [], {
          queryId: req.queryId ?? null,
          database: req.database ?? null,
        });
      } catch (e: any) {
        failure = String(e?.message ?? e);
        throw e;
      } finally {
        // Q5 决策：失败的语句也要记历史 —— 失败的才是最需要复用的
        if (outcome || failure) {
          recordHistory({
            connectionId: req.connId,
            database: req.database ?? null,
            sql: req.sql,
            success: !failure,
            error: failure,
            durationMs: outcome?.elapsedMs ?? Date.now() - startedAt,
            /**
             * 0.7.1：历史里的「行数」对写操作必须是影响行数。
             *
             * 早先一律用 `rowCount`，而写操作的结果集恒为空 → 历史面板里每次
             * UPDATE/DELETE 都记成 0 行，回溯「我刚才到底改了多少」直接失效。
             */
            rowCount: outcome
              ? outcome.statementKind === 'select'
                ? outcome.rowCount
                : outcome.affectedRows
              : 0,
            executedAt: startedAt,
          });
        }
      }

      const o = outcome!;
      return {
        payload: o.payload,
        elapsedMs: o.elapsedMs,
        rowCount: o.rowCount,
        // 0.7.1：影响行数三件套 + 语句分类，渲染层据此决定文案
        affectedRows: o.affectedRows,
        insertId: o.insertId,
        statementKind: o.statementKind,
        info: o.info,
        warnings: o.warnings,
        cancelled: o.cancelled,
        truncated: o.truncated,
        queryId: o.queryId,
        // A12 查询结果写回：source 由 session 层检测（单表 SELECT 才有）
        source: o.source ?? null,
      };
    }),
  );

  ipcMain.handle(IPC.QUERY_OPEN_TABLE, (_e, req: {
    connId: string;
    database: string;
    table: string;
    limit?: number;
    offset?: number;
    orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
    where?: string | null;
    whereParams?: unknown[];
  }) =>
    wrap<QueryOutcomeDto>(async () => {
      const o = await sessions.openTable(req.connId, req);
      return {
        payload: o.payload,
        elapsedMs: o.elapsedMs,
        rowCount: o.rowCount,
        // 打开表恒为 SELECT：影响行数 = 行数（字段仍要带，契约是必填）
        affectedRows: o.affectedRows,
        insertId: null,
        statementKind: 'select' as const,
        info: null,
        warnings: 0,
        cancelled: o.cancelled,
        truncated: o.truncated,
        queryId: o.queryId,
      };
    }),
  );

  ipcMain.handle(IPC.QUERY_CANCEL, (_e, queryId: string) =>
    wrap<boolean>(async () => sessions.cancelQuery(queryId)),
  );

  ipcMain.handle(IPC.QUERY_RUNNING, () => wrap(async () => sessions.listRunning()));

  // ---------- 写操作 ----------

  ipcMain.handle(IPC.MUTATION_APPLY, (_e, req: MutationApplyRequest) =>
    wrap(async () => {
      // 纵深防御：即使渲染层已经预演过，这里再拦一次只读
      const cfg = connections.get(req.connId);
      if (cfg?.readOnly) {
        throw Object.assign(new Error('只读连接不允许写操作'), { code: ERROR_CODES.READ_ONLY });
      }
      const r = await sessions.applyMutation(req.connId, req.database, req.statements, req.mode);
      // 写操作也进历史，便于回溯"我刚才到底改了什么"
      for (const st of req.statements) {
        recordHistory({
          connectionId: req.connId,
          database: req.database ?? null,
          sql: st.sql,
          success: true,
          error: null,
          durationMs: r.elapsedMs,
          rowCount: r.affected,
          executedAt: Date.now(),
        });
      }
      return r;
    }),
  );

  // ---------- 历史 ----------

  ipcMain.handle(IPC.HISTORY_LIST, (_e, req: { connId: string | null; limit?: number }) =>
    wrap(async () =>
      req.connId ? history.listHistory(req.connId, req.limit ?? 200) : history.listHistoryAll(req.limit ?? 200),
    ),
  );

  ipcMain.handle(IPC.HISTORY_SEARCH, (_e, req: { keyword: string; limit?: number }) =>
    wrap(async () => history.searchHistory(req.keyword ?? '', req.limit ?? 100)),
  );

  ipcMain.handle(IPC.HISTORY_CLEAR, (_e, req: { connId: string | null }) =>
    wrap<number>(async () => history.clearHistory(req.connId ?? undefined)),
  );

  // V6：删单条历史（区别于 clear 的整表清空 —— 危险且不可逆）
  ipcMain.handle(IPC.HISTORY_DELETE, (_e, req: { id: number }) =>
    wrap<boolean>(async () => history.deleteHistory(Number(req.id))),
  );

  // V6：星标/取消星标（星标条不受自动裁剪影响，见 HISTORY_PRUNE_KEEP）
  ipcMain.handle(IPC.HISTORY_STAR, (_e, req: { id: number; starred: boolean }) =>
    wrap<boolean>(async () => history.setStarred(Number(req.id), !!req.starred)),
  );

ipcMain.handle(IPC.SNIPPET_LIST, () => wrap(async () => history.listSnippets()));

  /**
   * v0.6.0：片段按（连接, 库）归属，库内同名即覆盖。
   *
   * 名称校验放在**主进程**而不是只靠渲染层：
   * 名称是唯一键的一部分，越界/非法名必须在写库前拦住，
   * 否则 demo 模式（渲染层校验）与真机行为会不一致。
   */
  ipcMain.handle(
    IPC.SNIPPET_SAVE,
    (
      _e,
      s: { name: string; sql: string; description?: string | null; connectionId?: string; database?: string },
    ) =>
      wrap(async () => {
  if (!isValidSnippetName(s.name)) {
   throw Object.assign(new Error(snippetNameTooLongMessage(s.name)), {
        code: ERROR_CODES.VALIDATION,
      });
    }
        const connId = s.connectionId ?? '';
        const db = s.database ?? '';
        const existing = history.getSnippet(connId, db, s.name);
        if (existing) {
     history.updateSnippet(connId, db, s.name, s.sql, s.description ?? null);
    return history.getSnippet(connId, db, s.name)!;
     }
    history.addSnippet({
   connectionId: connId,
          database: db,
          name: s.name,
          sql: s.sql,
          description: s.description ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      });
        return history.getSnippet(connId, db, s.name)!;
      }),
  );

  // ---------- 应用 ----------

  ipcMain.handle(IPC.APP_GET_MODE, () => wrap(async () => getGlassState()));

  ipcMain.handle(IPC.APP_SET_GLASS, (_e, req: { enabled: boolean }) =>
    wrap(async () => {
      setGlassEnabled(!!req?.enabled);
      return getGlassState();
    }),
  );

  ipcMain.handle(IPC.APP_DIAGNOSTICS, () =>
    wrap(async () => ({
      fps: null, // 由渲染层测（headless 测帧率无意义，见 e2e-ui.mjs）
      memMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      runningQueries: sessions.listRunning().length,
      liveConnections: countLive(deps),
      darwinMajor: process.platform === 'darwin' ? darwinMajor() : null,
    })),
  );

  // V21：手动检查更新（菜单 / 命令面板）。启动期静默检查在 main.ts 里排期。
  // T45：手动路径带 interactive —— 未接入发布通道时要给出「打开下载页」的入口；
  //       启动期静默检查不带，避免每次开机弹框。
  ipcMain.handle(IPC.APP_CHECK_UPDATE, () =>
    wrap(async () => checkForUpdate(deps.getWindow(), { interactive: true })),
  );

  // V23：在新窗口打开一张表。失败原因（如超上限）直接回中文消息给渲染层展示。
  ipcMain.handle(IPC.APP_OPEN_WINDOW, (_e, req: { connId: string; database: string; table: string }) =>
    wrap(async () => {
      const r = await deps.windows.open({
        connId: req?.connId ?? null,
        database: req?.database ?? null,
        table: req?.table ?? null,
      });
      if (!r.ok) throw codedError(ERROR_CODES.VALIDATION, r.message ?? '新窗口创建失败');
      return { opened: true };
    }),
  );

  ipcMain.handle(IPC.SECRET_STATE, () => wrap(async () => secrets.getState()));

  // ---------- 文件选择（渲染层沙箱无 fs） ----------

  ipcMain.handle(IPC.FILE_PICK_PRIVATE_KEY, () =>
    wrap<string | null>(async () => {
      /**
       * 弹系统文件选择框拿私钥路径。
       *
       * ⚠️ 只返回【路径】，绝不读内容回传 —— 私钥一旦越过 IPC 边界进渲染进程，
       *    任何 XSS 或依赖包投毒都能把它带出去。原则同"密文不进渲染层"。
       *
       * ⚠️ showOpenDialog 在【无 GUI 会话】（CI / 纯终端 / 自动化测试）下会抛错
       *    甚至挂住。这里必须 try/catch 收敛成 null（等价于用户取消），
       *    否则一次调用就能把主进程拖死。
       */
      const win = getWindow();
      if (!win || win.isDestroyed()) return null;
      try {
        const res = await dialog.showOpenDialog(win, {
          title: '选择 SSH 私钥文件',
          properties: ['openFile', 'showHiddenFiles'],
          // macOS 下允许用户手动导航到 ~/.ssh
          defaultPath: process.env.HOME ?? undefined,
        });
        if (res.canceled || res.filePaths.length === 0) return null;
        return res.filePaths[0];
      } catch {
        // 当前环境弹不出对话框 → 等同于用户取消，不能让 IPC 悬着
        return null;
      }
    }),
  );

  // ---------- BLOB/图片另存（A10） ----------

  ipcMain.handle(IPC.FILE_SAVE_BINARY, (_e, req: { suggestedName: string; data: ArrayBuffer }) =>
    wrap<string | null>(async () => {
      /**
       * 渲染层把二进制（图片/BLOB）经 IPC 传过来，这里弹保存框并写盘。
       * 与私钥路径同一原则的反向应用：渲染层沙箱无 fs，写文件必须经主进程；
       * 数据是用户主动选择保存的单元格内容，不是凭据，允许跨界。
       * 大小护栏：超过 256MB 拒绝（IPC 结构化克隆 + 内存峰值都不该这么大）。
       */
      const MAX_BYTES = 256 * 1024 * 1024;
      if (req?.data instanceof ArrayBuffer === false || req.data.byteLength === 0) {
        throw Object.assign(new Error('没有可保存的二进制数据'), { code: ERROR_CODES.VALIDATION });
      }
      if (req.data.byteLength > MAX_BYTES) {
        throw Object.assign(new Error('数据超过 256MB，请改用 SQL 导出'), { code: ERROR_CODES.VALIDATION });
      }
      const win = getWindow();
      if (!win || win.isDestroyed()) return null;
      try {
        const res = await dialog.showSaveDialog(win, {
          title: '保存二进制数据',
          defaultPath: req.suggestedName || 'blob.bin',
        });
        if (res.canceled || !res.filePath) return null;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(res.filePath, Buffer.from(req.data));
        return res.filePath;
      } catch (e: any) {
        if (e?.code === 'VALIDATION' || e?.code === 'INTERNAL') throw e;
        // 无 GUI 会话（CI/自动化）弹不出对话框 → 等同用户取消
        return null;
      }
    }),
  );

  // ---------- T41：SQL 文件编辑闭环（打开 / 读 / 保存&另存为） ----------

  /**
   * ⚠️ 与「运行 SQL 脚本」（SCRIPT_*）是两条完全不同的链路，别混：
   *    SCRIPT_* 是**执行**文件里的语句（要确认、要进历史、可能改数据）；
   *    本组只做**编辑** —— 打开不执行、保存不执行，一个字节的语义都不重叠。
   */
  ipcMain.handle(IPC.SQL_FILE_PICK, () =>
    wrap<string | null>(async () => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return null;
      try {
        const res = await dialog.showOpenDialog(win, {
          title: '打开 SQL 文件',
          properties: ['openFile', 'showHiddenFiles'],
          filters: [
            { name: 'SQL 脚本', extensions: ['sql'] },
            { name: '文本', extensions: ['txt', 'md'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (res.canceled || res.filePaths.length === 0) return null;
        return res.filePaths[0];
      } catch {
        // 无 GUI 会话弹不出对话框 → 等同用户取消（与 pickPrivateKey 同口径）
        return null;
      }
    }),
  );

  ipcMain.handle(IPC.SQL_FILE_READ, (_e, path: string) =>
    wrap<SqlFileReadResult>(async () => {
      if (typeof path !== 'string' || path === '') {
        throw codedError(ERROR_CODES.VALIDATION, '没有给出文件路径');
      }
      return readSqlFile(path);
    }),
  );

  ipcMain.handle(IPC.SQL_FILE_SAVE, (_e, req: SqlFileSaveRequest) =>
    wrap<SqlFileSaveResult>(async () => {
      /**
       * 保存流程（顺序不能换）：
       *  ① 没路径 → 弹保存框拿一个（另存为）；
       *  ② 有基线 → 先 stat 比对，**发现被外部改过就直接返回冲突、一个字节都不写**；
       *  ③ 才真正写盘（原子写），回新的戳给渲染层当下次的基线。
       */
      let target = typeof req?.path === 'string' && req.path !== '' ? req.path : null;
      if (target === null) {
        const win = getWindow();
        if (!win || win.isDestroyed()) throw codedError(ERROR_CODES.VALIDATION, '当前环境弹不出保存对话框');
        let picked: string | undefined;
        try {
          const res = await dialog.showSaveDialog(win, {
            title: '另存为 SQL 文件',
            defaultPath: req?.suggestedName || 'untitled.sql',
            filters: [{ name: 'SQL 脚本', extensions: ['sql'] }],
          });
          picked = res.canceled ? undefined : res.filePath;
        } catch {
          picked = undefined;
        }
        if (!picked) throw codedError(ERROR_CODES.CANCELLED, '已取消保存');
        target = picked;
      }

      const current = await statSqlFile(target);
      // 目标不存在时（新文件 / 原文件被删）没有可比对象 —— 不算冲突
      if (current !== null && req?.force !== true) {
        const change = detectExternalChange(req?.baseline ?? null, current);
        if (change !== 'none') {
          return {
            conflict: true,
            path: target,
            current,
          };
        }
      }
      const stamp = await writeSqlFile(target, typeof req?.content === 'string' ? req.content : '');
      return { conflict: false, path: target, stamp };
    }),
  );

  // ---------- 导出/导入（utilityProcess，见 transfer-manager.ts） ----------

  ipcMain.handle(IPC.EXPORT_START, (_e, req: ExportStartRequest) =>
    wrap(async () => transfers.exportStart(req)),
  );
  ipcMain.handle(IPC.EXPORT_CANCEL, (_e, jobId: string) =>
    wrap(async () => transfers.exportCancel(jobId)),
  );
  ipcMain.handle(IPC.EXPORT_PICK_PATH, (_e, req: { table: string; format: string }) =>
    wrap(async () => {
      // e2e 接缝：UI 自动化弹不了原生保存框。设 DB_STUDIO_E2E_TRANSFER_DIR 时
      // 返回确定性路径（跳过 dialog）—— 与 DB_STUDIO_E2E_USER_DATA 同族的测试口径
      const dir = process.env.DB_STUDIO_E2E_TRANSFER_DIR;
      if (dir) {
        const ext = req?.format === 'xlsx' ? 'xlsx' : req?.format || 'csv';
        return join(dir, `${req?.table || 'export'}.${ext}`);
      }
      return transfers.pickExportPath(req?.table ?? 'export', req?.format ?? 'csv');
    }),
  );

  ipcMain.handle(IPC.IMPORT_START, (_e, req: ImportStartRequest) =>
    wrap(async () => {
      // 只读连接不允许导入（纵深防御：UI 已挡，这里再兜一次）
      const cfg = connections.get(req.connId);
      if (cfg?.readOnly) {
        throw Object.assign(new Error('只读连接不允许导入'), { code: ERROR_CODES.READ_ONLY });
      }
      return transfers.importStart(req);
    }),
  );
  ipcMain.handle(IPC.IMPORT_CANCEL, (_e, jobId: string) =>
    wrap(async () => transfers.importCancel(jobId)),
  );
  ipcMain.handle(IPC.IMPORT_PICK_PATH, () =>
    wrap(async () => {
      // e2e 接缝：DB_STUDIO_E2E_IMPORT_FILE 指定待导入文件，跳过原生打开框
      return process.env.DB_STUDIO_E2E_IMPORT_FILE ?? transfers.pickImportPath();
    }),
  );
  ipcMain.handle(
    IPC.IMPORT_PEEK,
    (_e, req: { filePath: string; maxRows?: number }) =>
      wrap(async () => transfers.peekImportFile(req.filePath, req.maxRows ?? 50)),
  );

  // ---------- 运行 SQL 脚本（utilityProcess，见 transfer-manager.ts） ----------

  ipcMain.handle(IPC.SCRIPT_START, (_e, req: { connId: string; filePath: string; database: string; encoding?: 'utf8' | 'gbk' | null; onError?: 'stop' | 'continue' | null }) =>
    wrap(async () => {
      // 🔴 只读连接不允许执行脚本（脚本几乎必然含 DDL/DML，UI 已挡，这里纵深兜底）
      const cfg = connections.get(req.connId);
      if (cfg?.readOnly) {
        throw Object.assign(new Error('只读连接不允许执行 SQL 脚本'), { code: ERROR_CODES.READ_ONLY });
      }
      return transfers.scriptStart(req);
    }),
  );
  ipcMain.handle(IPC.SCRIPT_CONFIRM, (_e, jobId: string) =>
    wrap(async () => transfers.scriptConfirm(jobId)),
  );
  ipcMain.handle(IPC.SCRIPT_CANCEL, (_e, jobId: string) =>
    wrap(async () => transfers.scriptCancel(jobId)),
  );
  ipcMain.handle(IPC.SCRIPT_PICK_PATH, () =>
    wrap(async () => {
      // e2e 接缝：与 IMPORT_PICK_PATH 同族。FILES 支持换行分隔的多文件队列
      //（一次启动里按选择顺序依次消费 —— 脚本 UI 的多场景自测用），
      // 退而求其次用单文件变量。
      if (scriptE2EQueue === null) {
        scriptE2EQueue = (process.env.DB_STUDIO_E2E_SCRIPT_FILES ?? process.env.DB_STUDIO_E2E_SCRIPT_FILE ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return scriptE2EQueue.shift() ?? transfers.pickScriptPath();
    }),
  );
}

/** DB_STUDIO_E2E_SCRIPT_FILES 的消费队列（懒初始化，shift 一次少一个） */
let scriptE2EQueue: string[] | null = null;

// ---------- 辅助 ----------

/**
 * 剥掉连接配置里的凭据字段。
 *
 * 渲染层只需要知道「有没有存密码 / 是否每次手输」来决定 UI 形态，
 * 不需要拿到密文本体。密文一旦进了渲染进程，任何 XSS 或依赖包投毒
 * 都能把它带出去 —— 虽然解不开，但没有理由冒这个险。
 */
export function stripSecrets(cfg: ConnectionConfig): ConnectionConfig {
  return {
    ...cfg,
    passwordEnc: cfg.passwordEnc === null ? null : '', // 非空 → 表示"已保存密码"
    ssh: cfg.ssh
      ? {
          ...cfg.ssh,
          passwordEnc: cfg.ssh.passwordEnc === null ? null : '',
          passphraseEnc: cfg.ssh.passphraseEnc === null ? null : '',
        }
      : cfg.ssh,
  };
}

function countLive(deps: HandlerDeps): number {
  return deps.connections.listConnections().filter((c) => deps.sessions.isLive(c.id)).length;
}

/** 只读守卫暴露给外部（测试与未来的 SQL 编辑器共用） */
export function assertReadOnly(sql: string, dialect: 'mysql' = 'mysql'): void {
  const r = checkReadOnly(sql, dialect);
  if (!r.allowed) {
    throw Object.assign(new Error(r.message), { code: ERROR_CODES.READ_ONLY });
  }
}
