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

/**
 * 菜单命令枚举 —— 主进程 → 渲染层的全部菜单动作。
 * 渲染层 App 的分派表必须覆盖这里每一项（新增命令时两边同步）。
 */
export const MENU_COMMANDS = [
  // 文件
  'new-connection',
  'new-query',
  'close-tab',
  // 视图
  'open-palette',
  'save',
  'filter',
  'export',
  'import',
  'design-table',
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
 */
export function buildMenuTemplate(input: MenuTemplateInput): MenuItemConstructorOptions[] {
  const { appName, send, showAbout } = input;
  return [
    {
      // ---- 应用菜单（macOS 第一个菜单，label 由系统接管） ----
      label: appName,
      submenu: [
        { label: '关于 DB Studio', click: () => showAbout() },
        { type: 'separator' },
        // V5：macOS 惯例 —— 应用菜单里的「偏好设置…」（⌘,）
        { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', click: () => send('open-preferences') },
        { type: 'separator' },
        // V21：检查更新。加速键不给 —— 低频动作不该占全局键位。
        { label: '检查更新…', click: () => send('check-update') },
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
        { label: '新建连接…', accelerator: 'CmdOrCtrl+N', click: () => send('new-connection') },
        { label: '新建查询标签', accelerator: 'CmdOrCtrl+T', click: () => send('new-query') },
        { type: 'separator' },
        { label: '关闭标签', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
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
      // ---- 视图 ----
      label: '视图',
      submenu: [
        { label: '命令面板…', accelerator: 'CmdOrCtrl+K', click: () => send('open-palette') },
        { label: '保存修改…', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '筛选…', accelerator: 'Shift+CmdOrCtrl+F', click: () => send('filter') },
        { label: '导出数据…', accelerator: 'Shift+CmdOrCtrl+E', click: () => send('export') },
        { label: '导入数据…', accelerator: 'Shift+CmdOrCtrl+I', click: () => send('import') },
        { label: '设计表…', accelerator: 'Shift+CmdOrCtrl+D', click: () => send('design-table') },
        { label: '刷新表结构', accelerator: 'CmdOrCtrl+R', click: () => send('refresh-schema') },
        { type: 'separator' },
        { label: '字体放大', accelerator: 'CmdOrCtrl+=', click: () => send('font-zoom-in') },
        { label: '字体缩小', accelerator: 'CmdOrCtrl+-', click: () => send('font-zoom-out') },
        { label: '重置字体', accelerator: 'CmdOrCtrl+0', click: () => send('font-zoom-reset') },
        { type: 'separator' },
        { label: '切换主题', click: () => send('toggle-theme') },
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
        { label: '在新窗口打开当前表', accelerator: 'Shift+CmdOrCtrl+N', click: () => send('open-in-new-window') },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { label: '下一个标签', accelerator: 'Ctrl+Tab', click: () => send('next-tab') },
        { label: '上一个标签', accelerator: 'Ctrl+Shift+Tab', click: () => send('prev-tab') },
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
