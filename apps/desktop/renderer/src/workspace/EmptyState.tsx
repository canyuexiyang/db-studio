/**
 * F7 空态引导 —— 工作区没有连接、也没有标签时的落点：引导新建连接。
 *
 * 0.7.5：原先的 props.hasConnections 与「三张快捷入口卡」是死代码 —— 唯一调用点
 * 只在 connections.length === 0 时渲染本组件，却写死 hasConnections={false}；
 * 有连接但没标签时中间面板已由 ObjectBrowser 接管（v0.6.0），e2e:ui 也断言此时
 * 不应出现 empty-state。把卡片「接活」会和对象清单形态/空态断言冲突，按最小改动删掉。
 *
 * 回调必传但组件本身无副作用，回调不接也能安全渲染（onClick 缺失时按钮只是没有行为）。
 */

import { IconPlus, IconPlug } from '../ui/icons';


export interface EmptyStateProps {
  onNewConnection: () => void;
}

export function EmptyState({ onNewConnection }: EmptyStateProps) {
  return (
    <div className="es-root" data-testid="empty-state">
      <div className="es-glyph">
        <IconPlug size={30} />
      </div>
      <h2 className="es-title">还没有数据库连接</h2>
      <p className="es-desc">新建一个 MySQL 连接，就可以浏览表、查改数据。</p>
      <button className="es-primary" onClick={onNewConnection} data-testid="es-new-connection">
        <IconPlus size={12} />
        新建连接
      </button>
      <p className="es-footnote">也可以先用 demo 模式逛逛示例数据（纯浏览器 dev 环境），不会碰到真实库。</p>
    </div>
  );
}
