/**
 * 提交冲突处理弹窗（T09 / I28 / R15）。
 *
 * ## 要说清的三件事
 *
 *  1. **数据库没有任何改动** —— 冲突时整批已回滚（T08）。用户最先担心的是
 *     「是不是改了一半」，必须一句话回答。
 *  2. **你的未保存改动还在** —— 草稿没有被清（这正是旧实现最恶劣的地方：
 *     它先把草稿清了，再告诉用户「影响 N 行」，用户以为成了）。
 *  3. **库里现在是什么** —— 提供「重载该行并对比」：原值 / 待提交值 / 库中现值
 *     三列并排，`drifted` 标出「被他人改过」的列。不做「一键覆盖」——
 *     盲目覆盖等于把别人的改动无声抹掉。
 */

import { useEffect, useState } from 'react';
import { IconRefresh, IconX } from '../ui/icons';
import { buildDiff, type DiffCell, type RowProbe } from './conflictProbe';
import type { CellValue } from '@dbstudio/core-ipc-codec';
import { isImeComposing } from '../ui/imeGuard';

/** 一条冲突在 UI 里的完整视图（主进程给的部分 + 渲染层补的定位信息） */
export interface ConflictView {
  index: number;
  kind: string;
  actual: number;
  outcome: 'conflict' | 'ambiguous';
  reason: string;
  sql: string;
  /** 1-based 行号；null = 该语句没有行身份（如 DDL） */
  row: number | null;
  pending: { column: string; original: unknown; next: unknown }[];
  probe: RowProbe | null;
}

export interface ProbeOutcome {
  /** 命中行数：0 = 行已被删除；1 = 正常；2（LIMIT 2 上限）= 定位键已不唯一 */
  hits: number;
  /** 列的原始值（供 diff 用，含 NULL） */
  row: Record<string, CellValue> | null;
}

export interface SaveConflictModalProps {
  conflicts: ConflictView[];
  /** 本次提交的语句总数（用户要知道「整批」有多大） */
  totalStatements: number;
  /** 仍保留的未保存改动数 */
  pendingCount: number;
  onProbe: (c: ConflictView) => Promise<ProbeOutcome | null>;
  onClose: () => void;
}

function ConflictCard({ c, onProbe }: { c: ConflictView; onProbe: SaveConflictModalProps['onProbe'] }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'unavailable'>('idle');
  const [hits, setHits] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffCell[] | null>(null);

  const runProbe = async () => {
    if (!c.probe) {
      setState('unavailable');
      return;
    }
    setState('loading');
    try {
      const out = await onProbe(c);
      if (!out) {
        setState('unavailable');
        return;
      }
      setHits(out.hits);
      setDiff(buildDiff(c.pending, out.row));
      setState('done');
    } catch {
      setState('unavailable');
    }
  };

  return (
    <div className="conflict-card" data-testid="conflict-card">
      <div className="conflict-head">
        <span className="conflict-tag">语句 #{c.index + 1} · {c.kind}</span>
        {c.row != null ? <span className="conflict-row">第 {c.row + 1} 行</span> : null}
        <span className="spacer" />
        <span className="conflict-actual">实际命中 {c.actual} 行</span>
      </div>
      <div className="banner warn">{c.reason}</div>

      <details className="conflict-sql">
        <summary>查看语句原文</summary>
        <pre>{c.sql}</pre>
      </details>

      <div className="conflict-actions">
        <button type="button" onClick={() => void runProbe()} disabled={state === 'loading'}>
          <IconRefresh size={11} />
          {state === 'loading' ? '重载中…' : '重载该行并对比'}
        </button>
      </div>

      {state === 'unavailable' ? (
        <div className="conflict-note">无法回查该行（缺少定位键或连接不可用）。请手动刷新表后核对。</div>
      ) : null}

      {state === 'done' && hits === 0 ? (
        <div className="conflict-note" data-testid="probe-hits-0">
          该行在库中**已不存在**（按原定位键回查命中 0 行）—— 很可能是被删除，或定位键已被改动。不会自动覆盖。
        </div>
      ) : null}

      {state === 'done' && hits !== null && hits > 1 ? (
        <div className="conflict-note" data-testid="probe-hits-many">
          回查命中 {hits} 行（≥2）—— 定位键已不唯一，这是需要人工核对的异常。已停止，不做任何写入。
        </div>
      ) : null}

      {state === 'done' && diff ? (
        <table className="conflict-diff" data-testid="conflict-diff">
          <thead>
            <tr>
              <th>列</th>
              <th>库中原值</th>
              <th>你的待提交值</th>
              <th>库中现值</th>
            </tr>
          </thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.column} className={d.drifted ? 'drifted' : ''} data-drifted={d.drifted ? '1' : undefined}>
                <td>{d.column}</td>
                <td className="mono">{d.original}</td>
                <td className="mono">{d.next}</td>
                <td className="mono">{d.current ?? '—'}{d.drifted ? '（已变化）' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function SaveConflictModal({ conflicts, totalStatements, pendingCount, onProbe, onClose }: SaveConflictModalProps) {
  /** Esc 关闭（与既有弹窗同族） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // T13：输入法组合期一律放行（Enter/Esc 是确认/取消候选词，不是提交/关闭）
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal conflict-modal"
        data-testid="save-conflict-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <span>提交未完成 — {conflicts.length} 处冲突</span>
          <span className="spacer" />
          <button className="cell-modal-x" onClick={onClose} title="关闭（Esc）" data-testid="conflict-close">
            <IconX size={12} />
          </button>
        </header>

        <div className="body">
          <div className="banner warn" data-testid="conflict-rolled-back">
            <strong>整批已回滚，数据库没有任何改动。</strong>
            本轮共 {totalStatements} 条语句，其中一条未按预期影响 1 行 —— 按「一轮保存 = 单事务」
            语义整批撤销，不会出现「改了一半」。
          </div>
          <div className="banner" data-testid="conflict-draft-kept">
            你的 <strong>{pendingCount}</strong> 处未保存改动<strong>仍然保留</strong>在网格里，
            可以核对后修正重试（或直接放弃）。
          </div>

          {conflicts.map((c) => (
            <ConflictCard key={c.index} c={c} onProbe={onProbe} />
          ))}
        </div>

        <footer>
          <span className="spacer" />
          <button className="primary" onClick={onClose} data-testid="conflict-ack">
            知道了（保留我的改动）
          </button>
        </footer>
      </div>
    </div>
  );
}
