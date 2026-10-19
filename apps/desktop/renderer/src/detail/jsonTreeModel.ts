/**
 * T35：JSON 折叠树的**纯逻辑**（树构建 / 懒加载子节点 / 展开上限 / 路径生成 / 搜索索引）。
 * UI（`JsonTreeView.tsx`）只负责把这里算出来的行数组渲染成 DOM。
 *
 * ## 路径语义 —— 本项目选定 **RFC 6901 JSON Pointer**（一句话理由写在这，不许漂移）
 *
 * 候选有两个：JSONPath（`$['a'][0]`）与 RFC 6901 JSON Pointer（`/a/0`）。
 *
 * **选 JSON Pointer**：它有唯一确定的转义规则（`~` → `~0`，`/` → `~1`），
 * 任何键名都能无歧义地表达。JSONPath 在点号写法下遇到含空格、点号、中划线
 * 或中文的键（`{"user name": 1}` / `{"a.b": 1}`）必须退化到方括号 + 引号，
 * 而"什么时候加引号"各家实现不一致 —— 复制出去的路径可能在别人的工具里出错，
 * 这正是本任务要消灭的那类静默错误。代价是习惯了 `$.foo` 的用户要适应，
 * 所以 UI 上把路径**显示出来**（可预览）而不是藏在一个 tooltip 后面。
 *
 * 根节点的指针是**空串**（RFC 6901 原文：whole document = ""），UI 显示成「（根）」。
 *
 * ## 懒加载与"不一次建完整 DOM"
 *
 * 树模型**永不预先展开**：`childrenOf()` 只在某个成员真的要显示时才扫它的子树层级。
 * 一次吃动的 DOM 由 `MAX_VISIBLE_JSON_NODES` 卡住 —— 超过就停止继续铺开并把
 * `truncated` 报给 UI（UI 必须显式提示"已达展开上限"，不许悄悄少显示几个节点）。
 *
 * ## 只读
 *
 * 本模块只在源串上做**下标运算**，从不写回任何东西（`slice` 只用来生成展示文本）。
 */

export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonNode {
  /** 唯一 id —— 直接就是 RFC 6901 指针（根节点为 ''） */
  id: string;
  /** RFC 6901 JSON Pointer */
  pointer: string;
  depth: number;
  /** 对象成员的键（已解码）；数组元素为 null */
  key: string | null;
  /** 数组元素下标；对象成员为 null */
  index: number | null;
  kind: JsonNodeKind;
  /** 标量：源文中的原始字面量（不经过 JSON.parse，保真）；容器：`{…}` / `[…]` 摘要 */
  valueText: string;
  hasChildren: boolean;
  start: number;
  /** 尾后下标（不含） */
  end: number;
}

export interface JsonTreeRow {
  node: JsonNode;
  expanded: boolean;
  /** 展开过才知道子项数（懒加载的直接后果）；null = 未展开，不确定有几个 */
  childCount: number | null;
  /**
   * 该行的可搜索文本（构成规则，写死在这里供 UI 与测试对齐）：
   *  - 键（若有）+ 值；
   *  - 标量行 → 值的**原始字面量**；
   *  - 已展开容器 → `{…}` / `[…]` 摘要（子项的内容归各家行自己，避免重复命中）；
   *  - **折叠容器 → 它的原始片段全文**：这样折叠子树内部的内容仍然能被搜到，
   *    命中会高亮到这个可展开的行上，用户据此展开即可。
   */
  ownText: string;
}

export interface FlattenResult {
  rows: JsonTreeRow[];
  /** 命中节点上限被截断 —— UI 必须显式提示，不许静默少渲染 */
  truncated: boolean;
}

/** 单次最多铺开多少行 DOM（虚拟列表不在本期范围内，用上限兜住巨大的 JSON） */
export const MAX_VISIBLE_JSON_NODES = 2000;

// ---------- RFC 6901 ----------

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 子节点的指针：root('') + '/' + token */
export function jsonPointer(parentPointer: string, token: string | number): string {
  const seg = typeof token === 'number' ? String(token) : escapePointerToken(token);
  return `${parentPointer}/${seg}`;
}

// ---------- 源串扫描（全部是下标运算，零分配对象只在需要时产生） ----------

function skipWs(src: string, i: number): number {
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
    else break;
  }
  return i;
}

interface StringSpan {
  /** 尾后下标 */
  end: number;
  /** 解码后的内容 */
  text: string;
}

/**
 * 读一个 JSON 字符串（含引号），返回尾后下标与解码文本。
 *
 * 解码支持 \" \\ \/ \b \f \n \r \t \uXXXX；\u 产生的代理对会被正确拼成一个字符。
 * 遇到非法转义则返回其原字符（尽力而为，不下结论）。
 */
function readStringSpan(src: string, i: number): StringSpan | null {
  if (src[i] !== '"') return null;
  let j = i + 1;
  let out = '';
  let plainStart = i + 1;
  const flushPlain = (to: number): void => {
    if (to > plainStart) out += src.slice(plainStart, to);
  };
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      flushPlain(j);
      const e = src[j + 1];
      if (e === undefined) return null;
      if (e === 'u') {
        const hex = src.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
      } else {
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        out += map[e] ?? e;
        j += 2;
      }
      plainStart = j;
      continue;
    }
    if (c === '"') {
      flushPlain(j);
      return { end: j + 1, text: out };
    }
    j++;
  }
  return null;
}

/** 读一个非字符串的标量（number / true / false / null） */
function readBareValue(src: string, i: number): number | null {
  const c = src[i];
  if (c === 't') return src.startsWith('true', i) ? i + 4 : null;
  if (c === 'f') return src.startsWith('false', i) ? i + 5 : null;
  if (c === 'n') return src.startsWith('null', i) ? i + 4 : null;
  // number: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?  —— 只做结构校验，不做数值转换（保真）
  let j = i;
  if (src[j] === '-') j++;
  if (!/\d/.test(src[j] ?? '')) return null;
  if (src[j] === '0') {
    j++;
  } else {
    while (j < src.length && /\d/.test(src[j])) j++;
  }
  if (src[j] === '.') {
    j++;
    if (!/\d/.test(src[j] ?? '')) return null;
    while (j < src.length && /\d/.test(src[j])) j++;
  }
  if (src[j] === 'e' || src[j] === 'E') {
    j++;
    if (src[j] === '+' || src[j] === '-') j++;
    if (!/\d/.test(src[j] ?? '')) return null;
    while (j < src.length && /\d/.test(src[j])) j++;
  }
  return j;
}

interface ChildSpan {
  key: string | null;
  /** 值片段的起止（对象成员不含键） */
  start: number;
  end: number;
}

/**
 * 扫一个容器的**直属**子项（跨过嵌套容器，不去碰孙子的结构）。
 *
 * @param open '{' 或 '[' 的下标
 * @returns null = 源文在这个范围内不是合法 JSON
 */
function scanChildren(src: string, open: number): { children: ChildSpan[]; end: number } | null {
  const isObj = src[open] === '{';
  const close = isObj ? '}' : ']';
  const children: ChildSpan[] = [];
  let i = skipWs(src, open + 1);
  if (src[i] === close) return { children, end: i + 1 };
  for (;;) {
    if (i >= src.length) return null;
    let key: string | null = null;
    if (isObj) {
      const s = readStringSpan(src, i);
      if (s === null) return null;
      key = s.text;
      i = skipWs(src, s.end);
      if (src[i] !== ':') return null;
      i = skipWs(src, i + 1);
    }
    const end = skipValue(src, i);
    if (end === null) return null;
    children.push({ key, start: i, end });
    i = skipWs(src, end);
    const c = src[i];
    if (c === ',') {
      i = skipWs(src, i + 1);
      if (src[i] === close) return null; // 尾随逗号
      continue;
    }
    if (c === close) return { children, end: i + 1 };
    return null;
  }
}

/** 跳过一个值，返回尾后下标；非法返回 null */
function skipValue(src: string, i: number): number | null {
  const c = src[i];
  if (c === undefined) return null;
  if (c === '{' || c === '[') {
    const r = scanChildren(src, i);
    return r === null ? null : r.end;
  }
  if (c === '"') {
    const r = readStringSpan(src, i);
    return r === null ? null : r.end;
  }
  return readBareValue(src, i);
}

function kindOfValue(src: string, start: number): JsonNodeKind {
  const c = src[start];
  if (c === '{') return 'object';
  if (c === '[') return 'array';
  if (c === '"') return 'string';
  if (c === 't' || c === 'f') return 'boolean';
  if (c === 'n') return 'null';
  return 'number';
}

function summaryOf(kind: JsonNodeKind): string {
  return kind === 'object' ? '{…}' : '[…]';
}

/**
 * 解析顶层 JSON。
 *
 * 非法输入返回 null —— 让调用方退回"原文"视图（**绝不**因为解析失败就丢掉用户的值）。
 */
export function parseJsonRoot(src: string): JsonNode | null {
  const start = skipWs(src, 0);
  if (start >= src.length) return null;
  const end = skipValue(src, start);
  if (end === null) return null;
  if (skipWs(src, end) !== src.length) return null; // 顶层之后还有内容
  const kind = kindOfValue(src, start);
  return {
    id: '',
    pointer: '',
    depth: 0,
    key: null,
    index: null,
    kind,
    valueText: kind === 'object' || kind === 'array' ? summaryOf(kind) : src.slice(start, end),
    hasChildren: kind === 'object' || kind === 'array',
    start,
    end,
  };
}

/**
 * 取某个容器的直属子项（**懒加载**：只有 UI 真的要展开这一层时才走到这里）。
 *
 * 容器同时也是"非法 JSON"的唯一检查点：scanner 在这里发现结构不对就返回空数组，
 * 由 UI 给出提示，不让一次局部的解析失败把整棵树搞崩。
 */
export function childrenOf(src: string, node: JsonNode): JsonNode[] {
  if (!node.hasChildren) return [];
  const r = scanChildren(src, node.start);
  if (r === null) return [];
  const out: JsonNode[] = [];
  for (let idx = 0; idx < r.children.length; idx++) {
    const c = r.children[idx];
    const kind = kindOfValue(src, c.start);
    const isContainer = kind === 'object' || kind === 'array';
    const token = c.key === null ? idx : c.key;
    const pointer = jsonPointer(node.pointer, token);
    out.push({
      id: pointer,
      pointer,
      depth: node.depth + 1,
      key: c.key,
      index: c.key === null ? idx : null,
      kind,
      valueText: isContainer ? summaryOf(kind) : src.slice(c.start, c.end),
      hasChildren: isContainer,
      start: c.start,
      end: c.end,
    });
  }
  return out;
}

/**
 * 按当前的展开集合铺一行/子树层级，铺到 `maxNodes` 行就停。
 *
 * @returns `{ rows, truncated }` —— rows 已是**视觉顺序**（深度优先先序）
 */
export function flattenVisible(
  src: string,
  root: JsonNode,
  expanded: ReadonlySet<string>,
  maxNodes: number = MAX_VISIBLE_JSON_NODES,
): FlattenResult {
  const rows: JsonTreeRow[] = [];
  let truncated = false;
  const frames: { items: JsonNode[]; i: number }[] = [{ items: [root], i: 0 }];

  while (frames.length > 0) {
    const f = frames[frames.length - 1];
    if (f.i >= f.items.length) {
      frames.pop();
      continue;
    }
    if (rows.length >= maxNodes) {
      truncated = true;
      break;
    }
    const node = f.items[f.i++];
    const isExpanded = node.hasChildren && expanded.has(node.id);
    const kids = isExpanded ? childrenOf(src, node) : null;

    let ownText: string;
    if (node.hasChildren) {
      // 折叠容器的原始片段参与搜索（见 ownText 规则注释）
      ownText = isExpanded ? summaryOf(node.kind) : src.slice(node.start, node.end);
    } else {
      ownText = node.valueText;
    }
    if (node.key !== null) ownText = `${node.key} ${ownText}`;

    rows.push({ node, expanded: isExpanded, childCount: kids === null ? null : kids.length, ownText });
    if (kids !== null && kids.length > 0) frames.push({ items: kids, i: 0 });
  }

  return { rows, truncated };
}

/**
 * 初次打开时的默认展开集合：展开 `depth < depthLimit` 的容器，
 * 同时受 `maxNodes` 约束（铺到上限就住手，别把首帧铺成几千行 DOM）。
 */
export function defaultExpanded(
  src: string,
  root: JsonNode,
  depthLimit: number = 2,
  maxNodes: number = MAX_VISIBLE_JSON_NODES,
): Set<string> {
  const out = new Set<string>();
  let count = 0;
  /**
   * 🔴 深度上限必须有：外部 JSON 可以嵌套几万层（`[[[[…]]]]`），递归走下去会爆栈，
   *    而这类输入恰恰是"限制展开节点数"要防的东西。超过就只当叶子处理。
   */
  const MAX_BOOTSTRAP_DEPTH = 100;
  const walk = (node: JsonNode): void => {
    count++;
    if (count > maxNodes) return;
    if (!node.hasChildren || node.depth >= Math.min(depthLimit, MAX_BOOTSTRAP_DEPTH)) return;
    out.add(node.id);
    for (const kid of childrenOf(src, node)) {
      if (count > maxNodes) return;
      walk(kid);
    }
  };
  walk(root);
  return out;
}

// ---------- 搜索索引（T35 的查找复用 T32 的可取消引擎） ----------

export interface RowSearchIndex {
  /** 各行 ownText 用 '\n' 拼成的整串 */
  text: string;
  /** 每行在 text 里的起始 / 尾后偏移 */
  starts: number[];
  ends: number[];
}

/**
 * 把可见行拼成一个可搜索的字符串。
 *
 * 🔴 行数已被 `MAX_VISIBLE_JSON_NODES` 卡住，所以这个索引**大小有界** ——
 *    这正是"不一次建完整 DOM"在搜索这条路径上的等价保证。
 */
export function buildRowSearchIndex(rows: readonly JsonTreeRow[]): RowSearchIndex {
  const starts: number[] = new Array(rows.length);
  const ends: number[] = new Array(rows.length);
  const parts: string[] = new Array(rows.length);
  let at = 0;
  for (let i = 0; i < rows.length; i++) {
    starts[i] = at;
    const t = rows[i].ownText;
    parts[i] = t;
    at += t.length;
    ends[i] = at;
    at += 1; // '\n' 分隔符
  }
  return { text: parts.join('\n'), starts, ends };
}

/** 某个匹配偏移落在哪一行（行号升序）；落在分隔符上返回 -1 */
export function rowOfOffset(idx: RowSearchIndex, offset: number): number {
  let lo = 0;
  let hi = idx.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < idx.starts[mid]) hi = mid - 1;
    else if (offset >= idx.ends[mid]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** 命中偏移 → 去重升序的行号列表（一行的多处命中只算一处，符合"查找下一个节点"的语义） */
export function matchesToRows(idx: RowSearchIndex, matches: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const m of matches) {
    const r = rowOfOffset(idx, m);
    if (r >= 0) seen.add(r);
  }
  return [...seen].sort((a, b) => a - b);
}
