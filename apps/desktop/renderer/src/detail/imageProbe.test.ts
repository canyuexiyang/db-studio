import { describe, it, expect } from 'vitest';
import { probeImage, bytesToBase64, imageDataUrl, formatBytes, IMAGE_PREVIEW_MAX_BYTES } from './imageProbe';
import { toHexText, isHexTruncated, HEX_PREVIEW_BYTES } from './hex';

/**
 * T34 验收样本（任务清单原文）：透明 PNG、JPEG、GIF、WebP（三种子格式）、
 * 损坏头/损坏内容、超 8MiB、普通二进制误命中图片头。
 * 构造真实文件头字节，不 mock —— probeImage 就是要按字节判。
 */

function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 签名
  // IHDR chunk: len=13, 'IHDR', W(4BE), H(4BE), bitdepth, colortype, ...
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI + APP0(JFIF) + SOF0(width,height) —— 最小可解析骨架
  const b = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // FF + APP0 段 len=16 全长 18B（含 2B 长度）
    0xff, 0xc0, 0x00, 0x0b, 0x08, // FF + SOF0 段 len=11 精度 8（含长度字段共 11B）
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x00, 0x00, // 1 分量
  ]);
  return b;
}

function gifBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // 'GIF89a'
  const dv = new DataView(b.buffer);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  return b;
}

function webpBytes(sub: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  const b = new Uint8Array(34);
  b.set([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  b.set(sub.split('').map((c) => c.charCodeAt(0)), 12);
  const dv = new DataView(b.buffer);
  if (sub === 'VP8 ') {
    // VP8 关键帧头：3B 帧标记 + 0x9d 0x01 0x2a 起始码（在 20–25）+ 14bit 宽高（26/28 LE）
    b.set([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a], 20);
    dv.setUint16(26, width, true);
    dv.setUint16(28, height, true);
  } else if (sub === 'VP8L') {
    b[20] = 0x2f;
    const bits = ((width - 1) & 0x3fff) | ((((height - 1) & 0x3fff) << 14) >>> 0);
    dv.setUint32(21, bits >>> 0, true);
  } else {
    // VP8X: canvas width-1 / height-1 各 24bit LE
    dv.setUint32(24, (width - 1) & 0xffffff, true);
    dv.setUint32(27, (height - 1) & 0xffffff, true);
  }
  return b;
}

describe('probeImage · 四格式识别与像素尺寸', () => {
  it('PNG：宽×高按 IHDR 大端解出', () => {
    const p = probeImage(pngBytes(1920, 1080));
    expect(p.status).toBe('ok');
    expect(p.mime).toBe('image/png');
    expect(p.label).toBe('PNG');
    expect(p.ext).toBe('png');
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
    expect(p.previewAllowed).toBe(true);
    expect(p.reason).toBeNull();
  });

  it('JPEG：跳过 APPn 段后在 SOF 里解出宽×高（EXIF 干扰同路径）', () => {
    const p = probeImage(jpegBytes(640, 480));
    expect(p.status).toBe('ok');
    expect(p.mime).toBe('image/jpeg');
    expect(p.width).toBe(640);
    expect(p.height).toBe(480);
  });

  it('GIF：逻辑屏幕尺寸按小端解出', () => {
    const p = probeImage(gifBytes(300, 200));
    expect(p.status).toBe('ok');
    expect(p.width).toBe(300);
    expect(p.height).toBe(200);
  });

  it('WebP 三种子格式（VP8 / VP8L / VP8X）都能解尺寸', () => {
    const a = probeImage(webpBytes('VP8 ', 550, 368));
    expect(a.status).toBe('ok');
    expect(a.width).toBe(550);
    expect(a.height).toBe(368);

    const l = probeImage(webpBytes('VP8L', 386, 395));
    expect(l.status).toBe('ok');
    expect(l.width).toBe(386);
    expect(l.height).toBe(395);

    const x = probeImage(webpBytes('VP8X', 4096, 4096));
    expect(x.status).toBe('ok');
    expect(x.width).toBe(4096);
    expect(x.height).toBe(4096);
  });
});

describe('probeImage · 四类失败分类（每类都要有中文原因）', () => {
  it('not-image：普通二进制 → HEX 归宿，reason 明说', () => {
    const p = probeImage(new Uint8Array([1, 2, 3, 4, 5]));
    expect(p.status).toBe('not-image');
    expect(p.mime).toBeNull();
    expect(p.previewAllowed).toBe(false);
    expect(p.reason).toContain('魔数');
  });

  it('truncated-header：魔数命中但比最小头短 → 不构造预览', () => {
    const p = probeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // 只有 PNG 签名
    expect(p.status).toBe('truncated-header');
    expect(p.previewAllowed).toBe(false);
    expect(p.reason).toContain('PNG 头至少');
  });

  it('bad-header：字节够长但结构不符（PNG 无 IHDR）→ 仍允许交给浏览器试解码', () => {
    const b = new Uint8Array(32);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.set([0x41, 0x42, 0x43, 0x44], 12); // 不是 IHDR
    const p = probeImage(b);
    expect(p.status).toBe('bad-header');
    expect(p.previewAllowed).toBe(true); // 万一只是解析保守，解码兜底
    expect(p.reason).toContain('IHDR');
  });

  it('超大分辨率小体积：尺寸照解（只看头部，与总长无关）', () => {
    const p = probeImage(pngBytes(20000, 10000)); // 32 字节也能解出 2 万像素宽
    expect(p.status).toBe('ok');
    expect(p.width).toBe(20000);
    expect(p.height).toBe(10000);
  });
});

describe('probeImage · 超 8MiB 预览阈值', () => {
  it('tooLarge=true：不构造 data URL，但尺寸照解、reason 说明数据未截断', () => {
    const b = pngBytes(1000, 500);
    const big = new Uint8Array(IMAGE_PREVIEW_MAX_BYTES + 1);
    big.set(b.subarray(0, Math.min(b.length, big.length)));
    const p = probeImage(big);
    expect(p.tooLarge).toBe(true);
    expect(p.previewAllowed).toBe(false);
    expect(p.width).toBe(1000); // 尺寸照解
    expect(p.reason).toContain('不生成预览');
    expect(p.reason).toContain('未截断');
  });

  it('阈值边界：恰好 8MiB 不算超（> 才算）', () => {
    const p = probeImage(new Uint8Array(IMAGE_PREVIEW_MAX_BYTES));
    expect(p.tooLarge).toBe(false);
  });
});

describe('bytesToBase64 / imageDataUrl / formatBytes', () => {
  it('base64 分块拼装与大缓冲一致（不爆栈）', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    // 0x9000 字节 > 单块 0x8000，跨块路径
    const big = new Uint8Array(0x9000).fill(65);
    expect(bytesToBase64(big).length).toBe(Math.ceil((0x9000 / 3) * 4));
  });

  it('imageDataUrl 拼出正确前缀（🔴 调用方必须先看 previewAllowed）', () => {
    const url = imageDataUrl(new Uint8Array([0x89, 0x50]), 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('formatBytes 用 1024 进制（描述字节不是速率）', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.00 MB');
  });
});

describe('hex.ts · 与 ImageViewer 同一份截断口径', () => {
  it('每行 16 字节、空格分隔', () => {
    expect(toHexText(new Uint8Array([0, 1, 0xab]))).toBe('00 01 ab');
    const line = toHexText(new Uint8Array(20)).split('\n');
    expect(line).toHaveLength(2);
    expect(line[0].split(' ')).toHaveLength(16);
  });

  it('默认 2KB 截断 + isHexTruncated 一致', () => {
    const small = new Uint8Array(100);
    const big = new Uint8Array(HEX_PREVIEW_BYTES + 5);
    expect(isHexTruncated(small)).toBe(false);
    expect(isHexTruncated(big)).toBe(true);
    expect(toHexText(big).split('\n').length).toBe(HEX_PREVIEW_BYTES / 16);
  });
});
