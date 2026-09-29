/**
 * 表设计器（PRD §6.5）
 *
 * 三分区 tab：字段 / 索引 / 外键；底部常驻 DDL 预览（差异视图 / 完整 DDL 切换）。
 *
 * 两种模式：
 *  - 新建表：树库节点「新建表」入口 → newTableDesign() → 保存执行 CREATE TABLE
 *  - 编辑表：从 TableMeta 反构造 → buildAlterStatements 算 diff → 逐条执行 ALTER
 *
 * 保存前必须确认（红色表/危险操作走 DangerConfirm 二次弹窗 —— 与 P0-3 联动，
 * DROP COLUMN 的语句在确认文案里逐条列出）。
 *
 * DDL 执行走 backend.queryRun（只读连接会被主进程 AST 白名单拦截 —— 正确行为）。
 */

import { useCallback, useMemo, useState } from 'react';
import type { Backend } from '../backend';
import { IconX } from '../ui/icons';
import type { TableMeta, DatabaseMeta } from '@dbstudio/core-schema-cache';
import {
  newTableDesign,
  designFromTableMeta,
  emptyColumn,
  emptyIndex,
  emptyForeignKey,
  typeDefaultLength,
  typeSupportsLength,
  typeSupportsScale,
  validateDesign,
  buildCreateTable,
  buildAlterStatements,
  TYPE_GROUPS,
  FK_ACTIONS,
  type TableDesign,
  type DesignColumn,
  type IndexKind,
  type FkAction,
} from '@dbstudio/core-table-designer';

export interface TableDesignerProps {
  backend: Backend;
  connId: string;
  database: string;
  /** null = 新建表模式 */
  existingTable: TableMeta | null;
  /** 引用的其他表（外键引用表下拉数据源） */
  databases: DatabaseMeta[];
  onClose: () => void;
  onToast: (msg: string) => void;
  /** 保存成功后（刷新 schema / 树） */
  onSaved: () => void;
  /** 危险操作确认弹窗（P0-3 提供；未接时退化成 window.confirm 的兜底实现） */
  confirmDanger?: (opts: { title: string; statements: string[]; requireText?: string }) => Promise<boolean>;
}

const TAB_LABELS: { key: 'columns' | 'indexes' | 'foreignKeys'; label: string }[] = [
  { key: 'columns', label: '字段' },
  { key: 'indexes', label: '索引' },
  { key: 'foreignKeys', label: '外键' },
];

export function TableDesigner({
  backend,
  connId,
  database,
  existingTable,
  databases,
  onClose,
  onToast,
  onSaved,
  confirmDanger,
}: TableDesignerProps) {
  const isEdit = existingTable !== null;

  const [design, setDesign] = useState<TableDesign>(() =>
    isEdit
      ? designFromTableMeta(existingTable.name, existingTable)
      : newTableDesign(),
  );
  const [tab, setTab] = useState<'columns' | 'indexes' | 'foreignKeys'>('columns');
  const [ddlView, setDdlView] = useState<'diff' | 'full'>('diff');
  const [saving, setSaving] = useState(false);

  const issues = useMemo(() => validateDesign(design), [design]);
  const errors = issues.filter((i) => i.level === 'error');

  // DDL 预览（diff 模式编辑表；新建表给完整 CREATE）
  const create = useMemo(() => buildCreateTable(database, design), [database, design]);
  const alter = useMemo(
    () =>
      isEdit
        ? buildAlterStatements(database, existingTable.name, existingTable, design)
        : { statements: [], summary: [] },
    [isEdit, database, existingTable, design],
  );

  // ---------- 列编辑 ----------
  const updateColumn = useCallback((key: string, patch: Partial<DesignColumn>) => {
    setDesign((d) => ({
      ...d,
      columns: d.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    }));
  }, []);

  const changeColumnType = useCallback((key: string, type: string) => {
    setDesign((d) => ({
      ...d,
      columns: d.columns.map((c) =>
        c.key === key
          ? {
              ...c,
              type,
              length: typeDefaultLength(type),
              scale: '',
              // 切到非整数类型时清掉自增（校验会拦，这里主动清更友好）
              autoIncrement: /^(tinyint|smallint|mediumint|int|bigint)$/.test(type) ? c.autoIncrement : false,
            }
          : c,
      ),
    }));
  }, []);

  const addColumn = useCallback(() => {
    setDesign((d) => ({ ...d, columns: [...d.columns, emptyColumn()] }));
  }, []);

  const removeColumn = useCallback((key: string) => {
    setDesign((d) => ({ ...d, columns: d.columns.filter((c) => c.key !== key) }));
  }, []);

  const moveColumn = useCallback((key: string, dir: -1 | 1) => {
    setDesign((d) => {
      const idx = d.columns.findIndex((c) => c.key === key);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= d.columns.length) return d;
      const cols = [...d.columns];
      [cols[idx], cols[target]] = [cols[target], cols[idx]];
      return { ...d, columns: cols };
    });
  }, []);

  // ---------- 索引编辑 ----------
  const addIndex = useCallback(() => {
    setDesign((d) => ({ ...d, indexes: [...d.indexes, emptyIndex()] }));
  }, []);

  const updateIndex = useCallback((key: string, patch: Record<string, unknown>) => {
    setDesign((d) => ({ ...d, indexes: d.indexes.map((i) => (i.key === key ? { ...i, ...patch } : i)) }));
  }, []);

  const removeIndex = useCallback((key: string) => {
    setDesign((d) => ({ ...d, indexes: d.indexes.filter((i) => i.key !== key) }));
  }, []);

  // ---------- 外键编辑 ----------
  const addFk = useCallback(() => {
    setDesign((d) => ({ ...d, foreignKeys: [...d.foreignKeys, emptyForeignKey()] }));
  }, []);

  const updateFk = useCallback((key: string, patch: Record<string, unknown>) => {
    setDesign((d) => ({ ...d, foreignKeys: d.foreignKeys.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
  }, []);

  const removeFk = useCallback((key: string) => {
    setDesign((d) => ({ ...d, foreignKeys: d.foreignKeys.filter((f) => f.key !== key) }));
  }, []);

  // ---------- 保存 ----------
  const dangerConfirm = useCallback(
    async (title: string, statements: string[]) => {
      if (confirmDanger) {
        return confirmDanger({ title, statements, requireText: undefined });
      }
      // 兜底：window.confirm（e2e/演示环境没接 P0-3 时也能用）
      return window.confirm(`${title}\n\n${statements.join('\n')}`);
    },
    [confirmDanger],
  );

  const save = useCallback(async () => {
    if (errors.length > 0) {
      onToast(`还有 ${errors.length} 个校验错误，先修正再保存`);
      return;
    }

    let statements: string[] = [];
    let title = '';

    if (!isEdit) {
      if (!create.sql) return;
      statements = [create.sql];
      title = `在 ${database} 中创建表 ${design.tableName}？`;
    } else {
      if (alter.statements.length === 0) {
        onToast('没有结构改动');
        return;
      }
      statements = alter.statements;
      const hasDrop = statements.some((s) => /DROP (COLUMN|PRIMARY KEY)/i.test(s));
      title = hasDrop
        ? `修改表 ${existingTable.name} 包含删除操作（不可自动回滚），确认执行？`
        : `修改表 ${existingTable.name}：将执行 ${statements.length} 条变更？`;
    }

    // 危险语句必须逐条过目（P0-3 的分层确认：含 DROP → 强确认）
    const ok = await dangerConfirm(title, statements);
    if (!ok) return;

    setSaving(true);
    try {
      for (const sql of statements) {
        const r = await backend.queryRun({ connId, sql, database });
        if (r.cancelled) {
          onToast('执行被取消');
          return;
        }
      }
      onToast(isEdit ? `表 ${design.tableName} 已更新（${statements.length} 条变更）` : `表 ${design.tableName} 已创建`);
      onSaved();
      onClose();
    } catch (e) {
      onToast(`执行失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [errors.length, isEdit, create.sql, alter.statements, database, design.tableName, existingTable, dangerConfirm, backend, connId, onToast, onSaved, onClose]);

  // ---------- 渲染 ----------
  const hasChanges = isEdit ? alter.statements.length > 0 : true;
  const colNames = design.columns.map((c) => c.name).filter(Boolean);

  const ddlPreview = !isEdit
    ? create.sql ?? '-- 校验未通过，无法生成 DDL'
    : ddlView === 'diff'
      ? alter.statements.length > 0
        ? alter.statements.map((s) => s + ';').join('\n')
        : '-- 无结构改动'
      : create.sql ?? '-- 校验未通过';

  return (
    <div className="modal-mask" onClick={saving ? undefined : onClose}>
      <div className="modal designer-modal" onClick={(e) => e.stopPropagation()} data-testid="table-designer">
        <header>
          {isEdit ? `设计表 — ${database}.${existingTable.name}` : `新建表 — ${database}`}
        </header>

        <div className="body designer-body">
          {/* 表属性（新建模式可编辑表名/注释；编辑模式锁定表名） */}
          <div className="designer-meta">
            <label className="ce-field">
              <span className="ce-label">表名</span>
              <input
                className="ce-input"
                value={design.tableName}
                disabled={isEdit || saving}
                onChange={(e) => setDesign((d) => ({ ...d, tableName: e.target.value }))}
                data-testid="designer-table-name"
              />
            </label>
            <label className="ce-field">
              <span className="ce-label">引擎</span>
              <select
                value={design.engine}
                disabled={saving}
                onChange={(e) => setDesign((d) => ({ ...d, engine: e.target.value }))}
              >
                {['InnoDB', 'MyISAM', 'MEMORY'].map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </label>
            <label className="ce-field">
              <span className="ce-label">表注释</span>
              <input
                className="ce-input"
                value={design.comment}
                disabled={saving}
                onChange={(e) => setDesign((d) => ({ ...d, comment: e.target.value }))}
              />
            </label>
          </div>

          {/* 校验错误条 */}
          {errors.length > 0 ? (
            <ul className="designer-issues" data-testid="designer-issues">
              {errors.slice(0, 4).map((e, i) => (
                <li key={i}><IconX /> {e.message}</li>
              ))}
            </ul>
          ) : null}

          {/* 分区 tab */}
          <div className="ce-tabs">
            {TAB_LABELS.map((t) => (
              <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                {t.label}
                {t.key === 'columns' ? ` (${design.columns.length})` : ''}
              </button>
            ))}
          </div>

          {/* ---- 字段分区 ---- */}
          {tab === 'columns' ? (
            <div className="designer-columns" data-testid="designer-columns">
              <table>
                <thead>
                  <tr>
                    <th className="w-order" />
                    <th>字段名</th>
                    <th>类型</th>
                    <th className="w-len">长度</th>
                    <th className="w-len">小数位</th>
                    <th className="w-chk">无符号</th>
                    <th className="w-chk">可空</th>
                    <th>默认值</th>
                    <th className="w-chk">自增</th>
                    <th className="w-chk">主键</th>
                    <th>注释</th>
                    <th className="w-order" />
                  </tr>
                </thead>
                <tbody>
                  {design.columns.map((c, i) => (
                    <tr key={c.key} className="designer-col-row">
                      <td className="w-order">
                        <button title="上移" disabled={i === 0} onClick={() => moveColumn(c.key, -1)}>↑</button>
                        <button title="下移" disabled={i === design.columns.length - 1} onClick={() => moveColumn(c.key, 1)}>↓</button>
                      </td>
                      <td>
                        <input
                          value={c.name}
                          disabled={saving}
                          placeholder="字段名"
                          onChange={(e) => updateColumn(c.key, { name: e.target.value })}
                          data-testid={`col-name-${i}`}
                        />
                      </td>
                      <td>
                        <select value={c.type} disabled={saving} onChange={(e) => changeColumnType(c.key, e.target.value)}>
                          {TYPE_GROUPS.map((g) => (
                            <optgroup key={g.group} label={g.group}>
                              {g.types.map((t) => (
                                <option key={t.name} value={t.name}>{t.name}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td className="w-len">
                        <input
                          value={c.length}
                          disabled={saving || !typeSupportsLength(c.type)}
                          placeholder="长度"
                          onChange={(e) => updateColumn(c.key, { length: e.target.value })}
                        />
                      </td>
                      <td className="w-len">
                        <input
                          value={c.scale}
                          disabled={saving || !typeSupportsScale(c.type)}
                          placeholder="小数"
                          onChange={(e) => updateColumn(c.key, { scale: e.target.value })}
                        />
                      </td>
                      <td className="w-chk">
                        <input
                          type="checkbox"
                          checked={c.unsigned}
                          disabled={saving}
                          onChange={(e) => updateColumn(c.key, { unsigned: e.target.checked })}
                        />
                      </td>
                      <td className="w-chk">
                        <input
                          type="checkbox"
                          checked={c.nullable}
                          disabled={saving}
                          onChange={(e) => updateColumn(c.key, { nullable: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          value={c.defaultValue ?? ''}
                          disabled={saving}
                          placeholder="（无）"
                          onChange={(e) => updateColumn(c.key, { defaultValue: e.target.value === '' ? null : e.target.value })}
                        />
                      </td>
                      <td className="w-chk">
                        <input
                          type="checkbox"
                          checked={c.autoIncrement}
                          disabled={saving}
                          onChange={(e) => updateColumn(c.key, { autoIncrement: e.target.checked })}
                        />
                      </td>
                      <td className="w-chk">
                        <input
                          type="checkbox"
                          checked={c.isPrimaryKey}
                          disabled={saving}
                          onChange={(e) => updateColumn(c.key, { isPrimaryKey: e.target.checked, nullable: e.target.checked ? false : c.nullable })}
                        />
                      </td>
                      <td>
                        <input
                          value={c.comment}
                          disabled={saving}
                          placeholder="注释"
                          onChange={(e) => updateColumn(c.key, { comment: e.target.value })}
                        />
                      </td>
                      <td className="w-order">
                        <button title="删除字段" disabled={saving} onClick={() => removeColumn(c.key)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="designer-add" onClick={addColumn} disabled={saving} data-testid="designer-add-column">
                ＋ 添加字段
              </button>
            </div>
          ) : null}

          {/* ---- 索引分区 ---- */}
          {tab === 'indexes' ? (
            <div className="designer-indexes" data-testid="designer-indexes">
              {design.indexes.map((idx) => (
                <div key={idx.key} className="designer-index-card">
                  <div className="designer-index-head">
                    <input
                      value={idx.name}
                      placeholder="索引名（留空自动）"
                      disabled={saving}
                      onChange={(e) => updateIndex(idx.key, { name: e.target.value })}
                    />
                    <select
                      value={idx.kind}
                      disabled={saving}
                      onChange={(e) => updateIndex(idx.key, { kind: e.target.value as IndexKind })}
                    >
                      <option value="normal">普通</option>
                      <option value="unique">唯一</option>
                      <option value="fulltext">全文</option>
                      <option value="spatial">空间</option>
                    </select>
                    <input
                      value={idx.comment}
                      placeholder="注释"
                      disabled={saving}
                      onChange={(e) => updateIndex(idx.key, { comment: e.target.value })}
                    />
                    <span className="spacer" />
                    <button disabled={saving} onClick={() => removeIndex(idx.key)}>删除</button>
                  </div>
                  <div className="designer-index-cols">
                    {idx.columns.map((ic, ci) => (
                      <div key={ci} className="designer-index-col">
                        <select
                          value={ic.column}
                          disabled={saving}
                          onChange={(e) => {
                            const columns = [...idx.columns];
                            columns[ci] = { ...ic, column: e.target.value };
                            updateIndex(idx.key, { columns });
                          }}
                        >
                          <option value="">（选字段）</option>
                          {colNames.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <input
                          value={ic.prefixLength}
                          placeholder="前缀"
                          disabled={saving}
                          style={{ width: 64 }}
                          onChange={(e) => {
                            const columns = [...idx.columns];
                            columns[ci] = { ...ic, prefixLength: e.target.value };
                            updateIndex(idx.key, { columns });
                          }}
                        />
                        <button
                          disabled={saving}
                          onClick={() => updateIndex(idx.key, { columns: idx.columns.filter((_, j) => j !== ci) })}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      disabled={saving}
                      onClick={() =>
                        updateIndex(idx.key, { columns: [...idx.columns, { column: '', prefixLength: '' }] })
                      }
                    >
                      ＋ 加字段
                    </button>
                  </div>
                </div>
              ))}
              <button className="designer-add" onClick={addIndex} disabled={saving} data-testid="designer-add-index">
                ＋ 添加索引
              </button>
              <p className="designer-hint">编辑已有表时，此处新增的索引会在保存时创建；删除已有索引请用 SQL 编辑器。</p>
            </div>
          ) : null}

          {/* ---- 外键分区 ---- */}
          {tab === 'foreignKeys' ? (
            <div className="designer-fks" data-testid="designer-fks">
              {design.foreignKeys.map((fk) => {
                const refDbMeta = databases.find((d) => d.name === (fk.refDatabase || database));
                const refTableMeta = refDbMeta?.tables.find((t) => t.name === fk.refTable);
                return (
                  <div key={fk.key} className="designer-fk-card">
                    <div className="designer-fk-head">
                      <input
                        value={fk.name}
                        placeholder="外键名（留空自动）"
                        disabled={saving}
                        onChange={(e) => updateFk(fk.key, { name: e.target.value })}
                      />
                      <span className="spacer" />
                      <button disabled={saving} onClick={() => removeFk(fk.key)}>删除</button>
                    </div>
                    <div className="designer-fk-row">
                      <label>本表字段</label>
                      {fk.columns.map((c, ci) => (
                        <select
                          key={ci}
                          value={c}
                          disabled={saving}
                          onChange={(e) => {
                            const columns = [...fk.columns];
                            columns[ci] = e.target.value;
                            updateFk(fk.key, { columns });
                          }}
                        >
                          <option value="">（选字段）</option>
                          {colNames.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      ))}
                      <button
                        disabled={saving}
                        onClick={() => updateFk(fk.key, { columns: [...fk.columns, ''] })}
                      >
                        ＋
                      </button>
                    </div>
                    <div className="designer-fk-row">
                      <label>引用库.表</label>
                      <select
                        value={fk.refDatabase || database}
                        disabled={saving}
                        onChange={(e) => updateFk(fk.key, { refDatabase: e.target.value, refTable: '', refColumns: [] })}
                      >
                        {(databases.length > 0 ? databases.map((d) => d.name) : [database]).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                      <select
                        value={fk.refTable}
                        disabled={saving}
                        onChange={(e) => updateFk(fk.key, { refTable: e.target.value, refColumns: [] })}
                      >
                        <option value="">（选表）</option>
                        {(refDbMeta?.tables ?? []).map((t) => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="designer-fk-row">
                      <label>引用字段</label>
                      {fk.refColumns.map((c, ci) => (
                        <select
                          key={ci}
                          value={c}
                          disabled={saving}
                          onChange={(e) => {
                            const refColumns = [...fk.refColumns];
                            refColumns[ci] = e.target.value;
                            updateFk(fk.key, { refColumns });
                          }}
                        >
                          <option value="">（选字段）</option>
                          {(refTableMeta?.columns ?? []).map((c2) => (
                            <option key={c2.name} value={c2.name}>{c2.name}</option>
                          ))}
                        </select>
                      ))}
                      <button
                        disabled={saving}
                        onClick={() => updateFk(fk.key, { refColumns: [...fk.refColumns, ''] })}
                      >
                        ＋
                      </button>
                    </div>
                    <div className="designer-fk-row">
                      <label>ON DELETE / ON UPDATE</label>
                      <select
                        value={fk.onDelete}
                        disabled={saving}
                        onChange={(e) => updateFk(fk.key, { onDelete: e.target.value as FkAction })}
                      >
                        {FK_ACTIONS.map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                      <select
                        value={fk.onUpdate}
                        disabled={saving}
                        onChange={(e) => updateFk(fk.key, { onUpdate: e.target.value as FkAction })}
                      >
                        {FK_ACTIONS.map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
              <button className="designer-add" onClick={addFk} disabled={saving} data-testid="designer-add-fk">
                ＋ 添加外键
              </button>
            </div>
          ) : null}

          {/* ---- DDL 预览（常驻底栏） ---- */}
          <div className="designer-ddl" data-testid="designer-ddl">
            <div className="designer-ddl-head">
              <span>DDL 预览</span>
              {isEdit ? (
                <span className="designer-ddl-switch">
                  <button className={ddlView === 'diff' ? 'active' : ''} onClick={() => setDdlView('diff')}>
                    差异视图{alter.statements.length > 0 ? `（${alter.statements.length}）` : ''}
                  </button>
                  <button className={ddlView === 'full' ? 'active' : ''} onClick={() => setDdlView('full')}>
                    完整 DDL
                  </button>
                </span>
              ) : null}
            </div>
            {isEdit && alter.summary.length > 0 && ddlView === 'diff' ? (
              <ul className="designer-ddl-summary">
                {alter.summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : null}
            <pre>{ddlPreview}</pre>
          </div>
        </div>

        <footer>
          <button onClick={onClose} disabled={saving}>取消</button>
          <button
            className="primary"
            onClick={() => void save()}
            disabled={saving || errors.length > 0 || !hasChanges}
            data-testid="designer-save"
          >
            {saving ? '执行中…' : isEdit ? `保存（${alter.statements.length} 条变更）` : '创建表'}
          </button>
        </footer>
      </div>
    </div>
  );
}
