/**
 * 运行 SQL 脚本（库/表级别导入脚本 —— mysqldump / Navicat「运行 SQL 文件」同款）
 *
 * 用户场景：删掉库下所有表后，导入一份包含「建表 + 数据」的完整 .sql 脚本。
 *
 * 流程（与导入向导同族，执行跑在 utilityProcess，取消 = kill 真取消）：
 *  1. 选文件 + 选项（编码 / 遇错策略）→ scriptStart
 *  2. worker 先【扫描】（不执行）：语句数、DDL/DML 分布、DROP DATABASE 检出
 *  3. 摘要确认页：普通连接二次确认；生产连接 / 检出 DROP DATABASE 走第三层
 *     （confirmDanger 输库名）—— 「写操作先展示」红线在脚本场景的落地形态
 *  4. scriptConfirm 放行 → 流式逐条执行 → 进度 → 结果报告
 *
 * 边界：
 *  - 只读连接在入口就拒绝（主进程还会再兜一次）
 *  - 中途取消 / 失败时已执行语句不回滚（D3 语义，UI 明确提示）
 *  - 关闭弹窗即取消未完成任务（scanning/confirm 阶段 worker 在等确认，必须清掉）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend';
import type { ScriptScanStats, ScriptErrorDetail } from '@dbstudio/shared-ipc';
import { IconAlert, IconCheck, IconX } from '../ui/icons';
import type { DangerConfirmRequest } from '../danger/DangerConfirmModal';

export interface SqlScriptModalProps {
  backend: Backend;
  connId: string;
  /** 脚本执行的默认库上下文（树节点所在库） */
  database: string;
  /** 生产环境（红色标签）→ 摘要确认升第三层（输库名） */
  isProduction: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
  /** 完成（或中止）后刷新 schema —— 树要跟上脚本建出来的新表 */
  onFinished: () => void;
  confirmDanger: (req: DangerConfirmRequest) => Promise<boolean>;
}

interface ScriptMsg {
  type: 'scan' | 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  stats?: ScriptScanStats;
  executed?: number;
  total?: number;
  elapsedMs?: number;
  currentSql?: string | null;
  failed?: number;
  errors?: ScriptErrorDetail[];
  aborted?: boolean;
  lastError?: string | null;
  message?: string;
}

type Stage = 'pick' | 'scanning' | 'confirm' | 'running' | 'done' | 'error';

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function SqlScriptModal({
  backend,
  connId,
  database,
  isProduction,
  onClose,
  onToast,
  onFinished,
  confirmDanger,
}: SqlScriptModalProps) {
  const [stage, setStage] = useState<Stage>('pick');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<'utf8' | 'gbk'>('utf8');
  const [onError, setOnError] = useState<'stop' | 'continue'>('stop');
  const [stats, setStats] = useState<ScriptScanStats | null>(null);
  const [progress, setProgress] = useState({ executed: 0, total: 0, elapsedMs: 0 });
  const [result, setResult] = useState<{ executed: number; failed: number; elapsedMs: number; errors: ScriptErrorDetail[]; aborted: boolean; lastError: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  /** done 时是否已经触发过 onFinished（刷新只做一次） */
  const finishedRef = useRef(false);

  // 订阅脚本事件（scan/progress/done/error）
  useEffect(() => {
    const unsub = backend.onTransferEvent('script', (payload) => {
      const msg = payload as ScriptMsg;
      if (!jobIdRef.current || msg.jobId !== jobIdRef.current) return;
      if (msg.type === 'scan') {
        setStats(msg.stats ?? null);
        setStage('confirm');
      } else if (msg.type === 'progress') {
        setProgress({ executed: msg.executed ?? 0, total: msg.total ?? 0, elapsedMs: msg.elapsedMs ?? 0 });
      } else if (msg.type === 'done') {
        setResult({
          executed: msg.executed ?? 0,
          failed: msg.failed ?? 0,
          elapsedMs: msg.elapsedMs ?? 0,
          errors: msg.errors ?? [],
          aborted: !!msg.aborted,
          lastError: msg.lastError ?? null,
        });
        setStage('done');
      } else if (msg.type === 'error') {
        setError(msg.message ?? '脚本执行失败');
        setStage('error');
      } else if (msg.type === 'cancelled') {
        setError('已取消');
        setStage('error');
      }
    });
    return unsub;
  }, [backend]);

  /** 关闭：未完结的任务必须清掉 worker（scanning/confirm 阶段它还在等确认） */
  const requestClose = useCallback(() => {
    const jobId = jobIdRef.current;
    if (jobId && (stage === 'scanning' || stage === 'confirm' || stage === 'running')) {
      void backend.scriptCancel(jobId);
    }
    if ((stage === 'done' || stage === 'error') && !finishedRef.current && result && result.executed > 0) {
      finishedRef.current = true;
      onFinished();
    }
    onClose();
  }, [backend, stage, result, onFinished, onClose]);

  // ---------- 选文件并开始扫描 ----------
  const pickAndStart = useCallback(async () => {
    let path: string | null = null;
    try {
      path = await backend.scriptPickPath();
    } catch (e) {
      onToast(`选择文件失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!path) return; // 用户取消
    setFilePath(path);
    setStage('scanning');
    try {
      const r = await backend.scriptStart({ connId, filePath: path, database, encoding, onError });
      jobIdRef.current = r.jobId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }, [backend, connId, database, encoding, onError, onToast]);

  // ---------- 摘要确认 → 放行执行 ----------
  const confirmExecute = useCallback(async () => {
    if (!stats || !jobIdRef.current) return;
    const needThird = isProduction || stats.hasDropDatabase;
    if (needThird) {
      const ok = await confirmDanger({
        title: stats.hasDropDatabase ? '脚本包含 DROP DATABASE' : '生产环境执行脚本',
        statements: [
          `-- 目标库：${database}`,
          `-- 语句总数：${stats.statements.toLocaleString()}（DDL ${stats.ddl} · DML ${stats.dml} · 其他 ${stats.session + stats.other}）`,
          '-- 执行的是所选脚本文件的原文语句（详见文件内容）',
        ],
        reason: stats.hasDropDatabase
          ? '脚本中检出 DROP DATABASE/SCHEMA：将删除整个数据库，无法自动恢复'
          : '脚本将对生产库执行建表/写入等写操作',
        requireText: database,
      });
      if (!ok) {
        onToast('已取消执行');
        return;
      }
    }
    setProgress({ executed: 0, total: stats.statements, elapsedMs: 0 });
    setStage('running');
    await backend.scriptConfirm(jobIdRef.current);
  }, [backend, stats, isProduction, confirmDanger, database, onToast]);

  /** 完成/中止后的收尾：刷新 schema（只触发一次） */
  const finishAndClose = useCallback(() => {
    if (!finishedRef.current) {
      finishedRef.current = true;
      onFinished();
    }
    onClose();
  }, [onFinished, onClose]);

  // ---------- 渲染 ----------

  return (
    <div className="modal-mask" onClick={stage === 'running' ? undefined : requestClose}>
      <div className="modal script-modal" onClick={(e) => e.stopPropagation()} data-testid="script-modal">
        <header>
          运行 SQL 脚本 — {database}
        </header>

        <div className="body">
          {stage === 'pick' ? (
            <div className="script-pick">
              <p className="export-hint">
                将所选 <b>.sql</b> 脚本逐条执行到库 <b>{database}</b>（mysqldump / 建表 + 数据脚本同款链路）。
                执行前会先扫描出语句摘要供确认。<b className="bad">已执行的语句不会因中途取消而回滚。</b>
              </p>
              <div className="script-options">
                <label className="script-opt">
                  <span>文件编码</span>
                  <select value={encoding} onChange={(e) => setEncoding(e.target.value as 'utf8' | 'gbk')}>
                    <option value="utf8">UTF-8</option>
                    <option value="gbk">GBK（国内旧导出常见）</option>
                  </select>
                </label>
                <label className="script-opt">
                  <span>遇到错误</span>
                  <select value={onError} onChange={(e) => setOnError(e.target.value as 'stop' | 'continue')}>
                    <option value="stop">停止执行</option>
                    <option value="continue">继续执行剩余语句</option>
                  </select>
                </label>
              </div>
              <button className="primary" onClick={() => void pickAndStart()} data-testid="script-pick-file">
                选择脚本文件…
              </button>
            </div>
          ) : null}

          {stage === 'scanning' ? (
            <div className="script-scanning">
              <p className="export-hint">
                正在扫描 {filePath?.split('/').pop()} …（大文件扫描需要几秒）
              </p>
            </div>
          ) : null}

          {stage === 'confirm' && stats ? (
            <div className="script-confirm" data-testid="script-confirm">
              <p className="export-hint">
                <span title={filePath ?? ''}>{filePath?.split('/').pop()}</span> · {fmtBytes(stats.fileBytes)}
              </p>
              <table className="script-stats" data-testid="script-stats">
                <tbody>
                  <tr>
                    <th>语句总数</th>
                    <td>{stats.statements.toLocaleString()}</td>
                    <th>建表/结构（DDL）</th>
                    <td>{stats.ddl.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <th>写入/修改（DML）</th>
                    <td>{stats.dml.toLocaleString()}</td>
                    <th>会话/其他</th>
                    <td>{(stats.session + stats.other).toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
              {stats.hasDelimiter ? (
                <div className="ce-note">脚本含 DELIMITER 指令（存储过程/触发器），将按 mysql 客户端语义处理。</div>
              ) : null}
              {stats.hasDropDatabase ? (
                <div className="ce-note warn">
                  <IconAlert /> 检出 DROP DATABASE/SCHEMA 语句 —— 确认后将要求输入库名。
                </div>
              ) : null}
              <p className="export-hint">
                目标库 <b>{database}</b>。脚本按文件原文逐条执行，
                <b className="bad">不回滚、不撤消</b>；请确认这是预期要导入的脚本。
              </p>
            </div>
          ) : null}

          {stage === 'running' ? (
            <div className="export-progress" data-testid="script-progress">
              <div className="export-stat">
                已执行 {progress.executed.toLocaleString()} 条
                {progress.total > 0 ? ` / 共 ${progress.total.toLocaleString()} 条` : ''} ·{' '}
                {(progress.elapsedMs / 1000).toFixed(1)}s
              </div>
              <div className="export-bar">
                <div
                  className="export-bar-fill"
                  style={
                    progress.total > 0
                      ? { width: `${Math.min(100, (progress.executed / progress.total) * 100)}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : null}

          {stage === 'done' && result ? (
            <div className="export-done" data-testid="script-done">
              {result.executed > 0 ? (
                <p>
                  <IconCheck /> 已执行 {result.executed.toLocaleString()} 条（{(result.elapsedMs / 1000).toFixed(1)}s）
                </p>
              ) : null}
              {result.aborted ? (
                <p className="bad"><IconAlert /> 中途失败已停止（{result.lastError ?? '未知错误'}）</p>
              ) : null}
              {result.failed > 0 ? (
                <div>
                  <p className="bad"><IconAlert /> {result.failed} 条执行失败：</p>
                  <ul className="script-errors">
                    {result.errors.slice(0, 20).map((x, i) => (
                      <li key={i} className="bad" title={x.sql}>
                        第 {x.no} 条：{x.message}
                      </li>
                    ))}
                  </ul>
                  {result.errors.length > 20 ? <p className="script-more">其余 {result.errors.length - 20} 条错误已省略</p> : null}
                </div>
              ) : null}
              {result.executed === 0 && result.failed === 0 ? (
                <p className="export-hint">脚本中没有可执行的语句。</p>
              ) : null}
            </div>
          ) : null}

          {stage === 'error' ? (
            <div className="export-error" data-testid="script-error">
              <p><IconX /> {error}</p>
            </div>
          ) : null}
        </div>

        <footer>
          {stage === 'pick' || stage === 'scanning' ? <button onClick={requestClose}>取消</button> : null}
          {stage === 'confirm' ? (
            <>
              <button onClick={requestClose}>取消</button>
              <button className="primary" disabled={!stats || stats.statements === 0} onClick={() => void confirmExecute()} data-testid="script-confirm-run">
                确认执行（{stats?.statements.toLocaleString() ?? 0} 条）
              </button>
            </>
          ) : null}
          {stage === 'running' ? (
            <button onClick={() => void backend.scriptCancel(jobIdRef.current!)} data-testid="script-cancel">
              取消执行
            </button>
          ) : null}
          {stage === 'done' || stage === 'error' ? (
            <button className="primary" onClick={finishAndClose} data-testid="script-finish">
              完成
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
