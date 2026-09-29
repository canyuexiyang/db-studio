/**
 * 目标库选择（V7）—— 连接级「运行 SQL 脚本」的前置步骤。
 *
 * 为什么需要它：库/表级入口天然带库上下文（点哪个库就在哪个库执行），
 * 连接级没有 —— 一个连接可能挂多个库，直接进脚本流程会让脚本跑到错误的库上。
 * 这里只负责「选一个库」然后交回既有 SqlScriptModal 流程，不重复脚本逻辑。
 *
 * 组件很小，静态引入（不做 lazy）—— 避免弹窗出现前的加载间隙。
 * 外壳样式 `.script-db-*` 已在 styles.css 首屏就位（红线 9）。
 */

import { useEffect, useState } from 'react';
import { IconDatabase, IconX } from '../ui/icons';

export interface ScriptDbPickerProps {
  /** 连接显示名（标题用） */
  connName: string;
  /** 候选库名列表（来自已加载 schema 或 schemaRefresh） */
  databases: string[];
  /** 选好库 + 确认 */
  onPick: (database: string) => void;
  onClose: () => void;
}

export function ScriptDbPicker({ connName, databases, onPick, onClose }: ScriptDbPickerProps) {
  const [sel, setSel] = useState<string | null>(databases[0] ?? null);

  // Esc 关闭（与其它弹窗一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Enter' && sel) {
        e.stopPropagation();
        onPick(sel);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onPick, sel]);

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="modal script-db-modal"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="script-db-picker"
      >
        <header>
          <IconDatabase size={13} />
          选择目标库 — {connName}
          <span className="spacer" />
          <button className="prefs-close" onClick={onClose} title="关闭（Esc）" data-testid="script-db-close">
            <IconX size={13} />
          </button>
        </header>

        <div className="body">
          <div className="script-db-hint">
            该连接包含多个数据库，请选择脚本的执行目标。脚本里的建表 / 数据语句将落在这个库上。
          </div>
          {databases.length > 0 ? (
            <div className="script-db-list" role="listbox" aria-label="目标库">
              {databases.map((db) => (
                <button
                  key={db}
                  role="option"
                  aria-selected={sel === db}
                  className={`script-db-item${sel === db ? ' selected' : ''}`}
                  onClick={() => setSel(db)}
                  onDoubleClick={() => onPick(db)}
                  data-testid={`script-db-${db}`}
                >
                  <IconDatabase size={13} />
                  <span className="script-db-name">{db}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="script-db-empty">
              未获取到该连接的数据库列表。请先单击连接节点建立连接后重试。
            </div>
          )}
        </div>

        <footer>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!sel}
            onClick={() => sel && onPick(sel)}
            data-testid="script-db-confirm"
          >
            下一步
          </button>
        </footer>
      </div>
    </div>
  );
}