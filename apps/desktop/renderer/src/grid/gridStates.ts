/**
 * T47：网格**六种状态**各自的判定与文案（纯逻辑）。
 *
 * ## 为什么要收在一处
 *
 * 报告 §8.2 第 3 条：加载中、加载失败、零行、尚未查询、已截断、已断开，
 * 过去都可能落到同一块空白区域 —— 用户看到「一片白」时无从判断是
 * 「还没查」「查了没有」「查挂了」还是「连接掉了」。四种情况的下一步动作
 * 完全不同（等 / 加筛选 / 看重试 / 重连），共用一块空白等于逼用户猜。
 *
 * 现在：
 *  - 前五种（断开/加载中/失败/未查询/零行）由 `GridStateBlock` 各自渲染，
 *    各有 `data-testid="grid-state-<kind>"`，文案与提示互不重叠；
 *  - **已截断**不是空白态：它发生在「有行」的时候，表现形式是网格下方的
 *    提示条 + 行数口径（`rowCountBasis()` 返回 `truncated`）。
 *
 * ## 优先级（改之前先看）
 *
 * `loading > error`：重试时应当立刻显示加载中，而不是继续挂着上一次的错误。
 * `error > disconnected`：有失败原因时先给原因（原因里通常已经包含连接错误），
 * 只说「已断开」会把可用信息丢掉。
 * `disconnected > 其余`：连接没了，零行/未查询都是次生现象。
 */

export type GridStateKind = 'disconnected' | 'loading' | 'error' | 'idle' | 'empty' | 'ready';

export interface GridStateInput {
  /** 连接当前不可用（未连接 / 已断开 / 握手失败） */
  disconnected: boolean;
  loading: boolean;
  /** 最近一次加载的真实错误文案；null = 没出错 */
  error: string | null;
  /** 是否已经有载荷（null payload 且没在加载 = 尚未查询） */
  hasPayload: boolean;
  rowCount: number;
}

export interface GridState {
  kind: GridStateKind;
  /** 主文案（一句话说清现在是什么状态） */
  title: string;
  /** 次文案（下一步能做什么）；空串 = 不显示 */
  hint: string;
  /** 语义色调，渲染层映射到 CSS 类，避免各处自己拼颜色 */
  tone: 'muted' | 'error' | 'warn' | 'normal';
}

const DISCONNECTED: GridState = {
  kind: 'disconnected',
  title: '连接已断开',
  hint: '重新连接后可直接刷新数据；已提交的改动不受影响。',
  tone: 'warn',
};
const LOADING: GridState = { kind: 'loading', title: '正在加载数据…', hint: '', tone: 'muted' };
const IDLE: GridState = {
  kind: 'idle',
  title: '尚未查询',
  hint: '点「刷新数据」加载这张表的内容。',
  tone: 'muted',
};
const EMPTY: GridState = {
  kind: 'empty',
  title: '这个条件下没有数据',
  hint: '如果加过筛选，试试放宽或清空条件；表为空时可「新增行」。',
  tone: 'muted',
};

export function resolveGridState(input: GridStateInput): GridState {
  if (input.loading) return LOADING;
  if (input.error) {
    return {
      kind: 'error',
      title: '加载失败',
      // 原始错误必须露出来：只说「加载失败」等于让用户去猜
      hint: input.error,
      tone: 'error',
    };
  }
  if (input.disconnected) return DISCONNECTED;
  if (!input.hasPayload) return IDLE;
  if (input.rowCount === 0) return EMPTY;
  return { kind: 'ready', title: '', hint: '', tone: 'normal' };
}

/** 空白态才需要占位块；ready 交回网格自己渲染 */
export function needsStateBlock(state: GridState): boolean {
  return state.kind !== 'ready';
}

export type RowCountBasis = 'none' | 'exact' | 'estimated' | 'truncated';

export interface RowCountInfo {
  basis: RowCountBasis;
  /** 直接可显示的文案；basis === 'none' 时为空串 */
  label: string;
  /** 数字是否可信（估算/截断都不等于真实总数） */
  exact: boolean;
}

/**
 * 行数口径。
 *
 * 报告 §8.2 第 4 条：行数状态要区分**精确 / 估算 / 截断**。
 * 过去状态栏只有一个「约 N 行」，三类数字混在一起，用户会拿估算值去做
 * 「导出的是不是全量」这种判断。
 */
export function rowCountBasis(input: {
  rowCount: number;
  /** information_schema 估算值（不做全表 COUNT） */
  estimated: number | null | undefined;
  truncated: boolean;
  /** 是否已查询（未查询时不给任何数字） */
  hasPayload: boolean;
}): RowCountInfo {
  if (!input.hasPayload) return { basis: 'none', label: '', exact: false };
  const loaded = input.rowCount;
  if (input.truncated) {
    const est = input.estimated;
    const base = `已加载 ${loaded.toLocaleString('zh-CN')} 行`;
    return {
      basis: 'truncated',
      // 截断时必须同时说「还有更多」+ 总数是估算 —— 否则会被读成「全部就这么多」
      label: est != null && est > loaded ? `${base}（已截断，约 ${est.toLocaleString('zh-CN')} 行）` : `${base}（已截断）`,
      exact: false,
    };
  }
  if (input.estimated != null && input.estimated > loaded) {
    return {
      basis: 'estimated',
      label: `约 ${input.estimated.toLocaleString('zh-CN')} 行`,
      exact: false,
    };
  }
  return { basis: 'exact', label: `${loaded.toLocaleString('zh-CN')} 行`, exact: true };
}
