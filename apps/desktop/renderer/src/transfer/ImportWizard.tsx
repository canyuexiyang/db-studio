/**
 * 导入向导（D3：仅追加 INSERT，4 步，PRD §6.6.2-B；E3 支持 JSON；E5 失败行重试）
 *
 * Step 1 选文件 —— 主进程弹打开框 → importPeek 取前 50 行 + 分隔符探测
 *                 （json：首行是「键序伪表头」，拆出来当映射左列）
 * Step 2 列映射 —— 自动猜测（core-import guessMapping）+ 手工下拉调整；
 *                  首行是否表头可切换（json 无表头概念，隐藏该开关）
 * Step 3 预览校验 —— 用本地前 50 行跑 validateCellText 预演，展示错误行
 * Step 4 执行 —— importStart（utilityProcess）→ 订阅 event:import 进度
 *                完成后若有失败行，可只对失败行重跑（retryRows）
 *
 * 边界：
 *  - 只读连接在入口就拒绝（主进程还会再兜一次）
 *  - 校验失败的行不导入（不部分写入），done 后展示错误行数与明细
 *  - 取消 = kill worker（真取消）；已插入的批次不回滚（D3 语义，UI 提示）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from '../backend';
import type { TableMeta, ColumnMeta } from '@dbstudio/core-schema-cache';
import { guessMapping, validatePreview } from '@dbstudio/core-import';
import { IconAlert, IconCheck, IconX } from '../ui/icons';


export interface ImportWizardProps {
  backend: Backend;
  connId: string;
  database: string;
  table: TableMeta;
  onClose: () => void;
  onToast: (msg: string) => void;
  /** 导入完成后刷新网格（重新拉表数据） */
  onImported: () => void;
}

interface ImportMsg {
  type: 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  rowsRead?: number;
  rowsDone?: number;
  elapsedMs?: number;
  batches?: number;
  invalidRows?: number;
  invalidDetail?: { fileRow: number; column: string; reason: string }[];
  totalRows?: number;
  message?: string;
  rowsWritten?: number;
}

type ImportFileFormat = 'csv' | 'tsv' | 'xlsx' | 'json';

export function ImportWizard({ backend, connId, database, table, onClose, onToast, onImported }: ImportWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileFormat, setFileFormat] = useState<ImportFileFormat>('csv');
  const [delimiter, setDelimiter] = useState<string>(',');
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  /** E3：json 的键序（映射左列）。peek 的首行伪表头拆出来放这里，不占数据行 */
  const [jsonKeys, setJsonKeys] = useState<string[]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState({ rowsDone: 0, rowsRead: 0, elapsedMs: 0 });
  const [result, setResult] = useState<{
    rowsDone: number;
    invalidRows: number;
    invalidDetail: { fileRow: number; column: string; reason: string }[];
    totalRows: number;
    elapsedMs: number;
  } | null>(null);
  /** E5：本次执行是否是失败行重跑（结果页展示口径） */
  const [retryCount, setRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // 订阅导入进度
  useEffect(() => {
    const unsub = backend.onTransferEvent('import', (payload) => {
      const msg = payload as ImportMsg;
      if (!jobIdRef.current || msg.jobId !== jobIdRef.current) return;
      if (msg.type === 'progress') {
        setProgress({ rowsDone: msg.rowsDone ?? 0, rowsRead: msg.rowsRead ?? 0, elapsedMs: msg.elapsedMs ?? 0 });
      } else if (msg.type === 'done') {
        setResult({
          rowsDone: msg.rowsDone ?? 0,
          invalidRows: msg.invalidRows ?? 0,
          invalidDetail: msg.invalidDetail ?? [],
          totalRows: msg.totalRows ?? 0,
          elapsedMs: msg.elapsedMs ?? 0,
        });
        setPhase('done');
        onImported();
      } else if (msg.type === 'error') {
        setError(msg.message ?? '导入失败');
        setPhase('error');
      } else if (msg.type === 'cancelled') {
        setError('已取消');
        setPhase('error');
      }
    });
    return unsub;
  }, [backend, onImported]);

  // ---------- Step 1：选文件 ----------
  const pickFile = useCallback(async () => {
    try {
      const path = await backend.importPickPath();
      if (!path) return; // 用户取消
      const peek = await backend.importPeek(path, 50);
      // 运行时主进程可能返回 'json'（backend.ts 的渲染侧类型是既有窄化，这里拓宽）
      const fmt = peek.format as ImportFileFormat;
      setFilePath(path);
      setFileFormat(fmt);
      setDelimiter(peek.delimiter);
      if (fmt === 'json') {
        // peek 首行 = 键序伪表头：拆出来当映射左列，数据行从 0 重编号
        //（与 worker 的 fileRow 口径一致：json 永远无表头）
        const keys = peek.rows[0] ?? [];
        setJsonKeys(keys);
        setPreviewRows(peek.rows.slice(1));
        setHasHeader(false);
        const suggestion = guessMapping(keys, table.columns);
        setMapping(suggestion.mapping);
        setNotes(suggestion.notes);
      } else {
        setJsonKeys([]);
        setPreviewRows(peek.rows);
        // 自动猜测列映射
        const headers = peek.rows[0] ?? [];
        const suggestion = guessMapping(headers, table.columns);
        setMapping(suggestion.mapping);
        setNotes(suggestion.notes);
        setHasHeader(true);
      }
      setRetryCount(0);
      setStep(2);
    } catch (e) {
      onToast(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [backend, table, onToast]);

  // ---------- Step 2：列映射 ----------
  const fileHeaders = useMemo(() => {
    if (fileFormat === 'json') return jsonKeys;
    if (previewRows.length === 0) return [];
    if (!hasHeader) return previewRows[0].map((_, i) => `列 ${i + 1}`);
    return previewRows[0];
  }, [fileFormat, jsonKeys, previewRows, hasHeader]);

  const changeMapping = useCallback((fileIdx: number, value: string | null) => {
    setMapping((prev) => {
      const next = [...prev];
      // 互斥：同一表列只能被一个文件列占用
      if (value !== null) {
        for (let i = 0; i < next.length; i++) {
          if (i !== fileIdx && next[i] === value) next[i] = null;
        }
      }
      next[fileIdx] = value;
      return next;
    });
  }, []);

  const remap = useCallback(() => {
    const suggestion = guessMapping(fileHeaders, table.columns);
    setMapping(suggestion.mapping);
    setNotes(suggestion.notes);
  }, [fileHeaders, table]);

  // ---------- Step 3：预览校验（本地前 50 行跑 validateCellText） ----------
  type PreviewIssue = { fileRow: number; column: string; reason: string };
  // json 没有伪表头要跳（pickFile 已把数据行拆出来），强制按无表头校验
  const previewHeader = fileFormat === 'json' ? false : hasHeader;
  const previewIssues = useMemo(() => {
    if (previewRows.length === 0) return { issues: [] as PreviewIssue[] };
    return validatePreview(previewRows, mapping, table.columns, previewHeader);
  }, [previewRows, mapping, table, previewHeader]);

  const mappedCount = mapping.filter((m) => m !== null).length;

  // ---------- Step 4：执行 ----------
  const startImport = useCallback(
    async (retryRows?: number[]) => {
      if (!filePath) return;
      try {
        setPhase('running');
        setError(null);
        setProgress({ rowsDone: 0, rowsRead: 0, elapsedMs: 0 });
        setRetryCount(retryRows?.length ?? 0);
        const r = await backend.importStart({
          connId,
          filePath,
          format: fileFormat,
          delimiter: fileFormat === 'csv' ? delimiter : null,
          // json 强制无表头（worker 侧同口径兜底，这里传值只为请求类型完整）
          hasHeader: fileFormat === 'json' ? false : hasHeader,
          database,
          table: table.name,
          mapping,
          columns: table.columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            autoIncrement: c.autoIncrement,
          })),
          retryRows: retryRows && retryRows.length > 0 ? retryRows : null,
        });
        jobIdRef.current = r.jobId;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    },
    [backend, connId, database, delimiter, fileFormat, filePath, hasHeader, mapping, table],
  );

  const cancelImport = useCallback(async () => {
    if (jobIdRef.current) await backend.importCancel(jobIdRef.current);
  }, [backend]);

  // ---------- E5：失败行 → retryRows（0 基数据行号） ----------
  // 行号口径换算（与 import-worker 头注释一致）：
  //   invalidDetail.fileRow = (有表头 ? 1 : 0) + 数据行 0 基下标 + 1
  //   → retryIndex = fileRow - (有表头 ? 1 : 0) - 1；json 永远无表头，只差 1
  const retryRows = useMemo(() => {
    if (!result || result.invalidDetail.length === 0) return [];
    const offset = (fileFormat === 'json' ? 0 : hasHeader ? 1 : 0) + 1;
    return result.invalidDetail.map((d) => d.fileRow - offset).filter((n) => n >= 0);
  }, [result, fileFormat, hasHeader]);

  // ---------- 渲染 ----------
  const steps = ['选择文件', '列映射', '预览校验', '执行'];
  const mappingLeftLabel = fileFormat === 'json' ? '对象键' : '文件列';

  return (
    <div className="modal-mask" onClick={phase === 'running' ? undefined : onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()} data-testid="import-modal">
        <header>
          导入 — {database}.{table.name}
          <div className="wizard-steps" data-testid="wizard-steps">
            {steps.map((s, i) => (
              <span key={s} className={`wizard-step${step === i + 1 ? ' active' : step > i + 1 ? ' done' : ''}`}>
                {i + 1}. {s}
              </span>
            ))}
          </div>
        </header>

        <div className="body">
          {/* Step 1 */}
          {step === 1 ? (
            <div className="import-step1">
              <p className="export-hint">
                支持 CSV / TSV / Excel (.xlsx) / JSON（对象数组）。导入模式为<b>追加 INSERT</b>：
                只新增行，不修改或删除已有数据。错误行不会写入，导入完成后可查看明细并重试。
              </p>
              <button className="primary" onClick={() => void pickFile()} data-testid="import-pick-file">
                选择文件…
              </button>
            </div>
          ) : null}

          {/* Step 2 */}
          {step === 2 ? (
            <div className="import-step2">
              <div className="import-file-info">
                <span title={filePath ?? ''}>{filePath?.split('/').pop()}</span>
                <span className="spacer" />
                {/* json 无表头概念（键序伪表头已在 pickFile 拆出），隐藏该开关 */}
                {fileFormat !== 'json' ? (
                  <label className="ce-check">
                    <input
                      type="checkbox"
                      checked={hasHeader}
                      onChange={(e) => setHasHeader(e.target.checked)}
                      data-testid="import-has-header"
                    />
                    首行是表头
                  </label>
                ) : null}
                <button onClick={remap}>重新自动映射</button>
              </div>
              <table className="import-mapping-table" data-testid="import-mapping">
                <thead>
                  <tr>
                    <th>{mappingLeftLabel}</th>
                    <th>导入到表列</th>
                  </tr>
                </thead>
                <tbody>
                  {fileHeaders.map((h, i) => (
                    <tr key={i}>
                      <td>{h || `列 ${i + 1}`}</td>
                      <td>
                        <select value={mapping[i] ?? ''} onChange={(e) => changeMapping(i, e.target.value || null)}>
                          <option value="">（跳过）</option>
                          {table.columns.map((c: ColumnMeta) => (
                            <option key={c.name} value={c.name}>
                              {c.name}（{c.dataType}）
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {notes.length > 0 ? (
                <ul className="import-notes">
                  {notes.slice(0, 5).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* Step 3 */}
          {step === 3 ? (
            <div className="import-step3">
              <p className="export-hint">
                前 {Math.max(0, previewRows.length - (previewHeader ? 1 : 0))} 行预演校验：
                {previewIssues.issues.length === 0 ? (
                  <b className="ok">全部通过</b>
                ) : (
                  <b className="bad">{previewIssues.issues.length} 处问题（这些行不会导入）</b>
                )}
              </p>
              <div className="import-preview-grid" data-testid="import-preview">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      {fileHeaders.map((h, i) => (
                        <th key={i}>{mapping[i] ? fileHeaders[i] : <span className="skipped">{h}（跳过）</span>}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(previewHeader ? 1 : 0, previewHeader ? 9 : 8).map((row, ri) => {
                      const rowIssues = previewIssues.issues.filter((x) => x.fileRow === (previewHeader ? 1 : 0) + ri + 1);
                      return (
                        <tr key={ri} className={rowIssues.length > 0 ? 'has-error' : ''}>
                          <td className="row-no">{(previewHeader ? 1 : 0) + ri + 1}</td>
                          {fileHeaders.map((_, ci) => (
                            <td key={ci} title={rowIssues.find((x) => x.column === mapping[ci])?.reason}>
                              {row[ci] ?? ''}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {previewIssues.issues.length > 0 ? (
                <ul className="import-notes">
                  {previewIssues.issues.slice(0, 5).map((x, i) => (
                    <li key={i} className="bad">
                      第 {x.fileRow} 行 · {x.column}：{x.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* Step 4 */}
          {step === 4 ? (
            <div className="import-step4">
              {phase === 'idle' ? (
                <p className="export-hint">
                  即将向 {database}.{table.name} 追加导入（已映射 {mappedCount} 列）。
                  <b className="bad">已插入的行不会因中途取消而回滚</b> —— 若需重来请先清理本次导入的行。
                </p>
              ) : phase === 'running' ? (
                <div className="export-progress" data-testid="import-progress">
                  <div className="export-stat">
                    已插入 {progress.rowsDone.toLocaleString()} 行
                    {progress.rowsRead > 0 ? ` / 共 ${progress.rowsRead.toLocaleString()} 行` : ''} ·{' '}
                    {(progress.elapsedMs / 1000).toFixed(1)}s
                  </div>
                  <div className="export-bar">
                    <div
                      className="export-bar-fill"
                      style={
                        progress.rowsRead > 0
                          ? { width: `${Math.min(100, (progress.rowsDone / progress.rowsRead) * 100)}%` }
                          : undefined
                      }
                    />
                  </div>
                </div>
              ) : phase === 'done' && result ? (
                <div className="export-done" data-testid="import-done">
                  {result.rowsDone > 0 ? (
                    <p>
                      <IconCheck /> 已插入 {result.rowsDone.toLocaleString()} 行（{(result.elapsedMs / 1000).toFixed(1)}s）
                      {retryCount > 0 ? ` · 重跑 ${retryCount} 行` : ''}
                    </p>
                  ) : null}
                  {result.invalidRows > 0 ? (
                    <div>
                      <p className="bad"><IconAlert /> {result.invalidRows} 行校验未通过，未导入：</p>
                      <ul className="import-notes">
                        {result.invalidDetail.slice(0, 8).map((x, i) => (
                          <li key={i} className="bad">
                            第 {x.fileRow} 行 · {x.column}：{x.reason}
                          </li>
                        ))}
                      </ul>
                      {retryRows.length > 0 ? (
                        <button
                          className="xf-retry"
                          onClick={() => void startImport(retryRows)}
                          data-testid="import-retry"
                          title="只重新导入这些失败行（其余行不再处理）"
                        >
                          重试失败行（{retryRows.length}）
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="export-error" data-testid="import-error">
                  <p><IconX /> {error}</p>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <footer>
          {step === 1 ? <button onClick={onClose}>取消</button> : null}
          {step === 2 ? (
            <>
              <button onClick={onClose}>取消</button>
              <button className="primary" disabled={mappedCount === 0} onClick={() => setStep(3)} data-testid="import-next-3">
                下一步
              </button>
            </>
          ) : null}
          {step === 3 ? (
            <>
              <button onClick={() => setStep(2)}>上一步</button>
              <button
                className="primary"
                disabled={previewIssues.issues.length > 0 && previewIssues.issues.length === previewRows.length - (previewHeader ? 1 : 0)}
                onClick={() => setStep(4)}
                data-testid="import-next-4"
              >
                下一步
              </button>
            </>
          ) : null}
          {step === 4 ? (
            phase === 'running' ? (
              <button onClick={() => void cancelImport()} data-testid="import-cancel">
                取消导入
              </button>
            ) : phase === 'idle' ? (
              <>
                <button onClick={() => setStep(3)}>上一步</button>
                <button className="primary" onClick={() => void startImport()} data-testid="import-confirm">
                  开始导入
                </button>
              </>
            ) : (
              <button className="primary" onClick={onClose}>
                关闭
              </button>
            )
          ) : null}
        </footer>
      </div>
    </div>
  );
}
