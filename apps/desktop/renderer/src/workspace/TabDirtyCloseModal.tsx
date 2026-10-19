/**
 * T27：批量关闭遇到脏标签时的**一次性**确认弹窗。
 *
 * 需求点名要消灭的行为：批量关闭 N 个脏表 → 连弹 N 个 window.confirm。
 * 这里一次列出 `plan.dirty` 的全部对象，用户三选一：
 *  - 取消：整批不关（真取消，一个都不关）
 *  - 取消勾选某几行：那几个标签保留（"逐一处理"）
 *  - 确认：勾选中的脏标签 + 全部无改动标签一起关
 *
 * 只做「列清单 + 取舍」，不提供「保存」按钮 —— 保存要走网格的预演链路
 * （App 的 onRequestSave），那是另一个入口，不该在这里另起一套。
 */

import { useEffect, useState } from 'react';
import { IconAlert } from '../ui/icons';
import { isImeComposing } from '../ui/imeGuard';
import type { BatchClosePlan } from './tabContextMenuModel';

export interface TabDirtyCloseModalProps {
  plan: BatchClosePlan;
  onCancel: () => void;
  /** 用户确认后要真正关闭的 id（已剔除"保留"的脏标签） */
  onConfirm: (ids: string[]) => void;
}

export function TabDirtyCloseModal({ plan, onCancel, onConfirm }: TabDirtyCloseModalProps) {
  /** 用户选择**保留**的脏标签 id（默认空 = 全部丢弃并关闭） */
  const [kept, setKept] = useState<Set<string>>(() => new Set());

  // 换了一批清单（新的一次批量关闭）时重置勾选 —— 否则上一批的"保留"会漏进来
  useEffect(() => {
    setKept(new Set());
  }, [plan]);

  // 与 DangerConfirmModal 同口径：Esc 必须能退出（挂 window，输入框内也不会漏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const discardIds = plan.dirty.filter((d) => !kept.has(d.id)).map((d) => d.id);
  const closeIds = [...plan.cleanIds, ...discardIds];
  const dirtyTotal = plan.dirty.reduce((n, d) => n + d.dirtyCount, 0);

  return (
    <div className="modal-mask" data-testid="tab-dirty-close-modal">
      <div className="modal tab-dirty-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="ic">
            <IconAlert />
          </span>
          有 {plan.dirty.length} 个标签存在未保存改动
        </header>
        <div className="body">
          <p className="tab-dirty-summary">
            共 {dirtyTotal} 处未保存改动。下面一次列全：取消勾选 = 保留该标签，确认后
            关闭其余 {plan.cleanIds.length} 个无改动标签与勾选中的标签。
          </p>
          <ul className="tab-dirty-list">
            {plan.dirty.map((d) => (
              <li
                key={d.id}
                className="tab-dirty-item"
                data-testid="tab-dirty-close-item"
                data-tab-id={d.id}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={!kept.has(d.id)}
                    onChange={(e) => {
                      const keep = !e.target.checked;
                      setKept((prev) => {
                        const next = new Set(prev);
                        if (keep) next.add(d.id);
                        else next.delete(d.id);
                        return next;
                      });
                    }}
                    data-testid="tab-dirty-close-keep"
                  />
                  <span className="tab-dirty-name">{d.objectLabel}</span>
                  <span className="tab-dirty-meta">
                    {d.dirtyCount} 处未保存改动
                    {d.connId ? ` · 连接 ${d.connId}` : ''}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <footer>
          <button onClick={onCancel} data-testid="tab-dirty-close-cancel">
            取消
          </button>
          <button
            className="primary"
            disabled={closeIds.length === 0}
            onClick={() => onConfirm(closeIds)}
            title={
              closeIds.length === 0
                ? '所有脏标签都已选择保留，没有可关闭的标签'
                : `丢弃勾选中的未保存改动并关闭 ${closeIds.length} 个标签`
            }
            data-testid="tab-dirty-close-confirm"
          >
            丢弃并关闭 {closeIds.length} 个标签
          </button>
        </footer>
      </div>
    </div>
  );
}
