/**
 * T34：图片查看器（CellValueModal 的二进制分支）。
 *
 * 职责：
 *  - 识别成功 → 图片预览 + 像素宽×高 + 格式 + 字节数 + 「适应窗口 / 100%」切换 + 缩放；
 *  - 「图片 ↔ HEX」切换（hex.ts 的同一份截断口径，不复制逻辑）；
 *  - `<img>` onError / not-image / truncated-header → 明确中文原因回落 HEX；
 *  - 超 8MiB 不构造 data URL（提示原因），**复制 / 保存仍用完整字节**；
 *  - 保存走 Blob + a[download]（不依赖 backend 的写盘门面 —— 浏览器 demo 模式同样可存）。
 *
 * 🔴 本文件是 CellValueModal 的 lazy 分支目标（`React.lazy(() => import('./ImageViewer'))`），
 *    不进首屏 bundle。
 */

import { useEffect, useMemo, useState } from 'react';
import { probeImage, imageDataUrl, formatBytes, IMAGE_PREVIEW_MAX_BYTES, type ImageProbe } from './imageProbe';
import { toHexText, isHexTruncated, HEX_PREVIEW_BYTES } from './hex';
import { formatCount } from '@dbstudio/core-sql-editor/facts';
import { IconBinary, IconCopy, IconImage, IconSave, IconZoomIn, IconZoomOut } from '../ui/icons';

export interface ImageViewerProps {
  /** 完整字节（绝不截断 —— 复制 / 保存都用它） */
  bytes: Uint8Array;
  /** 列名 + 行号（保存文件名用） */
  fileBase: string;
  onToast?: (message: string) => void;
}

/** 缩放档位（百分比）：100% 起步，上下限卡住（不让用户缩到 0% 或 10000%） */
const ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 400, 800] as const;

/** 缩放显示模式 */
type ZoomMode = 'fit' | 'percent';

export default function ImageViewer({ bytes, fileBase, onToast }: ImageViewerProps) {
  // probeImage 是纯函数且从不修改入参；bytes 引用在弹窗生命周期内稳定
  const probe = useMemo<ImageProbe>(() => probeImage(bytes), [bytes]);

  const [view, setView] = useState<'image' | 'hex'>(probe.status === 'ok' || probe.status === 'bad-header' ? 'image' : 'hex');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [zoomIdx, setZoomIdx] = useState(ZOOM_STEPS.indexOf(100));
  /** <img> 解码失败（probe 说可以，但浏览器不认）→ 回落 HEX 并说明原因 */
  const [decodeError, setDecodeError] = useState<string | null>(null);

  // data URL 只在 probe.previewAllowed 时构造（>8MiB / truncated-header 不构造）
  const dataUrl = useMemo(() => {
    if (!probe.previewAllowed || !probe.mime) return null;
    try {
      return imageDataUrl(bytes, probe.mime);
    } catch {
      return null;
    }
  }, [bytes, probe]);

  /** 复制 / 保存任何时候都基于完整字节 —— 查看失败不影响它们（红线） */
  const hexText = useMemo(() => toHexText(bytes), [bytes]);
  const hexTrunc = isHexTruncated(bytes);

  // 保存：Blob + a[download]（浏览器原生下载，demo 后端同样可用）
  const handleSave = () => {
    const ext = probe.ext ?? 'bin';
    const name = `${fileBase}.${ext}`;
    try {
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: probe.mime ?? 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 释放 object URL：下载已在 click 时发起，稍后回收不影响下载
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      onToast?.(`已开始下载 ${name}（${formatBytes(bytes.length)}，完整字节）`);
    } catch {
      onToast?.('保存失败：无法构造下载（Blob / a[download] 不可用）');
    }
  };

  const copyHex = () => {
    void navigator.clipboard?.writeText(hexText).catch(() => undefined);
    onToast?.(hexTrunc ? `已复制前 ${formatCount(HEX_PREVIEW_BYTES)} 字节的 HEX（完整字节请保存为文件）` : '已复制完整 HEX');
  };

  // 缩放控制
  const zoomPct = ZOOM_STEPS[zoomIdx];
  const zoomIn = () => setZoomIdx((i) => Math.min(i + 1, ZOOM_STEPS.length - 1));
  const zoomOut = () => setZoomIdx((i) => Math.max(i - 1, 0));
  const setPercent = () => {
    setZoomMode('percent');
    setZoomIdx(ZOOM_STEPS.indexOf(100));
  };

  /** Esc：图片 ↔ HEX 无关（弹窗自己处理 Esc 关闭） */
  useEffect(() => {
    if (decodeError && view === 'image') setView('hex');
  }, [decodeError, view]);

  /**
   * meta 行：格式 · 宽×高 px · 字节数 —— 一眼读全。
   * 解不出尺寸时如实说「尺寸未知」，不装作没这回事。
   */
  const metaText =
    `二进制 · ${formatCount(bytes.length)} 字节（${formatBytes(bytes.length)}）` +
    (probe.label ? ` · ${probe.label}` : '') +
    (probe.width != null && probe.height != null ? ` · ${probe.width}×${probe.height} px` : ' · 尺寸未知');

  return (
    <div className="dt-binary" data-testid="image-viewer" data-probe-status={probe.status}>
      <div className="dt-binary-meta" data-testid="image-viewer-meta">
        <IconBinary size={11} />
        <span>{metaText}</span>
      </div>

      {/* 失败/降级原因：probe 给了 reason 就显示（含超阈值提示） */}
      {probe.reason ? (
        <div className="dt-image-reason" data-testid="image-viewer-reason">
          {probe.reason}
        </div>
      ) : null}

      {/* 图片↔HEX 切换（有识别出图片格式才给图片页签；纯二进制只有 HEX） */}
      <div className="dt-json-bar">
        {probe.mime ? (
          <button
            type="button"
            className={view === 'image' ? 'dt-on' : ''}
            onClick={() => setView('image')}
            title="图片预览"
            data-testid="image-viewer-tab-image"
          >
            <IconImage size={11} />
            图片
          </button>
        ) : null}
        <button
          type="button"
          className={view === 'hex' ? 'dt-on' : ''}
          onClick={() => setView('hex')}
          title={`十六进制视图（前 ${formatCount(HEX_PREVIEW_BYTES)} 字节，完整字节经「保存为文件」拿走）`}
          data-testid="image-viewer-tab-hex"
        >
          <IconBinary size={11} />
          HEX
        </button>

        {view === 'image' && dataUrl ? (
          <>
            <span className="dt-json-bar-spacer" />
            <button
              type="button"
              className={zoomMode === 'fit' ? 'dt-on' : ''}
              onClick={() => setZoomMode('fit')}
              title="适应窗口：最长边收进弹窗，不裁切"
              data-testid="image-viewer-fit"
            >
              适应窗口
            </button>
            <button
              type="button"
              className={zoomMode === 'percent' ? 'dt-on' : ''}
              onClick={setPercent}
              title="按像素 1:1 显示"
              data-testid="image-viewer-100"
            >
              100%
            </button>
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoomMode !== 'percent' || zoomIdx === 0}
              title={zoomMode !== 'percent' ? '先切到 100% 才能逐级缩放' : zoomIdx === 0 ? `已是最小缩放（${ZOOM_STEPS[0]}%）` : `缩小到 ${ZOOM_STEPS[Math.max(0, zoomIdx - 1)]}%`}
              data-testid="image-viewer-zoom-out"
            >
              <IconZoomOut size={11} />
            </button>
            <span className="dt-image-zoom-pct" data-testid="image-viewer-zoom-pct">
              {zoomMode === 'fit' ? '适应' : `${zoomPct}%`}
            </span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoomMode !== 'percent' || zoomIdx === ZOOM_STEPS.length - 1}
              title={zoomMode !== 'percent' ? '先切到 100% 才能逐级缩放' : zoomIdx === ZOOM_STEPS.length - 1 ? `已是最大缩放（${ZOOM_STEPS[ZOOM_STEPS.length - 1]}%）` : `放大到 ${ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomIdx + 1)]}%`}
              data-testid="image-viewer-zoom-in"
            >
              <IconZoomIn size={11} />
            </button>
          </>
        ) : null}
      </div>

      {view === 'image' && dataUrl ? (
        <div className="dt-image-stage" data-testid="image-viewer-stage">
          <img
            className="dt-image-zoom"
            src={dataUrl}
            alt={`单元格图片（${probe.label ?? probe.mime}，${probe.width ?? '?'}×${probe.height ?? '?'} 像素）`}
            style={zoomMode === 'fit' ? undefined : { width: `${zoomPct}%` }}
            onError={() => setDecodeError('浏览器解码这张图片失败（文件头可解析但数据损坏或不完整），已回落 HEX 视图')}
          />
        </div>
      ) : view === 'image' && !dataUrl ? (
        /* previewAllowed=false 但用户仍点「图片」页签：说明为什么看不到图 */
        <div className="dt-image-reason" data-testid="image-viewer-nopreview">
          {bytes.length > IMAGE_PREVIEW_MAX_BYTES
            ? `图片 ${formatBytes(bytes.length)} 超过 ${formatBytes(IMAGE_PREVIEW_MAX_BYTES)} 预览阈值，不构造预览（内存翻倍、价值趋零）；复制 / 保存仍用完整字节`
            : '这张图片的结构解析不通过（头部损坏或不完整），无法安全构造预览；请看 HEX 视图'}
        </div>
      ) : (
        <pre className="dt-hex" data-testid="image-viewer-hex">
          {hexText}
          {hexTrunc ? `\n… 仅前 ${formatCount(HEX_PREVIEW_BYTES)} 字节（共 ${formatCount(bytes.length)} 字节）` : ''}
        </pre>
      )}

      {decodeError ? (
        <div className="dt-image-reason" data-testid="image-viewer-decode-error">
          {decodeError}
        </div>
      ) : null}

      <div className="dt-binary-actions">
        <button type="button" onClick={copyHex} title="复制当前展示的 HEX 文本（前 2KB）">
          <IconCopy size={11} />
          复制 HEX
        </button>
        <button
          type="button"
          onClick={handleSave}
          title={`保存完整字节到文件（${formatCount(bytes.length)} 字节，不受预览阈值影响）`}
          data-testid="image-viewer-save"
        >
          <IconSave size={11} />
          保存为文件
        </button>
      </div>
    </div>
  );
}
