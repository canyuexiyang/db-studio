/**
 * 动作目录 —— 「动作 / 入口 / 快捷键 / 可用条件」的**唯一事实来源**（T11 / I04 / R05）。
 *
 * ## 为什么要有这张表
 *
 * 调研报告 §4.2 列出的冲突，根因不是「有人写错了键」，而是**同一个动作的键位被三处
 * 各写一遍**：`main/menu.ts`（原生菜单 accelerator）、`App.tsx`（window keydown）、
 * `DataGrid.tsx` / `SqlEditorCore.ts` / `TreeView.tsx`（局部 keydown）。三份各自演变，
 * 结果是：
 *
 * | 键 | 原生菜单 | 局部 | 后果 |
 * |---|---|---|---|
 * | ⌘R | 刷新表结构 | SQL 执行全部 | 菜单层先拦截 → SQL 侧永远收不到 |
 * | ⇧⌘E | 导出数据 | SQL EXPLAIN / 网格表达式模式 | 同上，三义冲突 |
 * | ⌘0 | 重置字体 | 网格设为 NULL | 数据动作被外观动作吃掉 |
 *
 * 所以这里建一张表：**每个动作的键位只在这里定义一次**。菜单从这里取 accelerator，
 * 渲染层从这里取匹配规则，文档从这张表生成（`scripts/gen-action-doc.mjs`）。
 *
 * ## 裁定原则（报告 §4.2 的逐项裁定）
 *
 *  1. **原生菜单优先**：macOS 的菜单 accelerator 会拦在页面 keydown 之前，
 *     所以凡是「菜单有、局部也有」的键，实际只有菜单那份会触发 ——
 *     要么把局部的挪走，要么把菜单的改掉，不能装作两个都生效。
 *  2. **高频动作拿短键**：SQL 执行是会话内最高频动作，⌘R 归它；刷新**结构**低频，
 *     挪到 ⇧⌘R（macOS「重新加载」的惯例键）。
 *  3. **一个键在任一瞬间只触发一个动作**：靠 scope 分层保证（见 assertNoConflicts）。
 */

export type ActionScope = 'global' | 'table' | 'grid' | 'sql' | 'tree' | 'dialog';

/**
 * 动作的**目标对象**（T15 §8.1 四维度之一）。
 *
 * 为什么单独一维：用户问「这一项动的是谁？」—— 是应用本身（切主题）、当前连接
 * （刷新结构）、当前表（保存/筛选）、还是当前行/格（复制行、设为 NULL）。
 * 三个维度（是否可用 / 是否只改草稿 / 是否要 SQL 确认）都答不了这个问题。
 */
export type ActionTarget =
  | 'app'
  | 'connection'
  | 'database'
  | 'table'
  | 'row'
  | 'cell'
  | 'tab'
  | 'sql'
  | 'window';

export interface ActionEntry {
  /** 稳定 id（命令面板 / 菜单分派 / 测试都用它） */
  id: string;
  /** 中文标签 —— 菜单、tooltip、命令面板共用同一条，不允许各处另写 */
  label: string;
  /**
   * Electron accelerator（如 `CmdOrCtrl+R`）。null = 该动作没有全局键位。
   * 🔴 只有 scope 的第一层（global / 上下文根）才允许有 accelerator ——
   *    局部 scope 的键位由各自 keydown 处理，写在这里会与菜单层冲突。
   */
  accelerator: string | null;
  /** 桌面展示串（tooltip / 右键菜单用），由 accelerator 派生，保证不手写错 */
  display: string | null;
  /** 出现在哪些入口 */
  surfaces: (
    | 'menu'
    | 'palette'
    | 'toolbar'
    | 'grid-toolbar'
    | 'tree-context'
    | 'grid-context'
    | 'cell-context'
    | 'column-context'
    | 'tab-context'
    | 'sql-toolbar'
    | 'sql-context'
  )[];
  scope: ActionScope;
  /** 目标对象（四维度之一）：这个动作动的是谁 */
  target: ActionTarget;
  /** 可用条件（人话）。禁用时 tooltip/菜单项据此解释原因 —— 报告 §8.1 的「四维度」之一 */
  availableWhen: string;
  /** 是否只改本地草稿（不写库）。四维度之二 */
  localDraftOnly: boolean;
  /** 是否需要 SQL 确认（写库前必须预演原文）。四维度之三 */
  requiresSqlConfirm: boolean;
  /** 备注：裁定理由 */
  note?: string;
}

/** Electron accelerator → 桌面展示串（供 tooltip/右键菜单） */
export function toDisplay(acc: string | null): string | null {
  if (!acc) return null;
  return acc
    .replace(/CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Shift/g, '⇧')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Return|Enter/g, '⏎')
    .replace(/Backspace/g, '⌫')
    .replace(/Delete/g, '⌫')
    .replace(/Plus/g, '+')
    .replace(/\+/g, '');
}

// ---------- 事实表 ----------

type Raw = Omit<ActionEntry, 'display'>;

const RAW: Raw[] = [
  // ===== 文件 =====
  { id: 'new-connection', target: 'connection', label: '新建连接…', accelerator: 'CmdOrCtrl+N', surfaces: ['menu', 'palette', 'tree-context'], scope: 'global', availableWhen: '始终可用', localDraftOnly: false, requiresSqlConfirm: false },
  { id: 'new-query', target: 'tab', label: '新建查询标签', accelerator: 'CmdOrCtrl+T', surfaces: ['menu', 'palette', 'toolbar', 'tree-context'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'close-tab', target: 'tab', label: '关闭标签', accelerator: 'CmdOrCtrl+W', surfaces: ['menu', 'tab-context'], scope: 'global', availableWhen: '有激活标签；有未保存改动时先确认', localDraftOnly: false, requiresSqlConfirm: false },
  { id: 'open-palette', target: 'app', label: '命令面板…', accelerator: 'CmdOrCtrl+K', surfaces: ['menu', 'toolbar'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== 视图 / 数据 =====
  { id: 'save', target: 'table', label: '保存修改…', accelerator: 'CmdOrCtrl+S', surfaces: ['menu', 'palette', 'toolbar'], scope: 'global', availableWhen: '表标签且有待提交改动；SQL 标签下改为保存片段', localDraftOnly: false, requiresSqlConfirm: true, note: '裁定：⌘S 归「保存表修改」。SQL 标签下必须给出明确反馈（打开保存片段对话框），不能静默无响应' },
  { id: 'filter', target: 'table', label: '筛选…', accelerator: 'Shift+CmdOrCtrl+F', surfaces: ['menu', 'palette', 'toolbar', 'column-context'], scope: 'global', availableWhen: '表标签', localDraftOnly: false, requiresSqlConfirm: false },
  { id: 'export', target: 'table', label: '导出数据…', accelerator: 'Shift+CmdOrCtrl+E', surfaces: ['menu', 'palette', 'toolbar', 'tree-context', 'sql-toolbar'], scope: 'global', availableWhen: '表标签 / 查询结果', localDraftOnly: false, requiresSqlConfirm: false, note: '裁定：⇧⌘E 唯归导出。SQL 的 EXPLAIN 与网格的表达式模式必须让位' },
  { id: 'import', target: 'table', label: '导入数据…', accelerator: 'Shift+CmdOrCtrl+I', surfaces: ['menu', 'palette', 'toolbar', 'tree-context'], scope: 'global', availableWhen: '表标签；只读连接禁用', localDraftOnly: false, requiresSqlConfirm: true },
  { id: 'design-table', target: 'table', label: '设计表…', accelerator: 'Shift+CmdOrCtrl+D', surfaces: ['menu', 'palette', 'toolbar', 'tree-context'], scope: 'global', availableWhen: '表标签 / 树表对象；只读连接禁用', localDraftOnly: false, requiresSqlConfirm: true },
  {
    id: 'refresh-schema',
    target: 'connection',
    label: '刷新表结构',
    accelerator: 'Shift+CmdOrCtrl+R',
    surfaces: ['menu', 'palette', 'tree-context'],
    scope: 'global',
    availableWhen: '已连接',
    localDraftOnly: false,
    requiresSqlConfirm: false,
    note: '🔴 裁定：原为 ⌘R，与 SQL「执行全部」同键，而菜单层会先拦截 ⇒ SQL 侧永远收不到。刷新结构是低频动作，让位给 SQL 执行并改用 macOS「重新加载」惯例键 ⇧⌘R',
  },

  // ===== 外观 =====
  { id: 'font-zoom-in', target: 'app', label: '字体放大', accelerator: 'CmdOrCtrl+=', surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'font-zoom-out', target: 'app', label: '字体缩小', accelerator: 'CmdOrCtrl+-', surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'font-zoom-reset', target: 'app', label: '重置字体', accelerator: 'CmdOrCtrl+0', surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false, note: '🔴 裁定：⌘0 唯归「重置字体」。网格「设为 NULL」让位到 ⌥0（数据动作不该被外观动作吃掉）' },
  { id: 'toggle-theme', target: 'app', label: '切换主题', accelerator: null, surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== 应用菜单 =====
  { id: 'open-preferences', target: 'app', label: '偏好设置…', accelerator: 'CmdOrCtrl+,', surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'check-update', target: 'app', label: '检查更新…', accelerator: null, surfaces: ['menu', 'palette'], scope: 'global', availableWhen: '始终可用', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== 窗口 / 标签 =====
  { id: 'open-in-new-window', target: 'table', label: '在新窗口打开当前表', accelerator: 'Shift+CmdOrCtrl+N', surfaces: ['menu', 'palette', 'tab-context'], scope: 'global', availableWhen: '表标签', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'next-tab', target: 'tab', label: '下一个标签', accelerator: 'Ctrl+Tab', surfaces: ['menu'], scope: 'global', availableWhen: '有多个标签', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'prev-tab', target: 'tab', label: '上一个标签', accelerator: 'Ctrl+Shift+Tab', surfaces: ['menu'], scope: 'global', availableWhen: '有多个标签', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== SQL（scope: sql）=====
  {
    id: 'sql-run-all',
    target: 'sql',
    label: '执行全部',
    accelerator: 'CmdOrCtrl+R',
    surfaces: ['sql-toolbar', 'sql-context'],
    scope: 'sql',
    availableWhen: 'SQL 标签且已连库且非空',
    localDraftOnly: false,
    requiresSqlConfirm: true,
    note: '🔴 裁定：⌘R 归 SQL 执行全部（会话内最高频）；刷新表结构让位到 ⇧⌘R。原方案是「菜单刷新结构 + 局部执行全部」，菜单层先拦截 ⇒ SQL 侧实际按不动',
  },
  {
    id: 'sql-run-selection',
    target: 'sql',
    label: '执行选中（无选区 = 当前语句）',
    accelerator: 'CmdOrCtrl+Return',
    surfaces: ['sql-toolbar', 'sql-context'],
    scope: 'sql',
    availableWhen: 'SQL 标签且已连库',
    localDraftOnly: false,
    requiresSqlConfirm: true,
    note: '裁定：原 ⇧⌘R 让位给刷新结构；改用行业惯例 ⌘⏎（DataGrip / VS Code 同键）',
  },
  { id: 'sql-explain', target: 'sql', label: '执行计划（EXPLAIN）', accelerator: 'Shift+CmdOrCtrl+X', surfaces: ['sql-toolbar', 'sql-context'], scope: 'sql', availableWhen: 'SQL 标签且已连库', localDraftOnly: false, requiresSqlConfirm: false, note: '裁定：⇧⌘E 已被「导出数据」占用，EXPLAIN 改用 ⇧⌘X（X = eXplain）' },
  { id: 'sql-cancel', target: 'sql', label: '取消执行', accelerator: 'CmdOrCtrl+.', surfaces: ['sql-toolbar'], scope: 'sql', availableWhen: '有正在执行的查询', localDraftOnly: false, requiresSqlConfirm: false },
  { id: 'sql-format', target: 'sql', label: '格式化 SQL', accelerator: 'CmdOrCtrl+I', surfaces: ['sql-context', 'sql-toolbar'], scope: 'sql', availableWhen: 'SQL 标签且非空', localDraftOnly: true, requiresSqlConfirm: false, note: '报告 §4.2：当前实现就是 ⌘I，不是 ⇧⌘F —— 以代码事实为准，不按印象列冲突' },
  { id: 'sql-comment', target: 'sql', label: '注释 / 取消注释', accelerator: 'CmdOrCtrl+/', surfaces: ['sql-context'], scope: 'sql', availableWhen: 'SQL 标签且有选区或光标', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'sql-save-snippet', target: 'sql', label: '保存为片段…', accelerator: null, surfaces: ['sql-toolbar', 'sql-context'], scope: 'sql', availableWhen: 'SQL 标签且非空', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== 网格（scope: grid）=====
  { id: 'grid-set-null', target: 'cell', label: '设为 NULL', accelerator: 'Alt+0', surfaces: ['cell-context', 'grid-context'], scope: 'grid', availableWhen: '单元格可写且非只读连接', localDraftOnly: true, requiresSqlConfirm: false, note: '🔴 裁定：原 ⌘0 与「重置字体」同键且被菜单层吃掉 ⇒ 改为 ⌥0' },
  { id: 'grid-delete-rows', target: 'row', label: '删除选中行', accelerator: 'CmdOrCtrl+Backspace', surfaces: ['grid-context', 'cell-context'], scope: 'grid', availableWhen: '有主键/唯一键且非只读连接', localDraftOnly: false, requiresSqlConfirm: true },
  { id: 'grid-duplicate-row', target: 'row', label: '复制行', accelerator: 'CmdOrCtrl+D', surfaces: ['cell-context', 'grid-context'], scope: 'grid', availableWhen: '表可编辑；追加行无需定位键', localDraftOnly: true, requiresSqlConfirm: false },
  /**
   * T19（报告 §5 D16）：新增空白行。
   *
   * 🔴 键位裁定：⌘+ 在 TablePlus 是「加行」、在本项目已归「放大字体」；⌘N 归「新建查询」。
   *    取 **⌥⌘N**（N = New row）—— 与 ⌘N / ⇧⌘N 同族、语义一眼可辨，且与现有全部键不冲突
   *    （`findAcceleratorConflicts()` 单测钉住）。
   * ⚠️ 与 ⌘D 的分工：复制行需要**源行**，空表上只有本动作成立 —— 两者不是替代关系，
   *    工具栏/右键都并列给出，避免用户面对空表找不到「加一行」的入口。
   *
   * 🔴 scope 为什么是 `global` 而不是 `grid`：任务要求「工具栏 + 菜单 + 行号右键」三处入口，
   *    而目录的硬规则是**局部 scope 的动作一律不进原生菜单**（否则菜单会认领该键位、
   *    在错误的焦点下抢键 —— 正是 T11/T12 修的 ⌘R/⇧⌘E/⌘0 那一类缺陷）。
   *    所以这里与 `filter` / `design-table` / `import` 同款：声明 global + 写清真实约束，
   *    由渲染层在菜单分派处按上下文兜底（无表标签时明确提示，不静默）。
   */
  { id: 'grid-add-row', target: 'row', label: '新增空白行', accelerator: 'Alt+CmdOrCtrl+N', surfaces: ['menu', 'palette', 'grid-toolbar', 'grid-context', 'cell-context'], scope: 'global', availableWhen: '表标签且表可编辑；只读连接禁用', localDraftOnly: true, requiresSqlConfirm: false },
  { id: 'grid-expr-mode', target: 'cell', label: '切换 SQL 表达式模式', accelerator: 'CmdOrCtrl+E', surfaces: ['cell-context'], scope: 'grid', availableWhen: '仅单元格编辑态', localDraftOnly: true, requiresSqlConfirm: false, note: '🔴 裁定：原 ⇧⌘E 与「导出数据」同键且被菜单吃掉 ⇒ 编辑态改 ⌘E' },
  { id: 'grid-search', target: 'table', label: '查找本页（本地）', accelerator: 'CmdOrCtrl+F', surfaces: ['grid-toolbar'], scope: 'grid', availableWhen: '表标签', localDraftOnly: true, requiresSqlConfirm: false, note: '范围明确为「本页已加载行」，不是服务端检索' },
  { id: 'grid-column-finder', target: 'table', label: '列快速定位', accelerator: 'F12', surfaces: ['grid-toolbar', 'palette'], scope: 'grid', availableWhen: '表标签', localDraftOnly: true, requiresSqlConfirm: false },

  // ===== 树（scope: tree）=====
  {
    id: 'tree-design-table',
    target: 'table',
    label: '设计表…',
    accelerator: 'F2',
    surfaces: ['tree-context'],
    scope: 'tree',
    availableWhen: '树中选中表对象；只读连接禁用',
    localDraftOnly: false,
    requiresSqlConfirm: true,
    note: '报告 §4.2：F2 旧文案写「重命名」，实际行为是**进入表设计器**（不是树内改名）。文案已按真实行为统一为「设计表…」',
  },
  { id: 'tree-delete-object', target: 'table', label: '删除表…', accelerator: 'Delete', surfaces: ['tree-context'], scope: 'tree', availableWhen: '树中选中表对象；只读连接禁用', localDraftOnly: false, requiresSqlConfirm: true },
];

export const ACTIONS: ActionEntry[] = RAW.map((a) => ({ ...a, display: toDisplay(a.accelerator) }));

export const ACTIONS_BY_ID: Record<string, ActionEntry> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a]),
);

/** 取某动作的 Electron accelerator（菜单构建用） */
export function acceleratorOf(id: string): string | undefined {
  const a = ACTIONS_BY_ID[id];
  return a?.accelerator ?? undefined;
}

/** 取某动作的桌面展示串（tooltip / 右键菜单用） */
export function displayOf(id: string): string | null {
  return ACTIONS_BY_ID[id]?.display ?? null;
}

/** 取标签（菜单/tooltip/命令面板共用，禁止各处另写） */
export function labelOf(id: string): string {
  return ACTIONS_BY_ID[id]?.label ?? id;
}

/**
 * 把 accelerator 归一成「键位签名」，用于查重。
 *
 * 归一化内容：大小写、修饰符别名（`CmdOrCtrl`/`Cmd`/`Command`/`Meta` → cmd，
 * `Ctrl`/`Control` → ctrl，`Alt`/`Option` → alt）、`Return`/`Enter`、修饰符书写顺序。
 * 这样 `CmdOrCtrl+Return` 与 `Cmd+Enter` 会被判为同一个键。
 *
 * 🔴 `CmdOrCtrl` 是 Electron accelerator 的**标准写法**（全目录都在用）。
 *    它必须映射成 cmd —— 早先只认 `Cmd`/`Command`，于是 `CmdOrCtrl+P` 归一成
 *    `p`、`Cmd+P` 归一成 `cmd+p`，两者**被判成不同键** ⇒ 查重静默放行。
 *    （`action-catalog.test.ts` 的「反例必须报出」用例抓到的就是这个假阴性：
 *      没有修饰符的 `F12` 会与 `CmdOrCtrl+F12` 撞签名。）
 */
const MOD_ALIAS: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  cmdorctrl: 'cmd',
  cmdorcontrol: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

export function keySignature(acc: string): string {
  const parts = acc.split('+').map((p) => p.trim().toLowerCase());
  const mods = new Set<string>();
  for (const m of parts.slice(0, -1)) {
    const norm = MOD_ALIAS[m];
    if (norm) mods.add(norm);
    else mods.add(m); // 未知修饰符原样保留，宁可多报也不漏报
  }
  const key = parts[parts.length - 1] ?? '';
  const normKey = key === 'enter' ? 'return' : key;
  return [...['cmd', 'shift', 'alt', 'ctrl'].filter((m) => mods.has(m)), normKey].join('+');
}

/**
 * 查重：在**同一作用域层**里不允许两个动作共用同一个键。
 *
 * 为什么要分层：`⌘R` 在 SQL 标签里是「执行全部」，在全局面板里不该同时触发别的 ——
 * 但 `F12` 只在网格、`⌘F` 只在网格，与全局 `⌘K` 不冲突。所以冲突判定只在
 * 「global」层内、以及「同一局部 scope」内进行；跨层不算冲突（焦点决定谁生效）。
 *
 * @returns 冲突描述数组，空 = 无冲突
 */
export function findAcceleratorConflicts(actions: ActionEntry[] = ACTIONS): string[] {
  const conflicts: string[] = [];
  const buckets = new Map<string, ActionEntry[]>();
  for (const a of actions) {
    if (!a.accelerator) continue;
    // 全局层与各局部层各自成桶
    const key = `${a.scope}\u0000${keySignature(a.accelerator)}`;
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }
  for (const [key, list] of buckets) {
    if (list.length > 1) {
      const [scope, sig] = key.split('\u0000');
      conflicts.push(`scope=${scope} 键位 ${sig}：${list.map((a) => a.id).join(' / ')}`);
    }
  }
  return conflicts;
}

/**
 * 跨层冲突：局部 scope 的动作若与 **global 层** 共用同一个键，实际会被原生菜单
 * 抢先拦截（macOS 菜单 accelerator 优先于页面 keydown）⇒ 必须报出来。
 *
 * 这正是 R05 的根因，所以它必须是「可检测的错误」而不是靠人记住。
 */
export function findCrossLayerConflicts(actions: ActionEntry[] = ACTIONS): string[] {
  const globalSigs = new Set<string>();
  for (const a of actions) {
    if (a.accelerator && a.scope === 'global') globalSigs.add(keySignature(a.accelerator));
  }
  const out: string[] = [];
  for (const a of actions) {
    if (!a.accelerator || a.scope === 'global') continue;
    if (globalSigs.has(keySignature(a.accelerator))) {
      out.push(`${a.id}（scope=${a.scope}）的 ${a.accelerator} 与全局键位冲突 —— 会被原生菜单抢先拦截`);
    }
  }
  return out;
}
