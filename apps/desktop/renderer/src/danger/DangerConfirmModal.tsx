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
import { isImeComposing } from '../ui/imeGuard';

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
  /**
   * 🔴 0.7.3：这里的判据是「**需要输名**」，不是「生产环境」。
   *
   * 两者过去被混成一个布尔，结果是文案替调用方撒谎：非生产的「删除数据库」
   * 也走第三层（审计红线：删库比删表更严格），弹窗却写着「这是生产环境连接」。
   * 环境判断属于 `confirmDanger`（它知道 colorTag 并据此改标题与红标），
   * 弹窗只负责「要不要输名」这一件事。
   */
  const needsText = request.requireText != null && request.requireText !== '';
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 需要输名时自动聚焦输入框（键盘用户不必先 Tab）
  useEffect(() => {
    if (needsText) inputRef.current?.focus();
  }, [needsText]);

  /**
   * 🔴 T18 / 报告 §4.5：Esc 关闭。
   *
   * 原来 Esc 只挂在**生产模式的输入框**上 ⇒ 普通（非生产）确认框按 Esc
   * **关不掉**，只能点「取消」或点遮罩 —— 而危险确认框恰恰是最需要能一键退出的地方。
   * 现在统一挂到 window（与其它弹窗同口径）；输入框那条只留 Enter 确认。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') onResolve(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve]);

  const match = useMemo(
    () => !needsText || input.trim() === request.requireText,
    [needsText, input, request.requireText],
  );

  const confirm = () => {
    if (!match) return;
    onResolve(true);
  };

  return (
    <div className="modal-mask" data-testid="danger-confirm">
      <div className="modal danger-modal" onClick={(e) => e.stopPropagation()}>
        <header className={needsText ? 'danger' : ''}>
          {needsText ? <span className="state-dot danger-dot" aria-label="危险操作" /> : <IconAlert />}
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

          {needsText ? (
            <div className="danger-input-row">
              <label>
                请输入 <b>{request.requireText}</b> 以确认（此操作不可恢复）：
              </label>
              <input
                ref={inputRef}
                value={input}
                placeholder={request.requireText ?? ''}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // T13：危险确认框尤其不能把「确认候选词」当成「确认执行」
                  if (isImeComposing(e)) return;
                  // Esc 由上面的 window 监听统一处理（避免输入框内触发两次）
                  if (e.key === 'Enter' && match) confirm();
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
            {needsText ? '确认执行（不可恢复）' : '确认执行'}
          </button>
        </footer>
      </div>
    </div>
  );
}
