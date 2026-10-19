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

/**
 * T11/T50：快捷键一览的键位从【动作目录】取，不在这里另写一份。
 *
 * 相对路径而不是 alias：目录源文件（`apps/desktop/src/shared/action-catalog.ts`）
 * 是零依赖纯数据模块（不 import electron / 不碰 DOM），渲染层可以安全引用；
 * 新增一条 alias 要同步维护四处构建配置（见 AGENTS.md §二），不值得。
 */
import { displayOf } from '../../../src/shared/action-catalog.js';

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

/** 快捷键一览（只读展示用） */
export interface ShortcutHint {
  keys: string;
  label: string;
}

/**
 * 一览表的种子条目。
 *
 * 🔴 T11/T50：**键位不许在这里手写**。凡是在动作目录里有对应动作的，一律用
 *    `action` 指过去、由 `displayOf()` 取展示串 —— 否则「偏好设置里的快捷键一览」
 *    就成了同一份键位的第四处副本，改键位时必然漂移（本文件先前就写着
 *    `⌘R 刷新表结构` / `⌘0 设 NULL`，两个都已被 T11 裁定改掉）。
 *
 * `keys` 手写只允许两种情况：
 *  1. 该键由原生 Edit 菜单的 role 提供（撤销/重做/复制/粘贴），主进程不认领为「动作」；
 *  2. 一次展示合并多个动作，或键位只存在于页面 keydown（未上原生菜单）。
 *     后者必须在注释里写明出处，方便以后收编进目录。
 */
interface HintSeed {
  /** 动作目录 id（数组 = 合并展示，如字体放大/缩小/重置） */
  action?: string | readonly string[];
  /** 手写展示串（仅在 action 缺省时允许） */
  keys?: string;
  label: string;
}

const HINT_SEEDS: readonly HintSeed[] = [
  { action: 'open-palette', label: '命令面板' },
  { action: 'filter', label: '筛选当前表' },
  { action: 'open-preferences', label: '偏好设置' },
  { action: 'refresh-schema', label: '刷新表结构' },
  { action: 'save', label: '保存改动（走 SQL 预演）' },
  { action: 'new-query', label: '新建查询标签' },
  { action: 'close-tab', label: '关闭当前标签' },
  // 原生「编辑」菜单的 role（undo/redo/cut/copy/paste/selectAll），不属动作目录
  { keys: '⌘Z / ⌘⇧Z', label: '撤销 / 重做编辑' },
  { keys: '⌘C / ⌘V', label: '复制 / 粘贴单元格' },
  { action: 'grid-delete-rows', label: '删除选中行' },
  { action: 'grid-set-null', label: '设 NULL / 清除本格改动' },
  { action: ['font-zoom-in', 'font-zoom-out', 'font-zoom-reset'], label: '字体放大 / 缩小 / 重置' },
  // 标签循环：页面 keydown 专有（App.tsx 的 ⌘⇧[ / ⌘⇧]），未上原生菜单 ——
  // 与目录里 next-tab/prev-tab 的 ⌃Tab 是两条并行入口，都保留。
  { keys: '⌘⇧[ / ⌘⇧]', label: '上一个 / 下一个标签' },
  { keys: '空格', label: '勾选当前行' },
  { keys: 'Enter', label: '编辑当前单元格' },
  { keys: 'Esc', label: '取消编辑 / 关闭面板' },
];

export const SHORTCUT_HINTS: readonly ShortcutHint[] = HINT_SEEDS.map((s) => {
  if (!s.action) return { keys: s.keys ?? '—', label: s.label };
  const ids = Array.isArray(s.action) ? s.action : [s.action];
  return {
    keys: ids.map((id) => displayOf(id) ?? `?${id}`).join(' / '),
    label: s.label,
  };
});