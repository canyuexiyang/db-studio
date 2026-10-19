/**
 * T41：SQL 文件的读与写 —— 编码探测 / 回退 / 外部覆盖冲突判定 / 原子写。
 *
 * 为什么单独一个文件（而不是塞进 ipc-handlers.ts）：
 *  这四块是 T41 里**最容易写错、又最难靠手点复现**的部分 ——
 *  手点只能造出 UTF-8 无 BOM 这一种输入，GBK 文件与「外部已改」几乎造不出来。
 *  抽成不依赖 electron 的纯模块后可以在 node 下直接单测（dialog 留在 ipc-handlers）。
 *
 * 两条硬约束：
 *  1. **不新增运行时依赖**：编码全部交给 Node 自带的 TextDecoder（官方构建带完整
 *     ICU，`gb18030` / `big5` / `utf-16be` 都可用，实测见 sql-file.test.ts）。
 *     引入 iconv 这类包既破体积预算又是纯属多余。
 *  2. **读不崩、写不覆盖**：读不出 UTF-8 要有明确回退与中文说明，绝不返回乱码；
 *     写之前必须先 stat 比对，发现被外部改过就**不写**（先发现再写）。
 */

import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { ERROR_CODES } from '../shared/ipc-channels.js';
import type { SqlFileStamp } from '../shared/ipc-channels.js';

/** 编辑器不是用来开大文件的：超过 8MB 明确拒绝，别把 UI 拖死 */
export const SQL_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 识别出的编码。
 *
 * `utf-8-bom` 单独成一档：它影响保存策略（写回时不写 BOM），
 * 也影响 UI 提示文案 —— 与「无 BOM 的干净 UTF-8」用户观感一样，处理却不同。
 */
export type SqlFileEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'latin1';

export interface DecodedSqlFile {
  text: string;
  encoding: SqlFileEncoding;
  /** 是否由 BOM 直接判定（有 BOM 就不需要猜） */
  bom: boolean;
  /**
   * 是否走了回退路径。
   *
   * 🔴 只要 fallback=true，UI 就**必须**把 `note` 展示出来 ——
   *    静默按别的编码解码等于给用户看一份可能不对的文件，比报错更糟。
   */
  fallback: boolean;
  /** 中文说明（null = 无需打扰用户） */
  note: string | null;
}

export const ENCODING_LABELS: Record<SqlFileEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8（带 BOM）',
  'utf-16le': 'UTF-16LE',
  'utf-16be': 'UTF-16BE',
  gb18030: 'GB18030',
  latin1: 'Latin-1',
};

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// ---------- 编码探测 ----------

function startsWith(bytes: Uint8Array, head: number[]): boolean {
  if (bytes.length < head.length) return false;
  for (let i = 0; i < head.length; i++) {
    if (bytes[i] !== head[i]) return false;
  }
  return true;
}

/** 严格解码：任何非法字节序列都返回 null（宽松解码会把错的东西静默变成 U+FFFD） */
function strictDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 无 BOM 的 UTF-16 判据。
 *
 * 只看前 64 字节的 NUL 分布：ASCII 文本在 UTF-16LE 下是 `61 00 62 00`，
 * 即**奇数下标**全 0；BE 则相反。判据刻意要求命中 ≥2 次 —— 单个 NUL 可能是
 * 二进制杂散字节，两个以上才是编码特征。
 */
function guessBomlessUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 64) - (Math.min(bytes.length, 64) % 2);
  if (n < 4) return null;
  let le = 0;
  let be = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i + 1] === 0 && bytes[i] !== 0) le++;
    if (bytes[i] === 0 && bytes[i + 1] !== 0) be++;
  }
  if (le >= 2 && le > be) return 'utf-16le';
  if (be >= 2 && be > le) return 'utf-16be';
  return null;
}

/**
 * 解码一段 SQL 文件字节。
 *
 * 判定顺序（每一步都有明确的下一步兜底，不存在「解不出来」的分支）：
 *  ① BOM 直判（UTF-8 / UTF-16LE / UTF-16BE）→ 最可靠，不猜；
 *  ② 严格 UTF-8（且不含 NUL）→ 常态路径；
 *  ③ 无 BOM 的 UTF-16 特征 → 按 LE/BE 解（Windows 导出的脚本常见）；
 *  ④ GB18030 → 覆盖 GBK/GB2312，中文老文件的绝大多数；
 *  ⑤ Latin-1 → 逐字节一对一，**永不失败**的兜底（可能显示为乱码，但已在 note 里说明）。
 */
export function decodeSqlBytes(bytes: Uint8Array): DecodedSqlFile {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', bom: false, fallback: false, note: null };

  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8-bom',
      bom: true,
      fallback: false,
      note: null,
    };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
      bom: true,
      fallback: false,
      note: null,
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf-16be',
      bom: true,
      fallback: false,
      note: null,
    };
  }

  const utf8 = strictDecode(bytes, 'utf-8');
  // NUL 在 UTF-8 里合法（0x00），但 SQL 文本里出现它几乎只可能是 UTF-16 被误读
  if (utf8 !== null && !utf8.includes('\u0000')) {
    return { text: utf8, encoding: 'utf-8', bom: false, fallback: false, note: null };
  }

  const bomless = guessBomlessUtf16(bytes);
  if (bomless !== null) {
    const text = strictDecode(bytes, bomless) ?? new TextDecoder(bomless).decode(bytes);
    return {
      text,
      encoding: bomless,
      bom: false,
      fallback: true,
      note: `文件没有 BOM，但字节特征像 ${ENCODING_LABELS[bomless]}，已按它解码`,
    };
  }

  const gb = strictDecode(bytes, 'gb18030');
  if (gb !== null) {
    return {
      text: gb,
      encoding: 'gb18030',
      bom: false,
      fallback: true,
      note: '文件不是 UTF-8，已按 GB18030（兼容 GBK / GB2312）解码；保存后会写成 UTF-8',
    };
  }

  return {
    text: new TextDecoder('latin1').decode(bytes),
    encoding: 'latin1',
    bom: false,
    fallback: true,
    note: '文件既不是 UTF-8 也不是 GB18030，已按 Latin-1 逐字节解码（内容可能是乱码，请先确认原编码再保存）',
  };
}

// ---------- 冲突判定 ----------

export type ExternalChange = 'none' | 'changed' | 'missing';

/**
 * 保存前先问一句「这个文件还是我上次看到的那个吗」。
 *
 * @param baseline 打开 / 上次保存时记下的戳（null = 没有基线，不比较）
 * @param current  此刻 stat 到的戳（null = 文件已经不在了）
 *
 * 🔴 为什么 size 也要比：mtime 在某些文件系统（含部分网络盘/同步盘）上精度只有
 *    1 秒，同一秒内被覆盖会漏判；size 是独立的第二证据。两者都相同才认为没变。
 */
export function detectExternalChange(
  baseline: SqlFileStamp | null | undefined,
  current: SqlFileStamp | null,
): ExternalChange {
  if (baseline === null || baseline === undefined) return 'none';
  if (current === null) return 'missing';
  if (Math.floor(baseline.mtimeMs) !== Math.floor(current.mtimeMs)) return 'changed';
  if (baseline.size !== current.size) return 'changed';
  return 'none';
}

/**
 * 写回前的提醒（null = 不用打扰）。
 *
 * 只有「原文不是 UTF-8」才提醒：UTF-8 无 BOM 与带 BOM 之间互转无信息损失，
 * 而 UTF-16 / GB18030 / Latin-1 写回 UTF-8 是**真的换了一套字节**，必须说明。
 */
export function writeBackNote(encoding: SqlFileEncoding): string | null {
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return null;
  return `原文件是 ${ENCODING_LABELS[encoding]}，保存后将按 UTF-8 写回（字节会与原文不同）`;
}

// ---------- 实际 IO ----------

export interface SqlFileReadResult extends DecodedSqlFile {
  path: string;
  stamp: SqlFileStamp;
}

/** 读一个 SQL 文件（含编码探测）。路径不存在 / 不是文件 / 过大都会抛出带 code 的错误 */
export async function readSqlFile(path: string): Promise<SqlFileReadResult> {
  const st = await stat(path).catch(() => null);
  if (st === null) throw coded(ERROR_CODES.NOT_FOUND, `文件不存在：${path}`);
  if (!st.isFile()) throw coded(ERROR_CODES.VALIDATION, `不是文件：${path}`);
  if (st.size > SQL_FILE_MAX_BYTES) {
    throw coded(ERROR_CODES.VALIDATION, `文件超过 ${Math.floor(SQL_FILE_MAX_BYTES / 1024 / 1024)}MB，编辑器打不开这么大的脚本`);
  }
  const buf = await readFile(path);
  return { ...decodeSqlBytes(buf), path, stamp: { mtimeMs: st.mtimeMs, size: st.size } };
}

/** 取文件戳（文件不存在返回 null —— 与 detectExternalChange 的 'missing' 对应） */
export async function statSqlFile(path: string): Promise<SqlFileStamp | null> {
  const st = await stat(path).catch(() => null);
  return st === null ? null : { mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * 原子写：先写同目录临时文件再 rename。
 *
 * 为什么不用 writeFile 直写：写一半失败（磁盘满 / 权限）会留下一个**半截文件**，
 * 而它的 mtime 又比原文件新 —— 下一次保存的冲突判定还会因此误判。rename 在
 * 同一目录内是原子的，要么全成功要么原文件不动。
 *
 * 写回一律 UTF-8 无 BOM（编码提示由 writeBackNote 交给 UI 说明）。
 */
export async function writeSqlFile(path: string, text: string): Promise<SqlFileStamp> {
  const tmp = `${path}.dbstudio-${process.pid}.tmp`;
  const bytes = new TextEncoder().encode(text);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  const st = await stat(path);
  return { mtimeMs: st.mtimeMs, size: st.size };
}
