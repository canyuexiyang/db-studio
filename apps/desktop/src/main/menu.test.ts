/**
 * F1 菜单模板纯函数测试。
 *
 * 不构造真实 Menu（Electron 的 Menu 在无 GUI 环境不可用），
 * 只测模板结构与命令枚举的一致性 —— 这恰好是最容易改漏的部分：
 * 菜单里加了命令、渲染层分派表没跟上，表现为"点了菜单没反应"。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

//拦掉 electron：menu.ts 顶层有 value import，测试里只走纯函数路径
vi.mock('electron', () => ({
  app: { name: 'DB Studio', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn((t: unknown) => t),
    setApplicationMenu: vi.fn(),
  },
}));

import { buildMenuTemplate, installAppMenu, MENU_COMMANDS } from './menu.js';

/** MenuItemConstructorOptions 的测试视图（走 role/click/accelerator 三种形态） */
interface TestItem {
  label?: string;
  role?: string;
  accelerator?: string;
  type?: string;
  click?: (...args: unknown[]) => void;
  submenu?: TestItem[];
}

/** 深度收集非分隔线叶子项 */
function leaves(items: TestItem[]): TestItem[] {
  const out: TestItem[] = [];
  for (const it of items) {
    if (it.type === 'separator') continue;
    if (it.submenu) out.push(...leaves(it.submenu));
    else out.push(it);
  }
  return out;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildMenuTemplate：命令枚举一致性', () => {
  it('每个自定义命令恰好出现一次，且点击转发该命令', () => {
    const sent: string[] = [];
    const tpl = buildMenuTemplate({
      appName: 'DB Studio',
      send: (cmd) => sent.push(cmd),
      showAbout: () => undefined,
    });
    const all = leaves(tpl as TestItem[]);

    // 逐项【隔离】点击：每次点击前清空，看这一次点击恰好发出哪条命令。
    // （不能边遍历边看末值：不发包的项会"继承"上一次的末值造成误判）
    const senders = new Map<string, number>();
    for (const it of all) {
      if (!it.click) continue;
      sent.length = 0;
      it.click();
      expect(sent.length, `菜单项「${it.label ?? it.role}」一次点击应至多发一条命令`).toBeLessThanOrEqual(1);
      if (sent.length === 1) senders.set(sent[0], (senders.get(sent[0]) ?? 0) + 1);
    }

    for (const cmd of MENU_COMMANDS) {
      expect(senders.get(cmd), `命令 ${cmd} 应恰好由一个菜单项触发`).toBe(1);
    }
    // 发包的菜单项与枚举完全一一对应（没有枚举之外的命令，也没有重复项）
    expect([...senders.keys()].sort()).toEqual([...MENU_COMMANDS].sort());
    expect(senders.size).toBe(MENU_COMMANDS.length);
  });

  it('加速键与规格一致（⌘N/⌘T/⌘W/⌘K/⌘S/⌘R/⌘=、⌘⇧F、⌃Tab…）', () => {
    const tpl = buildMenuTemplate({ appName: 'DB Studio', send: () => undefined, showAbout: () => undefined });
    const all = leaves(tpl as TestItem[]);
    const acc = (label: string): string | undefined =>
      all.find((it) => it.label === label)?.accelerator;

    expect(acc('新建连接…')).toBe('CmdOrCtrl+N');
    expect(acc('新建查询标签')).toBe('CmdOrCtrl+T');
    expect(acc('关闭标签')).toBe('CmdOrCtrl+W');
    expect(acc('命令面板…')).toBe('CmdOrCtrl+K');
    expect(acc('保存修改…')).toBe('CmdOrCtrl+S');
    expect(acc('筛选…')).toBe('Shift+CmdOrCtrl+F');
    expect(acc('导出数据…')).toBe('Shift+CmdOrCtrl+E');
    expect(acc('导入数据…')).toBe('Shift+CmdOrCtrl+I');
    expect(acc('设计表…')).toBe('Shift+CmdOrCtrl+D');
    expect(acc('刷新表结构')).toBe('CmdOrCtrl+R');
    expect(acc('字体放大')).toBe('CmdOrCtrl+=');
    expect(acc('字体缩小')).toBe('CmdOrCtrl+-');
    expect(acc('重置字体')).toBe('CmdOrCtrl+0');
    // V5：偏好设置走 macOS 惯例 ⌘,
    expect(acc('偏好设置…')).toBe('CmdOrCtrl+,');
    expect(acc('下一个标签')).toBe('Ctrl+Tab');
    expect(acc('上一个标签')).toBe('Ctrl+Shift+Tab');
    // V23：⌘⇧N（⌘N 已归「新建连接」，别抢）
    expect(acc('在新窗口打开当前表')).toBe('Shift+CmdOrCtrl+N');
    // V21：检查更新刻意不给加速键（低频动作不占全局键位）
    expect(acc('检查更新…')).toBeUndefined();
    // 切换主题刻意不给加速键（面板/工具栏已有入口，别再占一个全局键）
    expect(acc('切换主题')).toBeUndefined();
  });

  it('编辑/窗口菜单走 role；⌘W 与 ⌘R 绝不用 close/reload role（会毁掉 tab 状态）', () => {
    const tpl = buildMenuTemplate({ appName: 'DB Studio', send: () => undefined, showAbout: () => undefined });
    const all = leaves(tpl as TestItem[]);
    const roles = all.map((it) => it.role).filter(Boolean);

    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize', 'zoom', 'front', 'hide', 'quit']) {
      expect(roles).toContain(r);
    }
    // 防回归：有人图省事把 role 换成 close/reload，⌘W 就会关窗口而不是关标签
    expect(roles).not.toContain('close');
    expect(roles).not.toContain('reload');
  });

  it('应用菜单含「关于 DB Studio」且点击触发 showAbout', () => {
    let about = 0;
    const tpl = buildMenuTemplate({ appName: 'DB Studio', send: () => undefined, showAbout: () => about++ });
    const appMenu = (tpl as TestItem[])[0];
    const item = leaves(appMenu.submenu ?? []).find((it) => it.label === '关于 DB Studio');
    expect(item?.click).toBeTruthy();
    item!.click!();
    expect(about).toBe(1);
  });
});

describe('installAppMenu', () => {
  it('非 darwin 平台 no-op（项目只做 macOS，不做半吊子适配）', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const electron = await import('electron');
      installAppMenu(() => null);
      expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('darwin 平台调用 setApplicationMenu', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const electron = await import('electron');
      installAppMenu(() => null);
      expect(electron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
