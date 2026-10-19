/**
 * 保存预演：把绑定参数回填进 SQL 文本（**仅用于展示**，绝不用于执行）。
 *
 * ## 🔴 T06/R07：为什么不能 `sql.replace(/\?/g, ...)`
 *
 * `?` 是占位符，但也是合法出现在**字符串字面量、标识符、注释**里的普通字符：
 *
 *   - `UPDATE t SET note = 'why?' WHERE id = ?`   ← 第一个 `?` 在字符串里
 *   - ``SELECT `col?x` FROM t WHERE id = ?``       ← 反引号标识符里
 *   - `-- 这里有个 ? 说明\nUPDATE ...`              ← 注释里
 *
 * 无差别替换会把它们也当成占位符，于是**预览的占位符数量与真实绑定参数对不上**，
 * 展示出来的 SQL 与将要执行的 SQL 语义不同 —— 而预演的全部意义就是让用户
 * 「看到的＝要执行的」。所以这里做词法扫描，只替换**代码位置**的 `?`。
 *
 * 字符串/标识符/注释里的内容逐字保留（含逃逸与二次引号）。
 */

/** 二进制参数（BLOB）在预览里的字面量形式：`X'AB'` */
function hexLiteral(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0').toUpperCase();
  return `X'${s}'`;
}

/** 把单个参数渲染成 SQL 字面量（**仅供预览**） */
function renderParam(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return hexLiteral(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  // 字符串：单引号按 SQL 规则翻倍
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** MySQL 行注释：`--` 后必须跟空白/行尾（否则 `5--3` 会被误当注释） */
function isLineCommentDashDash(sql: string, i: number): boolean {
  if (sql[i] !== '-' || sql[i + 1] !== '-') return false;
  const after = sql[i + 2];
  return after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r';
}

export function fillParams(sql: string, params: unknown[]): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  let k = 0;
  while (i < n) {
    const c = sql[i];

    if (c === '?') {
      if (k < params.length) {
        out.push(renderParam(params[k++]));
      } else {
        // 占位符比绑定参数多 → 保留 `?`，让不一致**可见**（不能悄悄填 NULL 骗人）
        out.push('?');
      }
      i++;
      continue;
    }

    // 字符串 / 标识符：单引号、双引号、反引号
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out.push(c);
      i++;
      while (i < n) {
        const ch = sql[i];
        if (ch === '\\') {
          out.push(ch);
          if (i + 1 < n) out.push(sql[i + 1]);
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            // 二次引号转义：'' / "" / `` 都表示字面量本身
            out.push(ch, ch);
            i += 2;
            continue;
          }
          out.push(ch);
          i++;
          break;
        }
        out.push(ch);
        i++;
      }
      continue;
    }

    // 行注释：# 或 -- （到行尾）
    if (c === '#' || isLineCommentDashDash(sql, i)) {
      while (i < n && sql[i] !== '\n') {
        out.push(sql[i]);
        i++;
      }
      continue;
    }

    // 块注释：/* ... */
    if (c === '/' && sql[i + 1] === '*') {
      out.push('/*');
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out.push(sql[i]);
        i++;
      }
      if (i < n) {
        out.push('*/');
        i += 2;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}

/** 统计 SQL 中**代码位置**的占位符数量（预览用；与绑定参数比对发现不一致） */
export function countPlaceholders(sql: string): number {
  const sentinel = '\u0000';
  // 借 fillParams 的扫描：给每个占位符喂一个哨兵参数，数哨兵出现次数
  const filled = fillParams(sql, Array.from({ length: 4096 }, () => sentinel));
  let count = 0;
  let idx = filled.indexOf(sentinel);
  while (idx !== -1) {
    count++;
    idx = filled.indexOf(sentinel, idx + 1);
  }
  return count;
}
