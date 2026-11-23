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

import { useState } from 'react';
import { parseMysqlUrl } from '@dbstudio/core-connection';
import { IconPlug } from '../ui/icons';


export interface EmptyStateProps {
  onNewConnection: () => void;
  /**
   * 0.10.0 P2-08：粘贴 MySQL URL 直接进新建表单。
   * URL 非法在本组件内给原因，不把用户丢进一个空表单。
   */
  onPasteUrl?: (url: string) => void;
}

export function EmptyState({ onNewConnection, onPasteUrl }: EmptyStateProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const text = url.trim();
    if (text === '') {
      setError('请先粘贴连接 URL');
      return;
    }
    if (parseMysqlUrl(text) === null) {
      setError('无法识别：请用 mysql://user:password@host:3306/database 的格式');
      return;
    }
    setError(null);
    onPasteUrl?.(text);
  };

  return (
    <div className="es-root" data-testid="empty-state">
      <div className="es-glyph">
        <IconPlug size={30} />
      </div>
      <h2 className="es-title">还没有数据库连接</h2>
      <p className="es-desc">粘贴一条连接 URL，或手动填写连接信息，就可以浏览表、查改数据。</p>
      <div className="es-url">
        <input
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="mysql://user:password@127.0.0.1:3306/database"
          aria-label="连接 URL"
          data-testid="es-url"
          spellCheck={false}
        />
        <button className="es-primary" onClick={submit} data-testid="es-url-connect" disabled={!onPasteUrl}>
          连接
        </button>
      </div>
      {error ? <p className="es-error" data-testid="es-url-error">{error}</p> : null}
      <button className="es-secondary" onClick={onNewConnection} data-testid="es-new-connection">
        手动新建连接
      </button>
      <p className="es-footnote">也可以先用 demo 模式逛逛示例数据（纯浏览器 dev 环境），不会碰到真实库。</p>
    </div>
  );
}
