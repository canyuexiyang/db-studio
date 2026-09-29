/**
 * 筛选构建器 UI（§6.3.3，2026-09-29 缺陷 4 界面改版）
 *
 * 逻辑全在 `core-filter`，这里只做界面。三条红线（改之前先看）：
 *
 *  1. **数值列没有「包含」操作符** —— 由 `operatorsForColumn()` 决定，
 *     UI 不许自己塞选项。真机验证过：给数值列 LIKE 会静默返回空结果。
 *  2. **WHERE 必须参数化** —— 值永远不进 SQL 文本。`buildWhere()` 已经保证，
 *     这里只负责把值收进条件模型，一句 SQL 都不自己拼。
 *  3. **参数顺序是 `[...whereParams, ...limitParams]`** —— 这条在调用方
 *     （App 的 loadTable），顺序反了报的错完全指向别处。
 *
 * ---- 缺陷 4 改版：界面重排（用户反馈「点击的地方过多、布局很乱、按钮很丑」）----
 *
 * 对标 Navicat 筛选面板与 DataGrip 条件行，三处结构性改动：
 *
 *  ① **严格网格对齐**（治「布局很乱」）：条件行改用 CSS Grid 固定列轨
 *     `[逻辑 58][字段 1fr][条件 106][值 1.5fr][删除 24]`，所有行的控件纵向对齐成一条线。
 *     旧版是 `flex + flex-wrap` —— 值框宽度随内容浮动，第二条起就错位，
 *     条件一多视觉上散成一片（用户截图里正是这个形态）。
 *
 *  ② **AND/OR 改成点击即切的 chip**（治「点击过多」）：旧版是 `<select>`，
 *     切一次逻辑要「点开下拉 → 找选项 → 点它」三步；chip 一步，且当前态一眼可见。
 *     组内逻辑同理，从「全部满足/任一满足」下拉改成两段开关。
 *
 *  ③ **按钮统一到 Apple 原生精修语言**（治「按钮很丑」）：去掉浏览器默认按钮外观，
 *     改用项目既有的 12px + 灰底 hover 浮起 + focus ring（与 .toolbar button /
 *     .gd-tool-btn 同族）。删除按钮平时是淡灰 ✕、hover 行时加深 —— 降噪但可发现。
 *
 * 顺带的可用性改进：
 *  · 每个条件组底部都有「添加条件」，不用滚回顶部找入口；
 *  · 新增条件后自动聚焦它的字段下拉（省一次点击）；
 *  · 空组给一句引导 + 按钮，而不是一个孤零零的「+ 条件」；
 *  · 字段下拉把 comment 一起列出（选字段时能看懂它是干什么的）；
 *  · WHERE 预览独立成块并标明「N 条有效 / M 条未填完已跳过」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OPERATOR_LABELS,
  operatorsForColumn,
  needsValue,
  isRangeOperator,
  isListOperator,
  isConditionComplete,
  suggestMultiSelect,
  enumOptions,
  parseListInput,
  buildWhere,
  nextId,
  emptyFilter,
  conditionCount,
  effectiveConditionCount,
  type FilterModel,
  type FilterCondition,
  type FilterOperator,
  type LogicOp,
} from '@dbstudio/core-filter';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import {
  createSavedFilterStore,
  deleteFilter,
  listSavedFilters,
  renameFilter,
  saveFilter,
  savedFilterKey,
  searchSavedFilters,
  type SavedFilter,
} from './savedFilters';
import { IconPlus, IconX, IconTrash } from '../ui/icons';

export interface FilterBuilderProps {
  model: FilterModel;
  onChange: (next: FilterModel) => void;
  columns: ColumnMeta[];
  /**
   * V18：方案按 **表** 持久化（`connId::database::table`）。
   * 三个都给了才显示「已保存的方案」块 —— 缺省时静默不显示，而不是存到一张
   * 不知道属于谁的表下（那样下次打开就是一堆来历不明的方案）。
   */
  connId?: string;
  database?: string;
  table?: string;
  /**
   * V18：保存/重命名失败要把中文原因吐出来（重名、超上限、空条件）。
   * 缺省 = 只在组件内部静默 —— 弹窗场景不会用到，单测/复用场景才这么跑。
   */
  onToast?: (msg: string) => void;
}

/**
 * AND/OR 分段 chip（缺陷 4 的核心交互简化）。
 *
 * 为什么不用 `<select>`：切换逻辑是筛选里最高频的微操作之一，select 要点开再选
 * （3 次交互），chip 一次点击即可，且「当前是 AND 还是 OR」始终可见 —— 旧版的
 * select 收起后只剩一个小框，条件一多根本分不清哪条是 OR。
 *
 * 无障碍：role="group" + aria-pressed，Tab 可达、Enter/Space 可触发（button 原生行为）。
 */
function LogicChips({
  value,
  onChange,
  titlePrefix,
}: {
  value: LogicOp;
  onChange: (v: LogicOp) => void;
  titlePrefix: string;
}) {
  return (
    <span className="fb-logic" role="group" aria-label={titlePrefix}>
      <button
        type="button"
        className={value === 'AND' ? 'on' : ''}
        aria-pressed={value === 'AND'}
        title={`${titlePrefix}：AND（两个条件都要满足）`}
        onClick={() => onChange('AND')}
      >
        AND
      </button>
      <button
        type="button"
        className={value === 'OR' ? 'on' : ''}
        aria-pressed={value === 'OR'}
        title={`${titlePrefix}：OR（满足任一条件即可）`}
        onClick={() => onChange('OR')}
      >
        OR
      </button>
    </span>
  );
}

export function FilterBuilder({ model, onChange, columns, connId, database, table, onToast }: FilterBuilderProps) {
  const preview = useMemo(() => buildWhere(model), [model]);
  /**
   * 🔴 两个计数刻意不同源：
   *  - `effective` = **会真进 WHERE** 的条件数（`effectiveConditionCount`，与 buildWhere 同判据）
   *  - `total`     = 界面上的条件行总数（含还没填完的）
   * 上一版这里两个都数全部行，于是 `total > effective` 恒 false，
   * 「N 条未填完已跳过」这句提示**从来没显示过** —— 而我把它写进了需求文档当作已交付能力。
   * 计数口径必须与 buildWhere 一致，否则预览说的和实际筛的不是一回事。
   */
  const effective = effectiveConditionCount(model);
  const total = conditionCount(model);

  /**
   * 新增条件后把焦点送到它的字段下拉（缺陷 4「点击过多」的直接对策）。
   * 用条件 id 标记目标行，渲染完成后由 effect 查 DOM 聚焦 ——
   * setState 之后立刻查会拿到旧 DOM（新节点还没挂载）。
   */
  const [focusColOf, setFocusColOf] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focusColOf) return;
    const el = rootRef.current?.querySelector<HTMLSelectElement>(
      `[data-cond-id="${focusColOf}"] select.fb-col`,
    );
    el?.focus();
    setFocusColOf(null);
  }, [focusColOf]);

  const patchCondition = useCallback(
    (groupId: string, condId: string, patch: Partial<FilterCondition>) => {
      onChange({
        groups: model.groups.map((g) =>
          g.id !== groupId
            ? g
            : {
                ...g,
                conditions: g.conditions.map((c) => {
                  if (c.id !== condId) return c;
                  const next = { ...c, ...patch };
                  // 换列时操作符可能不再合法（数值列 → 文本列）→ 回落到"等于"
                  if (patch.column !== undefined) {
                    const col = columns.find((x) => x.name === patch.column);
                    if (col && !operatorsForColumn(col).includes(next.operator)) {
                      next.operator = 'eq';
                    }
                  }
                  return next;
                }),
              },
        ),
      });
    },
    [model, onChange, columns],
  );

  /** 全部已存在的条件 id（跨组）—— nextId 必须全局唯一，否则 React key 会撞 */
  const allCondIds = useMemo(() => model.groups.flatMap((g) => g.conditions.map((c) => c.id)), [model]);

  const addCondition = useCallback(
    (groupId: string) => {
      const id = nextId('c', allCondIds);
      onChange({
        groups: model.groups.map((g) =>
          g.id !== groupId
            ? g
            : {
                ...g,
                conditions: [
                  ...g.conditions,
                  {
                    id,
                    // 默认取第一列（与旧版一致）；焦点落到字段下拉让用户直接改
                    column: columns[0]?.name ?? '',
                    operator: 'eq' as FilterOperator,
                    value: '',
                  },
                ],
              },
        ),
      });
      setFocusColOf(id);
    },
    [model, onChange, columns, allCondIds],
  );

  const removeCondition = useCallback(
    (groupId: string, condId: string) => {
      onChange({
        groups: model.groups.map((g) =>
          g.id !== groupId ? g : { ...g, conditions: g.conditions.filter((c) => c.id !== condId) },
        ),
      });
    },
    [model, onChange],
  );

  const addGroup = useCallback(() => {
    const id = nextId('c', allCondIds);
    onChange({
      groups: [
        ...model.groups,
        {
          id: nextId('g', model.groups.map((g) => g.id)),
          logic: 'AND' as LogicOp,
          join: 'AND' as LogicOp,
          conditions: [
            {
              id,
              column: columns[0]?.name ?? '',
              operator: 'eq' as FilterOperator,
              value: '',
            },
          ],
        },
      ],
    });
    setFocusColOf(id);
  }, [model, onChange, columns, allCondIds]);

  const reset = useCallback(() => onChange(emptyFilter()), [onChange]);

  return (
    <div className="filter-builder" ref={rootRef}>
      {model.groups.map((g, gi) => (
        <div className="filter-group" key={g.id}>
          {gi > 0 ? (
            <div className="fb-group-join">
              <LogicChips
                value={g.join ?? 'AND'}
                titlePrefix="与上一组的连接方式"
                onChange={(v) =>
                  onChange({
                    groups: model.groups.map((x) => (x.id === g.id ? { ...x, join: v } : x)),
                  })
                }
              />
              <span className="fb-group-index">条件组 {gi + 1}</span>
            </div>
          ) : model.groups.length > 1 ? (
            <div className="fb-group-join">
              <span className="fb-group-index">条件组 1</span>
            </div>
          ) : null}

          {/* 组内逻辑：只在有多于一条条件时才需要（单条时 AND/OR 无意义，藏起来降噪） */}
          {g.conditions.length > 1 ? (
            <div className="fb-group-head">
              <span className="fb-group-label">组内条件的连接方式</span>
              <LogicChips
                value={g.logic}
                titlePrefix="组内条件"
                onChange={(v) =>
                  onChange({
                    groups: model.groups.map((x) => (x.id === g.id ? { ...x, logic: v } : x)),
                  })
                }
              />
            </div>
          ) : null}

          {g.conditions.length > 0 ? (
            <>
              {/* 列头：让用户知道每一格填什么（aria-hidden：屏幕阅读器读 select 的
                  label/option 就够，重复朗读表头反而是噪音） */}
              <div className="fb-head" aria-hidden="true">
                <span className="fb-head-cell fb-head-logic" />
                <span className="fb-head-cell">字段</span>
                <span className="fb-head-cell">条件</span>
                <span className="fb-head-cell">值</span>
                <span className="fb-head-cell" />
                <span className="fb-head-cell fb-head-del" />
              </div>

              {g.conditions.map((c, ci) => (
                <ConditionRow
                  key={c.id}
                  cond={c}
                  index={ci}
                  columns={columns}
                  onChange={(patch) => patchCondition(g.id, c.id, patch)}
                  onRemove={() => removeCondition(g.id, c.id)}
                />
              ))}

              <button type="button" className="fb-add" onClick={() => addCondition(g.id)}>
                <IconPlus size={10} />
                添加条件
              </button>
            </>
          ) : (
            <div className="fb-empty">
              <span>这个条件组还没有条件</span>
              <button type="button" className="fb-btn" onClick={() => addCondition(g.id)}>
                <IconPlus size={10} />
                添加条件
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="fb-actions">
        <button
          type="button"
          className="fb-btn"
          onClick={addGroup}
          title="新增一组括号条件（组与组之间可用 AND/OR 连接）"
        >
          <IconPlus size={10} />
          条件组
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="fb-btn"
          onClick={reset}
          disabled={total === 0}
          title={total === 0 ? '当前没有条件可清除' : '清空全部条件'}
        >
          清空全部
        </button>
      </div>

      {/* WHERE 预览：参数化 SQL 原文（红线 2 的可视化证据 —— 值不进文本） */}
      <div className="fb-preview">
        <div className="fb-preview-head">
          <span>WHERE 预览</span>
          <span className="fb-preview-count" data-testid="fb-preview-count">
            {effective > 0 ? `${effective} 条有效条件` : '无有效条件'}
            {total > effective ? ` · ${total - effective} 条未填完已跳过` : ''}
          </span>
        </div>
        <pre className="filter-preview" data-testid="fb-preview">
          {preview.preview || '（无有效条件 → 不加 WHERE，返回全部行）'}
        </pre>
      </div>

      {connId && database && table ? (
        <SavedFilterBlock
          connId={connId}
          database={database}
          table={table}
          model={model}
          onApply={onChange}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}

/**
 * V18：已保存的筛选方案（列 / 应用 / 重命名 / 删除 / 搜索 / 保存当前条件）。
 *
 * 单独成组件的原因：**store 与列表状态要跟着组件挂载周期走**，不能放在
 * FilterBuilder 里 —— 否则每敲一个筛选值都会重建一次 store（重读 localStorage）。
 *
 * 名字用 window.prompt 取：这是低频动作（一天存不了几个方案），为一个输入框
 * 引入一套弹窗基建不划算；取不到名字（取消）就什么都不做，不落盘也不提示。
 */
function SavedFilterBlock(props: {
  connId: string;
  database: string;
  table: string;
  /** 当前编辑中的筛选模型 —— 「保存当前条件」存的就是它 */
  model: FilterModel;
  onApply: (model: FilterModel) => void;
  onToast?: (msg: string) => void;
}) {
  const { connId, database, table, model, onApply, onToast } = props;

  // 🔴 只建一次：localStorage 的读写在 savedFilters 内部已 try/catch 静默降级，
  //    这里不必再兜一层；换表只换 tableKey，不重建 store。
  const store = useMemo(() => createSavedFilterStore(), []);
  const tableKey = useMemo(() => savedFilterKey(connId, database, table), [connId, database, table]);

  const [list, setList] = useState<SavedFilter[]>(() => listSavedFilters(store, tableKey));
  const [query, setQuery] = useState('');

  // 换表重读：useState 的初值只在挂载时算一次，弹窗没关就切标签会留在旧表的列表上
  useEffect(() => {
    setList(listSavedFilters(store, tableKey));
    setQuery('');
  }, [store, tableKey]);

  // 搜索是纯过滤，结果随 list/query 缓存即可（方案最多 50 条，不必再做防抖）
  const shown = useMemo(() => searchSavedFilters(list, query), [list, query]);

  /** 写操作后统一重读：以存储为唯一权威，避免本地快照与多入口写入打架 */
  const refresh = useCallback(() => setList(listSavedFilters(store, tableKey)), [store, tableKey]);

  function onSaveCurrent(): void {
    const name = window.prompt('为当前筛选条件命名（同一张表内不能重名）');
    if (name === null) return; // 取消：不落盘，也不打扰
    const r = saveFilter(store, tableKey, name, model);
    // 🔴 重名 / 超上限 / 空条件都必须说出来 —— 静默失败等于用户以为存上了
    if (!r.ok) {
      onToast?.(r.reason);
      return;
    }
    refresh();
    onToast?.(`已保存方案「${r.filter.name}」`);
  }

  function onRename(f: SavedFilter): void {
    const name = window.prompt('重命名方案', f.name);
    if (name === null) return;
    const r = renameFilter(store, tableKey, f.id, name);
    if (!r.ok) {
      onToast?.(r.reason);
      return;
    }
    refresh();
  }

  function onDelete(f: SavedFilter): void {
    // 删除不可恢复，先问一句 —— 方案是用户攒出来的，误删成本比多点一次高
    if (!window.confirm(`删除方案「${f.name}」？`)) return;
    // deleteFilter 直接返回剩余列表（已排序），省一次重读
    setList(deleteFilter(store, tableKey, f.id));
  }

  return (
    <div className="sf-block">
      <div className="sf-title">
        <span>已保存的方案</span>
        <span className="spacer" />
        <button type="button" className="fb-btn sm" onClick={onSaveCurrent} title="把当前筛选条件存成一个命名方案">
          <IconPlus size={10} />
          保存当前条件
        </button>
      </div>
      {list.length > 0 ? (
        <div className="sf-row">
          <input
            className="fb-input"
            value={query}
            placeholder="搜索方案名"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="sf-empty">{list.length === 0 ? '这张表还没有保存过方案' : '没有匹配的方案'}</div>
      ) : (
        shown.map((f) => (
          <div className="sf-row" key={f.id}>
            <button type="button" className="sf-name" onClick={() => onApply(f.model)} title="点击应用到当前筛选条件">
              {f.name}
            </button>
            <button type="button" className="fb-btn sm" onClick={() => onRename(f)} title={`重命名方案「${f.name}」`}>
              重命名
            </button>
            <button
              type="button"
              className="fb-btn sm danger"
              onClick={() => onDelete(f)}
              title={`删除方案「${f.name}」（不可恢复，会先确认）`}
            >
              <IconTrash size={10} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function ConditionRow(props: {
  cond: FilterCondition;
  index: number;
  columns: ColumnMeta[];
  onChange: (patch: Partial<FilterCondition>) => void;
  onRemove: () => void;
}) {
  const { cond, index, columns, onChange, onRemove } = props;
  const col = columns.find((c) => c.name === cond.column);
  // 🔴 操作符列表来自 core-filter，UI 不自己造 —— 数值列天然没有"包含"
  const ops = col ? operatorsForColumn(col) : (['eq', 'ne'] as FilterOperator[]);
  const showValue = needsValue(cond.operator);
  const isRange = isRangeOperator(cond.operator);
  const isList = isListOperator(cond.operator);
  const complete = isConditionComplete(cond);
  const multi = col ? suggestMultiSelect(col) : false;
  const options = col ? enumOptions(col) : [];

  return (
    <div className={`filter-cond${complete ? '' : ' incomplete'}`} data-cond-id={cond.id}>
      {/* 逻辑连接符：第一条前面没有东西可连，但要占位以保持网格对齐 */}
      {index > 0 ? (
        <LogicChips
          value={cond.logic ?? 'AND'}
          titlePrefix="与上一条的连接方式"
          onChange={(v) => onChange({ logic: v })}
        />
      ) : (
        <span className="fb-logic-pad" aria-hidden="true" />
      )}

      <select
        className="fb-select fb-col"
        value={cond.column}
        title={col?.comment ? `${cond.column} — ${col.comment}` : '选择要筛选的字段'}
        onChange={(e) => onChange({ column: e.target.value })}
      >
        <option value="">（选择字段）</option>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {/* 注释优先（选字段时"这是什么"比"什么类型"更重要），无注释时退回类型 */}
            {c.comment ? `${c.name} — ${c.comment}` : `${c.name}（${c.dataType}）`}
          </option>
        ))}
      </select>

      <select
        className="fb-select fb-op"
        value={cond.operator}
        title="比较方式（可选项由字段类型决定：数值列没有「包含」）"
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {OPERATOR_LABELS[o]}
          </option>
        ))}
      </select>

      {/* 值区：按操作符形态切换（无值 / 区间双值 / 列表 / 单值）。
          🔴 外层 span 是网格单元，内部再 flex —— 区间的双输入框要在同一格里排开 */}
      <span className="fb-value">
        {!showValue ? (
          <span className="fb-value-none">无需填值</span>
        ) : isList ? (
          multi && options.length > 0 ? (
            <select
              className="fb-select fb-multi"
              multiple
              value={cond.values ?? []}
              title="多选：按住 ⌘ 逐个点选"
              onChange={(e) => onChange({ values: Array.from(e.target.selectedOptions).map((o) => o.value) })}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="fb-input"
              placeholder="逗号分隔，如 a,b,c"
              value={(cond.values ?? []).join(',')}
              onChange={(e) => onChange({ values: parseListInput(e.target.value) })}
            />
          )
        ) : isRange ? (
          <>
            <input
              className="fb-input"
              placeholder="起始值"
              title="区间起始（填 NULL 表示真 NULL）"
              value={cond.value ?? ''}
              onChange={(e) => onChange({ value: e.target.value })}
            />
            <span className="fb-range-sep">至</span>
            <input
              className="fb-input"
              placeholder="结束值"
              title="区间结束"
              value={cond.value2 ?? ''}
              onChange={(e) => onChange({ value2: e.target.value })}
            />
          </>
        ) : (
          <input
            className="fb-input"
            placeholder={
              col?.comment
                ? `${OPERATOR_LABELS[cond.operator]}：${col.comment}`
                : '输入值（NULL 表示真 NULL）'
            }
            value={cond.value ?? ''}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}
      </span>

      {/* 未填完：温和的行内提示，不用红色（这不是错误，只是还没填完） */}
      {!complete ? <span className="fb-warn" title="这条条件还没填完，不会进入 WHERE">未填完</span> : null}

      <button type="button" className="fb-del" onClick={onRemove} title="删除这条条件" aria-label="删除条件">
        <IconX size={11} />
      </button>
    </div>
  );
}
