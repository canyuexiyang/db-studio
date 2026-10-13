'use strict';
/**
 * SQL 脚本执行 worker —— utilityProcess 里跑（运行 SQL 脚本，PRD §6.6 场景扩展）。
 *
 * 用户场景：删掉库下所有表后，导入一份包含「建表 + 数据」的完整 .sql 脚本
 * （mysqldump / Navicat「运行 SQL 文件」同款链路）。
 *
 * 协议（与 import-worker 同族）：
 *   主进程 postMessage（首条）：
 *     { jobId, filePath, encoding: 'utf8'|'gbk', onError: 'stop'|'continue',
 *       connection: {host,port,user,password,database} }
 *   worker → 主进程 → 渲染层（event:script）：
 *     { type:'scan',     jobId, stats }        —— 扫描完成，等用户确认（摘要 = 语句数/类型分布/危险检出）
 *     { type:'progress', jobId, executed, total, elapsedMs, currentSql }
 *     { type:'done',     jobId, executed, failed, elapsedMs, errors }
 *     { type:'error',    jobId, message }
 *
 * 🔴 两遍读取的设计：scan 阶段只统计不执行，用户看过摘要（语句数 / DDL·DML
 *    分布 / 是否检出 DROP DATABASE）确认后再执行 —— 「写操作先展示原文」红线
 *    在脚本场景的落地形态（脚本逐条预览不现实，摘要确认 + 原文文件已由用户自选）。
 *    代价是文件读两遍（流式解析很快，IO 顺序读便宜），换来内存有界 + 确认可信。
 *
 * 🔴 取消 = 主进程 kill 本进程，真取消。已执行的语句不回滚（D3 语义，
 *    向导 UI 明确提示）；正在执行的单条语句随进程死亡被 MySQL 断连中止。
 */

const parentPort = process.parentPort;

function send(msg) {
  try {
    parentPort.postMessage(msg);
  } catch {}
}

/** 单块读取大小：256KB 足够让解析开销摊薄，内存有界 */
const READ_CHUNK = 256 * 1024;
/** 错误明细上限（与导入 worker 的 invalidDetail 上限同思路） */
const MAX_ERRORS = 100;
/** 进度推送节流：每 150ms 或每 20 条语句发一次 */
const PROGRESS_INTERVAL_MS = 150;
const PROGRESS_EVERY_N = 20;

/** 当前语句预览截断长度（进度/错误明细展示用） */
function preview(sql, max = 200) {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 打开文件 + 按编码流式解码。utf8 的 BOM 由 TextDecoder 自动剥除 */
function openReader(filePath, encoding) {
  const fs = require('node:fs');
  let dec;
  try {
    dec = new TextDecoder(encoding === 'gbk' ? 'gbk' : 'utf-8');
  } catch {
    throw new Error('当前运行环境不支持所选编码：' + encoding);
  }
  const fd = fs.openSync(filePath, 'r');
  return {
    /** 读一块并解码；EOF 返回 null（flush 残余由 flushStep 处理） */
    next() {
      const buf = Buffer.alloc(READ_CHUNK);
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        throw new Error('读取脚本文件失败：' + String((e && e.message) || e));
      }
      if (n <= 0) return null;
      return dec.decode(buf.subarray(0, n), { stream: true });
    },
    /** EOF 后取解码器残余（多字节字符/状态收尾） */
    flushStep() {
      return dec.decode();
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {}
    },
  };
}

async function main() {
  const job = await new Promise((resolve) => {
    parentPort.once('message', (e) => resolve(e.data));
  });
  const { jobId, filePath, encoding, onError, connection } = job;

  const fs = require('node:fs');
  const startedAt = Date.now();
  const fileBytes = fs.statSync(filePath).size;

  // ---- 语句源：读文件 → 分割器 → 逐条产出。scan 与 execute 共用这一套 ----
  const { createStatementSplitter, classifyScriptStatement } = require('@dbstudio/core-import');

  /**
   * 流式遍历全部语句。onStatement 返回 Promise 时逐条 await（执行阶段），
   * 返回 undefined 时纯同步统计（扫描阶段）—— 内存始终只有「一条未完结语句」。
   * handle 返回 {stop:true} 时停止遍历（停止模式的「失败即止」）。
   */
  async function forEachStatement(handle) {
    const reader = openReader(filePath, encoding);
    try {
      let pending = [];
      const splitter = createStatementSplitter((sql, line) => pending.push([sql, line]));
      for (;;) {
        const text = reader.next();
        if (text === null) break;
        pending.length = 0;
        splitter.push(text);
        for (const [sql, line] of pending) {
          const r = await handle(sql, line);
          if (r && r.stop) return;
        }
      }
      splitter.push(reader.flushStep());
      pending.length = 0;
      splitter.flush();
      for (const [sql, line] of pending) {
        const r = await handle(sql, line);
        if (r && r.stop) return;
      }
    } finally {
      reader.close();
    }
  }

  // ---- 阶段 1：扫描统计（不执行） ----
  const stats = {
    statements: 0,
    ddl: 0,
    dml: 0,
    session: 0,
    other: 0,
    hasDropDatabase: false,
    hasDelimiter: false,
    fileBytes,
  };
  try {
    await forEachStatement((sql) => {
      const cls = classifyScriptStatement(sql);
      if (cls === 'drop-db') {
        stats.hasDropDatabase = true;
        stats.ddl++;
      } else if (cls === 'ddl') stats.ddl++;
      else if (cls === 'dml') stats.dml++;
      else if (cls === 'session') stats.session++;
      else stats.other++;
      stats.statements++;
      if (stats.statements > 5_000_000) throw new Error('脚本语句数超过 500 万，疑似异常文件，已中止');
    });
  } catch (e) {
    send({ type: 'error', jobId, message: String((e && e.message) || e) });
    return;
  }

  send({ type: 'scan', jobId, stats });

  // ---- 等待用户确认（主进程转发渲染层的决定）----
  const go = await new Promise((resolve) => {
    parentPort.once('message', (e) => resolve(!!(e.data && e.data.type === 'execute')));
  });
  if (!go) return; // 用户取消：主进程会 kill；这里兜底静默退出

  // ---- 阶段 2：建连执行 ----
  let mysql2;
  try {
    mysql2 = require('mysql2/promise');
  } catch (e) {
    send({ type: 'error', jobId, message: 'worker 无法加载 mysql2：' + String(e && e.message) });
    return;
  }

  let conn;
  try {
    conn = await mysql2.createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password ?? '',
      database: connection.database,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      timezone: 'local',
      jsonStrings: true,
      // 🔴 逐条执行（multipleStatements: false）—— 一条语句一问一答，
      //    进度/错误定位/取消语义都靠它；批量拼接会让错误行号失去意义
      multipleStatements: false,
      rowsAsArray: true,
    });
  } catch (e) {
    send({ type: 'error', jobId, message: '脚本执行建连失败：' + String((e && e.message) || e) });
    return;
  }

  let executed = 0;
  let failed = 0;
  /** MySQL 实际写入行数（affectedRows 之和）—— 用于与 executed 做一致性核对 */
  let affectedRows = 0;
  const errors = [];
  let lastPushAt = 0;
  /** 停止模式下的中止原因 —— 只在遍历自然结束后统一发一次 done，避免双 done 覆盖 */
  let abortInfo = null;

  function pushProgress(force) {
    const now = Date.now();
    if (!force && now - lastPushAt < PROGRESS_INTERVAL_MS) return;
    lastPushAt = now;
    send({
      type: 'progress',
      jobId,
      executed,
      total: stats.statements,
      elapsedMs: now - startedAt,
    });
  }

  /**
   * v0.6.0 性能：两个优化，都作用在"每条语句一次 fsync"这个真根因上。
   *
   * 实测基线（2026-09-30，MySQL 8.0.46 最严 durability）：
   * 单条 0.475ms 里 fsync 占 0.208ms = **61%**。3000 条要 1425ms。
   *   加事务（每 50 条一事务）→ 515ms（2.8x）
   *   合并连续 INSERT → 160ms（8.9x）
   *   两者叠加 → 143ms（**10x**）
   *
   * 🟢 为什么是「每 50 条一事务」而不是全局单事务：
   *   全局单事务一旦中途失败，100 万条全部回滚 —— 半小时的活儿白干，
   *   而且与 D3「已执行不回滚」的既有语义直接冲突。
   *   分段事务把这个风险窗口压到 50 条，量级上完全可接受。
   */
  const TX_BATCH = 50;
  let txOpen = false;
  async function beginTx() {
    if (txOpen) return;
    await conn.query('START TRANSACTION');
    txOpen = true;
  }
  async function commitTx() {
    if (!txOpen) return;
    await conn.query('COMMIT');
    txOpen = false;
  }
  async function rollbackTx() {
    if (!txOpen) return;
    try {
      await conn.query('ROLLBACK');
    } catch {
      // 回滚失败（连接已断）—— 记在下面的 failed 里，不掩盖原始错误
    }
    txOpen = false;
  }

  /**
   * 连续 INSERT 的合并缓冲。
   *
   * flush 条件（任一满足就发出去）：攒够 MERGED_INSERT_MAX_ROWS 条 /
   * 攒出的 SQL 超过 MERGED_INSERT_MAX_BYTES / 遇到不可合并的语句 / 遍历结束。
   *
   * 🔴 失败语义：一批里 N 条合并成1 条执行，若这 1 条失败，
   *    **按 N 条计失败**（用户看到的是"N 条语句出错"），
   *    否则进度与最终计数会和实际脱节，用户以为全成了。
   *    停止模式下同样按 N 条中止 —— 语义与逐条执行完全一致。
   *
   * 🔴 worker 不经 vite 构建，require('@dbstudio/core-import') 走 package.json 的
   *    main 拿到 runtime.cjs —— 合并逻辑的实现源就在那里（TS 侧只是类型出口）。
   */
  const {
    parseInsertShape,
    canMergeWith,
    mergeTwoInsert,
    MERGED_INSERT_MAX_ROWS,
    MERGED_INSERT_MAX_BYTES,
  } = require('@dbstudio/core-import');

  /** @type {{sql: string, count: number, shape: any}|null} */
  let pending = null;

  /** 把待合并的一批真正发出去。返回 {ok, msg} */
  async function flushMerged() {
    if (!pending) return { ok: true, msg: null };
    const batch = pending;
    pending = null;
    try {
      const [res] = await conn.query(batch.sql);
      executed += batch.count;
      /**
       * 🔴 采集 MySQL **亲口说的**写入行数（affectedRows）。
       *
       * 为什么必须采：`executed` 是「我们认为自己发了多少条」，
       * 而 affectedRows 是「数据库真的写进去多少行」。
       * 2026-10-13那个数据丢失缺陷正是二者背离：
       * executed=50004 / failed=0，但 affectedRows 只有 2002 ——
       * UI 只展示 executed，于是「显示成功、实际丢 96% 数据」。
       *
       * 有了这个数，done 阶段就能做一致性核对并在偏离时**显式告警**，
       * 而不必等用户自己去库里数行才发现。
       */
      if (res && typeof res.affectedRows === 'number') affectedRows += res.affectedRows;
      return { ok: true, msg: null };
    } catch (e) {
      const msg = String((e && e.message) || e);
      failed += batch.count;
      if (errors.length < MAX_ERRORS) {
        errors.push({ no: executed + failed, message: msg, sql: preview(batch.sql) });
      }
      return { ok: false, msg };
    }
  }

  /** 尝试把一条语句并入合并缓冲；返回 false = 它不可合并（调用方需先 flush） */
  async function offerMerge(sql) {
    const shape = parseInsertShape(sql);
    if (!shape.mergeable) return false;
    if (pending && !canMergeWith(pending.shape, shape)) {
      const r = await flushMerged();
      if (!r.ok && onError !== 'continue') return 'abort';
    }
    if (pending) {
      pending.sql = mergeTwoInsert(pending.sql, pending.shape, shape);
      pending.count++;
    } else {
      pending = { sql, count: 1, shape };
    }
    // 攒够了就发出去：控制单条语句体积，也给进度推送留出真实节点
    if (pending.count >= MERGED_INSERT_MAX_ROWS || pending.sql.length >= MERGED_INSERT_MAX_BYTES) {
      const r = await flushMerged();
      if (!r.ok && onError !== 'continue') return 'abort';
    }
    return true;
  }

  try {
    let sinceCommit = 0;
    await forEachStatement(async (sql) => {
      try {
        await beginTx();
        sinceCommit++;

        // 先试着并入 INSERT 合并批；不可合并时先发掉上一批再逐条执行
        const offer = await offerMerge(sql);
        if (offer === 'abort') {
          await rollbackTx();
          abortInfo = 'INSERT 合并批次失败';
          return { stop: true };
        }
        if (offer === false) {
          const r = await flushMerged();
          if (!r.ok && onError !== 'continue') {
            await rollbackTx();
            abortInfo = r.msg;
            return { stop: true };
          }
          const [res1] = await conn.query(sql);
          executed++;
          // 同样采集（DDL 返回 0/affectedRows 视类型而定，只累加数值型）
          if (res1 && typeof res1.affectedRows === 'number') affectedRows += res1.affectedRows;
        }

        // 事务分段：每 TX_BATCH 条提交一次（滚动点，失败时只丢这一段）
        if (sinceCommit >= TX_BATCH) {
          await flushMerged();
          await commitTx();
          sinceCommit = 0;
        }
      } catch (e) {
        await rollbackTx();
        sinceCommit = 0;
        failed++;
        const msg = String((e && e.message) || e);
        if (errors.length < MAX_ERRORS) {
          errors.push({ no: executed + failed, message: msg, sql: preview(sql) });
        }
        if (onError !== 'continue') {
          // 停止模式：失败即止。只记下中止原因，done 由遍历结束后统一发
          //（这里直接 send 会出现两个 done —— 第二个把 aborted 覆盖成 false）
          abortInfo = msg;
          return { stop: true };
        }
      }
      pushProgress(false);
    });
    // 遍历结束：把还挂着的合并批与事务收尾
    await flushMerged();
    await commitTx();
    send({
      type: 'done',
      jobId,
      executed,
      failed,
      affectedRows,
      elapsedMs: Date.now() - startedAt,
      errors,
      aborted: abortInfo != null,
      lastError: abortInfo,
    });
  } catch (e) {
    // forEachStatement 的同步异常（读文件失败 / 语句超长）—— 任务级失败
    send({ type: 'error', jobId, message: String((e && e.message) || e), executed, failed });
  } finally {
    try {
      await conn.end();
    } catch {}
  }
}

main().catch((e) => {
  send({ type: 'error', jobId: 'unknown', message: String((e && e.stack) || e) });
});
