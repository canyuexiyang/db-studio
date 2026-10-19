/**
 * 导出弹窗（PRD §6.6.2-A：五格式导出 + E2 细化选项 + E4 整库备份）
 *
 * 流程：选范围/格式 →（高级选项）→ 主进程弹保存框 → exportStart（utilityProcess）
 *      → 订阅 event:export 进度 → done/error/cancelled 收口
 *
 * 数据源三形态（互斥，优先级从高到低）：
 *  - props.sql     —— B7 查询结果导出：编辑器已确认执行的自定义 SQL。危险确认由
 *                     App 的 onRunSql 体系负责，这里原样传给 worker，不重复守卫。
 *  - scope=database —— E4 整库备份（仅 sql/markdown，逐表 DDL + 数据 / 分节表格）。
 *  - 整表/筛选      —— 有筛选时重建 WHERE（所见即所导）。
 *
 * T40 范围口径（行从哪来，见 transfer/exportScope.ts）：
 *  - 选区 / 当前已加载 = **快照**（网格已有的行，不再查库）；
 *  - 全部匹配 / 整库   = **重查**（服务端再跑一次 SQL，NOW()/RAND() 与期间的数据
 *    变化都会进文件）。两种结果的差异必须写在选项说明里 —— 这是本弹窗的核心约束：
 *    用户点「导出」之前就该知道自己拿到的是快照还是重查结果。
 *  - 宿主没提供快照行（未选中 / 表未在网格打开 / 未上报可见列）时对应选项禁用，
 *    并给出中文原因，绝不偷偷降级成「重查」再声称是「当前结果」。
 *
 * options 的生效矩阵（worker 同口径）：
 *  - csv      ：delimiter / encoding / nullText / includeHeader 全部生效
 *  - markdown ：encoding / nullText / includeHeader 生效（分隔符固定为管道，不提供）
 *  - xlsx/json/sql：忽略 options（列名行是 Excel 结构必需 / JSON 自带键 / SQL 无表头概念）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { toOpenTableFilter, type FilterModel } from '@dbstudio/core-filter';
import {
  describeColumnScope,
  describeScopeOptions,
  resolveExport,
  type ExportScopeId,
  type ScopeFacts,
} from './exportScope';
import { IconCheck, IconGear, IconX } from '../ui/icons';


export type ExportFormat = 'xlsx' | 'csv' | 'json' | 'sql' | 'markdown';

const FORMAT_LABELS: Record<ExportFormat, string> = {
  xlsx: 'Excel (.xlsx)',
  csv: 'CSV (.csv)',
  json: 'JSON (.json)',
  sql: 'SQL (.sql)',
  markdown: 'Markdown (.md)',
};

/** E2 分隔符预设（自定义直接在输入框里改） */
const DELIMITER_PRESETS: { label: string; value: string }[] = [
  { label: '逗号 ,', value: ',' },
  { label: '分号 ;', value: ';' },
  { label: 'Tab', value: '\t' },
  { label: '竖线 |', value: '|' },
];

interface ExportMsg {
  type: 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  rowsWritten?: number;
  elapsedMs?: number;
  bytes?: number;
  message?: string;
  /** E4 整库进度扩展：当前表与表序号（单表导出不下发） */
  table?: string;
  tableIndex?: number;
  tableCount?: number;
}

export interface ExportModalProps {
  backend: Backend;
  connId: string;
  database: string;
  /**
   * 目标表元数据。B7 自定义 SQL 导出时可为 null（查询结果没有表上下文）——
   * 所有 table.* 访问都在非 hasSql 分支或已做兜底。
   */
  table: TableMeta | null;
  /** 当前筛选（导出所见即所导） */
  filter: FilterModel | null;
  /**
   * B7 查询结果导出：编辑器已确认执行的自定义 SQL（非空时导出该结果集，
   * 隐藏整库范围与筛选重建）。危险确认由 App 的 onRunSql 体系负责。
   */
  sql?: string | null;
  /** 自定义 SQL 的列定义（给 csv/xlsx 表头与 markdown 列名；缺省由 worker 从 fields 事件兜底） */
  columns?: { name: string; dataType: string }[] | null;
  /**
   * T40：网格选区快照（行数组，顺序对齐 columns）。不传 / null =
   * 当前视图没有选区快照 → 「选区」范围禁用并说明原因。
   */
  selectedRows?: readonly (readonly unknown[])[] | null;
  /** T40：网格当前已加载的结果快照。不传 / null = 没有已加载快照 → 「当前已加载」禁用 */
  loadedRows?: readonly (readonly unknown[])[] | null;
  /** T40：网格当前可见列名（显示顺序）。不传 / null = 网格未上报 → 「仅可见列」禁用 */
  visibleColumns?: readonly string[] | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export function ExportModal({
  backend,
  connId,
  database,
  table,
  filter,
  sql,
  columns,
  selectedRows,
  loadedRows,
  visibleColumns,
  onClose,
  onToast,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  // 默认「全部匹配」= 改造前的「当前表」口径（重查），老用户的操作路径不变
  const [scope, setScope] = useState<ExportScopeId>('matched');
  const [onlyVisibleColumns, setOnlyVisibleColumns] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [delimiter, setDelimiter] = useState<string>(',');
  const [encoding, setEncoding] = useState<'utf8' | 'utf8-bom'>('utf8');
  const [nullText, setNullText] = useState<string>('\\N');
  const [includeHeader, setIncludeHeader] = useState<boolean>(true);
  const [phase, setPhase] = useState<'pick' | 'running' | 'done' | 'error'>('pick');
  const [rows, setRows] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [tableProgress, setTableProgress] = useState<{ name: string; index: number; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const hasSql = Boolean(sql && sql.trim());
  const dbScope = scope === 'database';
  const isTextFormat = format === 'csv' || format === 'markdown';

  // 生效的 WHERE：只有「当前表 tab + 有筛选」才重建（树右键导出未打开的表没有筛选上下文）
  const where = table && filter ? toOpenTableFilter(filter)?.where ?? '' : '';
  const resultColumns = hasSql ? columns ?? [] : table?.columns ?? [];

  // T40：范围选项的可用性完全由宿主能力决定 —— 缺什么就禁用并说清原因
  const facts: ScopeFacts = {
    hasSql,
    hasTable: Boolean(table),
    filterActive: Boolean(where),
    selectionRowCount: selectedRows ? selectedRows.length : null,
    loadedRowCount: loadedRows ? loadedRows.length : null,
    visibleColumnCount: visibleColumns ? visibleColumns.length : null,
    columnCount: resultColumns.length,
  };
  const scopeOptions = describeScopeOptions(facts);
  const columnScope = describeColumnScope(facts, scope);
  // 开关不可用时，之前残留的勾选不作数（切到整库 / 自定义 SQL 时不能假装在裁列）
  const onlyVisible = onlyVisibleColumns && columnScope.enabled;

  // 订阅进度推送（挂载一次）
  useEffect(() => {
    const unsub = backend.onTransferEvent('export', (payload) => {
      const msg = payload as ExportMsg;
      if (!jobIdRef.current || msg.jobId !== jobIdRef.current) return;
      if (msg.type === 'progress') {
        setRows(msg.rowsWritten ?? 0);
        setElapsed(msg.elapsedMs ?? 0);
        setTableProgress(msg.table ? { name: msg.table, index: msg.tableIndex ?? 0, count: msg.tableCount ?? 0 } : null);
      } else if (msg.type === 'done') {
        setRows(msg.rowsWritten ?? 0);
        setElapsed(msg.elapsedMs ?? 0);
        setBytes(msg.bytes ?? 0);
        setPhase('done');
      } else if (msg.type === 'error') {
        setError(msg.message ?? '导出失败');
        setPhase('error');
      } else if (msg.type === 'cancelled') {
        setError('已取消');
        setPhase('error');
      }
    });
    unsubRef.current = unsub;
    return () => unsub();
  }, [backend]);

  /** E4：整库只允许 sql/markdown，其余格式禁用；从整库切回单表时恢复 */
  const pickScope = useCallback(
    (s: ExportScopeId) => {
      setScope(s);
      if (s === 'database' && format !== 'sql' && format !== 'markdown') setFormat('sql');
    },
    [format],
  );

  const pickFormat = useCallback(
    (f: ExportFormat) => {
      if (dbScope && f !== 'sql' && f !== 'markdown') return;
      setFormat(f);
    },
    [dbScope],
  );

  const start = useCallback(async () => {
    try {
      // 1. 先解析范围（行从哪来、导哪些列），再弹保存框 ——
      //    否则用户选完路径才被告知「这个范围导不了」。
      const resolved = resolveExport({
        scope,
        database,
        tableName: table?.name ?? null,
        where,
        querySql: hasSql ? sql : null,
        rows: scope === 'selection' ? selectedRows : scope === 'loaded' ? loadedRows : null,
        columns: resultColumns,
        visibleColumns,
        onlyVisibleColumns: onlyVisible,
      });

      // 🔴 快照不能交给 exportStart：worker 只认 SQL，会把「快照」偷偷变成重查。
      //    当前宿主（App）尚未把行交给后台导出进程，所以先明确失败而不是给错数据。
      if (resolved.source === 'snapshot') {
        setError('快照导出暂未接入导出进程，当前只能按「全部匹配」重查导出');
        setPhase('error');
        return;
      }

      // 2. 主进程弹保存框（demo 模式返回 null → 直接提示）。
      //    整库用库名做默认文件名；自定义 SQL 结果集用「查询结果」。
      const targetName = hasSql ? '查询结果' : dbScope ? database : table?.name ?? '导出';
      const path = await backend.exportPickPath(targetName, format);
      if (!path) {
        onToast('未选择保存位置，已取消导出');
        return;
      }

      setPhase('running');
      setRows(0);
      setElapsed(0);
      setTableProgress(null);
      setError(null);

      const r = await backend.exportStart({
        connId,
        format,
        outputPath: path,
        database,
        table: dbScope ? '*' : table?.name ?? '查询结果',
        sql: resolved.sql,
        // 列集合 = 计划里的输出列（仅可见列时已被裁过）；自定义 SQL 交给 worker 的 fields 兜底
        columns: hasSql ? columns ?? null : resolved.columns.map((c) => ({ name: c.name, dataType: c.dataType ?? '' })),
        scope: dbScope ? 'database' : 'table',
        options: { delimiter, encoding, nullText, includeHeader },
      });
      jobIdRef.current = r.jobId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [backend, connId, database, format, table, sql, columns, hasSql, dbScope, delimiter, encoding, nullText, includeHeader, scope, where, resultColumns, selectedRows, loadedRows, visibleColumns, onlyVisible, onToast]);

  const cancel = useCallback(async () => {
    if (jobIdRef.current) await backend.exportCancel(jobIdRef.current);
  }, [backend]);

  const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  // 标题里的导出对象（B7：自定义 SQL 时隐藏表名语义）
  const targetLabel = hasSql ? '查询结果（自定义 SQL）' : dbScope ? `${database}（整库）` : `${database}.${table?.name ?? ''}`;

  // 范围一句话总结：把「快照 / 重查」再落到当前选择上（选项说明之外的第二道明示）
  const scopeSummary =
    scope === 'selection'
      ? `只导出选中的 ${(facts.selectionRowCount ?? 0).toLocaleString()} 行（快照，不再查库）。`
      : scope === 'loaded'
        ? `只导出网格当前已加载的 ${(facts.loadedRowCount ?? 0).toLocaleString()} 行（快照，不再查库）。`
        : dbScope
          ? '整库备份：SQL 格式逐表写出建表语句 + 数据，Markdown 每表一个分节（重查，不是快照）。'
          : hasSql
            ? '将重新执行上面这条 SQL 导出全部结果行（重查，不是屏幕上这份结果的快照）。'
            : `将${where ? '按当前筛选条件' : ''}重新查询整表导出全部命中行（重查，不是只导当前已加载的一页）。`;

  return (
    <div className="modal-mask" onClick={phase === 'running' ? undefined : onClose}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()} data-testid="export-modal">
        <header>导出 — {targetLabel}</header>
        <div className="body">
          {phase === 'pick' ? (
            <>
              {/* T40 行范围：四个选项同口径，说明里写清快照还是重查 */}
              <div className="export-formats xf-scope" role="radiogroup" aria-label="导出范围" style={{ gridTemplateColumns: '1fr' }}>
                {scopeOptions.map((opt) => (
                  <label
                    key={opt.id}
                    className={`export-format${scope === opt.id ? ' active' : ''}`}
                    style={{
                      alignItems: 'flex-start',
                      cursor: opt.enabled ? 'pointer' : 'not-allowed',
                      // 禁用项仍要读得清原因：.xf-format-off 的 0.4 太淡，这里单独给 0.6
                      opacity: opt.enabled ? 1 : 0.6,
                    }}
                    title={opt.enabled ? opt.hint : opt.disabledReason ?? ''}
                  >
                    <input
                      type="radio"
                      name="export-scope"
                      checked={scope === opt.id}
                      onChange={() => pickScope(opt.id)}
                      disabled={!opt.enabled}
                      data-testid={`export-scope-${opt.id}`}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span>{opt.label}</span>
                      <span className="export-hint" style={{ margin: 0 }} data-testid={`export-scope-hint-${opt.id}`}>
                        {opt.enabled ? opt.hint : opt.disabledReason}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {/* T40 列范围：与网格当前可见列一致；不可用时禁用 + 原因 */}
              {dbScope ? null : (
                <div className="xf-field" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
                  <span className="xf-field-label">列范围</span>
                  <div>
                    <label className="ce-check" style={{ paddingLeft: 0, margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={onlyVisible}
                        onChange={(e) => setOnlyVisibleColumns(e.target.checked)}
                        disabled={!columnScope.enabled}
                        data-testid="export-only-visible-columns"
                      />
                      仅导出可见列{columnScope.enabled ? `（${columnScope.visible}/${columnScope.total}）` : ''}
                    </label>
                    {columnScope.enabled ? null : (
                      <p className="export-hint" style={{ margin: '2px 0 0' }} data-testid="export-only-visible-columns-reason">
                        {columnScope.reason}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="export-formats" role="radiogroup" aria-label="导出格式">
                {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => {
                  const disabled = dbScope && f !== 'sql' && f !== 'markdown';
                  return (
                    <label key={f} className={`export-format${format === f ? ' active' : ''}${disabled ? ' xf-format-off' : ''}`}>
                      <input
                        type="radio"
                        name="export-format"
                        value={f}
                        checked={format === f}
                        onChange={() => pickFormat(f)}
                        disabled={disabled}
                        data-testid={`export-format-${f}`}
                      />
                      {FORMAT_LABELS[f]}
                    </label>
                  );
                })}
              </div>
              <p className="export-hint" data-testid="export-scope-summary">
                {scopeSummary} 大表导出在后台进程执行，不阻塞界面；可随时取消。
              </p>
              {isTextFormat ? (
                <div className="xf-adv">
                  <button type="button" className="xf-adv-head" onClick={() => setAdvOpen((v) => !v)} data-testid="export-adv-toggle">
                    <IconGear /> 高级选项
                  </button>
                  {advOpen ? (
                    <div className="xf-adv-body">
                      {format === 'csv' ? (
                        <div className="xf-field">
                          <span className="xf-field-label">分隔符</span>
                          <div className="xf-seg" role="radiogroup" aria-label="分隔符预设">
                            {DELIMITER_PRESETS.map((p) => (
                              <button
                                key={p.value}
                                type="button"
                                className={`xf-chip${delimiter === p.value ? ' active' : ''}`}
                                onClick={() => setDelimiter(p.value)}
                              >
                                {p.label}
                              </button>
                            ))}
                            <input
                              className="xf-input"
                              value={delimiter}
                              maxLength={4}
                              onChange={(e) => setDelimiter(e.target.value)}
                              placeholder="自定义"
                              title="自定义分隔符（1~4 个字符）"
                              aria-label="自定义分隔符"
                            />
                          </div>
                        </div>
                      ) : null}
                      <div className="xf-field">
                        <span className="xf-field-label">编码</span>
                        <div className="xf-seg" role="radiogroup" aria-label="导出编码">
                          <button
                            type="button"
                            className={`xf-chip${encoding === 'utf8' ? ' active' : ''}`}
                            onClick={() => setEncoding('utf8')}
                          >
                            UTF-8
                          </button>
                          <button
                            type="button"
                            className={`xf-chip${encoding === 'utf8-bom' ? ' active' : ''}`}
                            onClick={() => setEncoding('utf8-bom')}
                            title="文件头写入 BOM，Excel 直接打开 CSV 不乱码"
                          >
                            UTF-8 BOM
                          </button>
                        </div>
                      </div>
                      <div className="xf-field">
                        <span className="xf-field-label">NULL 文本</span>
                        <input
                          className="xf-input"
                          value={nullText}
                          onChange={(e) => setNullText(e.target.value)}
                          placeholder="\N"
                          title="NULL 值在文件中的文本表示"
                          aria-label="NULL 文本"
                        />
                      </div>
                      <div className="xf-field">
                        <span className="xf-field-label">表头</span>
                        <label className="ce-check">
                          <input
                            type="checkbox"
                            checked={includeHeader}
                            onChange={(e) => setIncludeHeader(e.target.checked)}
                            data-testid="export-include-header"
                          />
                          包含表头行
                        </label>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : phase === 'running' ? (
            <div className="export-progress" data-testid="export-progress">
              <div className="export-stat">
                已导出 {rows.toLocaleString()} 行
                {tableProgress ? ` · ${tableProgress.name}（${tableProgress.index}/${tableProgress.count}）` : ''} ·{' '}
                {(elapsed / 1000).toFixed(1)}s
              </div>
              <div className="export-bar">
                <div className="export-bar-fill indeterminate" />
              </div>
            </div>
          ) : phase === 'done' ? (
            <div className="export-done" data-testid="export-done">
              <p><IconCheck /> 导出完成</p>
              <p>
                共 {rows.toLocaleString()} 行 · {(elapsed / 1000).toFixed(1)}s · {fmtBytes(bytes)}
              </p>
            </div>
          ) : (
            <div className="export-error" data-testid="export-error">
              <p><IconX /> {error}</p>
            </div>
          )}
        </div>
        <footer>
          {phase === 'pick' ? (
            <>
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={() => void start()} data-testid="export-start">
                选择位置并导出
              </button>
            </>
          ) : phase === 'running' ? (
            <button onClick={() => void cancel()} data-testid="export-cancel">
              取消导出
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              关闭
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
