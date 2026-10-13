#!/usr/bin/env node
/**
 * 脚本导入的**数据完整性**门禁（2026-10-13 新增）
 *
 * ## 为什么单独一个脚本
 *
 * 原有 `e2e-script-ui.mjs` 的脚本用例只有 **2 条 INSERT**，所以一个
 * 「50000 行只落 30~50 行」的缺陷能全绿通过 —— 小样本对这类缺陷没有分辨力。
 * 本脚本专测一件事：**脚本里的 INSERT 有多少行，库里就必须有多少行**。
 *
 * ## 覆盖的形态（都是用户真实脚本的形状）
 *  - CREATE TABLE + 连续 INSERT（触发 INSERT 合并路径）
 *  - 值里含逗号/括号/中文/单引号转义（切分逻辑最易崩的输入）
 *  - 反引号标识符里含空格与点
 *  - 大于合并阈值（500）以确认跨批不丢
 *  - 多个表交替（每次切表触发 flush）
 *
 * 用真 MySQL fixture + 真实 worker 逻辑（同一个 runtime.cjs，同一个分句器），
 * 只把 `conn` 换成真连接 —— 不是"照着实现再写一遍"。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(ROOT, 'x.js'));

// 🔴 与 worker 完全同一份实现（含修复），不是复刻
const {
  createStatementSplitter,
  parseInsertShape,
  canMergeWith,
  mergeTwoInsert,
  MERGED_INSERT_MAX_ROWS,
  MERGED_INSERT_MAX_BYTES,
} = require('@dbstudio/core-import');

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const CFG = {
  host: '127.0.0.1',
  port: Number(process.env.DB_STUDIO_E2E_PORT ?? 13306),
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
  multipleStatements: false,
};

/**
 * 跑一个脚本文件，返回实际落库行数。
 * 🔴 与 worker 的执行段同构（分句 → 合并 → 每 50 条一事务）。
 */
async function runScript(conn, filePath, targetDb, table) {
  const fs = await import('node:fs');
  const fd = fs.openSync(filePath, 'r');
  const dec = new TextDecoder('utf-8');
  let queue = [];
  const splitter = createStatementSplitter((sql) => queue.push(sql));

  let executed = 0;
  let failed = 0;
  let realAffected = 0;
  let sinceCommit = 0;
  let txOpen = false;
  let pending = null;
  const errors = [];

  const beginTx = async () => { if (!txOpen) { await conn.query('START TRANSACTION'); txOpen = true; } };
  const commitTx = async () => { if (txOpen) { await conn.query('COMMIT'); txOpen = false; } };
  const rollbackTx = async () => { if (txOpen) { try { await conn.query('ROLLBACK'); } catch {} txOpen = false; } };

  const flushMerged = async () => {
    if (!pending) return;
    const batch = pending;
    pending = null;
    try {
      const [res] = await conn.query(batch.sql);
      executed += batch.count;
      realAffected += res.affectedRows;
    } catch (e) {
      failed += batch.count;
      if (errors.length < 20) errors.push(String(e.message).slice(0, 140));
    }
  };

  const offerMerge = async (sql) => {
    const shape = parseInsertShape(sql);
    if (!shape.mergeable) return false;
    if (pending && !canMergeWith(pending.shape, shape)) await flushMerged();
    if (pending) {
      // 🔴 注意：shape **故意不更新** —— 这正是触发原缺陷的写法，
      // 合并函数必须对这种用法幂等（修复见 runtime.cjs 的 mergeTwoInsert）
      pending.sql = mergeTwoInsert(pending.sql, pending.shape, shape);
      pending.count++;
    } else {
      pending = { sql, count: 1, shape };
    }
    if (pending.count >= MERGED_INSERT_MAX_ROWS || pending.sql.length >= MERGED_INSERT_MAX_BYTES) {
      await flushMerged();
    }
    return true;
  };

  const handle = async (sql) => {
    try {
      await beginTx();
      sinceCommit++;
      const offer = await offerMerge(sql);
      if (offer === false) {
        await flushMerged();
        await conn.query(sql);
        executed++;
      }
      if (sinceCommit >= 50) {
        await flushMerged();
        await commitTx();
        sinceCommit = 0;
      }
    } catch (e) {
      await rollbackTx();
      sinceCommit = 0;
      failed++;
      if (errors.length < 20) errors.push(String(e.message).slice(0, 140));
    }
  };

  for (;;) {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) break;
    queue.length = 0;
    splitter.push(dec.decode(buf.subarray(0, n), { stream: true }));
    for (const sql of queue) await handle(sql);
  }
  splitter.push(dec.decode());
  queue.length = 0;
  splitter.flush();
  for (const sql of queue) await handle(sql);

  await flushMerged();
  await commitTx();
  fs.closeSync(fd);

  const [[row]] = await conn.query(
    'SELECT COUNT(*) n FROM `' + targetDb + '`.`' + table + '`',
  );
  return { rows: row.n, executed, failed, realAffected, errors };
}

const tmp = mkdtempSync(join(tmpdir(), 'dbstudio-scriptdata-'));
const conn = await mysql.createConnection(CFG);
const DB = 'e2e_scriptdata';

try {
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\``);

  // ---- 用例 1：50000 行连续 INSERT（用户报告的原始形态）----
  {
    const N = 50000;
    const lines = [
      `USE \`${DB}\`;`,
      `CREATE TABLE \`big\` (id INT PRIMARY KEY, v VARCHAR(64)) ENGINE=InnoDB;`,
    ];
    for (let i = 1; i <= N; i++) lines.push(`INSERT INTO \`big\` (id, v) VALUES (${i}, 'row_${i}');`);
    const f = join(tmp, 'big.sql');
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const r = await runScript(conn, f, DB, 'big');
    ok('🔴 50000 行连续 INSERT 完整落库', r.rows === N, `实际 ${r.rows} / 期望 ${N}`);
    // affectedRows 是 MySQL 亲口说的写入行数 —— 比"逻辑 executed"可靠得多
    ok('affectedRows 与实际行数一致', r.realAffected === N, `affectedRows=${r.realAffected}`);
    ok('无失败语句', r.failed === 0, `failed=${r.failed} ${r.errors[0] ?? ''}`);
  }

  // ---- 用例 2：值里含逗号/括号/中文/转义单引号（切分逻辑最易崩）----
  {
    const N = 2000;
    const lines = [
      `USE \`${DB}\`;`,
      `CREATE TABLE \`tricky\` (id INT PRIMARY KEY, v VARCHAR(128)) ENGINE=InnoDB;`,
    ];
    /**
     * ⚠️ 必须是**合法 MySQL 转义**：单引号写成 \\' 或 ''。
     * 这里用反斜杠转义（mysqldump 常见形态），值里同时含逗号、括号、中文、
     * 转义单引号与 VALUES 字面量 —— 专打合并切分逻辑的软肋。
     * （第一版这里直接写了裸单引号，SQL 本身非法 → 测的是"我的数据错"不是产品对错。）
     */
    const raw = "a,b)c'd中文VALUES ef";
    const v = raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    for (let i = 1; i <= N; i++) {
      lines.push(`INSERT INTO \`tricky\` (id, v) VALUES (${i}, '${v}');`);
    }
    const f = join(tmp, 'tricky.sql');
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const r = await runScript(conn, f, DB, 'tricky');
    ok('值含逗号/括号/转义引号 2000 行完整落库', r.rows === N,
      `实际 ${r.rows} / 期望 ${N} ${r.errors[0] ?? ''}`);
    // 数据保真：不能只是"行数对"，值本身也得原样
    const [[sample]] = await conn.query(
      `SELECT v FROM \`${DB}\`.\`tricky\` WHERE id = 1`,
    );
    ok('含特殊字符的值原样保真', sample.v === raw,
      `读回 ${JSON.stringify(sample.v)}`);
  }

  // ---- 用例 3：多表交替（每次切表触发 flush）+ 用例 3b：反引号标识符 ----
  {
    const per = 800;
    const lines = [`USE \`${DB}\`;`];
    const tables = ['t_1', '`odd name`', '`my.db`'];
    for (const t of tables) {
      lines.push(`CREATE TABLE ${t} (id INT PRIMARY KEY) ENGINE=InnoDB;`);
    }
    // 三张表交替 INSERT：每次从 A 切到 B 时 canMergeWith=false → 走 flush 路径
    for (let i = 1; i <= per; i++) {
      for (const t of tables) lines.push(`INSERT INTO ${t} (id) VALUES (${i});`);
    }
    const f = join(tmp, 'multi.sql');
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const r = await runScript(conn, f, DB, 't_1');
    // 一次执行，三张表都要完整 —— 切表时的 flush 最容易丢数据
    for (const t of tables) {
      const name = t.replace(/`/g, '');
      const [[row]] = await conn.query(
        `SELECT COUNT(*) n FROM \`${DB}\`.\`${name}\``,
      );
      ok(`多表交替（${name}）${per} 行完整落库`, row.n === per, `实际 ${row.n} / 期望 ${per}`);
    }
    ok('多表交替无失败语句', r.failed === 0, `failed=${r.failed} ${r.errors[0] ?? ''}`);
  }

  // ---- 用例 4：跨合并阈值（>500）不丢 ----
  {
    const N = 1234; // 非 500 整数倍，确保尾批也不丢
    const lines = [`USE \`${DB}\`;`, `CREATE TABLE \`cross\` (id INT PRIMARY KEY) ENGINE=InnoDB;`];
    for (let i = 1; i <= N; i++) lines.push(`INSERT INTO \`cross\` (id) VALUES (${i});`);
    const f = join(tmp, 'cross.sql');
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const r = await runScript(conn, f, DB, 'cross');
    ok('跨合并阈值（1234 行）不丢', r.rows === N, `实际 ${r.rows} / 期望 ${N}`);
  }
} finally {
  try { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``); } catch {}
  try { await conn.close(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);