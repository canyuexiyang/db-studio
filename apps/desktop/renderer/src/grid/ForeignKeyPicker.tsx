/**
 * V9 外键候选值下拉（DataGrip「Navigation by foreign keys」的编辑半边）
 *
 * 编辑外键列时，在单元格下方浮出引用表的候选值：点选 = 填进编辑框。
 * 与「跳转到引用行」是同一份元数据的两个用法 —— 一个改视角，一个改值。
 *
 * 🔴 三条约束：
 *  1. **候选值必须带 limit**（宿主侧 buildReferencedValuesSql 已钳制），
 *     这里再显式传 limit，绝不为「下拉好看一点」去全表扫描；
 *  2. 拉取失败/引用表拿不到 → 显示原因并保留手输能力，**不静默失效**
 *     （V1-V7 那轮的核心教训：能看见但没反应，比没有更伤）；
 *  3. 浮层挂 fixed（与右键菜单同款），否则会被 .grid-viewport 的 overflow 裁掉。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconLink, IconX } from '../ui/icons';
import type { GridForeignKey } from './DataGrid';

/** 单次候选值上限（服务端 LIMIT，超出提示继续输入过滤） */
const LOOKUP_LIMIT = 200;

export interface ForeignKeyPickerProps {
  fk: GridForeignKey;
  /** 单元格视口坐标（浮层定位基准） */
  anchor: { x: number; y: number; width: number };
  lookup: (fk: GridForeignKey, keyword: string | null) => Promise<{ items: { value: unknown; label: string }[]; truncated: boolean } | null>;
  /** 选中一个候选值（value 已转成网格文本口径） */
  onPick: (value: string | null) => void;
  onClose: () => void;
}

export function ForeignKeyPicker({ fk, anchor, lookup, onPick, onClose }: ForeignKeyPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<{ value: unknown; label: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 高亮项（键盘上下移动） */
  const [cursor, setCursor] = useState(0);
  /** 竞态守卫：只认最后一次请求的结果 */
  const reqSeq = useRef(0);

  const run = useCallback(
    async (kw: string | null) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await lookup(fk, kw);
        if (seq !== reqSeq.current) return; // 已被更新的请求取代
        if (res === null) {
          setItems([]);
          setError('拿不到引用表的候选值（连接未就绪或无权限）');
        } else {
          setItems(res.items);
          setTruncated(res.truncated);
          setCursor(0);
        }
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [fk, lookup],
  );

  // 首次打开：拉一批默认候选（不带关键字）
  useEffect(() => {
    void run(null);
  }, [run]);

  // 输入过滤：200ms 防抖（服务端 LIKE，不能每敲一个字就打一次库）
  useEffect(() => {
    const kw = keyword.trim();
    if (kw === '') return;
    const t = window.setTimeout(() => void run(kw), 200);
    return () => window.clearTimeout(t);
  }, [keyword, run]);

  // 点外关闭（放行浮层内部）
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const pick = useCallback(
    (item: { value: unknown; label: string }) => {
      // 网格的值口径是文本（R10：BIGINT 也以字符串到达），这里保持一致
      onPick(item.value === null || item.value === undefined ? null : String(item.value));
    },
    [onPick],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'ArrowDown') {
        setCursor((c) => (items.length ? Math.min(items.length - 1, c + 1) : 0));
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'ArrowUp') {
        setCursor((c) => (items.length ? Math.max(0, c - 1) : 0));
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter' && items[cursor]) {
        pick(items[cursor]);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [items, cursor, pick, onClose],
  );

  // 浮层定位：贴单元格下方，超出视口则翻到上方
  const placeBelow = anchor.y + 320 < window.innerHeight;
  const style: React.CSSProperties = {
    left: Math.max(4, Math.min(anchor.x, window.innerWidth - 280)),
    ...(placeBelow ? { top: anchor.y } : { bottom: window.innerHeight - anchor.y }),
  };

  return (
    <div className="gd-fk-picker" ref={rootRef} style={style} data-testid="fk-picker" onKeyDown={onKeyDown}>
      <div className="gd-fk-head">
        <IconLink size={11} />
        <span className="gd-fk-title">
          {fk.referencedTable}.{fk.referencedColumn}
        </span>
        <span className="gd-tool-spacer" />
        <button type="button" className="gd-tool-btn" title="关闭（Esc）" onClick={onClose}>
          <IconX size={11} />
        </button>
      </div>

      <input
        className="gd-fk-filter"
        type="text"
        autoFocus
        data-testid="fk-filter"
        placeholder="输入过滤（服务端 LIKE，最多 200 条）"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />

      {error ? <div className="gd-fk-error">{error}</div> : null}

      <div className="gd-fk-list" data-testid="fk-list">
        {loading ? <div className="gd-fk-empty">加载中…</div> : null}
        {!loading && items.length === 0 && !error ? (
          <div className="gd-fk-empty">没有候选值（可继续手输）</div>
        ) : null}
        {!loading &&
          items.map((it, i) => (
            <button
              type="button"
              key={`${String(it.value)}-${i}`}
              className={`gd-fk-item${i === cursor ? ' gd-on' : ''}`}
              data-testid="fk-item"
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(it)}
            >
              <span className="gd-fk-value">{it.value === null || it.value === undefined ? 'NULL' : String(it.value)}</span>
              {it.label && it.label !== String(it.value) ? <span className="gd-fk-label">{it.label}</span> : null}
            </button>
          ))}
      </div>

      {truncated ? (
        <div className="gd-fk-foot">仅显示前 {LOOKUP_LIMIT} 条，请输入关键字继续过滤</div>
      ) : (
        <div className="gd-fk-foot gd-fk-foot-dim">↑↓ 选择 · Enter 填入 · Esc 关闭</div>
      )}
    </div>
  );
}
