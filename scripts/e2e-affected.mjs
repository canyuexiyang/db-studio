/**
 * 真机验证：非 SELECT 语句的「影响行数」口径（0.7.1 需求 1）
 *
 * ## 为什么单测不够
 *
 * 单测里的驱动是替身，它「照我们的假设返回 affectedRows」。而这条需求真正的风险
 * 恰恰是 **MySQL 的语义**：
 *   - `affectedRows` 是 **changed** 而不是 **matched**（`UPDATE SET x = x` 返回 0）
 *   - matched 只在 `OkPacket.info` 里（"Rows matched: 3  Changed: 0"）
 * 替身永远不会告诉我们这件事 —— 只有真库会。
 *
 * 所以这里跑**真驱动 + 真 MySQL + 真 SessionRegistry**，一路断到**渲染层的文案函数**：
 *   session.runQuery() → QueryOutcome 字段 → describeRunResult() 文案
 * 三个环节都必须对，中间断了任何一环用户看到的还是「0 行」。
 *
 * ## 覆盖的形态
 *  SELECT / UPDATE 全命中 / UPDATE 值未变（关键反例）/ UPDATE 命中 0 行 /
 *  INSERT / DELETE / DDL
 *
 * 运行：npm run e2e:affected
 * 前置：docker dbstudio-mysql 在 13306 监听；没有就跳过（不算失败）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import { SessionRegistry, realDriverFactory } from '../apps/desktop/src/main/session-registry.js';
import { SchemaCache } from '../packages/core-schema-cache/src/index.js';
import { defaultConnectionConfig } from '../packages/core-connection/src/index.js';
import { describeRunResult, parseMatchedRows, parseChangedRows } from '../apps/desktop/renderer/src/editor/resultMessage.js';

const FIXTURE = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

/** 专用库：跑完就删，不污染 fixture 的 bench / app_db */
const DB = 'dbstudio_e2e_affected';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 把 QueryOutcome 直接喂给渲染层文案函数 —— 这条链就是 UI 上看到的那句话 */
function textOf(out) {
  return out.cancelled
    ? describeRunResult({
        statementKind: out.statementKind,
        rowCount: out.rowCount,
        affectedRows: out.affectedRows,
        insertId: out.insertId,
        info: out.info,
        warnings: out.warnings,
        cancelled: true,
        elapsedMs: out.elapsedMs,
      })
    : describeRunResult({
        statementKind: out.statementKind,
        rowCount: out.rowCount,
        affectedRows: out.affectedRows,
        insertId: out.insertId,
        info: out.info,
        warnings: out.warnings,
        cancelled: false,
        elapsedMs: out.elapsedMs,
      });
}

// ---------- 依赖检查：fixture 不在就跳过，不算失败 ----------
async function fixtureAlive() {
  try {
    return await new Promise((resolve) => {
      const s = createConnection({ host: FIXTURE.host, port: FIXTURE.port });
      s.setTimeout(2000);
      s.on('connect', () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
      s.on('timeout', () => (s.destroy(), resolve(false)));
    });
  } catch {
    return false;
  }
}

if (!(await fixtureAlive())) {
  console.log(`⏭️  跳过影响行数真机验证：fixture MySQL 未在 ${FIXTURE.host}:${FIXTURE.port} 监听`);
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-affected-'));
const cache = new SchemaCache(workDir);
const t0 = Date.now();

try {
  const reg = new SessionRegistry(cache, realDriverFactory);
  const cfg = defaultConnectionConfig({
    id: 'e2e-affected',
    name: 'e2e affected rows',
    host: FIXTURE.host,
    port: FIXTURE.port,
    user: FIXTURE.user,
  });

  const conn = await reg.connect(cfg, FIXTURE.password);
  check('前置：连接 fixture 成功', reg.stateOf(cfg.id) === 'connected' && !!conn.serverVersion, conn.serverVersion ?? '');

  // ---------- 建一张可控的小表 ----------
  await reg.runQuery(cfg.id, `DROP DATABASE IF EXISTS \`${DB}\``);
  await reg.runQuery(cfg.id, `CREATE DATABASE \`${DB}\``);
  const created = await reg.runQuery(
    cfg.id,
    `CREATE TABLE \`${DB}\`.t (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(32) NULL)`,
  );
  check('DDL：statementKind=ddl，文案是「执行成功」且不含行数', created.statementKind === 'ddl'
    && textOf(created).title === '执行成功'
    && !/\d+\s*行/.test(textOf(created).headline), `title=${textOf(created).title}`);

  await reg.runQuery(cfg.id, `INSERT INTO \`${DB}\`.t (v) VALUES (NULL), (NULL), (NULL)`);

  // =====================================================================
  console.log('\n【A】SELECT：行数与影响行数同源');
  // =====================================================================
  const sel = await reg.runQuery(cfg.id, `SELECT * FROM \`${DB}\`.t`);
  check('A1 SELECT statementKind=select，rowCount=3', sel.statementKind === 'select' && sel.rowCount === 3,
    `kind=${sel.statementKind} rowCount=${sel.rowCount}`);
  check('A2 SELECT 的 affectedRows 跟随行数（不是 0）', sel.affectedRows === 3, `affectedRows=${sel.affectedRows}`);
  check('A3 文案是「返回 3 行」', textOf(sel).title === '返回 3 行', `title=${textOf(sel).title}`);

  const selEmpty = await reg.runQuery(cfg.id, `SELECT * FROM \`${DB}\`.t WHERE id = 999999`);
  check('A4 空结果集仍说「返回 0 行」（这是 0 行的正确用法）', textOf(selEmpty).title === '返回 0 行',
    `title=${textOf(selEmpty).title}`);

  // =====================================================================
  console.log('\n【B】UPDATE：changed vs matched（本需求最容易做错的地方）');
  // =====================================================================
  const up1 = await reg.runQuery(cfg.id, `UPDATE \`${DB}\`.t SET v = 'x' WHERE v IS NULL`);
  const t1 = textOf(up1);
  check('B1 命中 3 行全部变化：affectedRows=3', up1.affectedRows === 3, `affectedRows=${up1.affectedRows}`);
  check('B2 statementKind=update', up1.statementKind === 'update', `kind=${up1.statementKind}`);
  check('B3 文案是「已修改 3 行」而不是「返回 0 行」', t1.title === '已修改 3 行', `title=${t1.title}`);
  check('B4 已修改 3 行时不该出现「返回」二字', !t1.headline.includes('返回'), `headline=${t1.headline}`);

  // 🔴 关键反例：值没变 → 真实变更数是 0，但 affectedRows（matched）仍是 3
  //
  // ⚠️ 这里的 WHERE 必须写 `v = 'x'`（上一句刚把 NULL 改成 'x'，所以现在匹配 3 行、
  //    但再改成 'x' 值不变）。早先误写成 `WHERE v IS NULL`——那句已经匹配 0 行了，
  //    matched 当然是 0，断言「匹配 3 行」会假红。这个场景只有真库跑得出来。
  //
  // 🔴 2026-10-27 真库探针得出的关键事实：mysql2 默认带 CLIENT_FOUND_ROWS，
  //    所以 affectedRows = **matched**（不是 changed）。真实变更数在 info 的 Changed 里。
  //    因此这一段的期望是 affectedRows=3、changed=0 —— 如果哪天实现退回「用 affectedRows
  //    当已修改行数」，B7 的文案会变成「已修改 3 行」，这里立刻红。
  const up2 = await reg.runQuery(cfg.id, `UPDATE \`${DB}\`.t SET v = 'x' WHERE v = 'x'`);
  const t2 = textOf(up2);
  check('B5 值未变化时 affectedRows 是 matched=3（不是 0）', up2.affectedRows === 3,
    `affectedRows=${up2.affectedRows}`);
  check('B6 info 里 matched=3 且 Changed=0', parseMatchedRows(up2.info) === 3 && parseChangedRows(up2.info) === 0,
    `info=${up2.info ?? 'null'}`);
  check('B7 文案必须是「已修改 0 行 · 匹配 3 行 · 值未变化」', t2.headline === '已修改 0 行 · 匹配 3 行 · 值未变化',
    `headline=${t2.headline}`);

  const up3 = await reg.runQuery(cfg.id, `UPDATE \`${DB}\`.t SET v = 'y' WHERE id = 999999`);
  const t3 = textOf(up3);
  check('B8 一行都没匹配到：只说「已修改 0 行」，不给迷惑的匹配次信息',
    t3.title === '已修改 0 行' && t3.detail === null, `headline=${t3.headline}`);

  // =====================================================================
  console.log('\n【C】INSERT / DELETE');
  // =====================================================================
  const ins = await reg.runQuery(cfg.id, `INSERT INTO \`${DB}\`.t (v) VALUES ('ok')`);
  const ti = textOf(ins);
  check('C1 INSERT affectedRows=1 且有自增值', ins.affectedRows === 1 && ins.insertId !== null,
    `affectedRows=${ins.affectedRows} insertId=${ins.insertId}`);
  check('C2 文案是「已插入 1 行」', ti.title === '已插入 1 行', `title=${ti.title}`);
  check('C3 次信息带自增起始值', (ti.detail ?? '').includes('自增 ID 起始'), `detail=${ti.detail ?? 'null'}`);

  const del = await reg.runQuery(cfg.id, `DELETE FROM \`${DB}\`.t WHERE v = 'x'`);
  const td = textOf(del);
  check('C4 DELETE affectedRows=3', del.affectedRows === 3, `affectedRows=${del.affectedRows}`);
  check('C5 文案是「已删除 3 行」', td.title === '已删除 3 行', `title=${td.title}`);

  // =====================================================================
  console.log('\n【D】DDL 与判不出类型');
  // =====================================================================
  // 临时表也必须带库限定：这个连接没有默认库（未指定 database），
  // 裸表名会报 "No database selected"（真机踩过）
  const tmp = await reg.runQuery(cfg.id, `CREATE TEMPORARY TABLE \`${DB}\`.tmp_e2e (id INT)`);
  check('D1 CREATE TEMPORARY：ddl 且文案「执行成功」（绝不出现 0 行）',
    tmp.statementKind === 'ddl' && textOf(tmp).title === '执行成功', `kind=${tmp.statementKind}`);

  const setStmt = await reg.runQuery(cfg.id, "SET @x = 1");
  check('D2 SET：落 other（中文案「执行完成」），不冒充结果集',
    setStmt.statementKind === 'other' && textOf(setStmt).title === '执行完成', `kind=${setStmt.statementKind}`);

  // ---------- 收尾 ----------
  await reg.runQuery(cfg.id, `DROP DATABASE IF EXISTS \`${DB}\``);
  await reg.closeAll();
} catch (e) {
  check('未捕获异常', false, e instanceof Error ? `${e.message}` : String(e));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 影响行数真机验证：${results.length - failed.length}/${results.length} 通过（${Date.now() - t0}ms）`,
);
process.exit(failed.length === 0 ? 0 : 1);
