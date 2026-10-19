/**
 * T35：JSON 折叠树视图（CellValueModal 的 JSON 分支，`React.lazy` 目标）。
 *
 * 行模型 / 折叠 / JSON Pointer / 搜索索引全部来自 `jsonTreeModel`（纯逻辑），
 * 这里只做渲染与交互：
 *  - 折叠/展开（懒加载：展开那一刻才扫子节点，DOM 上限 MAX_VISIBLE_JSON_NODES）；
 *  - 每行显示 RFC 6901 JSON Pointer 路径 + 复制按钮；
 *  - 搜索（复用 textSearch 的可取消状态机）+ 上一个/下一个跳转 + 停止；
 *  - 只读：树上没有任何编辑入口，源文不改写。
 *
 * 「格式化 ↔ 树」的切换开关在 CellValueModal；本组件只渲染树这一侧。
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  parseJsonRoot,
  flattenVisible,
  defaultExpanded,
  buildRowSearchIndex,
  matchesToRows,
  MAX_VISIBLE_JSON_NODES,
  type JsonTreeRow,
} from './jsonTreeModel';
import { SEARCH_INITIAL_STATE, cancelSearch, findAllMatches, runSearch, type SearchState } from './textSearch';
import { formatCount } from '@dbstudio/core-sql-editor/facts';
import { IconCopy, IconSearch } from '../ui/icons';
import { isImeComposing } from '../ui/imeGuard';

/** 树内搜索的小文本同步跑完；超过才走分块（行数已被上限卡住，一般不会超） */
const TREE_SYNC_SEARCH_LIMIT = 1_000_000;
const TREE_SEARCH_CHUNK_CHARS = 200_000;

export interface JsonTreeViewProps {
  /** JSON 原文（只读，绝不改写） */
  source: string;
  onToast?: (message: string) => void;
  /** 让宿主（CellValueModal）在 Esc 时优先交给树（关闭搜索框而不是关弹窗） */
  escHookRef?: MutableRefObject<(() => void) | null>;
}

export default function JsonTreeView({ source, onToast, escHookRef }: JsonTreeViewProps) {
  const root = useMemo(() => parseJsonRoot(source), [source]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [initialized, setInitialized] = useState(false);
  // 搜索状态
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<SearchState>(SEARCH_INITIAL_STATE);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 初次挂载：默认展开两层（受行数上限约束）
  useEffect(() => {
    if (!root) return;
    setExpanded(defaultExpanded(source, root));
    setInitialized(true);
  }, [root, source]);

  const flat = useMemo(() => {
    if (!root) return { rows: [] as JsonTreeRow[], truncated: false };
    return flattenVisible(source, root, expanded);
  }, [source, root, expanded]);

  /** 行号 → DOM 锚点（用 data-row-id 而不是数组下标 —— 下标在展开集合变化时会漂移） */
  const searchIndex = useMemo(() => buildRowSearchIndex(flat.rows), [flat.rows]);

  // 树内搜索：小索引同步跑完；大索引分块跑可取消
  useEffect(() => {
    if (!findOpen || query === '') {
      setHits(SEARCH_INITIAL_STATE);
      setCursor(0);
      return;
    }
    if (searchIndex.text.length <= TREE_SYNC_SEARCH_LIMIT) {
      setHits(findAllMatches(searchIndex.text, { text: query, caseSensitive }));
      setCursor(0);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    let st: SearchState = SEARCH_INITIAL_STATE;
    const tick = (): void => {
      if (!alive) return;
      st = runSearch(searchIndex.text, { text: query, caseSensitive }, st, TREE_SEARCH_CHUNK_CHARS);
      setHits(st);
      if (!st.done) timer = window.setTimeout(tick, 0);
    };
    tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      setHits((s) => cancelSearch(s));
    };
  }, [findOpen, query, caseSensitive, searchIndex]);

  const hitRows = useMemo(() => matchesToRows(searchIndex, hits.matches), [searchIndex, hits.matches]);
  const hitRowSet = useMemo(() => new Set(hitRows), [hitRows]);
  const hitCount = hitRows.length;

  const gotoHit = (delta: number): void => {
    if (hitCount === 0) return;
    const next = (cursor + delta + hitCount) % hitCount;
    setCursor(next);
    const rowIdx = hitRows[next];
    const el = containerRef.current?.querySelector(`[data-tree-row="${rowIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  // Esc 钩子：搜索框开着 → 先关搜索框；否则交还弹窗（关闭）
  useEffect(() => {
    if (!escHookRef) return;
    escHookRef.current = () => {
      if (findOpen) {
        setFindOpen(false);
        setQuery('');
        setHits((s) => cancelSearch(s));
        return;
      }
      // 没有可吃掉的 Esc：显式交还（宿主看到 null 就自己处理）
      escHookRef.current = null;
    };
    return () => {
      if (escHookRef.current) escHookRef.current = null;
    };
  }, [escHookRef, findOpen]);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    onToast?.(`已复制${label}`);
  };

  if (!root) {
    // parseJsonRoot 失败：调用方（CellValueModal）保证只在合法 JSON 时挂本组件；
    // 真到这说明状态串了 —— 如实说，不假装能显示
    return <div className="dt-json-hint">JSON 解析失败，无法渲染树视图（请退回「格式化 / 原文」视图）</div>;
  }

  const statusText = (): string => {
    if (!findOpen) return '';
    if (query === '') return '输入要查找的内容';
    if (hits.cancelled) return `已取消（找到 ${hitCount} 个节点）`;
    if (!hits.done) {
      const pct = Math.min(100, Math.floor((hits.scanned / Math.max(1, searchIndex.text.length)) * 100));
      return `搜索中… ${pct}%（已命中 ${hitCount} 个节点）`;
    }
    if (hitCount === 0) return '无匹配';
    return `${cursor + 1}/${hitCount} 个节点`;
  };

  return (
    <div className="dt-tree" data-testid="json-tree-view">
      <div className="dt-json-bar">
        <button
          type="button"
          className={findOpen ? 'dt-on' : ''}
          onClick={() => setFindOpen((v) => !v)}
          title="在树中查找节点（可取消）"
          data-testid="json-tree-find-toggle"
        >
          <IconSearch size={11} />
          查找
        </button>
        <span className="dt-tree-count" data-testid="json-tree-count">
          {formatCount(flat.rows.length)} 个可见节点
        </span>
        <span className="dt-json-bar-spacer" />
        <button
          type="button"
          onClick={() => {
            setExpanded(new Set());
          }}
          title="全部折叠（只留根节点）"
          data-testid="json-tree-collapse-all"
        >
          全部折叠
        </button>
      </div>

      {findOpen ? (
        <div className="cv-find" data-testid="json-tree-find">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                gotoHit(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="查找键或值（Esc 取消）"
            data-testid="json-tree-find-input"
          />
          <label className="cv-find-cs">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} data-testid="json-tree-find-case" />
            区分大小写
          </label>
          <button type="button" disabled={hitCount === 0} onClick={() => gotoHit(-1)} title={hitCount === 0 ? '没有命中' : '上一个节点'} data-testid="json-tree-find-prev">
            上一个
          </button>
          <button type="button" disabled={hitCount === 0} onClick={() => gotoHit(1)} title={hitCount === 0 ? '没有命中' : '下一个节点'} data-testid="json-tree-find-next">
            下一个
          </button>
          <button
            type="button"
            disabled={hits.done}
            onClick={() => setHits((s) => cancelSearch(s))}
            title={hits.done ? '搜索已结束' : '停止搜索（已找到的保留）'}
            data-testid="json-tree-find-stop"
          >
            停止
          </button>
          <span className="cv-find-status" data-testid="json-tree-find-status">
            {statusText()}
          </span>
        </div>
      ) : null}

      {flat.truncated ? (
        <div className="dt-json-hint" data-testid="json-tree-truncated">
          已达展开上限（{formatCount(MAX_VISIBLE_JSON_NODES)} 行）：折叠部分分支后才能展开更多（防巨大 JSON 一次铺满 DOM）
        </div>
      ) : null}

      <div className="dt-tree-body" ref={containerRef} data-testid="json-tree-body">
        {flat.rows.map((row, i) => {
          const node = row.node;
          const isHit = hitRowSet.has(i);
          const isCurrentHit = hitRows.length > 0 && hitRows[cursor] === i;
          const ptr = node.pointer === '' ? '（根）' : node.pointer;
          return (
            <div
              key={node.id || '(root)'}
              className={`dt-tree-row${isHit ? (isCurrentHit ? ' dt-tree-hit-cur' : ' dt-tree-hit') : ''}`}
              style={{ paddingInlineStart: `${node.depth * 14}px` }}
              data-tree-row={i}
              data-pointer={node.pointer}
            >
              {node.hasChildren ? (
                <button
                  type="button"
                  className="dt-tree-caret"
                  onClick={() => toggle(node.id)}
                  title={row.expanded ? '折叠' : `展开（${row.childCount ?? '?'} 个子项）`}
                  aria-expanded={row.expanded}
                  data-testid="json-tree-caret"
                >
                  {row.expanded ? '▾' : '▸'}
                </button>
              ) : (
                <span className="dt-tree-leaf" aria-hidden="true">
                  ·
                </span>
              )}
              <span className={`dt-tree-key dt-tree-kind-${node.kind}`}>
                {node.key !== null ? node.key : node.index !== null ? `[${node.index}]` : '（根）'}
              </span>
              {node.hasChildren ? (
                <span className="dt-tree-summary">{row.expanded ? (row.childCount != null ? `${row.childCount} 项` : '…') : row.childCount != null ? `…（${row.childCount} 项）` : '…'}</span>
              ) : (
                <span className={`dt-tree-val dt-tree-kind-${node.kind}`}>{node.valueText}</span>
              )}
              <span className="dt-json-bar-spacer" />
              <button
                type="button"
                className="dt-tree-copy"
                onClick={() => copyText(node.pointer, ` JSON Pointer 路径「${ptr}」`)}
                title={`复制 JSON Pointer 路径（RFC 6901）：${ptr}`}
                data-testid="json-tree-copy-pointer"
              >
                <IconCopy size={10} />
                {ptr}
              </button>
            </div>
          );
        })}
        {!initialized ? <div className="dt-json-hint">构建树…</div> : null}
      </div>
    </div>
  );
}
