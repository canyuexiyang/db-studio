/**
 * 表设计器核心（PRD §6.5）—— DDL 生成的单一来源
 *
 * 职责（纯逻辑，无 IO）：
 *  - 设计模型（DesignColumn / DesignIndex / DesignForeignKey）
 *  - 模型校验（重名 / 空类型 / 主键合法性 / 外键引用存在）
 *  - CREATE TABLE 生成（新表）
 *  - ALTER TABLE 差异生成（改表：对照原结构算 diff → ADD/DROP/MODIFY 列、索引、外键）
 *
 * 硬约束：
 *  - 标识符一律 quoteIdentifier（反引号转义）
 *  - 默认值按类型判定是否加引号（数值不加、字符串加、函数/表达式不加）
 *  - 生产环境确认（输入表名）由 UI 层做，这里只给 DDL 文本
 *
 * 编辑已有表（ALTER）的语义边界（v1）：
 *  - 改列 = MODIFY（不 rename；RENAME COLUMN 需要额外确认，v1 不做）
 *  - 删列 = DROP（危险操作，UI 要二次确认 —— 与 P0-3 危险确认联动）
 */

import { quoteIdentifier, quoteQualified } from '@dbstudio/core-sql-ident';

// ---------- 模型 ----------

/** 设计器里的一列（编辑态，含 UI 需要的辅助字段） */
export interface DesignColumn {
  /** 设计器行 id（临时生成，区分同名行） */
  key: string;
  name: string;
  /** 基础类型，如 int / varchar / decimal */
  type: string;
  /** 长度（varchar(N) 的 N） */
  length: string;
  /** 小数位（decimal(M,D) 的 D） */
  scale: string;
  unsigned: boolean;
  nullable: boolean;
  /** 默认值原文；null = 无默认；'' = 空串默认（二者语义不同，不能合并） */
  defaultValue: string | null;
  autoIncrement: boolean;
  isPrimaryKey: boolean;
  comment: string;
  charset: string;
  collation: string;
}

export type IndexKind = 'normal' | 'unique' | 'fulltext' | 'spatial';

export interface DesignIndex {
  key: string;
  name: string;
  kind: IndexKind;
  /** 复合索引的列（有序）；每项 { column, prefixLength }，prefixLength 空串 = 无前缀 */
  columns: { column: string; prefixLength: string }[];
  comment: string;
}

export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const;
export type FkAction = (typeof FK_ACTIONS)[number];

export interface DesignForeignKey {
  key: string;
  name: string;
  /** 本表列（复合外键按序） */
  columns: string[];
  refDatabase: string;
  refTable: string;
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
}

/** 一次设计会话的全部状态 */
export interface TableDesign {
  /** 目标表名（建表时可改；改表时锁定） */
  tableName: string;
  /** 表注释 */
  comment: string;
  /** 引擎（v1 固定下拉：InnoDB / MyISAM / MEMORY） */
  engine: string;
  /** 建表时 utf8mb4 默认；改表时沿用原表 */
  collation: string;
  columns: DesignColumn[];
  indexes: DesignIndex[];
  foreignKeys: DesignForeignKey[];
}

// ---------- MySQL 类型分组（下拉数据） ----------

export const TYPE_GROUPS: { group: string; types: { name: string; hasLength: boolean; hasScale: boolean }[] }[] = [
  {
    group: '数值',
    types: [
      { name: 'tinyint', hasLength: false, hasScale: false },
      { name: 'smallint', hasLength: false, hasScale: false },
      { name: 'mediumint', hasLength: false, hasScale: false },
      { name: 'int', hasLength: false, hasScale: false },
      { name: 'bigint', hasLength: false, hasScale: false },
      { name: 'decimal', hasLength: true, hasScale: true },
      { name: 'float', hasLength: true, hasScale: true },
      { name: 'double', hasLength: false, hasScale: false },
      { name: 'bit', hasLength: true, hasScale: false },
    ],
  },
  {
    group: '字符串',
    types: [
      { name: 'char', hasLength: true, hasScale: false },
      { name: 'varchar', hasLength: true, hasScale: false },
      { name: 'tinytext', hasLength: false, hasScale: false },
      { name: 'text', hasLength: false, hasScale: false },
      { name: 'mediumtext', hasLength: false, hasScale: false },
      { name: 'longtext', hasLength: false, hasScale: false },
      { name: 'binary', hasLength: true, hasScale: false },
      { name: 'varbinary', hasLength: true, hasScale: false },
      { name: 'enum', hasLength: true, hasScale: false },
      { name: 'set', hasLength: true, hasScale: false },
    ],
  },
  {
    group: '日期时间',
    types: [
      { name: 'date', hasLength: false, hasScale: false },
      { name: 'datetime', hasLength: true, hasScale: false },
      { name: 'timestamp', hasLength: true, hasScale: false },
      { name: 'time', hasLength: true, hasScale: false },
      { name: 'year', hasLength: false, hasScale: false },
    ],
  },
  {
    group: '二进制',
    types: [
      { name: 'tinyblob', hasLength: false, hasScale: false },
      { name: 'blob', hasLength: false, hasScale: false },
      { name: 'mediumblob', hasLength: false, hasScale: false },
      { name: 'longblob', hasLength: false, hasScale: false },
    ],
  },
  {
    group: 'JSON / 空间',
    types: [
      { name: 'json', hasLength: false, hasScale: false },
      { name: 'geometry', hasLength: false, hasScale: false },
      { name: 'point', hasLength: false, hasScale: false },
      { name: 'linestring', hasLength: false, hasScale: false },
      { name: 'polygon', hasLength: false, hasScale: false },
    ],
  },
];

/** 该类型是否支持长度参数（决定 UI 是否显示长度框） */
export function typeSupportsLength(type: string): boolean {
  return TYPE_GROUPS.flatMap((g) => g.types).find((t) => t.name === type)?.hasLength ?? false;
}

/** 该类型是否支持小数位 */
export function typeSupportsScale(type: string): boolean {
  return TYPE_GROUPS.flatMap((g) => g.types).find((t) => t.name === type)?.hasScale ?? false;
}

// ---------- 工厂 ----------

let keySeq = 0;
function nextKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${keySeq++}`;
}

export function emptyColumn(): DesignColumn {
  return {
    key: nextKey('col'),
    name: '',
    type: 'varchar',
    // 长度默认空：不是所有类型都有“合理默认”（timestamp 的长度是精度 0-6），
    // UI 在类型切换时按 typeDefaultLength() 填充
    length: '',
    scale: '',
    unsigned: false,
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    isPrimaryKey: false,
    comment: '',
    charset: '',
    collation: '',
  };
}

/** 类型切换时 UI 填的默认长度（空串 = 不带长度） */
export function typeDefaultLength(type: string): string {
  switch (type) {
    case 'varchar':
    case 'varbinary':
      return '255';
    case 'char':
    case 'binary':
      return '16';
    case 'decimal':
      return '10';
    case 'bit':
      return '1';
    default:
      return '';
  }
}

export function emptyIndex(): DesignIndex {
  return { key: nextKey('idx'), name: '', kind: 'normal', columns: [], comment: '' };
}

export function emptyForeignKey(): DesignForeignKey {
  return {
    key: nextKey('fk'),
    name: '',
    columns: [],
    refDatabase: '',
    refTable: '',
    refColumns: [],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  };
}

/** 空设计（新建表）：预置一个 id 主键列 —— 90% 的表都这么开始 */
export function newTableDesign(tableName = ''): TableDesign {
  const id = emptyColumn();
  id.name = 'id';
  id.type = 'bigint';
  id.unsigned = true;
  id.nullable = false;
  id.autoIncrement = true;
  id.isPrimaryKey = true;
  return {
    tableName,
    comment: '',
    engine: 'InnoDB',
    collation: 'utf8mb4_general_ci',
    columns: [id],
    indexes: [],
    foreignKeys: [],
  };
}

// ---------- 校验 ----------

export interface DesignIssue {
  level: 'error' | 'warning';
  field: string;
  message: string;
}

export function validateDesign(d: TableDesign): DesignIssue[] {
  const issues: DesignIssue[] = [];

  if (!d.tableName.trim()) {
    issues.push({ level: 'error', field: 'tableName', message: '表名不能为空' });
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(d.tableName.trim())) {
    issues.push({ level: 'error', field: 'tableName', message: '表名只能含字母、数字、下划线，且以字母或下划线开头' });
  }

  if (d.columns.length === 0) {
    issues.push({ level: 'error', field: 'columns', message: '至少需要一列' });
  }

  const seen = new Set<string>();
  const pkCols: string[] = [];
  for (const c of d.columns) {
    if (!c.name.trim()) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: '字段名不能为空' });
    } else if (seen.has(c.name.trim().toLowerCase())) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: `字段名「${c.name}」重复` });
    } else {
      seen.add(c.name.trim().toLowerCase());
    }

    if (!c.type) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: '字段类型不能为空' });
    }

    if (c.length && !/^\d+$/.test(c.length)) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: `字段 ${c.name} 的长度必须是数字` });
    }
    if (c.scale && !/^\d+$/.test(c.scale)) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: `字段 ${c.name} 的小数位必须是数字` });
    }
    if (c.length && c.scale && Number(c.scale) > Number(c.length)) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: `字段 ${c.name} 的小数位不能超过长度` });
    }

    if (c.autoIncrement && !c.isPrimaryKey && !d.columns.some((x) => x.isPrimaryKey)) {
      // MySQL 允许非主键自增（需有索引），但设计器简化：提示即可
      issues.push({ level: 'warning', field: `col:${c.key}`, message: `自增字段 ${c.name} 建议设为主键` });
    }
    if (c.autoIncrement && !/^(tinyint|smallint|mediumint|int|bigint)$/.test(c.type)) {
      issues.push({ level: 'error', field: `col:${c.key}`, message: `字段 ${c.name}：只有整数类型可以自增` });
    }

    if (c.isPrimaryKey) {
      pkCols.push(c.name.trim());
      if (c.nullable) {
        issues.push({ level: 'error', field: `col:${c.key}`, message: `主键字段 ${c.name} 不能为 NULL` });
      }
    }
  }

  if (d.columns.filter((c) => c.autoIncrement).length > 1) {
    issues.push({ level: 'error', field: 'columns', message: '一张表只能有一个自增字段' });
  }

  // 索引：名字可空（自动生成），但列必须存在
  for (const idx of d.indexes) {
    if (idx.columns.length === 0) {
      issues.push({ level: 'error', field: `idx:${idx.key}`, message: '索引至少要选一个字段' });
    }
    for (const ic of idx.columns) {
      if (!seen.has(ic.column.trim().toLowerCase())) {
        issues.push({ level: 'error', field: `idx:${idx.key}`, message: `索引引用了不存在的字段「${ic.column}」` });
      }
      if (ic.prefixLength && !/^\d+$/.test(ic.prefixLength)) {
        issues.push({ level: 'error', field: `idx:${idx.key}`, message: `索引前缀长度必须是数字` });
      }
    }
  }

  // 外键：列/引用列数量要一致，且引用了存在的字段
  for (const fk of d.foreignKeys) {
    if (fk.columns.length === 0) {
      issues.push({ level: 'error', field: `fk:${fk.key}`, message: '外键至少要选一个字段' });
    }
    if (!fk.refTable.trim()) {
      issues.push({ level: 'error', field: `fk:${fk.key}`, message: '外键引用表不能为空' });
    }
    if (fk.columns.length !== fk.refColumns.length) {
      issues.push({ level: 'error', field: `fk:${fk.key}`, message: '外键字段与引用字段数量必须一致' });
    }
    for (const c of fk.columns) {
      if (!seen.has(c.trim().toLowerCase())) {
        issues.push({ level: 'error', field: `fk:${fk.key}`, message: `外键引用了不存在的字段「${c}」` });
      }
    }
    if ((fk.onDelete === 'SET NULL' || fk.onUpdate === 'SET NULL')) {
      const nullableOk = fk.columns.every((c) => d.columns.find((x) => x.name.trim().toLowerCase() === c.trim().toLowerCase())?.nullable);
      if (!nullableOk) {
        issues.push({ level: 'warning', field: `fk:${fk.key}`, message: 'SET NULL 行为要求外键字段允许 NULL' });
      }
    }
  }

  return issues;
}

// ---------- DDL 生成：列 ----------

/** 该类型的默认值是否需要引号（数值不加，函数/表达式不加，其余加） */
const NUMERIC_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)$/;
const VALUE_FUNCS = /^(NOW\(\)|CURRENT_TIMESTAMP(?:\(\))?|NULL|UUID\(\)|RAND\(\))$/i;

function columnType(c: DesignColumn): string {
  let t = c.type;
  const hasLen = typeSupportsLength(c.type);
  if (hasLen && c.length) {
    t += c.scale ? `(${c.length},${c.scale})` : `(${c.length})`;
  }
  if (c.unsigned) t += ' UNSIGNED';
  return t;
}

function columnDefault(c: DesignColumn): string {
  if (c.defaultValue === null) return '';
  const v = c.defaultValue.trim();
  if (v === '') return ' DEFAULT \'\'';
  if (NUMERIC_TYPES.test(c.type)) {
    return ` DEFAULT ${v}`;
  }
  if (VALUE_FUNCS.test(v)) {
    return ` DEFAULT ${v}`;
  }
  return ` DEFAULT '${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function columnCharset(c: DesignColumn): string {
  const parts: string[] = [];
  if (c.charset) parts.push(`CHARACTER SET ${c.charset}`);
  if (c.collation) parts.push(`COLLATE ${c.collation}`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

function columnDef(c: DesignColumn): string {
  // 顺序按 MySQL 语法：类型 → 字符集/排序规则 → NULL → 默认 → 自增 → 注释
  // 🔴 CHARACTER SET 必须在 NULL/NOT NULL 之前（真库实测：反了是 ER_PARSE_ERROR）
  let s = `  ${quoteIdentifier(c.name)} ${columnType(c)}`;
  s += columnCharset(c);
  s += c.nullable ? ' NULL' : ' NOT NULL';
  s += columnDefault(c);
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  if (c.comment) s += ` COMMENT '${c.comment.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return s;
}

// ---------- DDL 生成：索引 / 外键 ----------

function indexDef(idx: DesignIndex): string | null {
  if (idx.columns.length === 0) return null;
  const parts = idx.columns.map((ic) => {
    const name = quoteIdentifier(ic.column);
    return ic.prefixLength ? `${name}(${ic.prefixLength})` : name;
  });
  const name = idx.name.trim() || autoIndexName(idx);
  const kind = idx.kind === 'unique' ? 'UNIQUE ' : idx.kind === 'fulltext' ? 'FULLTEXT ' : idx.kind === 'spatial' ? 'SPATIAL ' : '';
  return `  ${kind}INDEX ${quoteIdentifier(name)} (${parts.join(', ')})${idx.comment ? ` COMMENT '${idx.comment.replace(/'/g, "''")}'` : ''}`;
}

/** 自动生成索引名（未命名时）：idx_<col1>_<col2>（复合取前两个） */
function autoIndexName(idx: DesignIndex): string {
  return 'idx_' + idx.columns.slice(0, 2).map((c) => c.column).join('_');
}

function fkDef(fk: DesignForeignKey, database: string): string | null {
  if (!fk.refTable.trim() || fk.columns.length === 0 || fk.columns.length !== fk.refColumns.length) return null;
  const refDb = fk.refDatabase.trim() || database;
  const name = fk.name.trim() || `fk_${fk.columns[0]}`;
  const cols = fk.columns.map(quoteIdentifier).join(', ');
  const refCols = fk.refColumns.map(quoteIdentifier).join(', ');
  const ref = quoteQualified([refDb, fk.refTable.trim()]);
  return `  CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
}

// ---------- CREATE TABLE ----------

export interface CreateDdlResult {
  sql: string | null;
  issues: DesignIssue[];
}

/**
 * 生成 CREATE TABLE（新表保存）。
 * 返回 null + issues 表示有校验错误，不能执行。
 */
export function buildCreateTable(database: string, d: TableDesign): CreateDdlResult {
  const issues = validateDesign(d).filter((i) => i.level === 'error');
  if (issues.length > 0) return { sql: null, issues };

  const parts: string[] = [];
  const pk = d.columns.filter((c) => c.isPrimaryKey);
  for (const c of d.columns) parts.push(columnDef(c));
  if (pk.length > 0) {
    parts.push(`  PRIMARY KEY (${pk.map((c) => quoteIdentifier(c.name)).join(', ')})`);
  }
  for (const idx of d.indexes) {
    const def = indexDef(idx);
    if (def) parts.push(def);
  }
  for (const fk of d.foreignKeys) {
    const def = fkDef(fk, database);
    if (def) parts.push(def);
  }

  let sql = `CREATE TABLE ${quoteQualified([database, d.tableName.trim()])} (\n${parts.join(',\n')}\n)`;
  sql += ` ENGINE=${d.engine || 'InnoDB'}`;
  if (d.collation) sql += ` DEFAULT CHARSET=utf8mb4 COLLATE=${d.collation}`;
  if (d.comment) sql += ` COMMENT='${d.comment.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  sql += ';';

  return { sql, issues: [] };
}

// ---------- ALTER（差异） ----------

export interface AlterDiff {
  statements: string[];
  /** 变更摘要（UI 展示「将执行 N 条变更」） */
  summary: string[];
}

/**
 * 对照原表结构，生成 ALTER TABLE 语句集。
 * 原始结构来自 TableMeta（introspect），设计态来自 TableDesign。
 *
 * v1 语义：
 *  - 新列 → ADD COLUMN
 *  - 删列 → DROP COLUMN（UI 必须二次确认）
 *  - 改列（类型/可空/默认/自增/注释/字符集）→ MODIFY COLUMN
 *  - 主键变化 → 重建 PRIMARY KEY（DROP PRIMARY KEY + ADD PRIMARY KEY）
 *  - 索引/外键：v1 支持「新增」；删除走 DROP INDEX / DROP FOREIGN KEY（diff 出来的）
 */
export function buildAlterStatements(
  database: string,
  tableName: string,
  original: { columns: { name: string; dataType: string; nullable: boolean; defaultValue: string | null; comment: string | null; isPrimaryKey: boolean; autoIncrement: boolean; charset: string | null; collation: string | null }[] },
  design: TableDesign,
): AlterDiff {
  const stmts: string[] = [];
  const summary: string[] = [];
  const qualified = quoteQualified([database, tableName]);

  const origByName = new Map(original.columns.map((c) => [c.name.toLowerCase(), c]));

  // ADD COLUMN
  for (const c of design.columns) {
    if (!c.name.trim()) continue;
    if (!origByName.has(c.name.trim().toLowerCase())) {
      stmts.push(`ALTER TABLE ${qualified} ADD COLUMN ${columnDef(c).trim()}`);
      summary.push(`新增字段 ${c.name}`);
    }
  }

  // DROP COLUMN（危险：UI 必须确认；这里只生成语句）
  const designNames = new Set(design.columns.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
  for (const o of original.columns) {
    if (!designNames.has(o.name.toLowerCase())) {
      stmts.push(`ALTER TABLE ${qualified} DROP COLUMN ${quoteIdentifier(o.name)}`);
      summary.push(`删除字段 ${o.name}`);
    }
  }

  // MODIFY COLUMN（同名且定义变化）
  for (const c of design.columns) {
    const name = c.name.trim().toLowerCase();
    if (!name) continue;
    const o = origByName.get(name);
    if (!o) continue; // 新列已走 ADD

    const newType = columnType(c);
    const typeChanged = normalizeType(o.dataType) !== normalizeType(newType);
    const nullChanged = o.nullable !== c.nullable;
    const defaultChanged = (o.defaultValue ?? null) !== (c.defaultValue === '' && !NUMERIC_TYPES.test(c.type) ? c.defaultValue : c.defaultValue ?? null) &&
      String(o.defaultValue ?? '') !== String(c.defaultValue ?? '');
    const commentChanged = (o.comment ?? '') !== c.comment;
    const autoIncChanged = o.autoIncrement !== c.autoIncrement;
    const charsetChanged = (o.charset ?? '') !== c.charset || (o.collation ?? '') !== c.collation;

    if (typeChanged || nullChanged || defaultChanged || commentChanged || autoIncChanged || charsetChanged) {
      stmts.push(`ALTER TABLE ${qualified} MODIFY ${columnDef(c).trim()}`);
      summary.push(`修改字段 ${c.name}${typeChanged ? '（类型）' : ''}${nullChanged ? '（可空）' : ''}${autoIncChanged ? '（自增）' : ''}`);
    }
  }

  // 主键变化：DROP + ADD
  const origPk = original.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const newPk = design.columns.filter((c) => c.isPrimaryKey).map((c) => c.name.trim());
  const pkChanged =
    origPk.length !== newPk.length ||
    origPk.some((n, i) => n.toLowerCase() !== (newPk[i] ?? '').toLowerCase());
  if (pkChanged) {
    if (origPk.length > 0) {
      stmts.push(`ALTER TABLE ${qualified} DROP PRIMARY KEY`);
      summary.push('删除原主键');
    }
    if (newPk.length > 0 && newPk.every((n) => n)) {
      stmts.push(`ALTER TABLE ${qualified} ADD PRIMARY KEY (${newPk.map(quoteIdentifier).join(', ')})`);
      summary.push(`设置主键：${newPk.join(', ')}`);
    }
  }

  // 索引：v1 只生成「新增索引」（原有索引的删除需要索引元数据支持，v1 设计器
  // 新建索引保存后刷新 schema；删除索引走 SQL 编辑器）
  for (const idx of design.indexes) {
    if (idx.columns.length === 0) continue;
    const name = idx.name.trim() || autoIndexName(idx);
    const kind = idx.kind === 'unique' ? 'UNIQUE ' : idx.kind === 'fulltext' ? 'FULLTEXT ' : idx.kind === 'spatial' ? 'SPATIAL ' : '';
    const cols = idx.columns
      .map((ic) => (ic.prefixLength ? `${quoteIdentifier(ic.column)}(${ic.prefixLength})` : quoteIdentifier(ic.column)))
      .join(', ');
    stmts.push(`ALTER TABLE ${qualified} ADD ${kind}INDEX ${quoteIdentifier(name)} (${cols})`);
    summary.push(`新增索引 ${name}`);
  }

  // 外键：同上，v1 只生成新增
  for (const fk of design.foreignKeys) {
    const def = fkDef(fk, database);
    if (def) {
      stmts.push(`ALTER TABLE ${qualified} ADD ${def.trim().replace(/^  /, '')}`);
      summary.push(`新增外键 ${fk.name.trim() || fk.columns[0]}`);
    }
  }

  return { statements: stmts, summary };
}

// ---------- ALTER 执行（P1-12：失败即停 + 结构化失败报告） ----------

/**
 * 一次 ALTER 批量执行里"卡在哪一条"的结构化描述。
 *
 * 为什么需要它：MySQL 的 DDL **隐式提交**，一批 ALTER 跑到第 k 条失败时，
 * 前 k-1 条已经落库且**无法回滚**。此时若还拿原来那份 diff 再点一次保存，
 * 就会把已成功的语句**重跑一遍**（ADD COLUMN 重复 → 直接报 1060）。
 * 所以要有一个能回答「到第几条为止」的东西，让 UI 能做两件事：
 *   ① 把失败报告说清楚（已执行 N 条 / 失败于第 M 条 / 原文 / 错误）；
 *   ② 重新拉取表结构、**按新的基线重建 diff** —— 已执行的语句自然消失。
 */
export interface AlterRunFailure {
  /** 已成功执行的条数（也等于失败语句的 0 基下标） */
  executed: number;
  /** 失败语句的 1 基序号（给用户看的「第 N 条」） */
  failedAt: number;
  /** 本批语句总数 */
  total: number;
  /** 失败语句原文 */
  sql: string;
  /** 数据库返回的错误原文 */
  message: string;
}

export type AlterRunOutcome =
  | { ok: true; executed: number; total: number }
  | { ok: false; failure: AlterRunFailure };

/**
 * 逐条执行 ALTER，**遇到第一条失败立刻停下**。
 *
 * 「停下」是本函数的全部意义：继续往下跑只会在结构已半改的表上叠加更多错误，
 * 而且用户看到的错误会是后一条的（误导定位）。返回的 `executed` 是重建 diff 的
 * 唯一依据 —— 调用方据此重拉结构，让剩下的 `total - executed` 条继续待执行。
 *
 * 把 `run` 抽成参数是为了可测：真实调用是 backend.queryRun，单测里给个假 runner
 * 就能声明"第 2 条抛错时第 3 条不许被调用"。
 */
export async function runAlterStatements(
  statements: string[],
  run: (sql: string, index: number) => Promise<void>,
): Promise<AlterRunOutcome> {
  for (let i = 0; i < statements.length; i++) {
    try {
      await run(statements[i], i);
    } catch (e) {
      return {
        ok: false,
        failure: {
          executed: i,
          failedAt: i + 1,
          total: statements.length,
          sql: statements[i],
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }
  return { ok: true, executed: statements.length, total: statements.length };
}

/**
 * 失败报告的一行文案（toast 用；原文与错误详情由界面上的报告块承载）。
 *
 * 措辞刻意区分「已执行」与「失败于」：前者告诉用户库里**已经改了**什么，
 * 后者告诉他卡在哪 —— 只报错误消息的做法（旧实现）会让人以为整批都没生效。
 */
export function describeAlterFailure(f: AlterRunFailure): string {
  return `已执行 ${f.executed} 条，第 ${f.failedAt} 条失败（共 ${f.total} 条）：${f.message}`;
}

/** 失败后还剩多少条待执行（重建 diff 后应等于这个数） */
export function remainingAlterCount(f: AlterRunFailure): number {
  return Math.max(0, f.total - f.executed);
}

/** 类型归一化比较：varchar(255) vs varchar —— 长度不同的完整形态才算变化 */
function normalizeType(dataType: string): string {
  return (dataType || '').toLowerCase().replace(/\s+/g, ' ').trim();
}/** 从 TableMeta（introspect 形态）构造设计态（编辑已有表的入口） */
export function designFromTableMeta(tableName: string, meta: {
  comment: string | null;
  engine: string | null;
  collation: string | null;
  columns: {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    comment: string | null;
    isPrimaryKey: boolean;
    isUnique: boolean;
    autoIncrement: boolean;
    charset: string | null;
    collation: string | null;
  }[];
}): TableDesign {
  const columns: DesignColumn[] = meta.columns.map((c) => {
    const parsed = parseDataType(c.dataType);
    return {
      key: nextKey('col'),
      name: c.name,
      type: parsed.base,
      length: parsed.length,
      scale: parsed.scale,
      unsigned: /unsigned/i.test(c.dataType),
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      autoIncrement: c.autoIncrement,
      isPrimaryKey: c.isPrimaryKey,
      comment: c.comment ?? '',
      charset: c.charset ?? '',
      collation: c.collation ?? '',
    };
  });
  return {
    tableName,
    comment: meta.comment ?? '',
    engine: meta.engine ?? 'InnoDB',
    collation: meta.collation ?? 'utf8mb4_general_ci',
    columns,
    indexes: [],
    foreignKeys: [],
  };
}

/** varchar(255) → { base: 'varchar', length: '255', scale: '' }；bigint unsigned → base=bigint */
export function parseDataType(dataType: string): { base: string; length: string; scale: string } {
  const m = /^([a-zA-Z]+)(?:\((\d+)(?:,(\d+))?\))?/.exec((dataType || '').trim());
  if (!m) return { base: (dataType || '').trim().toLowerCase(), length: '', scale: '' };
  return { base: m[1].toLowerCase(), length: m[2] ?? '', scale: m[3] ?? '' };
}
