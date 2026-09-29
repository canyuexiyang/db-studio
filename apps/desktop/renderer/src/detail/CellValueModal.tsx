/**
 * 单元格完整值弹窗（2026-09-29 缺陷 5 的配套）
 *
 * 🔴 为什么会有这个组件：右侧详情面板原本有一块「单元格完整值」，它同时承担了
 *    A9（JSON 格式化 + 四色高亮）与 A10（BLOB/图片/HEX 预览 + 保存到磁盘）。
 *    缺陷 5 要求把那块换成「表结构语句」—— 但网格里长文本与 BLOB 是截断的，
 *    「有个地方能看全」这条能力（PRD §6.7 的存在理由）不能跟着一起消失。
 *    所以整块搬到弹窗：详情面板让位给建表语句，完整值查看改由
 *    网格右键「查看完整值」/ 双击 BLOB 单元格触发。
 *
 * 逻辑与样式与搬迁前逐字一致（.dt-json-* / .dt-binary / .dt-hex / .dt-image
 * 全部复用既有 token），只是宿主从「常驻侧栏」变成「按需弹窗」。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { formatCount } from '@dbstudio/core-sql-editor/facts';
import { pickBackend } from '../backend';
import { IconBinary, IconCopy, IconSave, IconX } from '../ui/icons';

/**
 * 被检视的单元格。
 *
 * 🔴 定义在这里而不是 DetailPanel：详情面板改版后（缺陷 5）已不再渲染单元格值，
 *    这个类型的唯一消费者就是本弹窗（App 的 cellModal 状态）。
 *    类型留在没人用的文件里，下一个人会以为"详情面板还在管完整值"。
 */
export interface CellSelection {
  row: number;
  col: number;
  column: string;
  value: unknown;
}

export interface CellValueModalProps {
  cell: CellSelection;
  table: TableMeta | null;
  database: string | null;
  onClose: () => void;
  onToast?: (message: string) => void;
}

// ---------- A10：二进制识别与预览 ----------

/**
 * 二进制的主判定形态是 `Uint8Array`，依据 core-ipc-codec 源码：
 * TypeCode.BIN（=4）列经 ColumnarReader.decodeCell 返回 `v.bytes.slice(...)`
 * —— 一个 Uint8Array 拷贝（mysql2 驱动对 BLOB 列本就返回 Buffer，编码时被
 * isBinary() 归入 BIN）。ArrayBuffer 顺手兼容。
 */
function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

/** 列类型兜底：binary/blob/varbinary 也按二进制展示 */
const BINARY_DATA_TYPE_RE = /binary|blob/i;

/**
 * 混合列降级路径：core-ipc-codec 的 inferTypeCode 对「字符串+二进制混合」整列
 * 降级为 STR —— 二进制字节会以有损 UTF-8 字符串到达。此时用列类型识别出来，
 * TextEncoder 回转字节（尽力而为，字节可能已被 UTF-8 解码破坏）。
 */
function resolveBinary(value: unknown, dataType: string): Uint8Array | null {
  const direct = toBytes(value);
  if (direct) return direct;
  if (typeof value === 'string' && BINARY_DATA_TYPE_RE.test(dataType)) {
    return new TextEncoder().encode(value);
  }
  return null;
}

/** 魔数检测：PNG / JPEG / GIF8 / RIFF…WEBP（都是文件头固定字节） */
function detectImageMime(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

const IMAGE_MIME_LABELS: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
};

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** HEX 视图只展示前 2KB（性能与可读性；完整字节经「保存到磁盘」拿走） */
const HEX_PREVIEW_BYTES = 2048;

function toHexText(b: Uint8Array, max = HEX_PREVIEW_BYTES): string {
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

/** data URL 的 base64：大缓冲分块拼，避免 String.fromCharCode 展开爆栈 */
function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)));
  }
  return btoa(s);
}

/** >8MB 不构造 data URL（btoa 内存翻倍，预览价值趋零） */
const IMAGE_DATA_URL_MAX = 8 * 1024 * 1024;

// ---------- A9：JSON 识别与高亮 ----------

/** >256KB 不格式化（解析 + 高亮都不划算，原文 + 提示） */
const JSON_FORMAT_MAX_CHARS = 256 * 1024;

/** 只把对象/数组当「JSON 值」—— JSON 标量（"42"/"true"）与普通字符串无法区分，不进格式化 */
function parseJsonCell(value: unknown): { parsed: unknown; pretty: string } | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0 || t.length > JSON_FORMAT_MAX_CHARS) return null;
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed === null || typeof parsed !== 'object') return null;
    return { parsed, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    return null;
  }
}

/** 原文疑似 JSON 但超过阈值（只提示不格式化） */
function looksLikeOversizedJson(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trimStart();
  return t.length > JSON_FORMAT_MAX_CHARS && (t.startsWith('{') || t.startsWith('['));
}

/**
 * 轻量 JSON 高亮：对格式化文本做线性分词（字符串优先，冒号归属 key），
 * 四类 token 各配色：key / string / number / bool|null。
 * 返回 ReactNode 数组而非 innerHTML —— 不引入 XSS 面。
 * 注意：只对 ≤256KB 的格式化文本执行（JSON_FORMAT_MAX_CHARS 已在入口拦住）。
 */
function highlightJson(text: string): ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        out.push(
          <span key={key++} className="dt-json-key">
            {m[1]}
          </span>,
        );
        out.push(m[2]); // 冒号与空白原样
      } else {
        out.push(
          <span key={key++} className="dt-json-str">
            {m[1]}
          </span>,
        );
      }
    } else if (m[3] !== undefined) {
      out.push(
        <span key={key++} className="dt-json-num">
          {m[3]}
        </span>,
      );
    } else if (m[4] !== undefined) {
      out.push(
        <span key={key++} className="dt-json-bool">
          {m[4]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 纯文本的展示串（NULL 与空串必须可区分 —— 红线 6） */
export function cellValueText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

export function CellValueModal({ cell, table, database, onClose, onToast }: CellValueModalProps) {
  const [jsonPretty, setJsonPretty] = useState(true);

  const json = useMemo(() => parseJsonCell(cell.value), [cell]);
  const jsonHint = useMemo(() => looksLikeOversizedJson(cell.value), [cell]);

  // A10：列类型从 TableMeta 反查（宿主不必额外传字段）
  const cellDataType = useMemo(
    () => (table ? (table.columns.find((c) => c.name === cell.column)?.dataType ?? '') : ''),
    [cell, table],
  );
  const bytes = useMemo(() => resolveBinary(cell.value, cellDataType), [cell, cellDataType]);
  const imageMime = useMemo(() => (bytes ? detectImageMime(bytes) : null), [bytes]);
  const imageDataUrl = useMemo(() => {
    if (!bytes || !imageMime || bytes.length > IMAGE_DATA_URL_MAX) return null;
    return `data:${imageMime};base64,${bytesToBase64(bytes)}`;
  }, [bytes, imageMime]);
  const hexText = useMemo(() => (bytes ? toHexText(bytes) : ''), [bytes]);
  const hexTruncated = (bytes?.length ?? 0) > HEX_PREVIEW_BYTES;

  /** Esc 关闭（与既有弹窗同族；点遮罩同样关闭） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    onToast?.('已复制到剪贴板');
  };

  /** A10：保存到磁盘（backend 门面，demo 返回 null = 环境不支持） */
  const handleSaveBinary = async () => {
    if (!bytes) return;
    const ext = imageMime ? (IMAGE_MIME_EXT[imageMime] ?? 'bin') : 'bin';
    const name = `${table?.name ?? 'data'}-${cell.column}-${cell.row + 1}.${ext}`;
    try {
      const path = await pickBackend().saveBinary(name, bytes.slice().buffer as ArrayBuffer);
      onToast?.(path ? `已保存到 ${path}` : '已取消保存（或当前环境不支持写盘）');
    } catch {
      onToast?.('保存失败');
    }
  };

  const plainText = cellValueText(cell.value);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal cell-modal"
        data-testid="cell-value-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <span>
            单元格完整值 — {cell.column}
            {/*
              🔴 定位信息前要有一个显式的文本分隔符（`·`），不能只靠 CSS margin：
              margin 只影响视觉，innerText 与屏幕阅读器朗读都会把两段黏成
              「idorder_db.order」—— 视觉上没错，但对无障碍与自动化都是脏数据。
            */}
            <span className="cell-modal-loc">
              · {database ? `${database}.` : ''}
              {table?.name ?? ''} · 第 {formatCount(cell.row + 1)} 行
            </span>
          </span>
          <span className="spacer" />
          <button className="cell-modal-x" onClick={onClose} title="关闭（Esc）" data-testid="cell-modal-close">
            <IconX size={12} />
          </button>
        </header>

        <div className="body">
          {bytes ? (
            /* A10：二进制 —— 图片直接预览，其余 HEX；不看原文（String(Uint8Array) 是垃圾输出） */
            <div className="dt-binary">
              <div className="dt-binary-meta">
                <IconBinary size={11} />
                <span>
                  二进制 · {formatCount(bytes.length)} 字节
                  {imageMime ? ` · ${IMAGE_MIME_LABELS[imageMime] ?? imageMime}` : ''}
                  {imageMime && !imageDataUrl ? '（超过 8MB，不生成预览）' : ''}
                </span>
              </div>
              {imageDataUrl ? (
                <img className="dt-image" src={imageDataUrl} alt="单元格图片预览" />
              ) : (
                <pre className="dt-hex">
                  {hexText}
                  {hexTruncated ? `\n… 共 ${formatCount(bytes.length)} 字节` : ''}
                </pre>
              )}
              <div className="dt-binary-actions">
                {!imageDataUrl ? (
                  <button type="button" onClick={() => copyText(hexText)} title="复制当前展示的 HEX 文本">
                    <IconCopy size={11} />
                    复制 HEX
                  </button>
                ) : null}
                <button type="button" onClick={() => void handleSaveBinary()}>
                  <IconSave size={11} />
                  保存到磁盘
                </button>
              </div>
            </div>
          ) : (
            <>
              {json ? (
                /* A9：格式化视图开关 + 一键复制格式化 JSON */
                <div className="dt-json-bar">
                  <button type="button" className={jsonPretty ? 'dt-on' : ''} onClick={() => setJsonPretty(true)}>
                    格式化
                  </button>
                  <button type="button" className={!jsonPretty ? 'dt-on' : ''} onClick={() => setJsonPretty(false)}>
                    原文
                  </button>
                  <span className="dt-json-bar-spacer" />
                  <button type="button" onClick={() => copyText(json.pretty)} title="复制格式化 JSON 文本">
                    <IconCopy size={11} />
                    复制格式化 JSON
                  </button>
                </div>
              ) : null}
              {jsonHint ? <div className="dt-json-hint">JSON 过大（&gt;256KB），仅显示原文</div> : null}
              <div className="detail-value cell-modal-value">
                {json && jsonPretty ? (
                  <pre className="dt-json">{highlightJson(json.pretty)}</pre>
                ) : (
                  plainText
                )}
              </div>
            </>
          )}
        </div>

        <footer>
          <button onClick={() => copyText(bytes ? hexText : plainText)} title="复制本格内容">
            <IconCopy size={11} />
            复制值
          </button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
