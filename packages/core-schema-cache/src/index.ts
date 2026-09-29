/**
 * Schema 缓存 —— 服务「树首屏 ≤500ms」（PRD §6.1.5 / R11）
 *
 * 依据：docs/engineering/TECH-REVIEW-v1.0.md §4.5
 *  - 连接成功后异步拉取：库 → 表/视图/存储过程 → 字段
 *  - 落盘快照 userData/schema-cache/<connId>.json，带版本号与 TTL（7 天）
 *  - 下次打开【先渲染快照，再后台刷新】
 *  - 过期则标记「元数据可能过期」并提供刷新入口
 *  - 额外：columnName → tableName[] 倒排索引（Q2 按字段名搜表，成本 ~0.5d）
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_CACHE_VERSION = 1;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 树/元数据里的对象类别。
 *
 * trigger/event 是 C1 加入的：跟随 procedure/function 的既有表示方式 ——
 * 挂在 DatabaseMeta.tables 里用 kind 区分，而不是另立列表。
 * 这样树的分类渲染（core-tree-view 的 OBJECT_KIND_ORDER）、快照、缓存查询
 * 全部天然复用同一套结构，旧快照（没有这两类）读入也不受影响。
 */
export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export interface ColumnMeta {
  name: string;
  /** 完整类型串，如 varchar(64)、decimal(12,2) */
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
  /** 是否主键列 */
  isPrimaryKey: boolean;
  /** 是否唯一键列 */
  isUnique: boolean;
  /** 是否自增 */
  autoIncrement: boolean;
  /** 字符集（可空） */
  charset: string | null;
  /** 排序规则（可空） */
  collation: string | null;
}

export interface TableMeta {
  name: string;
  kind: ObjectKind;
  comment: string | null;
  /** 估算行数（Information Schema 的 TABLE_ROWS，仅 InnoDB 近似值） */
  estimatedRows: number | null;
  engine: string | null;
  collation: string | null;
  columns: ColumnMeta[];
  /**
   * 触发器专有（kind === 'trigger'）：作用的目标表。
   * 来自 information_schema.TRIGGERS.EVENT_OBJECT_TABLE。
   * 可选字段 —— 旧快照文件没有这些键，读入不能崩（快照兼容红线）。
   */
  triggerTable?: string | null;
  /** 触发器专有：ACTION_TIMING（BEFORE / AFTER） */
  triggerTiming?: string | null;
  /** 触发器专有：EVENT_MANIPULATION（INSERT / UPDATE / DELETE） */
  triggerEvent?: string | null;
}

export interface DatabaseMeta {
  name: string;
  charset: string | null;
  collation: string | null;
  tables: TableMeta[];
}

export interface SchemaSnapshot {
  version: number;
  connectionId: string;
  /** 快照生成时间（epoch ms） */
  capturedAt: number;
  databases: DatabaseMeta[];
  /** 字段名 → 表名列表（Q2 倒排索引），小写键 */
  columnIndex: Record<string, string[]>;
}

/** 缓存状态：决定 UI 是否提示「可能过期」 */
export interface CacheState {
  snapshot: SchemaSnapshot | null;
  /** 是否过期（超过 TTL） */
  stale: boolean;
  /** 快照年龄（ms），无快照时为 null */
  ageMs: number | null;
  /** 版本是否兼容（不兼容则不可用，需整份重建） */
  compatible: boolean;
}

export class SchemaCache {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'schema-cache');
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(connectionId: string): string {
    // 连接 ID 可能含路径分隔符，做一次安全化，防止越权写入
    const safe = connectionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  // ---------- 写 ----------

  save(connectionId: string, databases: DatabaseMeta[], capturedAt = Date.now()): SchemaSnapshot {
    const snapshot: SchemaSnapshot = {
      version: SCHEMA_CACHE_VERSION,
      connectionId,
      capturedAt,
      databases,
      columnIndex: buildColumnIndex(databases),
    };
    writeFileSync(
      this.pathFor(connectionId),
      JSON.stringify(snapshot),
      'utf8',
    );
    return snapshot;
  }

  // ---------- 读 ----------

  load(connectionId: string, ttlMs = DEFAULT_TTL_MS): CacheState {
    const p = this.pathFor(connectionId);
    if (!existsSync(p)) {
      return { snapshot: null, stale: true, ageMs: null, compatible: false };
    }

    let raw: SchemaSnapshot;
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // 快照损坏：当作没有快照，但不要把异常抛给调用方
      return { snapshot: null, stale: true, ageMs: null, compatible: false };
    }

    const compatible = raw.version === SCHEMA_CACHE_VERSION;
    const ageMs = Date.now() - raw.capturedAt;
    const stale = ageMs > ttlMs;

    return {
      snapshot: compatible ? raw : null,
      stale,
      ageMs,
      compatible,
    };
  }

  /** 快速判断：有没有可立即渲染的快照（树首屏用） */
  hasUsable(connectionId: string, ttlMs = DEFAULT_TTL_MS): boolean {
    const s = this.load(connectionId, ttlMs);
    return s.snapshot !== null;
  }

  remove(connectionId: string): void {
    const p = this.pathFor(connectionId);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  clear(): void {
    // 只删本目录的 .json，不做递归删除
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.json')) rmSync(join(this.dir, f), { force: true });
    }
  }

  // ---------- 查询（纯内存，基于已加载快照） ----------

  /** 列出所有库名 */
  listDatabases(snap: SchemaSnapshot): string[] {
    return snap.databases.map((d) => d.name);
  }

  /** 列出某库下的表/视图 */
  listTables(snap: SchemaSnapshot, database: string, kind?: ObjectKind): TableMeta[] {
    const db = snap.databases.find((d) => d.name === database);
    if (!db) return [];
    return kind ? db.tables.filter((t) => t.kind === kind) : db.tables;
  }

  /** 取某张表的元数据 */
  getTable(snap: SchemaSnapshot, database: string, table: string): TableMeta | null {
    const db = snap.databases.find((d) => d.name === database);
    if (!db) return null;
    return db.tables.find((t) => t.name === table) ?? null;
  }

  /** Q2：按字段名反查包含该字段的表（返回 "db.table" 形式） */
  findTablesByColumn(snap: SchemaSnapshot, columnName: string): string[] {
    return snap.columnIndex[columnName.toLowerCase()] ?? [];
  }

  // ---------- 行定位策略（B5 / R4） ----------

  /** 判断表的行定位策略 —— 决定网格能否编辑 */
  locateStrategy(table: TableMeta): 'pk' | 'unique' | 'none' {
    const pkCols = table.columns.filter((c) => c.isPrimaryKey);
    if (pkCols.length > 0) return 'pk';

    // 非空唯一键：可定位，但可空唯一键存在歧义风险
    const uniqueCols = table.columns.filter((c) => c.isUnique && !c.nullable);
    if (uniqueCols.length > 0) return 'unique';

    const anyUnique = table.columns.filter((c) => c.isUnique);
    if (anyUnique.length > 0) return 'unique'; // 可空唯一键，UI 需提示歧义风险

    return 'none'; // 无主键/无唯一键 → 网格只读
  }

  /** 网格是否可编辑（无唯一键则只读，这是红线） */
  isEditable(table: TableMeta): boolean {
    return this.locateStrategy(table) !== 'none';
  }

  /** 取用于 WHERE 定位的列 */
  locateColumns(table: TableMeta): ColumnMeta[] {
    const pk = table.columns.filter((c) => c.isPrimaryKey);
    if (pk.length > 0) return pk;
    return table.columns.filter((c) => c.isUnique);
  }
}

// ---------- 纯函数 ----------

/** 构建 字段名 → ["db.table", ...] 倒排索引（Q2） */
export function buildColumnIndex(databases: DatabaseMeta[]): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const db of databases) {
    for (const t of db.tables) {
      for (const c of t.columns) {
        const key = c.name.toLowerCase();
        (idx[key] ??= []).push(`${db.name}.${t.name}`);
      }
    }
  }
  // 去重（同一库表内重复列名理论上不会出现，但防御性处理）
  for (const k of Object.keys(idx)) {
    idx[k] = [...new Set(idx[k])];
  }
  return idx;
}
