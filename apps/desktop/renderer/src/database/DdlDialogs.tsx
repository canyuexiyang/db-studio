/**
 * 0.7.3 对象生命周期对话框（新建库 / 重命名 / 复制表）。
 *
 * 形态选择：**不引入新弹窗框架**，一律复用首屏既有的 `.modal-mask + .modal + header/body/footer`
 * （红线 9：懒加载组件的壳样式必须首屏就位）。三个对话框都很小，静态引入，
 * 不进 lazy —— 与 ScriptDbPicker 同口径（避免为几十行 JSX 付一次 Suspense 塌陷）。
 *
 * 🔴 三个共同的验收点：
 *  1. **SQL 原文必须在确认前可见**（红线 1）：新建库/复制表都把将要执行的语句
 *     实时显示出来，用户改名字时预览跟着变；
 *  2. **非法输入当场说原因**，而不是等点确认后被服务端报错（`validateNewName` 是唯一判定处）；
 *  3. 执行失败时**对话框不关**，把服务端原文贴在里面 —— 关掉就把用户填的东西丢了，
 *     而且"点了确认就消失、结果不知道成没成"是最难自查的形态。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  CHARSET_PRESETS,
  buildCopyTableSql,
  buildCreateDatabaseSql,
  collationsOf,
  validateNewName,
} from './ddlTemplates';

/** Esc 关闭（与 DangerConfirmModal 同口径：挂 window，输入框内也能退） */
function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function SqlPreview({ statements, testId }: { statements: string[]; testId: string }) {
  if (statements.length === 0) return null;
  return (
    <div className="ddl-sql" data-testid={testId}>
      <span className="ddl-sql-label">将要执行的语句</span>
      {statements.map((s, i) => (
        <pre key={i}>{s}</pre>
      ))}
    </div>
  );
}

// ---------- 单输入对话框：重命名表 / 重命名分组 / 新建分组 ----------

export interface NamePromptModalProps {
  title: string;
  /** 字段名（「新表名」「分组名」） */
  label: string;
  initial?: string;
  placeholder?: string;
  /** 常显说明（为什么这么做、影响范围） */
  hint?: string;
  confirmLabel?: string;
  /** 返回中文错误原因；null = 通过。判定逻辑由调用方传入（纯函数，可单测） */
  validate: (value: string) => string | null;
  /**
   * 0.7.3：实时 SQL 预览（红线 1：写操作先展示可预览的原文）。
   * 返回 null = 这一格没有 SQL 可展示（例如改分组名，只改本地配置）。
   */
  preview?: (value: string) => string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  testId: string;
}

export function NamePromptModal({
  title,
  label,
  initial = '',
  placeholder,
  hint,
  confirmLabel = '确定',
  validate,
  preview,
  onCancel,
  onConfirm,
  testId,
}: NamePromptModalProps) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEscapeClose(onCancel);

  const error = validate(value);
  // 初次进来不报错（用户还没动手），改动过之后才实时提示
  const shown = touched ? error : null;
  const canSubmit = error === null;
  const sql = preview && canSubmit ? preview(value) : null;

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    onConfirm(value.trim());
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal ddl-modal" onClick={(e) => e.stopPropagation()} data-testid={testId}>
        <header>{title}</header>
        <div className="body">
          <label className="ddl-field">
            <span className="ddl-label">{label}</span>
            <input
              className="ddl-input"
              value={value}
              autoFocus
              placeholder={placeholder}
              data-testid={`${testId}-input`}
              onChange={(e) => {
                setTouched(true);
                setValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </label>
          {shown ? (
            <p className="ddl-error" data-testid={`${testId}-error`}>
              {shown}
            </p>
          ) : hint ? (
            <p className="ddl-hint">{hint}</p>
          ) : null}
          {sql ? <SqlPreview statements={[sql]} testId={`${testId}-sql`} /> : null}
        </div>
        <footer>
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={!canSubmit} onClick={submit} data-testid={`${testId}-ok`}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------- 新建数据库 ----------

export interface CreateDatabaseModalProps {
  connName: string;
  /** 该连接已有的库名（重名判定用） */
  existing: string[];
  /** 初值：跟随该连接已有库的字符集/排序规则；没有就 utf8mb4 */
  defaultCharset: string;
  defaultCollation: string;
  /** 执行中：按钮禁用，避免双击发两次 CREATE */
  busy: boolean;
  /** 上一次执行失败的服务端原文（保留在弹窗里） */
  error: string | null;
  onCancel: () => void;
  onConfirm: (v: { name: string; charset: string; collation: string }) => void;
}

export function CreateDatabaseModal({
  connName,
  existing,
  defaultCharset,
  defaultCollation,
  busy,
  error,
  onCancel,
  onConfirm,
}: CreateDatabaseModalProps) {
  const [name, setName] = useState('');
  const [charset, setCharset] = useState(defaultCharset || 'utf8mb4');
  const [collation, setCollation] = useState(defaultCollation);
  const [touched, setTouched] = useState(false);
  useEscapeClose(busy ? () => undefined : onCancel);

  const check = validateNewName(name, {
    label: '库名',
    existing,
    conflictSuffix: `该实例上`,
  });

  /**
   * SQL 预览：名字不合法时**不预览**（拼不出来），但把原因写在下面 ——
   * 显示一个不可能执行的预览反而让人以为可以点。
   */
  const preview = useMemo(() => {
    if (!check.ok) return [];
    try {
      return [buildCreateDatabaseSql({ name: check.value, charset, collation })];
    } catch {
      return [];
    }
  }, [check.ok, check.value, charset, collation]);

  const collations = collationsOf(charset);
  const pickCharset = (next: string) => {
    setCharset(next);
    // 排序规则跟着字符集走：留着 utf8mb4 的排序规则配上 latin1 必然报 Unknown collation
    const list = collationsOf(next);
    setCollation(list[0] ?? '');
  };

  return (
    <div className="modal-mask" onClick={busy ? undefined : onCancel}>
      <div className="modal ddl-modal" onClick={(e) => e.stopPropagation()} data-testid="create-db-modal">
        <header>新建数据库 — {connName}</header>
        <div className="body">
          <label className="ddl-field">
            <span className="ddl-label">库名</span>
            <input
              className="ddl-input"
              value={name}
              autoFocus
              placeholder="例如 order_archive"
              data-testid="create-db-name"
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && check.ok && !busy) onConfirm({ name: check.value, charset, collation });
              }}
            />
          </label>
          {touched && check.error ? (
            <p className="ddl-error" data-testid="create-db-error">
              {check.error}
            </p>
          ) : null}

          <div className="ddl-row">
            <label className="ddl-field">
              <span className="ddl-label">字符集</span>
              <select
                className="ddl-input"
                value={charset}
                data-testid="create-db-charset"
                onChange={(e) => pickCharset(e.target.value)}
              >
                {CHARSET_PRESETS.map((p) => (
                  <option key={p.charset} value={p.charset}>
                    {p.charset}
                  </option>
                ))}
              </select>
            </label>
            <label className="ddl-field">
              <span className="ddl-label">排序规则</span>
              <input
                className="ddl-input"
                value={collation}
                list="dbstudio-collations"
                data-testid="create-db-collation"
                onChange={(e) => setCollation(e.target.value)}
              />
              <datalist id="dbstudio-collations">
                {collations.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>

          <SqlPreview statements={preview} testId="create-db-sql" />
          <p className="ddl-hint">
            只读连接不允许建库。执行后会自动刷新左侧结构，并定位到新库。
          </p>
          {error ? (
            <p className="ddl-error" data-testid="create-db-server-error">
              创建失败：{error}
            </p>
          ) : null}
        </div>
        <footer>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={!check.ok || busy}
            onClick={() => check.ok && onConfirm({ name: check.value, charset, collation })}
            data-testid="create-db-ok"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------- 复制表 ----------

export interface CopyTableModalProps {
  database: string;
  table: string;
  /** 可选目标库（含源库本身；跨库复制是常见需求） */
  databases: string[];
  /** 目标库已有的表名（每个库一份，重名判定按所选目标库取） */
  existingByDb: Record<string, string[]>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (v: { name: string; targetDatabase: string; withData: boolean }) => void;
}

export function CopyTableModal({
  database,
  table,
  databases,
  existingByDb,
  busy,
  error,
  onCancel,
  onConfirm,
}: CopyTableModalProps) {
  const [targetDb, setTargetDb] = useState(database);
  const [name, setName] = useState(`${table}_copy`);
  const [withData, setWithData] = useState(true);
  const [touched, setTouched] = useState(false);
  useEscapeClose(busy ? () => undefined : onCancel);

  const check = validateNewName(name, {
    label: '新表名',
    existing: existingByDb[targetDb] ?? [],
    conflictSuffix: `${targetDb} 中`,
  });

  const preview = useMemo(() => {
    if (!check.ok) return [];
    try {
      return buildCopyTableSql({ database, table, newTable: check.value, targetDatabase: targetDb, withData });
    } catch {
      return [];
    }
  }, [check.ok, check.value, database, table, targetDb, withData]);

  return (
    <div className="modal-mask" onClick={busy ? undefined : onCancel}>
      <div className="modal ddl-modal" onClick={(e) => e.stopPropagation()} data-testid="copy-table-modal">
        <header>
          复制表 — {database}.{table}
        </header>
        <div className="body">
          <div className="ddl-row">
            <label className="ddl-field">
              <span className="ddl-label">目标库</span>
              <select
                className="ddl-input"
                value={targetDb}
                data-testid="copy-table-db"
                onChange={(e) => {
                  setTouched(true);
                  setTargetDb(e.target.value);
                }}
              >
                {databases.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="ddl-field">
              <span className="ddl-label">新表名</span>
              <input
                className="ddl-input"
                value={name}
                autoFocus
                data-testid="copy-table-name"
                onChange={(e) => {
                  setTouched(true);
                  setName(e.target.value);
                }}
              />
            </label>
          </div>
          {touched && check.error ? (
            <p className="ddl-error" data-testid="copy-table-error">
              {check.error}
            </p>
          ) : null}

          <label className="ce-check ddl-check">
            <input
              type="checkbox"
              checked={withData}
              data-testid="copy-table-withdata"
              onChange={(e) => setWithData(e.target.checked)}
            />
            连同数据一起复制（大表会明显变慢）
          </label>

          <SqlPreview statements={preview} testId="copy-table-sql" />
          <p className="ddl-hint">
            结构通过 <code>CREATE TABLE … LIKE</code> 复制（索引/默认值一并带上）；勾选数据时追加一条
            <code>INSERT … SELECT</code>。两步不是同一个事务：若表已建好而数据失败，会如实告诉你哪一步失败了。
          </p>
          {error ? (
            <p className="ddl-error" data-testid="copy-table-server-error">
              {error}
            </p>
          ) : null}
        </div>
        <footer>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={!check.ok || busy}
            onClick={() => check.ok && onConfirm({ name: check.value, targetDatabase: targetDb, withData })}
            data-testid="copy-table-ok"
          >
            {busy ? '复制中…' : '开始复制'}
          </button>
        </footer>
      </div>
    </div>
  );
}
