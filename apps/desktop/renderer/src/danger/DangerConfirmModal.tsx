/**
 * 危险操作确认弹窗（P0-3，PRD §8.5 安全交互）
 *
 * 两档：
 *  - confirm：二次确认，展示 SQL 原文 + 影响说明
 *  - danger（生产环境红色标签 / DROP DATABASE）：第三层 —— 必须手动输入
 *    表名/库名才能点确认
 *
 * 硬要求（PRD §8.5）：
 *  - 确认弹窗必须展示将要执行的 SQL 原文，不允许只写"确定要删除吗？"
 *  - 生产环境 + 危险 = 手动输入表名，输错不给过
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconAlert } from '../ui/icons';

export interface DangerConfirmRequest {
  /** 弹窗标题 */
  title: string;
  /** 将执行的 SQL 语句（原文，逐条展示） */
  statements: string[];
  /** 危险原因（如「无 WHERE 条件将影响全部行」） */
  reason?: string;
  /**
   * 第三层确认要求输入的名字（表名/库名）。
   * 有值 = 生产级（红标连接或 DROP DATABASE）；无 = 普通二次确认。
   */
  requireText?: string | null;
}

export interface DangerConfirmModalProps {
  request: DangerConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}

export function DangerConfirmModal({ request, onResolve }: DangerConfirmModalProps) {
  const isProduction = request.requireText != null && request.requireText !== '';
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 生产模式自动聚焦输入框
  useEffect(() => {
    if (isProduction) inputRef.current?.focus();
  }, [isProduction]);

  const match = useMemo(
    () => !isProduction || input.trim() === request.requireText,
    [isProduction, input, request.requireText],
  );

  const confirm = () => {
    if (!match) return;
    onResolve(true);
  };

  return (
    <div className="modal-mask" data-testid="danger-confirm">
      <div className="modal danger-modal" onClick={(e) => e.stopPropagation()}>
        <header className={isProduction ? 'danger' : ''}>
          {isProduction ? <span className="state-dot danger-dot" aria-label="生产环境" /> : <IconAlert />}
          {request.title}
        </header>
        <div className="body">
          {request.reason ? <p className="danger-reason">{request.reason}</p> : null}

          <p className="danger-label">将要执行的语句：</p>
          <div className="danger-sql">
            {request.statements.map((s, i) => (
              <pre key={i}>{s}</pre>
            ))}
          </div>

          {isProduction ? (
            <div className="danger-input-row">
              <label>
                这是生产环境连接。请输入 <b>{request.requireText}</b> 以确认：
              </label>
              <input
                ref={inputRef}
                value={input}
                placeholder={request.requireText ?? ''}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && match) confirm();
                  if (e.key === 'Escape') onResolve(false);
                }}
                data-testid="danger-confirm-input"
              />
            </div>
          ) : null}
        </div>
        <footer>
          <button onClick={() => onResolve(false)}>取消</button>
          <button
            className="primary danger-primary"
            disabled={!match}
            onClick={confirm}
            data-testid="danger-confirm-btn"
          >
            {isProduction ? '确认执行（不可恢复）' : '确认执行'}
          </button>
        </footer>
      </div>
    </div>
  );
}
