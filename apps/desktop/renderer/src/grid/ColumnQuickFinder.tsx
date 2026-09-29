/**
 * 列列表快速定位浮层（V20）—— 自包含，接上就能用。
 *
 * 只负责浮层内部：输入 → rank → ↑↓ 选择 → Enter 选中 / Esc 关闭 / 点遮罩关闭。
 * **开关（⌘F12）由 App 层统一挂在 window 上**，本组件不碰 window —— 否则多个
 * 浮层实例会各自抢全局键盘，且卸载时容易漏解绑。
 *
 * 键盘事件挂在**组件根节点**上（输入框里的按键会冒泡到这里），并对每个事件
 * stopPropagation：App 层的全局快捷键（⌘K、⌘S、⌘W…）不该在浮层里被顺带触发。
 *
 * 集成示例（App 里用 ⌘F12 切一个 state 即可）：
 *   const [finderOpen, setFinderOpen] = useState(false);
 *   {finderOpen && table ? (
 *     <ColumnQuickFinder
 *       columns={table.columns}
 *       onPick={(col) => { scrollToColumn(col.name); setFinderOpen(false); }}
 *       onClose={() => setFinderOpen(false)}
 *     />
 *   ) : null}
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import { rankColumns } from './columnFinder';
import { IconSearch } from '../ui/icons';

export interface ColumnQuickFinderProps {
  columns: readonly ColumnMeta[];
  /** 选中某列（Enter / 点击）。调用方负责关闭浮层与把视图滚到该列 */
  onPick: (col: ColumnMeta) => void;
  /** 关闭（Esc / 点遮罩） */
  onClose: () => void;
  /** 结果条数上限，默认 50 */
  limit?: number;
  /** 输入框占位文案 */
  placeholder?: string;
}

/** 命中高亮：不用 <mark> 的默认黄底（深色主题下刺眼），跟主题走 --accent */
const MARK_STYLE = { background: 'transparent', color: 'var(--accent)', fontWeight: 700 } as const;

const HINT_STYLE = {
  padding: '6px 14px',
  borderTop: '1px solid var(--border)',
  fontSize: 11,
  color: 'var(--text-dim)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
} as const;

const EMPTY_STYLE = { padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' } as const;

/** 把命中下标渲染成高亮片段（未命中的整段保持原样，不逐字符拆 —— 省 DOM 节点） */
function Highlighted({ text, matches }: { text: string; matches: readonly number[] }): ReactNode {
  if (matches.length === 0) return <>{text}</>;
  const set = new Set(matches);
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === hit) j++;
    parts.push(
      hit ? (
        <mark key={i} style={MARK_STYLE}>
          {text.slice(i, j)}
        </mark>
      ) : (
        <span key={i}>{text.slice(i, j)}</span>
      ),
    );
    i = j;
  }
  return <>{parts}</>;
}

export function ColumnQuickFinder({
  columns,
  onPick,
  onClose,
  limit = 50,
  placeholder = '输入列名定位（支持首字母，如 ca → created_at）',
}: ColumnQuickFinderProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  // 输入变化就重新打分；rankColumns 是纯函数，列集合通常不变，缓存足够
  const hits = useMemo(() => rankColumns(columns, query, limit), [columns, query, limit]);

  // 挂载即聚焦：浮层是 ⌘F12 唤起的，用户接下来的动作一定是打字
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 结果集变短时把选中项拉回范围内（比如从 8 条筛到 2 条，光标不能停在 7）
  const activeIndex = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);

  // 键盘移动选中项时把它滚进可视区（结果超过一屏时才有意义）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function move(delta: number): void {
    const n = hits.length;
    if (n === 0) return;
    const from = activeIndex < 0 ? 0 : activeIndex;
    setActive((((from + delta) % n) + n) % n);
  }

  function commit(index: number): void {
    const hit = hits[index];
    if (hit) onPick(hit.column);
  }

  /**
   * 键盘全挂根节点：输入框内的按键冒泡到这里统一处理。
   * stopPropagation 是为了不让 ⌘K / ⌘W 之类的全局快捷键在浮层里被触发。
   */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="modal-mask" onMouseDown={onClose} onKeyDown={onKeyDown}>
      {/* 面板上阻止冒泡：点面板自己不该触发遮罩的"点外面关闭" */}
      <div
        className="palette"
        style={{ width: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="定位列"
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // 换了关键词就回到第一条，别停在旧位置上
          }}
        />

        {hits.length === 0 ? (
          <div style={EMPTY_STYLE}>没有匹配的列 —— 换个关键词，或按 Esc 关闭</div>
        ) : (
          <ul>
            {hits.map((hit, i) => (
              <li
                key={hit.column.name}
                ref={i === activeIndex ? activeRef : undefined}
                className={i === activeIndex ? 'active' : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                title={hit.column.comment ?? undefined}
              >
                <span>
                  <Highlighted text={hit.column.name} matches={hit.matches} />
                </span>
                <span className="sub">{hit.column.dataType}</span>
                {hit.column.isPrimaryKey ? <span className="badge">PK</span> : null}
              </li>
            ))}
          </ul>
        )}

        <div style={HINT_STYLE}>
          <IconSearch size={12} />
          <span>↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
          <span style={{ marginLeft: 'auto' }}>
            {hits.length} / {columns.length} 列
          </span>
        </div>
      </div>
    </div>
  );
}
