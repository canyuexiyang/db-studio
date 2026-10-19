/**
 * T01 / R01：数据重载前的未提交改动守卫。
 *
 * 背景（真机已复现）：`GridDataSource` 的脏单元格 Map 以「行下标:列下标」为键，
 * 而 `useGridDataSource(payload)` 在 payload 变化时**整体重建**数据源 ——
 * 排序 / 筛选 / 刷新 / 加载更多 / 外键跳转 全部会换 payload，于是脏格
 * 连同用户的输入一起静默蒸发（实测：输入后点列头排序，脏格 1→0 且无任何提示）。
 *
 * 本轮不做「跨重载按行身份迁移草稿」——那需要稳定行定位键与整栈撤销（I14/I18 的范围）。
 * 这里只保证**不静默丢**：三条明确出口，取消时数据、选区、列头状态原样保留。
 *
 * 复用 `DangerConfirmModal` 同一套 `.modal-mask` / `.modal` 外壳样式，
 * 因此不需要往 styles.css 首屏追加任何 CSS（红线 9：懒加载组件的外壳样式必须首屏就位）。
 */

import { IconAlert } from '../ui/icons';
import { isImeComposing } from '../ui/imeGuard';

export type DirtyGuardDecision = 'save' | 'discard' | 'cancel';

export interface DirtyReloadModalProps {
  /** 目标标签标题（形如 `order_db.orders`） */
  title: string;
  /** 未提交的改动格数 */
  count: number;
  /** 触发重载的原因，用于把「为什么会丢」讲清楚 */
  reason?: string;
  onResolve: (decision: DirtyGuardDecision) => void;
}

export function DirtyReloadModal({ title, count, reason, onResolve }: DirtyReloadModalProps) {
  return (
    <div className="modal-mask" data-testid="dirty-reload-guard">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // T13：组合期 Esc 是取消候选词，不该顺手关掉「未保存改动」守卫
          if (isImeComposing(e)) return;
          if (e.key === 'Escape') onResolve('cancel');
        }}
      >
        <header>
          <IconAlert />
          有 {count} 处未保存的改动
        </header>
        <div className="body">
          <p className="danger-reason">
            {reason ?? '该操作需要重新查询数据库'}
            ，重新加载会丢弃标签「{title}」上尚未提交的改动。
          </p>
          <p>你可以先提交这些改动，也可以明确放弃后再继续。</p>
        </div>
        <footer>
          <button onClick={() => onResolve('cancel')} data-testid="dirty-guard-cancel">
            取消
          </button>
          <span className="spacer" />
          <button onClick={() => onResolve('discard')} data-testid="dirty-guard-discard">
            放弃改动并继续
          </button>
          <button
            className="primary"
            onClick={() => onResolve('save')}
            data-testid="dirty-guard-save"
          >
            先保存…
          </button>
        </footer>
      </div>
    </div>
  );
}
