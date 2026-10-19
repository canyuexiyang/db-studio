/**
 * 保真的 JSON 美化器（T05 / I03 / 报告 §9.1 第一阶段）。
 *
 * ## 为什么不能用 `JSON.parse` → `JSON.stringify`
 *
 * `JSON.parse` 会把 JSON 数字转成 JS `number`（IEEE-754 双精度）。任何超过 2^53
 * 的整数（如 `9007199254740993`）都会**静默变成另一个数**（`9007199254740992`）。
 * 再 `JSON.stringify` 出去，用户看到/复制到的是被篡改过的值 —— 数据库 GUI 里
 * 这是不能接受的：用户拿它去写回、去比对、去当 ID 用。
 *
 * 所以这里改成**词法级**处理：先分词（字符串 / 数字 / 字面量 / 标点），再做结构
 * 校验与缩进排版，**所有标量原文逐字保留**（数字不经过 Number，字符串里的转义
 * 序列原样输出，重复键不去重）。美化只增删空白，不改变任何 token。
 *
 * ## 与 JSON.parse 的差异（有意为之）
 *
 * - 数字：原样保留字面量（含 `1e3`、`1.500`、超长整数）。
 * - 字符串：不重新转义（`\u00e9` 不会被改写成 `é`）。
 * - 重复键：保留（`JSON.parse` 会丢前者）。
 * - 校验：非法输入返回 `null`，由调用方退回原文展示。
 */

export interface JsonFormatResult {
  /** 美化后的文本；tab 之外只增删空白 */
  pretty: string;
}

type Tok =
  | { t: 'p'; v: '{' | '}' | '[' | ']' | ':' | ',' }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'lit'; v: string };

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** 词法分析。任何非法字符 / 未闭合字符串 → null */
function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      toks.push({ t: 'p', v: c });
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          // 跳过被转义的字符（不解释它，只保证不把 \" 当结束）
          if (i + 1 >= n) return null;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return null;
      toks.push({ t: 'str', v: src.slice(start, i) });
      continue;
    }
    if (c === '-' || isDigit(c)) {
      const start = i;
      if (src[i] === '-') i++;
      if (src[i] === '0') {
        i++;
      } else if (isDigit(src[i])) {
        while (i < n && isDigit(src[i])) i++;
      } else {
        return null;
      }
      if (src[i] === '.') {
        i++;
        if (!isDigit(src[i])) return null;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (!isDigit(src[i])) return null;
        while (i < n && isDigit(src[i])) i++;
      }
      toks.push({ t: 'num', v: src.slice(start, i) });
      continue;
    }
    if (src.startsWith('true', i)) {
      toks.push({ t: 'lit', v: 'true' });
      i += 4;
      continue;
    }
    if (src.startsWith('false', i)) {
      toks.push({ t: 'lit', v: 'false' });
      i += 5;
      continue;
    }
    if (src.startsWith('null', i)) {
      toks.push({ t: 'lit', v: 'null' });
      i += 4;
      continue;
    }
    return null;
  }
  return toks;
}

/**
 * 把 JSON 原文排版成缩进 2 空格的可读文本。
 *
 * @returns 美化结果；非法 JSON → null
 */
export function formatJsonPreserving(src: string): JsonFormatResult | null {
  const toks = tokenize(src);
  if (!toks || toks.length === 0) return null;

  interface Ctx {
    kind: 'obj' | 'arr';
    step: 'key' | 'colon' | 'value' | 'comma' | 'elem';
    empty: boolean;
    /** 刚吃掉一个逗号 → 此时不允许直接闭合（拒绝尾随逗号 `[1,]` / `{"a":1,}`） */
    trailing: boolean;
  }
  const stack: Ctx[] = [];
  const out: string[] = [];
  let i = 0;
  let indent = 0;
  let topDone = false;

  const cur = (): Ctx | undefined => stack[stack.length - 1];

  /** 容器内容项的起始：首个项顺带把缩进推一层 */
  const startItem = (): void => {
    const c = cur();
    if (!c) return;
    if (c.empty) {
      indent++;
      c.empty = false;
    }
    c.trailing = false;
    out.push('\n' + '  '.repeat(indent));
  };

  const openContainer = (v: '{' | '['): void => {
    out.push(v);
    i++;
    stack.push({ kind: v === '{' ? 'obj' : 'arr', step: v === '{' ? 'key' : 'elem', empty: true, trailing: false });
  };

  const closeContainer = (v: '}' | ']', c: Ctx): void => {
    if (c.empty) {
      out.push(v);
    } else {
      indent--;
      out.push('\n' + '  '.repeat(indent) + v);
    }
    i++;
    stack.pop();
    if (stack.length === 0) topDone = true;
  };

  while (i < toks.length) {
    const tk = toks[i];
    const c = cur();

    if (!c) {
      // 顶层：只允许一个值
      if (topDone) return null;
      if (tk.t === 'p' && (tk.v === '{' || tk.v === '[')) {
        openContainer(tk.v);
        continue;
      }
      if (tk.t === 'p') return null;
      out.push(tk.v);
      i++;
      topDone = true;
      continue;
    }

    if (c.kind === 'obj') {
      if (c.step === 'key') {
        if (tk.t === 'p' && tk.v === '}') {
          if (c.trailing) return null; // 尾随逗号
          closeContainer('}', c);
          continue;
        }
        if (tk.t !== 'str') return null;
        startItem();
        out.push(tk.v);
        i++;
        c.step = 'colon';
        continue;
      }
      if (c.step === 'colon') {
        if (!(tk.t === 'p' && tk.v === ':')) return null;
        out.push(': ');
        i++;
        c.step = 'value';
        continue;
      }
      if (c.step === 'value') {
        if (tk.t === 'p' && (tk.v === '{' || tk.v === '[')) {
          c.step = 'comma';
          openContainer(tk.v);
          continue;
        }
        if (tk.t === 'p') return null;
        out.push(tk.v);
        i++;
        c.step = 'comma';
        continue;
      }
      // comma
      if (tk.t === 'p' && tk.v === ',') {
        out.push(',');
        i++;
        c.step = 'key';
        c.trailing = true;
        continue;
      }
      if (tk.t === 'p' && tk.v === '}') {
        closeContainer('}', c);
        continue;
      }
      return null;
    }

    // arr
    if (c.step === 'elem') {
      if (tk.t === 'p' && tk.v === ']') {
        if (c.trailing) return null; // 尾随逗号
        closeContainer(']', c);
        continue;
      }
      if (tk.t === 'p' && (tk.v === '{' || tk.v === '[')) {
        c.step = 'comma';
        startItem();
        openContainer(tk.v);
        continue;
      }
      if (tk.t === 'p') return null;
      startItem();
      out.push(tk.v);
      i++;
      c.step = 'comma';
      continue;
    }
    if (tk.t === 'p' && tk.v === ',') {
      out.push(',');
      i++;
      c.step = 'elem';
      c.trailing = true;
      continue;
    }
    if (tk.t === 'p' && tk.v === ']') {
      closeContainer(']', c);
      continue;
    }
    return null;
  }

  if (stack.length !== 0 || !topDone) return null;
  return { pretty: out.join('') };
}

/** 顶部是对象/数组（花括号开头）→ 无论列类型都当 JSON 值处理 */
export function looksLikeJsonContainer(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  return t.startsWith('{') || t.startsWith('[');
}

/** 列类型是否 JSON（MySQL `json` / PG `json`/`jsonb`） */
export function isJsonColumn(dataType: string): boolean {
  return /json/i.test(dataType);
}

/**
 * 判断一个单元格值是否应当走 JSON 美化。
 *
 * 规则（报告 §9.1「合法标量 JSON 不应只因没有花括号就被误判为普通文本」）：
 *  - 花括号/方括号开头 → 直接当 JSON（仍要校验合法）；
 *  - 否则只有**列类型是 JSON** 时才把顶层标量当 JSON —— 否则 VARCHAR 里的
 *    `"42"`、`123` 会被误当 JSON，与普通文本无法区分。
 */
export function shouldTreatAsJson(value: unknown, dataType: string): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t.length === 0) return false;
  return looksLikeJsonContainer(value) || isJsonColumn(dataType);
}

/** 原文疑似 JSON 但超过阈值（只提示不格式化） */
export function looksLikeOversizedJson(value: unknown, dataType: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim().length <= JSON_FORMAT_MAX_CHARS) return false;
  return shouldTreatAsJson(value, dataType);
}

/** >256KB 不格式化（解析 + 高亮都不划算，退回原文） */
export const JSON_FORMAT_MAX_CHARS = 256 * 1024;

/**
 * 单元格 JSON 美化的唯一入口：按阈值 + 列类型决定是否美化。
 *
 * @returns 美化结果；不该美化 / 超阈值 / 非法 JSON → null（调用方退回原文）
 */
export function formatCellJson(value: unknown, dataType: string): JsonFormatResult | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0 || t.length > JSON_FORMAT_MAX_CHARS) return null;
  if (!shouldTreatAsJson(value, dataType)) return null;
  return formatJsonPreserving(t);
}
