/**
 * T32：文本度量（字符数 / 行数）—— 纯函数。
 *
 * ## 口径（本项目选 **Unicode 码点** 作为「字符数」）
 *
 * 三个候选口径的差别在 emoji 与组合字符上一眼可见：
 *
 *  | 文本        | 码点 | UTF-16 code unit (String.length) | UTF-8 字节 |
 *  |-------------|------|----------------------------------|------------|
 *  | `a😀b`      | 3    | 4（代理对占两个 unit）           | 6          |
 *  | `é`（预组合）| 1   | 1                                | 2          |
 *  | `e\u0301`   | 2    | 2                                | 3          |
 *
 * 选码点的理由：用户口中的「多少个字符」指的是眼睛看到的字符数，也就是码点
 * （emoji 算 **1**）。用 `String.length` 会让「一个 emoji 顶两个字符」，
 * 用户在别处数出来的数字对不上。
 *
 * 🔴 但**两者都要显示**：写回 MySQL 时按字符集算的是字节/UTF-16 长度（`VARCHAR(10)`
 *    在 utf8mb4 下按字符算，在 ucs2 口径的客户端里按 UTF-16 unit 算），只给一个数字
 *    会让「为什么提示超长」变成玄学。所以 UI 同时给两个，并且各自标口径名。
 *
 * 🔴 实现不许用 `[...s].length`：那会把整串摊成一个数组（几十 MB 的长文本直接炸内存）。
 *    这里一遍 scan 数代理对，零分配（在长文本编辑器的每次击键路径上也不能分配）。
 */

export interface TextMetrics {
  /** 「字符数」主口径：Unicode 码点数（emoji 算 1） */
  codePoints: number;
  /** UTF-16 code unit 数（等于 `String.prototype.length`） */
  utf16Units: number;
  /** 行数：CRLF / CR / LF 都算一个换行；空串为 0 行 */
  lines: number;
}

/**
 * 数一遍搞定三件事。
 *
 * 代理对识别：0xD800–0xDBFF 是高位代理，紧随其后的 0xDC00–0xDFFF 是低位代理，
 * 二者合起来**只算一个码点**（孤立代理 agent 也算一个码点 —— 那是损坏的文本，
 * 但也不该被数成两个字符之外的东西，这里按「一个 code unit 一个码点」兜底）。
 */
export function measureText(s: string): TextMetrics {
  let codePoints = 0;
  let lines = 0;
  const n = s.length;
  let i = 0;
  let sawChar = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) {
      lines++;
      i++;
      sawChar = true;
      continue;
    }
    if (c === 0x0d) {
      // CRLF 算一个换行；单独 CR 也算一个
      if (i + 1 < n && s.charCodeAt(i + 1) === 0x0a) i++;
      lines++;
      i++;
      sawChar = true;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    codePoints++;
    i++;
    sawChar = true;
  }
  return {
    codePoints,
    utf16Units: n,
    // 空串 = 0 行（写在页面上「空」比「1 行」更不容易被误读成"有一行内容"）
    lines: sawChar ? lines + 1 : 0,
  };
}

/** UI 文案：两个口径都带口径名，不让用户猜 */
export function formatTextMetrics(m: TextMetrics): string {
  const parts = [`${m.codePoints.toLocaleString('en-US')} 字符（码点）`, `UTF-16 长度 ${m.utf16Units.toLocaleString('en-US')}`];
  if (m.lines > 0) parts.push(`${m.lines.toLocaleString('en-US')} 行`);
  return parts.join(' · ');
}
