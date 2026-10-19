/**
 * 冲突行重载探测（T09/R15）。
 *
 * 提交因原值冲突被整批回滚后，用户最需要知道的是**「库里现在到底是什么」** ——
 * 只看「affectedRows=0」等于说「没成」，但没说为什么、也没说该不该重试。
 *
 * 这里用**原定位键**回查当前行（`<=> ` 是 MySQL 的 NULL 安全等值，NULL 主键也能
 * 命中）。只读探测，不改任何东西。`LIMIT 2` 是为了能识别「定位键已不唯一」
 * （命中 2 行 = 有人的改动把唯一键搞重复了，这本身是要报给用户的异常）。
 */

import { quoteIdentifier, quoteQualified } from '@dbstudio/core-sql-ident';

export interface RowProbe {
  sql: string;
  params: unknown[];
}

/**
 * 构造「按定位键回查该行」的只读 SELECT。
 *
 * @throws IdentifierError 库/表/列名非法
 */
export function buildRowProbeSql(
  database: string,
  table: string,
  locateColumns: string[],
  locateValues: unknown[],
): RowProbe {
  if (locateColumns.length === 0) throw new Error('缺少定位列，无法回查');
  const conds = locateColumns.map((c) => `${quoteIdentifier(c)} <=> ?`);
  return {
    sql: `SELECT * FROM ${quoteQualified([database, table])} WHERE ${conds.join(' AND ')} LIMIT 2`,
    params: locateValues,
  };
}

/** 展示用的值串（NULL 必须与空串区分 —— 红线 6） */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `<二进制 ${v.length} 字节>`;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export interface DiffCell {
  column: string;
  /** 用户操作时看到的库中原值 */
  original: string;
  /** 用户的待提交值 */
  next: string;
  /** 刚重载到的库中现值（未探测到 = null） */
  current: string | null;
  /** 库中现值相对原值被改过 → 这是冲突的根因 */
  drifted: boolean;
}

/** 逐列对比「原值 / 待提交值 / 库中现值」 */
export function buildDiff(
  pending: { column: string; original: unknown; next: unknown }[],
  current: Record<string, unknown> | null,
): DiffCell[] {
  return pending.map((p) => {
    const orig = displayValue(p.original);
    const hasCurrent = current !== null && Object.prototype.hasOwnProperty.call(current, p.column);
    const cur = hasCurrent ? displayValue(current![p.column]) : null;
    return {
      column: p.column,
      original: orig,
      next: displayValue(p.next),
      current: cur,
      drifted: cur !== null && cur !== orig,
    };
  });
}
