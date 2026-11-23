/**
 * 表结构页（0.10.0 P1-04）—— 表标签的只读 Structure 视图。
 *
 * 设计边界：
 *  - **只读**：任何修改仍走既有「设计」弹窗 + DDL 预演；这里不生成 ALTER。
 *  - **按需加载**：进页签才查 information_schema.STATISTICS 与外键；
 *    打开表本身不长这条查询（表首屏性能预算优先）。
 *  - **失败不阻塞**：索引/外键任一失败只影响对应分区，不让整页变成错误页。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import type { Backend } from '../backend';
import type { ForeignKeyDto, TableInfoDto } from '../../../src/shared/ipc-channels.js';
import { IconDesign, IconRefresh } from '../ui/icons';

export interface StructureTabProps {
  backend: Backend;
  connId: string;
  database: string;
  table: TableMeta;
  onEdit: () => void;
  onToast?: (message: string) => void;
}

function bytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function count(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `约 ${Math.round(n).toLocaleString('zh-CN')}`;
}

function orDash(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? '—' : v;
}

export function StructureTab({ backend, connId, database, table, onEdit, onToast }: StructureTabProps) {
  const [info, setInfo] = useState<TableInfoDto | null>(null);
  const [fks, setFks] = useState<ForeignKeyDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // onToast 是宿主内联函数（每次渲染新引用）；放进 load 依赖会让 effect 反复拉结构。
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;

  const load = useMemo(
    () => async () => {
      setLoading(true);
      setError(null);
      const [infoRes, fkRes] = await Promise.allSettled([
        backend.schemaGetTableInfo({ connId, database, table: table.name, includeIndexes: true }),
        backend.schemaGetForeignKeys({ connId, database, table: table.name }),
      ]);
      if (infoRes.status === 'fulfilled') setInfo(infoRes.value);
      else {
        setInfo(null);
        setError(infoRes.reason instanceof Error ? infoRes.reason.message : String(infoRes.reason));
      }
      setFks(fkRes.status === 'fulfilled' ? fkRes.value : []);
      if (fkRes.status === 'rejected' && infoRes.status === 'fulfilled') {
        onToastRef.current?.(`外键读取失败：${fkRes.reason instanceof Error ? fkRes.reason.message : String(fkRes.reason)}`);
      }
      setLoading(false);
    },
    [backend, connId, database, table.name],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const indexes = info?.indexes ?? null;

  return (
    <div className="structure-tab" data-testid="structure-tab">
      <div className="structure-bar">
        <span className="structure-title">表结构</span>
        <span className="structure-sub">{database}.{table.name}</span>
        <span className="spacer" />
        <button type="button" onClick={() => void load()} disabled={loading} title="重新读取结构">
          <IconRefresh size={11} />
          刷新
        </button>
        <button type="button" onClick={onEdit} title="打开表设计器（DDL 仍会预演）">
          <IconDesign size={11} />
          设计
        </button>
      </div>

      {loading && !info ? <div className="detail-empty">正在读取结构…</div> : null}
      {error && !info ? <div className="detail-empty">结构读取失败：{error}</div> : null}

      <div className="structure-scroll">
        <section className="structure-section">
          <h4>概览</h4>
          <dl className="structure-kv">
            <dt>引擎</dt><dd>{orDash(info?.engine ?? table.engine)}</dd>
            <dt>估算行数</dt><dd>{count(info?.rowsEstimate ?? table.estimatedRows)}</dd>
            <dt>数据大小</dt><dd>{bytes(info?.dataLength ?? null)}</dd>
            <dt>索引大小</dt><dd>{bytes(info?.indexLength ?? null)}</dd>
            <dt>字符集</dt><dd>{orDash(info?.charset)}</dd>
            <dt>排序规则</dt><dd>{orDash(info?.collation ?? table.collation)}</dd>
            <dt>创建时间</dt><dd>{orDash(info?.createTime)}</dd>
            <dt>注释</dt><dd>{orDash(info?.comment ?? table.comment)}</dd>
          </dl>
        </section>

        <section className="structure-section">
          <h4>字段（{table.columns.length}）</h4>
          <div className="structure-table-wrap">
            <table className="structure-table">
              <thead>
                <tr><th>名称</th><th>类型</th><th>可空</th><th>默认</th><th>键</th><th>注释</th></tr>
              </thead>
              <tbody>
                {table.columns.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="mono dim">{c.dataType}</td>
                    <td>{c.nullable ? '是' : '否'}</td>
                    <td className="mono dim">{c.defaultValue ?? '—'}</td>
                    <td className="keys">
                      {c.isPrimaryKey ? <em className="structure-tag pk">PK</em> : null}
                      {c.isUnique && !c.isPrimaryKey ? <em className="structure-tag uq">UQ</em> : null}
                      {c.autoIncrement ? <em className="structure-tag ai">AI</em> : null}
                    </td>
                    <td className="dim">{orDash(c.comment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="structure-section">
          <h4>索引{indexes ? `（${indexes.length}）` : ''}</h4>
          {indexes === null ? (
            <div className="detail-empty">索引信息未返回；可点「刷新」重试，或到设计器查看完整定义。</div>
          ) : indexes.length === 0 ? (
            <div className="detail-empty">这张表没有索引。</div>
          ) : (
            <div className="structure-table-wrap">
              <table className="structure-table">
                <thead>
                  <tr><th>名称</th><th>类型</th><th>唯一</th><th>列</th></tr>
                </thead>
                <tbody>
                  {indexes.map((idx) => (
                    <tr key={idx.name}>
                      <td className="mono">{idx.name}</td>
                      <td className="dim">{idx.type ?? '—'}</td>
                      <td>{idx.kind === 'primary' ? '主键' : idx.unique ? '唯一' : '普通'}</td>
                      <td className="mono">{idx.columns.map((c) => c ?? '(表达式)').join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="structure-section">
          <h4>外键{fks ? `（${fks.length}）` : ''}</h4>
          {fks === null ? (
            <div className="detail-empty">正在读取外键…</div>
          ) : fks.length === 0 ? (
            <div className="detail-empty">这张表没有外键。</div>
          ) : (
            <div className="structure-table-wrap">
              <table className="structure-table">
                <thead>
                  <tr><th>名称</th><th>列</th><th>引用</th><th>删除时</th><th>更新时</th></tr>
                </thead>
                <tbody>
                  {fks.map((fk) => (
                    <tr key={fk.constraintName}>
                      <td className="mono">{fk.constraintName}</td>
                      <td className="mono">{fk.columns.join(', ')}</td>
                      <td className="mono">
                        {fk.referencedDatabase}.{fk.referencedTable}({fk.referencedColumns.join(', ')})
                      </td>
                      <td className="dim">{orDash(fk.onDelete)}</td>
                      <td className="dim">{orDash(fk.onUpdate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}