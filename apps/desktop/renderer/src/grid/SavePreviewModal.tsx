/**
 * 保存预演弹窗（PRD §6.3.4 硬要求）
 *
 * 系统的行为是：**提交前必须展示将要执行的完整 SQL**，多条改动可展开逐条查看。
 * 这是 Navicat 没做到、而我们拿来当差异化的地方 —— 所以这里不提供"跳过预览"。
 */

import { useState } from 'react';

export interface SavePreviewModalProps {
  statements: { sql: string; params: unknown[]; description?: string; hasSqlExpr?: boolean }[];
  rejected: { row: number; column: string; reason: string }[];
  onCancel: () => void;
  onConfirm: () => void;
}

/** 把参数回填进 SQL 供展示 —— 只用于预览，绝不用于执行 */
export function fillParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

export function SavePreviewModal({ statements, rejected, onCancel, onConfirm }: SavePreviewModalProps) {
  const [expandAll, setExpandAll] = useState(false);
  const shown = expandAll ? statements : statements.slice(0, 3);
  /**
   * V10：含 SQL 表达式的语句条数。
   *
   * 表达式值是**原样嵌进 SQL 文本**的（不走 ? 参数绑定），所以必须在这里
   * 显式告警 —— 头号红线要求「任何写操作必须可预览 SQL 原文」，
   * 而表达式模式下用户看到的原文里有一段是他自己写的 SQL，
   * 不标出来就等于让他盲签。
   */
  const exprCount = statements.filter((s) => s.hasSqlExpr).length;

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          即将执行 {statements.length} 条语句
          {rejected.length > 0 ? `（${rejected.length} 处被拒绝）` : ''}
        </header>
        <div className="body">
          {exprCount > 0 ? (
            <div className="banner warn" data-testid="expr-warning">
              其中 {exprCount} 条含 <strong>SQL 表达式</strong>：下面标有 fx 的值会
              <strong>原样嵌进 SQL 执行</strong>（不走参数绑定，如 <code>NOW()</code>、
              <code>amount * 2</code>）。请逐条确认原文。
            </div>
          ) : null}

          {rejected.length > 0 ? (
            <div className="banner warn">
              以下改动不会提交：
              <ul>
                {rejected.map((r, i) => (
                  <li key={i}>
                    第 {r.row + 1} 行 · {r.column} —— {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {statements.length === 0 ? (
            <p>没有需要提交的改动。</p>
          ) : (
            <>
              {shown.map((s, i) => (
                <div key={i} className={s.hasSqlExpr ? 'preview-sql has-expr' : 'preview-sql'} data-testid="preview-sql">
                  {s.hasSqlExpr ? (
                    <span className="preview-expr-tag" title="含 SQL 表达式，原样嵌入执行">fx</span>
                  ) : null}
                  <pre>{s.description ? `-- ${s.description}\n` : ''}{fillParams(s.sql, s.params)};</pre>
                </div>
              ))}
              {statements.length > 3 ? (
                <button onClick={() => setExpandAll((v) => !v)}>
                  {expandAll ? '收起' : `查看全部 ${statements.length} 条`}
                </button>
              ) : null}
            </>
          )}
        </div>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={onConfirm} disabled={statements.length === 0}>
            确认执行
          </button>
        </footer>
      </div>
    </div>
  );
}
