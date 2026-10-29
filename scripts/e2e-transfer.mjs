/**
 * 导入导出 e2e —— 真实 MySQL fixture（端口 13306）+ 真 utilityProcess worker
 *
 * 覆盖（P0-1 验收口径）：
 *  1. 导出四格式：xlsx / csv / json / sql —— 文件落盘、行数正确、内容抽查
 *  2. xlsx 日期保真（E4 红线：不退化为裸数字 —— exceljs 读回 Date 类型）
 *  3. CSV 大值转义（引号/逗号/换行 RFC 4180）
 *  4. SQL 导出是可重放的多值 INSERT 文本
 *  5. 导入闭环：CSV → import-worker → 行真的进库
 *  6. 导入校验：类型错误行被剔除，valid 行照常插入
 *  7. 导出失败（SQL 语法错）→ 半截文件被清理
 *  8. P0-1 快照导出（rows 通道）：连接不可达也能写出，只写选中行、不重查
 *  9. P0-1 快照列数不符 → 明确失败且不留半截文件
 *
 * 运行：node scripts/e2e-transfer.mjs（前置：docker dbstudio-mysql + npm run build）
 *
 * ⚠️ utilityProcess 需要完整 Electron 运行时 —— node 里 import electron 拿到的是
 *    CJS 占位（named export 不存在）。所以这里用 playwright 起真 Electron 进程，
 *    把 e2e 逻辑作为「无窗口 main 脚本」注入执行（该脚本只 fork worker + 验证，
 *    不建窗口，退出码承载结果）。
 *
 * ⚠️ 看门狗：真进程交互挂住时 90s 强制失败（带阶段标记）—— 沿用 e2e-ssh 的教训。
 */

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DESKTOP = join(ROOT, 'apps/desktop');

const CRED = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: process.env.DB_STUDIO_E2E_PWD ?? 'dbstudio_local_2026',
};

const workersDir = join(DESKTOP, 'dist/main/workers');
if (!existsSync(join(workersDir, 'export-worker.cjs'))) {
  console.error('❌ worker 未构建：先 npm run build');
  process.exit(1);
}

const electronBin = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(electronBin)) {
  console.log('⏭️  跳过：未找到 Electron 二进制');
  process.exit(0);
}

// fixture 检查
try {
  const net = await import('node:net');
  const alive = await new Promise((resolve) => {
    const s = net.createConnection({ host: CRED.host, port: CRED.port });
    s.setTimeout(2000);
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
    s.on('timeout', () => (s.destroy(), resolve(false)));
  });
  if (!alive) {
    console.log(`⏭️  跳过：fixture MySQL 未在 ${CRED.host}:${CRED.port} 监听`);
    process.exit(0);
  }
} catch {
  console.log('⏭️  跳过：fixture 探测失败');
  process.exit(0);
}

// ---------- 注入主进程的 e2e 逻辑（无窗口，只 fork worker + 验证） ----------

const WORKER_TEST = `
const { app, utilityProcess } = require('electron');
const { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const CRED = ${JSON.stringify(CRED)};
const workersDir = ${JSON.stringify(workersDir)};
const results = [];
function check(name, cond, detail) {
  results.push([name, !!cond, detail ?? '']);
  console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
}
function runWorker(script, job, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(script, undefined, { stdio: 'pipe' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker 超时')); }, timeoutMs || 30000);
    // 🔴 Electron 44 实测：主进程侧 message 事件参数是裸消息（无 {data} 包装）
    child.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'done' || msg.type === 'error') { clearTimeout(timer); resolve(msg); }
    });
    child.postMessage(job);
  });
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-transfer-'));
  let mysql2;
  try { mysql2 = require('mysql2/promise'); } catch (e) { throw new Error('mysql2 加载失败 ' + e.message); }
  const admin = await mysql2.createConnection({
    ...CRED,
    // 🔴 R10：验证侧也要 bigNumberStrings —— 否则读回的 BIGINT 过 2^53 丢精度，
    //    会把「worker 插入正确」误判成「精度丢失」（e2e 自己的坑，不是 worker 的）
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const db = 'e2e_tr_' + Date.now().toString(36);
  await admin.query('CREATE DATABASE \\\`' + db + '\\\`');
  await admin.query('USE \\\`' + db + '\\\`');
  await admin.query(\`CREATE TABLE src (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    note TEXT,
    ts DATETIME(6) NULL,
    big_no BIGINT NOT NULL
  )\`);
  await admin.query("INSERT INTO src (name, amount, note, ts, big_no) VALUES ('alpha','10.50','plain','2026-09-20 15:04:05.123456',9007199254740993),('bravo','20.00','has,comma','2026-09-21 16:05:06.000000',9007199254740994),('charlie','30.25','has\\"quote','2026-09-22 17:06:07.654321',9007199254740995),('delta','40.00','has\\\\nline',NULL,9007199254740996)");
  check('测试表已就绪（4 行，含特殊字符与 NULL）', true, db);

  const connInfo = { ...CRED, database: db };
  const columns = [
    { name: 'id', dataType: 'bigint' }, { name: 'name', dataType: 'varchar(64)' },
    { name: 'amount', dataType: 'decimal(12,2)' }, { name: 'note', dataType: 'text' },
    { name: 'ts', dataType: 'datetime(6)' }, { name: 'big_no', dataType: 'bigint' },
  ];

  // 1. xlsx
  {
    const out = join(workDir, 'e2e.xlsx');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j1', format: 'xlsx', outputPath: out, tableName: 'src', columns, connection: connInfo, sql: null, batchSize: 2,
    });
    check('xlsx 导出 done（4 行）', msg.type === 'done' && msg.rowsWritten === 4, JSON.stringify(msg).slice(0, 120));
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const ws = wb.worksheets[0];
    check('xlsx 可被 exceljs 打开且行数正确', ws.rowCount >= 5, 'rowCount=' + ws.rowCount);
    // R10：dateStrings:true → 日期以原文（字符串）进 worker，exceljs 写入后读回也是字符串。
    // 「不退化」的语义 = 原文完整保留（含微秒），而不是变成 Excel 序列数字。
    const tsCell = ws.getRow(2).getCell(5).value;
    check(
      'xlsx 日期保真（R10 dateStrings：微秒原文完整，非 Excel 序列号）',
      String(tsCell) === '2026-09-20 15:04:05.123456' && !/^\\d+(\\.\\d+)?$/.test(String(tsCell)),
      'value=' + String(tsCell),
    );
    check('xlsx 文本列保真', String(ws.getRow(2).getCell(4).value) === 'plain', String(ws.getRow(2).getCell(4).value));
    check('xlsx 含逗号文本保真', String(ws.getRow(3).getCell(4).value) === 'has,comma', String(ws.getRow(3).getCell(4).value));
  }

  // 2. csv
  {
    const out = join(workDir, 'e2e.csv');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j2', format: 'csv', outputPath: out, tableName: 'src', columns, connection: connInfo, batchSize: 2,
    });
    check('csv 导出 done（4 行）', msg.type === 'done' && msg.rowsWritten === 4, JSON.stringify(msg).slice(0, 100));
    const text = readFileSync(out, 'utf8');
    // CSV 行数必须按 RFC 4180 语义解析（引号内换行不算行分隔）
    const { parseDelimited } = require('@dbstudio/core-import');
    const rows = parseDelimited(text, ',');
    check('csv 解析后 = 表头 + 4 数据行', rows.length === 5, 'rows=' + rows.length);
    check('csv 表头正确', rows[0].join(',').startsWith('id,name,amount,note'), rows[0].join(',').slice(0, 40));
    check('csv 含逗号值被引号包裹', text.includes('"has,comma"'), '');
    check('csv 含引号值转义（""）', text.includes('"has""quote"'), '');
    check('csv 引号内换行保留原值', rows[4][3] === 'has\\nline' || rows[4][3] === 'has\\\\nline', JSON.stringify(rows[4][3]));
    check('csv bigint 不丢精度', text.includes('9007199254740993'), '');
  }

  // 3. json
  {
    const out = join(workDir, 'e2e.json');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j3', format: 'json', outputPath: out, tableName: 'src', columns, connection: connInfo,
    });
    check('json 导出 done（4 行）', msg.type === 'done' && msg.rowsWritten === 4, JSON.stringify(msg).slice(0, 100));
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    check('json 是 4 元素数组且首行 name=alpha', Array.isArray(parsed) && parsed.length === 4 && parsed[0].name === 'alpha');
    check('json bigint 保留精度', String(parsed[0].big_no).includes('9007199254740993'), typeof parsed[0].big_no);
    check('json NULL 是 null', parsed[3].ts === null, String(parsed[3].ts));
  }

  // 4. sql + 重放
  {
    const out = join(workDir, 'e2e.sql');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j4', format: 'sql', outputPath: out, tableName: 'src', columns, connection: connInfo,
    });
    check('sql 导出 done（4 行）', msg.type === 'done' && msg.rowsWritten === 4, JSON.stringify(msg).slice(0, 100));
    const text = readFileSync(out, 'utf8');
    check('sql 是 INSERT INTO', text.includes('INSERT INTO'), text.split('\\n')[0].slice(0, 60));
    // 重放验证：导出 SQL 的表名写死了 \`db\`.\`src\`（这是导出的正确语义）。
    // 重放到 replay 表需要改写目标表名 —— 语句由我们生成，字符串替换安全。
    await admin.query('DROP TABLE IF EXISTS replay');
    await admin.query('CREATE TABLE replay LIKE src');
    await admin.query('USE \\\`' + db + '\\\`');
    const replayText = text.split('\\\`' + db + '\\\`.\\\`src\\\`').join('replay').split('\\\`src\\\`').join('replay');
    for (const stmt of replayText.split(';').map((s) => s.trim()).filter(Boolean)) {
      await admin.query(stmt);
    }
    const [cnt] = await admin.query('SELECT COUNT(*) AS n FROM replay');
    check('sql 导出可重放（4 行进 replay 表）', Number(cnt[0].n) === 4, 'n=' + cnt[0].n);
  }

  // 5. 导入闭环
  {
    const csv = ['name,amount,note,big_no',
      '"echo","55.10","ok",9007199254740997',
      '"foxtrot","66.20","ok2",9007199254740998',
      '"golf","77.30",NULL,9007199254740999',
      '"hotel","not-a-number","bad",1',
      ',"88.40","no-name",2'].join('\\n');
    const csvPath = join(workDir, 'in.csv');
    writeFileSync(csvPath, csv);
    const mapping = ['name', 'amount', 'note', 'big_no'];
    const importColumns = [
      { name: 'id', dataType: 'bigint', nullable: false, autoIncrement: true },
      { name: 'name', dataType: 'varchar(64)', nullable: false, autoIncrement: false },
      { name: 'amount', dataType: 'decimal(12,2)', nullable: false, autoIncrement: false },
      { name: 'note', dataType: 'text', nullable: true, autoIncrement: false },
      { name: 'ts', dataType: 'datetime(6)', nullable: true, autoIncrement: false },
      { name: 'big_no', dataType: 'bigint', nullable: false, autoIncrement: false },
    ];
    const msg = await runWorker(join(workersDir, 'import-worker.cjs'), {
      jobId: 'j5', filePath: csvPath, format: 'csv', delimiter: ',', hasHeader: true, batchSize: 100,
      mapping, columns: importColumns, connection: connInfo, database: db, tableName: 'src',
    });
    check('导入 done', msg.type === 'done', JSON.stringify(msg).slice(0, 150));
    check('导入插入 3 行（2 行被校验拒绝）', msg.rowsDone === 3, 'rowsDone=' + msg.rowsDone + ' invalid=' + msg.invalidRows);
    check('校验拒绝行被报告', msg.invalidRows === 2, 'invalidRows=' + msg.invalidRows);
    check('错误明细含行号与原因', (msg.invalidDetail || []).length === 2 && msg.invalidDetail[0].fileRow >= 2, JSON.stringify(msg.invalidDetail || []).slice(0, 120));
    const [rows] = await admin.query("SELECT name, amount, big_no FROM src WHERE name IN ('echo','foxtrot','golf')");
    check('导入行真的在库里（3 行）', rows.length === 3, 'n=' + rows.length);
    check('导入值保真（big_no 精度）', rows.some((r) => String(r.big_no) === '9007199254740999'), JSON.stringify(rows).slice(0, 120));
  }

  // 5.5 P1-10 GBK 导入（中文旧系统导出的 CSV 就是这个形态）
  {
    /**
     * 「张三」「李四」的 GBK 字节，硬编码 —— Node 没有现成的 GBK 编码器。
     *
     * 🔴 断言落在**库里的字面中文**上：如果 worker 忽略 encoding 而按 utf8 硬读，
     *    插进去的是一串替换字符（不报错），这条立刻红。这正是 P1-10 要防的形态。
     */
    const gbk = Buffer.concat([
      Buffer.from('name,amount,note,big_no\\n'),
      Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]),
      Buffer.from(',10.00,ok,9007199254741001\\n'),
      Buffer.from([0xc0, 0xee, 0xcb, 0xc4]),
      Buffer.from(',20.00,ok2,9007199254741002\\n'),
    ]);
    const gbkPath = join(workDir, 'gbk.csv');
    writeFileSync(gbkPath, gbk);
    const cols2 = [
      { name: 'id', dataType: 'bigint', nullable: false, autoIncrement: true },
      { name: 'name', dataType: 'varchar(64)', nullable: false, autoIncrement: false },
      { name: 'amount', dataType: 'decimal(12,2)', nullable: false, autoIncrement: false },
      { name: 'note', dataType: 'text', nullable: true, autoIncrement: false },
      { name: 'ts', dataType: 'datetime(6)', nullable: true, autoIncrement: false },
      { name: 'big_no', dataType: 'bigint', nullable: false, autoIncrement: false },
    ];
    const msg = await runWorker(join(workersDir, 'import-worker.cjs'), {
      jobId: 'j5b', filePath: gbkPath, format: 'csv', delimiter: ',', encoding: 'gbk', hasHeader: true,
      batchSize: 100, mapping: ['name', 'amount', 'note', 'big_no'],
      columns: cols2, connection: connInfo, database: db, tableName: 'src',
    });
    check('GBK 导入 done（2 行）', msg.type === 'done' && msg.rowsDone === 2, JSON.stringify(msg).slice(0, 120));
    const [zh] = await admin.query(
      'SELECT name FROM src WHERE big_no IN (9007199254741001,9007199254741002) ORDER BY big_no',
    );
    check(
      '🔴 GBK 中文按原文入库（不是替换字符）',
      zh.length === 2 && zh[0].name === '张三' && zh[1].name === '李四',
      JSON.stringify(zh),
    );
  }

  // 6. 导出失败 → 半截文件清理
  {
    const out = join(workDir, 'bad.csv');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j6', format: 'csv', outputPath: out, tableName: 'src', columns, connection: connInfo,
      sql: 'SELECT * FROM nonexistent_table_xyz',
    });
    check('坏 SQL → error 消息', msg.type === 'error', JSON.stringify(msg).slice(0, 100));
    check('失败后不留半截文件', !existsSync(out), existsSync(out) ? '残留 ' + out : '已清理');
  }

  // 7. P0-1 快照导出（rows 通道）
  {
    // 🔴 故意给一个**连不通**的连接（端口 1）：快照路径必须完全不建连、不查库。
    //    这是这条用例的核心证伪能力 —— 如果实现偷偷去重查，这里会立刻失败。
    const deadConn = { host: '127.0.0.1', port: 1, user: 'nobody', password: 'x', database: db };
    const snapColumns = [
      { name: 'id', dataType: 'bigint' },
      { name: 'name', dataType: 'varchar(64)' },
    ];
    const out = join(workDir, 'snap.csv');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j7', format: 'csv', outputPath: out, tableName: 'src', columns: snapColumns,
      connection: deadConn, rows: [['9007199254740993', 'alpha'], ['9007199254740994', 'bravo']],
      scope: 'snapshot', batchSize: 1,
    });
    check('快照导出 done（2 行，连接不可达也不受影响）', msg.type === 'done' && msg.rowsWritten === 2, JSON.stringify(msg).slice(0, 120));
    const snapText = existsSync(out) ? readFileSync(out, 'utf8') : '';
    const { parseDelimited } = require('@dbstudio/core-import');
    const snapRows = parseDelimited(snapText, ',');
    check('快照 CSV = 表头 + 2 数据行（不是整表 4 行）', snapRows.length === 3, 'rows=' + snapRows.length);
    check('快照只含选中的两行（未混入 charlie/delta）', !/charlie|delta/.test(snapText), snapText.slice(0, 80));
    check('快照 bigint 原样写出不丢精度', snapText.includes('9007199254740993'), '');
  }

  // 8. P0-1 快照列数不符 → 明确失败 + 不留半截文件
  {
    const deadConn = { host: '127.0.0.1', port: 1, user: 'nobody', password: 'x', database: db };
    const out = join(workDir, 'snap-bad.csv');
    const msg = await runWorker(join(workersDir, 'export-worker.cjs'), {
      jobId: 'j8', format: 'csv', outputPath: out, tableName: 'src',
      columns: [{ name: 'id', dataType: 'bigint' }, { name: 'name', dataType: 'varchar(64)' }],
      connection: deadConn, rows: [['only-one-column']], scope: 'snapshot',
    });
    check('快照列数不符 → error（不写错位文件）', msg.type === 'error' && /列数不一致/.test(String(msg.message)), JSON.stringify(msg).slice(0, 140));
    check('快照失败后不留半截文件', !existsSync(out), existsSync(out) ? '残留 ' + out : '已清理');
  }

  await admin.query('DROP DATABASE \\\`' + db + '\\\`');
  await admin.end();
  const failed = results.filter((r) => !r[1]);
  console.log('RESULT_JSON ' + JSON.stringify({ total: results.length, failed: failed.length }));
  app.exit(failed.length > 0 ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
  console.error('e2e 异常：', e);
  app.exit(2);
});
`;

// 写临时 main 脚本。⚠️ 必须放在项目目录内：Electron 的 require('electron') 与
// mysql2/exceljs 都靠 node_modules 向上解析，放 /tmp 会 MODULE_NOT_FOUND。
// 用【固定目录】复用：mkdtemp 每次生成新目录，异常退出会堆积 → 撞宿主
// "批量删除需确认"护栏（>50 文件）。固定名 + 每次 rmSync 重建，最多留一份。
const workDir = join(ROOT, '.e2e-tmp');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const mainScript = join(workDir, 'e2e-main.cjs');
writeFileSync(mainScript, WORKER_TEST);

const child = spawn(electronBin, [mainScript, '--no-sandbox', '--disable-gpu'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    // 🔴 宿主 shell 可能带着 ELECTRON_RUN_AS_NODE=1（让 Electron 退化成纯 Node，
    //    require('electron') 变 undefined）。必须显式清掉。
    ELECTRON_RUN_AS_NODE: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
  // cwd 设项目根：确保 worker 里 require('@dbstudio/core-import') 等包解析正常
  cwd: ROOT,
});

const watchdog = setTimeout(() => {
  console.error('⏰ 看门狗触发（120s）：e2e 挂住');
  child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}, 120_000);

child.on('exit', (code) => {
  clearTimeout(watchdog);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
