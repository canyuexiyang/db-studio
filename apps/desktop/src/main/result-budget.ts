/**
 * T44：查询结果的**硬预算**（主进程侧，编码前执行）。
 *
 * ## 为什么必须在主进程、在编码前
 *
 * 结果集的内存量级由 **行数 × 平均列宽** 决定（见 `scripts/bench-result-memory.mjs`
 * 实测：166 B/行，10 万行 ≈ 15.9 MB 载荷）。一旦整包 `encodeColumnar` 再走 IPC，
 * 主进程与渲染层会**同时**持有这份数据，渲染层再叠加结构化克隆的峰值。
 * 等到渲染层再砍，内存已经付过了 —— 所以预算必须卡在 encode 之前。
 *
 * ## 为什么按字节而不是只按行数
 *
 * 一次 1000 行的 `SELECT * FROM 日志表`（每行 2MB 的 TEXT）比 20 万行的窄表更大。
 * 只用行数阈值会把最坏情况放过去。
 *
 * ## 不做的事（写在最前面，别误读）
 *
 *  - **不改写用户 SQL**：不注入 LIMIT、不改语义（报告 §10 I23 明确要求）。
 *  - **不做按需取大值**（`SUBSTRING` 回捞）：那需要行定位键与二次查询协议，
 *    本轮不做 —— 见 `docs/devlog` 的 T44 记录。这里只保证「不会因为一次查询
 *    把整个应用顶到 OOM」，并且**如实告诉用户被截断了**。
 *  - 截断**不影响已经拿到的前 N 行**：它们就是服务端返回的真实前 N 行
 *    （顺序由 SQL 的 ORDER BY 决定，无 ORDER BY 时顺序本来就是不保证的）。
 */

/** 行数上限：再多的行在网格里也没人看得完，且虚拟滚动只为可视行付费 */
export const RESULT_ROW_BUDGET = 200_000;
/** 载荷字节上限（编码后的粗估），64MiB ≈ 40 万行 × 166B */
export const RESULT_BYTE_BUDGET = 64 * 1024 * 1024;

export interface ResultBudgetOutcome {
  rows: unknown[][];
  /** 是否发生了截断（UI 必须显示，不得静默） */
  truncated: boolean;
  /** 原始行数（截断前） */
  receivedRows: number;
  /** 估算的编码后字节数（截断前，全量） */
  estimatedBytes: number;
  /** 按什么原因截断；null = 没截断 */
  reason: 'rows' | 'bytes' | null;
}

/** 单值字节估算：字符串按 UTF-8 粗估，Buffer/Uint8Array 按长度，其余按 8 字节 */
function valueBytes(v: unknown): number {
  if (v === null || v === undefined) return 1;
  if (typeof v === 'string') return v.length * 2 + 8; // UTF-16 存储 + 头开销
  if (v instanceof Uint8Array) return v.byteLength + 8;
  if (typeof v === 'number' || typeof v === 'bigint') return 8;
  if (typeof v === 'boolean') return 1;
  if (v instanceof Date) return 16;
  return 16;
}

/**
 * 估算全量结果的编码后字节数。
 *
 * 采样前 200 行 × 全部列：行宽在真实表里通常同分布，采样比全量扫描便宜几个数量级；
 * 采样为空（0 行）时返回 0。
 */
export function estimateResultBytes(rows: unknown[][]): number {
  if (rows.length === 0) return 0;
  const sampleCount = Math.min(rows.length, 200);
  let sampleBytes = 0;
  for (let i = 0; i < sampleCount; i++) {
    const row = rows[i];
    for (let c = 0; c < row.length; c++) sampleBytes += valueBytes(row[c]);
  }
  const avgPerRow = sampleBytes / sampleCount;
  return Math.round(avgPerRow * rows.length);
}

/**
 * 应用预算：超限时**从尾部截断**（保留服务端返回的前 N 行）。
 *
 * 🔴 「从尾部」而不是随便丢：SQL 的 ORDER BY 决定前 N 行是有意义的；
 *    随机抽样会让用户看到「排序正确但行缺失」的错觉。
 */
export function applyResultBudget(
  rows: unknown[][],
  limits: { rowBudget?: number; byteBudget?: number } = {},
): ResultBudgetOutcome {
  const rowBudget = limits.rowBudget ?? RESULT_ROW_BUDGET;
  const byteBudget = limits.byteBudget ?? RESULT_BYTE_BUDGET;
  const receivedRows = rows.length;
  const estimatedBytes = estimateResultBytes(rows);

  let keep = receivedRows;
  let reason: 'rows' | 'bytes' | null = null;

  if (receivedRows > rowBudget) {
    keep = rowBudget;
    reason = 'rows';
  }
  if (estimatedBytes > byteBudget && receivedRows > 0) {
    const avgPerRow = estimatedBytes / receivedRows;
    const byBytes = Math.max(1, Math.floor(byteBudget / avgPerRow));
    if (byBytes < keep) {
      keep = byBytes;
      reason = 'bytes';
    }
  }

  if (reason === null) {
    return { rows, truncated: false, receivedRows, estimatedBytes, reason: null };
  }
  return {
    rows: rows.slice(0, keep),
    truncated: true,
    receivedRows,
    estimatedBytes,
    reason,
  };
}
