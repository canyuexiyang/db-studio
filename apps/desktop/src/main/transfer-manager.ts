/**
 * 导入导出管理器 —— utilityProcess 生命周期 + 进度推送的统一持有者。
 *
 * 为什么不放 ipc-handlers.ts：
 *  - handler 文件已经 460 行，转移逻辑有独立的「任务表 + 取消 + 推送」状态，
 *    混进去会让两件事都变得难测；
 *  - 管理器可以注入 utilityProcess.fork（测试用替身），保持 ipc-handlers
 *    的既有单测形态不动。
 *
 * 关键设计：
 *  - 🔴 worker 文件用绝对路径 fork —— utilityProcess 不走 vite 构建（ESM/CJS
 *    互转在 Electron 44 下坑多），原样拷贝到 dist（scripts/copy-workers.mjs）
 *  - 🔴 取消 = kill() 真取消；被 kill 的 worker 发不出消息，
 *    「cancelled」状态在主进程侧判定并推送
 *  - 🔴 密码解密后只进 worker 进程内存，不进任何日志
 *  - 导出/导入失败或取消时**必须清理半截文件**（PRD §八验收）
 */

import { utilityProcess, dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ExportTask, type ExportJob } from '@dbstudio/core-export';
import type { ConnectionStore } from './connection-store.js';
import type { SessionRegistry } from './session-registry.js';

/** 渲染层订阅的推送通道（与 EVENT_CONN_STATE 同风格） */
export const EVENT_EXPORT = 'event:export';
export const EVENT_IMPORT = 'event:import';
/** 运行 SQL 脚本的进度/摘要推送（scan/progress/done/error） */
export const EVENT_SCRIPT = 'event:script';

/** JSON 导入的大小护栏（peek 与 import-worker 同值）：JSON.parse 无法流式 */
const JSON_PEEK_MAX_BYTES = 100 * 1024 * 1024;

export interface ExportRequest {
  connId: string;
  format: 'xlsx' | 'csv' | 'json' | 'sql' | 'markdown';
  outputPath: string;
  database: string;
  table: string;
  /** 不传 = SELECT * FROM table */
  sql?: string | null;
  /** 不传 = 从表元数据取（渲染层负责传，worker 不查 schema） */
  columns?: { name: string; dataType: string }[] | null;
  /** 'table'（默认）= 单表；'database' = 整库全部表（E4 轻量备份，仅 sql/markdown） */
  scope?: 'table' | 'database' | null;
  /** 导出细化配置（E2） */
  options?: {
    delimiter?: string | null;
    encoding?: 'utf8' | 'utf8-bom' | null;
    nullText?: string | null;
    includeHeader?: boolean | null;
  } | null;
}

export interface ImportRequest {
  connId: string;
  filePath: string;
  format: 'csv' | 'tsv' | 'xlsx' | 'json';
  delimiter?: string | null;
  hasHeader: boolean;
  database: string;
  table: string;
  mapping: (string | null)[];
  columns: { name: string; dataType: string; nullable: boolean; autoIncrement: boolean }[];
  batchSize?: number;
  /** E5 失败行重跑：只导这些文件行号（0 基，不含表头）。缺省 = 全部行 */
  retryRows?: number[] | null;
}

interface TaskEntry {
  kind: 'export' | 'import' | 'script';
  jobId: string;
  connId: string;
  /** 输出/输入路径：取消或失败时要清理半截产物（仅导出侧清理） */
  outputPath: string;
  process: import('electron').UtilityProcess | null;
  cancelled: boolean;
  startedAt: number;
}

/** 测试可注入的 fork 形态（electron 的 UtilityProcess 结构） */
export type ForkFn = (
  path: string,
) => {
  kill(): boolean;
  /**
   * 🔴 Electron 44 实测：主进程侧 message 事件的参数是【裸消息对象】，
   *    不是 worker 侧 parentPort 的 {data} 包装。两种形态别搞混：
   *    - worker 里 process.parentPort.on('message', e => e.data) —— 有包装
   *    - 主进程 child.on('message', msg => msg) —— 无包装
   */
  on(event: string, cb: (msg: unknown) => void): void;
  postMessage(msg: unknown): void;
};

export interface TransferManagerDeps {
  connections: ConnectionStore;
  sessions: SessionRegistry;
  getWindow: () => BrowserWindow | null;
  /** fork 工厂：默认用 electron utilityProcess.fork，测试注入替身 */
  fork?: ForkFn;
}

export class TransferManager {
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly fork: ForkFn;

  constructor(private readonly deps: TransferManagerDeps) {
    this.fork =
      deps.fork ??
      ((path: string) => utilityProcess.fork(path, undefined, { stdio: 'pipe' }) as unknown as ReturnType<ForkFn>);
  }

  /** workers 目录：主进程产物（dist/main/main.cjs）的旁挂目录 */
  private workerPath(name: string): string {
    // dist/main/main.cjs → dist/main/workers/xxx.cjs
    const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    return join(here, 'workers', name);
  }

  private push(channel: string, payload: unknown): void {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  /** 连接参数 + 解密密码（只进 worker 内存）。database 用请求里表实际所在的库 */
  private async connectionFor(connId: string, database?: string | null): Promise<{
    host: string; port: number; user: string; password: string | null; database: string;
  }> {
    const cfg = this.deps.connections.get(connId);
    if (!cfg) throw Object.assign(new Error('连接不存在'), { code: 'NOT_FOUND' });
    if (!this.deps.sessions.isLive(connId)) {
      throw Object.assign(new Error('连接未建立，先连接再导出'), { code: 'NOT_CONNECTED' });
    }
    const password = await this.deps.connections.passwordFor(connId);
    return {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      // 🔴 请求里带的库（表实际所在的库）优先于连接的默认库 —— 2026-09-26 自测抓到的
      //    缺陷：导出非默认库的表 / 连接未设默认库时，worker 会拿到空库名，
      //    报 "Incorrect database name ''"。表属于哪个库由调用方（UI/树节点）决定。
      database: database || cfg.defaultDatabase || '',
    };
  }

  // ---------- 导出 ----------

  async exportStart(req: ExportRequest): Promise<{ jobId: string }> {
    const connection = await this.connectionFor(req.connId, req.database);
    const jobId = randomUUID();

    // 列定义兜底：渲染层没传就查表元数据。两条路径例外（worker 自己解决列名）：
    //  - 自定义 SQL（B7）：列集合要执行了才知道，worker 从 fields 事件兜底
    //  - 整库（E4）：逐表 SHOW COLUMNS，单表元数据没有意义
    let columns = req.columns && req.columns.length > 0 ? req.columns : null;
    if (!columns && !req.sql && req.scope !== 'database') {
      const table = await this.deps.sessions.getTable(req.connId, req.database, req.table);
      columns = (table?.columns ?? []).map((c) => ({ name: c.name, dataType: c.dataType }));
    }

    const job: ExportJob = {
      jobId,
      format: req.format,
      outputPath: req.outputPath,
      tableName: req.table,
      columns: columns ?? [],
      connection,
      sql: req.sql || undefined,
      // E2 细化选项 / E4 范围：原样透传，worker 按格式自行取舍
      options: req.options ?? undefined,
      scope: req.scope ?? undefined,
      batchSize: 1000,
    };

    const entry: TaskEntry = {
      kind: 'export',
      jobId,
      connId: req.connId,
      outputPath: req.outputPath,
      process: null,
      cancelled: false,
      startedAt: Date.now(),
    };
    this.tasks.set(jobId, entry);

    const child = this.fork(this.workerPath('export-worker.cjs'));
    entry.process = child as unknown as import('electron').UtilityProcess;

    const task = new ExportTask(jobId, req.outputPath);
    task.attach(child as never);

    // 转发 worker 消息到渲染层（参数是裸消息，不是 {data} 包装 —— 见 ForkFn 注释）
    child.on('message', (msg: any) => {
      if (!msg || msg.jobId !== jobId) return;
      this.push(EVENT_EXPORT, msg);
      if (msg.type === 'done' || msg.type === 'error') this.tasks.delete(jobId);
    });

    child.postMessage(job);

    return { jobId };
  }

  async exportCancel(jobId: string): Promise<boolean> {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.kind !== 'export') return false;
    entry.cancelled = true;
    const killed = entry.process?.kill() ?? false;
    // 半截文件必须清理（PRD §八：取消不留打不开的 .xlsx）
    try {
      if (existsSync(entry.outputPath)) unlinkSync(entry.outputPath);
    } catch {
      // 清不掉不挡取消流程（文件可能被杀的 worker 还握着句柄，
      // macOS 下 unlink 同步删除通常仍成功）
    }
    this.push(EVENT_EXPORT, { type: 'cancelled', jobId, rowsWritten: 0 });
    this.tasks.delete(jobId);
    return killed;
  }

  // ---------- 导入 ----------

  async importStart(req: ImportRequest): Promise<{ jobId: string }> {
    if (!existsSync(req.filePath)) {
      throw Object.assign(new Error('导入文件不存在'), { code: 'NOT_FOUND' });
    }
    const connection = await this.connectionFor(req.connId, req.database);
    const jobId = randomUUID();

    const entry: TaskEntry = {
      kind: 'import',
      jobId,
      connId: req.connId,
      outputPath: req.filePath,
      process: null,
      cancelled: false,
      startedAt: Date.now(),
    };
    this.tasks.set(jobId, entry);

    const child = this.fork(this.workerPath('import-worker.cjs'));
    entry.process = child as unknown as import('electron').UtilityProcess;

    child.on('message', (msg: any) => {
      if (!msg || msg.jobId !== jobId) return;
      this.push(EVENT_IMPORT, msg);
      if (msg.type === 'done' || msg.type === 'error') this.tasks.delete(jobId);
    });

    child.postMessage({
      jobId,
      filePath: req.filePath,
      format: req.format,
      delimiter: req.delimiter ?? undefined,
      hasHeader: req.hasHeader,
      batchSize: req.batchSize ?? 1000,
      mapping: req.mapping,
      columns: req.columns,
      connection,
      database: req.database,
      tableName: req.table,
      // E5 失败行重跑：0 基数据行号，worker 侧 filterRetryRows 再规整一遍
      retryRows: req.retryRows ?? undefined,
    });

    return { jobId };
  }

  /** 导入中途取消：已插入的行不回滚（D3 语义），仅停止后续批次 */
  async importCancel(jobId: string): Promise<boolean> {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.kind !== 'import') return false;
    entry.cancelled = true;
    const killed = entry.process?.kill() ?? false;
    this.push(EVENT_IMPORT, { type: 'cancelled', jobId, rowsDone: 0 });
    this.tasks.delete(jobId);
    return killed;
  }

  // ---------- 运行 SQL 脚本 ----------

  /**
   * 发起脚本执行。worker 先做【扫描】（语句数/类型分布/危险检出），
   * scan 消息推给渲染层等用户确认摘要后，由 scriptConfirm 放行执行 ——
   * 「写操作先展示」红线在脚本场景的落地形态。
   */
  async scriptStart(req: {
    connId: string;
    filePath: string;
    database: string;
    encoding?: 'utf8' | 'gbk' | null;
    onError?: 'stop' | 'continue' | null;
  }): Promise<{ jobId: string }> {
    if (!existsSync(req.filePath)) {
      throw Object.assign(new Error('脚本文件不存在'), { code: 'NOT_FOUND' });
    }
    const connection = await this.connectionFor(req.connId, req.database);
    const jobId = randomUUID();

    const entry: TaskEntry = {
      kind: 'script',
      jobId,
      connId: req.connId,
      outputPath: req.filePath,
      process: null,
      cancelled: false,
      startedAt: Date.now(),
    };
    this.tasks.set(jobId, entry);

    const child = this.fork(this.workerPath('sql-script-worker.cjs'));
    entry.process = child as unknown as import('electron').UtilityProcess;

    child.on('message', (msg: any) => {
      if (!msg || msg.jobId !== jobId) return;
      this.push(EVENT_SCRIPT, msg);
      if (msg.type === 'done' || msg.type === 'error') this.tasks.delete(jobId);
    });

    child.postMessage({
      jobId,
      filePath: req.filePath,
      encoding: req.encoding ?? 'utf8',
      onError: req.onError ?? 'stop',
      connection,
    });

    return { jobId };
  }

  /** 用户确认扫描摘要后放行 worker 继续执行 */
  scriptConfirm(jobId: string): boolean {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.kind !== 'script') return false;
    entry.process?.postMessage({ type: 'execute' });
    return true;
  }

  /** 取消脚本任务（扫描等待期 / 执行中）：kill worker = 真取消 */
  scriptCancel(jobId: string): boolean {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.kind !== 'script') return false;
    entry.cancelled = true;
    const killed = entry.process?.kill() ?? false;
    this.push(EVENT_SCRIPT, { type: 'cancelled', jobId });
    this.tasks.delete(jobId);
    return killed;
  }

  // ---------- 文件对话框 ----------

  /** 导出：弹保存框。取消返回 null（无 GUI 环境同 null，不能挂住） */
  async pickExportPath(
    table: string,
    format: string,
  ): Promise<string | null> {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      const ext = format === 'xlsx' ? 'xlsx' : format;
      const res = await dialog.showSaveDialog(win, {
        title: `导出 ${table}`,
        defaultPath: `${table}.${ext}`,
        filters: [
          { name: format.toUpperCase(), extensions: [ext] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      return res.canceled ? null : res.filePath;
    } catch {
      return null;
    }
  }

  /** 导入：弹打开框（csv/tsv/xlsx/json）。取消返回 null */
  async pickImportPath(): Promise<string | null> {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '选择导入文件',
        properties: ['openFile'],
        filters: [
          { name: '表格文件', extensions: ['csv', 'tsv', 'xlsx', 'xls', 'json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0];
    } catch {
      return null;
    }
  }

  /** 运行 SQL 脚本：弹打开框（.sql）。取消返回 null */
  async pickScriptPath(): Promise<string | null> {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '选择 SQL 脚本文件',
        properties: ['openFile'],
        filters: [
          { name: 'SQL 脚本', extensions: ['sql'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0];
    } catch {
      return null;
    }
  }

  /**
   * 读取导入文件预览（前 N 行 + 推测分隔符），用于向导第 1/2 步。
   * JSON（E3）：返回首行 = 键序伪表头，其后 = 前 N 个对象的值序列 ——
   * 渲染层把首行拆出来当「对象键 → 表列」映射的左列，数据行从 0 重编号，
   * 因此伪表头不会污染行号口径（worker 对 json 强制按无表头处理）。
   */
  async peekImportFile(
    filePath: string,
    maxRows = 50,
  ): Promise<{ rows: string[][]; delimiter: '\t' | ',' | ';'; format: string }> {
    if (!existsSync(filePath)) {
      throw Object.assign(new Error('文件不存在'), { code: 'NOT_FOUND' });
    }
    const ext = filePath.toLowerCase().split('.').pop() ?? '';
    if (ext === 'xlsx' || ext === 'xls') {
      // xlsx 预览也走 worker 太重：主进程直接读（预览只取前几十行，内存可控）
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.worksheets[0];
      if (!ws) return { rows: [], delimiter: ',', format: 'xlsx' };
      const rows: string[][] = [];
      let n = 0;
      ws.eachRow((row) => {
        if (n++ >= maxRows) return;
        const vals: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          vals.push(xlsxCellText(cell.value));
        });
        rows.push(vals);
      });
      return { rows, delimiter: ',', format: 'xlsx' };
    }

    if (ext === 'json') {
      // JSON.parse 无法流式，超限会顶爆主进程内存 —— 与 import-worker 的护栏同值
      const { statSync, readFileSync } = await import('node:fs');
      if (statSync(filePath).size > JSON_PEEK_MAX_BYTES) {
        throw Object.assign(new Error('JSON 文件超过 100MB，暂不支持导入（请先拆分文件）'), {
          code: 'TOO_LARGE',
        });
      }
      const { stripBom, normalizeJsonRows, jsonCellText } = await import('@dbstudio/core-import');
      // 带 BOM 的文件 JSON.parse 会直接抛 "Unexpected token"，先剥掉
      const parsed = JSON.parse(stripBom(readFileSync(filePath, 'utf8')));
      const { rows: objs, keys } = normalizeJsonRows(parsed);
      const valueRows = objs.slice(0, maxRows).map((o) => keys.map((k) => jsonCellText(o[k])));
      return { rows: [keys, ...valueRows], delimiter: ',', format: 'json' };
    }

    const { readFileSync } = await import('node:fs');
    const text = readFileSync(filePath, 'utf8');
    const { sniffDelimiter, parseDelimited } = await import('@dbstudio/core-import');
    const delimiter = sniffDelimiter(text);
    const all = parseDelimited(text, delimiter);
    return { rows: all.slice(0, maxRows), delimiter, format: ext === 'tsv' ? 'tsv' : 'csv' };
  }

  /** 清理（应用退出时）：杀掉所有活着的 worker */
  cancelAll(): void {
    for (const entry of [...this.tasks.values()]) {
      try {
        entry.process?.kill();
      } catch {}
    }
    this.tasks.clear();
  }

  get runningCount(): number {
    return this.tasks.size;
  }
}

/** exceljs 单元格值 → 展示文本（richText / 超链接 / 公式 / 错误值收窄） */
function xlsxCellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v !== 'object') return String(v);
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText)) {
    return o.richText.map((r) => String((r as { text?: unknown }).text ?? '')).join('');
  }
  if (typeof o.text === 'string') return o.text;
  if ('result' in o) return o.result == null ? '' : String(o.result);
  if (o.error) return '';
  return String(o);
}
