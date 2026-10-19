/**
 * T37：日期时间专用编辑器。
 *
 * 三条来自需求原文的约束，这段代码里逐条落地：
 *
 *  1. **日期控件只是辅助输入** —— 控件改的是文本的某一段，文本始终由调用方的
 *     `value` 持有，控件不拥有值（`onChange` 只回写片段）。
 *  2. **原始字符串仍可见** —— 原始值输入框永远渲染在最上面，且始终显示完整文本
 *     （含小数秒与时区后缀），不被控件替代。
 *  3. **微秒不能被吞 / 不隐式赋予本地时区** —— 全程**不构造 `Date`**：
 *     解析是把字符串切成片段（`parseDateTimeText`），回写是把片段拼回去
 *     （`withDatePart` / `withTimePart`）。小数秒与 `Z` / `+08:00` 属于
 *     "不参与控件的片段"，因此 Date 构造函数常见的"微秒四舍五入到毫秒 +
 *     按本地时区重排"在这里**物理上不可能发生**（往返恒等单测守着）。
 */

import { useMemo } from 'react';
import {
  dateInputValueOf,
  dateTimeFidelityNote,
  parseDateTimeText,
  timeInputValueOf,
  withDatePart,
  withTimePart,
  type ColumnTypeInfo,
} from './valueEditorModel';

/** 列类型 → 需要哪些原生控件 */
export interface DateTimeFieldSet {
  date: boolean;
  time: boolean;
}

export function dateTimeFieldsOf(info: ColumnTypeInfo): DateTimeFieldSet {
  switch (info.kind) {
    case 'date':
      return { date: true, time: false };
    case 'time':
      return { date: false, time: true };
    case 'datetime':
      return { date: true, time: true };
    default:
      return { date: false, time: false };
  }
}

export interface DateTimeCellEditorProps {
  /** 当前文本（null → 空串） */
  value: string | null;
  /** 列类型信息：决定只给日期控件、只给时间控件，还是两个都给 */
  info: ColumnTypeInfo;
  onChange: (value: string | null) => void;
  autoFocus?: boolean;
}

export function DateTimeCellEditor({ value, info, onChange, autoFocus = false }: DateTimeCellEditorProps) {
  const text = value ?? '';
  const parts = useMemo(() => parseDateTimeText(text), [text]);
  const fields = dateTimeFieldsOf(info);
  const note = dateTimeFidelityNote(parts);

  return (
    <div className="ce-dt" data-testid="ce-dt">
      {/*
        原始值：永远在最上面、永远显示**完整**文本（含小数秒与时区后缀）。
        🔴 它同时是**可编辑的输入框**（不只是只读展示）—— 控件表达不了的值
        （带时区后缀、MySQL 零值、非法格式）只能靠这一格改，否则用户会被卡死。
      */}
      <label className="ce-dt-row">
        <span className="ce-dt-label">原始值</span>
        <input
          className="ce-dt-text"
          data-testid="ce-dt-text"
          type="text"
          autoFocus={autoFocus}
          spellCheck={false}
          value={text}
          placeholder="例如 2024-01-02 03:04:05.123456"
          onChange={(e) => onChange(e.target.value)}
        />
      </label>

      {/* 辅助控件：只改文本里对应的那一段，其余片段（含微秒/时区）原样保留 */}
      {fields.date ? (
        <label className="ce-dt-row">
          <span className="ce-dt-label">日期</span>
          <input
            className="ce-dt-date"
            data-testid="ce-dt-date"
            type="date"
            value={dateInputValueOf(parts)}
            disabled={!parts.parsed || parts.dateText === null}
            title={
              parts.parsed
                ? '只改写文本的日期段，时间与小数秒保持原样'
                : '当前文本无法用日期控件表达，请直接改原始值'
            }
            onChange={(e) => {
              if (e.target.value === '') return; // 清空不落值（避免把整段抹掉）
              onChange(withDatePart(text, e.target.value));
            }}
          />
        </label>
      ) : null}

      {fields.time ? (
        <label className="ce-dt-row">
          <span className="ce-dt-label">时间</span>
          <input
            className="ce-dt-time"
            data-testid="ce-dt-time"
            type="time"
            step="1"
            value={timeInputValueOf(parts)}
            disabled={!parts.parsed || parts.timeText === null}
            title={
              parts.parsed
                ? '只改写文本的时间段（秒级），小数秒保持原样'
                : '当前文本无法用时间控件表达，请直接改原始值'
            }
            onChange={(e) => {
              if (e.target.value === '') return;
              onChange(withTimePart(text, e.target.value));
            }}
          />
        </label>
      ) : null}

      {note ? (
        <div className="ce-dt-note" role="status" data-testid="ce-dt-note">
          {note}
        </div>
      ) : null}
    </div>
  );
}
