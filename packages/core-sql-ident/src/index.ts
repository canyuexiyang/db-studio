/**
 * MySQL 标识符转义与字面量安全构造
 *
 * ⚠️ 为什么单独成一个零依赖包：
 * 原本它在 `core-driver-mysql` 里，但渲染层（网格/筛选器）也需要转义列名，
 * 一 import 就把 **mysql2 整个拖进浏览器 bundle**（Vite 构建实测：会拉进
 * stream/tls/crypto/zlib 等 Node 内置模块，全部 externalize 报错）。
 * 标识符转义是纯字符串逻辑，根本不需要驱动 —— 抽出来，两边都不背依赖。
 *
 * 规则：
 *  1. 标识符（库/表/列名）只能用反引号包裹 + 内部反引号加倍；
 *     没有"转义"能救带 0x00 或超长的名字，遇到就直接拒绝。
 *  2. 用户输入的值【一律用 ? 占位参数绑定】，绝不拼进 SQL 文本。
 *     本文件不提供"值转义"函数，就是为了防止有人拿它拼字符串。
 */

/** MySQL 标识符最大长度 */
const MAX_IDENT_LEN = 64;

export class IdentifierError extends Error {
  constructor(public readonly identifier: string, reason: string) {
    super(`非法标识符 ${JSON.stringify(identifier)}：${reason}`);
    this.name = 'IdentifierError';
  }
}

/**
 * 校验并转义单个标识符。
 * @throws IdentifierError 名字为空 / 超长 / 含 NUL 字符
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new IdentifierError(String(name), '不能为空');
  }
  if (name.length > MAX_IDENT_LEN) {
    throw new IdentifierError(name, `超过 MySQL 标识符上限 ${MAX_IDENT_LEN} 字符`);
  }
  if (name.includes('\0')) {
    throw new IdentifierError(name, '包含 NUL 字符');
  }
  return `\`${name.replace(/`/g, '``')}\``;
}

/** 转义 "db.table" 形式的限定名（也接受数组） */
export function quoteQualified(name: string | string[]): string {
  const parts = Array.isArray(name) ? name : name.split('.');
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new IdentifierError(String(name), '限定名格式错误');
  }
  return parts.map(quoteIdentifier).join('.');
}

/**
 * 安全地把列名列表拼进 SQL（如 SELECT 列表、WHERE 条件左侧）。
 * 值永远不要走这里 —— 值用 ? 占位。
 */
export function joinIdentifiers(names: string[], sep = ', '): string {
  return names.map(quoteIdentifier).join(sep);
}

/**
 * 生成 INSERT 模板（C3：右键表/结果集 → 生成 INSERT 语句）。
 *
 * 形态：`INSERT INTO `db`.`t` (`c1`, `c2`) VALUES (?, ?);\n`（带尾换行，编辑器里直接可续写）。
 *
 *  1. 标识符（库/表/列）一律走包内既有转义函数 —— 反引号加倍是防注入最后一道，绝不手拼；
 *     非法名字（空/超长/含 NUL）直接抛 IdentifierError，fail-closed。
 *  2. 值占位用 `?`：模板由用户填参后执行，本包不提供也不应该提供"值转义"。
 *  3. 无列时返回空串 —— 没有列信息时生成 `INSERT INTO t () VALUES ()` 这种垃圾只会误导用户。
 */
export function insertTemplate(
  database: string | null,
  table: string,
  columns: { name: string }[],
): string {
  if (!columns || columns.length === 0) return '';
  const target = database
    ? `${quoteIdentifier(database)}.${quoteIdentifier(table)}`
    : quoteIdentifier(table);
  const cols = joinIdentifiers(columns.map((c) => c.name));
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${target} (${cols}) VALUES (${placeholders});\n`;
}
