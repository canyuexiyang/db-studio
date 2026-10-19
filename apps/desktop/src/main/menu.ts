/**
 * F1 macOS 原生菜单栏。
 *
 * 设计要点：
 *  - 菜单项点击【不在主进程做业务】，只把命令经 EVENT_MENU_COMMAND 推给渲染层，
 *    由 App 统一分派 —— 主进程不知道"当前激活的标签是什么"，也不该知道。
 *  - 模板构建是纯函数（buildMenuTemplate），不触碰任何 electron API，
 *    这样命令枚举 / 加速键 / role 结构可以在单测里直接断言（menu.test.ts）。
 *  - ⚠️ macOS 上菜单加速键会拦在菜单层，页面 keydown 收不到 —— 所以不会双重
 *    触发。App 既有的 window keydown 处理保留，作为纯浏览器 demo 的兜底。
 *  - ⌘W 刻意【不用】role:'close'：那会关掉整个窗口，这里必须转发"关闭标签"。
 *    同理 ⌘R 不用 role:'reload'（整页刷新会丢掉全部 tab 状态）。
 */

import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { EVENT_MENU_COMMAND } from '../shared/ipc-channels.js';
import { labelOf, acceleratorOf } from '../shared/action-catalog.js';

/**
 * 菜单命令枚举 —— 主进程 → 渲染层的全部菜单动作。
 * 渲染层 App 的分派表必须覆盖这里每一项（新增命令时两边同步）。
 */
export const MENU_COMMANDS = [
  // 文件
  'new-connection',
  'new-query',
  'close-tab',
  // 数据（T15：从「视图」移出的改数据/看数据动作）
  'save',
  'filter',
  'export',
  'import',
  'design-table',
  // T19：新增空白行（grid-add-row 复用目录里的标签与 ⌥⌘N）
  'grid-add-row',
  // 视图（只剩外观与面板）
  'open-palette',
  'refresh-schema',
  'font-zoom-in',
  'font-zoom-out',
  'font-zoom-reset',
  'toggle-theme',
  // 偏好设置（V5，macOS ⌘,）
  'open-preferences',
  // 应用维护（V21 自动更新）
  'check-update',
  // 窗口
  'next-tab',
  'prev-tab',
  // V23 多窗口：把当前表在新窗口打开（对照查看）
  'open-in-new-window',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export interface MenuTemplateInput {
  /** 应用名（仅非 macOS 生效；macOS 用 Info.plist 的 CFBundleName） */
  appName: string;
  /** 自定义项点击 → 转发命令到渲染层 */
  send: (cmd: MenuCommand) => void;
  /** 关于对话框（注入是为了单测不用碰 dialog） */
  showAbout: () => void;
}

/**
 * 构建菜单模板（纯函数，macOS 规范结构：应用/文件/编辑/视图/窗口）。
 * 角色项（编辑/窗口的基础动作）直接用 role —— 系统接管行为与本地化文案。
 *
 * 🔴 T11/T12：标签与加速键**一律从 action-catalog 取**（`labelOf` / `acceleratorOf`）。
 *    这份菜单曾经自带一套文案 + 键位，与渲染层局部 keydown 各写一遍，
 *    于是 ⌘R / ⇧⌘E / ⌘0 三处同键异义（报告 §4.2）。现在键位只有一处定义。
 */
export function buildMenuTemplate(input: MenuTemplateInput): MenuItemConstructorOptions[] {
  const { appName, send, showAbout } = input;
  /** 从目录取标签+键位（键位为 null 的项不带 accelerator） */
  const item = (cmd: MenuCommand): MenuItemConstructorOptions => {
    const acc = acceleratorOf(cmd);
    return { label: labelOf(cmd), ...(acc ? { accelerator: acc } : {}), click: () => send(cmd) };
  };

  return [
    {
      // ---- 应用菜单（macOS 第一个菜单，label 由系统接管） ----
      label: appName,
      submenu: [
        { label: '关于 DB Studio', click: () => showAbout() },
        { type: 'separator' },
        // V5：macOS 惯例 —— 应用菜单里的「偏好设置…」（⌘,）
        item('open-preferences'),
        { type: 'separator' },
        // V21：检查更新。目录里标了 accelerator: null —— 低频动作不该占全局键位。
        item('check-update'),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      // ---- 文件 ----
      label: '文件',
      submenu: [
        item('new-connection'),
        item('new-query'),
        { type: 'separator' },
        item('close-tab'),
      ],
    },
    {
      // ---- 编辑（全 role：文本编辑的基础能力，系统行为） ----
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      /**
       * ---- 数据 ----
       *
       * 🔴 T15（报告 §4.1）：`保存 / 筛选 / 导出 / 导入 / 设计表` 原本混在**视图**菜单里
       * —— 它们是**改数据或看数据**的动作，与「字体缩放 / 切换主题」不是一类。
       * 视图菜单里放着「导入数据…」，用户找它时第一反应是去看「文件」或「数据」。
       *
       * 约束（报告同段）：**不为了像 Navicat 而一次增加很多顶层菜单**。
       * 所以只新增这一个「数据」，且视图菜单同步瘦身 —— 顶层菜单总数不变。
       * 每个动作的四个维度（目标对象 / 是否可用 / 是否只改本地草稿 / 是否需 SQL 确认）
       * 由 `action-catalog` 单处维护。
       */
      label: '数据',
      submenu: [
        // 保存是唯一「把草稿变成写库」的入口，永远排第一且单独成组
        item('save'),
        { type: 'separator' },
        // T19：新增空白行（与筛选/导入同组 —— 都是「往表里加东西」的方向）
        item('grid-add-row'),
        item('filter'),
        { type: 'separator' },
        // 导入（写）与导出（读）方向相反，分开放，避免误点
        item('import'),
        item('export'),
        { type: 'separator' },
        item('design-table'),
      ],
    },
    {
      // ---- 视图（只剩「外观 / 面板」，不再混数据动作） ----
      label: '视图',
      submenu: [
        item('open-palette'),
        // 🔴 ⌘R 已归 SQL「执行全部」；刷新结构改用 ⇧⌘R（见 action-catalog 的裁定说明）
        item('refresh-schema'),
        { type: 'separator' },
        item('font-zoom-in'),
        item('font-zoom-out'),
        item('font-zoom-reset'),
        { type: 'separator' },
        item('toggle-theme'),
      ],
    },
    {
      // ---- 窗口 ----
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // V23：把当前标签在新窗口打开（对照查看两张表/两个库）。
        // ⚠️ 用 ⌘⇧N 而不是 ⌘N —— 后者已归「新建连接」，且 macOS 惯例 ⌘N 是新建。
        item('open-in-new-window'),
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        item('next-tab'),
        item('prev-tab'),
      ],
    },
  ];
}

/**
 * 关于对话框：简单信息框，不建独立窗口。
 * getWindow() 为 null（窗口还没建好/已关闭）时退化为无主窗口的弹窗。
 */
export function showAboutDialog(getWindow: () => BrowserWindow | null): void {
  const opts = {
    type: 'info' as const,
    title: '关于 DB Studio',
    message: `DB Studio v${app.getVersion()}`,
    // 文案口径来自项目定位（AGENTS.md §一）：一句话说清它是什么
    detail: `反应最快的 macOS 数据库查看器\nElectron ${process.versions.electron ?? '?'}`,
    buttons: ['好'],
  };
  const win = getWindow();
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

/**
 * 安装应用菜单。main.ts 在窗口创建后调用一次：
 *   installAppMenu(() => mainWindow);
 *
 * 非 darwin 直接 no-op：项目只做 macOS（PRD 非目标），其余平台的 role
 * 集合（hide/front 等）语义不齐，不做半吊子适配。
 */
export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  if (process.platform !== 'darwin') return;

  const send = (cmd: MenuCommand): void => {
    // 窗口可能已关闭（closed → null）：静默丢弃，菜单动作不值得报错
    getWindow()?.webContents.send(EVENT_MENU_COMMAND, { command: cmd });
  };

  const template = buildMenuTemplate({
    appName: app.name,
    send,
    showAbout: () => showAboutDialog(getWindow),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
