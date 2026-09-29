/**
 * 多标签条（P0-4）—— 工作区顶部 tab UI
 *
 * 交互：
 *  - 单击切换；中键/关闭按钮关闭（table tab 有脏数据时 onBeforeClose 返回 false 拦截）
 *  - ＋ 新建查询标签
 *  - 只读连接的 tab 标题后带锁图标（PRD §6.2 只读标识）
 *  - 图标一律来自 ui/icons.tsx（红线：禁止 emoji 当图标）
 */

import { memo } from 'react';
import type { WorkspaceTab } from './useWorkspaceTabs';
import { IconTable, IconTerminal, IconLock, IconX, IconPlus } from '../ui/icons';

export interface WorkspaceTabsBarProps {
  tabs: WorkspaceTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  /** 关闭前确认（table tab 有脏数据时弹确认）；返回 true 才真正关 */
  onBeforeClose?: (tab: WorkspaceTab) => boolean;
  /** 连接只读标记（connId → readOnly） */
  readOnlyConns: Record<string, boolean>;
}

export const WorkspaceTabsBar = memo(function WorkspaceTabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewQuery,
  onBeforeClose,
  readOnlyConns,
}: WorkspaceTabsBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="ws-tabs" data-testid="ws-tabs">
      {tabs.map((t, i) => {
        const readOnly = t.connId ? readOnlyConns[t.connId] === true : false;
        return (
          <div
            key={t.id}
            className={`ws-tab${t.id === activeId ? ' active' : ''}`}
            data-testid={`ws-tab-${t.title}`}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => {
              // 中键关闭（macOS 惯例）
              if (e.button === 1) {
                e.preventDefault();
                if (!onBeforeClose || onBeforeClose(t)) onClose(t.id);
              }
            }}
            title={t.kind === 'table' ? `${t.database}.${t.tableName}` : t.title}
          >
            <span className="ws-tab-icon">{t.kind === 'table' ? <IconTable size={11} /> : <IconTerminal size={11} />}</span>
            <span className="ws-tab-label">
              {t.title}
              {readOnly ? <span className="ws-tab-readonly" title="只读连接"><IconLock size={10} /></span> : null}
              {t.kind === 'table' && t.dirtyCount > 0 ? (
                <span className="ws-tab-dirty" title={`${t.dirtyCount} 个未保存改动`}>
                  {' •'}
                </span>
              ) : null}
            </span>
            <button
              className="ws-tab-close"
              title="关闭（⌘W）"
              onClick={(e) => {
                e.stopPropagation();
                if (!onBeforeClose || onBeforeClose(t)) onClose(t.id);
              }}
            >
              <IconX size={10} />
            </button>
            {/* ⌘1..9 提示 */}
            {i < 9 ? <span className="ws-tab-index">{i + 1}</span> : null}
          </div>
        );
      })}
      <button className="ws-tab-new" title="新建查询标签（⌘T）" onClick={onNewQuery} data-testid="ws-new-query">
        <IconPlus size={12} />
      </button>
    </div>
  );
});
