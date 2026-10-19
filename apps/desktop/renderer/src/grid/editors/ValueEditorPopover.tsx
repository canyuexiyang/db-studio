/**
 * T25/T36/T37：单元格「编辑值…」浮层。
 *
 * 为什么是浮层而不是只在格内输入：
 *  - 长文本需要**换行编辑**（格内单行输入框会把换行吃掉）；
 *  - ENUM / 日期时间需要**原生控件**（`<select>` / `<input type=date|time>`），
 *    塞进 24px 高的单元格里既挤又会被 `overflow:hidden` 裁掉；
 *  - 浮层让「清空 → 确认为空串」这条路径**可见**：格内清空后失焦容易被当成
 *    "编辑取消"，而浮层里有显式的「设为空串」按钮（正是本次要补的入口）。
 *
 * 🔴 红线 1（不许做假 UI）：所有按钮要么有真实回调，要么 `disabled` + 中文原因。
 *
 * 交互：⌘/⌃+Enter 提交（Enter 留给换行），Esc / 点外面 / 关闭按钮 = 取消。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconFn, IconX } from '../../ui/icons';
import { isImeComposing } from '../../ui/imeGuard';
import { EnumCellEditor } from './EnumCellEditor';
import { DateTimeCellEditor } from './DateTimeCellEditor';
import { TextCellEditor } from './TextCellEditor';
import {
  DEFAULT_KEYWORD,
  validateEnumValue,
  type ColumnTypeInfo,
  type GridValueKind,
  type MenuItemState,
} from './valueEditorModel';

/** 浮层宽度（与 .gd-fk-picker 同族） */
const POPOVER_WIDTH = 320;

export interface ValueEditorPopoverProps {
  /** 列名（用于标题） */
  column: string;
  /** MySQL 类型原文（用于标题与禁用原因） */
  dataType: string;
  /** 类型信息（决定用哪个编辑器） */
  info: ColumnTypeInfo;
  /** 初始值：脏优先的展示值（null = NULL） */
  initialValue: string | null;
  /** 行号 ≥ 已加载行数 = 待 INSERT 的新行（决定「使用默认值」的语义） */
  isInsertRow: boolean;
  /** 「设为空串」可用性 + 原因 */
  emptyState: MenuItemState;
  /** 「设为 NULL」可用性（宿主的 canSetNull） */
  canSetNull: boolean;
  /** 「使用默认值」可用性 + 原因 */
  useDefaultState: MenuItemState;
  /** 「使用默认值」的语境说明（INSERT 省略列 vs UPDATE DEFAULT） */
  useDefaultHint: string;
  /** 库中原值（提示用，不参与提交） */
  originalValue: unknown;
  /** 提交一个值 */
  onCommit: (value: string | null, valueKind: GridValueKind) => void;
  /** 清除本格待提交改动（INSERT 语境的「使用默认值」走这条路） */
  onDiscard: () => void;
  /** 关闭（不落值） */
  onClose: () => void;
  /** 锚点（视口坐标，来自右键事件） */
  anchor: { x: number; y: number };
}

/** 浮层左边界上限：贴右边缘时不越出视口 */
function popoverLeftBound(): number {
  const w = typeof window === 'undefined' ? 1280 : window.innerWidth;
  return Math.max(4, w - POPOVER_WIDTH - 8);
}

export function ValueEditorPopover({
  column,
  dataType,
  info,
  initialValue,
  isInsertRow,
  emptyState,
  canSetNull,
  useDefaultState,
  useDefaultHint,
  originalValue,
  onCommit,
  onDiscard,
  onClose,
  anchor,
}: ValueEditorPopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState<string | null>(initialValue);

  // 目标格变化时重置（浮层实例会被复用在不同格子上）
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  /**
   * T36：ENUM 列提交前的**取值校验**。
   *
   * EnumCellEditor 的 `<select>` 让正常交互选不出非法值，但两条路径仍可能
   * 把非法值带到「好」按钮：① 打开浮层时本格数据就比 schema 新（历史遗留值）；
   * ② `TextCellEditor` 分支没有出现枚举时（定义值缺失退回文本编辑）。
   * 这两条若直接提交，非法枚举就会落进脏格 —— 与「不合法枚举不写入」的验收冲突。
   * 校验用 valueEditorModel 的 `validateEnumValue`（唯一口径），null 不在这里拦：
   * 「设为 NULL」是独立按钮的显式动作，语义本来就是写 NULL。
   */
  const enumError = useMemo(() => {
    if (info.kind !== 'enum') return '';
    if (value === null) return '';
    const r = validateEnumValue(info.enumValues, value);
    return r.ok ? '' : r.reason;
  }, [info, value]);

  /**
   * 提交当前工作值。
   *
   * 🔴 `null` 原样提交 = 写入 SQL NULL；`''` 原样提交 = 写入空串。
   *    两者在这里**不合并**，正是 T25 要修的缺陷。
   * ENUM 非法值在校验层拦（enumError 非空 → 按钮已禁用），这里是第二道防线。
   */
  const commitText = () => {
    if (enumError) return;
    onCommit(value, 'literal');
  };
  const commitEmpty = () => onCommit('', 'literal');
  const commitNull = () => onCommit(null, 'literal');

  /**
   * T25：「使用默认值」的两条路（与 resolveValueEdit 同一口径）。
   *  - INSERT（新行）：去掉待提交值 → 该列不出现在 INSERT 列表 → 数据库填 DEFAULT；
   *  - UPDATE（已有行）：原样嵌入 `DEFAULT` 关键字。
   */
  const useDefault = () => {
    if (isInsertRow) onDiscard();
    else onCommit(DEFAULT_KEYWORD, 'sql-expr');
  };

  // 点外关闭（放行浮层内部 —— 否则点输入框也会把浮层关掉）
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const isEnum = info.kind === 'enum';
  const isDateTime = info.kind === 'datetime' || info.kind === 'date' || info.kind === 'time';

  return (
    <div
      className="ce-popover"
      ref={rootRef}
      data-testid="ce-value-editor"
      role="dialog"
      aria-label={`编辑 ${column} 的值`}
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(anchor.x, popoverLeftBound())),
        top: Math.max(4, anchor.y),
        width: POPOVER_WIDTH,
        zIndex: 63,
      }}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Escape') {
          onClose();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          commitText();
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div className="ce-pop-head">
        <span className="ce-pop-title" title={`${column} · ${dataType}`}>
          编辑值 · {column}
        </span>
        <span className="ce-pop-type" data-testid="ce-value-editor-type">
          {dataType || '未知类型'}
        </span>
        <span className="gd-tool-spacer" />
        <button type="button" className="gd-tool-btn" title="关闭（Esc，不落值）" onClick={onClose}>
          <IconX size={11} />
        </button>
      </div>

      {/*
        三种编辑器按**列类型**挑一个（T36 / T37 / 通用）。
        🔴 拿不到 ENUM 定义值时 EnumCellEditor 自己会显示原因，
           而不是给一个只能瞎猜的下拉（红线 6）。
      */}
      {isEnum ? (
        <EnumCellEditor values={info.enumValues ?? []} value={value} onChange={setValue} />
      ) : isDateTime ? (
        <DateTimeCellEditor value={value} info={info} onChange={setValue} />
      ) : (
        <TextCellEditor value={value} onChange={setValue} />
      )}

      {/*
        T25：三个显式取值入口与「设为 NULL」并列 —— 空串 ≠ NULL ≠ DEFAULT。
        `disabled` + `title`（原因）全部来自纯逻辑层 menuStateOf，组件不另判一遍。
      */}
      <div className="ce-pop-foot">
        <button
          type="button"
          className="ce-pop-btn"
          data-testid="ce-btn-empty"
          disabled={!emptyState.enabled}
          title={emptyState.enabled ? "写入空串 ''（不是 NULL）" : emptyState.reason}
          onClick={commitEmpty}
        >
          设为空串
        </button>
        <button
          type="button"
          className="ce-pop-btn"
          data-testid="ce-btn-null"
          disabled={!canSetNull}
          title={canSetNull ? '写入 SQL NULL（不是空串）' : '不可编辑，或本格原始值已是 NULL'}
          onClick={commitNull}
        >
          设为 NULL
        </button>
        <button
          type="button"
          className="ce-pop-btn"
          data-testid="ce-btn-default"
          disabled={!useDefaultState.enabled}
          title={useDefaultState.enabled ? useDefaultHint : useDefaultState.reason}
          onClick={useDefault}
        >
          <IconFn size={10} />
          使用默认值
        </button>
        <span className="gd-tool-spacer" />
        <button type="button" className="ce-pop-btn" data-testid="ce-value-editor-cancel" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="ce-pop-btn primary"
          data-testid="ce-value-editor-ok"
          disabled={!!enumError}
          title={enumError || '提交当前值'}
          onClick={commitText}
        >
          好
        </button>
      </div>

      {/* 原值提示：本格已有待提交改动时明说，避免"我改的是哪个版本"的困惑 */}
      <div className="ce-pop-original" role="status" data-testid="ce-value-editor-original">
        库中原值：
        {originalValue === null || originalValue === undefined ? 'NULL' : String(originalValue)}
      </div>

      {/* T36：ENUM 非法值 → 提交被拦下，原因摆出来（不合法枚举不写入） */}
      {enumError ? (
        <div className="ce-pop-error" role="alert" data-testid="ce-value-editor-error">
          {enumError}
        </div>
      ) : null}
    </div>
  );
}
