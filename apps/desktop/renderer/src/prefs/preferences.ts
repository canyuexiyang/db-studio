/**
 * 偏好设置（V5）—— 纯逻辑，无 React/Electron 依赖，可离线单测。
 *
 * 定位：把散落各处的「用户偏好」收拢到一个可持久化的键值仓（localStorage）。
 * 目前只有三项需要真正落盘的（外观三态与字体缩放已在各自模块内落盘，见
 * themeMode / fontZoom.ts，本模块不重复持有）：
 *  - 网格默认行高（RowHeightMode）
 *  - 关闭标签前是否二次确认
 *  - 使用统计开关（默认关闭；PRD §2.2：只写本地日志，绝不上报网络）
 *
 * 🔴 键值读写全部 try/catch 静默降级：偏好的持久化失败只影响"下次启动的默认值"，
 *    不值得为它打断用户（与树展开记忆 / 字体缩放同口径）。
 */

/** 网格默认行高三档（与 App 的 rowHeightMode 取值一致，避免双份真相） */
export type PrefsRowHeight = 'compact' | 'standard' | 'loose';

export interface Preferences {
  /** 网格默认行高 */
  rowHeight: PrefsRowHeight;
  /** 关闭有脏改动的标签前是否二次确认 */
  confirmCloseDirty: boolean;
  /** 使用统计开关（默认关闭）。开启后只写本地日志，无任何网络上报 */
  telemetryEnabled: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  rowHeight: 'standard',
  confirmCloseDirty: true,
  telemetryEnabled: false,
};

export const PREFS_STORAGE_KEY = 'dbstudio.preferences.v1';

const VALID_ROW_HEIGHTS: readonly PrefsRowHeight[] = ['compact', 'standard', 'loose'];

function isRowHeight(v: unknown): v is PrefsRowHeight {
  return typeof v === 'string' && (VALID_ROW_HEIGHTS as readonly string[]).includes(v);
}

/**
 * 读取持久化偏好。
 *
 * 逐字段校验：localStorage 里可能残留旧版本/被手改的畸形值，任一项不合法
 * 就回退该项默认值（不是整份丢弃 —— 保住其它仍有效的字段）。
 */
export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };
    return {
      rowHeight: isRowHeight(parsed.rowHeight) ? parsed.rowHeight : DEFAULT_PREFERENCES.rowHeight,
      confirmCloseDirty:
        typeof parsed.confirmCloseDirty === 'boolean'
          ? parsed.confirmCloseDirty
          : DEFAULT_PREFERENCES.confirmCloseDirty,
      telemetryEnabled:
        typeof parsed.telemetryEnabled === 'boolean'
          ? parsed.telemetryEnabled
          : DEFAULT_PREFERENCES.telemetryEnabled,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** 持久化偏好；写失败静默（只影响下次启动的默认值） */
export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 静默降级：隐私模式 / 配额满时偏好不落盘
  }
}

/**
 * 合并一层补丁并落盘，返回合并后的完整偏好（调用方直接 setState 用）。
 * 把「读 → 合 → 写」收成一个纯函数，避免各处散落地手拼对象。
 */
export function patchPreferences(cur: Preferences, patch: Partial<Preferences>): Preferences {
  const next: Preferences = { ...cur, ...patch };
  savePreferences(next);
  return next;
}

/** 快捷键一览（只读展示用；口径来自 App 的 window keydown 与原生菜单） */
export interface ShortcutHint {
  keys: string;
  label: string;
}

export const SHORTCUT_HINTS: readonly ShortcutHint[] = [
  { keys: '⌘K', label: '命令面板' },
  { keys: '⌘⇧F', label: '筛选当前表' },
  { keys: '⌘,', label: '偏好设置' },
  { keys: '⌘R', label: '刷新表结构' },
  { keys: '⌘S', label: '保存改动（走 SQL 预演）' },
  { keys: '⌘T', label: '新建查询标签' },
  { keys: '⌘W', label: '关闭当前标签' },
  { keys: '⌘Z / ⌘⇧Z', label: '撤销 / 重做编辑' },
  { keys: '⌘C / ⌘V', label: '复制 / 粘贴单元格' },
  { keys: '⌘⌫', label: '删除选中行' },
  { keys: '⌘0', label: '设 NULL / 清除本格改动' },
  { keys: '⌘= / ⌘- / ⌘0', label: '字体放大 / 缩小 / 重置' },
  { keys: '⌘⇧[ / ⌘⇧]', label: '上一个 / 下一个标签' },
  { keys: '空格', label: '勾选当前行' },
  { keys: 'Enter', label: '编辑当前单元格' },
  { keys: 'Esc', label: '取消编辑 / 关闭面板' },
];