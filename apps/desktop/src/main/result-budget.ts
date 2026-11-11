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
 * 计算一组行「编码后字节数」的真实累计值（全量逐行，不再采样外推）。
 *
 * 🔴 0.8.0（P1-3 / #47）修复：旧实现只采样**前 200 行**估算平均行宽再乘总行数。
 *    当大 TEXT/BLOB 集中在**后段**（前 200 行是窄行）时，采样得到的平均行宽严重
 *    偏低，外推出的总字节远低于真实值 —— 64MiB 字节预算形同虚设，最坏情况
 *    （正是预算要防的那种「一次查询把应用顶到 OOM」）被整个放过去。
 *    改为全量真实累计后，多一次 O(n·m) 遍历，但与紧随其后的 `encodeColumnar`
 *    同量级（都要逐格走一遍），换来「预算真的生效」。
 *
 * 注：`valueBytes` 是启发式（不是编码后 buffer 的精确字节），所以结果仍是
 *     「估算」——名字保留 `estimateResultBytes`，但口径已从采样升级为全量真实。
 */
export function estimateResultBytes(rows: unknown[][]): number {
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let c = 0; c < row.length; c++) total += valueBytes(row[c]);
  }
  return total;
}

/**
 * 应用预算：超限时**从尾部截断**（保留服务端返回的前 N 行）。
 *
 * 🔴 「从尾部」而不是随便丢：SQL 的 ORDER BY 决定前 N 行是有意义的；
 *    随机抽样会让用户看到「排序正确但行缺失」的错觉。
 *
 * 🔴 0.8.0（#47）：字节判定改为**单次前向遍历真实累计**，记录「首次压垮字节预算」
 *    的行号作为切点。旧实现用采样平均行宽折算 `floor(byteBudget/avgPerRow)`，
 *    在「前窄后宽」时 avgPerRow 偏小 → 折算出的保留行数偏多 → 截断点太靠后，
 *    实际保留的字节远超预算。现在切点由真实累计决定，预算精确生效。
 */
export function applyResultBudget(
  rows: unknown[][],
  limits: { rowBudget?: number; byteBudget?: number } = {},
): ResultBudgetOutcome {
  const rowBudget = limits.rowBudget ?? RESULT_ROW_BUDGET;
  const byteBudget = limits.byteBudget ?? RESULT_BYTE_BUDGET;
  const receivedRows = rows.length;

  // 单次遍历：真实累计每行字节，并记录第一个「使累计超过字节预算」的行下标。
  let cumulative = 0;
  let byteCutAt = -1; // -1 = 累计始终没超预算
  for (let i = 0; i < receivedRows; i++) {
    const row = rows[i];
    for (let c = 0; c < row.length; c++) cumulative += valueBytes(row[c]);
    if (byteCutAt < 0 && cumulative > byteBudget) byteCutAt = i;
  }
  const estimatedBytes = cumulative; // 现在是全量真实字节累计

  let keep = receivedRows;
  let reason: 'rows' | 'bytes' | null = null;

  if (receivedRows > rowBudget) {
    keep = rowBudget;
    reason = 'rows';
  }
  // 字节预算：保留 byteCutAt **之前**的行（byteCutAt 这一行是压垮预算的那行，不含它）。
  // 至少留 1 行：单行就超预算（如一个 >64MiB 的 BLOB）时无能为力 —— 按需回捞大值
  // 属更深的 SUBSTRING 协议，本轮不做（见文件头「不做的事」），但绝不静默：
  // truncated=true 会如实告知用户结果被截断。
  if (byteCutAt >= 0 && byteCutAt < keep) {
    keep = Math.max(1, byteCutAt);
    reason = 'bytes';
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
