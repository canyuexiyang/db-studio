#!/usr/bin/env tsx
/**
 * T10 / I28 / R15：真库并发冲突门禁。
 *
 * ## 为什么必须有这条门禁
 *
 * 「提交结果契约」这件事，单测只能证明「拿到 affectedRows=0 时我们会判定为冲突」——
 * 证明不了「MySQL 真的会返回 0」「回滚真的把前面的语句也撤了」。
 * 而 R15 的原始症状正是**部分成功被当成整体成功**，只有真库才能证伪。
 *
 * ## 覆盖
 *
 *  A. 单条 UPDATE 撞上「目标行被外部改过」→ outcome=conflict、整批回滚、行值不变
 *  B. 两条 UPDATE，第 2 条冲突 → 第 1 条（已执行）必须被回滚，值回到初始
 *  C. no-op UPDATE（把值设成与当前相同）→ **不能**误报冲突（依赖 CLIENT_FOUND_ROWS）
 *  D. 定位命中多行 → outcome=ambiguous、整批回滚
 *  E. DDL 入口（mode:'ddl'）允许 DROP；grid-write 入口拒绝 DROP
 *
 * 真库来源：与其它 e2e 同一 fixture（默认 127.0.0.1:13306）。
 * 环境变量：DB_STUDIO_E2E_PORT / DB_STUDIO_E2E_PWD
 *
 * 🔴 用的是**真实 SessionRegistry + 真实 mysql 驱动**（不是照着被测代码写的替身）——
 *    替身会照抄被测代码的假设，正是报告 §12.2 点名的失效模式。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

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
};

const DB = 'e2e_conflict_t10';
const TABLE = 't_conflict';

async function main() {
  // ---- 0. 前置：fixture 必须可达（造不出前置条件就别假装通过）----
  let admin;
  try {
    admin = await mysql.createConnection(CFG);
    await admin.query('SELECT 1');
  } catch (e) {
    console.error(`\n⚠️  跳过：fixture MySQL 不可达（${CFG.host}:${CFG.port}）—— ${e.message}`);
    console.error('   这不是「通过」。请先起 docker fixture（dbstudio-mysql，13306）再跑本门禁。');
    process.exit(1);
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'dbstudio-t10-'));
  const { SessionRegistry } = await import('../apps/desktop/src/main/session-registry.ts');
  const { SchemaCache } = await import('@dbstudio/core-schema-cache');
  const { defaultConnectionConfig } = await import('@dbstudio/core-connection');
  const { buildMutationPlan, interpretResult } = await import('@dbstudio/core-mutation');

  const registry = new SessionRegistry(new SchemaCache(userDataDir));
  const connId = 'c-t10';

  const cfg = {
    ...defaultConnectionConfig(),
    id: connId,
    name: 'fixture',
    host: CFG.host,
    port: CFG.port,
    user: CFG.user,
    database: DB,
  };

  const metaOf = () => ({
    name: TABLE,
    kind: 'table',
    columns: [
      { name: 'id', dataType: 'int', isPrimaryKey: true, autoIncrement: false, nullable: false },
      { name: 'v', dataType: 'varchar(20)', isPrimaryKey: false, autoIncrement: false, nullable: true },
      { name: 'w', dataType: 'varchar(20)', isPrimaryKey: false, autoIncrement: false, nullable: true },
    ],
  });

  const seed = async (rows) => {
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await admin.query(`CREATE DATABASE \`${DB}\``);
    await admin.query(`USE \`${DB}\``);
    await admin.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, v VARCHAR(20), w VARCHAR(20))`);
    for (const [id, v, w] of rows) {
      await admin.query(`INSERT INTO \`${TABLE}\` VALUES (?, ?, ?)`, [id, v, w]);
    }
  };

  const read = async (id) => {
    const [r] = await admin.query(`SELECT v, w FROM \`${DB}\`.\`${TABLE}\` WHERE id = ?`, [id]);
    return r[0] ?? null;
  };

  try {
    await registry.connect(cfg, CFG.password);
    await seed([[1, 'a', 'x'], [2, 'b', 'y']]);

    // ---------- A. 单条 UPDATE 撞并发改 ----------
    {
      await seed([[1, 'a', 'x']]);
      // 渲染层构造计划时，用户看到的是 v='a'
      const plan = buildMutationPlan(DB, metaOf(), {
        updates: [[{
          column: 'v', oldValue: 'a', newValue: 'mine', rowId: '0',
          locateValues: [1], locate: 'pk', valueKind: 'literal',
        }]],
      });
      ok('A1 计划生成 1 条 UPDATE 且带行身份 refId', plan.statements.length === 1 && plan.statements[0].refId === '0',
        `statements=${plan.statements.length} refId=${plan.statements[0]?.refId}`);

      // 并发：外部先把 v 改掉 → 原值比较条件不再匹配
      await admin.query(`UPDATE \`${DB}\`.\`${TABLE}\` SET v='other' WHERE id=1`);

      const r = await registry.applyMutation(connId, DB, plan.statements.map((s) => ({
        sql: s.sql, params: s.params, expect: 'one', kind: s.kind,
      })));

      const after = await read(1);
      ok('A2 冲突被识别为 conflict（不是「影响 0 行」的成功）', r.outcome === 'conflict', `outcome=${r.outcome}`);
      ok('A3 committed=false 且 affected=0', r.committed === false && r.affected === 0,
        `committed=${r.committed} affected=${r.affected}`);
      ok('A4 冲突明细带实际行数与原因', r.conflicts.length === 1 && r.conflicts[0].actual === 0 && !!r.conflicts[0].reason,
        JSON.stringify(r.conflicts[0] ?? null));
      ok('A5 用户的改动**没有**落库（仍是外部改的那份）', after?.v === 'other', `v=${after?.v}`);
      ok('A6 interpretResult 口径与实际一致', interpretResult(0).kind === 'conflict');
    }

    // ---------- B. 两语句部分冲突 → 整批回滚 ----------
    {
      await seed([[1, 'a', 'x'], [2, 'b', 'y']]);
      const plan = buildMutationPlan(DB, metaOf(), {
        updates: [
          [{ column: 'v', oldValue: 'a', newValue: 'A2', rowId: '0', locateValues: [1], locate: 'pk', valueKind: 'literal' }],
          [{ column: 'v', oldValue: 'b', newValue: 'B2', rowId: '1', locateValues: [2], locate: 'pk', valueKind: 'literal' }],
        ],
      });
      ok('B1 计划生成 2 条 UPDATE', plan.statements.length === 2, `statements=${plan.statements.length}`);

      // 只让第 2 行的原值失配
      await admin.query(`UPDATE \`${DB}\`.\`${TABLE}\` SET v='moved' WHERE id=2`);

      const r = await registry.applyMutation(connId, DB, plan.statements.map((s) => ({
        sql: s.sql, params: s.params, expect: 'one', kind: s.kind,
      })));

      const row1 = await read(1);
      const row2 = await read(2);
      ok('B2 判定为 conflict', r.outcome === 'conflict', `outcome=${r.outcome}`);
      ok('B3 冲突在语句 #2（后一条）', r.conflicts[0]?.index === 1, `index=${r.conflicts[0]?.index}`);
      ok('B4 冲突前已执行 1 条（该条也必须被回滚）', r.conflicts[0]?.executedBefore === 1,
        `executedBefore=${r.conflicts[0]?.executedBefore}`);
      ok('🔴 B5 第 1 条已执行的 UPDATE 被回滚（v 仍是 a）', row1?.v === 'a', `v=${row1?.v}`);
      ok('B6 第 2 条未生效（v 仍是外部改的 moved）', row2?.v === 'moved', `v=${row2?.v}`);
    }

    // ---------- C. no-op UPDATE 不能误报冲突 ----------
    {
      await seed([[1, 'a', 'x']]);
      const plan = buildMutationPlan(DB, metaOf(), {
        updates: [[{
          column: 'v', oldValue: 'a', newValue: 'a', rowId: '0',
          locateValues: [1], locate: 'pk', valueKind: 'literal',
        }]],
      });
      const r = await registry.applyMutation(connId, DB, plan.statements.map((s) => ({
        sql: s.sql, params: s.params, expect: 'one', kind: s.kind,
      })));
      ok('🔴 C1 值未变化的 UPDATE 不误报冲突（CLIENT_FOUND_ROWS 语义）',
        r.outcome === 'ok' && r.committed === true, `outcome=${r.outcome} affected=${r.affected}`);
    }

    // ---------- D. 定位命中多行 → ambiguous ----------
    {
      await seed([[1, 'a', 'x'], [2, 'b', 'y']]);
      // 手工构造一条「WHERE 会命中 2 行」的 update（模拟定位缺陷，而不是用户能造出的输入）
      await admin.query('START TRANSACTION');
      const r = await registry.applyMutation(connId, DB, [{
        sql: 'UPDATE `t_conflict` SET v = ? WHERE w IS NOT NULL',
        params: ['z'], expect: 'one', kind: 'update',
      }]);
      await admin.query('ROLLBACK');
      const rows = await admin.query(`SELECT v FROM \`${DB}\`.\`${TABLE}\` ORDER BY id`);
      ok('D1 命中多行判定为 ambiguous', r.outcome === 'ambiguous', `outcome=${r.outcome} actual=${r.conflicts[0]?.actual}`);
      ok('D2 多行命中未落库（整批回滚）', rows[0].map((x) => x.v).join(',') === 'a,b',
        rows[0].map((x) => x.v).join(','));
    }

    // ---------- E. DDL 入口 ----------
    {
      await seed([[1, 'a', 'x']]);
      await admin.query(`CREATE TABLE \`${DB}\`.\`tmp_drop_me\` (x INT)`);
      const okDrop = await registry.applyMutation(
        connId,
        DB,
        [{ sql: 'DROP TABLE `tmp_drop_me`', params: [], expect: 'any' }],
        'ddl',
      );
      const [exists] = await admin.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='tmp_drop_me'`,
        [DB],
      );
      ok('E1 mode:ddl 允许 DROP TABLE（v0.6.1 曾被表达式白名单误拒）',
        okDrop.committed === true && exists[0].n === 0, `n=${exists[0].n}`);

      let rejected = false;
      let msg = '';
      try {
        await registry.applyMutation(connId, DB, [{ sql: 'DROP TABLE `t_conflict`', params: [] }]);
      } catch (e) {
        rejected = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      const still = await read(1);
      ok('🔴 E2 grid-write 入口仍拒绝 DDL（表达式防线没为 DDL 开口子）', rejected && still?.v === 'a', msg.slice(0, 80));
    }
  } finally {
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
      await admin.end();
      await registry.disconnect(connId);
    } catch { /* 清理尽力而为 */ }
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? '✅' : '❌'} T10 并发冲突门禁：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：\n' + failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('门禁自身异常：', e);
  process.exit(1);
});
