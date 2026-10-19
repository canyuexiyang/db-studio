/**
 * SQL 编辑器右键菜单 + 工具栏执行目标的【纯逻辑模型】（T28 / T29）。
 *
 * 为什么单开一个文件而不是写在 SqlEditorPanel.tsx 里：
 * 面板是 React 组件（带 CodeMirror 生命周期），而「哪些菜单项该出现、该不该可用、
 * 该显示什么文案」是**不依赖 DOM 的纯计算**。拆出来后可以在 node 下直接单测
 * （本项目没有 jsdom），把「无选区时剪切/复制必须禁用」这类断言真正钉死 ——
 * 留在组件里就只能靠 e2e，红不起来就没有意义。
 *
 * 两条红线在这里的落点：
 *  1. **不做假 UI**：`enabled=false` 的项**必须**带 `disabledReason`（中文），
 *     面板据此渲染 disabled + title，不留「看着能点、点了没反应」的项。
 *  2. **不臆造功能**：菜单只有 T28 列出的最小集 + 已在动作目录登记 `sql-context`
 *     入口的「执行全部」；不塞 SQL 优化 / 生成测试数据等推测动作。
 */

import { isProduction, type ConnectionConfig } from '@dbstudio/core-connection';

// ===========================================================================
// T28 右键菜单模型
// ===========================================================================

/**
 * 菜单动作 id。
 *
 * 前五个**刻意与动作目录同名** —— 快捷键文案由面板用 `displayOf(id)` 取，
 * 不在这里手写（手写一份必然与裁定漂移，见 action-catalog 的头注释）。
 * 后三个是纯粹的文本编辑动作，主机系统键（⌘X/⌘C/⌘V）不在目录里，面板本地兜底。
 */
export type SqlMenuActionId =
  | 'sql-run-all'
  | 'sql-run-selection'
  | 'sql-explain'
  | 'sql-format'
  | 'sql-comment'
  | 'sql-cut'
  | 'sql-copy'
  | 'sql-paste';

/** 分组：面板按组插 `.ctx-sep` 分隔线（复用既有样式，不新增 CSS） */
export type SqlMenuGroup = 'execution' | 'edit' | 'clipboard';

export interface SqlMenuContext {
  /** 编辑器有非空选区 */
  hasSelection: boolean;
  /** 编辑器有内容（空文档时执行/格式化无处下手） */
  hasText: boolean;
  /** 已选中连接（未连库时执行类禁用） */
  connected: boolean;
  /** 有查询在执行 */
  running: boolean;
  /** 宿主检测到 `navigator.clipboard` 可用 */
  clipboardAvailable: boolean;
}

export interface SqlMenuItem {
  id: SqlMenuActionId;
  group: SqlMenuGroup;
  label: string;
  enabled: boolean;
  /** enabled=false 时**必填**的中文原因（面板渲染成 title） */
  disabledReason: string | null;
}

/** 执行类（全部 / 选中或当前语句 / 执行计划）的共用禁用口径 */
function runDisabledReason(ctx: SqlMenuContext): string | null {
  if (!ctx.connected) return '未选择连接';
  if (!ctx.hasText) return '编辑器为空';
  if (ctx.running) return '已有查询在执行';
  return null;
}

/**
 * 构建右键菜单项（顺序即渲染顺序）。
 *
 * 三种「执行对象」在菜单里都存在且可辨：
 *  - `sql-run-all` → 全文全部语句；
 *  - `sql-run-selection` → 有选区=选中，无选区=**当前语句**（label 随之切换）；
 *  - `sql-explain` → 同上口径的 EXPLAIN。
 */
export function buildSqlContextMenu(ctx: SqlMenuContext): SqlMenuItem[] {
  const runReason = runDisabledReason(ctx);
  const emptyReason = ctx.hasText ? null : '编辑器为空';
  const noSelectionReason = ctx.hasSelection ? null : '没有选中文本';
  const noClipboardReason = ctx.clipboardAvailable ? null : '当前环境不支持读取剪贴板';

  return [
    {
      id: 'sql-run-all',
      group: 'execution',
      label: '执行全部',
      enabled: runReason === null,
      disabledReason: runReason,
    },
    {
      id: 'sql-run-selection',
      group: 'execution',
      // 有选区 / 无选区两种对象在 label 上直接分开 —— 这正是 T29 要的「三者可辨」
      label: ctx.hasSelection ? '执行选中' : '执行当前语句（无选区）',
      enabled: runReason === null,
      disabledReason: runReason,
    },
    {
      id: 'sql-explain',
      group: 'execution',
      label: '执行计划',
      enabled: runReason === null,
      disabledReason: runReason,
    },
    {
      id: 'sql-format',
      group: 'edit',
      label: '格式化 SQL',
      enabled: emptyReason === null,
      disabledReason: emptyReason,
    },
    {
      id: 'sql-comment',
      group: 'edit',
      label: '注释 / 取消注释',
      enabled: emptyReason === null,
      disabledReason: emptyReason,
    },
    {
      id: 'sql-cut',
      group: 'clipboard',
      label: '剪切',
      enabled: noSelectionReason === null,
      disabledReason: noSelectionReason,
    },
    {
      id: 'sql-copy',
      group: 'clipboard',
      label: '复制',
      enabled: noSelectionReason === null,
      disabledReason: noSelectionReason,
    },
    {
      id: 'sql-paste',
      group: 'clipboard',
      label: '粘贴',
      enabled: noClipboardReason === null,
      disabledReason: noClipboardReason,
    },
  ];
}

// ===========================================================================
// T29 执行对象 & 目标连接/环境
// ===========================================================================

export type RunTarget = 'all' | 'statement' | 'selection' | 'explain';

export interface RunTargetLabel {
  target: RunTarget;
  /** 按钮文案（不含键位，键位由面板追加） */
  label: string;
}

/**
 * 「执行」这类按钮命中哪个执行对象 —— 三个值彼此可辨（T29 的核心诉求）。
 *
 * 无选区时它就是**当前语句**，而不是「执行选中但选区是空的」这种歧义说法。
 */
export function runTargetLabel(target: RunTarget): RunTargetLabel {
  switch (target) {
    case 'all':
      return { target, label: '执行全部' };
    case 'selection':
      return { target, label: '执行选中' };
    case 'explain':
      return { target, label: '执行计划' };
    default:
      return { target: 'statement', label: '执行当前语句' };
  }
}

/**
 * 由选区长度推出「⌘⏎ 会执行哪个对象」。
 *
 * 选区塌陷（to == from）→ 当前语句；否则 → 选中。
 */
export function targetOfSelection(selectedChars: number): RunTarget {
  return selectedChars > 0 ? 'selection' : 'statement';
}

/** 工具栏「执行对象」指示器文案（与 ⌘⏎ 按钮同一口径，单一真值） */
export function executionTargetHint(selectedChars: number): string {
  return selectedChars > 0 ? `选中 ${selectedChars} 字符` : '当前语句';
}

/** 工具栏执行区的一整套文案 —— 三者（全部 / 当前语句 / 选中）由此处一次性派生 */
export interface ExecutionScopeLegend {
  /** 「执行全部」按钮的显式名称（渲染层用于 aria-label / title） */
  runAll: string;
  /** ⌘⏎ 按钮文案：有选区=执行选中，无选区=执行当前语句 */
  runSelection: string;
  /**
   * 执行计划按钮文案。
   *
   * T29 要求三个执行对象**互不可混**，而 e2e 只能靠「三者文案两两不同」来证伪。
   * 文案从这里出，才有唯一真值可比 —— 别让渲染层再手写一份。
   */
  explain: string;
  /** ⌘⏎ 当前命中的执行对象 */
  active: RunTarget;
  /** 指示器文案（不含「执行对象：」前缀） */
  hint: string;
}

/**
 * 由选区长度派生执行区全部文案。
 *
 * 🔴 集中一处的理由：按钮 label、指示器、单元测试三个消费者如果各自判断
 *    `selectedChars > 0`，迟早在边界上分叉（比如某处忘了「塌陷 ≠ 选中」）。
 */
export function executionScopeLegend(selectedChars: number): ExecutionScopeLegend {
  const active = targetOfSelection(selectedChars);
  return {
    runAll: runTargetLabel('all').label,
    runSelection: runTargetLabel(active).label,
    explain: runTargetLabel('explain').label,
    active,
    hint: executionTargetHint(selectedChars),
  };
}

export interface ConnectionTargetBadge {
  /** 连接名；找不到时退化为 connId，未选中时是「未选择连接」 */
  name: string;
  /** 环境名：优先用户自定义分组，其次「生产环境」，都没有则空串 */
  environment: string;
  /** 是否生产环境（红标签）—— 与 core-connection `isProduction` 同源 */
  production: boolean;
  /** 连接列表里是否真的命中该连接（false = 名字只能退化成 id，提示语要更谨慎） */
  known: boolean;
}

/**
 * 「这条 SQL 要往哪个连接、哪个环境执行」的展示模型。
 *
 * 🔴 唯一事实来源是连接配置本身（`connections` 来自后端 `connList()`），
 *    不读任何本地猜测 —— 环境判定直接调 `isProduction`，不在渲染层重写一遍
 *    `colorTag === 'red'`（那种复制就是漂移的种子）。
 */
export function describeConnectionTarget(
  connections: readonly ConnectionConfig[],
  connId: string | null,
): ConnectionTargetBadge {
  if (connId === null || connId === '') {
    return { name: '未选择连接', environment: '', production: false, known: false };
  }
  const cfg = connections.find((c) => c.id === connId);
  if (cfg === undefined) {
    // 列表还没加载完 / 连接刚被删：显示 id 而不是谎报一个名字
    return { name: connId, environment: '', production: false, known: false };
  }
  const production = isProduction(cfg);
  const group = (cfg.group ?? '').trim();
  const environment = group !== '' ? group : production ? '生产环境' : '';
  return { name: cfg.name, environment, production, known: true };
}
