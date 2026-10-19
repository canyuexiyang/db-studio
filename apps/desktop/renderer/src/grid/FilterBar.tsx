/**
 * 已生效筛选条件条（T26）+ 列头快筛浮层（T24）
 *
 * ## 真值
 *
 * 条件条上显示的每一条，**只从 `tab.filter` 派生**（`applied`）。草稿（`draft`）
 * 只用于标注差异，不参与「已生效」的判定 —— 否则「打开筛选器改了值、点取消」
 * 之后，条上会留着一个从未生效的条件。
 *
 * ## 三条刻意的设计
 *
 *  1. **删除 = 改模型重查，不是删徽标**：✕ 走 `onRemoveCondition(id)`，
 *     由宿主算出新模型并重新查询；SQL 少一条是被 `buildWhere` 验证过的
 *     （见 filterBarModel.test.ts「删掉一条后 buildWhere 少一个条件」）。
 *  2. **草稿与已生效分开显示**：同一条被草稿改了值 → 同时显示「已生效值」与
 *     「草稿值」，不让两者混成一个看起来已生效的徽标。
 *  3. **查询失败了不会假装一致**：失败时宿主把乐观写入的 `tab.filter` 退回上一个
 *     模型（不是贴一个「失败」标签了事），条件条读到的真值随之回退 ——
 *     所以「新徽标 + 旧数据」这个形态根本不会出现。重查在途一律标 pending。
 *
 * ## 列头快筛（T24）
 *
 * 浮层由 `quick` 控制（列头菜单经 HeaderFilterContext 把列名送进来 → TablePane
 * 置状态 → 这里渲染）。它**复用既有筛选链路**：产出的仍是 `FilterModel`，
 * 由宿主走 loadTable 重查 —— 是服务端筛选，不是本地查找。
 */

import { useMemo, useState, type KeyboardEvent } from 'react';
import { OPERATOR_LABELS, needsValue, type FilterModel, type FilterOperator } from '@dbstudio/core-filter';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import { IconFilter, IconPlus, IconX } from '../ui/icons';
import { isImeComposing } from '../ui/imeGuard';
import type { ColumnFilterMode } from './headerFilterBridge';
import {
  QUICK_IN_LIMIT,
  appendFilterGroups,
  buildInGroups,
  columnFilterCapability,
  describeInPlan,
  planBarStatus,
  planFilterChips,
  planInValues,
  resolveSingleValue,
  splitInInput,
  type FilterChip,
} from './filterBarModel';

export interface FilterBarProps {
  /** 🔴 真值：tab.filter */
  applied: FilterModel | null;
  /** 筛选弹窗里的草稿（弹窗没开时为 null） */
  draft?: FilterModel | null;
  /** 本 tab 正在重查（条件已写入真值，数据还没回来） */
  loading?: boolean;
  /** 已生效 WHERE 的用户可见原文（由调用方用 openTableSqlPreview 算好） */
  previewLabel: string;
  /** 表列元数据（快筛浮层要按列类型给操作符） */
  columns: readonly ColumnMeta[];
  /** 删除一条条件 → 宿主改模型并重查 */
  onRemoveCondition: (condId: string) => void;
  /** 清空全部条件 → 宿主改模型并重查 */
  onClearAll: () => void;
  /** 快筛浮层的应用：把追加后的完整模型交给宿主（追加 AND、去重/NULL/上限规则都在 model 里） */
  onApplyModel: (next: FilterModel, note: string) => void;
  /** 「在完整筛选器里继续」：预选该列打开既有筛选构建器。没接 → 该按钮禁用并说明 */
  onOpenBuilder?: ((column: string) => void) | null;
  /** 快筛浮层的受控开关（列头菜单传入列名 + 模式）；null = 关闭 */
  quick?: { column: string; mode: ColumnFilterMode } | null;
  /** 关闭快筛浮层 */
  onCloseQuick?: () => void;
}

/** 徽标的状态标签（e2e 按 data-state 断言，别改字面量） */
function chipState(c: FilterChip): string {
  if (c.draft) return `draft-${c.draft.kind}`;
  if (c.incomplete) return 'incomplete';
  if (c.pending) return 'pending';
  return 'applied';
}

export function FilterBar({
  applied,
  draft = null,
  loading = false,
  previewLabel,
  columns,
  onRemoveCondition,
  onClearAll,
  onApplyModel,
  onOpenBuilder,
  quick = null,
  onCloseQuick,
}: FilterBarProps) {
  const chips = useMemo(() => planFilterChips({ applied, draft, loading }), [applied, draft, loading]);
  const status = useMemo(() => planBarStatus({ applied, draft, loading }), [applied, draft, loading]);

  return (
    <div className="filter-bar" data-testid="fb-bar" data-tone={status.tone}>
      <span className="fbbar-icon" title="已生效的筛选条件（服务端筛选）" aria-hidden="true">
        <IconFilter size={11} />
      </span>

      <span className="fbbar-status" data-testid="fb-bar-status" data-tone={status.tone}>
        {status.label}
      </span>

      {chips.map((c) => (
        <span
          key={c.id}
          className="fbbar-chip"
          data-testid="fb-bar-chip"
          data-cond-id={c.id}
          data-state={chipState(c)}
        >
          {c.isList ? (
            <span className="fbbar-tag" title="多值 IN 条件">
              IN
            </span>
          ) : null}
          {c.incomplete ? (
            <span className="fbbar-chip-text incomplete" data-testid="fb-bar-chip-text" title="这条还没填完，不会进入 WHERE">
              未填完
            </span>
          ) : (
            <span className="fbbar-chip-text" data-testid="fb-bar-chip-text">
              {c.text ?? '—'}
            </span>
          )}
          {/* T26：草稿改了值 → 必须把「草稿值」和「已生效值」分开显示 */}
          {c.draft ? (
            <span
              className="fbbar-chip-draft"
              data-testid="fb-bar-chip-draft"
              data-kind={c.draft.kind}
              title={
                c.draft.kind === 'changed'
                  ? '筛选器里改了值，尚未应用'
                  : c.draft.kind === 'new'
                    ? '只在筛选器草稿里，尚未应用'
                    : '筛选器草稿里已删除，尚未应用'
              }
            >
              {c.draft.kind === 'changed' ? `草稿：${c.draft.text ?? '未填完'}` : c.draft.kind === 'new' ? `草稿新增：${c.draft.text ?? '未填完'}` : '草稿中已移除'}
            </span>
          ) : null}
          <button
            type="button"
            className="fbbar-del"
            data-testid="fb-bar-chip-del"
            title="删除这条条件并立即重新查询（服务端重查，不是只藏起徽标）"
            aria-label={`删除条件 ${c.id}`}
            onClick={() => onRemoveCondition(c.id)}
          >
            <IconX size={10} />
          </button>
        </span>
      ))}

      {/* 既有结构保留：scripts/e2e-ui.mjs 断言 .filter-bar .preview 的文案 */}
      <span className="preview" data-testid="fb-bar-preview" title={previewLabel}>
        {previewLabel}
      </span>

      <button
        type="button"
        data-testid="fb-bar-clear"
        disabled={status.total === 0}
        title={status.total === 0 ? '当前没有条件可清空' : '清空全部条件并立即重新查询'}
        onClick={onClearAll}
      >
        清空
      </button>

      {quick ? (
        <QuickFilter
          // 🔴 快筛是「在已生效条件上再加一条」（AND），所以必须拿到真值模型
          base={applied}
          columns={columns}
          initialColumn={quick.column}
          initialMode={quick.mode}
          onClose={() => onCloseQuick?.()}
          onApplyModel={onApplyModel}
          onOpenBuilder={onOpenBuilder}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 列头快筛浮层

function QuickFilter(props: {
  /** 要往哪份模型上追加（真值 tab.filter；null = 当前没有筛选） */
  base: FilterModel | null;
  columns: readonly ColumnMeta[];
  initialColumn: string;
  initialMode: ColumnFilterMode;
  onClose: () => void;
  onApplyModel: (next: FilterModel, note: string) => void;
  onOpenBuilder?: ((column: string) => void) | null;
}) {
  const { base, columns, initialColumn, initialMode, onClose, onApplyModel, onOpenBuilder } = props;

  const [column, setColumn] = useState(initialColumn);
  const [mode, setMode] = useState<ColumnFilterMode>(initialMode);
  const [operator, setOperator] = useState<FilterOperator>('eq');
  const [value, setValue] = useState('');
  const [valuesText, setValuesText] = useState('');
  const [negate, setNegate] = useState(false);

  const col = columns.find((c) => c.name === column);
  const cap = columnFilterCapability(col);
  // 列不支持 IN 时强制退回单值（保持与列头菜单的禁用态一致，不让浮层和菜单打架）
  const inMode = mode === 'in' && cap.canIn;
  const operators = cap.operators.length > 0 ? cap.operators : (['eq'] as FilterOperator[]);
  const effectiveOp = operators.includes(operator) ? operator : operators[0];

  const single = resolveSingleValue(effectiveOp, value);
  const plan = planInValues(splitInInput(valuesText), QUICK_IN_LIMIT);

  /** 当前输入能不能应用（不能应用时按钮禁用并说明，绝不静默什么都不做） */
  const gate: { ok: boolean; reason: string } = !column
    ? { ok: false, reason: '请先选择一列' }
    : inMode
      ? plan.ok
        ? { ok: true, reason: '' }
        : { ok: false, reason: plan.reason || '请输入至少一个值（逗号或换行分隔）' }
      : needsValue(effectiveOp)
        ? single.ok
          ? value.trim() === ''
            ? { ok: false, reason: "请输入值；查 NULL 写 NULL，查空串写 ''" }
            : { ok: true, reason: '' }
          : { ok: false, reason: single.reason }
        : { ok: true, reason: '' };

  function apply(): void {
    if (!gate.ok) return;
    if (inMode) {
      const r = buildInGroups(column, plan, negate);
      if (!r.ok) return;
      onApplyModel(appendFilterGroups(base, r.groups), describeInPlan(plan));
      return;
    }
    const next = appendFilterGroups(base, [
      {
        conditions: [
          {
            column,
            operator: single.operator,
            value: single.value === null ? undefined : single.value,
          },
        ],
      },
    ]);
    onApplyModel(next, `${column} ${OPERATOR_LABELS[single.operator]}`);
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // T13：输入法组合期的 Enter/Esc 属于候选词操作，不截获
    if (isImeComposing(e)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    // ⌘/Ctrl+Enter 应用（textarea 里的 Enter 要能换行）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div className="fbbar-pop" data-testid="fb-qf" role="dialog" aria-label="按列筛选" onKeyDown={onKeyDown}>
      <div className="fbbar-pop-head">
        <span>按列筛选</span>
        <span className="spacer" />
        <button type="button" data-testid="fb-qf-cancel" title="放弃（Esc）" onClick={onClose}>
          取消
        </button>
      </div>

      <div className="fbbar-pop-row">
        <select
          className="fbbar-select"
          data-testid="fb-qf-col"
          value={column}
          title="选择要筛选的列"
          onChange={(e) => setColumn(e.target.value)}
        >
          <option value="">（选择列）</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.comment ? `${c.name} — ${c.comment}` : `${c.name}（${c.dataType}）`}
            </option>
          ))}
        </select>

        <span className="fbbar-modes" role="group" aria-label="匹配方式">
          <button
            type="button"
            data-testid="fb-qf-mode-single"
            className={inMode ? '' : 'on'}
            aria-pressed={!inMode}
            onClick={() => setMode('single')}
          >
            单值
          </button>
          <button
            type="button"
            data-testid="fb-qf-mode-in"
            className={inMode ? 'on' : ''}
            aria-pressed={inMode}
            disabled={!cap.canIn}
            title={cap.canIn ? '一次匹配多个值，生成 IN 条件' : cap.inReason}
            onClick={() => setMode('in')}
          >
            多值 IN
          </button>
        </span>
      </div>

      {inMode ? (
        <>
          <textarea
            className="fbbar-textarea"
            data-testid="fb-qf-values"
            value={valuesText}
            rows={3}
            placeholder={'粘贴多个值，逗号或换行分隔\n写 NULL 表示真 NULL；写 \'\' 表示空串'}
            onChange={(e) => setValuesText(e.target.value)}
          />
          <label className="fbbar-check" title="排除这些值（NOT IN）">
            <input type="checkbox" data-testid="fb-qf-negate" checked={negate} onChange={(e) => setNegate(e.target.checked)} />
            排除这些值（NOT IN）
          </label>
          <div className="fbbar-summary" data-testid="fb-qf-summary">
            {describeInPlan(plan)}
          </div>
        </>
      ) : (
        <div className="fbbar-pop-row">
          <select
            className="fbbar-select"
            data-testid="fb-qf-op"
            value={effectiveOp}
            title="比较方式（可选项由列类型决定：数值列没有「包含」）"
            onChange={(e) => setOperator(e.target.value as FilterOperator)}
          >
            {operators.map((o) => (
              <option key={o} value={o}>
                {OPERATOR_LABELS[o]}
              </option>
            ))}
          </select>
          <input
            className="fbbar-input"
            data-testid="fb-qf-value"
            value={value}
            disabled={!needsValue(effectiveOp)}
            placeholder={needsValue(effectiveOp) ? "值：写 NULL 筛 NULL，写 '' 筛空串" : '该条件不需要值'}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      )}

      {gate.reason ? (
        <div className="fbbar-reason" data-testid="fb-qf-reason">
          {gate.reason}
        </div>
      ) : null}

      <div className="fbbar-pop-foot">
        <button
          type="button"
          data-testid="fb-qf-builder"
          disabled={!onOpenBuilder || !column}
          title={
            onOpenBuilder && column
              ? '在完整筛选构建器里继续编辑（已预选这一列）'
              : onOpenBuilder
                ? '请先选择一列'
                : '宿主未接入筛选构建器'
          }
          onClick={() => {
            if (column) onOpenBuilder?.(column);
            onClose();
          }}
        >
          <IconPlus size={10} />
          在完整筛选器中编辑
        </button>
        <span className="spacer" />
        <button type="button" className="primary" data-testid="fb-qf-apply" disabled={!gate.ok} title={gate.ok ? '加入条件并立即重新查询' : gate.reason} onClick={apply}>
          应用
        </button>
      </div>
    </div>
  );
}
