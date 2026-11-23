/**
 * 行检查器（0.10.0 P0-01）—— 右侧「当前行」视图。
 *
 * 背景：详情面板此前只有「表信息 / 字段 / 建表语句」，单元格完整值要开弹窗；
 * 100+ 列宽表里用户没法一屏纵读一行。这里按 DBDelve 的 Row Inspector 做一版
 * **只读优先、编辑仍走脏单元格 + 保存预演**的实现：
 *  - 展示 source.value（脏格优先），但「保存」只标脏，不直接写库；
 *  - NULL / 空串 / 二进制 / DEFAULT 用不同文案，不把空串画成 NULL；
 *  - 过滤只过滤当前行字段，不触发查询、不改网格选择。
 *
 * 刻意不做的事：
 *  - 不复制 DataGrid 的单元格编辑状态机（Enter/Tab/IME），只提供显式「编辑」；
 *  - 不自动保存（DB Studio 红线 1：任何写前必须过保存预演）；
 *  - 不在面板里 decodeAll / materialize，只按当前行逐格 decode。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import type { GridDataSource } from '../grid/useGridData';
import { formatCellJson, looksLikeOversizedJson } from './jsonFormat';
import { IconBinary, IconCheck, IconCopy, IconSearch, IconX } from '../ui/icons';

/** 面板里单字段的展示上限：与 DBDelve 的 4,000 字符同口径，避免一屏被一个 JSON 撑爆。 */
const ROW_FIELD_DISPLAY_LIMIT = 4_000;

export interface RowInspectorProps {
  source: GridDataSource;
  table: TableMeta;
  /** 0 基行号；行号来自 DataGrid 的焦点格 */
  row: number;
  /** 0 基列号，用于高亮当前列 */
  activeCol: number;
  /** 当前表/连接是否可写；false 时只给「查看完整值」，不给编辑入口 */
  writable: boolean;
  /** 保存 = 只标脏；落库仍由 ⌘S 的 SavePreviewModal 负责 */
  onEdit: (row: number, col: number, value: string | null) => void;
  onInspect: (row: number, col: number) => void;
  onToast?: (message: string) => void;
}

type FieldView = {
  col: number;
  name: string;
  dataType: string;
  raw: unknown;
  shown: string;
  kind: 'null' | 'empty' | 'binary' | 'json' | 'text';
  dirty: boolean;
  truncated: boolean;
  editable: boolean;
};

function isBinary(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (isBinary(v)) return '';
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function viewOf(source: GridDataSource, table: TableMeta, row: number, col: number): FieldView {
  const meta = table.columns[col];
  const raw = source.value(row, col);
  const dataType = meta?.dataType ?? '';
  const dirty = source.isDirty(row, col);
  const name = meta?.name ?? source.columnName(col) ?? `列 ${col + 1}`;

  if (raw === null || raw === undefined) {
    return { col, name, dataType, raw, shown: 'NULL', kind: 'null', dirty, truncated: false, editable: true };
  }
  if (isBinary(raw)) {
    return {
      col,
      name,
      dataType,
      raw,
      shown: `二进制 ${raw.byteLength} B`,
      kind: 'binary',
      dirty,
      truncated: false,
      editable: false,
    };
  }
  if (raw === '') {
    return { col, name, dataType, raw, shown: '（空串）', kind: 'empty', dirty, truncated: false, editable: true };
  }

  const formatted = formatCellJson(raw, dataType);
  if (formatted !== null) {
    const truncated = formatted.pretty.length > ROW_FIELD_DISPLAY_LIMIT || looksLikeOversizedJson(raw, dataType);
    return {
      col,
      name,
      dataType,
      raw,
      shown: truncated ? `${formatted.pretty.slice(0, ROW_FIELD_DISPLAY_LIMIT)}…` : formatted.pretty,
      kind: 'json',
      dirty,
      truncated,
      editable: true,
    };
  }

  const text = textOf(raw);
  const truncated = text.length > ROW_FIELD_DISPLAY_LIMIT;
  return {
    col,
    name,
    dataType,
    raw,
    shown: truncated ? `${text.slice(0, ROW_FIELD_DISPLAY_LIMIT)}…` : text,
    kind: 'text',
    dirty,
    truncated,
    editable: true,
  };
}

/** 编辑器初值：原始值文本，不是截断后的展示串。 */
function editTextOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : textOf(v);
}

export function RowInspector({ source, table, row, activeCol, writable, onEdit, onInspect, onToast }: RowInspectorProps) {
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ col: number; text: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  const total = source.totalRows;
  const valid = Number.isInteger(row) && row >= 0 && row < total;

  // 切行 / 切表时退出编辑：旧行的草稿不能落到新行上
  useEffect(() => {
    setEditing(null);
  }, [row, table.name]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  // 行检查器只解当前行；不用 useMemo —— source 是可变对象（脏值/刷新），
  // 依赖数组拿不到变化，会把「刚保存的待提交值」显示成旧值。
  const fields: FieldView[] = (() => {
    if (!valid) return [];
    const n = Math.min(table.columns.length, source.columnCount);
    const q = filter.trim().toLowerCase();
    const out: FieldView[] = [];
    for (let col = 0; col < n; col += 1) {
      const f = viewOf(source, table, row, col);
      if (q !== '') {
        const hay = `${f.name}\n${f.shown}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(f);
    }
    return out;
  })();

  const copy = useCallback(
    async (f: FieldView) => {
      // 复制原文，不复制截断/美化后的展示串 —— 与 CellValueModal 的「与原字节一致」同口径
      const text = f.kind === 'null' ? '' : textOf(f.raw);
      try {
        await navigator.clipboard.writeText(text);
        setCopied(f.col);
        window.setTimeout(() => setCopied((cur) => (cur === f.col ? null : cur)), 900);
        onToast?.(`已复制 ${f.name}`);
      } catch {
        onToast?.('复制失败：写不进系统剪贴板');
      }
    },
    [onToast],
  );

  const startEdit = useCallback(
    (f: FieldView) => {
      if (!writable || !f.editable) return;
      setEditing({ col: f.col, text: editTextOf(source.value(row, f.col)) });
    },
    [writable, source, row],
  );

  const commit = useCallback(() => {
    if (!editing) return;
    const before = source.value(row, editing.col);
    const next = editing.text;
    if (editTextOf(before) !== next) onEdit(row, editing.col, next);
    setEditing(null);
  }, [editing, onEdit, row, source]);

  const setNull = useCallback(() => {
    if (!editing) return;
    if (source.value(row, editing.col) !== null) onEdit(row, editing.col, null);
    setEditing(null);
  }, [editing, onEdit, row, source]);

  if (!valid) {
    return (
      <div className="ri-root" data-testid="row-inspector-empty">
        <div className="detail-empty">选中一行后，这里显示该行全部字段；空表可先用「新增空白行」。</div>
      </div>
    );
  }

  return (
    <div className="ri-root" data-testid="row-inspector" data-row={row}>
      <div className="ri-bar">
        <span className="ri-pos" data-testid="row-inspector-pos">
          第 {row + 1} / {total} 行
        </span>
        <span className="ri-spacer" />
        <button type="button" onClick={() => onInspect(row, activeCol)} title="在弹窗中查看/编辑完整值">
          完整值
        </button>
      </div>
      <div className="ri-search">
        <IconSearch size={11} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤列名或值…"
          aria-label="过滤字段"
          data-testid="row-inspector-filter"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setFilter('');
            }
          }}
        />
        {filter !== '' ? (
          <button type="button" className="ri-icon-btn" onClick={() => setFilter('')} title="清空过滤">
            <IconX size={10} />
          </button>
        ) : null}
      </div>

      <div className="ri-fields">
        {fields.length === 0 ? <div className="detail-empty">没有匹配的字段</div> : null}
        {fields.map((f) => {
          const isEditing = editing?.col === f.col;
          return (
            <div
              key={f.col}
              className={`ri-field${f.col === activeCol ? ' active' : ''}${f.dirty ? ' dirty' : ''}`}
              data-testid={`row-inspector-field-${f.name}`}
            >
              <div className="ri-field-head">
                <span className="ri-name" title={f.name}>
                  {f.name}
                </span>
                {f.dirty ? <em className="ri-tag dirty-tag">待提交</em> : null}
                <span className="ri-spacer" />
                {f.dataType ? <span className="ri-type">{f.dataType}</span> : null}
                <button
                  type="button"
                  className="ri-icon-btn"
                  onClick={() => void copy(f)}
                  title={`复制 ${f.name} 的原文`}
                  aria-label={`复制 ${f.name}`}
                >
                  {copied === f.col ? <IconCheck size={10} /> : <IconCopy size={10} />}
                </button>
                {writable && f.editable ? (
                  <button
                    type="button"
                    className="ri-link-btn"
                    onClick={() => startEdit(f)}
                    title="编辑这一格（只标脏，⌘S 仍要预演）"
                  >
                    编辑
                  </button>
                ) : null}
              </div>

              {isEditing && editing ? (
                <div className="ri-editor">
                  <textarea
                    ref={editRef}
                    value={editing.text}
                    onChange={(e) => setEditing({ col: f.col, text: e.target.value })}
                    spellCheck={false}
                    rows={Math.min(6, Math.max(3, editing.text.split('\n').length + 1))}
                    aria-label={`编辑 ${f.name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditing(null);
                      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        commit();
                      }
                    }}
                  />
                  <div className="ri-editor-actions">
                    <button type="button" className="primary" onClick={commit}>
                      保存到待提交
                    </button>
                    <button type="button" onClick={setNull} title="把这一格标为 SQL NULL">
                      设为 NULL
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      取消
                    </button>
                    <span className="ri-hint">⌘↵ 保存 · Esc 取消</span>
                  </div>
                </div>
              ) : (
                <pre
                  className={`ri-value${f.kind === 'null' ? ' is-null' : ''}${f.kind === 'empty' ? ' is-empty' : ''}${f.kind === 'json' ? ' is-json' : ''}`}
                  onDoubleClick={() => startEdit(f)}
                  title={f.truncated ? '已截断，点「完整值」查看全部' : undefined}
                >
                  {f.kind === 'binary' ? <IconBinary size={11} /> : null}
                  {f.shown}
                  {f.truncated ? (
                    <button type="button" className="ri-more" onClick={() => onInspect(row, f.col)}>
                      查看全部
                    </button>
                  ) : null}
                </pre>
              )}
            </div>
          );
        })}
      </div>
      {!writable ? <div className="ri-readonly">当前表只读；可查看与复制，编辑请使用 SQL。</div> : null}
    </div>
  );
}