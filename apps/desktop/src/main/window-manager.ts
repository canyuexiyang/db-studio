/**
 * V23 多窗口
 *
 * 定位：**同一份数据开两个窗口对照看**（例如把生产与测试库的同名表并排）。
 * 这不是"多实例" —— 所有窗口共用同一个主进程：连接池、schema 缓存、
 * 历史库、导入导出 worker 都是同一份。所以不存在两份连接互相抢锁的问题。
 *
 * 刻意不做的部分（任务书原文已授权裁剪「V23 成本最高，可裁剪」）：
 *  ❌ **标签拖出成新窗口**：这需要渲染层 DnD + 跨窗口状态迁移 + 标签归属管理，
 *     成本远大于本板块其余部分；而且真正的痛点是"对比两张表"，
 *     用「在新窗口打开」菜单项已经解决，拖拽只是更花哨的入口。
 *  ❌ **窗口间状态独立**：所有窗口共用 schema 缓存与连接状态，
 *     一个窗口刷新结构，另一个也能立刻看到（这正是想要的）。
 *
 * 🔴 三条约束：
 *  1. **窗口数量上限**：自用工具，开太多窗口只会互相抢连接与内存。
 *  2. **关掉最后一个窗口 = 退出应用**（macOS 惯例，与既有 window-all-closed 一致）。
 *  3. **新窗口必须走与主窗口完全相同的 createMainWindow** —— 否则玻璃/交通灯/
 *     关闭守卫这些形态会在第二个窗口上悄悄缺失（最难发现的那类缺陷）。
 */

import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/** 自用工具，上限够用了；超了给中文提示而不是静默失败 */
export const MAX_WINDOWS = 4;

export interface OpenWindowRequest {
  connId: string | null;
  database: string | null;
  table: string | null;
}

export interface WindowManagerDeps {
  /** 复用主窗口的创建函数（含玻璃、交通灯、关闭守卫），不要另起一套 */
  createWindow: (opts: { initialTab: { connId: string; database: string; table: string } | null; title?: string }) => Promise<BrowserWindow>;
  /** 主进程 dist 目录（算 preload / html 路径） */
  here: string;
}

export class WindowManager {
  private windows = new Set<BrowserWindow>();

  constructor(private deps: WindowManagerDeps) {}

  /** 主窗口建好后登记进来，这样它也算进上限与广播范围 */
  register(win: BrowserWindow): void {
    this.windows.add(win);
    win.on('closed', () => this.windows.delete(win));
  }

  /** 当前存活窗口数（不含已销毁的） */
  count(): number {
    return this.alive().length;
  }

  private alive(): BrowserWindow[] {
    return [...this.windows].filter((w) => !w.isDestroyed());
  }

  /**
   * 打开新窗口。返回中文错误信息（成功时为 null）——
   * 调用方把原因 toast 给用户，绝不静默失败。
   */
  async open(req: OpenWindowRequest): Promise<{ ok: boolean; message: string | null }> {
    if (this.count() >= MAX_WINDOWS) {
      return { ok: false, message: `最多同时打开 ${MAX_WINDOWS} 个窗口（关闭一个再试）` };
    }
    try {
      const initialTab =
        req.connId && req.database && req.table
          ? { connId: req.connId, database: req.database, table: req.table }
          : null;
      const win = await this.deps.createWindow({
        initialTab,
        title: initialTab ? `${initialTab.database}.${initialTab.table}` : undefined,
      });
      this.register(win);
      return { ok: true, message: null };
    } catch (e: unknown) {
      return { ok: false, message: `新窗口创建失败：${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  }

  /**
   * 向**所有**窗口广播（V23 的顺带收益 + 一个既有缺陷的修复）。
   *
   * 为什么需要：主进程原本把连接状态只推给 `mainWindow`。多窗口之后，
   * 第二个窗口里的连接状态横幅永远不会更新 —— 表现为"另一个窗口显示已连接，
   * 这个窗口还写着连接中"。所有窗口级推送都应该走这里。
   */
  broadcast(channel: string, payload: unknown): void {
    for (const w of this.alive()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        // 单个窗口发送失败（正在销毁）不该影响其他窗口
      }
    }
  }

  /** 所有窗口的 preload / html 路径（与主窗口同口径，别在这里重新推导） */
  paths(): { preloadPath: string; htmlPath: string } {
    return {
      preloadPath: join(this.deps.here, '../preload/preload.cjs'),
      htmlPath: join(this.deps.here, '../../renderer/dist/index.html'),
    };
  }
}