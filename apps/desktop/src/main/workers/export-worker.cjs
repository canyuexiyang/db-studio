'use strict';
/**
 * 导出 worker —— 在 utilityProcess 里跑（评审 §4.4：重活不进主进程）。
 *
 * 之所以用 .cjs：utilityProcess.fork 加载 ESM 文件要求 Electron 特定版本路径，
 * CJS 是最稳的形态；且 worker 不经 vite 构建（见 vite.main.config.ts 的注释），
 * 独立放 src/main/workers/ 目录，构建脚本原样拷贝（见 scripts/copy-workers.mjs）。
 *
 * 消息协议与 core-export 的 ExportMessage 一致：
 *   progress / done / error / cancelled（jobId 区分多任务）
 * 协议扩展（只加字段不改既有字段，主进程原样转发）：
 *   - progress 新增可选 table / tableIndex / tableCount（E4 整库：按表推送进度）
 *
 * 🔴 Electron 44：端口是 process.parentPort（不是 require('electron').parentPort）
 * 🔴 取消语义：utilityProcess.kill() 是真取消；被 kill 的 worker 发不出
 *    cancelled 消息 —— 「cancelled」状态由主进程侧判定并推送（本文件只管干完）
 *
 * 信任边界（B7 自定义 SQL 导出）：worker 收到的 job.sql 是用户在编辑器里
 * 已确认执行的语句，渲染层的只读守卫/危险确认由 App 的 onRunSql 体系负责；
 * worker 不重复做 SQL 守卫（它也守不住——守卫逻辑在 core-sql-guard，主进程链路）。
 */

const parentPort = process.parentPort;

function send(msg) {
  try {
    parentPort.postMessage(msg);
  } catch {
    /* 主进程已不在（被 kill 的窗口期）：尽力发，失败就算了 */
  }
}

// ---------- 文本格式小工具 ----------
// 漂移防线：这里与 core-export 的纯函数（csvRow / toMarkdownTable）保持同一套规则，
// 项目既有先例就是 worker 内联实现 + core 包钉测试（csvEsc ↔ csvRow）。
// 改任何一条转义规则，必须同步改 core-export 的对应函数与用例。

/** UTF-8 BOM：Excel 直接打开 UTF-8 CSV 不乱码（E2 utf8-bom） */
const BOM = '\uFEFF';

/** JSON 导入/解析的大小护栏：JSON.parse 无法流式，超限会顶爆内存 */
const JSON_MAX_BYTES = 100 * 1024 * 1024;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CSV 单元格：RFC 4180 引号规则 + 自定义分隔符 + NULL 文本（E2） */
function makeCsvEsc(delimiter, nullText) {
  const needsQuote = new RegExp('["\\r\\n' + escapeRegExp(delimiter) + ']');
  return (v) => {
    if (v === null || v === undefined) return nullText;
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
}

/** Markdown 表格单元格：竖线转 \| 防破表、换行转 <br>（GitHub 方言约定） */
function mdCell(v, nullText) {
  if (v === null || v === undefined) return nullText;
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

/** SQL 字面量转义（与历史行为一致：反斜杠/单引号翻倍） */
function sqlEsc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const s = String(v);
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function main() {
  const job = await new Promise((resolve) => {
    parentPort.once('message', (e) => resolve(e.data));
  });
  const { jobId, format, outputPath, columns, connection, sql, tableName, batchSize } = job;
  // E4：'database' = 整库全部表（仅 sql/markdown）；其余一律按单表处理
  const scope = job.scope === 'database' ? 'database' : 'table';
  /**
   * P0-1：快照行（选区 / 当前已加载）。有它就是**纯编码任务**：
   * 不建连接、不查库、不受连接状态影响。行数组由渲染层按输出列裁好。
   */
  const snapshotRows = Array.isArray(job.rows) ? job.rows : null;
  // E2 细化选项：缺省回各格式历史默认值。xlsx/json/sql 刻意忽略 options（见各分支注释）
  const options = job.options || {};
  const delimiter =
    typeof options.delimiter === 'string' && options.delimiter.length > 0 ? options.delimiter : ',';
  const bom = options.encoding === 'utf8-bom';
  const nullText = options.nullText == null ? '\\N' : String(options.nullText);
  const includeHeader = options.includeHeader !== false;

  const startedAt = Date.now();
  let rowsWritten = 0;
  const batch = Math.max(1, batchSize || 1000);

  const fs = require('node:fs');

  /**
   * ---- 连库（**懒建**：快照导出不需要数据库） ----
   *
   * worker 自己建连接：主进程连接要跑 UI 查询，不能被导出长查询占用。
   * 抛出的错误消息与改造前逐字一致（原来在函数开头就建连并就地 send）。
   */
  let conn = null;
  async function connectDb() {
    if (conn) return conn;
    let mysql2;
    try {
      mysql2 = require('mysql2/promise');
    } catch (e) {
      throw new Error('worker 无法加载 mysql2：' + String(e && e.message));
    }
    try {
      conn = await mysql2.createConnection({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password ?? '',
        database: connection.database,
        // R10 参数（与主进程驱动一致，保证数据形态相同）
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
      throw new Error('导出建连失败：' + String(e && e.message));
    }
    return conn;
  }

  // 打开的 fd 登记在册：失败/收尾路径统一关闭，不留句柄（半截文件由外层 catch 负责删）
  const openFds = [];
  function openOutFd() {
    const fd = fs.openSync(outputPath, 'w');
    openFds.push(fd);
    return fd;
  }
  function closeAllFds() {
    while (openFds.length > 0) {
      const fd = openFds.pop();
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭（EBADF）忽略 */
      }
    }
  }

  // 🔴 mysql2 3.x 实测：Connection 上没有 queryStream（文档误导）。
  //    流式读的正确姿势是原生 conn.query() 返回的事件流：
  //    on('result') 逐行到达（rowsAsArray:true → 行是数组），on('end') 收尾。
  //    PromiseConnection 会把 query 包装成整批 Promise，丢失流式 ——
  //    所以这里必须用 conn.connection（底层原生连接）。
  //    rowsWritten 是跨表累计值（E4 整库按全局行数推进度）。
  function streamQuery(query, onRow) {
    return connectDb().then(
      (c) =>
        new Promise((resolve, reject) => {
          const stream = c.connection.query(query);
          stream
            .on('result', (row) => {
              rowsWritten++;
              onRow(row);
              if (rowsWritten % batch === 0) {
                send({ type: 'progress', jobId, rowsWritten, elapsedMs: Date.now() - startedAt });
              }
            })
            .on('end', resolve)
            .on('error', reject);
        }),
    );
  }

  /** 非流式查询（SHOW TABLES / SHOW COLUMNS / SHOW CREATE，结果集小） */
  async function queryRows(q) {
    const c = await connectDb();
    const [rows] = await c.query(q);
    return rows;
  }

  /** 整库路径用：某张表的列名（rowsAsArray → 每行 [Field, Type, ...]） */
  async function showColumns(db, t) {
    const rows = await queryRows(`SHOW COLUMNS FROM \`${db}\`.\`${t}\``);
    return rows.map((r) => String(r[0]));
  }

  try {
    if (scope === 'database') {
      // ================= E4 整库导出（mysqldump 语义的轻量版） =================
      // 🔴 快照没有库范围：整库是「逐表重查」，两者语义冲突（宁可报错也不猜）
      if (snapshotRows) throw new Error('快照导出不支持整库范围');
      if (format !== 'sql' && format !== 'markdown') {
        throw new Error('整库导出仅支持 SQL / Markdown 格式');
      }
      const tableRows = await queryRows('SHOW TABLES');
      const tables = tableRows.map((r) => String(r[0]));
      if (tables.length === 0) throw new Error(`数据库 ${connection.database} 里没有可导出的表`);
      const db = connection.database;

      if (format === 'sql') {
        const fd = openOutFd();
        // 文件头：来源与时间，便于追溯这份备份从哪来
        fs.writeSync(fd, `-- DB Studio 整库备份 · ${db} · ${new Date().toISOString()}\n`);
        // 保守默认：不写 DROP TABLE IF EXISTS —— 备份文件默认只追加，误在恢复库上
        // 覆盖的风险太大；是否先删表由恢复方自己决定。（要加的话在这里补一行）
        // 外键约束会让逐表恢复顺序敏感，用会话级开关包住（mysqldump 同款做法），
        // 恢复结束自动恢复校验 —— 这不破坏任何数据，只是让恢复真正可执行。
        fs.writeSync(fd, 'SET FOREIGN_KEY_CHECKS=0;\n\n');
        for (let i = 0; i < tables.length; i++) {
          const t = tables[i];
          send({
            type: 'progress',
            jobId,
            rowsWritten,
            elapsedMs: Date.now() - startedAt,
            table: t,
            tableIndex: i + 1,
            tableCount: tables.length,
          });
          const cols = await showColumns(db, t);
          const createRows = await queryRows(`SHOW CREATE TABLE \`${db}\`.\`${t}\``);
          const ddl = String(createRows[0][1]);
          fs.writeSync(
            fd,
            `-- ----------------------------\n-- 表结构 ${db}.${t}\n-- ----------------------------\n${ddl};\n\n`,
          );
          // 数据：多值 INSERT，每 batch 行一批（复用单表 sql 路径的生成逻辑）。
          // 🔴 表名【不带库前缀】（mysqldump 同款语义）：整库备份必须能恢复进任意
          //    库名 —— 若带源库名，恢复时数据会直接写回源库（重复主键/污染在线库），
          //    而 DDL（SHOW CREATE）本来就不带库名，两者必须一致。恢复方先 USE
          //    目标库再执行本文件。
          const prefix = `INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES\n`;
          const buf = [];
          await streamQuery(`SELECT * FROM \`${db}\`.\`${t}\``, (row) => {
            buf.push('(' + row.map(sqlEsc).join(', ') + ')');
            if (buf.length >= batch) {
              fs.writeSync(fd, prefix + buf.join(',\n') + ';\n');
              buf.length = 0;
            }
          });
          if (buf.length > 0) fs.writeSync(fd, prefix + buf.join(',\n') + ';\n');
          fs.writeSync(fd, '\n');
        }
        fs.writeSync(fd, 'SET FOREIGN_KEY_CHECKS=1;\n');
        closeAllFds();
      } else {
        // markdown 整库：每个表一个 `## 表名` 分节，复用单表的单元格规则
        const fd = openOutFd();
        if (bom) fs.writeSync(fd, BOM);
        for (let i = 0; i < tables.length; i++) {
          const t = tables[i];
          send({
            type: 'progress',
            jobId,
            rowsWritten,
            elapsedMs: Date.now() - startedAt,
            table: t,
            tableIndex: i + 1,
            tableCount: tables.length,
          });
          const cols = await showColumns(db, t);
          fs.writeSync(fd, `## ${t}\n\n`);
          if (includeHeader) {
            fs.writeSync(fd, '| ' + cols.map((c) => mdCell(c, nullText)).join(' | ') + ' |\n');
            fs.writeSync(fd, '| ' + cols.map(() => '---').join(' | ') + ' |\n');
          }
          await streamQuery(`SELECT * FROM \`${db}\`.\`${t}\``, (row) => {
            fs.writeSync(fd, '| ' + row.map((v) => mdCell(v, nullText)).join(' | ') + ' |\n');
          });
          fs.writeSync(fd, '\n');
        }
        closeAllFds();
      }
    } else {
      // ================= 单表 / 自定义 SQL 导出 =================
      const q = sql && sql.trim() ? sql : `SELECT * FROM \`${connection.database}\`.\`${tableName}\``;
      let outCols = columns && columns.length ? columns.slice() : [];

      let handle = null;

      if (format === 'xlsx') {
        // xlsx：忽略 options —— 列名行是 Excel 结构的一部分（不是可选"表头"），
        // 且 exceljs 红线：这条路径一行都不动（日期保真）
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: outputPath,
          useSharedStrings: false,
          useStyles: false,
        });
        const ws = wb.addWorksheet('Sheet1');
        handle = {
          header: () => ws.addRow(outCols.map((c) => c.name)).commit(),
          row: (vals) => ws.addRow(vals).commit(),
          finish: async () => {
            await ws.commit();
            await wb.commit();
          },
        };
      } else if (format === 'csv') {
        const fd = openOutFd();
        // E2：BOM 只在文件头写一次、位置在所有内容之前
        if (bom) fs.writeSync(fd, BOM);
        const csvEsc = makeCsvEsc(delimiter, nullText);
        handle = {
          header: () => {
            if (!includeHeader) return;
            fs.writeSync(fd, outCols.map((c) => csvEsc(c.name)).join(delimiter) + '\n');
          },
          row: (vals) => fs.writeSync(fd, vals.map(csvEsc).join(delimiter) + '\n'),
          finish: async () => closeAllFds(),
        };
      } else if (format === 'markdown') {
        const fd = openOutFd();
        if (bom) fs.writeSync(fd, BOM);
        handle = {
          header: () => {
            if (!includeHeader) return;
            fs.writeSync(fd, '| ' + outCols.map((c) => mdCell(c.name, nullText)).join(' | ') + ' |\n');
            fs.writeSync(fd, '| ' + outCols.map(() => '---').join(' | ') + ' |\n');
          },
          row: (vals) => fs.writeSync(fd, '| ' + vals.map((v) => mdCell(v, nullText)).join(' | ') + ' |\n'),
          finish: async () => closeAllFds(),
        };
      } else if (format === 'json') {
        // json：忽略 options —— 对象数组自带键名（无"表头"概念）、
        // JSON 规范即 UTF-8（BOM 反而会让部分解析器报错）
        const fd = openOutFd();
        fs.writeSync(fd, '[');
        let first = true;
        handle = {
          header: () => {},
          row: (vals) => {
            const obj = {};
            outCols.forEach((c, i) => {
              const v = vals[i];
              obj[c.name] = v instanceof Date ? v.toISOString() : v ?? null;
            });
            fs.writeSync(fd, (first ? '' : ',') + JSON.stringify(obj));
            first = false;
          },
          finish: async () => {
            fs.writeSync(fd, ']');
            closeAllFds();
          },
        };
      } else {
        // sql：多值 INSERT，每 batch 行一批（PRD §6.6）。
        // B7：列名延迟到首行前确定 —— 自定义 SQL 的列集合渲染层可能给不出，
        // 由 fields 事件兜底（见下方），所以 INSERT 前缀不能在这里求值。
        const fd = openOutFd();
        const buf = [];
        let insertPrefix = null;
        const getPrefix = () => {
          if (insertPrefix === null) {
            const qTable = `\`${connection.database}\`.\`${tableName}\``;
            insertPrefix = `INSERT INTO ${qTable} (${outCols.map((c) => `\`${c.name}\``).join(', ')}) VALUES\n`;
          }
          return insertPrefix;
        };
        handle = {
          header: () => {},
          row: (vals) => {
            buf.push('(' + vals.map(sqlEsc).join(', ') + ')');
            if (buf.length >= batch) {
              fs.writeSync(fd, getPrefix() + buf.join(',\n') + ';\n');
              buf.length = 0;
            }
          },
          finish: async () => {
            if (buf.length > 0) fs.writeSync(fd, getPrefix() + buf.join(',\n') + ';\n');
            closeAllFds();
          },
        };
      }

      // 表头时机：列名已知 → 立刻写；列名未知（自定义 SQL 且渲染层没传 columns）
      // → 等 fields 事件到了再写（mysql2 在首行前推送 fields）
      let headerDone = outCols.length > 0;
      if (headerDone) handle.header();

      if (snapshotRows) {
        /**
         * P0-1：快照路径 —— 行已经在渲染层手上，这里只编码写盘。
         *
         * 🔴 快照必须**原样**写出，不做任何「补一排」「再查一次」的补救：
         *    用户选的是「导出眼前这份结果」，任何补数据都会让文件与屏幕不一致。
         * 列数不符就报错 —— 悄悄少写几列会得到一个能打开但错位的文件。
         */
        if (!outCols.length) throw new Error('快照导出缺少列定义，无法确定表头');
        for (const row of snapshotRows) {
          if (!Array.isArray(row) || row.length !== outCols.length) {
            throw new Error(
              `快照列数不一致：第 ${rowsWritten + 1} 行有 ${Array.isArray(row) ? row.length : '?'} 列，` +
                `表头有 ${outCols.length} 列`,
            );
          }
          rowsWritten++;
          handle.row(row);
          if (rowsWritten % batch === 0) {
            send({ type: 'progress', jobId, rowsWritten, elapsedMs: Date.now() - startedAt });
          }
        }
      } else {
        // 重查路径才需要连接（懒建：快照路径上面已经写完了）
        const c = await connectDb();
        await new Promise((resolve, reject) => {
          const stream = c.connection.query(q);
          // B7 兜底：渲染层给不出自定义 SQL 的列定义时，从 fields 事件取列名。
          // 🔴 必须归一成 {name, dataType} 对象数组（与 job.columns 同形状）——
          //    各格式表头都按 c.name 取值，直接塞字符串会全部退化成 NULL 文本。
          // 只在 outCols 为空时生效 —— 单表路径的列来自元数据，优先级更高。
          stream.on('fields', (fields) => {
            if (!outCols.length && Array.isArray(fields)) {
              outCols = fields
                .map((f) => ({ name: String((f && f.name) || ''), dataType: String((f && f.type) ?? '') }))
                .filter((c) => c.name);
              if (!headerDone && outCols.length) {
                headerDone = true;
                handle.header();
              }
            }
          });
          stream
            .on('result', (row) => {
              rowsWritten++;
              handle.row(row);
              if (rowsWritten % batch === 0) {
                send({ type: 'progress', jobId, rowsWritten, elapsedMs: Date.now() - startedAt });
              }
            })
            .on('end', resolve)
            .on('error', reject);
        });
      }

      await handle.finish();
    }

    const bytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    send({ type: 'done', jobId, rowsWritten, elapsedMs: Date.now() - startedAt, bytes });
  } catch (e) {
    // 半截文件必须清理（PRD §八：取消/失败不留打不开的文件）；先把 fd 收干净再删
    closeAllFds();
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
    send({ type: 'error', jobId, message: String((e && e.message) || e), fatal: true });
  } finally {
    // 快照路径没建连接（conn = null）—— 不要对 null 调 end()
    if (conn) {
      try {
        await conn.end();
      } catch {}
    }
  }
}

main().catch((e) => {
  send({ type: 'error', jobId: 'unknown', message: String((e && e.stack) || e), fatal: true });
});
