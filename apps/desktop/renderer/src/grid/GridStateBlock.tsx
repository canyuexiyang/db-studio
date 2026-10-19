/**
 * T47：网格空白区的**六态占位块**。
 *
 * 只负责排版；判定与文案全部来自 `gridStates.ts`（纯函数，可单测）。
 * 每个状态都有自己的 `data-testid`，e2e 才能断言「这时显示的是这一态」，
 * 而不是靠文案正则去猜。
 */

import type { GridState } from './gridStates';

export interface GridStateBlockProps {
  state: GridState;
  /** 失败态的重试入口；未接线时按钮不渲染（画一个点了没反应的按钮更糟） */
  onRetry?: (() => void) | null;
}

export function GridStateBlock({ state, onRetry }: GridStateBlockProps) {
  return (
    <div className={`gs-block gs-${state.kind}`} data-testid={`grid-state-${state.kind}`} data-tone={state.tone}>
      <div className="gs-title">{state.title}</div>
      {state.hint ? (
        <div className="gs-hint" data-testid="grid-state-hint">
          {state.hint}
        </div>
      ) : null}
      {state.kind === 'error' && onRetry ? (
        <button type="button" className="gs-retry" data-testid="grid-state-retry" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
