/**
 * 右侧详情面板（§6.7）
 *
 * 三块内容：表信息 / 字段详情 / 单元格完整值。
 * 最后一块是它的存在理由 —— 网格里长文本与 BLOB 是截断的，
 * 用户需要一个地方看全。
 *
 * 宽 280px，可折叠。折叠时只留一条竖条（28px），不占空间。
 *
 * 网格 B 追加（2026-09-26）：
 *  - A9  JSON 单元格增强：值可解析为对象/数组时提供「格式化视图」开关 +
 *        轻量四色语法高亮（key/string/number/bool|null）；>256KB 不格式化只提示；
 *        「复制格式化 JSON」一键取规整文本。
 *  - A10 BLOB/图片/HEX 预览：PNG/JPEG/GIF/WebP 魔数 → data URL 直接预览；
 *        非图片二进制 → HEX 视图（前 2KB）+ 复制 HEX + 保存到磁盘（backend 门面）。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { tableFacts, formatCount } from '@dbstudio/core-sql-editor/facts';
import { pickBackend } from '../backend';
import { IconBinary, IconCopy, IconSave } from '../ui/icons';


export interface CellSelection {
  row: number;
  col: number;
  column: string;
  value: unknown;
}

export interface DetailPanelProps {
  table: TableMeta | null;
  database: string | null;
  collapsed: boolean;
  onToggle: () => void;
  /** 当前聚焦单元格 —— 展示其完整值 */
  cell: CellSelection | null;
  /** 可选 toast（保存到磁盘的结果反馈）；宿主未接时静默降级 */
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

export function DetailPanel({ table, database, collapsed, onToggle, cell, onToast }: DetailPanelProps) {
  const facts = useMemo(() => (table ? tableFacts(table) : []), [table]);

  // ---- A9：JSON 解析与格式化开关（换格重置） ----
  const [jsonPretty, setJsonPretty] = useState(true);
  useEffect(() => {
    setJsonPretty(true);
  }, [cell]);

  const json = useMemo(() => (cell ? parseJsonCell(cell.value) : null), [cell]);
  const jsonHint = useMemo(() => (cell ? looksLikeOversizedJson(cell.value) : false), [cell]);

  // ---- A10：二进制识别（列类型从 TableMeta 反查，App 无需传额外字段） ----
  const cellDataType = useMemo(
    () => (cell && table ? (table.columns.find((c) => c.name === cell.column)?.dataType ?? '') : ''),
    [cell, table],
  );
  const bytes = useMemo(() => (cell ? resolveBinary(cell.value, cellDataType) : null), [cell, cellDataType]);
  const imageMime = useMemo(() => (bytes ? detectImageMime(bytes) : null), [bytes]);
  const imageDataUrl = useMemo(() => {
    if (!bytes || !imageMime || bytes.length > IMAGE_DATA_URL_MAX) return null;
    return `data:${imageMime};base64,${bytesToBase64(bytes)}`;
  }, [bytes, imageMime]);
  const hexText = useMemo(() => (bytes ? toHexText(bytes) : ''), [bytes]);
  const hexTruncated = (bytes?.length ?? 0) > HEX_PREVIEW_BYTES;

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  /** A10：保存到磁盘（backend 门面，demo 返回 null = 环境不支持） */
  const handleSaveBinary = async () => {
    if (!bytes || !cell) return;
    const ext = imageMime ? (IMAGE_MIME_EXT[imageMime] ?? 'bin') : 'bin';
    const name = `${table?.name ?? 'data'}-${cell.column}-${cell.row + 1}.${ext}`;
    try {
      const path = await pickBackend().saveBinary(name, bytes.slice().buffer as ArrayBuffer);
      onToast?.(path ? `已保存到 ${path}` : '已取消保存（或当前环境不支持写盘）');
    } catch {
      onToast?.('保存失败');
    }
  };

  if (collapsed) {
    return (
      <aside className="detail-panel collapsed">
        <div className="detail-head">
          <button onClick={onToggle} title="展开详情面板">
            ‹
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <span>详情</span>
        <span className="spacer" />
        <button onClick={onToggle} title="折叠">
          ›
        </button>
      </div>

      {!table ? (
        <div className="detail-section">
          <h4>未选中表</h4>
        </div>
      ) : (
        <>
          <div className="detail-section">
            <h4>表信息</h4>
            <dl className="detail-kv">
              <dt>名称</dt>
              <dd>
                {database ? `${database}.` : ''}
                {table.name}
              </dd>
              <dt>类型</dt>
              <dd>{table.kind === 'view' ? '视图' : '表'}</dd>
              {facts.map((f) => (
                <div key={f.label} style={{ display: 'contents' }}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="detail-section">
            <h4>字段（{table.columns?.length ?? 0}）</h4>
            <div className="detail-cols">
              {(table.columns ?? []).map((c) => (
                <div className="detail-col" key={c.name} title={c.comment ?? undefined}>
                  <span className="name">{c.name}</span>
                  <span className="type">{c.dataType}</span>
                  <span className="flags">
                    {[
                      c.isPrimaryKey ? 'PK' : '',
                      c.isUnique && !c.isPrimaryKey ? 'UQ' : '',
                      c.autoIncrement ? 'AI' : '',
                      c.nullable ? 'NULL' : 'NOT NULL',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="detail-section" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <h4>单元格完整值</h4>
        {cell ? (
          <>
            <div className="detail-kv" style={{ paddingBottom: 0 }}>
              <dt>列</dt>
              <dd>{cell.column}</dd>
              <dt>行</dt>
              <dd>#{formatCount(cell.row)}</dd>
            </div>

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
                    <button
                      type="button"
                      onClick={() => copyText(json.pretty)}
                      title="复制格式化 JSON 文本"
                    >
                      <IconCopy size={11} />
                      复制格式化 JSON
                    </button>
                  </div>
                ) : null}
                {jsonHint ? <div className="dt-json-hint">JSON 过大（&gt;256KB），仅显示原文</div> : null}
                <div className="detail-value">
                  {json && jsonPretty ? (
                    <pre className="dt-json">{highlightJson(json.pretty)}</pre>
                  ) : cell.value === null || cell.value === undefined ? (
                    'NULL'
                  ) : (
                    String(cell.value)
                  )}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="detail-value" style={{ color: 'var(--text-dim)' }}>
            点击网格单元格查看完整值
          </div>
        )}
      </div>
    </aside>
  );
}
