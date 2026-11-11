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
  /** 空表 / 空结果下的「新增空白行」入口；未接线时不渲染 */
  onAddBlankRow?: (() => void) | null;
}

export function GridStateBlock({ state, onRetry, onAddBlankRow }: GridStateBlockProps) {
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
      {/* 空态文案原本就指向「可新增行」，但旧实现整块不渲染网格，用户无从下手 */}
      {state.kind === 'empty' && onAddBlankRow ? (
        <button
          type="button"
          className="gs-retry"
          data-testid="grid-state-add-blank-row"
          onClick={onAddBlankRow}
        >
          新增空白行
        </button>
      ) : null}
    </div>
  );
}
