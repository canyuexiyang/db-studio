/**
 * 命令面板（PRD §6.8，D5）
 *
 * 从窗口顶部居中浮出，宽 640px，玻璃材质。输入即筛，↑↓ 选择，Enter 执行，Esc 关闭。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  queryPalette,
  moveSelection,
  parsePaletteInput,
  type PaletteMode,
  type CommandDef,
} from '@dbstudio/core-command-palette';
import type { PaletteItem } from '@dbstudio/core-command-palette';
import { isImeComposing } from '../ui/imeGuard';

export interface CommandPaletteProps {
  items: PaletteItem[];
  /**
   * @ 历史模式的【异步】数据源（走主进程 historySearch，P1-3 接线）。
   * 不传则退化为在 items 里同步过滤 —— demo 后端就是这么降级的。
   */
  historySource?: (keyword: string) => Promise<PaletteItem[]>;
  /** 命令集（内置命令 + 动态命令如片段）；不传用内置 */
  commands?: CommandDef[];
  onClose: () => void;
  onPickTable: (item: PaletteItem) => void;
  onPickHistory: (item: PaletteItem) => void;
  /**
   * V6：历史模式下删单条（⌘⌫）。不传则禁用该键。
   * 面板只负责"告知意图 + 关面板"，实际删除与列表刷新由宿主执行。
   */
  onDeleteHistory?: (item: PaletteItem) => void;
  /**
   * V6：历史模式下星标/取消星标（⌘S）。不传则禁用该键。
   * starred 参数 = 目标状态（取反后的值），宿主据此调 historyStar 并刷新。
   */
  onToggleHistoryStar?: (item: PaletteItem, starred: boolean) => void;
  /**
   * V6：历史刷新信号。宿主删/星标后自增它 → 面板重新拉 historySource，
   * 列表才会反映刚才的改动（面板内部对历史结果做了缓存）。
   */
  historyReloadKey?: number;
  onCommand: (action: string) => void;
}

const MODE_HINT: Record<PaletteMode, string> = {
  table: '搜索表与视图',
  command: '执行命令',
  history: '搜索查询历史（⌘S 星标 · ⌘⌫ 删除）',
};

export function CommandPalette({
  items,
  historySource,
  commands,
  onClose,
  onPickTable,
  onPickHistory,
  onDeleteHistory,
  onToggleHistoryStar,
  historyReloadKey,
  onCommand,
}: CommandPaletteProps) {
  const [input, setInput] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const parsed = useMemo(() => parsePaletteInput(input), [input]);
  const mode = parsed.mode;

  // @ 历史模式：每次输入变化调一次主进程 historySearch（真搜库里的历史表）。
  // seq 守卫乱序返回；不传 historySource（demo）保持 null，退回 items 同步过滤。
  const [remote, setRemote] = useState<PaletteItem[] | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    if (mode !== 'history' || !historySource) {
      setRemote(null);
      return;
    }
    const seq = ++seqRef.current;
    let alive = true;
    void (async () => {
      try {
        const r = await historySource(parsed.query);
        if (alive && seq === seqRef.current) setRemote(r);
      } catch {
        if (alive && seq === seqRef.current) setRemote([]);
      }
    })();
    return () => {
      alive = false;
    };
    // historyReloadKey：宿主删/星标后自增 → 重新拉取（否则列表是旧快照）
  }, [input, mode, parsed.query, historySource, historyReloadKey]);

  const { results } = useMemo(() => {
    const effItems = mode === 'history' && remote !== null ? remote : items;
    return queryPalette(input, { items: effItems, commands }, { limit: 10 });
  }, [input, items, commands, remote, mode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [input]);

  const run = useCallback(
    (i: number) => {
      const hit = results[i];
      if (!hit) return;
      const item = hit.item;
      if (mode === 'command') {
        const action = (item as PaletteItem & { action?: string }).action;
        if (action) onCommand(action);
      } else if (mode === 'history') {
        onPickHistory(item);
      } else {
        onPickTable(item);
      }
      onClose();
    },
    [results, mode, onCommand, onPickHistory, onPickTable, onClose],
  );

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder={`${MODE_HINT[mode]}　（: 命令 · @ 历史）`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // T13：命令面板里组合期 Enter 会**直接执行高亮命令**（可能是「删除表」）——
            // 必须先放行给输入法。
            if (isImeComposing(e)) return;
            const meta = e.metaKey || e.ctrlKey;
            // V6：历史模式专属操作 —— ⌘⌫ 删单条、⌘S 星标切换。
            // 只在 history 模式且宿主接了两个回调时生效，避免误吞其它模式的键。
            //
            // 🔴 必须 stopPropagation：App 的全局 keydown 挂在 window 上（⌘S=保存
            //    预演）。不停传播的话，面板里 ⌘S 星标会顺手弹出保存预演弹窗。
            if (mode === 'history' && meta && historySource) {
              const cur = results[index]?.item;
              if (cur && e.key === 'Backspace' && onDeleteHistory) {
                onDeleteHistory(cur);
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (cur && e.key.toLowerCase() === 's' && onToggleHistoryStar) {
                const starred = !(cur as PaletteItem & { starred?: boolean }).starred;
                onToggleHistoryStar(cur, starred);
                e.preventDefault();
                e.stopPropagation();
                return;
              }
            }
            if (e.key === 'ArrowDown') {
              setIndex((v) => moveSelection(v, 1, results.length));
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              setIndex((v) => moveSelection(v, -1, results.length));
              e.preventDefault();
            } else if (e.key === 'Enter') {
              run(index);
              e.preventDefault();
            } else if (e.key === 'Escape') {
              onClose();
              e.preventDefault();
            }
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li
              key={r.item.id}
              className={i === index ? 'active' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(i)}
            >
              <span>{r.item.title}</span>
              {r.item.subtitle ? <span className="sub">{r.item.subtitle}</span> : null}
              {r.item.badge ? <span className="badge">{r.item.badge}</span> : null}
            </li>
          ))}
          {results.length === 0 ? (
            // 🔴 带 palette-empty 标识：它**不是候选项**。
            //    不带标识时，`li` 计数会把「没有匹配项」当成 1 个候选，
            //    让「Enter 执行命令」这类断言在空列表上假绿（写 e2e 时踩过）。
            <li className="palette-empty">
              <span className="sub">
                {mode === 'history' && remote === null && historySource ? '搜索历史…' : '没有匹配项'}
              </span>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
