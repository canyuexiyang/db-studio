/**
 * 导出 Worker 骨架（utilityProcess）
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §2.1 / §5.3，以及 Spike S3 实测结论
 *
 * 为什么用 utilityProcess 而不是 worker_threads：
 *   - utilityProcess 可以 kill()，因此「取消」是【真取消】而不是"跑完再丢弃"
 *   - 崩溃不拖垮主进程
 *   - S3 实测：fork → kill 延迟 6ms，进程确实消失，主进程存活
 *
 * exceljs 硬约束（TECH-REVIEW §1.5）：
 *   - 只用 stream.xlsx.WorkbookWriter，【禁止】workbook.xlsx.writeFile()（全量缓冲会 OOM）
 *   - 逐行 addRow().commit()，不构造样式对象
 *
 * S3 实测选型结论（重要）：
 *   - 采用 exceljs + useSharedStrings:false + useStyles:false（100万行 P50 6.26s）
 *   - 【不采用】手写 sheet XML：虽快 2 倍，但日期会退化为裸数字（无 numFmt 样式），
 *     "失去样式能力"的真实代价是数据类型损坏
 *   - 导出峰值内存实测 987MB（不是评审预估的 <500MB）
 *
 * 取消语义（PRD §八 验收项）：
 *   kill 后输出文件是【半截的】，必须删除或标记未完成，不能残留打不开的 .xlsx
 */

import type { ChildProcess } from 'node:child_process';

/**
 * Electron 的 `UtilityProcess`（来自 `electron` 的 `utilityProcess.fork()`）。
 *
 * 本模块刻意【不 import electron】（保持可在无 GUI 环境单测），所以这里声明
 * 最小结构接口而不是引它的类型。注意：`UtilityProcess` 不在 `node:child_process`
 * 里 —— 早期版本从那里 import 是类型错误（tsc 全量检查时才暴露）。
 */
export interface UtilityProcessLike {
  pid?: number;
  kill(): boolean;
  on(event: 'message', listener: (msg: unknown) => void): void;
}

/** 导出格式（R1：新增 markdown，DBeaver 对齐） */
export type ExportFormat = 'xlsx' | 'csv' | 'json' | 'sql' | 'markdown';

/** 导出细化配置（E2）：缺省字段用各格式历史默认值 */
export interface ExportTextOptions {
  delimiter?: string | null;
  encoding?: 'utf8' | 'utf8-bom' | null;
  /** NULL 值文本表示（默认 \N） */
  nullText?: string | null;
  includeHeader?: boolean | null;
}

/** 导出任务参数（跨进程传递，必须可结构化克隆） */
export interface ExportJob {
  jobId: string;
  format: ExportFormat;
  /** 输出文件绝对路径 */
  outputPath: string;
  /** 目标表名（SQL/CSV/JSON 需要） */
  tableName?: string;
  /** 列定义（顺序即输出列顺序） */
  columns: { name: string; dataType: string }[];
  /** 连接信息（不含明文密码，密码由主进程解密后传入或用 token 换取） */
  connection: {
    host: string;
    port: number;
    user: string;
    /** 已解密的密码，仅存活于 worker 进程内存 */
    password: string | null;
    database: string;
  };
  /** 查询 SQL（若为 null 则 SELECT * FROM table） */
  sql?: string;
  /** 细化配置（E2），csv/markdown 生效 */
  options?: ExportTextOptions | null;
  /** 'table'（默认）= 单表；'database' = 整库全部表（E4 轻量备份，仅 sql/markdown） */
  scope?: 'table' | 'database' | null;
  /** 单批行数，用于进度上报 */
  batchSize?: number;
}

/** Worker → 主进程的消息 */
export type ExportMessage =
  | { type: 'progress'; jobId: string; rowsWritten: number; elapsedMs: number }
  | { type: 'done'; jobId: string; rowsWritten: number; elapsedMs: number; bytes: number }
  | { type: 'error'; jobId: string; message: string; fatal: boolean }
  | { type: 'cancelled'; jobId: string; rowsWritten: number };

export interface ExportResult {
  rowsWritten: number;
  elapsedMs: number;
  bytes: number;
}

/**
 * 导出任务的句柄 —— 主进程侧使用它来控制 worker。
 * 关键：cancel() 调用的是 utilityProcess 的 kill()，是【真取消】。
 */
export class ExportTask {
  private child: UtilityProcessLike | ChildProcess | null = null;
  private cancelled = false;
  private startedAt = 0;
  /** 已写入行数。取消后要据此决定是否清理半截文件 */
  private rowsWritten = 0;

  constructor(
    readonly jobId: string,
    readonly outputPath: string,
  ) {}

  attach(child: UtilityProcessLike | ChildProcess): void {
    this.child = child;
    this.startedAt = Date.now();
  }

  onProgress(cb: (rows: number, elapsedMs: number) => void): void {
    this.child?.on('message', (msg: any) => {
      if (msg?.type === 'progress' && msg.jobId === this.jobId) {
        this.rowsWritten = msg.rowsWritten;
        cb(msg.rowsWritten, msg.elapsedMs);
      }
    });
  }

  onDone(cb: (r: ExportResult) => void): void {
    this.child?.on('message', (msg: any) => {
      if (msg?.type === 'done' && msg.jobId === this.jobId) {
        cb({ rowsWritten: msg.rowsWritten, elapsedMs: msg.elapsedMs, bytes: msg.bytes });
      }
    });
  }

  onError(cb: (msg: string, fatal: boolean) => void): void {
    this.child?.on('message', (msg: any) => {
      if (msg?.type === 'error' && msg.jobId === this.jobId) {
        cb(msg.message, msg.fatal);
      }
    });
  }

  /**
   * 取消导出。
   * 这是本模块存在的理由：utilityProcess.kill() 是真正的进程终止，
   * 不像 worker_threads 只能"跑完再丢弃"。
   * S3 实测 kill 延迟 6ms，进程确实消失。
   */
  cancel(): boolean {
    // 无论能否真正 kill，用户的取消意图必须被记录 —— 否则 UI 会一直显示"进行中"
    if (this.cancelled) return false;
    this.cancelled = true;

    // 尚未 attach 子进程（任务还没起来）：只能标记意图，返回 false 让调用方知晓
    if (!this.child) return false;

    try {
      return Boolean((this.child as any).kill());
    } catch {
      // kill 失败（进程已退出）：状态已标记，返回 false
      return false;
    }
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** 已写入行数（取消时用于判断有没有留下半截文件） */
  get written(): number {
    return this.rowsWritten;
  }
}

// ---------- 纯逻辑：可单测，不需 Electron ----------

/** xlsx 单元格上限（PRD Q6） */
export const XLSX_MAX_CELL_CHARS = 32_767;

/** XML 1.0 非法控制字符 —— 不清会让 xlsx 损坏打不开（PRD Q6） */
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * 单元格值清洗（PRD Q6 的 B 方案：截断 + 非法字符清理）。
 * 返回 { value, truncated } 便于生成坐标报告。
 *
 * 注意：这段逻辑来自 S3 的 E4 实现，是那次实验最有价值的产出之一，
 * 无论最终选 exceljs 还是手写 XML 都需要它。
 *
 * ⚠️ Date 必须原样传给 exceljs —— S3 实测的 E4 缺陷正是"把日期转成裸数字
 * 且不带 numFmt"，导致 Excel 里显示成一串数字。这里保留 Date 类型就是防线。
 */
export function sanitizeCell(
  value: unknown,
): { value: string | number | boolean | Date | null; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { value: String(value), truncated: false };
    return { value, truncated: false };
  }
  if (typeof value === 'boolean') return { value, truncated: false };
  if (value instanceof Date) return { value, truncated: false };

  const s = String(value);
  const cleaned = s.replace(ILLEGAL_XML_CHARS, '');
  if (cleaned.length > XLSX_MAX_CELL_CHARS) {
    return { value: cleaned.slice(0, XLSX_MAX_CELL_CHARS), truncated: true };
  }
  return { value: cleaned, truncated: cleaned !== s };
}

/**
 * Excel 序列号转换（1899-12-30 起算）。
 * 手写 XML 路径需要；也用于校验 exceljs 的日期输出是否符合预期。
 */
export function dateToExcelSerial(d: Date): number {
  return (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** 列索引 → A1 列名 */
export function columnName(index0: number): string {
  let s = '';
  let n = index0 + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 生成 CSV 行（RFC 4180）。
 * 导出 CSV 时不走 exceljs，直接手写更快且内存可控。
 */
export function csvRow(values: unknown[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString();
      const s = String(v);
      // 含逗号/引号/换行 → 加引号并转义内部引号
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    })
    .join(',');
}

/**
 * 按 S3 实测结论生成 exceljs writer 选项。
 * 强制 useSharedStrings:false + useStyles:false —— 默认配置会慢 3 倍且内存高 2.8 倍。
 */
export function excelWriterOptions(filename: string): {
  filename: string;
  useSharedStrings: boolean;
  useStyles: boolean;
} {
  return { filename, useSharedStrings: false, useStyles: false };
}

// ---------- Markdown 表格（E1） ----------

/** Markdown 导出选项（E1）：与 ExportTextOptions.nullText 同口径 */
export interface MarkdownTableOptions {
  /** NULL 值的文本表示（默认 \N） */
  nullText?: string | null;
}

/**
 * Markdown 表格单元格转义：
 *  - 竖线转 `\|`，否则会把单元格撕裂（Markdown 表格的列分隔符就是 |）
 *  - 换行转 `<br>`（GitHub 方言约定）：表格单元格内不允许裸换行，
 *    直接丢掉换行会破坏数据保真，`<br>` 是可还原度最好的表示
 */
export function markdownEscapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * 生成 Markdown 表格（E1）：表头行 + `|---|` 分隔行 + 值行。
 *
 * export-worker 的 markdown 路径按【行】流式写同一套规则（内存有界），
 * 本函数是整表形态的纯引用实现 —— 改转义规则必须两处同步（见 worker 注释）。
 */
export function toMarkdownTable(
  columns: { name: string }[],
  rows: unknown[][],
  options?: MarkdownTableOptions,
): string {
  const nullText = options?.nullText == null ? '\\N' : String(options.nullText);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return nullText;
    if (v instanceof Date) return v.toISOString();
    return markdownEscapeCell(String(v));
  };
  const lines: string[] = [];
  lines.push(`| ${columns.map((c) => markdownEscapeCell(c.name)).join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    lines.push(`| ${columns.map((_, i) => cell(r[i])).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** 是否为流式 writer 的禁用 API（用于静态自检） */
export const FORBIDDEN_EXCELJS_APIS = ['writeFile', 'writeBuffer'] as const;
