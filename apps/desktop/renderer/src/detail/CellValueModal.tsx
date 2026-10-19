/**
 * 单元格完整值弹窗（2026-09-29 缺陷 5 的配套；T31/T32/T34/T35 的宿主）。
 *
 * 🔴 为什么会有这个组件：右侧详情面板原本有一块「单元格完整值」，它同时承担了
 *    A9（JSON 格式化 + 四色高亮）与 A10（BLOB/图片/HEX 预览 + 保存到磁盘）。
 *    缺陷 5 要求把那块换成「表结构语句」—— 但网格里长文本与 BLOB 是截断的，
 *    「有个地方能看全」这条能力（PRD §6.7 的存在理由）不能跟着一起消失。
 *    所以整块搬到弹窗：详情面板让位给建表语句，完整值查看改由
 *    网格右键「查看完整值」/ 双击 BLOB 单元格触发。
 *
 * 本轮（v0.7.0）新增四个消费点，各自只贴 UI，判定逻辑全在纯函数层：
 *  - T31 `cellValueSource`：库中原值 vs 当前待提交值（复制按钮 title 说明复制对象）；
 *  - T32 `TextValueEditor`（lazy）：多行编辑 + 查找 + 存为待提交值（onCommitDraft）；
 *  - T34 `ImageViewer`（lazy）：图片像素/缩放/HEX 切换，失败回落 HEX；
 *  - T35 `JsonTreeView`（lazy）：JSON 折叠树 + JSON Pointer 复制 + 可取消搜索。
 */

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { formatCount } from '@dbstudio/core-sql-editor/facts';
import { pickBackend } from '../backend';
import { IconBinary, IconCopy, IconSave, IconX } from '../ui/icons';
import { formatCellJson, looksLikeOversizedJson } from './jsonFormat';
import { isImeComposing } from '../ui/imeGuard';
import { diffCellValues, copyTargetTitle, copyTargetLabel, pendingText, type PendingCellValue } from './cellValueSource';

// 🔴 三个大组件全部 React.lazy：右键「查看完整值」才触发加载，不进首屏 bundle（红线）
const TextValueEditor = lazy(() => import('./TextValueEditor'));
const ImageViewer = lazy(() => import('./ImageViewer'));
const JsonTreeView = lazy(() => import('./JsonTreeView'));

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
  /**
   * T31：宿主提供的「当前待提交值」信息。
   * undefined = 宿主没接这条线（如 SQL 结果网格——只读，没有脏格概念），
   * 此时弹窗如实说明「展示的是库中原值」，不假装知道没有修改。
   */
  pending?: { value: string | null; provided: boolean };
  /**
   * T32：是否给「编辑」入口（表网格且表可写时传 true；SQL 结果网格不传）。
   * 提交动作走 onCommitDraft —— 宿主接到后写脏格（valueKind='literal'），
   * null = 写 SQL NULL。
   */
  editable?: boolean;
  /** T32：编辑器「存为待提交值」的提交通道（text=null 表示写 NULL） */
  onCommitDraft?: (text: string | null) => void;
}

// ---------- A10：二进制识别（图片/HEX 部分已下沉 ImageViewer，这里只判「是不是二进制」） ----------

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

// ---------- A9：JSON 高亮（美化/识别已在 jsonFormat） ----------

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

export function CellValueModal({ cell, table, database, onClose, onToast, pending, editable, onCommitDraft }: CellValueModalProps) {
  const [jsonPretty, setJsonPretty] = useState(true);
  // T35：JSON 视图切换（格式化 ↔ 树）
  const [jsonView, setJsonView] = useState<'pretty' | 'tree'>('pretty');
  // T32：编辑态（草稿保存在这，编辑器卸载不丢 —— Esc 退出保留草稿，弹窗关闭才丢弃）
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * Esc 优先级钩子：编辑器/树视图打开时，Esc 先被它们吃掉（关查找框 / 退出编辑），
   * 都不吃才关弹窗。ref 里的函数由子组件在挂载时注册、卸载时置 null。
   */
  const escHookRef = useRef<(() => void) | null>(null);

  // A10：列类型从 TableMeta 反查（宿主不必额外传字段）
  const cellDataType = useMemo(
    () => (table ? (table.columns.find((c) => c.name === cell.column)?.dataType ?? '') : ''),
    [cell, table],
  );

  // A9 / T05：保真 JSON 美化 —— 不经过 JSON.parse，超 2^53 整数与字符串转义原样保留
  const json = useMemo(() => formatCellJson(cell.value, cellDataType), [cell, cellDataType]);
  const jsonHint = useMemo(() => looksLikeOversizedJson(cell.value, cellDataType), [cell, cellDataType]);
  const bytes = useMemo(() => resolveBinary(cell.value, cellDataType), [cell, cellDataType]);

  // T31：原值 vs 待提交值判定（纯函数出文案，UI 只贴）
  const pendingInfo: PendingCellValue | null = useMemo(() => {
    if (!pending || !pending.provided) return null;
    return { dirty: true, value: pending.value };
  }, [pending]);
  const diff = useMemo(() => diffCellValues(cell.value, pendingInfo), [cell, pendingInfo]);

  /** 展示主体值：有待提交值时显示待提交值（与网格所见一致），否则库中原值 */
  const displayText = diff.hasPending ? pendingText(pendingInfo!) : cellValueText(cell.value);

  /** Esc 关闭（与既有弹窗同族；点遮罩同样关闭）。编辑器/树视图优先吃掉 Esc */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // T13：输入法组合期一律放行（Enter/Esc 是确认/取消候选词，不是提交/关闭）
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (escHookRef.current) {
          escHookRef.current();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const copyText = (text: string, note?: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    onToast?.(note ?? '已复制到剪贴板');
  };

  /**
   * A10 旧保存通道（backend 门面）保留为兜底：ImageViewer 的主保存走 Blob+a[download]，
   * 但非图片二进制（HEX 视图里）的保存按钮仍走这里 —— 与旧行为一致。
   */
  const handleSaveBinary = async () => {
    if (!bytes) return;
    const name = `${table?.name ?? 'data'}-${cell.column}-${cell.row + 1}.bin`;
    try {
      const path = await pickBackend().saveBinary(name, bytes.slice().buffer as ArrayBuffer);
      onToast?.(path ? `已保存到 ${path}` : '已取消保存（或当前环境不支持写盘）');
    } catch {
      onToast?.('保存失败');
    }
  };

  const plainText = cellValueText(cell.value);

  // ---------- T32：编辑器接线 ----------

  /** 编辑的基准值 = 当前展示主体（待提交值优先——编辑的是「网格正在显示的值」） */
  const baseValue = displayText === 'NULL' ? '' : displayText;

  const canCommit = typeof onCommitDraft === 'function';

  const handleCommit = () => {
    if (!onCommitDraft) return;
    onCommitDraft(draft);
    setEditing(false);
  };

  const startEditing = () => {
    setDraft(baseValue);
    setEditing(true);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal cell-modal"
        data-testid="cell-value-modal"
        data-has-pending={diff.hasPending ? 'true' : 'false'}
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
          {/* T31：原值/待提交值说明行（文案来自 cellValueSource 纯函数） */}
          <div className={`cell-modal-note${diff.differs ? ' cell-modal-note-differs' : ''}`} data-testid="cell-modal-note">
            {diff.note}
          </div>

          {editing ? (
            /* T32：多行编辑器（lazy）。草稿在本组件，Esc 退出保留草稿、弹窗关闭丢弃 */
            <Suspense fallback={<div className="sql-loading">编辑器载入中…</div>}>
              <TextValueEditor
                value={draft}
                onChange={setDraft}
                baseValue={baseValue}
                canCommit={canCommit}
                commitDisabledReason={canCommit ? undefined : '宿主未接写脏格链路（onCommitDraft）'}
                onCommit={handleCommit}
                onExitEditing={() => setEditing(false)}
                onDiscardDraft={() => setDraft(baseValue)}
                onCopy={(text, label) => copyText(text, `已复制${label}`)}
                escHookRef={escHookRef}
              />
            </Suspense>
          ) : bytes ? (
            /* T34：二进制 —— 图片/HEX 全部交给 ImageViewer（lazy） */
            <Suspense fallback={<div className="sql-loading">图片查看器载入中…</div>}>
              <ImageViewer
                bytes={bytes}
                fileBase={`${table?.name ?? 'data'}-${cell.column}-${cell.row + 1}`}
                onToast={onToast}
              />
            </Suspense>
          ) : (
            <>
              {json ? (
                /* A9 + T35：格式化 / 原文 / 树 三态切换 */
                <div className="dt-json-bar">
                  <button
                    type="button"
                    className={jsonView === 'pretty' && jsonPretty ? 'dt-on' : ''}
                    onClick={() => {
                      setJsonView('pretty');
                      setJsonPretty(true);
                    }}
                  >
                    格式化
                  </button>
                  <button
                    type="button"
                    className={jsonView === 'pretty' && !jsonPretty ? 'dt-on' : ''}
                    onClick={() => {
                      setJsonView('pretty');
                      setJsonPretty(false);
                    }}
                  >
                    原文
                  </button>
                  <button
                    type="button"
                    className={jsonView === 'tree' ? 'dt-on' : ''}
                    onClick={() => setJsonView('tree')}
                    title="折叠树视图（只读，懒加载，RFC 6901 路径复制）"
                    data-testid="cell-modal-json-tree-tab"
                  >
                    树
                  </button>
                  <span className="dt-json-bar-spacer" />
                  {jsonView === 'pretty' ? (
                    <button type="button" onClick={() => copyText(json.pretty)} title="复制格式化 JSON 文本">
                      <IconCopy size={11} />
                      复制格式化 JSON
                    </button>
                  ) : null}
                </div>
              ) : null}
              {jsonHint ? (
                <div className="dt-json-hint">
                  JSON 过大（&gt;256KB），仅显示原文
                  <button type="button" onClick={() => copyText(plainText)} title="复制原始文本">
                    <IconCopy size={11} />
                    复制原文
                  </button>
                </div>
              ) : null}
              {json && jsonView === 'tree' ? (
                /* T35：折叠树（lazy）。只读不修改源文；超 256KB 走不到这里（json 为 null） */
                <Suspense fallback={<div className="sql-loading">树视图载入中…</div>}>
                  <JsonTreeView source={String(cell.value)} onToast={onToast} escHookRef={escHookRef} />
                </Suspense>
              ) : (
                <div className="detail-value cell-modal-value" data-testid="cell-modal-value">
                  {json && jsonPretty ? (
                    <pre className="dt-json">{highlightJson(json.pretty)}</pre>
                  ) : (
                    displayText
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer>
          {/*
            T31：复制按钮的 title 必须说明复制对象。
            主按钮复制「当前展示主体值」= 待提交值（有待提交修改时），无差异时即原值。
          */}
          <button
            onClick={() =>
              copyText(
                diff.hasPending ? (pendingInfo!.value === null ? 'NULL' : pendingInfo!.value) : plainText,
                diff.hasPending ? '已复制当前待提交值（网格正在显示的新值）' : '已复制库中原值',
              )
            }
            title={copyTargetTitle('pending', diff)}
            data-testid="cell-modal-copy-value"
          >
            <IconCopy size={11} />
            {copyTargetLabel('pending')}
          </button>
          {/*
            T31：与原值不同时给第二个「复制库中原值」按钮 —— 用户可能恰恰要旧的。
            二进制格式的复制按钮在 ImageViewer（复制 HEX）；无差异时两个按钮内容相同，不重复给。
          */}
          {diff.differs ? (
            <button
              onClick={() => copyText(plainText, '已复制库中原值（不含未保存的网格编辑）')}
              title={copyTargetTitle('original', diff)}
              data-testid="cell-modal-copy-original"
            >
              <IconCopy size={11} />
              {copyTargetLabel('original')}
            </button>
          ) : null}
          {/*
            T32：编辑按钮。editable 不传（SQL 结果网格 / 不可写表）就不显示 ——
            没有假 UI。二进制（bytes）走图片/HEX 查看，不给文本编辑入口。
          */}
          {editable && !bytes ? (
            <button onClick={startEditing} title="多行编辑本格的值（修改只标当前格，走保存预演）" data-testid="cell-modal-edit">
              <IconBinary size={11} />
              编辑
            </button>
          ) : null}
          {!bytes ? null : (
            <button onClick={() => void handleSaveBinary()} title="保存二进制到磁盘（backend 通道）">
              <IconSave size={11} />
              保存到磁盘
            </button>
          )}
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
