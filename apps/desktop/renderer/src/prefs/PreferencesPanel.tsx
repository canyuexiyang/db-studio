/**
 * 偏好设置面板（V5）—— macOS `⌘,` 惯例入口。
 *
 * 🔴 lazy chunk：低频动作，绝大多数会话用不到，不该让所有会话的首屏为它买单。
 *    外壳样式（.prefs-modal / .prefs-*）已在 styles.css 首屏就位（红线 9），
 *    否则懒加载间隙会布局塌陷。
 *
 * 分区（PRD v1.2 §一 V5）：
 *  ① 外观三态  ② 字体缩放档位  ③ 网格默认项  ④ 快捷键一览（只读）  ⑤ 使用统计开关
 *
 * 与 App 的分工：本组件只渲染 + 回调，状态全部由 App 持有（外观/字体在 App，
 * 网格默认项/关闭确认/使用统计走 preferences.ts 持久化）。
 */

import { useEffect } from 'react';
import { IconX, IconInfo } from '../ui/icons';
import {
  SHORTCUT_HINTS,
  type Preferences,
  type PrefsRowHeight,
} from './preferences';
import { FONT_ZOOM_STEPS, type FontZoomDir } from '../workspace/fontZoom';

/** 外观三态。与 App.tsx 的 ThemeMode 同口径（此处独立定义避免环形依赖） */
export type PrefsThemeMode = 'system' | 'light' | 'dark';

export interface PreferencesPanelProps {
  /** 当前外观三态 */
  themeMode: PrefsThemeMode;
  onThemeMode: (m: PrefsThemeMode) => void;
  /** 当前字体档位（倍率） */
  fontZoom: number;
  onFontZoom: (dir: FontZoomDir) => void;
  /** 网格默认项 + 使用统计（持久化在 preferences.ts） */
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  onClose: () => void;
}

const ROW_HEIGHT_LABELS: Record<PrefsRowHeight, string> = {
  compact: '紧凑 24px',
  standard: '标准 28px',
  loose: '宽松 32px',
};

export function PreferencesPanel({
  themeMode,
  onThemeMode,
  fontZoom,
  onFontZoom,
  prefs,
  onPrefs,
  onClose,
}: PreferencesPanelProps) {
  // Esc 关闭（与其它弹窗一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const zoomIdx = FONT_ZOOM_STEPS.findIndex((s) => Math.abs(s - fontZoom) < 1e-9);

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal prefs-modal" onMouseDown={(e) => e.stopPropagation()} data-testid="prefs-panel">
        <header className="prefs-head">
          偏好设置
          <span className="spacer" />
          <button className="prefs-close" onClick={onClose} title="关闭（Esc）" data-testid="prefs-close">
            <IconX size={13} />
          </button>
        </header>

        <div className="body prefs-body">
          {/* ① 外观三态 */}
          <section className="prefs-section">
            <div className="prefs-section-title">外观</div>
            <div className="prefs-row">
              <span className="prefs-label">主题</span>
              <div className="prefs-segmented" role="group" aria-label="主题">
                {(['system', 'light', 'dark'] as PrefsThemeMode[]).map((m) => (
                  <button
                    key={m}
                    className={themeMode === m ? 'active' : ''}
                    onClick={() => onThemeMode(m)}
                    data-testid={`prefs-theme-${m}`}
                  >
                    {{ system: '跟随系统', light: '浅色', dark: '深色' }[m]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ② 字体缩放档位 */}
          <section className="prefs-section">
            <div className="prefs-section-title">字体缩放</div>
            <div className="prefs-row">
              <span className="prefs-label">当前档位</span>
              <div className="prefs-zoom">
                <button
                  onClick={() => onFontZoom('out')}
                  title="缩小 (⌘-)"
                  disabled={zoomIdx <= 0}
                  data-testid="prefs-zoom-out"
                >
                  −
                </button>
                <span className="prefs-zoom-value" data-testid="prefs-zoom-value">
                  {Math.round(fontZoom * 100)}%
                </span>
                <button
                  onClick={() => onFontZoom('in')}
                  title="放大 (⌘=)"
                  disabled={zoomIdx >= FONT_ZOOM_STEPS.length - 1}
                  data-testid="prefs-zoom-in"
                >
                  +
                </button>
                <button
                  className="prefs-zoom-reset"
                  onClick={() => onFontZoom('reset')}
                  title="重置 (⌘0)"
                  data-testid="prefs-zoom-reset"
                >
                  重置
                </button>
              </div>
            </div>
          </section>

          {/* ③ 网格默认项 */}
          <section className="prefs-section">
            <div className="prefs-section-title">网格</div>
            <div className="prefs-row">
              <span className="prefs-label">默认行高</span>
              <select
                className="prefs-select"
                value={prefs.rowHeight}
                onChange={(e) => onPrefs({ rowHeight: e.target.value as PrefsRowHeight })}
                data-testid="prefs-rowheight"
              >
                {(Object.keys(ROW_HEIGHT_LABELS) as PrefsRowHeight[]).map((k) => (
                  <option key={k} value={k}>
                    {ROW_HEIGHT_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <label className="prefs-row prefs-check-row">
              <input
                type="checkbox"
                checked={prefs.confirmCloseDirty}
                onChange={(e) => onPrefs({ confirmCloseDirty: e.target.checked })}
                data-testid="prefs-confirm-close"
              />
              <span>关闭有未保存改动的标签前二次确认</span>
            </label>
          </section>

          {/* ④ 快捷键一览（只读） */}
          <section className="prefs-section">
            <div className="prefs-section-title">快捷键</div>
            <div className="prefs-shortcuts">
              {SHORTCUT_HINTS.map((h) => (
                <div className="prefs-shortcut" key={h.keys}>
                  <kbd>{h.keys}</kbd>
                  <span>{h.label}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ⑤ 使用统计开关（默认关闭；只写本地日志，无网络上报 PRD §2.2） */}
          <section className="prefs-section">
            <div className="prefs-section-title">隐私</div>
            <label className="prefs-row prefs-check-row">
              <input
                type="checkbox"
                checked={prefs.telemetryEnabled}
                onChange={(e) => onPrefs({ telemetryEnabled: e.target.checked })}
                data-testid="prefs-telemetry"
              />
              <span>记录本地使用统计（仅写入本机日志，绝不上报网络）</span>
            </label>
            <div className="prefs-note">
              <IconInfo size={12} />
              <span>开启后数据只写本机 Application Support 目录，不包含任何 SQL 内容与连接凭据。</span>
            </div>
          </section>
        </div>

        <footer>
          <button className="primary" onClick={onClose} data-testid="prefs-done">
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}