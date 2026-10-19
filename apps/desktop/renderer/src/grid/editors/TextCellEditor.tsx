/**
 * 通用值编辑器（ENUM / 日期时间之外的所有类型）。
 *
 * 用 `<textarea>` 而不是 `<input>`：文本/JSON/长注释常常是多行，
 * 单行输入框会把换行吃掉，也会让"清空后确认为空串"变得不可见。
 *
 * 🔴 这一格是**纯文本通道**：输入什么就写什么，绝不把内容解释成 SQL
 *    （写 SQL 表达式要显式开 fx 模式，见 V10）。
 */

export interface TextCellEditorProps {
  value: string | null;
  onChange: (value: string | null) => void;
  autoFocus?: boolean;
  /** 附加说明（如本格已有待提交改动） */
  hint?: string | null;
}

export function TextCellEditor({ value, onChange, autoFocus = false, hint = null }: TextCellEditorProps) {
  return (
    <div className="ce-text" data-testid="ce-text">
      <textarea
        className="ce-textarea"
        data-testid="ce-textarea"
        autoFocus={autoFocus}
        rows={6}
        spellCheck={false}
        value={value ?? ''}
        placeholder="输入新值；清空后点「设为空串」"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <div className="ce-hint" role="status" data-testid="ce-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
