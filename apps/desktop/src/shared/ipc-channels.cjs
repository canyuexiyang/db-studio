/**
 * IPC 通道常量的 CommonJS 版本。
 *
 * 为什么需要两份：
 *   sandbox:true 时 preload 必须是 CommonJS（ESM preload 会失败），
 *   但主进程与渲染进程用的是 ESM/TS。为了让通道名只有一处定义，
 *   这里以 CJS 形式提供同一份常量表给 preload 使用。
 *
 * ⚠️ 修改通道时必须同步改 ipc-channels.ts —— 两者必须保持一致。
 *   （ipc-channels.test.ts 里有对比校验，改漏了测试会红）
 */

const IPC = {
  CONN_LIST: 'conn:list',
  CONN_CREATE: 'conn:create',
  CONN_UPDATE: 'conn:update',
  CONN_DELETE: 'conn:delete',
  CONN_CONNECT: 'conn:connect',
  CONN_DISCONNECT: 'conn:disconnect',
  CONN_TEST: 'conn:test',

  SCHEMA_GET: 'schema:get',
  SCHEMA_REFRESH: 'schema:refresh',
  SCHEMA_GET_TABLE: 'schema:getTable',
  SCHEMA_SEARCH_COLUMN: 'schema:searchColumn',
  SCHEMA_GET_OBJECT_DDL: 'schema:getObjectDdl',
  SCHEMA_GET_TABLE_INFO: 'schema:getTableInfo',
  // V9：外键导航与候选值（两份通道表必须一致，有测试守着）
  SCHEMA_GET_FOREIGN_KEYS: 'schema:getForeignKeys',
  SCHEMA_GET_REFERENCED_VALUES: 'schema:getReferencedValues',

  QUERY_RUN: 'query:run',
  QUERY_OPEN_TABLE: 'query:openTable',
  QUERY_CANCEL: 'query:cancel',
  QUERY_RUNNING: 'query:running',

  MUTATION_APPLY: 'mutation:apply',

  EXPORT_START: 'export:start',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_PICK_PATH: 'export:pickPath',
  IMPORT_START: 'import:start',
  IMPORT_CANCEL: 'import:cancel',
  IMPORT_PICK_PATH: 'import:pickPath',
  IMPORT_PEEK: 'import:peek',

  SCRIPT_START: 'script:start',
  SCRIPT_CONFIRM: 'script:confirm',
  SCRIPT_CANCEL: 'script:cancel',
  SCRIPT_PICK_PATH: 'script:pickPath',

  HISTORY_LIST: 'history:list',
  HISTORY_SEARCH: 'history:search',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_DELETE: 'history:delete',
  HISTORY_STAR: 'history:star',
  SNIPPET_LIST: 'snippet:list',
  SNIPPET_SAVE: 'snippet:save',

  SECRET_STATE: 'secret:state',

  APP_GET_MODE: 'app:getMode',
  APP_SET_GLASS: 'app:setGlass',
  APP_DIAGNOSTICS: 'app:diagnostics',
  // W 板块：窗口关闭前询问渲染层「能否关闭」。
  // ⚠️ ASK（主→渲染推送）刻意不在这里 —— 它不是 invoke 通道，
  //    有测试守卫「IPC 表里每个通道都注册了 handler」。见 EVENT_BEFORE_CLOSE_ASK。
  APP_BEFORE_CLOSE_REPLY: 'app:beforeCloseReply',
  APP_CHECK_UPDATE: 'app:checkUpdate',
  APP_OPEN_WINDOW: 'app:openWindow',

  FILE_PICK_PRIVATE_KEY: 'file:pickPrivateKey',
  FILE_SAVE_BINARY: 'file:saveBinary',
};

/**
 * 单向推送通道（只被订阅，不被 invoke）—— 与 ipc-channels.ts 保持同值。
 * preload 与渲染层用它们按名订阅，避免字符串硬编码。
 */
const EVENT_BEFORE_CLOSE_ASK = 'app:beforeCloseAsk';

module.exports = { IPC, EVENT_BEFORE_CLOSE_ASK };
