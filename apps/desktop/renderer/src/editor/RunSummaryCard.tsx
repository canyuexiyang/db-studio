/**
 * 0.7.1 需求 1：非结果集语句的「执行摘要卡」。
 *
 * ## 为什么不能再画结果网格
 *
 * UPDATE / INSERT / DELETE / DDL 的载荷是「0 列 0 行」的**合法**空载荷（MySQL 只回
 * OkPacket，没有结果集）。早先这类语句渲成一张空表格，用户看到的是
 * 「一个没有列的空白区域 + 返回 0 行」—— 既看不出改了几行，也像是查询失败。
 *
 * 竞品（Workbench / Navicat / DataGrip / TablePlus）都不给写操作画网格，
 * 只给一行「受影响 N 行」的摘要。这里对齐这个做法。
 *
 * ## 为什么 info 原文要露出来
 *
 * `affectedRows` 是 changed 行数。`UPDATE ... SET x = x` 会返回 0，而 matched 可能是 5。
 * `affectedRows` 单独看会让人以为「没匹配到」。主文案已经用 `匹配 N 行 · 值未变化`
 * 兜住了，但原文（`Rows matched: 5  Changed: 0`）是最终的证据来源 —— 给能看懂的人看。
 */

import type { RunResultText, StatementKind } from './resultMessage';

/** 卡片的输入（只取展示所需字段，不依赖 SqlEditorPanel 的 ResultTab 类型） */
export interface RunSummaryTab {
  statementKind: StatementKind;
  text: RunResultText;
  elapsedMs: number;
  info: string | null;
  warnings: number;
}

/** 语句类型徽标：用中文而不是 SQL 关键字 —— 徽标是给「刚点完执行」的人扫一眼的 */
const KIND_LABEL: Record<StatementKind, string> = {
  select: '查询',
  insert: '插入',
  update: '更新',
  delete: '删除',
  ddl: '结构变更',
  other: '语句',
};

export interface RunSummaryCardProps {
  tab: RunSummaryTab;
  onToast?: (msg: string) => void;
}

export function RunSummaryCard({ tab, onToast }: RunSummaryCardProps) {
  return (
    <div className="sql-run-summary" data-testid="sql-run-summary" data-kind={tab.statementKind}>
      <div className="sql-run-summary-row">
        <span className="sql-run-kind">{KIND_LABEL[tab.statementKind]}</span>
        {/* 主文案：已修改 2 行 / 已插入 1 行 / 执行成功 … */}
        <strong className="sql-run-title" data-testid="sql-run-title">
          {tab.text.title}
        </strong>
        {tab.text.detail ? (
          <span className="sql-run-detail" data-testid="sql-run-detail">
            {tab.text.detail}
          </span>
        ) : null}
        {tab.elapsedMs > 0 ? (
          <span className={tab.elapsedMs > 5000 ? 'dur bad' : tab.elapsedMs > 1000 ? 'dur warn' : 'dur'}>
            {tab.elapsedMs}ms
          </span>
        ) : null}
        {tab.warnings > 0 ? (
          <span className="dur warn" data-testid="sql-run-warnings">
            {tab.warnings} 条警告
          </span>
        ) : null}
      </div>
      {tab.info ? (
        <div className="sql-run-info" data-testid="sql-run-info">
          <span className="sql-run-info-label">服务端原文</span>
          <code>{tab.info}</code>
          <button
            className="sql-mini-btn"
            title="复制服务端返回的原文（含 Rows matched / Changed）"
            data-testid="sql-run-info-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(tab.info ?? '').catch(() => undefined);
              onToast?.('已复制服务端原文');
            }}
          >
            复制
          </button>
        </div>
      ) : null}
    </div>
  );
}
