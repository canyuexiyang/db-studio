/**
 * T34：图片识别与**按文件头解析像素尺寸**（纯函数，零依赖）。
 *
 * ## 为什么不用 ImageMagick / sharp / image-size
 *
 * ① 红线：不新增运行时依赖、不新建 package。
 * ② 场景根本用不上解码库：我们要的是「这是不是图片 / 什么格式 / 多少像素 /
 *    能不能预览」四件事，全都在**前几十个字节**里。真要解码的是 `<img>`，
 *    而 `<img>` 的解不出来我们用 `onError` 兜（见 ImageViewer）。
 * ③ hex dump 之外还得给出明确的**失败分类** —— 「不是一个图片」和「是一个 PNG 但头坏了」
 *    对用户是两个不同的事实，混成一句「无法显示」等于把线索掐了。
 *
 * ## 四种失败/降级（每条都必须有明确中文原因）
 *
 *  - `not-image`：前若干字节不匹配任何已知魔数 → 直接走 HEX（普通二进制的正常归宿）。
 *  - `truncated-header`：魔数命中，但数据**比该格式的最小头还短** → 连尺寸都读不出来，
 *    一定解码不出来，不再浪费时间构造 data URL，直接 HEX。
 *  - `bad-header`：字节够长，但结构不符（PNG 没有 IHDR / JPEG 没走到 SOF /
 *    WebP 的 fourcc 不认识）→ **仍尝试交给浏览器解码**（万一只是我们解析偏保守），
 *    同时把警告写在界面上，解码失败立刻回退 HEX。
 *  - `too-large`：超过 8MiB 预览阈值 → **不构造 data URL**（btoa 内存翻倍、
 *    预览价值趋零），但**尺寸照解**（只看头部，和总长度无关）。
 *
 * 🔴 阈值是「预览」阈值，**不是存储上限**：无论多大，`bytes` 都保持完整，
 *    「保存到磁盘」始终保存原始字节 —— 绝不能把截断过的东西写出去。
 */

/** >8MiB 不构造 data URL（btoa 内存翻倍，预览价值趋零） */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export type ImageProbeStatus =
  /** 魔数 + 结构都对，尺寸已解出 */
  | 'ok'
  /** 不是已知图片格式（普通二进制） */
  | 'not-image'
  /** 比该格式的最小头还短 —— 一定损坏 */
  | 'truncated-header'
  /** 字节够长但结构不符 —— 尝试解码 + 失败兜底 */
  | 'bad-header';

export interface ImageProbe {
  /** 识别出的 MIME；null = 不是图片 */
  mime: string | null;
  /** 短格式名（PNG / JPEG / GIF / WebP）；未识别为 null */
  label: string | null;
  /** 保存时建议的扩展名；未识别为 null（调用方回 'bin'） */
  ext: string | null;
  status: ImageProbeStatus;
  /** 按文件头解出的宽（px）；解不出为 null */
  width: number | null;
  /** 按文件头解出的高（px）；解不出为 null */
  height: number | null;
  /** 是否超过预览阈值（true ≠ 数据被截断） */
  tooLarge: boolean;
  /** 是否建议构造 data URL 交给 `<img>` 试一次 */
  previewAllowed: boolean;
  /** 失败/降级的中文原因；正常时为 null */
  reason: string | null;
}

type SizeResult =
  | { ok: true; width: number; height: number }
  | { ok: false; status: 'truncated-header' | 'bad-header'; reason: string };

// ---------- 字节读工具（全是大端/小端显式区分，不许猜） ----------

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number): number => ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** 从 offset 起是否等于给定 ASCII 串 */
function asciiAt(b: Uint8Array, offset: number, s: string): boolean {
  if (offset + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (b[offset + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

// ---------- 四种格式 ----------

/** PNG：签名 8 字节 + IHDR（长 4 + "IHDR" + 宽 4 + 高 4）= 24 字节起才有意义 */
const PNG_MIN_HEADER = 24;

function pngSize(b: Uint8Array): SizeResult {
  if (b.length < PNG_MIN_HEADER) {
    return { ok: false, status: 'truncated-header', reason: `PNG 头至少 ${PNG_MIN_HEADER} 字节，实际只有 ${b.length} 字节` };
  }
  if (!asciiAt(b, 12, 'IHDR')) {
    return { ok: false, status: 'bad-header', reason: '魔数是 PNG，但偏移 12 处不是 IHDR 块（格式结构不符）' };
  }
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width === 0 || height === 0) {
    return { ok: false, status: 'bad-header', reason: `IHDR 里的像素尺寸非法（${width}×${height}）` };
  }
  return { ok: true, width, height };
}

/** JPEG 的 SOF 段：0xC0–0xCF，剔除 0xC4(DHT) / 0xC8(JPG 保留) / 0xCC(DAC) */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

/**
 * JPEG：FFD8 之后是一串「FF + 标记 + 段长度」的段，尺寸在第一个 SOF 段里。
 *
 * 为什么不能像 PNG 那样按固定偏移读：JPEG 允许 SOI 之后先插任意多个 APPn / DQT /
 * DHT 段（EXIF、JFIF、缩略图都在这里），宽度必须**逐段跳**才能找到。
 */
function jpegSize(b: Uint8Array): SizeResult {
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      return { ok: false, status: 'bad-header', reason: `偏移 ${i} 处不是 JPEG 标记（期望 0xFF，实际 0x${b[i].toString(16)}）` };
    }
    // 跳过填充字节 FF FF FF …
    let m = i + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) return { ok: false, status: 'truncated-header', reason: 'JPEG 标记后没有剩余字节' };
    const marker = b[m];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = m + 1;
      continue;
    }
    if (marker === 0xda) {
      return { ok: false, status: 'bad-header', reason: '还没到 SOF 就先遇到了 SOS（扫描数据），文件头里没有尺寸段' };
    }
    if (marker === 0xd9) {
      return { ok: false, status: 'bad-header', reason: '还没到 SOF 就先遇到了 EOI（结束标记）' };
    }
    if (m + 3 >= b.length) {
      return { ok: false, status: 'truncated-header', reason: 'JPEG 段长度字段不完整（至少还需要 2 字节）' };
    }
    const segLen = u16be(b, m + 1);
    if (segLen < 2) {
      return { ok: false, status: 'bad-header', reason: `JPEG 段长度非法（${segLen}）` };
    }
    if (isSofMarker(marker)) {
      /**
       * SOF 段内布局（`m` 是标记字节本身的下标）：
       *   b[m] = 标记, b[m+1..m+2] = 段长度, b[m+3] = 精度,
       *   b[m+4..m+5] = 高, b[m+6..m+7] = 宽
       *
       * 🔴 这里曾经写成 +5 / +7（把「段长度两个字节」和「精度一个字节」记混），
       *    结果 640×480 的 JPEG 解出 32769 —— 那不是 640 的移位，而是把
       *    高/宽各错开一个字节后拼出来的垃圾值。断言必须按**像素值**核对，
       *    不能只断言「解出来了、非零」。
       */
      if (m + 7 >= b.length) {
        return { ok: false, status: 'truncated-header', reason: 'SOF 段被截断，读不到宽高' };
      }
      const height = u16be(b, m + 4);
      const width = u16be(b, m + 6);
      if (width === 0 || height === 0) {
        return { ok: false, status: 'bad-header', reason: `SOF 段里的像素尺寸非法（${width}×${height}）` };
      }
      return { ok: true, width, height };
    }
    i = m + 1 + segLen;
  }
  return { ok: false, status: 'truncated-header', reason: '数据结束也没能扫到 SOF 段' };
}

/** GIF：'GIF87a' / 'GIF89a' + 宽 2 + 高 2 = 10 字节最小头 */
function gifSize(b: Uint8Array): SizeResult {
  if (b.length < 10) {
    return { ok: false, status: 'truncated-header', reason: `GIF 头至少 10 字节，实际只有 ${b.length} 字节` };
  }
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  if (width === 0 || height === 0) {
    return { ok: false, status: 'bad-header', reason: `GIF 逻辑屏幕尺寸非法（${width}×${height}）` };
  }
  return { ok: true, width, height };
}

/**
 * WebP：RIFF 容器 + 'WEBP' + 一个子块。
 *  - `VP8 ` 有损：瞬间要 forward to start code 0x9d 0x01 0x2a 后才有 14bit 宽高；
 *  - `VP8L` 无损：签名 0x2f 之后的 32bit 里，低 14 位是宽-1、其次 14 位是高-1；
 *  - `VP8X` 扩展：画布宽/高是 24bit 的 (值-1)。
 */
const WEBP_MIN_HEADER = 12;

function webpSize(b: Uint8Array): SizeResult {
  if (b.length < 16) {
    return { ok: false, status: 'truncated-header', reason: `WebP 头至少 ${WEBP_MIN_HEADER + 4} 字节，实际只有 ${b.length} 字节` };
  }
  if (asciiAt(b, 12, 'VP8 ')) {
    if (b.length < 30) {
      return { ok: false, status: 'truncated-header', reason: `WebP(VP8) 头至少 30 字节，实际只有 ${b.length} 字节` };
    }
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) {
      return { ok: false, status: 'bad-header', reason: 'VP8 帧起始码不是 9d 01 2a，可能不是关键帧或已损坏' };
    }
    const width = u16le(b, 26) & 0x3fff;
    const height = u16le(b, 28) & 0x3fff;
    if (width === 0 || height === 0) {
      return { ok: false, status: 'bad-header', reason: `VP8 帧尺寸非法（${width}×${height}）` };
    }
    return { ok: true, width, height };
  }
  if (asciiAt(b, 12, 'VP8L')) {
    if (b.length < 25) {
      return { ok: false, status: 'truncated-header', reason: `WebP(VP8L) 头至少 25 字节，实际只有 ${b.length} 字节` };
    }
    if (b[20] !== 0x2f) {
      return { ok: false, status: 'bad-header', reason: 'VP8L 签名字节不是 0x2f' };
    }
    const bits = u32le(b, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { ok: true, width, height };
  }
  if (asciiAt(b, 12, 'VP8X')) {
    if (b.length < 30) {
      return { ok: false, status: 'truncated-header', reason: `WebP(VP8X) 头至少 30 字节，实际只有 ${b.length} 字节` };
    }
    const width = u24le(b, 24) + 1;
    const height = u24le(b, 27) + 1;
    if (width === 0 || height === 0) {
      return { ok: false, status: 'bad-header', reason: `VP8X 画布尺寸非法（${width}×${height}）` };
    }
    return { ok: true, width, height };
  }
  return { ok: false, status: 'bad-header', reason: 'RIFF 容器里的 WebP 子类型不是 VP8 / VP8L / VP8X' };
}

interface MagicEntry {
  mime: string;
  label: string;
  ext: string;
  matches(b: Uint8Array): boolean;
  size(b: Uint8Array): SizeResult;
}

const MAGIC: readonly MagicEntry[] = [
  {
    mime: 'image/png',
    label: 'PNG',
    ext: 'png',
    matches: (b) => asciiAt(b, 0, '\x89PNG'),
    size: pngSize,
  },
  {
    mime: 'image/jpeg',
    label: 'JPEG',
    ext: 'jpg',
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    size: jpegSize,
  },
  {
    mime: 'image/gif',
    label: 'GIF',
    ext: 'gif',
    matches: (b) => asciiAt(b, 0, 'GIF8') && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
    size: gifSize,
  },
  {
    mime: 'image/webp',
    label: 'WebP',
    ext: 'webp',
    matches: (b) => asciiAt(b, 0, 'RIFF') && asciiAt(b, 8, 'WEBP'),
    size: webpSize,
  },
];

const NOT_IMAGE_REASON = '前若干字节不匹配 PNG / JPEG / GIF / WebP 的魔数，按普通二进制处理';

/**
 * 识别并解析图片尺寸。
 *
 * 这个函数**从不抛异常**，也**从不修改入参**（`bytes` 是 `Uint8Array` 视图，
 * 调用方可能持有的是 grid 解码出来的原始缓冲 —— 只读处理，保真红线）。
 */
export function probeImage(bytes: Uint8Array): ImageProbe {
  const tooLarge = bytes.length > IMAGE_PREVIEW_MAX_BYTES;
  const base = {
    mime: null,
    label: null,
    ext: null,
    width: null,
    height: null,
    tooLarge,
    previewAllowed: false,
  };

  for (const m of MAGIC) {
    if (!m.matches(bytes)) continue;
    const size = m.size(bytes);
    if (size.ok) {
      return {
        ...base,
        mime: m.mime,
        label: m.label,
        ext: m.ext,
        width: size.width,
        height: size.height,
        status: 'ok',
        previewAllowed: !tooLarge,
        reason: tooLarge
          ? `超过 ${formatBytes(IMAGE_PREVIEW_MAX_BYTES)} 预览阈值，不生成预览（${formatBytes(bytes.length)} 原始数据未截断，保存行为不受影响）`
          : null,
      };
    }
    return {
      ...base,
      mime: m.mime,
      label: m.label,
      ext: m.ext,
      status: size.status,
      // truncated-header 连最小头都不完整 → 不浪费时间构造 data URL；
      // bad-header 只说明**我们的结构解析**不通，浏览器未必失败 → 仍试一次。
      previewAllowed: !tooLarge && size.status === 'bad-header',
      reason: tooLarge
        ? `${size.reason}；且超过 ${formatBytes(IMAGE_PREVIEW_MAX_BYTES)} 预览阈值，不生成预览`
        : size.reason,
    };
  }

  return { ...base, status: 'not-image', reason: NOT_IMAGE_REASON };
}

/** data URL 的 base64：大缓冲分块拼，避免 String.fromCharCode 展开爆栈 */
export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)));
  }
  return btoa(s);
}

/**
 * 构造 data URL。
 *
 * 🔴 调用前必须先看过 `probe.previewAllowed` —— 本函数不拦体积，
 *    巨型缓冲请走 ImageViewer 的超阈值分支（那里明确告诉用户为什么不预览）。
 */
export function imageDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** 字节数的人读格式（二进制1024还是1000一律用 1024，**因为它描述的是字节不是速率**） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
