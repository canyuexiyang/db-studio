/**
 * 0.8.0（P1-1 / #45）：对象生命周期入口的**真库回放**门禁。
 *
 * ## 为什么要有这个脚本（审计认定的第一风险）
 * 0.7.3 新增的 12 个对象生命周期入口（建库/删库/改名/复制表/五类对象模板/
 * 视图改定义/表维护），此前唯一的验收是 `scripts/e2e-ui.mjs` 里对 **demo 后端**
 * 的 SQL 预览文本断言。而 demo 后端 `mutationApply` 恒返回
 * `{ ok:true, committed:true, conflicts:[] }`（见 renderer/backend.ts），
 * 于是「点了按钮 → 出现预期的 SQL 文本」永远为真 —— **无法证伪**：
 * 就算 SQL 拼错、执行必失败，demo 断言也全绿。这正是项目最忌讳的「假绿」。
 *
 * ## 这个脚本怎么补
 *  1. **复用生产同款构造器**（import 自 `renderer/src/database/ddlTemplates.ts`）——
 *     绝不另写一套 SQL，否则测的不是产品真实发出的语句，又成假绿；
 *  2. 在 **fixture 真库**（MySQL @13306）上真实执行，回读 `information_schema` /
 *     `SHOW CREATE` 证明结构**真的变了**（不是只看返回 ok）；
 *  3. 每个入口配**反例断言**：错误输入（非法名 / 不存在的对象）必须失败，
 *     确认断言有证伪能力，不是恒真。
 *
 * ## 口径
 *  - 「前提不成立」（fixture 不在）→ 记 skipped，不算通过也不算失败（对齐
 *    e2e-smoke / e2e-conflict 的既有 skipped 机制，杜绝「跳过 = 通过」的假绿）；
 *  - 全部写操作在**一次性临时库**里做，finally 清理，绝不污染 fixture 的 bench/app_db。
 *
 * 运行：npm run e2e:ddl:real（前置：docker dbstudio-mysql 在 13306；没有就 skip）
 */

import { MySqlDriver } from '../packages/core-driver-mysql/src/index.js';
import {
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildRenameTableSql,
  buildCopyTableSql,
  buildMaintenanceSql,
  buildObjectTemplate,
  toCreateOrReplaceView,
} from '../apps/desktop/renderer/src/database/ddlTemplates.ts';

const CRED = {
  host: '127.0.0.1',
  port: Number(process.env.DB_STUDIO_E2E_PORT ?? 13306),
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const skipped = [];
function skip(name, reason = '') {
  skipped.push({ name, reason });
  console.log(`⏭️ ${name}${reason ? ` — ${reason}` : ''}`);
}

const t0 = Date.now();
const suffix = Date.now().toString(36);
const DB = `e2e_ddl_${suffix}`; // 一次性临时库
let admin = null;

/** fixture 可达性探测：连不上就整体 skip（造不出前提就别假装通过） */
async function fixtureAlive() {
  try {
    const d = new MySqlDriver({ ...CRED }, {});
    await d.connect();
    await d.query('SELECT 1');
    await d.close();
    return true;
  } catch {
    return false;
  }
}

/** 在临时库里建一张基准表，供改名/复制/维护/触发器复用 */
async function seedTable(driver) {
  await driver.query(
    `CREATE TABLE \`${DB}\`.\`src\` (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(32) NOT NULL,
       amount DECIMAL(10,2) NOT NULL DEFAULT 0
     ) ENGINE=InnoDB`,
  );
  await driver.query(`INSERT INTO \`${DB}\`.\`src\` (name, amount) VALUES ('a', 1.5), ('b', 2.5), ('c', 3.5)`);
}

/** 回读 information_schema：某库里是否存在某对象（表/视图/例程/触发器/事件） */
async function objectExists(driver, kind, name) {
  const tableMap = {
    table: `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='${name}' AND TABLE_TYPE='BASE TABLE'`,
    view: `SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='${name}'`,
    procedure: `SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='${DB}' AND ROUTINE_NAME='${name}' AND ROUTINE_TYPE='PROCEDURE'`,
    function: `SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='${DB}' AND ROUTINE_NAME='${name}' AND ROUTINE_TYPE='FUNCTION'`,
    trigger: `SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${DB}' AND TRIGGER_NAME='${name}'`,
    event: `SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${DB}' AND EVENT_NAME='${name}'`,
  };
  const sql = tableMap[kind];
  const r = await driver.query(sql);
  return Number(r.rows[0][0]) > 0;
}

/** 取某表的行数（复制表「结构+数据」验证用） */
async function rowCount(driver, table) {
  const r = await driver.query(`SELECT COUNT(*) FROM \`${DB}\`.\`${table}\``);
  return Number(r.rows[0][0]);
}

/** 执行一条 SQL，返回是否成功（用于反例断言：期望失败的语句） */
async function execExpectFail(driver, sql) {
  try {
    await driver.query(sql);
    return false; // 没抛 = 没失败 = 反例断言不成立
  } catch {
    return true;
  }
}

/**
 * 表维护命令（OPTIMIZE/ANALYZE/CHECK）对**不存在的表**不抛 SQL 异常，而是
 * 返回结果行 `Msg_type=Error, Msg_text=Table '…' doesn't exist`（实测 MySQL 8.0.46）。
 * 所以维护反例的判据不是「抛异常」，而是「返回行里出现 Error」。
 * 这正是「写断言前先问此刻基线是什么」—— 用 execExpectFail 会误判成通过。
 */
async function maintenanceReportsError(driver, sql) {
  try {
    const r = await driver.query(sql);
    return r.rows.some((row) => row.some((cell) => String(cell) === 'Error'));
  } catch {
    return true; // 某些命令对坏输入仍可能直接抛错，抛错也算「如实失败」
  }
}

try {
  if (!(await fixtureAlive())) {
    skip('对象生命周期真库回放', `fixture MySQL 未在 ${CRED.host}:${CRED.port} 监听`);
    console.log('   这不是「通过」。请先起 docker fixture（dbstudio-mysql，13306）再跑本门禁。');
  } else {
    admin = new MySqlDriver({ ...CRED }, {});
    await admin.connect();

    // 事件模板需要 event_scheduler=ON（fixture 已确认 ON）；不在则 event 入口 skip 而非红
    const es = await admin.query("SHOW VARIABLES LIKE 'event_scheduler'");
    const eventSchedulerOn = String(es.rows?.[0]?.[1] ?? '').toUpperCase() === 'ON';

    // ---------- 入口 1：新建数据库（buildCreateDatabaseSql）----------
    console.log('\n【1】新建数据库');
    const createDbSql = buildCreateDatabaseSql({
      name: DB,
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
    });
    await admin.query(createDbSql);
    const dbExists = await admin.query(
      `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${DB}'`,
    );
    check('建库：information_schema 里真的出现该库', Number(dbExists.rows[0][0]) === 1, createDbSql);
    // 反例：非法库名（含句点）必须被构造器当场拒绝
    let createDbRejected = false;
    try {
      buildCreateDatabaseSql({ name: 'bad.name', charset: 'utf8mb4' });
    } catch {
      createDbRejected = true;
    }
    check('建库反例：非法库名（含句点）被构造器拒绝', createDbRejected);

    // 之后的写操作都在临时库里做
    const driver = new MySqlDriver({ ...CRED, database: DB }, {});
    await driver.connect();

    try {
      await seedTable(driver);
      check('前置：基准表 src 已建且有 3 行', (await rowCount(driver, 'src')) === 3);

      // ---------- 入口 2：重命名表（buildRenameTableSql）----------
      console.log('\n【2】重命名表');
      const renameSql = buildRenameTableSql(DB, 'src', 'src_renamed');
      await driver.query(renameSql);
      check(
        '改名：新名存在、旧名消失（information_schema 回读）',
        (await objectExists(driver, 'table', 'src_renamed')) && !(await objectExists(driver, 'table', 'src')),
        renameSql,
      );
      // 反例：改名到已存在的表名必须失败（MySQL 报 Table already exists）
      check(
        '改名反例：目标名已存在时执行失败',
        await execExpectFail(driver, buildRenameTableSql(DB, 'src_renamed', 'src_renamed')),
      );
      await driver.query(buildRenameTableSql(DB, 'src_renamed', 'src')); // 改回，供后续复用

      // ---------- 入口 3：复制表·仅结构（buildCopyTableSql withData:false）----------
      console.log('\n【3】复制表（仅结构）');
      const copyStructSqls = buildCopyTableSql({
        database: DB,
        table: 'src',
        newTable: 'copy_struct',
        withData: false,
      });
      check('复制·仅结构：构造器只出 1 条 CREATE LIKE', copyStructSqls.length === 1, copyStructSqls.join(' | '));
      for (const s of copyStructSqls) await driver.query(s);
      check(
        '复制·仅结构：新表存在且 0 行（数据没被带过来）',
        (await objectExists(driver, 'table', 'copy_struct')) && (await rowCount(driver, 'copy_struct')) === 0,
      );

      // ---------- 入口 4：复制表·结构+数据（withData:true）----------
      console.log('\n【4】复制表（结构+数据）');
      const copyDataSqls = buildCopyTableSql({
        database: DB,
        table: 'src',
        newTable: 'copy_data',
        withData: true,
      });
      check('复制·含数据：构造器出 2 条（CREATE LIKE + INSERT SELECT）', copyDataSqls.length === 2, copyDataSqls.join(' | '));
      for (const s of copyDataSqls) await driver.query(s);
      check(
        '复制·含数据：新表存在且行数与源表一致（3 行）',
        (await objectExists(driver, 'table', 'copy_data')) && (await rowCount(driver, 'copy_data')) === 3,
      );

      // ---------- 入口 5-7：表维护三件套（buildMaintenanceSql）----------
      console.log('\n【5】表维护（优化 / 分析 / 检查）');
      for (const action of ['optimize', 'analyze', 'check']) {
        const sql = buildMaintenanceSql(DB, 'src', action);
        // 维护命令返回一张结果表（Msg_type/Msg_text），不抛异常即为服务端接受
        let ok = true;
        let detail = '';
        try {
          const r = await driver.query(sql);
          detail = `rows=${r.rows.length}`;
        } catch (e) {
          ok = false;
          detail = String(e?.message ?? e);
        }
        check(`维护·${action}：服务端接受并返回回执`, ok, `${sql} → ${detail}`);
      }
      // 反例：对不存在的表做维护，服务端如实返回 Error 行（不抛异常，见 maintenanceReportsError）
      check(
        '维护反例：对不存在的表返回 Error 行',
        await maintenanceReportsError(driver, buildMaintenanceSql(DB, 'no_such_table', 'optimize')),
      );

      // ---------- 入口 8：视图模板 + 视图改定义（buildObjectTemplate / toCreateOrReplaceView）----------
      console.log('\n【6】视图：模板新建 + 改定义');
      const viewTpl = buildObjectTemplate('view', DB, 'v_demo');
      // 模板带前置注释行；编辑器按 ; 切分后执行 —— 这里直接执行整段（mysql2 允许多语句需多条，
      // 但本模板注释 + 单条 CREATE，用一次 query 发送；注释行 mysql2 会忽略）
      await driver.query(viewTpl);
      check('视图·模板：information_schema.VIEWS 里出现 v_demo', await objectExists(driver, 'view', 'v_demo'), viewTpl.replace(/\n/g, ' '));
      // 取回 SHOW CREATE VIEW，用 toCreateOrReplaceView 改成可重复执行的定义并再次执行
      const showView = await driver.query(`SHOW CREATE VIEW \`${DB}\`.\`v_demo\``);
      const viewDdl = String(showView.rows[0][1] ?? '');
      const crv = toCreateOrReplaceView(viewDdl);
      check('视图·改定义：SHOW CREATE 原文可转成 CREATE OR REPLACE', typeof crv === 'string' && /CREATE OR REPLACE/i.test(crv ?? ''), (crv ?? 'null').slice(0, 60));
      let crvOk = true;
      try {
        // 去掉库前缀（`DB`.）后在当前库内执行；用 split/join 避免正则反引号转义地狱
        const prefixed = '`' + DB + '`.';
        if (crv) await driver.query(crv.split(prefixed).join(''));
      } catch (e) {
        crvOk = false;
      }
      check('视图·改定义：CREATE OR REPLACE 可重复执行不报错', crvOk);

      // ---------- 入口 9-12：过程 / 函数 / 触发器 / 事件模板（buildObjectTemplate）----------
      console.log('\n【7】存储过程 / 函数 / 触发器 / 事件模板');
      await driver.query(buildObjectTemplate('procedure', DB, 'p_demo'));
      check('过程·模板：ROUTINES 里出现 p_demo（PROCEDURE）', await objectExists(driver, 'procedure', 'p_demo'));

      await driver.query(buildObjectTemplate('function', DB, 'f_demo'));
      check('函数·模板：ROUTINES 里出现 f_demo（FUNCTION）', await objectExists(driver, 'function', 'f_demo'));

      // 触发器模板挂到 your_table —— 先建这张表（模板注释就要求用户换成真表）
      await driver.query(`CREATE TABLE \`${DB}\`.\`your_table\` (id INT, tick INT)`);
      await driver.query(buildObjectTemplate('trigger', DB, 't_demo'));
      check('触发器·模板：TRIGGERS 里出现 t_demo', await objectExists(driver, 'trigger', 't_demo'));

      if (eventSchedulerOn) {
        await driver.query(buildObjectTemplate('event', DB, 'e_demo'));
        check('事件·模板：EVENTS 里出现 e_demo', await objectExists(driver, 'event', 'e_demo'));
      } else {
        skip('事件·模板', 'event_scheduler 非 ON，无法建事件（fixture 未开）');
      }

      // 反例：模板对同名对象重复创建必须失败（CREATE 不带 OR REPLACE）
      check(
        '对象模板反例：重复创建同名视图执行失败',
        await execExpectFail(driver, buildObjectTemplate('view', DB, 'v_demo')),
      );

      // ---------- 入口 13：删除数据库（buildDropDatabaseSql）----------
      console.log('\n【8】删除数据库');
      const dropSql = buildDropDatabaseSql(DB);
      // 先断开库内连接再删（DROP DATABASE 需要没有活动 USE 该库的语句阻塞；这里直接 admin 执行）
      await driver.close();
      await admin.query(dropSql);
      const gone = await admin.query(
        `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${DB}'`,
      );
      check('删库：information_schema 里该库已消失', Number(gone.rows[0][0]) === 0, dropSql);
    } catch (e) {
      check('临时库内的对象生命周期回放未抛异常', false, String(e?.message ?? e));
      console.error(e);
    }
  }
} catch (e) {
  check('脚本执行未抛异常', false, String(e?.message ?? e));
  console.error(e);
} finally {
  // 兜底清理：临时库可能因中途失败残留（DROP IF EXISTS 幂等，重复删不报错）
  try {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
      await admin.close();
    }
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(
  `对象生命周期真库回放：${results.length - failed.length}/${results.length} 通过，${skipped.length} 跳过，耗时 ${Date.now() - t0}ms`,
);
if (skipped.length > 0) {
  console.log('\n跳过项（前提不成立，既不计通过也不计失败）：');
  for (const s of skipped) console.log(`  ⏭️ ${s.name}${s.reason ? ` — ${s.reason}` : ''}`);
}
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log(skipped.length > 0 ? '已执行断言全部通过（有跳过项，非全绿）✅' : '全部通过 ✅');
