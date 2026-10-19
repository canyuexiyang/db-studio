/**
 * 保存预演弹窗（PRD §6.3.4 硬要求）
 *
 * 系统的行为是：**提交前必须展示将要执行的完整 SQL**，多条改动可展开逐条查看。
 * 这是 Navicat 没做到、而我们拿来当差异化的地方 —— 所以这里不提供"跳过预览"。
 *
 * T21：在此之上**增加**「旧值 → 新值」摘要（对象 / 行定位 / 字段 / 改前改后），
 * 让用户不必读 SQL 也能一眼核对。⚠️ 摘要只是**多一层**核对 —— 原文 SQL 仍是权威，
 * 逐条可看、不折叠、不做可选绕过（红线本身没有变）。
 */

import { useState } from 'react';
import type { ChangeSummary } from '@dbstudio/core-mutation';
import { fillParams, countPlaceholders } from './fillParams';

export interface SavePreviewModalProps {
  statements: {
    sql: string;
    params: unknown[];
    description?: string;
    hasSqlExpr?: boolean;
    /** T21：该语句的「旧值→新值」摘要；缺省则不显示该条摘要（不猜、不补） */
    summary?: ChangeSummary;
  }[];
  rejected: { row: number; column: string; reason: string }[];
  onCancel: () => void;
  onConfirm: () => void;
}

export { fillParams };

/** 摘要表的内联样式（本弹窗不引新 CSS 文件，避免动他人样式） */
const thStyle = { textAlign: 'left', fontWeight: 500, color: 'var(--text-dim)', padding: '2px 8px 2px 0' } as const;
const tdStyle = { padding: '2px 8px 2px 0', verticalAlign: 'top', wordBreak: 'break-all' } as const;

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
  /**
   * T21：摘要覆盖**全部**将要执行的语句（不受「只显示前 3 条 SQL」的截断影响）——
   * 摘要的用途就是让人不用展开也能核对所有改动。没有 summary 的语句（如外部
   * 构造的语句）直接跳过，绝不显示空壳行。
   */
  const summaries = statements.map((s) => s.summary).filter((s): s is ChangeSummary => s !== undefined);

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

          {summaries.length > 0 ? (
            <div data-testid="change-summary" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                改动摘要（改前 → 改后）—— 请与下方 SQL 原文对照核对
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>对象</th>
                    <th style={thStyle}>行定位</th>
                    <th style={thStyle}>字段</th>
                    <th style={thStyle}>改前 → 改后</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.flatMap((s, si) => {
                    // 整行操作（DELETE）或「未指定任何列的新增行」没有字段级改动
                    if (s.changes.length === 0) {
                      const isDelete = s.kind === 'delete';
                      return [
                        <tr
                          key={`s${si}`}
                          data-testid="change-row"
                          data-kind={s.kind}
                          data-target={s.target}
                          data-locate={s.locateText}
                          data-field="*"
                          data-old={isDelete ? '（整行）' : '（新增）'}
                          data-new={isDelete ? '（删除整行）' : '（数据库默认值）'}
                        >
                          <td style={tdStyle}>{s.target}</td>
                          <td style={tdStyle}>{s.locateText}</td>
                          <td style={tdStyle}>{isDelete ? '（整行）' : '（未指定列）'}</td>
                          <td style={tdStyle}>{isDelete ? '删除该行' : '全部由数据库默认值填充'}</td>
                        </tr>,
                      ];
                    }
                    return s.changes.map((c, ci) => (
                      <tr
                        key={`s${si}-${ci}`}
                        data-testid="change-row"
                        data-kind={s.kind}
                        data-target={s.target}
                        data-locate={s.locateText}
                        data-field={c.column}
                        data-old={c.oldText}
                        data-new={c.newText}
                      >
                        <td style={tdStyle}>{s.target}</td>
                        <td style={tdStyle}>{s.locateText}</td>
                        <td style={tdStyle}>
                          {c.column}
                          {c.valueKind === 'sql-expr' ? (
                            <span title="SQL 表达式，原样嵌入执行" style={{ marginLeft: 4, color: 'var(--accent)' }}>
                              fx
                            </span>
                          ) : null}
                        </td>
                        <td style={tdStyle}>
                          <span>{c.oldText}</span> → <span>{c.newText}</span>
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {statements.length === 0 ? (
            <p>没有需要提交的改动。</p>
          ) : (
            <>
              {shown.map((s, i) => {
                // T06/R07：占位符数应与绑定参数一致（含 SQL 表达式的语句除外 ——
                // 表达式值是原样嵌进文本的，本来就不走参数绑定）。
                const mismatch = !s.hasSqlExpr && countPlaceholders(s.sql) !== s.params.length;
                return (
                  <div
                    key={i}
                    className={s.hasSqlExpr ? 'preview-sql has-expr' : 'preview-sql'}
                    data-testid="preview-sql"
                    data-params-mismatch={mismatch ? '1' : undefined}
                  >
                    {s.hasSqlExpr ? (
                      <span className="preview-expr-tag" title="含 SQL 表达式，原样嵌入执行">fx</span>
                    ) : null}
                    <pre>{s.description ? `-- ${s.description}\n` : ''}{fillParams(s.sql, s.params)};</pre>
                    {mismatch ? (
                      <div className="banner warn" data-testid="params-mismatch">
                        占位符数量（{countPlaceholders(s.sql)}）与绑定参数（{s.params.length}）不一致 —— 请勿提交，先反馈此问题。
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
