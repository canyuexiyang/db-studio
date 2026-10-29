/**
 * 渲染层专用的 IPC 类型入口。
 *
 * 为什么不直接 alias 到 ipc-channels.ts：
 *  那个文件所在目录还有 window.ts（import electron）、main.ts 等主进程代码。
 *  渲染层只需要【类型】，但 alias 指到文件本身会让人误以为可以引实现，
 *  一旦有人 `import { IPC } from '@dbstudio/shared-ipc'` 就会把 electron 拖进
 *  渲染层 bundle —— 这在 S2 的 1.5MB 首屏硬约束下是事故。
 *
 * 所以这里 re-export 类型并重申 global 声明，实现部分一个都不带。
 */

export type {
  DbStudioApi,
  IpcResult,
  ConnListResult,
  ConnectResult,
  QueryOutcomeDto,
  OpenTableRequest,
  RunQueryRequest,
  MutationApplyRequest,
  MutationApplyResult,
  TableBundle,
  GlassModeDto,
  DiagnosticsDto,
  SecretStateDto,
  SaveConnectionRequest,
  ErrorCode,
  ExportStartRequest,
  ImportStartRequest,
  ImportPeekResult,
  ImportPeekOptions,
  ImportDoneResult,
  ExportFormat,
  ExportOptions,
  DbObjectKind,
  ObjectDdlRequest,
  ObjectDdlResult,
  TableInfoRequest,
  TableInfoDto,
  ForeignKeysRequest,
  ForeignKeyDto,
  ReferencedValuesRequest,
  ReferencedValuesDto,
  ScriptStartRequest,
  ScriptScanStats,
  ScriptErrorDetail,
  ScriptDoneResult,
  UpdateCheckResult,
} from './ipc-channels.js';

// 全局声明必须在这里【再写一遍】：
// `declare global` 只在被实际引入的模块里生效，而渲染层通过 type-only import
// 引用 ipc-channels 时，其 global 声明不会参与合并。
declare global {
  interface Window {
    dbStudio: import('./ipc-channels.js').DbStudioApi;
    dbStudioChannels: Record<string, string>;
    dbStudioRuntime: { hasIpc: boolean };
    /** V23：主进程注入的「新窗口初始标签」，普通窗口为 null */
    dbStudioInitialTab: { connId: string; database: string; table: string } | null;
  }
}
