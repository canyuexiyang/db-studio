/**
 * 对象生命周期 DDL 的**唯一构造处**（0.7.3：库/表/视图等对象的创建、重命名、复制、维护）。
 *
 * 为什么抽成零 React 依赖的纯模块：
 *  1. 拼 SQL 是安全面 —— 标识符必须走 `core-sql-ident`（红线 5），校验必须 fail-closed；
 *     这类规则只有被单测逐条钉住才不会在某次改动中悄悄放宽。
 *  2. 「文字正确」不等于「执行得通」：模板里每一句都必须是**单条可执行语句**
 *     （编辑器的 splitStatements 按 `;` 切分，`BEGIN … END` 块会被切碎）——
 *     这条约束写在这里，而不是让每个调用点各自记得。
 *
 * 🔴 三条硬约束（对应 AGENTS 红线）：
 *  1. 标识符一律 `quoteIdentifier/quoteQualified`，**不许手拼反引号**；
 *  2. 用户输入的名字先过 `validateNewName`（空/超长/含分隔符/重名）—— 返回中文原因；
 *  3. charset / collation 是**裸值**（不是标识符），必须过字符白名单才允许拼进 SQL。
 */

import { quoteIdentifier, quoteQualified } from '@dbstudio/core-sql-ident';

/** MySQL 标识符上限（与 core-sql-ident 同值；这里只用于提前给中文提示） */
export const MAX_IDENT_LEN = 64;

/** 裸值白名单：字符集 / 排序规则只允许字母数字下划线 */
const BARE_TOKEN_RE = /^[A-Za-z0-9_]+$/;

// ---------- 名称校验 ----------

export interface NameRules {
  /** 中文名（「库名」「表名」「分组名」），进错误文案 */
  label?: string;
  /** 已存在的名字（重名检查，大小写不敏感 —— MySQL 在 macOS 上常见大小写不敏感） */
  existing?: readonly string[];
  /** 重名时的补充说明（「该库下」等） */
  conflictSuffix?: string;
  /**
   * 是否禁止 `.` `/` `:`。
   *
   * 🔴 这三个字符在本产品里有结构含义：`.` 是限定名分隔符、`/` 是分组路径分隔符、
   *    `:` 是树节点 key 分隔符。允许它们会让「`db`.`a.b`」这类名字在树上/导出身份里错位。
   *    数据库对象名默认禁止；分组名只允许 `/`（它本身就是路径分隔符）。
   */
  forbid?: readonly string[];
}

export interface NameCheck {
  ok: boolean;
  /** 归一后的名字（去首尾空白）；不合法时为空串 */
  value: string;
  /** 不合法原因（中文，可直接展示）；合法为 null */
  error: string | null;
}

const OBJECT_FORBIDDEN = ['.', ':', '/'] as const;

/**
 * 校验「要新建/重命名的对象名」。
 *
 * 只做**名字本身**的判定，不碰连接与权限 —— 那些由调用方按上下文补齐，
 * 但错误文案要能直接贴到输入框下面，所以一律返回中文原因。
 */
export function validateNewName(raw: string, rules: NameRules = {}): NameCheck {
  const label = rules.label ?? '名称';
  const value = (raw ?? '').trim();
  const existing = rules.existing ?? [];
  const forbid = rules.forbid ?? OBJECT_FORBIDDEN;

  const fail = (error: string): NameCheck => ({ ok: false, value: '', error });

  if (value.length === 0) return fail(`${label}不能为空`);
  if (value.length > MAX_IDENT_LEN) return fail(`${label}不能超过 ${MAX_IDENT_LEN} 个字符（MySQL 标识符上限）`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return fail(`${label}不能包含控制字符或换行`);
  for (const ch of forbid) {
    if (value.includes(ch)) {
      return fail(
        ch === '/'
          ? `${label}不能包含斜杠（分组路径用斜杠分隔）`
          : ch === ':'
            ? `${label}不能包含冒号（对象标识用冒号分段）`
            : `${label}不能包含英文句点（会与「库.表」限定名混淆）`,
      );
    }
  }
  const lower = value.toLowerCase();
  if (existing.some((n) => n.toLowerCase() === lower)) {
    return fail(`${rules.conflictSuffix ?? ''}已存在同名对象「${value}」`);
  }
  return { ok: true, value, error: null };
}

/** 裸值（charset / collation）白名单校验；不合法返回中文原因 */
export function validateBareToken(raw: string, label: string, { required = false } = {}): string | null {
  const v = (raw ?? '').trim();
  if (v.length === 0) return required ? `${label}不能为空` : null;
  if (!BARE_TOKEN_RE.test(v)) return `${label}只能包含字母、数字和下划线`;
  if (v.length > MAX_IDENT_LEN) return `${label}过长`;
  return null;
}

// ---------- 数据库 ----------

export interface CreateDatabaseInput {
  name: string;
  /** 空 = 用服务端默认（只在用户显式填了才拼进 SQL） */
  charset?: string | null;
  collation?: string | null;
}

/**
 * `CREATE DATABASE` 原文。
 *
 * 不带 `IF NOT EXISTS`：用户刚在对话框里确认过名字，服务端若说「已存在」应当**报错**，
 * 而不是静默成功 —— 静默会让用户以为新建了一个库。
 *
 * @throws Error 名字/字符集不合法（fail-closed，绝不把可疑文本拼进 SQL）
 */
export function buildCreateDatabaseSql(input: CreateDatabaseInput): string {
  const check = validateNewName(input.name, { label: '库名' });
  if (!check.ok) throw new Error(check.error ?? '库名不合法');

  const charset = (input.charset ?? '').trim();
  const collation = (input.collation ?? '').trim();
  const csErr = validateBareToken(charset, '字符集');
  if (csErr) throw new Error(csErr);
  const coErr = validateBareToken(collation, '排序规则');
  if (coErr) throw new Error(coErr);
  if (collation && !charset) throw new Error('指定排序规则时必须同时指定字符集');

  let sql = `CREATE DATABASE ${quoteIdentifier(check.value)}`;
  if (charset) sql += ` CHARACTER SET ${charset}`;
  if (collation) sql += ` COLLATE ${collation}`;
  return `${sql};`;
}

/** `DROP DATABASE` 原文（危险第三层由调用方用 requireText = 库名 保证） */
export function buildDropDatabaseSql(name: string): string {
  const check = validateNewName(name, { label: '库名' });
  if (!check.ok) throw new Error(check.error ?? '库名不合法');
  return `DROP DATABASE ${quoteIdentifier(check.value)};`;
}

// ---------- 表 ----------

/** `RENAME TABLE` 原文（同一库内改名；跨库改名不在本入口范围） */
export function buildRenameTableSql(database: string, from: string, to: string): string {
  const target = validateNewName(to, { label: '新表名' });
  if (!target.ok) throw new Error(target.error ?? '新表名不合法');
  return `RENAME TABLE ${quoteQualified([database, from])} TO ${quoteQualified([database, target.value])};`;
}

export interface CopyTableInput {
  /** 源库 */
  database: string;
  /** 源表 */
  table: string;
  /** 新表名 */
  newTable: string;
  /** 目标库（默认同库）；跨库复制用 `CREATE TABLE 目标库.新表 LIKE 源库.源表` */
  targetDatabase?: string | null;
  withData: boolean;
}

/**
 * 复制表：`CREATE TABLE … LIKE` +（可选）`INSERT … SELECT`。
 *
 * 🔴 返回**数组**而不是一条拼接串：`mutationApply` 的 ddl 入口只收单条语句，
 *    而第二条 INSERT 走的是另一套（写语句）白名单 —— 两条必须分别发。
 */
export function buildCopyTableSql(input: CopyTableInput): string[] {
  const target = validateNewName(input.newTable, { label: '新表名' });
  if (!target.ok) throw new Error(target.error ?? '新表名不合法');
  const targetDb = (input.targetDatabase ?? '').trim() || input.database;
  // 目标库名同样走标识符校验（它是从下拉里选的，但入口不因此放松）
  const dbCheck = validateNewName(targetDb, { label: '目标库名' });
  if (!dbCheck.ok) throw new Error(dbCheck.error ?? '目标库名不合法');

  const from = quoteQualified([input.database, input.table]);
  const to = quoteQualified([dbCheck.value, target.value]);
  const out = [`CREATE TABLE ${to} LIKE ${from};`];
  if (input.withData) out.push(`INSERT INTO ${to} SELECT * FROM ${from};`);
  return out;
}

/** 表维护三件套（服务端命令，不改行数据） */
export type MaintenanceAction = 'optimize' | 'analyze' | 'check';

export const MAINTENANCE_LABELS: Record<MaintenanceAction, string> = {
  optimize: '优化表',
  analyze: '分析表',
  check: '检查表',
};

export function buildMaintenanceSql(database: string, table: string, action: MaintenanceAction): string {
  const verb =
    action === 'optimize' ? 'OPTIMIZE' : action === 'analyze' ? 'ANALYZE' : 'CHECK';
  return `${verb} TABLE ${quoteQualified([database, table])};`;
}

// ---------- 对象模板（视图 / 过程 / 函数 / 触发器 / 事件） ----------

export type ObjectCreateKind = 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export const OBJECT_KIND_TEXT: Record<ObjectCreateKind, string> = {
  view: '视图',
  procedure: '存储过程',
  function: '函数',
  trigger: '触发器',
  event: '事件',
};

/** 模板里的占位对象名（用户改掉再执行） */
export const TEMPLATE_NAMES: Record<ObjectCreateKind, string> = {
  view: 'new_view',
  procedure: 'new_procedure',
  function: 'new_function',
  trigger: 'new_trigger',
  event: 'new_event',
};

/**
 * 新建对象的 SQL 模板（P1-21 的落地形态：不做专用设计器，给可改的模板）。
 *
 * 🔴 每个模板都必须是**单条语句**，且不用 `BEGIN … END`：
 *    编辑器的 splitStatements 按 `;` 切分，块体会被切成几条废语句，
 *    「填了模板 → 执行 → 语法错误」是最伤人的假实现。MySQL 允许例程/触发器/事件
 *    用单条语句做体，这里就用单条语句，保证「点执行就能成」。
 */
export function buildObjectTemplate(kind: ObjectCreateKind, database: string, name?: string): string {
  const db = quoteIdentifier(database);
  const obj = quoteIdentifier(name?.trim() || TEMPLATE_NAMES[kind]);
  const head = `-- 新建${OBJECT_KIND_TEXT[kind]}：执行成功后点左侧「刷新」或直接看「${OBJECT_KIND_TEXT[kind]}」类别`;

  switch (kind) {
    case 'view':
      return [
        head,
        `CREATE VIEW ${db}.${obj} AS`,
        'SELECT',
        "  1 AS col1;",
        '',
      ].join('\n');
    case 'procedure':
      return [
        head,
        `CREATE PROCEDURE ${db}.${obj}()`,
        "  SELECT 'hello' AS message;",
        '',
      ].join('\n');
    case 'function':
      return [
        head,
        `CREATE FUNCTION ${db}.${obj}(x INT) RETURNS INT`,
        '  DETERMINISTIC',
        '  RETURN x + 1;',
        '',
      ].join('\n');
    case 'trigger':
      return [
        head + '（把表名换成真正要挂的表，并确认时机/事件）',
        `CREATE TRIGGER ${db}.${obj} BEFORE INSERT ON ${db}.${quoteIdentifier('your_table')}`,
        'FOR EACH ROW',
        '  SET @dbstudio_trigger_tick = 1;',
        '',
      ].join('\n');
    case 'event':
      return [
        head + '（需要 event_scheduler=ON；计划与逻辑按需改）',
        `CREATE EVENT ${db}.${obj}`,
        'ON SCHEDULE EVERY 1 DAY',
        'STARTS CURRENT_TIMESTAMP',
        `COMMENT '新建事件'`,
        'DO',
        '  SET @dbstudio_event_tick = 1;',
        '',
      ].join('\n');
  }
}

/**
 * 把 `SHOW CREATE VIEW` 的原文改成可重复执行的 `CREATE OR REPLACE VIEW`（P2-30 缓解）。
 *
 * 三个必须处理的形态：
 *  1. 原文可能带**前置注释**（demo 后端就是），不能只对第一行做 `startsWith('CREATE')`；
 *  2. `CREATE ALGORITHM=… DEFINER=… SQL SECURITY … VIEW` —— 修饰子句在 CREATE 与 VIEW 之间，
 *     所以只能在 **CREATE 这个 token** 上插入 `OR REPLACE`；
 *  3. 已经是 `CREATE OR REPLACE` 时不要叠第二遍（否则语法错误）。
 *
 * @returns 可执行模板；不是 CREATE 语句（如 demo 的占位注释）→ null，由调用方如实说明
 */
export function toCreateOrReplaceView(ddl: string): string | null {
  const body = (ddl ?? '').replace(/;\s*$/, '').trim();
  if (!body) return null;

  // 跳过前置空白与注释，定位第一条语句的起始位置
  const lead = /^(?:\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*/.exec(body)?.[0] ?? '';
  const rest = body.slice(lead.length);
  const create = /^CREATE\b/i.exec(rest);
  if (!create) return null;

  const afterCreate = rest.slice(create[0].length);
  if (/^\s+OR\s+REPLACE\b/i.test(afterCreate)) return `${body};`;

  return `${lead}CREATE OR REPLACE${afterCreate};`.trim();
}

// ---------- 新建数据库对话框的字符集候选 ----------

/**
 * 常用字符集 → 排序规则候选。
 *
 * 只列 MySQL 8 里真实存在的组合：给出不存在的组合只会让用户点确认后收一条
 * 「Unknown collation」的服务端错误。
 */
export const CHARSET_PRESETS: { charset: string; collations: string[] }[] = [
  { charset: 'utf8mb4', collations: ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci'] },
  { charset: 'utf8mb3', collations: ['utf8mb3_general_ci', 'utf8mb3_unicode_ci'] },
  { charset: 'latin1', collations: ['latin1_swedish_ci', 'latin1_general_ci'] },
  { charset: 'ascii', collations: ['ascii_general_ci'] },
];

export function collationsOf(charset: string): string[] {
  return CHARSET_PRESETS.find((p) => p.charset === charset)?.collations ?? [];
}

/** 该字符集的默认排序规则（对话框初值用） */
export function defaultCollationOf(charset: string): string {
  return collationsOf(charset)[0] ?? '';
}
