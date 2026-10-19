/**
 * 单表（带筛选）导出的 SQL 构造（T07/R08）。
 *
 * 抽成纯函数的原因：标识符转义失败是**静默的** —— 手拼反引号遇到名字里含
 * 反引号/空格/Unicode 时，要么拼出语法错误的 SQL，要么拼出一个**指向别的表**的
 * 合法 SQL。这种缺陷只有把「构造」这一层单独钉住才好回归。
 */

import { joinIdentifiers, quoteQualified } from '@dbstudio/core-sql-ident';

/**
 * 构造「单表 + 筛选」导出的 SELECT。
 *
 * @param database  库名
 * @param tableName 表名
 * @param where     已由 core-filter 生成的 WHERE 子句（不含 `WHERE` 关键字）
 * @returns SQL 文本；where 为空返回 null（无筛选不重建 SQL）
 * @throws IdentifierError 库/表名非法（空 / 超长 / 含 NUL）
 */
export function buildFilteredExportSql(database: string, tableName: string, where: string): string | null {
  const w = where.trim();
  if (!w) return null;
  return `SELECT * FROM ${quoteQualified([database, tableName])} WHERE ${w}`;
}

/**
 * 构造「单表 + 显式列清单（+ 可选筛选）」的导出 SELECT（T40 仅可见列）。
 *
 * 为什么不复用 buildFilteredExportSql：那个函数的 `SELECT *` 会把整表列都查回来，
 * 列裁剪就落到 worker 的输出阶段 —— 而 worker 的列清单只用于表头，行仍是全列，
 * 结果就是表头比数据短。列裁剪必须在 SQL 层完成，列名走 core-sql-ident。
 *
 * @param columns 要导出的列名（顺序即输出顺序）
 * @returns 永远返回 SQL 文本（无筛选时不带 WHERE）
 * @throws Error 列清单为空（`SELECT  FROM ...` 是语法错误）
 * @throws IdentifierError 库/表/列名非法
 */
export function buildColumnScopedExportSql(
  database: string,
  tableName: string,
  where: string,
  columns: readonly string[],
): string {
  if (columns.length === 0) throw new Error('没有可导出的列');
  const selectList = joinIdentifiers([...columns]);
  const w = where.trim();
  return `SELECT ${selectList} FROM ${quoteQualified([database, tableName])}${w ? ` WHERE ${w}` : ''}`;
}
