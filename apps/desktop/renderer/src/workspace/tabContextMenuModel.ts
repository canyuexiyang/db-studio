/**
 * T27（报告 §5 W02 / §10 I07 / §8.1 标签右键最小集）：标签右键菜单的**纯逻辑**。
 *
 * 为什么抽成独立模块（与 snippetCommand.ts 同口径）：
 *  1. 「关闭其他 / 关闭右侧」的集合计算有边界（无右侧、只剩自己、不可关闭的标签），
 *     这些边界在 UI 里很难造，且造出来也看不出对错；
 *  2. **批量关闭的核心验收**（多个脏表 → 一次列出全部，不连弹十个框）本质是
 *     「一批 id → 一份待确认清单」的纯计算，必须能被单测钉住；
 *  3. 「复制完整对象身份」的身份串要能**解析回查**，编解码不能有第二种写法。
 *
 * 本文件不 import React、不碰 DOM —— 纯数据进、纯数据出。
 */

import type { WorkspaceTab } from './useWorkspaceTabs';

/** 菜单动作；同时用作 data-testid 后缀（`tab-menu-<key>`） */
export type TabMenuAction =
  | 'close'
  | 'closeOthers'
  | 'closeRight'
  | 'togglePin'
  | 'revealInTree'
  | 'copyIdentity';

export interface TabMenuItem {
  key: TabMenuAction;
  label: string;
  disabled: boolean;
  /** T14/T18：禁用必须给中文原因，否则用户只会以为「软件坏了」 */
  disabledReason?: string;
  shortcut?: string;
  separatorBefore?: boolean;
  danger?: boolean;
}

// ---------- 关闭集合 ----------

/**
 * 「不可关闭」的判定钩子。
 *
 * v0.7.0 还没有固定标签（T42 才做），默认是全部可关；参数留在这里是为了让
 * 「关闭其他」的集合计算在**有固定标签时**也能被单测覆盖 —— 否则等 T42 加进来，
 * 这段集合计算会静默地把固定标签一起关掉。
 */
export interface ClosableOptions {
  isClosable?: (tab: WorkspaceTab) => boolean;
}

function closable(tab: WorkspaceTab, opts?: ClosableOptions): boolean {
  return opts?.isClosable ? opts.isClosable(tab) : true;
}

/**
 * 关闭其他：除自己以外**可关闭**的标签（保持 tabs 原序）。
 *
 * 🔴 target 不在 tabs 里必须返回空集：`t.id !== targetId` 的写法在这种输入下会
 *    返回**全部**标签（单测抓到：期望 [] 实际 ['a','b','c','d']）—— 右键的标签
 *    若刚好在这一帧被关掉，就会变成「关闭其他 = 关闭全部」。
 */
export function closeOthersIds(
  tabs: readonly WorkspaceTab[],
  targetId: string,
  opts?: ClosableOptions,
): string[] {
  if (!tabs.some((t) => t.id === targetId)) return [];
  return tabs.filter((t) => t.id !== targetId && closable(t, opts)).map((t) => t.id);
}

/** 关闭右侧：严格在 target **之后**的可关闭标签；target 不存在 → [] */
export function closeRightIds(
  tabs: readonly WorkspaceTab[],
  targetId: string,
  opts?: ClosableOptions,
): string[] {
  const idx = tabs.findIndex((t) => t.id === targetId);
  if (idx < 0) return [];
  return tabs.slice(idx + 1).filter((t) => closable(t, opts)).map((t) => t.id);
}

// ---------- 批量关闭的脏清单 ----------

export interface DirtyTabEntry {
  id: string;
  /** 标签标题（表标签 = 表名） */
  title: string;
  connId: string | null;
  database: string | null;
  /** 表名；查询标签恒 null */
  name: string | null;
  dirtyCount: number;
  /** 列表里展示的一行：`<库>.<表>` */
  objectLabel: string;
}

export interface BatchClosePlan {
  /** 真正可关的 id（剔除不存在 / 不可关闭），按 tabs 原序 */
  closableIds: string[];
  /**
   * 一次列出的**全部**脏标签。
   *
   * 🔴 这条是 T27 的核心验收：批量关闭遇到 N 个脏表时，调用方必须拿这份清单
   *    弹**一个**框，而不是对每个 id 各弹一次（连弹十个框是需求点名要消灭的行为）。
   */
  dirty: DirtyTabEntry[];
  /** 无改动、可直接关的 id */
  cleanIds: string[];
  /** dirty.length > 0 —— 空清单时不弹框 */
  needsConfirm: boolean;
}

/** 一批 id 里的脏表（table tab 且 dirtyCount > 0），按 tabs 原序 */
export function dirtyEntriesOf(
  tabs: readonly WorkspaceTab[],
  ids: readonly string[],
): DirtyTabEntry[] {
  const want = new Set(ids);
  const out: DirtyTabEntry[] = [];
  for (const t of tabs) {
    if (!want.has(t.id)) continue;
    if (t.kind !== 'table' || t.dirtyCount <= 0) continue;
    out.push({
      id: t.id,
      title: t.title,
      connId: t.connId,
      database: t.database,
      name: t.tableName,
      dirtyCount: t.dirtyCount,
      objectLabel: `${t.database}.${t.tableName}`,
    });
  }
  return out;
}

/** 「批量关闭请求 → 待确认清单」：一次算全，弹框与否由 needsConfirm 决定 */
export function planBatchClose(
  tabs: readonly WorkspaceTab[],
  ids: readonly string[],
  opts?: ClosableOptions,
): BatchClosePlan {
  const closableIds = tabs.filter((t) => ids.includes(t.id) && closable(t, opts)).map((t) => t.id);
  const dirty = dirtyEntriesOf(tabs, closableIds);
  const dirtyIds = new Set(dirty.map((d) => d.id));
  return {
    closableIds,
    dirty,
    cleanIds: closableIds.filter((id) => !dirtyIds.has(id)),
    needsConfirm: dirty.length > 0,
  };
}

// ---------- 完整对象身份 ----------

/**
 * 身份串前缀。三段 `连接 / 库 / 表`，每段各自 encodeURIComponent。
 *
 * 为什么每段单独编码再 join('/')：库名/表名在 MySQL 里可以含 `/`、空格、中文、
 * 甚至 `:`（树 key 用 `:` 分段就是被它坑过），裸拼会让解析错位。编码后
 * `dbstudio://c1/a%2Fb/t1` 仍能解析回 `a/b`，且人眼可读 ASCII 部分。
 */
export const TAB_IDENTITY_PREFIX = 'dbstudio://';

export interface ObjectIdentity {
  connId: string;
  database: string;
  name: string;
}

/** 表标签 → 身份；查询标签没有表对象 → null（菜单项据此禁用） */
export function objectIdentityOf(tab: WorkspaceTab): ObjectIdentity | null {
  if (tab.kind !== 'table') return null;
  if (!tab.connId || !tab.database || !tab.tableName) return null;
  return { connId: tab.connId, database: tab.database, name: tab.tableName };
}

export function formatObjectIdentity(id: ObjectIdentity): string {
  return (
    TAB_IDENTITY_PREFIX +
    [id.connId, id.database, id.name].map((s) => encodeURIComponent(s)).join('/')
  );
}

/** 解析回三段身份；格式不符 / 段数不对 / 有空段 / 编码非法 → null */
export function parseObjectIdentity(text: string): ObjectIdentity | null {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw.startsWith(TAB_IDENTITY_PREFIX)) return null;
  const parts = raw.slice(TAB_IDENTITY_PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  try {
    const [connId, database, name] = parts.map((p) => decodeURIComponent(p));
    if (!connId || !database || !name) return null;
    return { connId, database, name };
  } catch {
    return null;
  }
}

/** 按身份串**三元组**回查标签：两个连接同名库同名表不会串 */
export function findTabByIdentity(
  tabs: readonly WorkspaceTab[],
  text: string,
): WorkspaceTab | null {
  const id = parseObjectIdentity(text);
  if (!id) return null;
  return (
    tabs.find(
      (t) =>
        t.kind === 'table' &&
        t.connId === id.connId &&
        t.database === id.database &&
        t.tableName === id.name,
    ) ?? null
  );
}

// ---------- 在树定位 ----------

/**
 * 标签 → 树节点 key（与 core-tree-view 的 key 口径一致）：
 * `obj:<connId>:<db>:<table>` / `db:<connId>:<db>` / `conn:<connId>`。
 *
 * 只回 key，不回祖先链 —— 组节点 key 含成员 id 集合（`group:ungrouped:id1,id2`），
 * 拼不出来；展开祖先由宿主用 core-tree-view 的 `expandAncestors` 走真实树。
 */
export function treeKeyOfTab(tab: WorkspaceTab): string | null {
  if (tab.kind === 'table') {
    if (!tab.connId || !tab.database || !tab.tableName) return null;
    return `obj:${tab.connId}:${tab.database}:${tab.tableName}`;
  }
  if (!tab.connId) return null;
  return tab.database ? `db:${tab.connId}:${tab.database}` : `conn:${tab.connId}`;
}

// ---------- 菜单项 ----------

export interface TabMenuInput {
  tabs: readonly WorkspaceTab[];
  /** 右键命中的标签 */
  tab: WorkspaceTab;
  /** 当前激活标签（只有它才该显示 ⌘W） */
  activeId: string | null;
  /** 宿主是否接了「在树中定位」 */
  canRevealInTree: boolean;
  /** 不可关闭的标签（固定标签，T42） */
  isClosable?: (tab: WorkspaceTab) => boolean;
}

/** 构造菜单项：不可用的项一律 disabled + 中文原因（红线：不许做假 UI） */
export function buildTabMenuItems(input: TabMenuInput): TabMenuItem[] {
  const { tabs, tab, activeId, canRevealInTree } = input;
  const opts: ClosableOptions | undefined = input.isClosable
    ? { isClosable: input.isClosable }
    : undefined;

  const others = closeOthersIds(tabs, tab.id, opts);
  const right = closeRightIds(tabs, tab.id, opts);
  const identity = objectIdentityOf(tab);
  const treeKey = treeKeyOfTab(tab);

  const totalOthers = tabs.filter((t) => t.id !== tab.id).length;
  const rightTotal = tabs.length - 1 - tabs.findIndex((t) => t.id === tab.id);

  return [
    {
      key: 'close',
      label: '关闭',
      disabled: false,
      shortcut: tab.id === activeId ? '⌘W' : undefined,
    },
    /**
     * P1-7：固定/取消固定。
     * 固定的标签会排到最左侧，且**不参与「关闭其他 / 关闭右侧」**（isClosable 钩子）。
     */
    {
      key: 'togglePin',
      label: tab.pinned ? '取消固定' : '固定标签',
      disabled: false,
    },
    {
      key: 'closeOthers',
      label: '关闭其他标签',
      disabled: others.length === 0,
      disabledReason:
        others.length === 0
          ? totalOthers === 0
            ? '没有其他标签'
            : '其余标签都不可关闭'
          : undefined,
    },
    {
      key: 'closeRight',
      label: '关闭右侧标签',
      disabled: right.length === 0,
      disabledReason:
        right.length === 0
          ? rightTotal <= 0
            ? '没有右侧标签'
            : '右侧没有可关闭的标签'
          : undefined,
    },
    {
      key: 'revealInTree',
      label: '在树中定位',
      disabled: !canRevealInTree || treeKey === null,
      disabledReason: !canRevealInTree
        ? '宿主未接「在树中定位」，该功能暂不可用'
        : treeKey === null
          ? '该标签未绑定连接，无法在树中定位'
          : undefined,
      separatorBefore: true,
    },
    {
      key: 'copyIdentity',
      label: '复制完整对象身份',
      disabled: identity === null,
      disabledReason:
        identity === null ? '查询标签不是表对象，没有可复制的表身份' : undefined,
    },
  ];
}
