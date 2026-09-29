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
 * options 的生效矩阵（worker 同口径）：
 *  - csv      ：delimiter / encoding / nullText / includeHeader 全部生效
 *  - markdown ：encoding / nullText / includeHeader 生效（分隔符固定为管道，不提供）
 *  - xlsx/json/sql：忽略 options（列名行是 Excel 结构必需 / JSON 自带键 / SQL 无表头概念）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import { toOpenTableFilter, type FilterModel } from '@dbstudio/core-filter';
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
  onClose,
  onToast,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [scope, setScope] = useState<'table' | 'database'>('table');
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
  const dbScope = !hasSql && scope === 'database';
  // E2：细化选项只对文本格式有意义（xlsx/json/sql 忽略，见文件头矩阵）
  const isTextFormat = format === 'csv' || format === 'markdown';

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
    (s: 'table' | 'database') => {
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
      // 1. 主进程弹保存框（demo 模式返回 null → 直接提示）。
      //    整库用库名做默认文件名；自定义 SQL 结果集用「查询结果」。
      const targetName = hasSql ? '查询结果' : dbScope ? database : table?.name ?? '导出';
      const path = await backend.exportPickPath(targetName, format);
      if (!path) {
        onToast('未选择保存位置，已取消导出');
        return;
      }

      // 2. 数据源：自定义 SQL 原样导出（B7，信任边界见文件头注释）；
      //    整库忽略筛选；单表按筛选重建 WHERE（所见即所导）
      let exportSql: string | null = null;
      if (hasSql) {
        exportSql = sql!.trim();
      } else if (!dbScope && filter && table) {
        const built = toOpenTableFilter(filter);
        const where = built?.where?.trim();
        if (where) exportSql = `SELECT * FROM \`${database}\`.\`${table.name}\` WHERE ${where}`;
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
        sql: exportSql,
        columns: hasSql ? (columns ?? null) : dbScope ? null : (table?.columns ?? []).map((c) => ({ name: c.name, dataType: c.dataType })),
        scope: dbScope ? 'database' : 'table',
        options: { delimiter, encoding, nullText, includeHeader },
      });
      jobIdRef.current = r.jobId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [backend, connId, database, format, filter, onToast, table, sql, columns, hasSql, dbScope, delimiter, encoding, nullText, includeHeader]);

  const cancel = useCallback(async () => {
    if (jobIdRef.current) await backend.exportCancel(jobIdRef.current);
  }, [backend]);

  const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  // 标题里的导出对象（B7：自定义 SQL 时隐藏表名语义）
  const targetLabel = hasSql ? '查询结果（自定义 SQL）' : dbScope ? `${database}（整库）` : `${database}.${table?.name ?? ''}`;

  return (
    <div className="modal-mask" onClick={phase === 'running' ? undefined : onClose}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()} data-testid="export-modal">
        <header>导出 — {targetLabel}</header>
        <div className="body">
          {phase === 'pick' ? (
            <>
              {/* E4 范围：自定义 SQL 导出是单结果集，没有范围概念 */}
              {!hasSql ? (
                <div className="export-formats xf-scope" role="radiogroup" aria-label="导出范围">
                  <label className={`export-format${scope === 'table' ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="export-scope"
                      checked={scope === 'table'}
                      onChange={() => pickScope('table')}
                      data-testid="export-scope-table"
                    />
                    当前表
                  </label>
                  <label className={`export-format${scope === 'database' ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="export-scope"
                      checked={scope === 'database'}
                      onChange={() => pickScope('database')}
                      data-testid="export-scope-database"
                    />
                    整库
                  </label>
                </div>
              ) : null}
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
              <p className="export-hint">
                {hasSql ? (
                  <>导出该查询的全部结果行（列定义来自结果集）。 </>
                ) : dbScope ? (
                  <>整库备份：SQL 格式逐表写出建表语句 + 数据，Markdown 每表一个分节。 </>
                ) : (
                  <>导出整表数据{filter && toOpenTableFilter(filter)?.where ? '（含当前筛选条件）' : ''}。 </>
                )}
                大表导出在后台进程执行，不阻塞界面；可随时取消。
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
