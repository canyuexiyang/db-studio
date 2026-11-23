/**
 * 状态栏结果摘要（0.10.0 P1-06）。
 *
 * 目的：把「多少行 / 是否截断 / 多大 / 多久」放在同一处，避免用户
 * 以为看到的是全量。纯函数便于单测，不依赖 React/DOM。
 */

export interface ResultMetaInput {
  /** 已格式化的行数文案（来自 rowCountBasis，保留「约」/千分位口径） */
  rowsLabel: string;
  /** 列式 payload 的字节数；null = 未知（不编造 0 B） */
  bytes: number | null;
  /** 本次查询耗时（ms）；null = 快照恢复/未知 */
  queryMs: number | null;
  /** 是否被行上限或结果预算截断 */
  truncated: boolean;
}

/** 1024 进制，保留 1 位小数；0 也如实显示 0 B */
export function formatResultBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 结果摘要。顺序固定：行数 → 截断 → 大小 → 耗时。
 * 截断放在大小之前，是因为「这不是全量」比「多大」更重要。
 */
export function resultMetaLabel(input: ResultMetaInput): string {
  const parts: string[] = [input.rowsLabel];
  if (input.truncated) parts.push('已截断');
  if (input.bytes !== null) parts.push(formatResultBytes(input.bytes));
  if (input.queryMs !== null && Number.isFinite(input.queryMs)) parts.push(`${Math.round(input.queryMs)} ms`);
  return parts.join(' · ');
}