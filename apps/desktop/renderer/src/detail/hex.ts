/**
 * HEX 文本视图（A10 既有能力的下沉，纯函数）。
 *
 * 🔴 为什么要单独成文件：`CellValueModal` 要渲染 HEX，`ImageViewer`（T34 的图片↔HEX
 *    切换）也要渲染同一份样式与同样的截断口径。**复制两份就会漂移** ——
 *    一边显示 2KB 一边显示 4KB，用户会在「哪个才是全的」上浪费时间。
 */

/** HEX 视图只展示前 2KB（性能与可读性；完整字节经「保存到磁盘」拿走） */
export const HEX_PREVIEW_BYTES = 2048;

/**
 * 字节 → 十六进制文本，每行 16 字节，空格分隔。
 *
 * @param max 展示上限（按**字节**截断，不是按行）
 */
export function toHexText(b: Uint8Array, max: number = HEX_PREVIEW_BYTES): string {
  const n = Math.min(b.length, max);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const parts: string[] = [];
    for (let j = i; j < Math.min(i + 16, n); j++) {
      parts.push(b[j].toString(16).padStart(2, '0'));
    }
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

/** 展示是否被截断（UI 必须据此给出「这不是完整数据」的显式说明） */
export function isHexTruncated(b: Uint8Array, max: number = HEX_PREVIEW_BYTES): boolean {
  return b.length > max;
}
