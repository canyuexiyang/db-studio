/**
 * 筛选器的 SQL 预览（§6.3.3）
 *
 * 单独成文件是为了让 App 能拿到「筛选后的完整 SQL」而不必 import 组件，
 * 也顺便把参数顺序这件最容易搞错的事收敛在一处。
 */

import { buildWhere, type FilterModel } from '@dbstudio/core-filter';

export interface OpenTablePreview {
  where: string | null;
  params: unknown[];
  /** 给用户看的可读条件（UI 展示它，不要自己拼一遍） */
  label: string;
}

export function openTableSqlPreview(model: FilterModel | null): OpenTablePreview {
  if (!model) return { where: null, params: [], label: '' };
  const built = buildWhere(model);
  if (!built.sql) return { where: null, params: [], label: '' };
  return { where: built.sql, params: built.params, label: built.preview };
}
