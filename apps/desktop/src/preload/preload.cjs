/**
 * Preload —— 必须是 CommonJS。
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §2.1
 *  ⚠️ sandbox:true 时 preload 必须是 CommonJS，ESM preload 会失败。
 *  （这也是本文件后缀为 .cjs 的原因，不要改成 .mjs）
 *
 * 职责：通过 contextBridge 暴露类型化的 window.dbStudio。
 * 渲染进程 nodeIntegration:false，拿不到任何 Node API，
 * 所有能力都必须经这里显式暴露 —— 这也是安全边界。
 *
 * 设计要点：
 *  - 通道名来自 ipc-channels.cjs，不在本文件硬编码字符串
 *  - 每个 invoke 都收敛成 IpcResult，渲染侧不必满屏 try/catch
 *  - 暴露 `dbStudioRuntime.hasIpc`，让渲染层能判断自己跑在什么环境里
 *    （纯浏览器 dev 模式下没有 IPC → 降级到 demo 数据，见 App.tsx）
 */

const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipc-channels.cjs');

/** 统一的 invoke 包装：把异常收敛成 IpcResult，渲染侧无需满屏 try/catch */
async function invoke(channel, payload) {
  try {
    const res = await ipcRenderer.invoke(channel, payload);
    // 主进程 handler 一律返回 IpcResult；这里兜底防止某个 handler 忘了包装
    if (res && typeof res === 'object' && 'ok' in res) return res;
    return { ok: true, data: res ?? null };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'IPC_FAILED', message: String(e && e.message ? e.message : e) },
    };
  }
}

/** 订阅主进程推送，返回退订函数 */
function subscribe(channel, cb) {
  const listener = (_evt, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('dbStudio', {
  // ---- 连接 ----
  connList: () => invoke(IPC.CONN_LIST, null),
  connCreate: (input) => invoke(IPC.CONN_CREATE, input),
  connUpdate: (input) => invoke(IPC.CONN_UPDATE, input),
  connDelete: (id) => invoke(IPC.CONN_DELETE, id),
  connConnect: (id, password) => invoke(IPC.CONN_CONNECT, { id, password: password ?? null }),
  connDisconnect: (id) => invoke(IPC.CONN_DISCONNECT, id),
  connTest: (input) => invoke(IPC.CONN_TEST, input),

  // ---- Schema ----
  schemaGet: (connId) => invoke(IPC.SCHEMA_GET, connId),
  schemaRefresh: (connId) => invoke(IPC.SCHEMA_REFRESH, connId),
  schemaGetTable: (connId, database, table) =>
    invoke(IPC.SCHEMA_GET_TABLE, { connId, database, table }),
  schemaSearchColumn: (connId, column) => invoke(IPC.SCHEMA_SEARCH_COLUMN, { connId, column }),
  // 对象定义 / 表信息（C2/C9/A14）
  schemaGetObjectDdl: (req) => invoke(IPC.SCHEMA_GET_OBJECT_DDL, req),
  schemaGetTableInfo: (req) => invoke(IPC.SCHEMA_GET_TABLE_INFO, req),
  // V9：外键导航与候选值
  schemaGetForeignKeys: (req) => invoke(IPC.SCHEMA_GET_FOREIGN_KEYS, req),
  schemaGetReferencedValues: (req) => invoke(IPC.SCHEMA_GET_REFERENCED_VALUES, req),

  // ---- 查询 ----
  queryRun: (req) => invoke(IPC.QUERY_RUN, req),
  queryOpenTable: (req) => invoke(IPC.QUERY_OPEN_TABLE, req),
  queryCancel: (queryId) => invoke(IPC.QUERY_CANCEL, queryId),
  queryRunning: () => invoke(IPC.QUERY_RUNNING, null),

  // ---- 写操作 ----
  mutationApply: (req) => invoke(IPC.MUTATION_APPLY, req),

  // ---- 导出/导入（D3 + §6.6） ----
  exportStart: (req) => invoke(IPC.EXPORT_START, req),
  exportCancel: (jobId) => invoke(IPC.EXPORT_CANCEL, jobId),
  exportPickPath: (table, format) => invoke(IPC.EXPORT_PICK_PATH, { table, format }),
  importStart: (req) => invoke(IPC.IMPORT_START, req),
  importCancel: (jobId) => invoke(IPC.IMPORT_CANCEL, jobId),
  importPickPath: () => invoke(IPC.IMPORT_PICK_PATH, null),
  // P1-10：opts.encoding / opts.delimiter = 用户改过后的重新预览
  importPeek: (filePath, maxRows, opts) =>
    invoke(IPC.IMPORT_PEEK, {
      filePath,
      maxRows: maxRows ?? 50,
      encoding: opts?.encoding ?? null,
      delimiter: opts?.delimiter ?? null,
    }),

  // ---- 运行 SQL 脚本 ----
  scriptStart: (req) => invoke(IPC.SCRIPT_START, req),
  scriptConfirm: (jobId) => invoke(IPC.SCRIPT_CONFIRM, jobId),
  scriptCancel: (jobId) => invoke(IPC.SCRIPT_CANCEL, jobId),
  scriptPickPath: () => invoke(IPC.SCRIPT_PICK_PATH, null),

  // ---- 历史与片段 ----
  historyList: (connId, limit) => invoke(IPC.HISTORY_LIST, { connId: connId ?? null, limit: limit ?? 200 }),
  historySearch: (keyword, limit) => invoke(IPC.HISTORY_SEARCH, { keyword, limit: limit ?? 100 }),
  historyClear: (connId) => invoke(IPC.HISTORY_CLEAR, { connId: connId ?? null }),
  historyDelete: (id) => invoke(IPC.HISTORY_DELETE, { id }),
  historyStar: (id, starred) => invoke(IPC.HISTORY_STAR, { id, starred }),
  snippetList: () => invoke(IPC.SNIPPET_LIST, null),
  snippetSave: (s) => invoke(IPC.SNIPPET_SAVE, s),

  // ---- 应用 ----
  appGetMode: () => invoke(IPC.APP_GET_MODE, null),
  appSetGlass: (enabled) => invoke(IPC.APP_SET_GLASS, { enabled }),
  appDiagnostics: () => invoke(IPC.APP_DIAGNOSTICS, null),
  secretState: () => invoke(IPC.SECRET_STATE, null),

  // ---- 文件选择（渲染层沙箱无 fs，必须经这里） ----
  pickPrivateKey: () => invoke(IPC.FILE_PICK_PRIVATE_KEY, null),
  // BLOB/图片另存（A10）
  saveBinary: (req) => invoke(IPC.FILE_SAVE_BINARY, req),

  // ---- T41：SQL 文件编辑闭环（打开不执行、保存不执行）----
  sqlFilePick: () => invoke(IPC.SQL_FILE_PICK, null),
  sqlFileRead: (path) => invoke(IPC.SQL_FILE_READ, path),
  sqlFileSave: (req) => invoke(IPC.SQL_FILE_SAVE, req),

  // ---- P2-18j：连接配置导入 / 导出 ----
  connBundlePick: () => invoke(IPC.CONN_BUNDLE_PICK, null),
  connBundleSave: (req) => invoke(IPC.CONN_BUNDLE_SAVE, req),

  // ---- 订阅 ----
  on: subscribe,

  // ---- W 板块：答复主进程的关闭询问（原生红按钮的唯一拦截点）----
  replyBeforeClose: (ok) => invoke(IPC.APP_BEFORE_CLOSE_REPLY, { ok: !!ok }),

  // ---- V21：手动检查更新 ----
  appCheckUpdate: () => invoke(IPC.APP_CHECK_UPDATE, null),

  // ---- V23：在新窗口打开（多窗口） ----
  openWindowInNew: (req) => invoke(IPC.APP_OPEN_WINDOW, req),
});

// 通道表也暴露出去，便于渲染侧按名订阅（避免字符串硬编码）
contextBridge.exposeInMainWorld('dbStudioChannels', IPC);

// 运行环境标记：只要这个 preload 跑起来了，就说明有真 IPC
contextBridge.exposeInMainWorld('dbStudioRuntime', { hasIpc: true });

/**
 * V23：读取主进程经 additionalArguments 注入的「新窗口初始标签」。
 *
 * 为什么走命令行参数而不是等 IPC 推送：窗口 PRIME 渲染之前就要知道开哪张表，
 * 否则会先闪一个空工作区再跳转。process.argv 在 preload 阶段就是可读的。
 * 解析失败一律返回 null（宁可开个空窗口，也不要因为一个坏参数白屏）。
 */
contextBridge.exposeInMainWorld('dbStudioInitialTab', (() => {
  try {
    const hit = process.argv.find((a) => a.startsWith('--dbstudio-open='));
    if (!hit) return null;
    const parsed = JSON.parse(hit.slice('--dbstudio-open='.length));
    if (!parsed || typeof parsed.connId !== 'string' || typeof parsed.database !== 'string' || typeof parsed.table !== 'string') {
      return null;
    }
    return { connId: parsed.connId, database: parsed.database, table: parsed.table };
  } catch {
    return null;
  }
})());
