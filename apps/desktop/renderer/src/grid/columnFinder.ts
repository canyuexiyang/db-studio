/**
 * 列列表快速定位（V20）—— 纯逻辑部分，不依赖 React/DOM，可离线单测。
 *
 * 场景：宽表 80 列，用户想跳到 `customer_address_id`，横向滚半天。
 * 给一个 ⌘F12 浮层，敲几个字母就能命中（浮层见 ColumnQuickFinder.tsx）。
 *
 * 匹配规则分四档，档位之间**永远不互相跨越**（见 SCORE_BAND_* 的间隔）：
 *   ① 前缀   created_at  输入 cre      —— 最像"我要找它"
 *   ② 子串   created_at  输入 ated
 *   ③ 首字母 created_at  输入 ca       —— 缩写，下划线/驼峰分词后取词首
 *   ④ 模糊   created_at  输入 crdat    —— 子序列，兜底
 *
 * 排序必须**稳定**：同分时按原列序（表结构里列的顺序是用户熟悉的顺序，
 * 不能因为打分抖动让列表每次敲一个键就重排）。
 */

import type { ColumnMeta } from '@dbstudio/core-schema-cache';

export interface ColumnHit {
  column: ColumnMeta;
  /** 分数，越大越靠前 */
  score: number;
  /** 命中字符在 column.name 中的下标（升序），用于高亮；空输入时为 [] */
  matches: number[];
}

/** 默认返回条数上限：列再多，一屏也只看得下几十条 */
export const DEFAULT_COLUMN_HIT_LIMIT = 50;

/**
 * 四档基础分。
 *
 * 档间隔 300，而"段内微调"最多加 90（见 scoreOf），所以**微调绝不可能把
 * 一条子串匹配顶到一条前缀匹配前面** —— 档位是硬保证，不是靠调参凑出来的。
 */
const SCORE_BAND_PREFIX = 1000;
const SCORE_BAND_SUBSTRING = 700;
const SCORE_BAND_ACRONYM = 400;
const SCORE_BAND_SUBSEQUENCE = 100;

/**
 * ASCII 折小写。
 *
 * 不用 `toLowerCase()`：它在极少数字符上会改变长度（如 'İ'.toLowerCase() 是两个码元），
 * 而命中下标要能直接索引回原字符串做高亮 —— 长度一变，高亮就会错位。
 * 列名是标识符，只处理 A-Z 足够。
 */
function lowerAscii(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/**
 * 计算词首下标：created_at → [0, 8]，customerAddressId → [0, 9, 17]。
 * 驼峰也算词首 —— 不少团队的列名是驼峰，缩写定位对它同样有用。
 */
function wordStarts(name: string): number[] {
  const out: number[] = name.length > 0 ? [0] : [];
  for (let i = 1; i < name.length; i++) {
    const prev = name.charCodeAt(i - 1);
    const cur = name.charCodeAt(i);
    // 分隔符之后必是词首
    if (prev === 95 /* _ */ || prev === 45 /* - */ || prev === 32 /* space */ || prev === 46 /* . */) {
      out.push(i);
      continue;
    }
    // 小→大 的驼峰边界
    if (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90) out.push(i);
  }
  return out;
}

/** 连续下标序列（前缀/子串命中用） */
function range(start: number, len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(start + i);
  return out;
}

/** ③ 首字母缩写：query 的每个字符按顺序对上不同的词首 */
function matchAcronym(lower: string, starts: readonly number[], q: string): number[] | null {
  const hits: number[] = [];
  let si = 0;
  for (let qi = 0; qi < q.length; qi++) {
    while (si < starts.length && lower[starts[si]] !== q[qi]) si++;
    if (si >= starts.length) return null;
    hits.push(starts[si]);
    si++;
  }
  return hits.length > 0 ? hits : null;
}

/** ④ 模糊子序列：字符按顺序出现即可（贪心取最靠前的） */
function matchSubsequence(lower: string, q: string): number[] | null {
  const hits: number[] = [];
  let from = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = lower.indexOf(q[qi], from);
    if (idx < 0) return null;
    hits.push(idx);
    from = idx + 1;
  }
  return hits.length > 0 ? hits : null;
}

/**
 * 段内微调：命中越靠前越好、名字越短越好。
 * 两项加起来最多 90（< 档间隔 300），保证不会跨档。
 */
function scoreOf(band: number, firstIndex: number, nameLen: number, qLen: number): number {
  const front = 60 - Math.min(firstIndex, 60);
  const compact = 30 - Math.min(Math.max(nameLen - qLen, 0), 30);
  return band + Math.max(front, 0) + Math.max(compact, 0);
}

interface Band {
  band: number;
  matches: number[];
}

/** 按 ①②③④ 的顺序试，命中即返回（顺序就是优先级） */
function matchName(lower: string, starts: readonly number[], q: string): Band | null {
  const at = lower.indexOf(q);
  if (at === 0) return { band: SCORE_BAND_PREFIX, matches: range(at, q.length) };
  if (at > 0) return { band: SCORE_BAND_SUBSTRING, matches: range(at, q.length) };

  const acro = matchAcronym(lower, starts, q);
  if (acro) return { band: SCORE_BAND_ACRONYM, matches: acro };

  const sub = matchSubsequence(lower, q);
  if (sub) return { band: SCORE_BAND_SUBSEQUENCE, matches: sub };
  return null;
}

/**
 * 给列打分排序。
 *
 * - query 为空（或只有空白）→ 原顺序的前 limit 条（不打分、不高亮）。
 *   这是"刚打开浮层"的状态：先把列摆出来给用户看，而不是一片空白。
 * - 大小写不敏感。
 * - limit ≤ 0 → 空数组（调用方要"先不要结果"时用）。
 */
export function rankColumns(
  columns: readonly ColumnMeta[],
  query: string,
  limit: number = DEFAULT_COLUMN_HIT_LIMIT,
): ColumnHit[] {
  const src = columns ?? [];
  if (limit <= 0) return [];

  const q = lowerAscii((query ?? '').trim());
  if (q === '') {
    return src.slice(0, limit).map((column) => ({ column, score: 0, matches: [] }));
  }

  const scored: { hit: ColumnHit; index: number }[] = [];
  for (let i = 0; i < src.length; i++) {
    const column = src[i];
    const name = column?.name ?? '';
    if (name.length === 0) continue;

    const lower = lowerAscii(name);
    const m = matchName(lower, wordStarts(lower), q);
    if (!m) continue;

    const first = m.matches.length > 0 ? m.matches[0] : 0;
    scored.push({
      hit: { column, score: scoreOf(m.band, first, name.length, q.length), matches: m.matches },
      index: i,
    });
  }

  // 分数降序；同分按原列序 —— 显式比较 index，不依赖引擎的排序稳定性
  scored.sort((a, b) => b.hit.score - a.hit.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.hit);
}
