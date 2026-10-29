'use strict';
/**
 * core-import 的【运行时实现】（CJS）。
 *
 * 为什么是 .cjs 且手写：utilityProcess worker 不经 vite 构建（见
 * vite.main.config.ts / scripts/copy-workers.mjs），require('@dbstudio/core-import')
 * 必须拿到纯 JS —— package.json 的 main 指向 TS 源码只对 vite/tsx 的 alias
 * 解析有效，worker 直接跑不了。
 *
 * 维护约定（🔴 双实现漂移防线）：
 *  - 本文件是【唯一实现】；index.ts 只 re-export + 类型，不写逻辑
 *  - index.test.ts 的全部单测同时覆盖两份导出（require 本文件 + import index.ts）
 *    —— 任何一边改了没同步，测试会红
 */

// ---------- 文本表格解析 ----------

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------- 编码：UTF-8 / GBK + BOM 探测（P1-10） ----------
/**
 * 为什么需要这一层：CSV 没有"编码声明"，而中文环境的旧系统导出 GBK 是常态。
 * 按 UTF-8 硬读 GBK 文件不会报错 —— 只会得到满屏 `�`、列映射全错、导入进去
 * 一堆乱码。所以要么按 BOM 认，要么按"UTF-8 严格解码能不能过"来猜，
 * 最后再交给用户一句话就能改的下拉框兜底。
 *
 * 约定（与 SQL 脚本入口一致，别再造第三套口径）：`'utf8' | 'gbk'`。
 */

/** UTF-8 BOM 长度（0 = 没有）。只认 UTF-8 的 —— UTF-16 是另一种编码，不是乱码。 */
function utf8BomLength(bytes) {
  return bytes && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

function normalizeEncoding(encoding) {
  return String(encoding || '').trim().toLowerCase() === 'gbk' ? 'gbk' : 'utf8';
}

/**
 * 猜测编码：有 UTF-8 BOM → utf8；否则按 UTF-8 **严格**解码试一次，失败即判 gbk。
 *
 * 严格的（`fatal: true`）是关键：非严格解码遇到非法字节会静默换成 `�`，
 * 那就永远"成功"，探测等于没做。反过来，真 UTF-8 文本几乎不可能恰好
 * 构成合法 GBK —— 单向误判概率远低于双向猜。
 */
function sniffEncoding(bytes) {
  if (utf8BomLength(bytes) > 0) return 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf8';
  } catch {
    return 'gbk';
  }
}

/**
 * 按编码解码。utf8 顺带剥 BOM —— 不剥的话首列表头会带一个 `\ufeff`，
 * 自动映射认不出「ID」而认得出「\ufeffID」，用户看到的是"明明有这一列却全没映上"。
 */
function decodeBytes(bytes, encoding) {
  const enc = normalizeEncoding(encoding);
  try {
    if (enc === 'gbk') return new TextDecoder('gbk').decode(bytes);
    const skip = utf8BomLength(bytes);
    return new TextDecoder('utf-8').decode(skip ? bytes.subarray(skip) : bytes);
  } catch (e) {
    // Electron/Node 缺 ICU 时 TextDecoder 建不出来。宁可报清楚，不要静默乱码。
    throw new Error('当前运行环境不支持所选编码：' + enc + '（' + String((e && e.message) || e) + '）');
  }
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = stripBom(text || '');

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      if (s[i] === '\n') i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function sniffDelimiter(sample) {
  const firstLine = (sample || '').split(/\r?\n/, 1)[0] || '';
  const counts = [
    ['\t', countChar(firstLine, '\t')],
    [',', countChar(firstLine, ',')],
    [';', countChar(firstLine, ';')],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

// ---------- 标识符转义（与 core-sql-ident 同规则；独立实现避免 worker 依赖链） ----------

function quoteIdentifier(name) {
  const s = String(name);
  if (/`/.test(s)) throw new Error('非法标识符：' + s);
  return '`' + s + '`';
}

function quoteQualified(parts) {
  return parts.filter((p) => p !== '' && p != null).map(quoteIdentifier).join('.');
}

// ---------- 类型判定（与 core-clipboard validateCellText 同规则的子集） ----------

function baseType(dataType) {
  return (dataType || '').replace(/\(.*\)$/, '').trim().toLowerCase();
}

function isNumericType(dataType) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)$/.test(baseType(dataType));
}

function isIntegerType(dataType) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(baseType(dataType));
}

function isTemporalType(dataType) {
  return /^(date|datetime|timestamp|time|year)$/.test(baseType(dataType));
}

function enumValues(dataType) {
  const m = /^enum\((.*)\)$/i.exec((dataType || '').trim());
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

function charMaxLength(dataType) {
  const m = /\(([^)]+)\)/.exec(dataType || '');
  if (!m) return null;
  const n = Number(m[1].split(',')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

function validateCellText(raw, col) {
  const text = raw == null ? '' : raw;
  const type = baseType(col.dataType);

  const isNullLiteral = text.trim().toUpperCase() === 'NULL' || text.trim() === '\\N';

  if (text === '') {
    if (isNullLiteral) return null;
    return col.nullable ? null : `列 ${col.name} 不允许为 NULL（NOT NULL），但值为空`;
  }
  if (isNullLiteral) {
    return col.nullable ? null : `列 ${col.name} 不允许为 NULL（NOT NULL）`;
  }

  if (isNumericType(col.dataType)) {
    if (!/^-?\d+(\.\d+)?$/.test(text.trim())) {
      return `列 ${col.name} 是 ${type}，但值 "${text}" 不是合法数值`;
    }
    if (isIntegerType(col.dataType) && /\./.test(text.trim())) {
      return `列 ${col.name} 是整数类型 ${type}，不接受小数 "${text}"`;
    }
    return null;
  }

  if (isTemporalType(col.dataType)) {
    if (/^(NOW\(\)|CURRENT_TIMESTAMP(?:\(\))?)$/i.test(text.trim())) return null;
    const m = DATETIME_RE.exec(text.trim());
    if (!m) return `列 ${col.name} 是 ${type}，但值 "${text}" 不是合法日期时间`;
    const [, y, mo, d, h, mi, s] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(s || 0));
    if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) {
      return `列 ${col.name} 的日期 "${text}" 不存在（如 2026-02-30）`;
    }
  }

  if (type === 'enum') {
    const vals = enumValues(col.dataType);
    if (vals.length > 0 && !vals.includes(text)) {
      return `列 ${col.name} 是 ENUM，可选值：${vals.join(' / ')}`;
    }
  }

  if (/^(char|varchar|text|tinytext|mediumtext|longtext)$/.test(type)) {
    const max = charMaxLength(col.dataType);
    if (max != null && Array.from(text).length > max) {
      return `列 ${col.name} 超长：${Array.from(text).length} > ${max} 字符`;
    }
  }

  return null;
}

// ---------- 值转录 ----------

function cellTextToValue(raw) {
  const t = (raw == null ? '' : raw).trim();
  if (t === '') return null; // 空单元格 → NULL（Excel 无法表达 NULL 的现实约定）
  if (t.toUpperCase() === 'NULL' || t === '\\N') return null;
  return raw;
}

// ---------- 列映射 ----------

function normName(s) {
  return (s || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
}

function guessMapping(fileHeaders, tableColumns) {
  const notes = [];
  const used = new Set();
  const mapping = new Array(fileHeaders.length).fill(null);

  const byName = new Map();
  tableColumns.forEach((c, i) => byName.set(normName(c.name), i));

  fileHeaders.forEach((h, fi) => {
    const ti = byName.get(normName(h));
    if (ti !== undefined && !used.has(ti)) {
      mapping[fi] = tableColumns[ti].name;
      used.add(ti);
      if (h !== tableColumns[ti].name) notes.push(`「${h}」按名称匹配到列「${tableColumns[ti].name}」`);
    }
  });

  fileHeaders.forEach((h, fi) => {
    if (mapping[fi] !== null) return;
    for (let ti = 0; ti < tableColumns.length; ti++) {
      if (used.has(ti)) continue;
      mapping[fi] = tableColumns[ti].name;
      used.add(ti);
      notes.push(`「${h}」无同名列，按位置对齐到「${tableColumns[ti].name}」`);
      break;
    }
    if (mapping[fi] === null) notes.push(`文件列「${h}」无表列可对齐，将被跳过`);
  });

  const unmatchedTableColumns = tableColumns
    .map((c, i) => (used.has(i) ? null : c.name))
    .filter((n) => n !== null);

  return { mapping, unmatchedTableColumns, notes };
}

// ---------- INSERT 生成 ----------

function usableColumns(mapping, columns) {
  const out = [];
  for (let fi = 0; fi < mapping.length; fi++) {
    const name = mapping[fi];
    if (!name) continue;
    const col = columns.find((c) => c.name === name);
    if (!col) continue;
    out.push({ fileIdx: fi, col });
  }
  return out;
}

function buildInsertBatches(database, tableName, rows, mapping, columns, opts) {
  opts = opts || {};
  const batchSize = Math.max(1, opts.batchSize || 1000);
  const hasHeader = opts.hasHeader !== false;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const cols = usableColumns(mapping, columns);
  const colList = cols.map((c) => quoteIdentifier(c.col.name)).join(', ');
  const qualified = quoteQualified([database, tableName]);

  // E5 失败行重跑：只处理指定的 0 基数据行。空数组/缺省 = 全部行（调用方约定）。
  // fileRow 仍按【原始行位置】计算 —— 重跑报告的行号必须和首次导入对得上，
  // 否则用户对着文件找不到错在哪行。
  const retrySet =
    Array.isArray(opts.retryRows) && opts.retryRows.length > 0 ? new Set(opts.retryRows) : null;

  const invalidRows = [];
  const validValues = [];

  dataRows.forEach((row, ri) => {
    if (retrySet && !retrySet.has(ri)) return;
    const fileRow = (hasHeader ? 1 : 0) + ri + 1;
    let rowValid = true;

    for (const c of cols) {
      const raw = row[c.fileIdx] == null ? '' : row[c.fileIdx];
      const reason = validateCellText(raw, c.col);
      if (reason) {
        invalidRows.push({ fileRow, column: c.col.name, raw, reason });
        rowValid = false;
      }
    }
    if (!rowValid) return;

    const values = cols.map((c) => cellTextToValue(row[c.fileIdx] == null ? '' : row[c.fileIdx]));
    validValues.push(values);
  });

  const statements = [];
  for (let start = 0; start < validValues.length; start += batchSize) {
    const slice = validValues.slice(start, start + batchSize);
    const rowTemplate = '(' + cols.map(() => '?').join(', ') + ')';
    const placeholders = slice.map(() => rowTemplate).join(', ');
    const params = [];
    for (const v of slice) params.push(...v);
    statements.push({
      sql: `INSERT INTO ${qualified} (${colList}) VALUES ${placeholders}`,
      params,
      rowCount: slice.length,
    });
  }

  return {
    statements,
    invalidRows,
    totalRows: dataRows.length,
    insertableRows: validValues.length,
  };
}

// ---------- 预览校验 ----------

function validatePreview(rows, mapping, columns, hasHeader) {
  const cols = usableColumns(mapping, columns);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const issues = [];

  dataRows.forEach((row, ri) => {
    const fileRow = (hasHeader ? 1 : 0) + ri + 1;
    for (const c of cols) {
      const raw = row[c.fileIdx] == null ? '' : row[c.fileIdx];
      const reason = validateCellText(raw, c.col);
      if (reason) issues.push({ fileRow, column: c.col.name, raw, reason });
    }
  });

  return { issues };
}

// ---------- 错误行 CSV ----------

function issuesToCsv(issues) {
  const lines = ['file_row,column,reason'];
  for (const i of issues) {
    const esc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    lines.push([String(i.fileRow), i.column, i.reason].map(esc).join(','));
  }
  return lines.join('\n');
}

// ---------- E3 JSON 行规范化 ----------

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * JSON.parse 的产物 → 可导入的行集合。
 *
 * 校验（不是对象数组形态的输入一律抛中文错误，给向导 UI 直接展示）：
 *  - 顶层非对象/数组（数字、字符串、布尔、null）→ 抛错
 *  - 空数组 → 抛错（没有可导入的数据，peek/import 两侧都要这个报错）
 *  - 数组里混入非对象项 → 抛错并指明第几项
 *
 * keys 的稳定排序：首个对象的键序优先，后续对象的新键按首次出现顺序追加。
 * 🔴 渲染层 peek（前 50 个对象）与 worker（全量对象）必须推出【同序】的键 ——
 *    该算法对子集求出的键序是全量键序的前缀，位置映射才不会错位。改算法前先想清楚这点。
 */
function normalizeJsonRows(parsed) {
  let arr;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (isPlainObject(parsed)) {
    arr = [parsed]; // 单对象包成 [obj]，允许单行导入
  } else {
    throw new Error('JSON 导入需要对象或对象数组（顶层应为 {...} 或 [...]）');
  }
  if (arr.length === 0) {
    throw new Error('JSON 数组为空，没有可导入的数据');
  }
  for (let i = 0; i < arr.length; i++) {
    if (!isPlainObject(arr[i])) {
      throw new Error(`第 ${i + 1} 项不是 JSON 对象，无法按行导入`);
    }
  }
  const keys = [];
  const seen = new Set();
  for (const obj of arr) {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return { rows: arr, keys };
}

/** JSON 值 → 表格文本（对齐 validateCellText 的字符串入参口径） */
function jsonCellText(v) {
  if (v === null || v === undefined) return '';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean') return String(v);
  return JSON.stringify(v); // 嵌套对象/数组保真为 JSON 文本
}

// ---------- E5 失败行重跑 ----------

/**
 * 规整 retryRows：去重 + 升序，越界/非整数丢弃。
 * totalRows 是数据行总数（不含表头）；返回空数组表示没有有效行
 * （worker 侧约定：入参缺省才等于"全部行"，规整后为空按空处理）。
 */
function filterRetryRows(totalRows, retryRows) {
  if (!Array.isArray(retryRows)) return [];
  const set = new Set();
  for (const n of retryRows) {
    // 严格只收整数 number（IPC 类型就是 number[]；字符串数字等脏值一律丢弃，不做隐式转换）
    if (typeof n !== 'number' || !Number.isInteger(n)) continue;
    if (n < 0 || n >= totalRows) continue; // 越界忽略
    set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// ---------- SQL 脚本语句分割（运行 SQL 脚本） ----------

/** 状态常量：普通 / 单引号串 / 双引号串 / 反引号标识符 / 行注释 / 块注释 / 条件注释(/*!...*\/，内容要发服务器) */
const ST_NORMAL = 0;
const ST_SQ = 1;
const ST_DQ = 2;
const ST_BT = 3;
const ST_LINE_COMMENT = 4;
const ST_BLOCK_COMMENT = 5;
const ST_COND_COMMENT = 6;

/** 单条语句缓冲上限：mysqldump 的 extended-insert 单条可到几 MB，64MB 已远超正常脚本 */
const MAX_STATEMENT_BYTES = 64 * 1024 * 1024;

/** DELIMITER 指令检测窗口：指令行很短，64 字节足够，避免对整段文本做正则 */
const DELIM_WINDOW = 64;

/**
 * 构造流式 SQL 语句分割器 —— 按块喂入文本（大文件不整读），产出完整语句。
 *
 * 对齐 mysql CLI / Navicat「运行 SQL 文件」的语义：
 *  - 语句以分隔符结束（默认 ';'；行首 DELIMITER 指令可改写 —— 存储过程/触发器脚本依赖）
 *  - 引号（' " `）内的分隔符、注释符不生效；'' "" `` 双写与 \' 反斜杠为转义（反引号内只有双写）
 *  - `-- `（MySQL 要求后跟空白）、`#` 行注释与 `/* *\/` 块注释内的分隔符不生效
 *  - 条件注释 /*!nnnn ... *\/ 是【发给服务器的内容】，不是注释 —— mysqldump 头部全靠它
 *  - DELIMITER 指令仅在「行首 + 当前语句为空」时生效，与 mysql CLI 一致
 *
 * 跨块安全：peek 越界（引号转义/多字符分隔符/注释判定需要看后续字符）时把
 * 尾部留给下次 push，不会在块边界误判 —— 用例见 index.test.ts 的流式分块断言。
 *
 * @param {(sql: string, line: number) => void} onStatement 产出回调（sql 已 trim，line 为语句起始行 1 基）
 */
function createStatementSplitter(onStatement) {
  let state = ST_NORMAL;
  let delimiter = ';';
  let buf = '';
  let stmtHasContent = false; // 当前语句缓冲是否已有实质内容（跳过前导空白/注释行）
  let line = 1; // 当前行号（1 基），全状态统一计数
  let stmtLine = 1; // 当前语句起始行
  let atLineStart = true; // normal 态：是否处于「新行语句起始」（DELIMITER 判定用）
  let pending = ''; // 上次 push 末尾 peek 不足的尾巴，下次 push 拼回
  let eof = false;
  let eofFlushing = false; // flush 处理尾巴时置位：peek 越界按文本结束处理

  // normal 态快进：正则定位「边界字符」，之间的大段文本零逐字符处理
  let boundaryRe = buildBoundaryRe(delimiter);

  function emit() {
    const sql = buf.trim();
    buf = '';
    stmtHasContent = false;
    if (sql.length > 0) onStatement(sql, stmtLine);
  }

  /** 语句缓冲追加：从空到非空时记下语句起始行（注释/空行后的行号要准确）；统一护栏 */
  function bufAppend(s) {
    if (!stmtHasContent && hasNonBlank(s)) stmtLine = line;
    if (!stmtHasContent && s.length > 0) stmtHasContent = hasNonBlank(s);
    buf += s;
    if (buf.length > MAX_STATEMENT_BYTES) throwTooLong();
  }

  function buildBoundaryRe(d) {
    // ' " ` - # / 换行 + 分隔符首字符（正则元字符要转义）
    const first = d.charAt(0).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`['"\`\\-#/\\n${first}]`, 'g');
  }

  function throwTooLong() {
    throw new Error(`单条语句超过 ${Math.round(MAX_STATEMENT_BYTES / 1024 / 1024)}MB，脚本疑似异常，已中止`);
  }

  /** 是否处于最终 flush（peek 越界按文本结束处理，不再留尾巴） */
  function atEof() {
    return eofFlushing;
  }

  function push(text) {
    if (eof) throw new Error('分割器已结束，不能再 push');
    if (pending) {
      text = pending + text;
      pending = '';
    }
    const n = text.length;
    let i = 0;

    while (i < n) {
      const ch = text[i];

      if (state === ST_NORMAL) {
        if (ch === '\n') {
          line++;
          atLineStart = true;
          bufAppend('\n');
          i++;
          continue;
        }

        // 行首且语句为空 → 检查 DELIMITER 指令（mysql CLI 语义；容忍 \r\n 行尾）
        if (atLineStart && !stmtHasContent && !isBlankOrEol(ch)) {
          const win = text.slice(i, Math.min(n, i + DELIM_WINDOW));
          const m = /^DELIMITER[ \t]+(\S+)[ \t]*(?=\r|\n|$)/i.exec(win);
          if (m) {
            // 指令必须完整落在窗口内（窗口截断的匹配不可信）→ 跨块尾巴留到下次
            if (m[0].length === win.length && !atEof()) {
              pending = text.slice(i);
              return;
            }
            delimiter = m[1];
            boundaryRe = buildBoundaryRe(delimiter);
            const j = i + m[0].length;
            if (j >= n && !atEof()) {
              pending = text.slice(i);
              return;
            }
            i = j; // 换行留给统一分支计数
            continue;
          }
          // 行还没结束（窗口内无换行且已到块尾）→ 不能断定这行不是 DELIMITER，等下个块
          if (!atEof() && i + win.length === n && !/[\r\n]/.test(win)) {
            pending = text.slice(i);
            return;
          }
          atLineStart = false;
        }

        // 快进：定位下一个边界字符
        boundaryRe.lastIndex = i;
        const m = boundaryRe.exec(text);
        let end = m ? m.index : n;
        // 行首候选态（语句之间）：快进只吞空白 —— 第一个非空白字符必须交给
        // 分支链做 DELIMITER 指令判定，一旦被快进吞进语句缓冲就永远认不出了
        if (atLineStart && !stmtHasContent) {
          let k = i;
          while (k < end && isBlankOrEol(text[k]) && text[k] !== '\n') k++;
          end = k;
        }
        if (end > i) {
          bufAppend(text.slice(i, end));
          i = end;
          if (!m) {
            // 候选态截断的尾巴（尚未判定是否 DELIMITER 行）留给下次 push
            if (i < n) {
              pending = text.slice(i);
              return;
            }
            break;
          }
          continue; // 回顶部刷新 ch，再以边界字符走下面的分支链
        }

        const c = text[i];

        if (c === delimiter.charAt(0)) {
          // 完整分隔符匹配；多字符分隔符跨块时留尾巴
          if (i + delimiter.length > n && !atEof()) {
            pending = text.slice(i);
            return;
          }
          if (text.startsWith(delimiter, i)) {
            emit();
            i += delimiter.length;
            continue;
          }
          bufAppend(c);
          i++;
          continue;
        }

        if (c === '-' || c === '/') {
          // 注释判定需要 peek 2 字符；第三字符可能在块尾 → 留尾巴
          if (i + 2 >= n && !atEof()) {
            pending = text.slice(i);
            return;
          }
          const c2 = text[i + 1] ?? '';
          if (c === '-' && c2 === '-' && isBlankOrEol(text[i + 2] ?? '')) {
            // MySQL 语义：`-- ` 后跟空白才是注释（1--2 是双负号表达式）
            state = ST_LINE_COMMENT;
            i += 2;
            continue;
          }
          if (c === '/' && c2 === '*') {
            // 第三字符（是否条件注释）恰在块边界 → 留尾巴等下个块判定
            if (i + 2 >= n && !atEof()) {
              pending = text.slice(i);
              return;
            }
            if ((text[i + 2] ?? '') === '!') {
              // 条件注释 /*!nnnn ... */：内容要发给服务器，进专用态（其中 -- # 不是注释）
              state = ST_COND_COMMENT;
              bufAppend('/*!');
              i += 3;
            } else {
              state = ST_BLOCK_COMMENT;
              i += 2;
            }
            continue;
          }
        }

        if (c === '#') {
          // MySQL 行注释（# 到行尾）；boundaryRe 已把 # 列为边界字符
          state = ST_LINE_COMMENT;
          i++;
          continue;
        }

        if (c === "'" || c === '"' || c === '`') {
          state = c === "'" ? ST_SQ : c === '"' ? ST_DQ : ST_BT;
          bufAppend(c);
          i++;
          continue;
        }

        // 普通字符（含空白）：进语句缓冲
        bufAppend(c);
        i++;
        continue;
      }

      if (state === ST_SQ || state === ST_DQ || state === ST_BT) {
        const quote = state === ST_SQ ? "'" : state === ST_DQ ? '"' : '`';
        // 反斜杠转义（反引号内不存在 —— MySQL 标识符只有双写转义）
        if (ch === '\\' && state !== ST_BT) {
          if (i + 1 >= n && !atEof()) {
            pending = text.slice(i);
            return;
          }
          bufAppend(text.slice(i, i + 2));
          // 被转义的字符若恰是换行，同样要计数
          if ((text[i + 1] ?? '') === '\n') line++;
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (i + 1 >= n && !atEof()) {
            pending = text.slice(i);
            return;
          }
          if (text[i + 1] === quote) {
            bufAppend(quote + quote); // 双写转义
            i += 2;
            continue;
          }
          state = ST_NORMAL;
        }
        if (ch === '\n') line++;
        bufAppend(ch);
        i++;
        continue;
      }

      if (state === ST_LINE_COMMENT) {
        if (ch === '\n') {
          state = ST_NORMAL;
          line++;
          bufAppend('\n');
          atLineStart = true;
        }
        i++;
        continue;
      }

      if (state === ST_BLOCK_COMMENT) {
        if (ch === '*' && i + 1 >= n && !atEof()) {
          pending = text.slice(i);
          return;
        }
        if (ch === '*' && text[i + 1] === '/') {
          state = ST_NORMAL;
          atLineStart = false;
          i += 2;
          continue;
        }
        if (ch === '\n') line++;
        i++;
        continue;
      }

      // ST_COND_COMMENT：条件注释体，除结束符 */ 外全部进语句缓冲
      if (ch === '*' && i + 1 >= n && !atEof()) {
        pending = text.slice(i);
        return;
      }
      if (ch === '*' && text[i + 1] === '/') {
        state = ST_NORMAL;
        atLineStart = false;
        bufAppend('*/');
        i += 2;
        continue;
      }
      if (ch === '\n') line++;
      bufAppend(ch);
      i++;
    }
  }

  function flush() {
    eofFlushing = true;
    if (pending) {
      const tail = pending;
      pending = '';
      // eofFlushing 已置位：peek 越界按文本结束处理，不会再产生 pending
      push(tail);
    }
    eof = true;
    emit();
    eofFlushing = false;
  }

  return {
    push,
    flush,
    /** 当前分隔符（DELIMITER 指令可改写；调试与提示用） */
    get delimiter() {
      return delimiter;
    },
    get line() {
      return line;
    },
  };
}

function isBlankOrEol(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function hasNonBlank(s) {
  for (let i = 0; i < s.length; i++) {
    if (!isBlankOrEol(s[i])) return true;
  }
  return false;
}

/**
 * 脚本语句分类（扫描摘要用）。
 * 'session' 收纳 SET/USE/SELECT 等「不改动数据与结构」的语句；drop-db 单独返回 —— UI 要走第三层确认。
 */
function classifyScriptStatement(sql) {
  // mysqldump 语句常以条件注释开头（/*!40101 SET ... */）：剥掉再看首词
  const s = sql.replace(/^\/\*!\d*\s*/, '').toUpperCase();
  if (/^DROP\s+(DATABASE|SCHEMA)\b/.test(s)) return 'drop-db';
  if (/^(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/.test(s)) return 'ddl';
  if (/^(INSERT|UPDATE|DELETE|REPLACE|LOAD|MERGE|CALL)\b/.test(s)) return 'dml';
  if (/^(SET|USE|LOCK|UNLOCK|START|BEGIN|COMMIT|ROLLBACK|FLUSH|ANALYZE|OPTIMIZE|CHECK|REPAIR|DESCRIBE|SHOW|SELECT|EXPLAIN)\b/.test(s)) {
    return 'session';
  }
  return 'other';
}


// ========== v0.6.0：连续 INSERT 合并（实现源在此，insert-merge.ts 是薄封装） ==========
/** 语句里出现即禁止合并的构造（大小写不敏感，作用于整条语句） */
const FORBIDDEN = [
  /\bon\s+duplicate\b/i,   // 重跑幂等语义
  /\bon\s+conflict\b/i,    // 同上（MariaDB/PG 兼容语法）
  /\breturning\b/i,        // 返回结果集的行会被静默丢弃
  /\bwith\b/i,             // 前置 CTE，结构上不可直接拼
];

/**
 * 剥掉开头与内嵌的 `/*! ... *\/` 条件注释（mysqldump 的版本门控）。
 * 只影响"判定"，不改写语句本体 —— 合并时仍用原文，避免动到数据。
 */
function stripConditionalComments(sql) {
  return sql.replace(/\/\*!\d*\s*/g, ' ').replace(/\*\//g, ' ');
}

/** 单个表名片段：带引号的（可含任意字符）或裸标识符 */
const IDENT_SEG = "(?:`[^`]*`|\"[^\"]*\"|\\[[^\\]]*\\]|[^\\s.(]+)";

/**
 * 🔴 解析策略：**分段**而不是一条大正则。
 *
 * 第一版用一条正则同时吃「表名 + 列清单 + VALUES」，结果每一段都在抢：
 * 贪婪的列名模式把 ` (a) VALUES (1)` 一起吞掉，VALUES 组恒为空，
 * 表现为"所有 INSERT 都判不出可合并"—— 修复静默失效，还很难看出是正则的问题。
 *
 * 分段后每一步都能单独判成败：
 *  1. 先按 VALUES 关键字切头尾（VALUES 之前的部分必然是「表名 (列清单)」）
 *  2. 再从头部里解析表名与列清单
 * 任何一步不像就整体不合并 —— 退回逐条执行，功能永远正确。
 */
const INSERT_HEAD_RE =
  /^INSERT\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\s+)*INTO\s+([\s\S]+?)\s+VALUES\s+([\s\S]+)$/i;

/** 头部「表名 (列清单)」：列清单用惰性 + 尾部锚定，允许内部含括号 */
const TARGET_RE = new RegExp(
  `^(${IDENT_SEG}(?:\\.${IDENT_SEG})*)\\s*\\(([\\s\\S]*)\\)\\s*$`,
);

/**
 * 解析一条 INSERT，判断能否参与合并。
 *
 * @returns mergeable=false 时其余字段无意义，调用方应退回逐条执行
 */
function parseInsertShape(rawSql) {
  const none = { mergeable: false, database: '', table: '', columns: [], valuesClause: '' };
  if (!rawSql) return none;

  // 分号会让拼接后变成多语句：交给上层去处理，别在这里蒙混
  if (rawSql.includes(';')) return none;

  const sql = stripConditionalComments(rawSql).trim();
  if (FORBIDDEN.some((re) => re.test(sql))) return none;

  const head = INSERT_HEAD_RE.exec(sql);
  if (!head) return none;

  const values = head[2].trim();
  if (!values) return none;

  // INSERT ... SELECT：行数未知，拼上去就错了
  if (/^\s*SELECT\b/i.test(values)) return none;

  const target = TARGET_RE.exec(head[1].trim());
  if (!target) return none;

  /**
   * 拆库名与表名。
   *
   * 🔴 不能用 lastIndexOf('.') 切：反引号标识符里可以合法含点与空格
   *    （`my.db`.`weird table`），按最后一个点切会拿到残缺的库名；
   *    库名判错就可能把两个不同库的 INSERT 判成"可合并"—— 跨库串数据。
   *    这里按标识符分段（点只作分隔符，不出现在引号内部）。
   */
  const segments = target[1].match(new RegExp(IDENT_SEG, 'g')) || [];
  const unquote = (t) => t.replace(/^[`"[]/, '').replace(/[`"\]]$/, '');
  const database = segments.length >= 2 ? unquote(segments[segments.length - 2]).toLowerCase() : '';
  const table = unquote(segments[segments.length - 1] ?? '').toLowerCase();
  if (!table) return none;

  const columns = target[2]
    .split(',')
    .map((c) => c.trim().replace(/^[`"']|[`"']$/g, '').toLowerCase())
    .filter((c) => c.length > 0);
  // 没有列清单的 INSERT（INSERT INTO t VALUES (...)）不参与合并：
  // 列名对不上就无法安全判定同构，只能靠猜测 —— 猜错就是数据错位。
  if (columns.length === 0) return none;

  // values 必须是「(…),(…)…」形态；出现括号外的裸内容说明不是纯 VALUES 列表
  if (!/^\(/.test(values)) return none;

  return {
    mergeable: true,
    database,
    table,
    columns,
    valuesClause: values,
  };
}

/**
 * 判断两条 INSERT 能否合并到同一条语句里。
 *
 * 口径：同库同表 + 列清单完全一致（个数与顺序）。
 * 列顺序不同就拒绝 —— 合并后第二行的值会落进错误的列，这是数据损坏。
 */
function canMergeWith(prev, next) {
  if (!prev.mergeable || !next.mergeable) return false;
  if (prev.database !== next.database) return false;
  if (prev.table !== next.table) return false;
  if (prev.columns.length !== next.columns.length) return false;
  for (let i = 0; i < prev.columns.length; i++) {
    if (prev.columns[i] !== next.columns[i]) return false;
  }
  return true;
}

/**
 * 表标识符片段（单个名字，可带引号且允许内部空格与点）：
 *   `my.db`.`weird table` 的每一段各自匹配。
 *
 * 🔴 裸标识符分支刻意排除 `.` 与 `(`（不含引号时不允许这两个字符），
 *    否则表名模式会越过"表名 (列清单)"的分界把列清单一起吞掉。
 */

/**
 * 把两条已判定可合并的 INSERT 拼成一条。
 *
 * 🔴 只做两件事：把上条的 VALUES 尾部逗号接起来、把新条目的括号列表追加。
 *    一个字符的语义解释都不做 —— 任何"顺手优化一下引号"都是自找数据损坏。
 *
 * 头部从原文按「VALUES 之前」切出，库表名的引号写法（`my-db`.`weird table`）
 * 原样保留 —— 这正是第一版用 `[^\\s(]+` 写表名时踩的坑：
 * 表名里带空格会被提前截断，拼接结果丢掉整组新值（静默数据损坏）。
 */
/**
 * 把两条已判定可合并的 INSERT 拼成一条。
 *
 * 🔴🔴 【2026-10-13 修复数据丢失】这里曾把 **已有N 组的语句再合并时丢掉前面全部组**，
 * 表现为「脚本 50000 行 INSERT，实际只落 30~50 行」而 UI 显示执行成功。
 *
 * ## 缺陷机制（保留记录：这是本项目最隐蔽的一类错）
 *
 *   旧实现：`head = prevSql.slice(0, 第一个VALUES)` + ` prevShape.valuesClause`
 *
 *   而 `prevShape` 是**调用方持有的上一条 shape**，不是 prevSql 重新解析的结果。
 *   worker 里的用法是：
 *     pending.sql   = mergeTwoInsert(pending.sql, pending.shape, shape)
 *     pending.shape = **没有更新**   ← 致命
 *   于是第二次合并时：
 *     prevSql  = "... VALUES (1),(2)"      （已含 2 组）
 *     prevShape= { valuesClause: "(1)" }   （仍是最初那1 组）
 *     head     = 第一个 VALUES 之前        （正确）
 *     结果= head + "(1)" + ", (3)"  = 只有 2 组 → **第 2 组被静默丢弃**
 *   再合并一次又回到 2 组，于是每批恒定只剩最后 2 组 ——与真机 observed 完全吻合。
 *
 * ## 修复口径
 *
 * 不信任外部传入的 prevShape，而是**从 prevSql 自身切出头部**再拼：
 *   result = head + " VALUES " + [prevSql 的全部值组] + ", " + [next 的值组]
 *
 * 这样合并是**幂等**的：无论 prevSql 已经合并了多少组，都完整保留。
 * 「拆头部」与「拆值组」用同一个正则，两处判定永远自洽（不会再各写一份而漂移）。
 *
 * ⚠️ 仍然刻意**不解释任何字面量**：只按括号配对切分字符串外的括号，
 *    引号内的括号/逗号原样保留（`'a)b,c'` 这类数据不会被切错）。
 */
function splitInsertHeadAndValues(sql) {
  const cleaned = sql.replace(/\/\*!\d*\s*/g, ' ');
  //头部：第一个「不在引号内」的 VALUES 关键字之前
  const at = /\s+VALUES\s+/i.exec(stripLiterals(cleaned));
  if (!at) return null;
  const head = cleaned.slice(0, at.index).replace(/\s+$/, '');
  const rest = cleaned.slice(at.index + at[0].length).trim();
  if (!rest.startsWith('(')) return null;
  return { head, values: splitTopLevelValueGroups(rest) };
}

/** 把字符串字面量替换成等长空格，使正则只在「代码区」生效（不改变长度，索引仍对得上） */
function stripLiterals(sql) {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === '\\') { out += '  '; i++; continue; }
      if (ch === quote) { quote = null; out += ch; continue; }
      // 字面量内部一律抹成空格：VALUES 关键字只可能在代码区
      out += ch === quote ? ch : ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * 按括号配对切分 VALUES 列表：'(a),(b)' → ['(a)', '(b)']
 * 只认括号外的逗号，引号内的括号与逗号原样保留。
 */
function splitTopLevelValueGroups(list) {
  const groups = [];
  let depth = 0, start = -1, quote = null;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { if (depth === 0) start = i; depth++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) { groups.push(list.slice(start, i + 1)); start = -1; }
      continue;
    }
    if (ch === ',' && depth === 0) continue;
  }
  return groups;
}

function mergeTwoInsert(prevSql, prevShape, nextShape) {
  const parts = splitInsertHeadAndValues(prevSql);
  const prevGroups = parts ? parts.values : [prevShape.valuesClause];
  const head = parts ? parts.head : prevSql.replace(/\s*$/, '');
  // 防御：prevSql 切不出值组时退回调用方给的 shape，绝不凭空造组
  const groups = prevGroups.length > 0 ? prevGroups : [prevShape.valuesClause];
  const nextGroups = splitTopLevelValueGroups(nextShape.valuesClause);
  const tail = nextGroups.length > 0 ? nextGroups : [nextShape.valuesClause];
  return `${head} VALUES ${[...groups, ...tail].join(', ')}`;
}

/** 合并后的语句大小上限（MB）。超过就先把已攒的刷出去，避免拼出超大语句 */
const MERGED_INSERT_MAX_BYTES = 4 * 1024 * 1024;

/** 单批最多合并多少条 —— 给错误定位留出可读的粒度，也限制内存占用 */
const MERGED_INSERT_MAX_ROWS = 500;

module.exports = {
  parseDelimited,
  stripBom,
  utf8BomLength,
  sniffEncoding,
  decodeBytes,
  normalizeEncoding,
  sniffDelimiter,
  guessMapping,
  cellTextToValue,
  buildInsertBatches,
  validatePreview,
  issuesToCsv,
  validateCellText,
  normalizeJsonRows,
  jsonCellText,
  filterRetryRows,
  createStatementSplitter,
  classifyScriptStatement,
  parseInsertShape,
  canMergeWith,
  mergeTwoInsert,
  MERGED_INSERT_MAX_ROWS,
  MERGED_INSERT_MAX_BYTES,
};
