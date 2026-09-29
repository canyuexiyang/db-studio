'use strict';
/**
 * 导入 worker（D3）—— utilityProcess 里跑。
 *
 * 输入（parentPort 首条消息）：
 *   { jobId, filePath, format: 'csv'|'tsv'|'xlsx'|'json', delimiter?, hasHeader, batchSize,
 *     mapping, columns, connection, database, tableName, retryRows? }
 *
 * 阶段：
 *   parse   —— 读文件 → 二维表格（xlsx 用 exceljs 流式读；json 用 core-import 规范化）
 *   insert  —— buildInsertBatches 分批执行（每批一个事务语义：MySQL 默认每句独立提交）
 *   错误行  —— 逐行校验失败的行不进 INSERT，汇总在 done 消息的 invalidRows 字段
 *
 * E5 失败行重跑（retryRows）：只处理指定的 0 基数据行号（不含表头）；缺省/空 = 全部行。
 *   🔴 行号口径（与渲染层约定一致，改任何一侧都要同步）：
 *      invalidDetail.fileRow = (有表头 ? 1 : 0) + 数据行 0 基下标 + 1   —— 1 基、含表头偏移
 *      retryRows[i]          = 数据行 0 基下标                          —— 不含表头
 *      换算：retryIndex = fileRow - (有表头 ? 1 : 0) - 1
 *   json 强制无表头（见 effHeader），其 fileRow = 数据行下标 + 1。
 *
 * 取消：主进程 kill 本进程即真取消。已插入的批次不回滚（D3 语义：仅追加，
 * 用户重跑前自己清掉；向导 UI 会提示）。这里不做"撤销"—— 5 万行回滚反而更危险。
 */

const parentPort = process.parentPort;

function send(msg) {
  try {
    parentPort.postMessage(msg);
  } catch {}
}

/** JSON.parse 无法流式，超限会顶爆 worker 内存（与 transfer-manager 的 peek 护栏同值） */
const JSON_MAX_BYTES = 100 * 1024 * 1024;

async function main() {
  const job = await new Promise((resolve) => {
    parentPort.once('message', (e) => resolve(e.data));
  });
  const {
    jobId,
    filePath,
    format,
    delimiter,
    hasHeader,
    batchSize,
    mapping,
    columns,
    connection,
    database,
    tableName,
    retryRows,
  } = job;

  const startedAt = Date.now();
  const fs = require('node:fs');

  // ---- 1. 读文件 ----
  let rows;
  try {
    if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      // readFile 是全量的，但导入场景（v1 验收 5 万行）内存可控；
      // csv.reader 流式接口在 exceljs 里不稳定，不冒这个险
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('Excel 文件里没有工作表');
      rows = [];
      ws.eachRow((row) => {
        const vals = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          const v = cell.value;
          if (v === null || v === undefined) vals.push('');
          else if (v instanceof Date) vals.push(isoLocal(v));
          else if (typeof v === 'object' && v.richText) vals.push(v.richText.map((r) => r.text).join(''));
          else if (typeof v === 'object' && v.text) vals.push(String(v.text));
          else if (typeof v === 'object' && v.formula) vals.push(v.result == null ? '' : String(v.result));
          else vals.push(String(v));
        });
        rows.push(vals);
      });
    } else if (format === 'json') {
      // E3 JSON 导入：数组（或单对象包成单行）→ 行。护栏必须放在 parse 之前。
      const stat = fs.statSync(filePath);
      if (stat.size > JSON_MAX_BYTES) {
        throw new Error('JSON 文件超过 100MB，暂不支持导入（请先拆分文件）');
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const { stripBom, normalizeJsonRows, jsonCellText } = require('@dbstudio/core-import');
      // 带 BOM 的文件 JSON.parse 会直接抛 "Unexpected token"，先剥掉
      const parsed = JSON.parse(stripBom(raw));
      const { rows: objs, keys } = normalizeJsonRows(parsed);
      // 行 = 对象值序列（按 keys 对齐），列 = keys。keys 与渲染层 peek 用同一
      // normalizeJsonRows 算法：子集键序是全量键序的前缀，位置映射不会错位；
      // 渲染层只见前 50 个对象，后续对象的新键追加在 keys 尾部，超出 mapping
      // 长度的列由 buildInsertBatches 自然跳过（只遍历 mapping 下标）。
      rows = objs.map((o) => keys.map((k) => jsonCellText(o[k])));
    } else {
      const text = fs.readFileSync(filePath, 'utf8');
      const delim = delimiter || (format === 'tsv' ? '\t' : ',');
      // 纯逻辑在 core-import，worker 不重复实现 —— 从编译后的包加载
      const { parseDelimited } = require('@dbstudio/core-import');
      rows = parseDelimited(text, delim);
    }
  } catch (e) {
    send({ type: 'error', jobId, message: '读取文件失败：' + String((e && e.message) || e) });
    return;
  }

  if (!rows || rows.length === 0) {
    send({ type: 'error', jobId, message: '文件为空或没有可导入的行' });
    return;
  }

  // ---- 2. 生成 INSERT 批次 ----
  // json 没有表头概念：渲染层传来的 hasHeader 只服务于它的「键序伪表头」预览，
  // 这里强制按无表头算，保证 fileRow / retryRows 口径与真实文件一致
  const effHeader = format === 'json' ? false : hasHeader;

  const { buildInsertBatches, filterRetryRows } = require('@dbstudio/core-import');
  // E5：先规整（去重/升序/越界剔除）。注意约定：调用方【缺省】retryRows 才等于
  // 全部行；规整结果为空数组时同样按"全部行"处理（与 ipc-channels 注释的口径一致）
  const retry = filterRetryRows(rows.length - (effHeader ? 1 : 0), retryRows);
  const plan = buildInsertBatches(database, tableName, rows, mapping, columns, {
    hasHeader: effHeader,
    batchSize: batchSize || 1000,
    retryRows: retry.length > 0 ? retry : undefined,
  });

  if (plan.insertableRows === 0) {
    send({
      type: 'done',
      jobId,
      rowsDone: 0,
      elapsedMs: Date.now() - startedAt,
      batches: 0,
      invalidRows: plan.invalidRows.length,
      // 明细上限 1000（E5 重试按 fileRow 重跑，越多越完整；1000 条 ≈ 百 KB 级消息，可控）
      invalidDetail: plan.invalidRows.slice(0, 1000),
      totalRows: plan.totalRows,
    });
    return;
  }

  // ---- 3. 执行 ----
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
      multipleStatements: false,
      rowsAsArray: true,
    });
  } catch (e) {
    send({ type: 'error', jobId, message: '导入建连失败：' + String((e && e.message) || e) });
    return;
  }

  let rowsDone = 0;
  let failedAt = null;
  try {
    for (const st of plan.statements) {
      await conn.query(st.sql, st.params);
      rowsDone += st.rowCount;
      send({
        type: 'progress',
        jobId,
        rowsRead: plan.totalRows,
        rowsDone,
        elapsedMs: Date.now() - startedAt,
      });
    }
    send({
      type: 'done',
      jobId,
      rowsDone,
      elapsedMs: Date.now() - startedAt,
      batches: plan.statements.length,
      invalidRows: plan.invalidRows.length,
      // 明细上限 1000（同上：E5 重试需要完整 fileRow 列表）
      invalidDetail: plan.invalidRows.slice(0, 1000),
      totalRows: plan.totalRows,
    });
  } catch (e) {
    failedAt = rowsDone;
    send({
      type: 'error',
      jobId,
      message: `第 ${rowsDone} 行后插入失败：` + String((e && e.message) || e),
      rowsDone,
    });
  } finally {
    try {
      await conn.end();
    } catch {}
  }
}

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

main().catch((e) => {
  send({ type: 'error', jobId: 'unknown', message: String((e && e.stack) || e) });
});
