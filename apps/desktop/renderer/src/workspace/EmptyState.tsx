/**
 * F7 空态引导 —— 工作区没有标签时的落点。
 *
 * 两种形态（props.hasConnections 切换）：
 *  - 无连接：一个主按钮引导建连接（demo 模式说明作脚注，不喧宾夺主）
 *  - 有连接无标签：三张快捷入口（⌘K 搜表 / ⌘T 查询 / 左侧双击开表）
 *
 * 所有回调都是必传（App 接线成本为零），但组件本身无副作用，
 * 回调不接也能安全渲染（onClick 缺失时按钮只是没有行为）。
 */

import { IconPlus, IconSearch, IconTerminal, IconTable, IconPlug } from '../ui/icons';


export interface EmptyStateProps {
  /** 左侧是否已有连接（决定走"建连接引导"还是"快捷入口"形态） */
  hasConnections: boolean;
  onNewConnection: () => void;
  onOpenPalette: () => void;
  onNewQuery: () => void;
}

export function EmptyState({ hasConnections, onNewConnection, onOpenPalette, onNewQuery }: EmptyStateProps) {
  if (!hasConnections) {
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

  return (
    <div className="es-root" data-testid="empty-state">
      <h2 className="es-title">从这里开始</h2>
      <div className="es-cards">
        <button className="es-card" onClick={onOpenPalette} data-testid="es-open-palette">
          <span className="es-card-icon">
            <IconSearch size={16} />
          </span>
          <span className="es-card-name">搜索表</span>
          <span className="es-card-key">⌘K</span>
        </button>
        <button className="es-card" onClick={onNewQuery} data-testid="es-new-query">
          <span className="es-card-icon">
            <IconTerminal size={16} />
          </span>
          <span className="es-card-name">新建查询</span>
          <span className="es-card-key">⌘T</span>
        </button>
        {/* 纯提示卡：开表的主路径在左树，这里只指路，不给第二套入口 */}
        <div className="es-card es-card-static">
          <span className="es-card-icon">
            <IconTable size={16} />
          </span>
          <span className="es-card-name">打开左侧表</span>
          <span className="es-card-key">双击树节点</span>
        </div>
      </div>
    </div>
  );
}
