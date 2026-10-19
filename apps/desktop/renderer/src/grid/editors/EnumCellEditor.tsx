/**
 * T36：ENUM 专用单元格编辑器。
 *
 * 与通用文本编辑器的本质差别：**取值集合是数据库定义的，不是用户随便敲的**。
 * 所以这里用 `<select>` 而不是 `<input>` —— 下拉里只有 DDL 里写死的那些值，
 * 从交互上就不可能写出不合法枚举（验收口径：不合法枚举不写入）。
 *
 * 🔴 两条不能违反的口径：
 *  1. **空串与 NULL 是两个选项**，不是一个「空」选项：
 *     - 空串 = 枚举的一个**定义成员**（`enum('','a')` 里的第一个），写入的是 `''`；
 *     - NULL = 这一列**不取值**，写入的是 SQL `NULL`；
 *     二者在 option value 上用不同前缀编码（`v:i` vs `x:null`），绝不混淆。
 *  2. **拿不到定义值就不画下拉**（红线 6）：`values` 为空时组件不渲染 `<select>`，
 *     改为显示原因 —— 一个只能瞎猜的下拉比没有下拉更危险。
 */

import { buildEnumOptions, enumOptionActual } from './valueEditorModel';

export interface EnumCellEditorProps {
  /** 数据库定义值（DDL 顺序）；空数组/null = 元数据不足 */
  values: readonly string[];
  /** 当前值（null = NULL；'' = 空串成员） */
  value: string | null;
  /** 是否可空；undefined = 未知（不拦，由数据库判定） */
  nullable?: boolean | null;
  /** 选中某个选项（含 NULL） */
  onChange: (value: string | null) => void;
  /** 是否自动聚焦 */
  autoFocus?: boolean;
}

export function EnumCellEditor({
  values,
  value,
  nullable,
  onChange,
  autoFocus = false,
}: EnumCellEditorProps) {
  const options = buildEnumOptions(values, nullable);
  if (options.length === 0) {
    return (
      <div className="ce-enum-missing" role="status" data-testid="ce-enum-missing">
        拿不到本列的 ENUM 定义值（schema 元数据不足），无法提供专用下拉；请改用文本编辑
      </div>
    );
  }

  /**
   * 当前值 → 选中的 option。
   *
   * 🔴 空串与 NULL 各自命中**不同**的选项：空串命中 `v:i`（那个定义成员就是 ''），
   *    NULL 命中 `x:null`。若当前值既不是定义成员也不是 NULL（数据比 schema 新的
   *    情况），不给选中项 —— 让浏览器停在空白，用户一动就显式选一个合法值，
   *    而不是默默把非法值当成合法值提交。
   */
  const selected = (() => {
    if (value === null) {
      const nullOption = options.find((o) => o.actual === null);
      // 列为 NOT NULL 时 NULL 选项被禁用 —— 此时不给选中项，避免"停在非法值上"
      return nullOption && nullOption.disabledReason === '' ? nullOption.value : '';
    }
    return options.find((o) => o.actual === value)?.value ?? '';
  })();

  return (
    <select
      className="ce-enum-select"
      data-testid="ce-enum-select"
      value={selected}
      autoFocus={autoFocus}
      onChange={(e) => {
        const hit = enumOptionActual(e.target.value, values);
        if (hit) onChange(hit.actual);
      }}
    >
      {selected === '' ? (
        <option value="" disabled>
          选择取值…
        </option>
      ) : null}
      {options.map((o) => (
        <option
          key={o.value}
          value={o.value}
          data-testid="ce-enum-option"
          disabled={o.disabledReason !== ''}
          title={o.disabledReason !== '' ? o.disabledReason : `写入 ${o.label}`}
        >
          {o.label}
        </option>
      ))}
    </select>
  );
}
