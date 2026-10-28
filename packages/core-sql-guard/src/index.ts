/**
 * SQL 只读守卫（D6 只读模式的安全层）
 *
 * 设计依据：docs/engineering/TECH-REVIEW-v1.0.md §4.2（对应阻塞级问题 B4）
 *
 * 为什么不用正则扫关键字：
 *   正则在工程上必然漏判 CALL / SELECT…INTO OUTFILE / WITH…UPDATE / 多语句第二条。
 *   这是安全功能，漏判 = 用户以为开着只读模式，实际改了生产库。
 *   因此采用「SQL AST 语句类型白名单」：不在白名单内 → 拒绝。
 *   这样未来出现的任何新语法天然被拦住，不需要我们提前认识它。
 *
 * 三条硬规则：
 *   1. 白名单，不是黑名单
 *   2. 多语句逐条判定，任一条不合规则整批拒绝
 *   3. 解析失败 → 拒绝（fail-closed），宁可误拦不可漏放
 */

import pkg from 'node-sql-parser';

const { Parser } = pkg;

export type Dialect = 'mysql' | 'postgresql';

/** 拒绝原因（便于 UI 给出精确提示与日志归因） */
export type RejectReason =
  | 'empty'
  | 'parse-failed'          // 解析失败 → fail-closed
  | 'not-in-whitelist'      // 语句类型不在白名单
  | 'not-in-ddl-whitelist'  // T08：DDL 入口只放行结构变更语句
  | 'forbidden-select-modifier' // SELECT 带写副作用（INTO OUTFILE / FOR UPDATE / LOCK IN SHARE MODE）
  | 'unsafe-set'            // SET 了有副作用的变量
  | 'missing-where'         // V10：网格写语句的 UPDATE/DELETE 缺 WHERE（= 全表改删）
  | 'multi-statement-rejected'; // 多语句中某条被拒

export interface GuardResult {
  readonly allowed: boolean;
  readonly reason?: RejectReason;
  /** 解析出的语句类型（多条时为第一条的类型） */
  readonly statementType?: string;
  /** 所有语句的类型（多语句场景） */
  readonly statementTypes?: string[];
  /** 触发拒绝的那条语句原文（多语句时用于精确定位） */
  readonly offendingStatement?: string;
  /** 可直接展示给用户的中文说明 */
  readonly message: string;
}

/** 语句类型白名单 —— 只放行确定只读的语句 */
const STATEMENT_WHITELIST = new Set([
  'select',
  'show',
  'describe',
  'desc',
  'explain',
  'use',
  'set', // SET 需二次检查变量白名单，见 checkSet
]);

/**
 * SET 变量白名单。
 * MySQL 里 SET autocommit=0 / SET @@global.* / SET GLOBAL * 都有副作用，必须拦。
 * 只放行会话级、无副作用的字符集与时区设置。
 */
const SAFE_SET_VARS = new Set([
  'names',
  'character_set_client',
  'character_set_connection',
  'character_set_results',
  'character_set_server',
  'time_zone',
  'sql_mode',      // 会话级，不改数据
  'names_utf8mb4', // 兼容写法
]);

/** 有副作用的 SET 作用域关键字，一律拒绝 */
const UNSAFE_SET_SCOPES = new Set(['global', 'persist', 'persist_only']);

const parser = new Parser();

function ok(types: string[]): GuardResult {
  return {
    allowed: true,
    statementType: types[0],
    statementTypes: types,
    message: '允许执行',
  };
}

function reject(
  reason: RejectReason,
  message: string,
  extra: Partial<GuardResult> = {},
): GuardResult {
  return { allowed: false, reason, message, ...extra };
}

/**
 * T19：把「全默认值 INSERT」改写成解析器认识的等价写法。
 *
 * 🔴 为什么需要这一步：`INSERT INTO t () VALUES ()` 是**合法 MySQL**，但
 *    `node-sql-parser` 对它**任何**写法都解析失败 —— 实测三种形式全部报语法错：
 *      `INSERT INTO t () VALUES ()`  ✗
 *      `INSERT INTO t VALUES ()`     ✗
 *      `INSERT INTO t (c) VALUES (DEFAULT)`  ✗（DEFAULT 关键字也不认）
 *    后果不是「报个小错」而是**功能被自己的守卫拦死**：T19 的空白行生成的正是这条 SQL，
 *    用户点确认后拿到「解析失败已阻止执行」。单测只断 SQL 文本、UI 预演只显示文本，
 *    两边都发现不了 —— 只有真库门禁（e2e:app）能暴露。
 *
 * 处理方式是**解析前的等价改写**，不是白名单放行：
 *   - 只匹配「列清单为空 且 VALUES 里全是空元组」这一种形状（见正则），
 *     任何带表达式/子查询/多余内容的写法都不匹配 → 照旧 fail-closed；
 *   - 改写后的文本里没有任何来自用户的值（凭空补的列名只存在于解析副本中，
 *     真实执行的仍是原文），所以 AST 白名单那一步照样生效、照样拦非白名单类型。
 *
 * 与 `SET NAMES` 那处前置放行的区别：那里是文本白名单直接放行（失去 AST 覆盖），
 * 这里保留了 AST 路径，只是把解析器不认识的字面形态翻译成它认识的同义形态。
 */
const BLANK_INSERT_RE =
  /(^|;)(\s*)INSERT\s+INTO\s+((?:`[^`]+`|[\w$\u4e00-\u9fa5]+)(?:\s*\.\s*(?:`[^`]+`|[\w$\u4e00-\u9fa5]+))?)\s*\(\s*\)\s*VALUES\s*(\(\s*\)(?:\s*,\s*\(\s*\))*)(?=\s*;|\s*$)/gi;

function normalizeBlankInsert(sql: string): string {
  return sql.replace(BLANK_INSERT_RE, (_m, sep: string, gap: string, table: string, groups: string) => {
    const n = groups.split(',').length;
    const rows = Array.from({ length: n }, () => '(NULL)').join(', ');
    // 列名刻意用不会与真实列冲突的占位 —— 它只活在解析副本里
    return `${sep}${gap}INSERT INTO ${table} (__dbstudio_blank_col__) VALUES ${rows}`;
  });
}

/**
 * 把 SQL 拆成多条语句。
 *
 * 优先交给解析器（astify 在多条时返回数组），因为手写按分号切分会在
 * 字符串字面量 / 注释里的分号处误切。只有当解析器无法处理时才退回文本切分。
 */
function parseStatements(sql: string, dialect: Dialect): { asts: any[] } | { error: string } {
  try {
    const ast = parser.astify(normalizeBlankInsert(sql), {
      database: dialect === 'mysql' ? 'MySQL' : 'PostgreSQL',
    });
    return { asts: Array.isArray(ast) ? ast : [ast] };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/** 去掉注释与多余空白，用于 FOR UPDATE 等解析器未覆盖的副作用检测 */
function stripCommentsAndNormalize(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/--[^\n]*/g, ' ')            // -- 行注释
    .replace(/#[^\n]*/g, ' ')             // MySQL # 注释
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 检测 SELECT 上的写副作用修饰符。
 *
 * 解析器能覆盖 INTO OUTFILE（ast.into.keyword），但实测 FOR UPDATE 与
 * LOCK IN SHARE MODE 的 ast.lock 为 undefined（解析器未保留该信息）。
 * 因此这两项用文本兜底——注意这是**在已确定为 select 类型的 AST 之上**做的
 * 附加检测，不是拿正则当主防线，误判风险可控。
 */
function selectHasWriteSideEffect(ast: any, rawSql: string): string | null {
  // INTO OUTFILE / INTO DUMPFILE：写文件
  const into = ast?.into;
  if (into && into.keyword) {
    const kw = String(into.keyword).toUpperCase();
    if (kw === 'OUTFILE' || kw === 'DUMPFILE') {
      return `SELECT … INTO ${kw} 会写服务端文件`;
    }
  }

  const norm = stripCommentsAndNormalize(rawSql).toUpperCase();
  // FOR UPDATE / LOCK IN SHARE MODE：加排他/共享锁，会阻塞他人写入
  // 用词边界匹配，避免误伤字段名（如 for_updated_at）
  if (/\bFOR\s+UPDATE\b/.test(norm)) {
    return 'SELECT … FOR UPDATE 会加排他锁';
  }
  if (/\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(norm)) {
    return 'SELECT … LOCK IN SHARE MODE 会加共享锁';
  }

  return null;
}

/**
 * SET 语句的二次校验。
 * 返回 null 表示安全，否则返回拒绝原因描述。
 */
function checkSet(ast: any, rawSql: string): string | null {
  // 作用域关键字：SET GLOBAL ... / SET PERSIST ... 一律拒绝
  const keyword = ast?.keyword ? String(ast.keyword).toLowerCase() : null;
  if (keyword && UNSAFE_SET_SCOPES.has(keyword)) {
    return `SET ${keyword.toUpperCase()} 是全局级设置，有副作用`;
  }

  const exprs = Array.isArray(ast?.expr) ? ast.expr : [];

  for (const e of exprs) {
    // 变量名：var 节点带 prefix（@@ / @），members 数组
    const left = e?.left;
    if (left?.prefix) {
      // @@global.* / @@session.* / @user_var
      const name = String(left.name ?? '').toLowerCase();
      if (UNSAFE_SET_SCOPES.has(name)) {
        return `SET @@${name} 是全局级变量，有副作用`;
      }
      // 用户变量 @@x / @x 一律拒绝（多数用于状态传递）
      return `SET ${left.prefix}${name} 涉及状态变量，有副作用`;
    }

    const varName = String(left?.name ?? '').toLowerCase();
    if (!SAFE_SET_VARS.has(varName)) {
      return `SET ${varName} 不在安全变量白名单内`;
    }
  }

  // exprs 为空时（如 SET NAMES 这类解析器不直接支持的写法），
  // 退回文本白名单匹配
  if (exprs.length === 0) {
    const norm = stripCommentsAndNormalize(rawSql).toUpperCase();
    if (/^SET\s+NAMES\b/.test(norm)) return null;
    if (/^SET\s+(SESSION\s+)?(CHARACTER\s+SET|CHARSET)\b/.test(norm)) return null;
    if (/^SET\s+(SESSION\s+)?TIME_ZONE\b/.test(norm)) return null;
    return 'SET 语句无法判定为安全，已阻止执行';
  }

  return null;
}

/**
 * 只读校验主入口。
 *
 * @param sql 用户输入的 SQL（可能是多语句）
 * @param dialect 数据库方言
 */
export function checkReadOnly(sql: string, dialect: Dialect): GuardResult {
  if (!sql || !sql.trim()) {
    return reject('empty', '空语句');
  }

  const parsed = parseStatements(sql, dialect);

  if ('error' in parsed) {
    // fail-closed：解析失败一律拒绝。
    // 注意：node-sql-parser 实测不支持 `SET NAMES utf8mb4`（无等号赋值形式），
    // 该写法会在 MySQL 方言下解析失败。这里对 SET NAMES 做前置放行，
    // 因为它是确定安全的会话级字符集设置，且用户高频使用。
    const norm = stripCommentsAndNormalize(sql).toUpperCase();
    if (/^SET\s+NAMES\b/.test(norm) || /^SET\s+(SESSION\s+)?(CHARACTER\s+SET|CHARSET)\b/.test(norm)) {
      return ok(['set']);
    }
    return reject(
      'parse-failed',
      `无法判定该语句是否为只读，已阻止执行（解析失败：${parsed.error.slice(0, 120)}）`,
    );
  }

  const asts = parsed.asts;
  const types = asts.map((a) => String(a?.type ?? 'unknown'));

  // 逐条判定：任一条不合规 → 整批拒绝
  for (let i = 0; i < asts.length; i++) {
    const ast = asts[i];
    const type = String(ast?.type ?? 'unknown');

    if (!STATEMENT_WHITELIST.has(type)) {
      return reject(
        'not-in-whitelist',
        `语句类型「${type}」不在只读白名单内，已阻止执行`,
        {
          statementType: type,
          statementTypes: types,
          offendingStatement: asts.length > 1 ? `第 ${i + 1} 条语句` : undefined,
          ...(asts.length > 1 ? { reason: 'multi-statement-rejected' as RejectReason } : {}),
        },
      );
    }

    // SELECT 的写副作用
    if (type === 'select') {
      const sideEffect = selectHasWriteSideEffect(ast, sql);
      if (sideEffect) {
        return reject('forbidden-select-modifier', `${sideEffect}，已阻止执行`, {
          statementType: type,
          statementTypes: types,
        });
      }
    }

    // SET 的变量白名单
    if (type === 'set') {
      const setIssue = checkSet(ast, sql);
      if (setIssue) {
        return reject('unsafe-set', `${setIssue}，已阻止执行`, {
          statementType: type,
          statementTypes: types,
        });
      }
    }
  }

  return ok(types);
}

// ---------- 危险操作分级（P0-3，PRD §8.5 安全交互） ----------

/** 危险等级：none 无需确认 / confirm 二次确认 / danger 生产环境再加第三层 */
export type DangerLevel = 'none' | 'confirm' | 'danger';

export interface DangerInfo {
  level: DangerLevel;
  /** 触发危险的语句（多语句时逐条列出） */
  statements: string[];
  /** 人读原因（弹窗正文） */
  reason: string;
  /** 第三层确认要求输入的表名（从 DROP/TRUNCATE 目标提取） */
  requireName: string | null;
}

/**
 * 危险语句分级（DROP / TRUNCATE / 无 WHERE 的 UPDATE / DELETE）。
 *
 * 与 checkReadOnly 的关系：
 *  - checkReadOnly 服务只读模式（白名单拦截，fail-closed）
 *  - classifyDanger 服务【正常连接】的写前确认 —— 只分类不拦截，执行与否由 UI 确认
 *
 * 判定走 AST（与守卫同一解析器），注释/字符串里的关键字不会误报。
 * DROP DATABASE / DROP SCHEMA 的 requireName = 库名；其余 = 表名。
 */
export function classifyDanger(sql: string, dialect: Dialect = 'mysql'): DangerInfo {
  const none: DangerInfo = { level: 'none', statements: [], reason: '', requireName: null };
  if (!sql || !sql.trim()) return none;

  const parsed = parseStatements(sql, dialect);
  if ('error' in parsed) {
    // 解析失败不拦（那是只读守卫的事），但也不给任何危险放行信号：
    // 未知语句就当普通语句走默认流程。这里宁可少报不能误报级别。
    return none;
  }

  const asts = parsed.asts;
  const statements: string[] = [];
  let level: DangerLevel = 'none';
  const reasons: string[] = [];
  let requireName: string | null = null;

  for (const ast of asts) {
    const type = String(ast?.type ?? '').toLowerCase();
    let hit = false;

    if (type === 'truncate') {
      hit = true;
      reasons.push('TRUNCATE 将清空全表数据（保留结构）');
    } else if (type === 'drop') {
      hit = true;
      // node-sql-parser：keyword='database' 时 name 是字符串库名；'table' 时 name 是 [{db, table}]
      if (String(ast?.keyword) === 'database' || String(ast?.keyword) === 'schema') {
        reasons.push('DROP DATABASE 将删除整个库（含全部表，不可恢复）');
        level = 'danger'; // DROP DATABASE 无论如何都是最高级
        const n = ast?.name;
        if (typeof n === 'string') requireName = n;
      } else {
        reasons.push('DROP TABLE 将删除表结构与全部数据，不可恢复');
      }
    } else if (type === 'update' || type === 'delete') {
      // 无 WHERE 的改/删 = 影响全表
      if (ast?.where == null) {
        hit = true;
        reasons.push(`${type === 'update' ? 'UPDATE' : 'DELETE'} 没有 WHERE 条件，将影响【全部行】`);
      }
    }

    if (hit) {
      if (level === 'none') level = 'confirm';
      if (!requireName) {
        const name = extractTableName(ast);
        if (name) requireName = name;
      }
      statements.push(statementText(ast, sql));
    }
  }

  return { level, statements, reason: reasons.join('；'), requireName };
}

/**
 * AST → 表名（去掉库名前缀）。
 * node-sql-parser 实测形态：
 *  - update/delete：table 是数组 [{db, table}]
 *  - truncate/drop table：name 是数组 [{db, table}]
 */
function extractTableName(ast: any): string | null {
  const candidates: unknown[] = [];
  if (Array.isArray(ast?.table)) candidates.push(ast.table[0]);
  else candidates.push(ast?.table);
  if (Array.isArray(ast?.name)) candidates.push(ast.name[0]);
  else if (typeof ast?.name === 'string') candidates.push({ table: ast.name });

  for (const c of candidates) {
    if (typeof c === 'string') {
      const name = c.split('.').pop() ?? '';
      if (name) return name;
    } else if (c && typeof c === 'object') {
      const name = String((c as { table?: unknown }).table ?? '');
      if (name) return name;
    }
  }
  return null;
}

/** AST → 语句原文（近似：取 type 上下文的关键片段；展示用不追求逐字） */
function statementText(ast: any, fullSql: string): string {
  // node-sql-parser 的定位信息不含行列，退而求其次：
  // 用语句类型 + 表名拼一个可识别的描述
  const type = String(ast?.type ?? '').toUpperCase();
  const name = extractTableName(ast) ?? '';
  return name ? `${type} ${name}（节选自：${fullSql.trim().slice(0, 60)}）` : type;
}

/**
 * A12 查询结果写回：判定一条 SQL 是否为「可直接定位到单表」的 SELECT。
 *
 * 判定通过 → 返回唯一表的 {database, table}，渲染层据此提供
 * 「打开可编辑表格」入口（真正的编辑仍走 TableMeta 的 PK 定位与
 * 逐条 SQL 预览红线，这里只负责安全地找到写回目标）。
 *
 * 保守启发式（宁可不给入口，绝不能给错目标）：
 *  - 仅接受【单条】select 语句；多语句/解析失败 → null（fail-closed）
 *  - FROM 必须是且只是一个【真实表】——派生表/子查询/多表 JOIN/逗号连接一律 null
 *  - 有 CTE（WITH）、DISTINCT、GROUP BY/HAVING、INTO、FOR UPDATE → null
 *  - SELECT 列表里出现函数/表达式（COUNT/SUM/…）→ null
 *  - WHERE/ORDER BY/LIMIT 允许：不影响写回目标的判定
 */
export function extractSingleTable(
  sql: string,
  dialect: Dialect = 'mysql',
): { database: string | null; table: string } | null {
  if (!sql || !sql.trim()) return null;
  const parsed = parseStatements(sql, dialect);
  if ('error' in parsed || parsed.asts.length !== 1) return null;
  const ast = parsed.asts[0];
  if (String(ast?.type ?? '') !== 'select') return null;

  // 写意图/聚合形态直接出局。
  // ⚠️ INTO 不能判 ast.into —— node-sql-parser 对普通 SELECT 也恒置
  //    `into: {position: null}`，按真值判会把所有 SELECT 全拒掉。
  //    改用文本级关键字检测：误拒（WHERE 里恰好有 "into" 单词）无害，
  //    漏放 INTO OUTFILE 才是事故。
  if (ast.with || ast.distinct || ast.groupby || ast.having) return null;
  if (ast.for_update || ast.lock_mode) return null;
  if (/\bINTO\b/.test(stripCommentsAndNormalize(sql).toUpperCase())) return null;

  // FROM：必须恰好一个真实表（node-sql-parser 里派生表是 {expr, as}，
  // 没有 .table 字符串字段；JOIN/逗号连接会变成多个 from 条目）
  const from = ast.from;
  if (!Array.isArray(from) || from.length !== 1) return null;
  const ref = from[0];
  const table = typeof ref?.table === 'string' ? ref.table : null;
  if (!table) return null;
  // 显式 JOIN 的条目带 .join 字段（理论上 from.length===1 已排除，双保险）
  if (ref.join) return null;

  // SELECT 列表：只允许 * 或纯列引用（防 COUNT/SUM 等聚合伪装成单表结果）
  const columns = ast.columns;
  if (columns !== '*') {
    if (!Array.isArray(columns)) return null;
    for (const col of columns) {
      const exprType = String(col?.expr?.type ?? col?.expr ?? '');
      if (exprType !== 'column_ref' && exprType !== '*') return null;
    }
  }

  const db = typeof ref.db === 'string' && ref.db ? ref.db : null;
  return { database: db, table };
}

/** 便捷判定：是否允许执行 */
export function isReadOnly(sql: string, dialect: Dialect): boolean {
  return checkReadOnly(sql, dialect).allowed;
}

// ---------- V10：网格写语句的结构白名单（表达式模式的真防线） ----------

/** 网格保存链路只允许这三种语句 */
const MUTATION_WHITELIST = new Set(['insert', 'update', 'delete']);

/**
 * V10 SQL 表达式模式的主进程兜底校验。
 *
 * **为什么需要这一层**：表达式值是「原样嵌进 SQL 文本」的，渲染层
 * `validateSqlExpression` 只是即时反馈 —— 它可以被绕过（改包、直接调 IPC）。
 * 只读守卫拦不住它：`UPDATE ... SET a = NOW()` 在只读白名单外没错，
 * 但只读守卫服务的是「只读连接」，正常连接根本不走它。
 * 所以正常连接的写链路需要**自己的**结构白名单。
 *
 * 判定（fail-closed，与 checkReadOnly 同一套口径）：
 *  1. 必须恰好一条语句 —— 分号拼第二条是表达式注入的最短路径；
 *  2. 语句类型必须在 insert/update/delete 里 —— DDL/权限/CALL 一律拒；
 *  3. UPDATE/DELETE 必须带 WHERE —— 网格的写永远是「定位到某些行」，
 *     没有 WHERE 意味着表达式写成了全表更新，那不是用户本意；
 *  4. 解析失败 → 拒绝。
 */
export function checkMutationStatement(sql: string, dialect: Dialect = 'mysql'): GuardResult {
  if (!sql || !sql.trim()) return reject('empty', '空语句');

  const parsed = parseStatements(sql, dialect);
  if ('error' in parsed) {
    return reject('parse-failed', `无法判定该写语句是否安全，已阻止执行（解析失败：${parsed.error.slice(0, 120)}）`);
  }

  const asts = parsed.asts;
  if (asts.length !== 1) {
    return reject('multi-statement-rejected', `网格保存只允许单条语句，收到 ${asts.length} 条，已阻止执行`, {
      statementTypes: asts.map((a) => String(a?.type ?? 'unknown')),
    });
  }

  const ast = asts[0];
  const type = String(ast?.type ?? 'unknown');
  if (!MUTATION_WHITELIST.has(type)) {
    return reject('not-in-whitelist', `语句类型「${type}」不允许由网格保存链路执行，已阻止`, {
      statementType: type,
    });
  }

  // UPDATE/DELETE 无 WHERE = 全表改删。网格的语义永远是定位行，
  // 出现这种语句只可能是表达式里藏了东西（或构造层有 bug），一律拒。
  if ((type === 'update' || type === 'delete') && !ast.where) {
    return reject('missing-where', `${type.toUpperCase()} 缺少 WHERE 条件，网格保存不接受全表写操作`, {
      statementType: type,
    });
  }

  return ok([type]);
}

export { STATEMENT_WHITELIST, SAFE_SET_VARS, MUTATION_WHITELIST };

// ---------- 0.7.1：语句分类（执行结果文案的判据） ----------

/**
 * 执行结果展示用的语句分类。
 *
 * 为什么需要它：执行结果文案不能靠 `rowCount` 一个数决定 —— 结果集说「返回 N 行」，
 * 写操作必须说「已修改 N 行」，DDL 根本不该提行数（它恒为 0）。
 *
 *  - `select`：会产生结果集（含 SHOW / DESCRIBE / EXPLAIN）
 *  - `insert` / `update` / `delete`：写操作，取 affectedRows（**不是** rows.length）
 *  - `ddl`：结构变更，无行数概念
 *  - `other`：判定不了（解析失败 / SET / CALL / 未知方言），fail-safe，文案退回中性
 *
 * ⚠️ 与 `STATEMENT_WHITELIST`（只读守卫）不是一回事：那是安全白名单，这是展示分类。
 *    两者共用同一份 AST，但语义变化互不影响 —— 不要合并。
 */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

/** 返回结果集的语句（USE/SET 不在此列：它们没有行数概念，归 other 出中性文案） */
const RESULT_SET_TYPES = new Set(['select', 'show', 'describe', 'desc', 'explain']);

/** 结构变更语句 */
const DDL_TYPES = new Set(['create', 'drop', 'alter', 'truncate', 'rename']);

/**
 * 判定一条 SQL 的执行结果分类。
 *
 * 多语句取**第一条**：执行链路本身是逐条执行、逐条出结果标签，文案跟着逐条走，
 * 这里只需要给「这一条」定性。
 *
 * 解析失败一律返回 `other`（不猜）—— 猜错方向的代价是给用户看错误的行数口径，
 * 比显示中性的「执行完成」更糟。
 */
export function statementKindOf(sql: string, dialect: Dialect = 'mysql'): StatementKind {
  if (!sql || !sql.trim()) return 'other';

  const parsed = parseStatements(sql, dialect);
  if ('error' in parsed) return 'other';

  const type = String(parsed.asts[0]?.type ?? '').toLowerCase();
  if (RESULT_SET_TYPES.has(type)) return 'select';
  if (type === 'insert' || type === 'replace') return 'insert';
  if (type === 'update') return 'update';
  if (type === 'delete') return 'delete';
  if (DDL_TYPES.has(type)) return 'ddl';
  return 'other';
}

// ---------- T08 配套：DDL 结构白名单（与网格写语句分开） ----------

/**
 * 允许由「DDL 入口」执行的语句类型（结构变更，不写行数据）。
 *
 * 🔴 为什么必须与 `MUTATION_WHITELIST` 分开：
 *
 * 网格写链路（保存预演）里 UPDATE/DELETE 的 SET 段可能含**原样嵌入的表达式**，
 * 所以那条链路要 fail-closed 地只放行 insert/update/delete。但 `mutationApply`
 * 这个入口**同时**承载树右键的「删除表 / 清空表」——它们是 DDL，
 * 类型是 drop/truncate，于是被上一条白名单拒之门外，
 * 结果「删除表」按钮点了直接报「语句类型「drop」不允许由网格保存链路执行」。
 *
 * 这不是放宽安全，而是**把两类语义分开**：
 *  - grid-write：走 MUTATION_WHITELIST（防表达式注入全表写）；
 *  - ddl       ：走本表 + 单语句约束（DDL 无法把值写进行里，注入面是语句拼接，
 *                而拼接在调用侧已由 core-sql-ident 的标识符转义封住）。
 *
 * 两条链路都仍然要过只读守卫；都不允许多语句拼接。
 */
const DDL_WHITELIST = new Set(['drop', 'truncate', 'create', 'alter', 'rename']);

/**
 * DDL 入口的结构校验。
 *
 * 判定（fail-closed）：
 *  1. 必须恰好一条语句 —— 分号拼第二条同样是注入的最短路径；
 *  2. 类型必须在 DDL 白名单里 —— 不允许从 DDL 入口偷跑 SELECT/INSERT 等。
 */
export function checkDdlStatement(sql: string, dialect: Dialect = 'mysql'): GuardResult {
  if (!sql || !sql.trim()) return reject('empty', '空语句');

  const parsed = parseStatements(sql, dialect);
  if ('error' in parsed) {
    return reject('parse-failed', `无法判定该 DDL 语句是否安全，已阻止执行（解析失败：${parsed.error.slice(0, 120)}）`);
  }

  const asts = parsed.asts;
  if (asts.length !== 1) {
    return reject('multi-statement-rejected', `只允许单条 DDL 语句，收到 ${asts.length} 条，已阻止执行`, {
      statementTypes: asts.map((a) => String(a?.type ?? 'unknown')),
    });
  }

  const type = String(asts[0]?.type ?? 'unknown');
  if (!DDL_WHITELIST.has(type)) {
    return reject('not-in-ddl-whitelist', `语句类型「${type}」不允许由 DDL 入口执行，已阻止`, {
      statementType: type,
    });
  }

  return ok([type]);
}
