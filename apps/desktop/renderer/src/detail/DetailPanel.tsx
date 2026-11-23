/**
 * 右侧详情面板（§6.7，2026-09-29 缺陷 3 + 缺陷 5 改版）
 *
 * 三块内容：**表信息 / 字段（含注释）/ 表结构语句**。
 *
 * 改版说明（缺陷 5）：
 *  - 表信息：保留不动（名称、类型、引擎、排序规则、估算行数、字段数、注释）。
 *  - 字段：此前只有「名称 · 类型 · PK/UQ/AI/NULL」，**注释挤在一个 title 里**，
 *    等于看不见。改为把 comment 作为第二行常驻显示 —— 字段的信息量主要在注释里
 *    （`status` 是什么状态、`is_delete` 是 0/1 还是 Y/N），类型只是附注。
 *  - 第三块：原「单元格完整值」→ 换成「表结构语句」（SHOW CREATE TABLE 全文）。
 *    单元格完整值的能力没有丢，整块搬到 `CellValueModal`（网格右键 / 双击触发），
 *    因为侧栏 280px 宽放长文本与图片预览本来就很局促，弹窗反而更好用。
 *
 * 联动说明（缺陷 3）：
 *  宿主传入的 `table` 现在优先来自**左树当前选中的表节点**（单击即联动），
 *  没有选中时回退到激活标签的表 —— 用户不必先把表打开才能看它的结构。
 *
 * 宽 280px，可折叠。折叠时只留一条竖条（28px），不占空间。
 */

import { useEffect, useMemo, useState } from 'react';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import type { TableInfoDto } from '../../../src/shared/ipc-channels.js';
import { formatResultBytes } from '../workspace/resultMeta';
import { tableFacts } from '@dbstudio/core-sql-editor/facts';
import { pickBackend } from '../backend';
import { IconCopy, IconFileCode } from '../ui/icons';
import { RowInspector, type RowInspectorProps } from './RowInspector';

export interface DetailPanelProps {
  table: TableMeta | null;
  database: string | null;
  /**
   * 拉建表语句所需的连接 id。缺省（demo / 未选中）时第三块只显示提示，
   * 不做无意义的请求 —— 拉不到 DDL 不该变成一条错误 toast（这是浏览态，不是操作态）。
   */
  connId?: string | null;
  collapsed: boolean;
  onToggle: () => void;
  /** 可选 toast（复制结果反馈）；宿主未接时静默降级 */
  onToast?: (message: string) => void;
  /**
   * 0.10.0 P0-01：当前行视图。
   *
   * null = 没有激活表/没有选中行；此时「行」页签禁用并说明原因，
   * 不伪造一个空行面板。值仍由宿主传入的 source 现场读取（脏格优先），
   * 本组件不持有行数据副本。
   */
  rowInspector?: RowInspectorProps | null;
  /** 0.10.0 P2-10：schema 快照的本地加载时刻（用于显示缓存年龄） */
  schemaLoadedAt?: number | null;
}

/** 相对时间：详情面板不引入日期库，够用即可 */
function describeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * DDL 拉取的防抖毫秒数。
 *
 * 为什么要防抖：用户在树上连续单击几张表时，每张表都会触发一次 SHOW CREATE TABLE。
 * 不防抖就是一串并发查询打到同一个连接上（驱动层会串行化，但白排队 + 白耗往返）。
 * 120ms 足够吞掉「扫过一串表」的手速，又不会让单张表的等待有可感延迟。
 */
const DDL_DEBOUNCE_MS = 120;

export function DetailPanel({ table, database, connId, collapsed, onToggle, onToast, rowInspector, schemaLoadedAt }: DetailPanelProps) {
  const facts = useMemo(() => (table ? tableFacts(table) : []), [table]);
  const [view, setView] = useState<'table' | 'row'>('table');

  // 当前行消失（切表/清空选择）时退回表信息，避免停在一个永远空的行页
  useEffect(() => {
    if (view === 'row' && !rowInspector) setView('table');
  }, [view, rowInspector]);

  // ---- 0.10.0 P2-10：表体积 / 创建时间（information_schema，估算口径）----
  const [info, setInfo] = useState<TableInfoDto | null>(null);
  useEffect(() => {
    if (!table || !connId || !database) {
      setInfo(null);
      return;
    }
    let alive = true;
    // 换表先把上一张表的体积清掉，避免请求返回前把 A 表大小标在 B 表上
    setInfo(null);
    const timer = setTimeout(() => {
      void pickBackend()
        .schemaGetTableInfo({ connId, database, table: table.name })
        .then((r) => {
          if (alive) setInfo(r);
        })
        .catch(() => {
          // 体积读不到不影响详情：表格其余部分照常显示
          if (alive) setInfo(null);
        });
    }, 160);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [connId, database, table?.name]);

  // ---- 表结构语句（SHOW CREATE TABLE）----
  const [ddl, setDdl] = useState<string | null>(null);
  const [ddlLoading, setDdlLoading] = useState(false);
  const [ddlError, setDdlError] = useState<string | null>(null);

  /**
   * 换表即重拉。key 用 `connId:database:table` —— 任一段变化都必须重拉
   * （同一张表名在不同库/不同连接下是完全不同的对象）。
   *
   * 🔴 alive 标志必须有：请求是异步的，用户可能在返回前就切到下一张表，
   *    没有它就会把上一张表的 DDL 写进当前视图（显示 `users` 的结构却写着 `orders`）。
   */
  useEffect(() => {
    if (!table || !connId || !database) {
      setDdl(null);
      setDdlError(null);
      setDdlLoading(false);
      return;
    }
    let alive = true;
    setDdlLoading(true);
    setDdlError(null);
    const timer = setTimeout(() => {
      void pickBackend()
        .schemaGetObjectDdl({ connId, database, name: table.name, kind: table.kind === 'view' ? 'view' : 'table' })
        .then((r) => {
          if (!alive) return;
          setDdl(r.ddl);
          setDdlLoading(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // 常见原因：连接空闲断开 / 无 SHOW VIEW 权限 / 表已被删。
          // 这里只在本块内说明，不 toast —— 浏览详情失败不该打断用户手头的操作。
          setDdl(null);
          setDdlError(e instanceof Error ? e.message : String(e));
          setDdlLoading(false);
        });
    }, DDL_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // table 对象引用会随 schema 刷新变化，用 name+kind 作为稳定依赖更准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, database, table?.name, table?.kind]);

  const copyDdl = () => {
    if (!ddl) return;
    void navigator.clipboard?.writeText(ddl).catch(() => undefined);
    onToast?.('已复制建表语句');
  };

  if (collapsed) {
    return (
      <aside className="detail-panel collapsed">
        <div className="detail-head">
          <button onClick={onToggle} title="展开详情面板">
            ‹
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <span>详情</span>
        <div className="detail-view-tabs" role="tablist" aria-label="详情视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'table'}
            className={view === 'table' ? 'active' : undefined}
            onClick={() => setView('table')}
            data-testid="detail-tab-table"
          >
            表
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'row'}
            className={view === 'row' ? 'active' : undefined}
            onClick={() => rowInspector && setView('row')}
            disabled={!rowInspector}
            title={rowInspector ? '查看当前行全部字段' : '先在表标签里选中一行'}
            data-testid="detail-tab-row"
          >
            行
          </button>
        </div>
        <span className="spacer" />
        <button onClick={onToggle} title="折叠">
          ›
        </button>
      </div>

      {view === 'row' && rowInspector ? (
        <RowInspector {...rowInspector} />
      ) : !table ? (
        <div className="detail-section">
          <h4>未选中表</h4>
          <div className="detail-empty">在左侧树中单击一张表即可查看它的信息、字段与建表语句</div>
        </div>
      ) : (
        <>
          <div className="detail-section">
            <h4>表信息</h4>
            <dl className="detail-kv">
              <dt>名称</dt>
              <dd>
                {database ? `${database}.` : ''}
                {table.name}
              </dd>
              <dt>类型</dt>
              <dd>{table.kind === 'view' ? '视图' : '表'}</dd>
              {facts.map((f) => (
                <div key={f.label} style={{ display: 'contents' }}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
              <dt>数据大小</dt>
              <dd>{info?.dataLength != null ? formatResultBytes(info.dataLength) : '—'}</dd>
              <dt>索引大小</dt>
              <dd>{info?.indexLength != null ? formatResultBytes(info.indexLength) : '—'}</dd>
              <dt>创建时间</dt>
              <dd>{info?.createTime ?? '—'}</dd>
              <dt>schema 缓存</dt>
              <dd title={schemaLoadedAt ? new Date(schemaLoadedAt).toLocaleString('zh-CN') : undefined}>
                {schemaLoadedAt ? describeAge(Date.now() - schemaLoadedAt) : '—'}
              </dd>
            </dl>
          </div>

          <div className="detail-section detail-cols-section">
            <h4>字段（{table.columns?.length ?? 0}）</h4>
            <div className="detail-cols">
              {(table.columns ?? []).map((c) => (
                <div className="detail-col" key={c.name}>
                  {/* 第一行：名称 + 约束徽标（PK/UQ/AI/NULL）。徽标右靠，名称可截断 */}
                  <span className="dc-head">
                    <span className="name" title={c.name}>
                      {c.name}
                    </span>
                    <span className="flags">
                      {c.isPrimaryKey ? <em className="dc-tag pk">PK</em> : null}
                      {c.isUnique && !c.isPrimaryKey ? <em className="dc-tag uq">UQ</em> : null}
                      {c.autoIncrement ? <em className="dc-tag ai">AI</em> : null}
                      {!c.nullable ? <em className="dc-tag nn">NOT NULL</em> : null}
                    </span>
                  </span>
                  {/* 第二行：类型 + 注释。注释是字段信息量的主体（缺陷 5），常驻显示 */}
                  <span className="dc-meta">
                    <span className="type">{c.dataType}</span>
                    {c.comment ? (
                      <span className="dc-comment" title={c.comment}>
                        {c.comment}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div
            className="detail-section detail-ddl-section"
            style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            <h4>
              <IconFileCode size={11} />
              表结构语句
              <span className="spacer" />
              <button
                type="button"
                className="detail-ddl-copy"
                data-testid="btn-copy-ddl"
                onClick={copyDdl}
                disabled={!ddl}
                title={ddl ? '复制完整建表语句' : '暂无可复制的语句'}
              >
                <IconCopy size={10} />
                复制
              </button>
            </h4>
            {ddlLoading ? (
              <div className="detail-empty">正在读取表结构…</div>
            ) : ddl ? (
              <pre className="detail-ddl" data-testid="detail-ddl">
                {ddl}
              </pre>
            ) : (
              <div className="detail-empty" data-testid="detail-ddl-empty">
                {ddlError
                  ? `读取失败：${ddlError}`
                  : connId
                    ? '暂无建表语句'
                    : '连接后即可查看完整建表语句（SHOW CREATE TABLE）'}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
