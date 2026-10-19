/**
 * T32：长文本单值编辑器 —— 换行编辑 + 弹窗内查找（可取消）+ 字符数 + 明确复制对象。
 *
 * 🔴 这个文件是 `React.lazy()` 的目标：**不进首屏 bundle**（AGENTS.md §四.9/10）。
 *    网格滚动路径上不需要它，用户右键「查看完整值」→ 点「编辑」才会拉这个 chunk。
 *
 * 🔴 这里**只能编辑这一个值**：明确拒绝把它长成整行 Form View（任务约束）。
 *    提交动作是把草稿交给宿主的脏格层（`onCommit`），改动范围永远是当前格。
 *
 * Esc 语义（任务原文「Esc 保持原草稿」）：编辑中按 Esc → 退出编辑器但**保留草稿**
 * （草稿状态在父组件里，本组件卸载不丢内容），不是「放弃修改」也不是「关闭弹窗」。
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { measureText, formatTextMetrics } from './textMetrics';
import {
  SEARCH_INITIAL_STATE,
  cancelSearch,
  findAllMatches,
  runSearch,
  type SearchState,
} from './textSearch';
import { IconCopy, IconSearch, IconWrap, IconX } from '../ui/icons';
import { isImeComposing } from '../ui/imeGuard';

/** 小于这个字符数就同步搜完（一次 indexOf 级别的成本），超过才走可取消的分块搜索 */
const SYNC_SEARCH_LIMIT = 1_000_000;
/** 分块搜索每帧扫描的字符数（主线程不被一次搜索卡住的关键） */
const SEARCH_CHUNK_CHARS = 200_000;

export interface TextValueEditorProps {
  /** 受控草稿文本 */
  value: string;
  onChange: (text: string) => void;
  /** 基准值（已落库 / 已标脏的值）—— 用来判定「草稿有改动」 */
  baseValue: string;
  /** 宿主是否接好了脏格提交（false → 提交按钮 disabled + 中文原因） */
  canCommit: boolean;
  commitDisabledReason?: string;
  /** 提交草稿（父组件负责写脏格） */
  onCommit: () => void;
  /** Esc：退出编辑，**保留草稿** */
  onExitEditing: () => void;
  /** 丢弃草稿回到基准值 */
  onDiscardDraft: () => void;
  /** 复制（带显式对象文案） */
  onCopy: (text: string, label: string) => void;
  /** 让宿主（CellValueModal）在 Esc 时优先调我们的处理 */
  escHookRef?: MutableRefObject<(() => void) | null>;
}

export default function TextValueEditor({
  value,
  onChange,
  baseValue,
  canCommit,
  commitDisabledReason,
  onCommit,
  onExitEditing,
  onDiscardDraft,
  onCopy,
  escHookRef,
}: TextValueEditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const [wrap, setWrap] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<SearchState>(SEARCH_INITIAL_STATE);
  const [cursor, setCursor] = useState(0);

  const metrics = useMemo(() => measureText(value), [value]);
  const dirty = value !== baseValue;

  // 宿主 Esc 钩子：找开→关查找；否则→退出编辑保留草稿（装卸载都要摘干净，避免泄漏）
  useEffect(() => {
    if (!escHookRef) return;
    escHookRef.current = () => {
      if (findOpen) {
        setFindOpen(false);
        setHits(cancelSearch(hits));
        return;
      }
      onExitEditing();
    };
    return () => {
      if (escHookRef.current) escHookRef.current = null;
    };
  }, [escHookRef, findOpen, hits, onExitEditing]);

  /**
   * 搜索：小文本一次跑完；大文本分块跑，期间的取消位由 UI 控制。
   *
   * 🔴 effect 依赖里带上 `value`（草稿在变）：上一次的 run 会在 cleanup 里被丢弃，
   *    不会把过期结果渲染到界面上。
   */
  useEffect(() => {
    if (!findOpen || query === '') {
      setHits(SEARCH_INITIAL_STATE);
      setCursor(0);
      return;
    }
    if (value.length <= SYNC_SEARCH_LIMIT) {
      setHits(findAllMatches(value, { text: query, caseSensitive }));
      setCursor(0);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    let st: SearchState = SEARCH_INITIAL_STATE;
    const tick = (): void => {
      if (!alive) return;
      st = runSearch(value, { text: query, caseSensitive }, st, SEARCH_CHUNK_CHARS);
      setHits(st);
      if (!st.done) timer = window.setTimeout(tick, 0);
    };
    tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      // 卸载/重跑时把上一次的分块结果作废，避免「旧进度条继续前进」的假象
      setHits((s) => cancelSearch(s));
    };
  }, [findOpen, query, caseSensitive, value]);

  /** 跳到第 n 处命中：浏览器会把 caret 滚进视野，无需手写 scroll 计算 */
  const gotoHit = (delta: number): void => {
    const total = hits.matches.length;
    if (total === 0) return;
    const next = (cursor + delta + total) % total;
    setCursor(next);
    const start = hits.matches[next];
    const ta = areaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(start, start + query.length);
    }
  };

  const hitCount = hits.matches.length;
  const statusText = (): string => {
    if (query === '') return '输入要查找的内容';
    if (hits.cancelled) return `已取消（保留找到的 ${hitCount} 处）`;
    if (!hits.done) {
      const pct = Math.min(100, Math.floor((hits.scanned / Math.max(1, value.length)) * 100));
      return `搜索中… 已扫描 ${pct}%（${hitCount} 处）`;
    }
    if (hitCount === 0) return '无匹配';
    return hits.truncated ? `${cursor + 1}/${hitCount}+ 处（命中过多，已截断）` : `第 ${cursor + 1}/${hitCount} 处`;
  };

  return (
    <div className="cv-editor">
      <div className="cv-editor-bar" data-testid="cv-editor-bar">
        <button
          type="button"
          className={findOpen ? 'dt-on' : ''}
          onClick={() => setFindOpen((v) => !v)}
          title="在编辑器内查找（Esc 可取消）"
          data-testid="cv-editor-find-toggle"
        >
          <IconSearch size={11} />
          查找
        </button>
        <button
          type="button"
          className={wrap ? 'dt-on' : ''}
          onClick={() => setWrap((v) => !v)}
          title="自动换行（关掉后按行横向滚动）"
          data-testid="cv-editor-wrap-toggle"
        >
          <IconWrap size={11} />
          换行
        </button>
        <span className="cv-editor-metrics" data-testid="cv-editor-metrics">
          {formatTextMetrics(metrics)}
        </span>
        <span className="dt-json-bar-spacer" />
        {dirty ? (
          <span className="cv-draft-badge" data-testid="cv-editor-dirty-badge">
            草稿未写入
          </span>
        ) : null}
        <button type="button" onClick={() => onCopy(value, '当前编辑框里的草稿')} data-testid="cv-editor-copy-draft">
          <IconCopy size={11} />
          复制草稿
        </button>
        <button
          type="button"
          onClick={onDiscardDraft}
          disabled={!dirty}
          title={dirty ? '丢弃草稿，回到基准值' : '草稿与基准值一致，无可丢弃'}
          data-testid="cv-editor-discard"
        >
          <IconX size={11} />
          丢弃草稿
        </button>
        <button
          type="button"
          className="primary"
          onClick={onCommit}
          disabled={!canCommit || !dirty}
          title={!canCommit ? (commitDisabledReason ?? '宿主未提供写脏格的接线') : !dirty ? '草稿与当前值一致，不需要写入' : '写入当前格的待提交值（不会立即入库，走保存预演）'}
          data-testid="cv-editor-commit"
        >
          存为待提交值
        </button>
      </div>

      {findOpen ? (
        <div className="cv-find" data-testid="cv-editor-find">
          <input
            ref={findInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                gotoHit(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="查找内容（Esc 取消）"
            data-testid="cv-editor-find-input"
          />
          <label className="cv-find-cs">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} data-testid="cv-editor-find-case" />
            区分大小写
          </label>
          <button type="button" disabled={hitCount === 0} onClick={() => gotoHit(-1)} title={hitCount === 0 ? '没有命中，无法跳转' : '上一处'} data-testid="cv-editor-find-prev">
            上一个
          </button>
          <button type="button" disabled={hitCount === 0} onClick={() => gotoHit(1)} title={hitCount === 0 ? '没有命中，无法跳转' : '下一处'} data-testid="cv-editor-find-next">
            下一个
          </button>
          <button
            type="button"
            disabled={hits.done}
            onClick={() => setHits((s) => cancelSearch(s))}
            title={hits.done ? '搜索已结束，无需停止' : '停止搜索（已找到的内容保留）'}
            data-testid="cv-editor-find-stop"
          >
            停止
          </button>
          <span className="cv-find-status" data-testid="cv-editor-find-status">
            {statusText()}
          </span>
        </div>
      ) : null}

      <textarea
        ref={areaRef}
        className="cv-editor-area"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={wrap ? undefined : { whiteSpace: 'pre', overflowX: 'auto' }}
        spellCheck={false}
        wrap={wrap ? 'soft' : 'off'}
        data-testid="cv-editor-textarea"
      />

      <div className="cv-editor-foot">
        <span>Esc 退出编辑并保留草稿 · Ctrl/⌘+Enter 不自动提交（避免误写脏格）</span>
        <span className="dt-json-bar-spacer" />
        <button type="button" onClick={onExitEditing} data-testid="cv-editor-exit">
          退出编辑（保留草稿）
        </button>
      </div>
    </div>
  );
}
