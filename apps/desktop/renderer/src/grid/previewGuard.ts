/**
 * 保存预演的第三层保护判定（P0-5）。
 *
 * 背景：删表/DDL 走 `danger/DangerConfirmModal`（第三层：生产环境必须手输表名），
 * 而网格删行/批量更新走的是 `grid/SavePreviewModal` —— 两轨制，删行这条**最不可逆**
 * 的路径反而只过普通预览。本模块把「这一批语句在生产连接上要不要再输一次表名」
 * 做成纯函数，App 只消费结论，判定不散落在 UI 里。
 *
 * 🔴 为什么是纯函数：这条判定的错误方向是「该拦没拦」（数据事故），
 *    必须能用单测在**错误输入**上钉住（无 WHERE 的 UPDATE / 非生产库的 DELETE）。
 */

export interface PreviewStatementLike {
  /** 完整 SQL 原文（可能带 `-- 描述\n` 前缀，见 core-mutation 的 summary 出口） */
  sql: string;
  /** 语句种类；缺省时从 SQL 首关键字推断 */
  kind?: 'insert' | 'update' | 'delete';
}

/** 去掉连续的 `-- 注释行`，取真正的首个关键字 */
export function leadingKeyword(sql: string): string {
  let s = (sql ?? '').trimStart();
  while (s.startsWith('--')) {
    const nl = s.indexOf('\n');
    if (nl < 0) return '';
    s = s.slice(nl + 1).trimStart();
  }
  const m = /^([A-Za-z]+)/.exec(s);
  return m ? m[1].toLowerCase() : '';
}

/** SQL 里是否含 WHERE 子句（本项目的写语句不含字符串字面量之外的干扰，按整串判即可） */
export function hasWhereClause(sql: string): boolean {
  return /\bwhere\b/i.test(sql ?? '');
}

function kindOf(st: PreviewStatementLike): 'insert' | 'update' | 'delete' | null {
  if (st.kind) return st.kind;
  const kw = leadingKeyword(st.sql);
  return kw === 'insert' || kw === 'update' || kw === 'delete' ? kw : null;
}

/**
 * 这批语句要不要升级为「输表名」确认。
 *
 * 规则（审计 P0-5）：
 *  - 非生产连接 → null（保持既有普通预览，不额外加摩擦）
 *  - 生产连接 + 任一 DELETE → 表名（删行是生产库上最高频也最不可逆的动作）
 *  - 生产连接 + 任一无 WHERE 的 UPDATE → 表名（等价于全表覆盖）
 *  - 其余（INSERT / 带 WHERE 的 UPDATE）→ null
 */
export function previewRequiresText(
  statements: readonly PreviewStatementLike[],
  opts: { isProduction: boolean; tableName: string },
): string | null {
  if (!opts.isProduction) return null;
  if (!opts.tableName) return null;
  for (const st of statements) {
    const kind = kindOf(st);
    if (kind === 'delete') return opts.tableName;
    if (kind === 'update' && !hasWhereClause(st.sql)) return opts.tableName;
  }
  return null;
}
