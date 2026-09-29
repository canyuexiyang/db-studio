/**
 * D1 断线重连横幅 —— 监听主进程 event:connState 推送，断线时给一条可操作的横幅。
 *
 * 信号源：组件内部自取后端（pickBackend()，契约 §一.1：demo 降级天然可用 ——
 * demo 后端的 onConnState 是空订阅，横幅永远不出现，不崩）。
 *
 * 显示条件（三条同时满足才显示）：
 *  1. 推送的 state ∈ {disconnected, failed, closed}（意外断开；手动断开的
 *     closed 不带 lastError，天然被第 2 条滤掉，不会"自己断开还报警"）
 *  2. lastError 非空（ipc-handlers 现有推送不带 lastError —— 那些是连接/
 *     断开动作的例行通知，不是事故；session-registry 补全的事故推送才带）
 *  3. 该连接当前不在 connected/busy（恢复后自动收起，不依赖再来一条推送）
 *
 * 只显示【最近一个】出问题的连接：多连接同时断时后到的覆盖先到的，
 * 重连成功或手动 × 后收起。红/黄用既有 token（--error-bar / --warn），禁紫色。
 */

import { useEffect, useState } from 'react';
import type { ConnectionConfig } from '@dbstudio/core-connection';
import { pickBackend } from '../backend';
import { IconAlert, IconRefresh, IconX } from '../ui/icons';


export interface ConnStateBannerProps {
  connections: ConnectionConfig[];
  /** App 现有的 connStates state —— 用于"恢复后自动收起"与重连中态 */
  connStates: Record<string, { state: string; lastError: string | null }>;
  /** 重连（App 传 onConnectNode 的包装；promptEveryTime 的密码流由 App 侧逻辑负责） */
  onReconnect: (cfg: ConnectionConfig) => void;
  onDismiss: () => void;
}

/** 意外断开的状态集合（failed 是握手失败，disconnected 是掉线，closed 是被服务端关） */
const BAD_STATES: ReadonlySet<string> = new Set(['disconnected', 'failed', 'closed']);

interface BadConn {
  id: string;
  state: string;
  lastError: string;
}

/** 原因摘要：横幅一行放不下长错误，全文进 title 悬浮 */
function summarize(err: string): string {
  const oneLine = err.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

export function ConnStateBanner({ connections, connStates, onReconnect, onDismiss }: ConnStateBannerProps) {
  const [bad, setBad] = useState<BadConn | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 订阅一次即可（backend 实例在会话生命周期内不变）；卸载时必须退订
    let alive = true;
    const unsub = pickBackend().onConnState((ev) => {
      if (!alive) return;
      const err = typeof ev.lastError === 'string' ? ev.lastError.trim() : '';
      if (ev.state === 'connected' || ev.state === 'busy') {
        // 恢复连接 → 收起并复位 dismiss（下次断开要能再弹出来）
        setBad(null);
        setDismissed(false);
        return;
      }
      if (BAD_STATES.has(ev.state) && err) {
        setBad({ id: ev.id, state: ev.state, lastError: err });
        setDismissed(false);
      }
      // 没带 lastError 的例行推送（连接中/已连上等）不动横幅
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  if (!bad || dismissed) return null;

  // 该连接已被删除（横幅还挂着）→ 没法重连，直接不显示
  const cfg = connections.find((c) => c.id === bad.id);
  if (!cfg) return null;

  // 以 App 的 connStates 为准看当前状态：已恢复就不显示（不依赖推送顺序）
  const liveState = connStates[bad.id]?.state ?? bad.state;
  if (liveState === 'connected' || liveState === 'busy') return null;

  const reconnecting = liveState === 'connecting';
  const name = cfg.name || bad.id;
  const summary = summarize(bad.lastError);
  const isError = bad.state === 'failed';

  return (
    <div
      className={`cb-root ${isError ? 'cb-error' : 'cb-warn'}`}
      data-testid="conn-state-banner"
      role="alert"
    >
      <span className="cb-icon">
        <IconAlert size={13} />
      </span>
      <span className="cb-text" title={bad.lastError}>
        {isError ? `连接 ${name} 失败` : `连接 ${name} 已断开`}（{summary}）
        {reconnecting ? ' — 正在重连…' : ''}
      </span>
      <span className="cb-spacer" />
      <button
        className="cb-reconnect"
        disabled={reconnecting}
        onClick={() => onReconnect(cfg)}
        title="重新建立这条连接"
        data-testid="cb-reconnect"
      >
        <IconRefresh size={11} />
        重连
      </button>
      <button
        className="cb-close"
        onClick={() => {
          setDismissed(true);
          onDismiss();
        }}
        title="关闭提醒"
        data-testid="cb-dismiss"
      >
        <IconX size={11} />
      </button>
    </div>
  );
}
