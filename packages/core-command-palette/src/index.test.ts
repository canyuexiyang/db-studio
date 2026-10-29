import { describe, it, expect } from 'vitest';
import {
  parsePaletteInput,
  queryPalette,
  rankItems,
  scoreItem,
  markUsed,
  moveSelection,
  BUILTIN_COMMANDS,
  PALETTE_PREFIXES,
} from './index.js';
import type { PaletteItem } from './index.js';

function item(id: string, title: string, over: Partial<PaletteItem> = {}): PaletteItem {
  return { id, title, ...over };
}

const tables: PaletteItem[] = [
  item('t1', 'order', { subtitle: 'prod / order_db', badge: '表' }),
  item('t2', 'order_item', { subtitle: 'prod / order_db', badge: '表' }),
  item('t3', 'user', { subtitle: 'prod / order_db', badge: '表' }),
  item('t4', '订单明细', { subtitle: 'prod / order_db', badge: '表' }),
  item('t5', 'v_order_summary', { subtitle: 'prod / order_db', badge: '视图' }),
];

describe('前缀判定', () => {
  it('无前缀 / > 走搜表', () => {
    expect(parsePaletteInput('order').mode).toBe('table');
    expect(parsePaletteInput('>order')).toEqual({ mode: 'table', query: 'order' });
  });

  it(': 走命令', () => {
    expect(parsePaletteInput(':refresh')).toEqual({ mode: 'command', query: 'refresh' });
  });

  it('@ 走历史', () => {
    expect(parsePaletteInput('@select')).toEqual({ mode: 'history', query: 'select' });
  });

  it('只认首字符：表名里的 @ 不会被当前缀', () => {
    expect(parsePaletteInput('user@2').mode).toBe('table');
    expect(parsePaletteInput('user@2').query).toBe('user@2');
  });

  it('空输入走搜表', () => {
    expect(parsePaletteInput('')).toEqual({ mode: 'table', query: '' });
  });

  it('只有前缀没有查询词', () => {
    expect(parsePaletteInput(':')).toEqual({ mode: 'command', query: '' });
  });
});

describe('打分', () => {
  it('完全相等 > 前缀 > 连续子串 > 子序列', () => {
    const q = 'order';
    const exact = scoreItem(item('a', 'order'), q)!;
    const prefix = scoreItem(item('b', 'order_item'), q)!;
    const sub = scoreItem(item('c', 'prod_order'), q)!;
    const seq = scoreItem(item('d', 'o_r_d_e_r_x'), q)!;
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(sub.score);
    expect(sub.score).toBeGreaterThan(seq.score);
  });

  it('不命中返回 null', () => {
    expect(scoreItem(item('a', 'user'), 'zzzz')).toBeNull();
    expect(scoreItem(item('a', 'user'), 'aeiou')).toBeNull();
  });

  it('短标题优先：order 排在 order_item 前', () => {
    const ranked = rankItems(tables, 'order');
    expect(ranked[0].item.title).toBe('order');
  });

  it('拼音首字母：dd → 订单明细', () => {
    const ranked = rankItems(tables, 'dd');
    expect(ranked[0].item.title).toBe('订单明细');
  });

  it('大小写不敏感', () => {
    expect(rankItems(tables, 'ORDER')[0].item.title).toBe('order');
  });

  it('关键词命中（命令别名）', () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.action === 'refresh')!;
    expect(scoreItem(cmd, 'reload')).not.toBeNull();
    // 拼音首字母：sx → 刷新
    expect(scoreItem(cmd, 'sx')).not.toBeNull();
    // 未收录的字不猜：随便两个字母不该命中
    expect(scoreItem(cmd, 'zz')).toBeNull();
  });

  it('命中位置供高亮', () => {
    const s = scoreItem(item('a', 'prod_order'), 'order')!;
    expect(s.matchedAt).toEqual([5]);
  });

  it('最近使用加权：同分下常用的排前', () => {
    const now = 1_000_000;
    const fresh = item('a', 'user_x', { lastUsedAt: now, useCount: 10 });
    const old = item('b', 'user_y', { lastUsedAt: now - 30 * 24 * 3600 * 1000, useCount: 0 });
    const ranked = rankItems([old, fresh], 'user', { now });
    expect(ranked[0].item.id).toBe('a');
  });

  it('limit 截断结果', () => {
    expect(rankItems(tables, 'o', { limit: 2 })).toHaveLength(2);
  });

  it('limit<=0 返回全部', () => {
    const all = rankItems(tables, 'o', { limit: 0 });
    expect(all.length).toBeGreaterThan(2);
  });

  it('空查询返回全部（供"最近打开"展示），按最近使用排序', () => {
    const now = 1_000_000;
    const a = item('a', 'aaa', { lastUsedAt: now - 1000 });
    const b = item('b', 'bbb', { lastUsedAt: now });
    const ranked = rankItems([a, b], '', { now });
    expect(ranked.map((r) => r.item.id)).toEqual(['b', 'a']);
  });
});

describe('面板查询', () => {
  it('搜表模式', () => {
    const r = queryPalette('order', { items: tables });
    expect(r.mode).toBe('table');
    expect(r.results[0].item.title).toBe('order');
  });

  it('命令模式：用内置命令', () => {
    const r = queryPalette(':refresh', { items: tables });
    expect(r.mode).toBe('command');
    expect(r.results[0].item.title).toBe('刷新当前对象');
  });

  it('命令模式空查询列出全部内置命令', () => {
    // ⚠️ 必须显式传 limit:0（= 不截断）。默认 limit 是 10 的 UI 口径，
    //    命令数一旦超过 10（V21/V23 加进来就超了），这条断言就会因为
    //    "被 UI 默认值截断"而失败 —— 那测的是默认值，不是「命令模式列内置命令」。
    const r = queryPalette(':', { items: tables }, { limit: 0 });
    expect(r.results.length).toBe(BUILTIN_COMMANDS.length);
  });

  it('历史模式：搜的是传入的历史条目', () => {
    const history = [item('h1', 'SELECT * FROM order LIMIT 10', { subtitle: '3 分钟前' })];
    const r = queryPalette('@order', { items: history });
    expect(r.mode).toBe('history');
    expect(r.results[0].item.title).toMatch(/FROM order/);
  });

  it('无命中返回空数组而非抛异常', () => {
    expect(queryPalette('zzzzz', { items: tables }).results).toEqual([]);
  });

  it('空数据源返回空结果', () => {
    expect(queryPalette('a', { items: [] }).results).toEqual([]);
  });

  it('内置命令覆盖 PRD §6.8 的六项 + F2 字体缩放三项 + V21/V23 两项 + P1-15 筛选 + P0-19 建库', () => {
    const actions = BUILTIN_COMMANDS.map((c) => c.action);
    expect(actions).toEqual([
      'newConnection', 'newQuery', 'refresh', 'toggleTheme', 'toggleReadOnly', 'openPreferences',
      'fontZoomIn', 'fontZoomOut', 'fontZoomReset',
      // V21 自动更新 / V23 多窗口
      'checkUpdate', 'openInNewWindow',
      // P1-15：筛选此前在面板里搜不到（工具栏/菜单之外没有第三个入口）
      'filter',
      // P0-19：建库此前全应用零入口（只能在编辑器里手写 CREATE DATABASE）
      'createDatabase',
    ]);
  });

  /**
   * P0-19：建库命令必须能被中英文关键词命中 —— 用户的两种说法都要搜得到，
   * 否则「面板里有这条命令」在实践中等于不存在。
   */
  it('「新建数据库」命令能被 建库 / 数据库 / database / create 命中', () => {
    for (const kw of ['建库', '数据库', 'database', 'create', 'newdb']) {
      const hit = rankItems(BUILTIN_COMMANDS, kw).some((s) => s.item.id === 'cmd.createDatabase');
      expect(hit, `关键词「${kw}」搜不到新建数据库命令`).toBe(true);
    }
  });

  /**
   * P1-15：筛选必须能被中文与英文关键词命中 —— 面板是「键盘优先」路径，
   * 搜不到等于没有这个入口。同时钉住 id 前缀不与表条目（`连接:库:表`）混淆。
   */
  it('「筛选」命令能被 筛选 / filter / where 命中且 id 带 cmd 前缀', () => {
    const cmds = BUILTIN_COMMANDS.filter((c) => c.action === 'filter');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id.startsWith('cmd.')).toBe(true);
    for (const q of ['筛选', 'filter', 'where', '过滤']) {
      const r = queryPalette(`:${q}`, { items: [] });
      expect(r.results.map((x) => x.item.id)).toContain('cmd.filter');
    }
  });

  it('前缀常量', () => {
    expect(PALETTE_PREFIXES).toEqual({ command: ':', history: '@', table: '>' });
  });
});

describe('使用记录与键盘导航', () => {
  it('markUsed 累加次数并刷新时间', () => {
    const a = markUsed(item('a', 'x'), 1000);
    expect(a.useCount).toBe(1);
    expect(a.lastUsedAt).toBe(1000);
    expect(markUsed(a, 2000).useCount).toBe(2);
  });

  it('↑↓ 在结果里循环', () => {
    expect(moveSelection(0, -1, 5)).toBe(4);
    expect(moveSelection(4, 1, 5)).toBe(0);
    expect(moveSelection(2, 1, 5)).toBe(3);
  });

  it('空结果不越界', () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
