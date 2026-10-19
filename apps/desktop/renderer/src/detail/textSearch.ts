/**
 * T32 / T35：**可取消**的纯文本查找（状态机，纯函数，无 React / DOM 依赖）。
 *
 * ## 为什么要自己写而不用 `RegExp`
 *
 *  ① 用户输入的查询串里必然会出现 `.` `*` `(` `[` `\` 这些正则元字符 ——
 *     直接 `new RegExp(query)` 要么抛错，要么查的是另一回事（最坏的情况是
 *     「用户输入 `a*b` 匹配到了 `b`」，静默错误）。要转义对，却仍背着编译成本。
 *  ② 正则一次跑到底，**没法中途取消**。而本弹窗要能在几十 MB 的单值上搜索
 *     （MySQL `longtext` 上限 4GB，虽然实际不会那么大），卡住主线程就是假死。
 *
 * 所以是「带着游标的状态机」：每帧只扫 `budgetChars` 个字符，调用方（UI）用
 * `setTimeout(tick, 0)` 续跑，点「停止」或 Esc 就把 `cancelled` 置真停掉。
 * 状态和推进是纯函数 → 单测可覆盖「命中 / 无命中 / 可取消 / 截断」四条路径。
 *
 * ## 已知限制（如实写明）
 *
 * 大小写不敏感匹配只做 **ASCII 折叠**（A–Z ↔ a–z）。非 ASCII 的大小写折叠
 * （如 `İ`、`ﬀ`、`Σ/ς`）需要 Unicode 大小写清单，为 8 个caselib 表付出依赖体积
 * 不值得（红线：不新增运行时依赖）。这里宁可明示受限，也不假装支持之后给错结果。
 */

export interface FindQuery {
  /** 待查找文本；空串 = 不搜（返回 done 且零命中） */
  text: string;
  /** 默认 false = 不区分大小写（ASCII 折叠） */
  caseSensitive?: boolean;
}

export interface SearchState {
  /** 已扫描到的下标（下一次从这里续跑） */
  cursor: number;
  /** 命中的起始下标，升序、互不重叠 */
  matches: number[];
  /** 扫描完毕（或命中数已达上限） */
  done: boolean;
  /** 用户取消 —— 之后的 runSearch 一律原样返回 */
  cancelled: boolean;
  /** 命中数达到 maxMatches 被截断（此时也是 done，但结果不完整） */
  truncated: boolean;
  /** 已扫描字符数（用于「40%」这种进度） */
  scanned: number;
}

export const SEARCH_INITIAL_STATE: SearchState = Object.freeze({
  cursor: 0,
  matches: Object.freeze([]) as unknown as number[],
  done: false,
  cancelled: false,
  truncated: false,
  scanned: 0,
});

/** 命中数上限：够大（跳转用不完），够小（不会因为几十万命中而卡住 UI） */
export const DEFAULT_MAX_MATCHES = 5000;

/** 比较两个字符是否相等（可选 ASCII 大小写折叠） */
function charEq(a: number, b: number, fold: boolean): boolean {
  if (a === b) return true;
  if (!fold) return false;
  return foldAscii(a) === foldAscii(b);
}

function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** 已取消 state 的构造（UI 点「停止」时用 —— 不原地修改，便于 React 状态更新） */
export function cancelSearch(state: SearchState): SearchState {
  if (state.done || state.cancelled) return state;
  return { ...state, cancelled: true };
}

/**
 * 推进搜索。
 *
 * @param budgetChars 本次调用最多扫多少字符（分块的核心；传 Infinity = 一次跑完）
 * @returns 新的状态对象（纯函数；已 done / 已 cancelled 时原样返回）
 */
export function runSearch(
  haystack: string,
  query: FindQuery,
  state: SearchState,
  budgetChars: number,
  maxMatches: number = DEFAULT_MAX_MATCHES,
): SearchState {
  if (state.done || state.cancelled) return state;

  const needle = query.text;
  if (needle.length === 0) {
    return { cursor: haystack.length, matches: [], done: true, cancelled: false, truncated: false, scanned: haystack.length };
  }
  if (budgetChars <= 0) return state;

  const fold = query.caseSensitive !== true;
  const n = haystack.length;
  const nl = needle.length;
  const n0 = needle.charCodeAt(0);

  const matches = state.matches.slice();
  let i = state.cursor;
  let scanned = state.scanned;
  let truncated = state.truncated;
  let done = false;

  const lastStart = n - nl;
  let budget = budgetChars;

  while (i <= lastStart && budget > 0) {
    budget--;
    scanned++;
    if (charEq(haystack.charCodeAt(i), n0, fold)) {
      let hit = true;
      for (let k = 1; k < nl; k++) {
        if (!charEq(haystack.charCodeAt(i + k), needle.charCodeAt(k), fold)) {
          hit = false;
          break;
        }
      }
      if (hit) {
        matches.push(i);
        if (matches.length >= maxMatches) {
          truncated = true;
          i += nl;
          done = true;
          break;
        }
        // 非重叠匹配：命中后整体跳过这一段（与「查找下一个」的心理模型一致）
        i += nl;
        continue;
      }
    }
    i++;
  }

  if (!done && i > lastStart) done = true;

  return { cursor: i, matches, done, cancelled: false, truncated, scanned };
}

/**
 * 一次性跑完（文本小到可以直接同步跑时用）。
 *
 * 🔴 调用方必须自己判定阈值 —— 大文本用这个会卡住主线程。
 */
export function findAllMatches(haystack: string, query: FindQuery, maxMatches: number = DEFAULT_MAX_MATCHES): SearchState {
  return runSearch(haystack, query, SEARCH_INITIAL_STATE, Number.POSITIVE_INFINITY, maxMatches);
}
