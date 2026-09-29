/**
 * 表元信息的展示格式化。
 *
 * 为什么单独成一个文件，不放 `index.ts`：
 *
 * `index.ts` 里有 SQL 关键字表、函数表、补全逻辑 —— 那些只有 SQL 编辑器用，
 * 必须留在 lazy chunk 里。而 `tableFacts()` / `formatCount()` 是【详情面板】
 * 要用的，详情面板是首屏组件。
 *
 * 混在一个入口会让详情面板把整个编辑器逻辑拖进首屏 bundle ——
 * 实测就是这么多了 15KB（首屏 271KB → 286KB）。
 * 拆开之后，首屏只为这两个函数付费。
 */

import type { TableMeta } from '@dbstudio/core-schema-cache';

/** 大数加千分位 —— 估算行数动辄千万，不格式化根本读不出量级 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/** 把 TableMeta 摊平成详情面板要显示的键值对 */
export function tableFacts(t: TableMeta): { label: string; value: string }[] {
  return [
    { label: '引擎', value: t.engine ?? '—' },
    { label: '排序规则', value: t.collation ?? '—' },
    { label: '估算行数', value: t.estimatedRows === null ? '—' : formatCount(t.estimatedRows) },
    { label: '字段数', value: String(t.columns?.length ?? 0) },
    { label: '注释', value: t.comment || '—' },
  ];
}
