/**
 * D3 导入核心（PRD §6.6.2-B：仅追加 INSERT，4 步向导）
 *
 * ⚠️ 实现全在 ./runtime.cjs（CJS）—— utilityProcess worker 不经 vite 构建，
 *    require 本包时 package.json 的 main 走到那里。本文件只负责：
 *     1. 给 vite/tsx/单测环境提供带类型的 ESM 出口（re-export）
 *     2. 类型定义（编译期契约）
 *
 * 🔴 双实现漂移防线：index.test.ts 同时 require runtime.cjs 与 import 本文件，
 *    两边行为不一致会红。改逻辑只改 runtime.cjs。
 */

import type { ColumnMeta } from '@dbstudio/core-schema-cache';

/** runtime.cjs 的类型化形状（与实现一一对应） */
interface ImportRuntime {
  parseDelimited(text: string, delimiter: string): string[][];
  stripBom(s: string): string;
  utf8BomLength(bytes: Uint8Array): number;
  sniffEncoding(bytes: Uint8Array): ImportEncoding;
  decodeBytes(bytes: Uint8Array, encoding: ImportEncoding | string): string;
  normalizeEncoding(encoding: string | null | undefined): ImportEncoding;
  sniffDelimiter(sample: string): '\t' | ',' | ';';
  guessMapping(fileHeaders: string[], tableColumns: ColumnMeta[]): MappingSuggestion;
  cellTextToValue(raw: string): string | null;
  buildInsertBatches(
    database: string,
    tableName: string,
    rows: string[][],
    mapping: (string | null)[],
    columns: ColumnMeta[],
    opts: { hasHeader?: boolean; batchSize?: number; retryRows?: number[] },
  ): BatchPlan;
  validatePreview(
    rows: string[][],
    mapping: (string | null)[],
    columns: ColumnMeta[],
    hasHeader: boolean,
  ): { issues: ImportRowIssue[] };
  issuesToCsv(issues: ImportRowIssue[]): string;
  validateCellText(raw: string, col: ColumnMeta): string | null;
  normalizeJsonRows(parsed: unknown): JsonRowsResult;
  jsonCellText(v: unknown): string;
  filterRetryRows(totalRows: number, retryRows: unknown): number[];
  createStatementSplitter(
    onStatement: (sql: string, line: number) => void,
  ): ScriptStatementSplitter;
  classifyScriptStatement(sql: string): ScriptStatementClass;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtime = require('./runtime.cjs') as ImportRuntime;

export const parseDelimited: ImportRuntime['parseDelimited'] = runtime.parseDelimited;
export const stripBom: ImportRuntime['stripBom'] = runtime.stripBom;
export const utf8BomLength: ImportRuntime['utf8BomLength'] = runtime.utf8BomLength;
export const sniffEncoding: ImportRuntime['sniffEncoding'] = runtime.sniffEncoding;
export const decodeBytes: ImportRuntime['decodeBytes'] = runtime.decodeBytes;
export const normalizeEncoding: ImportRuntime['normalizeEncoding'] = runtime.normalizeEncoding;
export const sniffDelimiter: ImportRuntime['sniffDelimiter'] = runtime.sniffDelimiter;
export const guessMapping: ImportRuntime['guessMapping'] = runtime.guessMapping;
export const cellTextToValue: ImportRuntime['cellTextToValue'] = runtime.cellTextToValue;
export const buildInsertBatches: ImportRuntime['buildInsertBatches'] = runtime.buildInsertBatches;
export const validatePreview: ImportRuntime['validatePreview'] = runtime.validatePreview;
export const issuesToCsv: ImportRuntime['issuesToCsv'] = runtime.issuesToCsv;
export const validateCellText: ImportRuntime['validateCellText'] = runtime.validateCellText;
export const normalizeJsonRows: ImportRuntime['normalizeJsonRows'] = runtime.normalizeJsonRows;
export const jsonCellText: ImportRuntime['jsonCellText'] = runtime.jsonCellText;
export const filterRetryRows: ImportRuntime['filterRetryRows'] = runtime.filterRetryRows;
export const createStatementSplitter: ImportRuntime['createStatementSplitter'] = runtime.createStatementSplitter;
export const classifyScriptStatement: ImportRuntime['classifyScriptStatement'] = runtime.classifyScriptStatement;

// ---------- 类型（worker 与渲染层共用形状） ----------

/**
 * 文本编码口径（P1-10）。
 *
 * 🔴 用 `'utf8'` 而**不是** `'utf-8'` —— SQL 脚本入口早就是这个字面量，
 *    两个「导入」入口各写一套只会让 IPC 侧多一层映射、多一处漏判。
 */
export type ImportEncoding = 'utf8' | 'gbk';

export interface MappingSuggestion {
  /** 文件列索引 → 表列名（null = 该文件列不导入） */
  mapping: (string | null)[];
  /** 表里没被任何文件列覆盖的列 */
  unmatchedTableColumns: string[];
  /** 猜测依据（预览 UI 可展示） */
  notes: string[];
}

export interface ImportRowIssue {
  /** 文件中的行号（1-based，含表头行） */
  fileRow: number;
  column: string;
  raw: string;
  reason: string;
}

export interface BatchPlan {
  /** 批量 INSERT 语句（多值 VALUES，每批 ≤ batchSize 行） */
  statements: { sql: string; params: unknown[]; rowCount: number }[];
  /** 校验失败的行（这些行不进 INSERT） */
  invalidRows: ImportRowIssue[];
  /** 文件总数据行数（重跑模式下仍是全量文件行数，便于进度对照） */
  totalRows: number;
  /** 实际会插入的行数 */
  insertableRows: number;
}

/** E3：normalizeJsonRows 的返回 —— 行对象集合 + 稳定排序后的键序（列顺序） */
export interface JsonRowsResult {
  rows: Record<string, unknown>[];
  keys: string[];
}

// ---------- 运行 SQL 脚本（流式语句分割） ----------

/** 流式 SQL 语句分割器（createStatementSplitter 的产物） */
export interface ScriptStatementSplitter {
  /** 喂入一块文本（大文件分块读，跨块语句自动拼接） */
  push(text: string): void;
  /** 文件读完后调用：产出残余的最后一条语句 */
  flush(): void;
  /** 当前分隔符（DELIMITER 指令可改写） */
  readonly delimiter: string;
  /** 当前行号（1 基；错误定位用） */
  readonly line: number;
}

/** 脚本语句分类（扫描摘要用）。'drop-db' 单独一类 —— UI 要走第三层确认 */
export type ScriptStatementClass = 'ddl' | 'dml' | 'session' | 'drop-db' | 'other';
