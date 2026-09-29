/**
 * 筛选构建器 UI（§6.3.3）
 *
 * 逻辑全在 `core-filter`，这里只做界面。三条红线（改之前先看）：
 *
 *  1. **数值列没有「包含」操作符** —— 由 `operatorsForColumn()` 决定，
 *     UI 不许自己塞选项。真机验证过：给数值列 LIKE 会静默返回空结果。
 *  2. **WHERE 必须参数化** —— 值永远不进 SQL 文本。`buildWhere()` 已经保证，
 *     这里只负责把值收进条件模型，一句 SQL 都不自己拼。
 *  3. **参数顺序是 `[...whereParams, ...limitParams]`** —— 这条在调用方
 *     （App 的 loadTable），顺序反了报的错完全指向别处。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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

export function FilterBuilder({ model, onChange, columns, connId, database, table, onToast }: FilterBuilderProps) {
  const preview = useMemo(() => buildWhere(model), [model]);
  const count = conditionCount(model);

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

  const addCondition = useCallback(
    (groupId: string) => {
      onChange({
        groups: model.groups.map((g) =>
          g.id !== groupId
            ? g
            : {
                ...g,
                conditions: [
                  ...g.conditions,
                  {
                    id: nextId('c', g.conditions.map((c) => c.id)),
                    column: columns[0]?.name ?? '',
                    operator: 'eq' as FilterOperator,
                    value: '',
                  },
                ],
              },
        ),
      });
    },
    [model, onChange, columns],
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
    onChange({
      groups: [
        ...model.groups,
        {
          id: nextId('g', model.groups.map((g) => g.id)),
          logic: 'AND' as LogicOp,
          join: 'AND' as LogicOp,
          conditions: [
            {
              id: nextId('c', model.groups.flatMap((g) => g.conditions.map((c) => c.id))),
              column: columns[0]?.name ?? '',
              operator: 'eq' as FilterOperator,
              value: '',
            },
          ],
        },
      ],
    });
  }, [model, onChange, columns]);

  const reset = useCallback(() => onChange(emptyFilter()), [onChange]);

  return (
    <div className="filter-builder">
      {model.groups.map((g, gi) => (
        <div className="filter-group" key={g.id}>
          {gi > 0 ? (
            <div className="filter-cond">
              <select
                className="filter-logic"
                value={g.join ?? 'AND'}
                onChange={(e) =>
                  onChange({
                    groups: model.groups.map((x) =>
                      x.id === g.id ? { ...x, join: e.target.value as LogicOp } : x,
                    ),
                  })
                }
                title="与上一组的连接符"
              >
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
              <span className="filter-incomplete">组 {gi + 1}</span>
            </div>
          ) : null}

          <div className="filter-cond">
            <span className="filter-incomplete">组内</span>
            <select
              className="filter-logic"
              value={g.logic}
              onChange={(e) =>
                onChange({
                  groups: model.groups.map((x) =>
                    x.id === g.id ? { ...x, logic: e.target.value as LogicOp } : x,
                  ),
                })
              }
            >
              <option value="AND">全部满足</option>
              <option value="OR">任一满足</option>
            </select>
            <span className="spacer" />
            <button onClick={() => addCondition(g.id)}>+ 条件</button>
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
        </div>
      ))}

      <div className="filter-cond">
        <button onClick={addGroup}>+ 条件组（一层括号）</button>
        <button onClick={reset}>重置</button>
      </div>

      <div className="filter-preview-bar">
        <span className="filter-incomplete">有效条件 {count} 条（不完整的已跳过）</span>
      </div>
      <pre className="filter-preview">{preview.preview || '（无有效条件 → 不加 WHERE）'}</pre>

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
        <button className="sf-btn" onClick={onSaveCurrent} title="把当前筛选条件存成一个命名方案">
          保存当前条件
        </button>
      </div>
      <div className="sf-row">
        <input value={query} placeholder="搜索方案名" onChange={(e) => setQuery(e.target.value)} />
      </div>
      {shown.length === 0 ? (
        <div className="sf-empty">
          {list.length === 0 ? '这张表还没有保存过方案' : '没有匹配的方案'}
        </div>
      ) : (
        shown.map((f) => (
          <div className="sf-row" key={f.id}>
            <button className="sf-name" onClick={() => onApply(f.model)} title="点击应用到当前筛选条件">
              {f.name}
            </button>
            <button className="sf-btn" onClick={() => onRename(f)}>
              重命名
            </button>
            <button className="sf-btn danger" onClick={() => onDelete(f)}>
              删除
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
    <div className="filter-cond">
      {index > 0 ? (
        <select
          className="filter-logic"
          value={cond.logic ?? 'AND'}
          onChange={(e) => onChange({ logic: e.target.value as LogicOp })}
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
      ) : (
        <span className="filter-logic" />
      )}

      <select
        className="col"
        value={cond.column}
        onChange={(e) => onChange({ column: e.target.value })}
      >
        <option value="">（选择列）</option>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.dataType}
          </option>
        ))}
      </select>

      <select
        className="op"
        value={cond.operator}
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {OPERATOR_LABELS[o]}
          </option>
        ))}
      </select>

      {showValue && isList ? (
        multi && options.length > 0 ? (
          <select
            multiple
            value={cond.values ?? []}
            onChange={(e) =>
              onChange({ values: Array.from(e.target.selectedOptions).map((o) => o.value) })
            }
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            placeholder="逗号分隔，如 a,b,c"
            value={(cond.values ?? []).join(',')}
            onChange={(e) => onChange({ values: parseListInput(e.target.value) })}
          />
        )
      ) : null}

      {showValue && !isList ? (
        <input
          placeholder={isRange ? '起始（NULL 表示真 NULL）' : '值（NULL 表示真 NULL）'}
          value={cond.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      ) : null}

      {isRange ? (
        <input
          placeholder="结束"
          value={cond.value2 ?? ''}
          onChange={(e) => onChange({ value2: e.target.value })}
        />
      ) : null}

      {!complete ? <span className="filter-incomplete">未填完</span> : null}
      <button className="del" onClick={onRemove} title="删除条件">
        ✕
      </button>
    </div>
  );
}
