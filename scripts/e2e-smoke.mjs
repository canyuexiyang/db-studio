/**
 * 端到端冒烟 —— 真实 MySQL fixture（S5 卷：dbstudio_mysql_data，1000 万行，端口 13306）
 *
 * 跑通 PRD 的核心闭环：
 *   连接 → 元数据 introspect → schema 快照落盘 → 列式查询 → 编辑保存 → 冲突检测
 *
 * 这不是单测：单测用替身验证逻辑，这个脚本验证「拼起来在真库上真的能跑」。
 * 只读断言用真实查询；写操作全部在一个临时库里做，跑完清理。
 *
 * 运行：node scripts/e2e-smoke.mjs
 * 前置：docker compose 的 dbstudio-mysql 已在 13306 监听
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MySqlDriver } from '../packages/core-driver-mysql/src/index.js';
import { encodeColumnar, ColumnarReader, columnarByteLength } from '../packages/core-ipc-codec/src/index.js';
import { SchemaCache } from '../packages/core-schema-cache/src/index.js';
import { checkReadOnly } from '../packages/core-sql-guard/src/index.js';
import { buildMutationPlan, locateStrategy, isEditable, interpretResult } from '../packages/core-mutation/src/index.js';

const CRED = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

const t0 = Date.now();
const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-e2e-'));
const cache = new SchemaCache(workDir);
let driver;

try {
  // ---------- 1. 连接 ----------
  console.log('\n【1】连接');
  driver = new MySqlDriver(CRED, { maxExecutionTimeMs: 30000 });
  const conn = await driver.connect();
  check('连接成功并取到服务端版本', !!conn.serverVersion, `${conn.serverVersion} / ${conn.elapsedMs}ms`);
  check('取到 connection_id（取消要用）', driver.connectionId > 0, `#${driver.connectionId}`);

  // ---------- 2. 建临时库（写操作隔离） ----------
  console.log('\n【2】准备临时库');
  const db = `e2e_${Date.now().toString(36)}`;
  const admin = new MySqlDriver(CRED, {});
  await admin.connect();
  await admin.query(`CREATE DATABASE \`${db}\``);
  await admin.close();
  check('临时库已创建', true, db);

  const writeDriver = new MySqlDriver({ ...CRED, database: db }, {});
  await writeDriver.connect();

  await writeDriver.query(`
    CREATE TABLE \`order\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      amount DECIMAL(12,2) NOT NULL,
      note TEXT,
      score DOUBLE NOT NULL,
      payload JSON NULL,
      big_no BIGINT NOT NULL,
      ts DATETIME(6) NULL
    )
  `);
  await writeDriver.query(`
    CREATE TABLE no_key_table (
      name VARCHAR(64) NOT NULL,
      city VARCHAR(32) NOT NULL
    )
  `);
  /**
   * V9：带外键的一对表（单列 + 复合外键各一）。
   *
   * 🔴 为什么要在真库冒烟里建：`listForeignKeys` 在 rowsAsArray 下**按列下标**
   *    解构 `KEY_COLUMN_USAGE JOIN REFERENTIAL_CONSTRAINTS` 的结果。单测的 mock
   *    是照这个假设写的 —— 服务端改了 information_schema 的列序/JOIN 语义，
   *    单测照样全绿，而线上会静默装配出**错误的外键**（跳到错误的行，不报错）。
   *    这是「替身照着被测代码的假设实现」的典型陷阱，必须真库盯着。
   */
  await writeDriver.query(`
    CREATE TABLE fk_parent (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_name (name)
    )
  `);
  await writeDriver.query(`
    CREATE TABLE fk_child (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      pid BIGINT NOT NULL,
      tag VARCHAR(32),
      CONSTRAINT fk_child_parent FOREIGN KEY (pid) REFERENCES fk_parent(id)
        ON DELETE RESTRICT ON UPDATE CASCADE
    )
  `);
  // 复合外键：验证按约束名分组时 ORDINAL_POSITION 的排序（错位 = 静默跳错行）
  await writeDriver.query(`
    CREATE TABLE fk_pair (a INT NOT NULL, b INT NOT NULL, PRIMARY KEY (a, b))
  `);
  await writeDriver.query(`
    CREATE TABLE fk_child2 (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      x INT NOT NULL,
      y INT NOT NULL,
      CONSTRAINT fk_child2_pair FOREIGN KEY (x, y) REFERENCES fk_pair(a, b)
    )
  `);
  await writeDriver.query(
    `INSERT INTO \`order\` (status, amount, note, score, payload, big_no, ts) VALUES
     ('new', '10.00', 'hello', 1.5, '{"id":9007199254740993}', 9007199254740993, '2026-09-20 15:04:05.123456'),
     ('new', '20.00', NULL,   2.5, NULL,                        9007199254740994, NULL),
     ('paid','30.00', '',     3.5, NULL,                        9007199254740995, NULL)`,
  );
  check('测试表与数据已就绪', true, '3 行 + 无键表 1 张');

  // ---------- 3. introspect ----------
  console.log('\n【3】元数据 introspect');
  const ti = Date.now();
  const dbs = await writeDriver.introspect([db]);
  const introspectMs = Date.now() - ti;
  const order = dbs[0].tables.find((t) => t.name === 'order');
  const noKey = dbs[0].tables.find((t) => t.name === 'no_key_table');
  check('introspect 返回库表', !!order && !!noKey, `${introspectMs}ms`);
  check('主键识别正确', order.columns.find((c) => c.name === 'id').isPrimaryKey);
  check('自增识别正确', order.columns.find((c) => c.name === 'id').autoIncrement);
  check(
    '有主键表 → 可编辑',
    locateStrategy(order) === 'pk' && isEditable(order),
  );
  check(
    '无键表 → 只读（B5 红线）',
    locateStrategy(noKey) === 'none' && !isEditable(noKey),
  );

  // ---------- 3.5 V9 外键元数据（真库校验 JOIN 列序假设） ----------
  /**
   * 🔴 这一段是真库门禁的核心价值所在：`listForeignKeys` 按**列下标**解构
   *    `KEY_COLUMN_USAGE JOIN REFERENTIAL_CONSTRAINTS`（rowsAsArray 下没有列名可依），
   *    单测的 mock 是照这个下标假设写的 —— 服务端改了 information_schema 的
   *    列序或 JOIN 语义，单测照样全绿，而线上会静默装配出**错误的外键**。
   *    错误的后果不是报错，是「点外键跳到错误的行」，用户看不出任何异常。
   */
  console.log('\n【3.5】V9 外键元数据（真库列序校验）');
  const fkSingle = await writeDriver.listForeignKeys(db, 'fk_child');
  check('单列外键被识别（真库 information_schema JOIN 生效）', fkSingle.length === 1,
    fkSingle.length ? fkSingle[0].constraintName : '0 条');
  const fk0 = fkSingle[0] ?? {};
  check('外键的本表列正确（COLUMN_NAME 下标没错位）', fk0.columns?.[0] === 'pid',
    JSON.stringify(fk0.columns));
  check('外键的引用库正确（REFERENCED_TABLE_SCHEMA 下标没错位）',
    fk0.referencedDatabase === db, fk0.referencedDatabase);
  check('外键的引用表正确（REFERENCED_TABLE_NAME 下标没错位）',
    fk0.referencedTable === 'fk_parent', fk0.referencedTable);
  check('外键的引用列正确（REFERENCED_COLUMN_NAME 下标没错位）',
    fk0.referencedColumns?.[0] === 'id', JSON.stringify(fk0.referencedColumns));
  // DELETE_RULE/UPDATE_RULE 来自 JOIN 的右表（rc），下标错位会让规则张冠李戴
  check('ON DELETE/UPDATE 规则来自 JOIN 右表且未错位',
    fk0.onDelete === 'RESTRICT' && fk0.onUpdate === 'CASCADE',
    `${fk0.onDelete}/${fk0.onUpdate}`);

  const fkCompound = await writeDriver.listForeignKeys(db, 'fk_child2');
  check('复合外键按约束名合并成一条（不是一列一条）', fkCompound.length === 1,
    `${fkCompound.length} 条`);
  // 🔴 顺序即语义：[x,y] ↔ [a,b]。若 ORDER BY ORDINAL_POSITION 失效或下标错位，
  //    这里会变成 [x,y] ↔ [b,a]，跳转时把 x 的值当 b 用 —— 静默定位到错误的行。
  check('🔴 复合外键列顺序一一对应（ORDER BY ORDINAL_POSITION 生效）',
    JSON.stringify(fkCompound[0]?.columns) === '["x","y"]' &&
    JSON.stringify(fkCompound[0]?.referencedColumns) === '["a","b"]',
    `${JSON.stringify(fkCompound[0]?.columns)} ↔ ${JSON.stringify(fkCompound[0]?.referencedColumns)}`);

  const fkNone = await writeDriver.listForeignKeys(db, 'order');
  check('无外键的表返回空数组（不是 null / 不抛错）',
    Array.isArray(fkNone) && fkNone.length === 0, `${fkNone.length} 条`);

  // 候选值查询：🔴 必须带 LIMIT（引用表可能百万行，下拉不该触发全表扫描）
  const lookup = await writeDriver.lookupReferencedValues({
    database: db, table: 'fk_parent', valueColumn: 'id', displayColumn: 'name', limit: 5,
  });
  check('候选值查询可执行（真库 LIMIT 路径通）',
    Array.isArray(lookup.items) && lookup.truncated === false, `${lookup.items.length} 条`);

  // ---------- 4. schema 快照 ----------
  console.log('\n【4】Schema 快照落盘与恢复');
  cache.save('e2e-conn', dbs);
  const state = cache.load('e2e-conn');
  check('快照可用且未过期', state.snapshot !== null && !state.stale, `age=${state.ageMs}ms`);
  check('快照版本兼容', state.compatible === true);
  const byCol = cache.findTablesByColumn(state.snapshot, 'status');
  check('字段名倒排索引可用（Q2 搜表）', byCol.includes(`${db}.order`), byCol.join(','));

  // ---------- 5. 列式查询 ----------
  console.log('\n【5】列式查询与保真');
  const q = await writeDriver.query(
    'SELECT id, status, amount, note, score, payload, big_no, ts FROM `order` ORDER BY id',
  );
  // 传列定义 dataType：R10 把数值字符串化了，不传就拿不回真正的数值列
  const columnTypes = q.fields.map((f) => order.columns.find((c) => c.name === f.name)?.dataType);
  const p = encodeColumnar(q.rows, q.fields.map((f) => f.name), columnTypes);
  const reader = new ColumnarReader(p);
  check('列式编码完成', reader.rowCount === 3, `${columnarByteLength(p)} bytes / ${reader.columnCount} 列`);

  // R10 字符串化数值 → 按列定义还原
  const scoreIdx = reader.payload.columns.findIndex((c) => c.name === 'score');
  check('DOUBLE 列还原为数值（R10 下原为字符串）', typeof reader.decodeCell(0, scoreIdx) === 'number', `${typeof reader.decodeCell(0, scoreIdx)} ${reader.decodeCell(0, scoreIdx)}`);
  const amountStr = String(reader.decodeCell(0, reader.payload.columns.findIndex((c) => c.name === 'amount')));
  check('DECIMAL 保持字符串（不引入浮点误差）', amountStr === '10.00', amountStr);

  // 红线：BIGINT > 2^53 不丢精度
  const bigNo = String(reader.decodeCell(0, reader.payload.columns.findIndex((c) => c.name === 'big_no')));
  check('BIGINT > 2^53 精度保持', bigNo === '9007199254740993', bigNo);

  // 红线：DATETIME(6) 微秒不丢
  const ts = reader.decodeCell(0, reader.payload.columns.findIndex((c) => c.name === 'ts'));
  check('DATETIME(6) 微秒保持', ts === '2026-09-20 15:04:05.123456', String(ts));

  // 红线：JSON 大整数不被 parse（注意 MySQL 服务端会规范化 JSON，加空格后再存储，
  // 所以比对的是"没有被 JS 对象化"这一点：必须是 string 且大整数位完整）
  const payload = reader.decodeCell(0, reader.payload.columns.findIndex((c) => c.name === 'payload'));
  check(
    'JSON 保持字符串、不被自动 parse',
    typeof payload === 'string' && payload.includes('9007199254740993'),
    `${typeof payload}: ${String(payload)}`,
  );

  // 红线：NULL 与空串可区分
  const noteIdx = reader.payload.columns.findIndex((c) => c.name === 'note');
  check('NULL 与空串可区分', reader.isNull(1, noteIdx) === true && reader.isNull(2, noteIdx) === false);
  check('空串解为空串而非 NULL', reader.decodeCell(2, noteIdx) === '');

  // 只解可视区
  const before = reader.stats.cellsDecoded;
  const visible = reader.decodeRowRange(0, 2);
  check('只解可视区', visible.length === 2 && reader.stats.cellsDecoded - before === 16, `解了 ${reader.stats.cellsDecoded - before} 格`);

  // ---------- 6. 只读守卫 ----------
  console.log('\n【6】只读模式 AST 守卫');
  const cases = [
    ['SELECT * FROM `order`', true],
    ['SHOW TABLES', true],
    ['EXPLAIN SELECT * FROM `order`', true],
    ['DROP TABLE `order`', false],
    ['CALL proc()', false],
    ['SELECT * FROM `order` INTO OUTFILE "/tmp/x"', false],
    ['SELECT 1; DROP TABLE `order`', false],
    ['UPDATE `order` SET status = "x"', false],
    ['SET GLOBAL max_connections = 1000', false],
    ['SET autocommit = 0', false],
    ['SET NAMES utf8mb4', true],
    ['THIS IS NOT SQL', false],
  ];
  let guardOk = true;
  for (const [sql, expected] of cases) {
    const r = checkReadOnly(sql, 'mysql');
    if (r.allowed !== expected) {
      guardOk = false;
      console.log(`   ❌ ${sql} → 期望 ${expected ? '放行' : '拦截'}，实际 ${r.allowed ? '放行' : '拦截'}`);
    }
  }
  check('只读守卫 12 个用例全部符合预期', guardOk);

  // ---------- 7. 编辑保存（红线：只提交被编辑的单元格） ----------
  console.log('\n【7】编辑保存');
  const row1 = q.rows[0];
  const plan = buildMutationPlan(db, order, {
    updates: [
      [
        { rowId: '1', locate: 'pk', column: 'status', oldValue: row1[1], newValue: 'paid', locateValues: [row1[0]] },
        { rowId: '1', locate: 'pk', column: 'note', oldValue: row1[3], newValue: '改过了', locateValues: [row1[0]] },
      ],
    ],
  });
  const sql = plan.statements[0].sql;
  check('只 SET 被编辑的两列', sql.includes('`status` = ?') && sql.includes('`note` = ?'), sql);
  check('未编辑的列不出现在 SQL 里', !sql.includes('`amount`') && !sql.includes('`score`') && !sql.includes('`payload`'));
  check('WHERE 带主键与原值（冲突检测）', sql.includes('WHERE `id` = ?') && sql.includes('AND `status` = ?'));

  await writeDriver.query('START TRANSACTION');
  const upd = await writeDriver.query(sql, plan.statements[0].params);
  check('UPDATE 命中 1 行', upd.affectedRows === 1, `affectedRows=${upd.affectedRows}`);
  await writeDriver.query('ROLLBACK');
  check('回滚成功（批量提交语义：单事务）', true);

  // 真正提交一次，验证数据落地
  const upd2 = await writeDriver.query(sql, plan.statements[0].params);
  check('提交后 affectedRows=1', upd2.affectedRows === 1);
  const after = await writeDriver.query('SELECT id, status, amount, note FROM `order` WHERE id = ?', [row1[0]]);
  check('被编辑列已更新', after.rows[0][1] === 'paid' && after.rows[0][3] === '改过了');
  check('未编辑列原封不动（红线）', String(after.rows[0][2]) === '10.00', `amount=${after.rows[0][2]}`);

  // ---------- 7.5 V10 SQL 表达式模式（真库求值验证） ----------
  /**
   * 🔴 这一段只有真库能验：表达式必须被**服务端真求值**。
   *
   * 如果 `NOW()` 被当成字符串（走 ? 绑定或错误转义），MySQL 会把它塞进
   * datetime 列 → 得到 `'0000-00-00 00:00:00'`（或 strict mode 下直接报错），
   * 而单测只能断言"SQL 文本里有 NOW()"，**看不出它到底被求值了没有**。
   * 同理 `amount * 2` 若被转义成字符串，结果是 0 而不是翻倍。
   */
  console.log('\n【7.5】V10 SQL 表达式模式（真库求值）');
  /**
   * 🔴 整段跑在事务里并 ROLLBACK —— 表达式测试会真的改 amount/ts，
   *    而【11】筛选断言依赖 amount 的原始分布（踩过：amount 被改成 30.00 后
   *    `amount >= 30` 多命中一行，断言就红了）。测试之间不该共享脏数据。
   *    事务内自己能读到自己未提交的改动，所以「真求值」的断言依然成立。
   */
  await writeDriver.query('START TRANSACTION');
  const exprPlan = buildMutationPlan(db, order, {
    updates: [
      [
        /**
         * 🔴 oldValue 必须是该列的**真实当前值**，不能想当然填 null。
         *
         * 踩过：这里给 ts 传了 `oldValue: null` → 冲突检测生成 `AND \`ts\` IS NULL`，
         * 而该行 ts 的真值是 '2026-09-20 15:04:05.123456' → WHERE 匹配 0 行 →
         * affectedRows=0，表达式根本没被执行。真库断言才抓到（单测只看 SQL 文本，
         * 文本完全"正确"，看不出行没命中）。这正是冲突检测该有的行为，
         * 是测试数据错了，不是产品错了。
         *
         * row1 的列序来自【5】的 SELECT：id, status, amount, note, score, payload, big_no, ts
         */
        // 表达式值：原样嵌入，不占 ? 位
        { rowId: '1', locate: 'pk', column: 'ts', oldValue: row1[7], newValue: 'NOW(6)', valueKind: 'sql-expr', locateValues: [row1[0]] },
        // 列算术表达式
        { rowId: '1', locate: 'pk', column: 'amount', oldValue: row1[2], newValue: '`amount` * 3', valueKind: 'sql-expr', locateValues: [row1[0]] },
        // 同一行混一个字面量值：验证 ? 位与表达式不互相挤占
        { rowId: '1', locate: 'pk', column: 'note', oldValue: after.rows[0][3], newValue: '表达式混合', locateValues: [row1[0]] },
      ],
    ],
  });
  const exprSql = exprPlan.statements[0].sql;
  check('表达式原样嵌入 SET（不走 ? 占位）',
    exprSql.includes('`ts` = NOW(6)') && exprSql.includes('`amount` = `amount` * 3'), exprSql.slice(0, 120));
  check('字面量仍走 ? 绑定（表达式不改变既有防注入路径）',
    exprSql.includes('`note` = ?'), exprSql.slice(0, 160));
  // 🔴 参数位不错位：SET 段只有 note 一个占位 → params[0] 必须是它的值，
  //    其后才是 WHERE 的定位/冲突检测值。错位会静默产出错 SQL（最难查的 bug）
  check('🔴 params 与 ? 一一对应（表达式列不占参数位）',
    exprPlan.statements[0].params[0] === '表达式混合',
    JSON.stringify(exprPlan.statements[0].params).slice(0, 100));
  check('语句被标记为含表达式（预演弹窗据此显式告警）',
    exprPlan.statements[0].hasSqlExpr === true);

  const exprRes = await writeDriver.query(exprSql, exprPlan.statements[0].params);
  check('含表达式的 UPDATE 真库执行成功', exprRes.affectedRows === 1,
    `affectedRows=${exprRes.affectedRows}`);

  const exprAfter = await writeDriver.query(
    'SELECT id, ts, amount, note FROM `order` WHERE id = ?', [row1[0]],
  );
  const tsVal = String(exprAfter.rows[0][1] ?? '');
  const amountVal = String(exprAfter.rows[0][2] ?? '');
  // 🔴 真求值的铁证：ts 必须是"刚刚"的时间戳，不是 0000-00-00 / 空 / 'NOW(6)' 字面量
  const tsIsRealDatetime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(tsVal) && !tsVal.startsWith('0000-00-00');
  check('🔴 NOW(6) 被服务端真求值（datetime 落库为真实时间，不是字符串）',
    tsIsRealDatetime, `ts=${tsVal}`);
  const tsIsRecent = tsIsRealDatetime
    ? Math.abs(Date.now() - new Date(tsVal.replace(' ', 'T') + 'Z').getTime()) < 10 * 60 * 1000
    : false;
  check('🔴 NOW(6) 的值是当前时间（不是历史值/零值）', tsIsRecent, `ts=${tsVal}`);
  // amount 原值 10.00 → ×3 = 30.00；若表达式被当字符串，MySQL 会隐式转成 0
  check('🔴 `amount` * 3 被真求值（10.00 → 30.00，不是 0）', amountVal === '30.00', `amount=${amountVal}`);
  check('同行字面量值照常写入（表达式与字面量可混用）',
    exprAfter.rows[0][3] === '表达式混合', String(exprAfter.rows[0][3]));

  // INSERT 路径的表达式（追加行填 NOW()）
  const insExprPlan = buildMutationPlan(db, order, {
    inserts: [
      {
        tempId: '900',
        values: { status: 'new', amount: 1, score: 0, big_no: 1, ts: 'NOW(6)', note: null },
        valueKinds: { ts: 'sql-expr' },
      },
    ],
  });
  const insSql = insExprPlan.statements[0].sql;
  check('INSERT 的表达式原样进 VALUES', insSql.includes('NOW(6)') && !/'NOW\(6\)'/.test(insSql),
    insSql.slice(0, 140));
  const insRes = await writeDriver.query(insSql, insExprPlan.statements[0].params);
  check('含表达式的 INSERT 真库执行成功', insRes.affectedRows === 1, `insertId=${insRes.insertId}`);
  const insAfter = await writeDriver.query('SELECT ts FROM `order` WHERE id = ?', [insRes.insertId]);
  check('🔴 INSERT 的 NOW(6) 同样被真求值',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(insAfter.rows[0][0] ?? '')),
    `ts=${insAfter.rows[0][0]}`);

  // 回滚：amount/ts 的改动与新增行都不该泄漏给后续用例（【11】筛选依赖原始数据分布）
  await writeDriver.query('ROLLBACK');
  const rolledBack = await writeDriver.query('SELECT COUNT(*) AS n, MIN(amount) AS a FROM `order`');
  check('表达式测试的改动已回滚（不污染后续用例）',
    Number(rolledBack.rows[0][0]) === 3 && String(rolledBack.rows[0][1]) === '10.00',
    `行数=${rolledBack.rows[0][0]} minAmount=${rolledBack.rows[0][1]}`);

  // ---------- 8. 冲突检测 ----------
  console.log('\n【8】冲突检测');
  // 用一个已经不存在的原值去更新 → affectedRows=0
  const stale = buildMutationPlan(db, order, {
    updates: [
      [{ rowId: '1', locate: 'pk', column: 'status', oldValue: '不存在的旧值', newValue: 'x', locateValues: [row1[0]] }],
    ],
  });
  const conflictRes = await writeDriver.query(stale.statements[0].sql, stale.statements[0].params);
  const outcome = interpretResult(conflictRes.affectedRows);
  check('他人已改动 → 识别为冲突，不覆盖', outcome.kind === 'conflict', outcome.reason ?? '');

  // ---------- 9. 无键表被拒 ----------
  console.log('\n【9】无键表网格只读');
  const noKeyPlan = buildMutationPlan(db, noKey, {
    updates: [
      [{ rowId: 'x', locate: 'none', column: 'city', oldValue: 'a', newValue: 'b', locateValues: [] }],
    ],
  });
  check('无键表不生成任何写语句', noKeyPlan.statements.length === 0);
  check('无键表改动进 rejected 并说明原因', noKeyPlan.rejected[0]?.reason.includes('无主键/唯一键'));

  // ---------- 10. 取消（KILL QUERY） ----------
  console.log('\n【10】长查询取消');
  // ⚠️ 实测语义：MySQL 被 KILL 的查询，mysql2 是【resolve】而不是 reject
  // （原生验证：SLEEP(5) 在 305ms 返回 [["1"]]）。所以不能用"抛异常"判定取消成功，
  // 要判"提前返回"。
  const sleepSec = 10;
  const tSleep = Date.now();
  const slow = writeDriver.query(`SELECT SLEEP(${sleepSec})`);
  await new Promise((r) => setTimeout(r, 300));
  const cancelled = await writeDriver.cancel();
  await slow;
  const sleepElapsed = Date.now() - tSleep;
  check(
    'KILL QUERY 生效：慢查询被提前中断',
    cancelled && sleepElapsed < sleepSec * 1000,
    `${sleepElapsed}ms（未取消时应 ≥${sleepSec * 1000}ms）`,
  );

  // 取消后连接仍可用（这条比"是否抛异常"更重要：取消不该毁掉连接）
  // 注意 R10 下 mysql2 把 LONGLONG 值以字符串返回，所以比对 "1" 而非 1
  try {
    const alive = await writeDriver.query('SELECT 1 AS ok');
    check('取消后连接仍可用', String(alive.rows[0][0]) === '1', `返回 ${JSON.stringify(alive.rows[0])}`);
  } catch (e) {
    check('取消后连接仍可用', false, `[${e?.code ?? 'NO_CODE'}] ${e?.message ?? String(e)}`);
  }

  // ---------- 11. 筛选器生成的 WHERE 在真库上跑通 ----------
  // 单测只能证明"生成的字符串符合预期"，只有真执行才知道它是不是合法 SQL
  console.log('\n【11】筛选器 → 真库执行');
  try {
    const { buildWhere, operatorsForColumn } = await import('../packages/core-filter/src/index.js');
    const { buildOpenTableSql } = await import('../packages/core-driver-mysql/src/index.js');

    const model = {
      groups: [
        {
          id: 'g1',
          logic: 'AND',
          conditions: [
            { id: 'c1', column: 'status', operator: 'eq', value: 'paid', logic: 'AND' },
            { id: 'c2', column: 'amount', operator: 'gte', value: '30', logic: 'AND' },
          ],
        },
      ],
    };
    const built = buildWhere(model);
    check(
      'WHERE 生成为参数化形式（值不进 SQL）',
      built.sql.includes('?') && !built.sql.includes('paid'),
      built.sql,
    );

    // ⚠️ 参数顺序：WHERE 在 LIMIT 之前，所以 WHERE 参数必须排在 LIMIT 参数前面。
    // 反了会把 'paid' 喂给 LIMIT，报 "near ''30''" 这类语法错误。
    const sql = buildOpenTableSql({ database: db, table: 'order', where: built.sql, limit: 10 });
    const res = await writeDriver.query(sql.sql, [...built.params, ...sql.params]);
    check('带筛选的查询在真库执行成功', true, `返回 ${res.rows.length} 行`);
    check(
      '筛选结果确实被条件收敛（status=paid 且 amount>=30）',
      res.rows.length === 1 && String(res.rows[0][1]) === 'paid',
      JSON.stringify(res.rows[0] ?? null),
    );

    // 操作符按类型收窄：数值列不给"包含"
    check(
      '数值列不含"包含"操作符',
      !operatorsForColumn({ dataType: 'decimal(12,2)', name: 'amount' }).includes('contains'),
    );

    // 注入面：值里的引号与分号只当数据
    const evil = buildWhere({
      groups: [
        {
          id: 'g1',
          logic: 'AND',
          conditions: [{ id: 'c1', column: 'status', operator: 'eq', value: "x'; DROP TABLE `order`; --" }],
        },
      ],
    });
    const evilSql = buildOpenTableSql({ database: db, table: 'order', where: evil.sql, limit: 1 });
    const evilRes = await writeDriver.query(evilSql.sql, [...evil.params, ...evilSql.params]);
    const stillThere = await writeDriver.query('SELECT COUNT(*) AS n FROM `order`');
    check(
      '注入串只当数据处理，表未被删除',
      evilRes.rows.length === 0 && Number(stillThere.rows[0][0]) > 0,
      `命中 0 行，表仍存在 ${stillThere.rows[0][0]} 行`,
    );
  } catch (e) {
    check('筛选器真库执行', false, String(e?.message ?? e));
  }

  // ---------- 12. 粘贴计划 → 真库写入 ----------
  console.log('\n【12】粘贴 → 真库 INSERT');
  try {
    const { planPasteFromText, toMutationInput } = await import('../packages/core-clipboard/src/index.js');
    const { buildMutationPlan } = await import('../packages/core-mutation/src/index.js');

    // order 表有 score/big_no 两列 NOT NULL 且无默认值，粘一半列必然失败。
    // 建一张只有 3 列的表 —— 这正是真实场景：粘贴只写用户选中的列。
    await writeDriver.query(`
      CREATE TABLE paste_target (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        amount DECIMAL(12,2) NOT NULL
      )
    `);

    const pasteMeta = {
      name: 'paste_target',
      kind: 'table',
      comment: null,
      estimatedRows: 0,
      engine: 'InnoDB',
      collation: null,
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, comment: null, isPrimaryKey: true, isUnique: false, autoIncrement: true, charset: null, collation: null },
        { name: 'status', dataType: 'varchar(16)', nullable: false, defaultValue: null, comment: null, isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null },
        { name: 'amount', dataType: 'decimal(12,2)', nullable: false, defaultValue: null, comment: null, isPrimaryKey: false, isUnique: false, autoIncrement: false, charset: null, collation: null },
      ],
    };

    // 从已加载行末尾起粘贴一行 → 追加新行（startCol=1 跳过自增主键）
    const plan = planPasteFromText('clip_a\t12.50\n', {
      startRow: 0,
      startCol: 1,
      loadedRows: 0,
      columns: pasteMeta.columns,
      editable: true,
    });
    check('粘贴计划：越出行尾 → 追加新行', plan.appendedRows === 1 && plan.rejected === null, plan.summary);

    const input = toMutationInput(plan);
    check('追加行转成 INSERT 输入', input.inserts.length === 1, JSON.stringify(input.inserts[0]?.values));

    const pm = buildMutationPlan(db, pasteMeta, { inserts: input.inserts });
    check('INSERT 语句已生成', pm.statements.length === 1 && pm.statements[0].kind === 'insert', pm.statements[0]?.sql);

    const before = await writeDriver.query('SELECT COUNT(*) AS n FROM `paste_target`');
    for (const s of pm.statements) await writeDriver.query(s.sql, s.params);
    const after = await writeDriver.query('SELECT COUNT(*) AS n FROM `paste_target`');
    check(
      '真库 INSERT 成功（行数 +1）',
      Number(after.rows[0][0]) === Number(before.rows[0][0]) + 1,
      `${before.rows[0][0]} → ${after.rows[0][0]}`,
    );

    // R10 下 DECIMAL 保持字符串，比对 '12.50'
    const inserted = await writeDriver.query("SELECT status, amount FROM `paste_target` WHERE status = 'clip_a'");
    check(
      '粘贴的值原样落库（DECIMAL 保持字符串）',
      String(inserted.rows[0][0]) === 'clip_a' && String(inserted.rows[0][1]) === '12.50',
      JSON.stringify(inserted.rows[0]),
    );

    // 类型校验拦截：amount 塞非数值
    const bad = planPasteFromText('clip_b\tnot-a-number\n', {
      startRow: 0,
      startCol: 1,
      loadedRows: 0,
      columns: pasteMeta.columns,
      editable: true,
    });
    check(
      '类型不匹配被标出且不进入写入',
      bad.issues.length === 1 && bad.cells.every((c) => c.column !== 'amount'),
      bad.issues[0]?.reason,
    );

    // 无键表：粘贴必须整体被拒（B5 红线）
    const noKey = planPasteFromText('x\ty\n', {
      startRow: 0,
      startCol: 0,
      loadedRows: 1,
      columns: [
        { ...pasteMeta.columns[1], name: 'name' },
        { ...pasteMeta.columns[1], name: 'city' },
      ],
      editable: false,
    });
    check('无键表粘贴整体被拒', noKey.rejected !== null && noKey.cells.length === 0, noKey.rejected ?? '');
  } catch (e) {
    check('粘贴真库写入', false, String(e?.message ?? e));
  }

  await writeDriver.close();

  // ---------- 13. 清理 ----------
  console.log('\n【13】清理');
  const cleanup = new MySqlDriver(CRED, {});
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE \`${db}\``);
  await cleanup.close();
  check('临时库已清理', true, db);

  // ---------- SSL：TLS 真机握手（P2-1 接线后的真库断言） ----------
  console.log('\n【SSL】TLS 真机握手');
  /**
   * fixture（MySQL 8）自带 auto-generated 证书（have_ssl=YES）。
   * 三个断言构成证据链：
   *  1. 不带 ssl 选项 → 明文（Ssl_cipher 空）—— 证明下面的对比有意义
   *  2. 带 ssl{ca} → 握手成功且 Ssl_cipher 非空 —— mysql2 接受我们的 ssl 形状
   *  3. 带【被篡改的 CA】 → 连接必须被拒 —— rejectUnauthorized 校验真实生效（fail-closed）
   */
  try {
    const { execFileSync } = await import('node:child_process');
    const DOCKER = ['/Applications/Docker.app/Contents/Resources/bin/docker', 'docker'];
    let caPem = null;
    for (const bin of DOCKER) {
      try {
        caPem = execFileSync(bin, ['exec', 'dbstudio-mysql', 'cat', '/var/lib/mysql/ca.pem'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        break;
      } catch {
        /* 换下一个路径 */
      }
    }
    if (caPem && caPem.includes('BEGIN CERTIFICATE')) {
      // 基线：明文连接的 Ssl_cipher 为空
      const plain = new MySqlDriver(CRED, {});
      await plain.connect();
      const cipherPlain = await plain.query("SHOW STATUS LIKE 'Ssl_cipher'");
      await plain.close();
      check('基线：不带 ssl 走明文（cipher 空）', !cipherPlain.rows[0]?.[1], String(cipherPlain.rows[0]?.[1] ?? ''));

      // TLS 握手：ca 内容（不是路径！）传给 mysql2
      const tls = new MySqlDriver({ ...CRED, ssl: { ca: caPem, rejectUnauthorized: true } }, {});
      await tls.connect();
      const cipherTls = await tls.query("SHOW STATUS LIKE 'Ssl_cipher'");
      await tls.close();
      check('ssl{ca} 真机 TLS 握手成功（cipher 非空）', !!cipherTls.rows[0]?.[1], String(cipherTls.rows[0]?.[1] ?? ''));

      // fail-closed：篡改 CA 后必须拒连（替换 base64 体，保持 PEM 结构）
      const brokenCa = caPem.replace(/[A-Za-z0-9+/]{40}/g, (m, i) => (i % 2 ? 'AAAA' + m.slice(4) : m));
      let rejected = false;
      try {
        const bad = new MySqlDriver({ ...CRED, ssl: { ca: brokenCa, rejectUnauthorized: true } }, {});
        await bad.connect();
        await bad.close();
      } catch {
        rejected = true;
      }
      check('篡改 CA 后连接被拒（校验生效）', rejected, '');
    } else {
      check('⏭️ fixture 无 TLS 证书，跳过 SSL 真机断言', true, 'container 未就绪或无 docker CLI');
    }
  } catch (e) {
    check('SSL 真机段未抛异常', false, String(e?.message ?? e));
  }

  await driver.close();
} catch (e) {
  check('脚本执行未抛异常', false, String(e?.message ?? e));
  console.error(e);
} finally {
  try {
    if (driver) await driver.close();
  } catch {}
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`端到端冒烟：${results.length - failed.length}/${results.length} 通过，耗时 ${Date.now() - t0}ms`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('全部通过 ✅');
