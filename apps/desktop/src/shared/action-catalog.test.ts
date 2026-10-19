import { describe, it, expect, vi } from 'vitest';

// 拦掉 electron：menu.ts 顶层有 value import（只为拿 MENU_COMMANDS 这份命令枚举）
vi.mock('electron', () => ({
  app: { name: 'DB Studio', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn((t: unknown) => t), setApplicationMenu: vi.fn() },
}));

import {
  ACTIONS,
  ACTIONS_BY_ID,
  acceleratorOf,
  displayOf,
  labelOf,
  keySignature,
  findAcceleratorConflicts,
  findCrossLayerConflicts,
  toDisplay,
  type ActionEntry,
} from './action-catalog.js';
import { MENU_COMMANDS } from '../main/menu.js';

/**
 * T11 / R05：动作目录的**可检测**证据。
 *
 * 🔴 这组断言的意义不在于"覆盖代码"，而在于把报告 §4.2 的病根钉住：
 *    键位冲突的根因是三处各写一遍，一旦有人再往某处加一个手写键位，
 *    `findCrossLayerConflicts` 就会从「空数组」变成非空 ⇒ 这里立刻红。
 *    旧代码里 ⌘R / ⇧⌘E / ⌘0 三处同键异义，跑完整套 e2e 都发现不了 ——
 *    因为「菜单层吞掉 LOCAL 键」这件事在 DOM 层根本观测不到。
 */

describe('action-catalog：目录自身的完整性', () => {
  it('id 唯一（命令分派/测试靠 id 定位，重复会让分派静默错位）', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条动作都有非空 label 与非空 surfaces', () => {
    for (const a of ACTIONS) {
      expect(a.label.trim(), `${a.id} 缺 label`).not.toBe('');
      expect(a.surfaces.length, `${a.id} 没有入口`).toBeGreaterThan(0);
      expect(a.availableWhen.trim(), `${a.id} 缺可用条件`).not.toBe('');
    }
  });

  it('display 由 accelerator 派生（禁止手写展示串）', () => {
    for (const a of ACTIONS) {
      expect(a.display, `${a.id} 的 display 与 accelerator 不一致`).toBe(toDisplay(a.accelerator));
    }
  });

  it('局部 scope 的动作一律不进原生菜单（菜单不认领它们的键位，否则又是跨层抢键）', () => {
    for (const a of ACTIONS) {
      if (a.scope !== 'global') {
        expect(
          (MENU_COMMANDS as readonly string[]).includes(a.id),
          `${a.id}（scope=${a.scope}）不该出现在原生菜单里`,
        ).toBe(false);
      }
    }
  });
});

describe('action-catalog：R05 冲突裁定（报告 §4.2）', () => {
  it('同层内无键位冲突', () => {
    expect(findAcceleratorConflicts()).toEqual([]);
  });

  it('局部层不与全局层撞键（撞了会被原生菜单抢先拦截 ⇒ 局部永远收不到）', () => {
    expect(findCrossLayerConflicts()).toEqual([]);
  });

  it('反例：人为造一个跨层撞键，必须被判出来（断言本身要有证伪能力）', () => {
    const broken: ActionEntry[] = [
      { ...ACTIONS_BY_ID['refresh-schema'], id: 'x-global', accelerator: 'Shift+CmdOrCtrl+E' },
      { ...ACTIONS_BY_ID['sql-explain'], id: 'x-local' },
    ];
    // x-global 用了 ⇧⌘E，与 x-local 的 ⇧⌘X 不同？—— 先确认未撞
    expect(findCrossLayerConflicts(broken)).toEqual([]);
    // 再把两者改成同键，必须报出来
    const reallyBroken: ActionEntry[] = [
      { ...ACTIONS_BY_ID['export'], id: 'g' },
      { ...ACTIONS_BY_ID['sql-explain'], id: 'l', accelerator: 'Shift+CmdOrCtrl+E' },
    ];
    expect(findCrossLayerConflicts(reallyBroken).length).toBe(1);
  });

  it('反例：同层撞键必须报出', () => {
    const broken: ActionEntry[] = [
      { ...ACTIONS_BY_ID['font-zoom-in'], id: 'a', accelerator: 'CmdOrCtrl+P' },
      { ...ACTIONS_BY_ID['font-zoom-out'], id: 'b', accelerator: 'Cmd+P' },
    ];
    expect(findAcceleratorConflicts(broken).length).toBe(1);
  });

  it('⌘R 唯归 SQL 执行全部；刷新结构在 ⇧⌘R（原 ⌘R 是 R05 的现场）', () => {
    expect(ACTIONS_BY_ID['sql-run-all'].accelerator).toBe('CmdOrCtrl+R');
    expect(ACTIONS_BY_ID['refresh-schema'].accelerator).toBe('Shift+CmdOrCtrl+R');
  });

  it('⇧⌘E 唯归导出数据（SQL EXPLAIN / 网格表达式模式必须让位）', () => {
    expect(ACTIONS_BY_ID['export'].accelerator).toBe('Shift+CmdOrCtrl+E');
    expect(ACTIONS_BY_ID['sql-explain'].accelerator).toBe('Shift+CmdOrCtrl+X');
    expect(ACTIONS_BY_ID['grid-expr-mode'].accelerator).toBe('CmdOrCtrl+E');
  });

  it('⌘0 唯归重置字体；网格设 NULL 让位到 ⌥0（数据动作不该被外观动作吃掉）', () => {
    expect(ACTIONS_BY_ID['font-zoom-reset'].accelerator).toBe('CmdOrCtrl+0');
    expect(ACTIONS_BY_ID['grid-set-null'].accelerator).toBe('Alt+0');
  });
});

describe('action-catalog：键位归一化', () => {
  it('Cmd/Ctrl/Command 等价，Return/Enter 等价，修饰符顺序无关', () => {
    expect(keySignature('CmdOrCtrl+Return')).toBe(keySignature('Cmd+Enter'));
    expect(keySignature('Shift+CmdOrCtrl+E')).toBe(keySignature('Cmd+Shift+E'));
    expect(keySignature('CmdOrCtrl+R')).not.toBe(keySignature('Shift+CmdOrCtrl+R'));
  });

  it('展示串按 macOS 习惯渲染', () => {
    expect(displayOf('sql-run-all')).toBe('⌘R');
    expect(displayOf('refresh-schema')).toBe('⇧⌘R');
    expect(displayOf('grid-set-null')).toBe('⌥0');
    expect(displayOf('sql-run-selection')).toBe('⌘⏎');
    expect(displayOf('toggle-theme')).toBeNull(); // 无键位动作
  });
});

describe('action-catalog：与原生菜单的契约', () => {
  it('每条 MENU_COMMANDS 都能在目录里查到 label 与 id（菜单文案不许另写一份）', () => {
    for (const cmd of MENU_COMMANDS) {
      const entry = ACTIONS_BY_ID[cmd];
      expect(entry, `菜单命令 ${cmd} 不在动作目录里`).toBeDefined();
      expect(labelOf(cmd)).toBe(entry.label);
      // acceleratorOf 允许 undefined（无键位动作）
      expect(acceleratorOf(cmd)).toBe(entry.accelerator ?? undefined);
    }
  });

  it('反过来：所有 surfaces 含 menu 的动作都必须在 MENU_COMMANDS 里（否则菜单项是死的）', () => {
    for (const a of ACTIONS) {
      if (a.surfaces.includes('menu')) {
        // 例外：sql-* 与 grid-* 与 tree-* 是局部动作，虽可出现在「命令面板」
        // 但不上原生菜单；这里只要求 menu 入口的动作必须被主进程知道。
        expect(
          (MENU_COMMANDS as readonly string[]).includes(a.id),
          `${a.id} 声称有 menu 入口，但 MENU_COMMANDS 里没有它`,
        ).toBe(true);
      }
    }
  });
});
