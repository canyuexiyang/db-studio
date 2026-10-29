/**
 * 命令面板（PRD §6.8，D5 决策：提前到 v1）
 *
 * v1 只做三类能力：
 *  - 无前缀 / `>`：搜索表与视图
 *  - `:`：执行命令
 *  - `@`：搜索查询历史
 *
 * **不在 v1 范围**：插件体系、自定义命令、搜索字段名、搜索单元格值、模糊命令别名。
 *
 * 性能要求（§6.8）：500 张表搜索，输入到结果更新 ≤ 50ms。因此打分是 O(n) 且
 * 不做正则回溯 —— 命中即给分，不命中即跳过，没有"尝试多种模式"的分支。
 */

export type PaletteMode = 'table' | 'command' | 'history';

export interface PaletteItem {
  id: string;
  /** 主标题 */
  title: string;
  /** 副标题（所属连接/库、或命令说明） */
  subtitle?: string;
  /** 右侧类型徽章 */
  badge?: string;
  /** 最近使用时间（epoch ms）。用于同分排序 */
  lastUsedAt?: number;
  /** 使用次数 */
  useCount?: number;
}

export interface PaletteCandidate extends PaletteItem {
  /** 供模糊匹配的额外关键词（如字段列表、命令别名） */
  keywords?: string[];
}

export interface ScoredItem {
  item: PaletteItem;
  score: number;
  /** 命中位置，供 UI 高亮 */
  matchedAt: number[];
}

// ---------- 前缀判定 ----------

export const PALETTE_PREFIXES = { command: ':', history: '@', table: '>' } as const;

export interface ParsedInput {
  mode: PaletteMode;
  /** 去掉前缀后的查询串 */
  query: string;
}

/**
 * 解析输入前缀。
 *
 * `>` 与无前缀都走搜表（PRD §6.8 表格里 `>` 是显式的搜表前缀）。
 * 前缀只认**首字符** —— 用户在表名里打 `@` 不该被当成搜历史。
 */
export function parsePaletteInput(raw: string): ParsedInput {
  const s = raw ?? '';
  if (s.startsWith(PALETTE_PREFIXES.command)) return { mode: 'command', query: s.slice(1) };
  if (s.startsWith(PALETTE_PREFIXES.history)) return { mode: 'history', query: s.slice(1) };
  if (s.startsWith(PALETTE_PREFIXES.table)) return { mode: 'table', query: s.slice(1) };
  return { mode: 'table', query: s };
}

// ---------- 打分 ----------

/**
 * 拼音首字母表（与 core-tree-view 同源口径：显式映射，不猜）。
 * 命令面板复用同一套规则，避免"树里能搜到、面板里搜不到"的不一致。
 */
const PINYIN_FIRST_LETTER: Record<string, string> = {
  订: 'd', 单: 'd', 明: 'm', 细: 'x', 用: 'y', 户: 'h', 商: 's', 品: 'p',
  支: 'z', 付: 'f', 金: 'j', 额: 'e', 状: 'z', 态: 't', 时: 's', 间: 'j',
  名: 'm', 称: 'c', 编: 'b', 号: 'h', 创: 'c', 建: 'j', 修: 'x', 改: 'g',
  库: 'k', 存: 'c', 价: 'j', 格: 'g', 数: 's', 量: 'l', 类: 'l', 型: 'x',
  地: 'd', 址: 'z', 电: 'd', 话: 'h', 邮: 'y', 箱: 'x', 备: 'b', 注: 'z',
  日: 'r', 志: 'z', 配: 'p', 置: 'z', 权: 'q', 限: 'x', 角: 'j', 色: 's',
  部: 'b', 门: 'm', 员: 'y', 工: 'g', 客: 'k', 供: 'g', 应: 'y', 仓: 'c',
  购: 'g', 销: 'x', 售: 's', 物: 'w', 流: 'l', 会: 'h', 计: 'j', 账: 'z',
  余: 'y', 收: 's', 款: 'k', 退: 't', 发: 'f', 票: 'p', 产: 'c', 分: 'f',
  标: 'b', 签: 'q', 图: 't', 片: 'p', 文: 'w', 章: 'z', 评: 'p', 论: 'l',
  点: 'd', 赞: 'z', 关: 'g', 系: 'x', 表: 'b', 字: 'z', 段: 'd', 索: 's',
  引: 'y', 外: 'w', 键: 'j', 主: 'z', 新: 'x', 连: 'l', 接: 'j', 查: 'c',
  询: 'x', 刷: 's', 题: 't', 只: 'z', 读: 'd', 偏: 'p', 好: 'h',
};

function pinyinLetters(s: string): string {
  let out = '';
  for (const ch of s) {
    const hit = PINYIN_FIRST_LETTER[ch];
    if (hit) out += hit;
    else if (/[a-z]/i.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 子串命中位置（大小写不敏感） */
function matchPositions(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const pos: number[] = [];
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i === -1) break;
    pos.push(i);
    from = i + n.length;
    if (pos.length >= 8) break; // 高亮不需要更多
  }
  return pos;
}

/**
 * 顺序子序列匹配（模糊）：`ord` 命中 `order`，也命中 `prod_order`。
 * 返回命中位置用于高亮；不命中返回 null。
 */
function subsequencePositions(haystack: string, needle: string): number[] | null {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const pos: number[] = [];
  let i = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) {
      pos.push(j);
      i++;
    }
  }
  return i === n.length ? pos : null;
}

export interface ScoreOptions {
  /** 最近使用加权：同匹配度下常用的排前（PRD §6.8） */
  now?: number;
  /** 最近使用的半衰期（ms）。默认 7 天 */
  recencyHalfLifeMs?: number;
  /** 单次使用的加分上限 */
  maxUsageBonus?: number;
}

/**
 * 给单个候选项打分。0 分表示不命中。
 *
 * 分档（高 → 低）：
 *  100 完全相等 > 80 前缀 > 60 连续子串 > 45 拼音首字母前缀 > 30 顺序子序列
 * 这样"输入 order 时 order 表一定排在 prod_order 前面"。
 */
export function scoreItem(item: PaletteCandidate, query: string, opts: ScoreOptions = {}): ScoredItem | null {
  const q = (query ?? '').trim();
  const title = item.title ?? '';

  if (!q) {
    return { item, score: 1, matchedAt: [] };
  }

  const needle = q.toLowerCase();
  const lower = title.toLowerCase();
  let base = 0;
  let matchedAt: number[] = [];

  if (lower === needle) {
    base = 100;
    matchedAt = Array.from({ length: title.length }, (_, i) => i);
  } else if (lower.startsWith(needle)) {
    base = 80;
    matchedAt = Array.from({ length: needle.length }, (_, i) => i);
  } else {
    const pos = matchPositions(title, q);
    if (pos.length > 0) {
      base = 60;
      matchedAt = pos;
    } else {
      const letters = pinyinLetters(title);
      if (letters.startsWith(needle)) {
        base = 45;
        matchedAt = Array.from({ length: Math.min(needle.length, title.length) }, (_, i) => i);
      } else {
        const sub = subsequencePositions(title, q);
        if (sub) {
          base = 30;
          matchedAt = sub;
        }
      }
    }
  }

  // 关键词命中：比正文弱一档，但足以让"刷新"被搜到（命令面板的别名场景）
  if (base === 0) {
    for (const kw of item.keywords ?? []) {
      const kwLower = kw.toLowerCase();
      if (kwLower.includes(needle)) {
        base = 25;
        matchedAt = matchPositions(kw, q);
        break;
      }
    }
  }

  if (base === 0) return null;

  // 短标题优先：order 比 order_history_detail 更像用户想要的
  const brevity = Math.max(0, 10 - Math.floor(title.length / 8));

  const halfLife = opts.recencyHalfLifeMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  let recency = 0;
  if (item.lastUsedAt && item.lastUsedAt <= now) {
    const age = now - item.lastUsedAt;
    recency = 8 * Math.pow(0.5, age / halfLife);
  }
  const usage = Math.min(opts.maxUsageBonus ?? 6, (item.useCount ?? 0) * 0.5);

  return { item, score: base + brevity + recency + usage, matchedAt };
}

export interface RankOptions extends ScoreOptions {
  limit?: number;
}

/** 排序：分数降序；同分按最近使用，再按标题字典序（保证结果稳定） */
export function rankItems(
  items: PaletteCandidate[],
  query: string,
  opts: RankOptions = {},
): ScoredItem[] {
  const scored: ScoredItem[] = [];
  for (const it of items) {
    const s = scoreItem(it, query, opts);
    if (s) scored.push(s);
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const au = a.item.lastUsedAt ?? 0;
    const bu = b.item.lastUsedAt ?? 0;
    if (bu !== au) return bu - au;
    return a.item.title.localeCompare(b.item.title);
  });
  const limit = opts.limit ?? 10;
  return limit > 0 ? scored.slice(0, limit) : scored;
}

// ---------- 内置命令 ----------

export interface CommandDef extends PaletteCandidate {
  /** 命令的唯一动作标识，UI 用它分派 */
  action: string;
}

/**
 * v1 内置命令（PRD §6.8）：新建连接、新建查询、刷新、切换主题、切换只读模式、打开偏好设置。
 * F2 增补：字体放大/缩小/重置（与原生菜单 ⌘= / ⌘- / ⌘0 同一动作，action 名即
 * 渲染层 App 分派表的键）。keywords 让「字体」和 zoom 等中英文关键词都能命中，
 * 也让"刷新"能被 `ref` / `reload` 命中。
 */
export const BUILTIN_COMMANDS: CommandDef[] = [
  { id: 'cmd.newConnection', action: 'newConnection', title: '新建连接', subtitle: '添加一个新的数据库连接', badge: '命令', keywords: ['new', 'connection', 'add'] },
  { id: 'cmd.newQuery', action: 'newQuery', title: '新建查询标签', subtitle: '打开一个 SQL 编辑器', badge: '命令', keywords: ['new', 'query', 'sql', 'editor'] },
  { id: 'cmd.refresh', action: 'refresh', title: '刷新当前对象', subtitle: '重新拉取当前表或库', badge: '命令', keywords: ['refresh', 'reload', '重新加载'] },
  { id: 'cmd.toggleTheme', action: 'toggleTheme', title: '切换主题', subtitle: '跟随系统 / 浅色 / 深色', badge: '命令', keywords: ['theme', 'dark', 'light', '主题'] },
  { id: 'cmd.toggleReadOnly', action: 'toggleReadOnly', title: '切换只读模式', subtitle: '开启后禁止所有写操作', badge: '命令', keywords: ['readonly', 'read', '只读'] },
  { id: 'cmd.openPreferences', action: 'openPreferences', title: '打开偏好设置', subtitle: '快捷键、外观、编辑行为', badge: '命令', keywords: ['settings', 'preferences', '设置'] },
  { id: 'cmd.fontZoomIn', action: 'fontZoomIn', title: '字体放大', subtitle: '放大界面字体（⌘=）', badge: '命令', keywords: ['zoom', 'zoom in', '字体', '放大'] },
  { id: 'cmd.fontZoomOut', action: 'fontZoomOut', title: '字体缩小', subtitle: '缩小界面字体（⌘-）', badge: '命令', keywords: ['zoom', 'zoom out', '字体', '缩小'] },
  { id: 'cmd.fontZoomReset', action: 'fontZoomReset', title: '重置字体', subtitle: '恢复默认字体大小（⌘0）', badge: '命令', keywords: ['zoom', 'reset', '字体', '重置'] },
  // V21 / V23：应用维护与多窗口（action 名同样是 App 分派表的键）
  { id: 'cmd.checkUpdate', action: 'checkUpdate', title: '检查更新', subtitle: '查看是否有新版本（仅打包产物联网）', badge: '命令', keywords: ['update', 'upgrade', 'version', '更新', '升级'] },
  { id: 'cmd.openInNewWindow', action: 'openInNewWindow', title: '在新窗口打开当前表', subtitle: '对照查看两张表或两个库（⌘⇧N）', badge: '命令', keywords: ['window', 'new window', '新窗口', '多窗口', '对照'] },
  /**
   * P1-15：筛选此前只有工具栏按钮 + 原生菜单两处入口，命令面板里搜「筛选 / filter / where」
   * 一个字都搜不到。`action: 'filter'` 与 App 分派表的键一致（同 ⌘⇧F）。
   */
  { id: 'cmd.filter', action: 'filter', title: '筛选当前表', subtitle: '按列加条件（⌘⇧F）', badge: '命令', keywords: ['filter', 'where', '筛选', '过滤', '条件'] },
];

// ---------- 面板入口 ----------

export interface PaletteQuery {
  items: PaletteItem[];
  commands?: CommandDef[];
}

/**
 * 面板查询入口。
 *
 * **输入为空时不做过滤** —— PRD §6.8 要求展示「最近打开的表」与「常用命令」，
 * 所以空查询返回的是按最近使用排序的列表，而不是空列表。
 */
export function queryPalette(
  input: string,
  data: PaletteQuery,
  opts: RankOptions = {},
): { mode: PaletteMode; results: ScoredItem[] } {
  const { mode, query } = parsePaletteInput(input);

  if (mode === 'command') {
    const cmds = data.commands ?? BUILTIN_COMMANDS;
    return { mode, results: rankItems(cmds, query, opts) };
  }

  const results = rankItems(data.items ?? [], query, opts);
  return { mode, results };
}

/** 记录一次使用（供下次加权排序） */
export function markUsed(item: PaletteItem, now = Date.now()): PaletteItem {
  return { ...item, lastUsedAt: now, useCount: (item.useCount ?? 0) + 1 };
}

/** 键盘导航：↑↓ 在结果里循环（PRD §6.8） */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const next = (current + delta) % count;
  return next < 0 ? next + count : next;
}
