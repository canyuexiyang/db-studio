/**
 * 库表树视图模型（PRD §6.2）
 *
 * 结构：分组 → 连接 → 数据库 → 对象类型（表/视图/存储过程/函数）→ 对象
 *
 * 三个核心能力：
 *  1. **扁平化**：树是嵌套的，虚拟滚动需要一维数组。这里把展开的节点压成
 *     `FlatNode[]`，渲染层只需按 index 取，**不必递归、不必在渲染时算可见性**。
 *  2. **展开记忆（D1）**：首次展开到数据库层，之后记住用户展开过的节点异步恢复。
 *     存的是**节点 key**而不是下标 —— 库表顺序变化时下标会错指到别的节点。
 *  3. **搜索**：匹配表名/视图名/字段名，**保留祖先链**（否则搜到的节点无父可挂）。
 *
 * ⚠️ 树节点数量可能上万（一个实例几百张表 × 多个库），所以扁平化必须是 O(n) 且
 * 只在展开状态变化时重算，不能每帧做。
 */

import type { ConnectionConfig } from '@dbstudio/core-connection';
import { buildGroupTree, isProduction, type GroupNode } from '@dbstudio/core-connection';
import type { DatabaseMeta, ObjectKind, TableMeta } from '@dbstudio/core-schema-cache';

export type TreeNodeKind = 'group' | 'connection' | 'database' | 'kind' | 'object';

export interface TreeNode {
  /** 全局唯一 key。路径式，便于持久化与调试 */
  key: string;
  kind: TreeNodeKind;
  label: string;
  /** 分组节点：子节点 */
  children?: TreeNode[];
  /** 连接节点 */
  connection?: ConnectionConfig;
  /** 数据库节点 / 对象节点归属的库 */
  database?: string;
  /** kind 节点（表/视图/存储过程/函数） */
  objectKind?: ObjectKind;
  /** 对象节点 */
  table?: TableMeta;
  /** 计数徽章，如表数量 */
  badge?: number;
  /** 生产环境标记（危险操作加第三层确认，§6.2.2） */
  danger?: boolean;
  /** 是否已加载过子节点（库表树的懒加载标记） */
  loaded?: boolean;
  /** 加载中 */
  loading?: boolean;
}

/**
 * 对象类型分组的展示顺序与文案（§6.2.1）。
 *
 * C1 追加触发器/事件两类：ORDER 追加在尾部（表/视图是高频对象，永远排前面）；
 * 树里没有触发器/事件的库不会出现这两个节点（badge=0 的 kind 节点由渲染层
 * 自行决定是否隐藏，这里不特殊处理 —— 数据是唯一事实来源）。
 */
export const OBJECT_KIND_LABELS: Record<ObjectKind, string> = {
  table: '表',
  view: '视图',
  procedure: '存储过程',
  function: '函数',
  trigger: '触发器',
  event: '事件',
};

export const OBJECT_KIND_ORDER: readonly ObjectKind[] = [
  'table',
  'view',
  'procedure',
  'function',
  'trigger',
  'event',
];

// ---------- 建树 ----------

export interface BuildTreeInput {
  connections: ConnectionConfig[];
  /** 连接 id → 已拉取的库元数据。没有则为"未连接/未加载" */
  schemas?: Record<string, DatabaseMeta[]>;
  /**
   * 0.7.3（P2-29）：**空分组**路径清单（`生产` / `生产/订单`）。
   *
   * 分组本来由连接的 `group` 字段派生，于是"没有连接的分组"根本不存在 ——
   * 用户点「新建分组」后什么都看不到，等于按钮坏了。宿主把显式创建过的
   * 空分组路径传进来，这里把它们并进分组树（成员为 0，badge 为 0）。
   *
   * ⚠️ 只影响渲染，不产生任何连接配置变更；已有连接的分组路径重复传入是无害的（按 path 去重）。
   */
  extraGroups?: readonly string[];
  /** 展开状态由外部维护（D1），这里只负责渲染 */
}

export function buildTree(input: BuildTreeInput): TreeNode[] {
  const groups = buildGroupTree(input.connections ?? [], input.extraGroups ?? []);
  const schemas = input.schemas ?? {};
  return groups.map((g) => groupNode(g, schemas));
}

function groupNode(g: GroupNode, schemas: Record<string, DatabaseMeta[]>): TreeNode {
  const children: TreeNode[] = [];

  for (const child of g.children) children.push(groupNode(child, schemas));
  for (const cfg of g.connections) children.push(connectionNode(cfg, schemas[cfg.id]));

  const total = countConnections(g);
  return {
    /**
     * P2-18i：key 必须**稳定**。
     *
     * 旧写法 `group:${name}:${成员 id 用逗号拼}` 把"成员集合"编进了 key ——
     * 增删任何一个连接都会让 key 变化，于是：展开记忆失效、`expandAncestors`
     * 算不到祖先、「在树中定位」定位到不存在的节点。组路径本身已经是唯一身份
     * （`buildGroupTree` 用 path 建索引），未分组只有一个（path === ''）。
     */
    key: g.path ? `group:${g.path}` : 'group-root:ungrouped',
    kind: 'group',
    label: g.name || '未分组',
    children,
    badge: total,
  };
}

function countConnections(g: GroupNode): number {
  return g.connections.length + g.children.reduce((n, c) => n + countConnections(c), 0);
}

function connectionNode(cfg: ConnectionConfig, dbs?: DatabaseMeta[]): TreeNode {
  const children: TreeNode[] = (dbs ?? []).map((d) => databaseNode(cfg.id, d));
  return {
    key: `conn:${cfg.id}`,
    kind: 'connection',
    label: cfg.name,
    connection: cfg,
    children,
    loaded: dbs != null,
    danger: isProduction(cfg),
  };
}

function databaseNode(connId: string, d: DatabaseMeta): TreeNode {
  const children: TreeNode[] = OBJECT_KIND_ORDER.map((k) => kindNode(connId, d, k));
  return {
    key: `db:${connId}:${d.name}`,
    kind: 'database',
    label: d.name,
    database: d.name,
    children,
  };
}

function kindNode(connId: string, d: DatabaseMeta, k: ObjectKind): TreeNode {
  const items = d.tables.filter((t) => t.kind === k);
  return {
    key: `kind:${connId}:${d.name}:${k}`,
    kind: 'kind',
    label: OBJECT_KIND_LABELS[k],
    database: d.name,
    objectKind: k,
    badge: items.length,
    children: items.map((t) => objectNode(connId, d.name, t)),
    loaded: true,
  };
}

function objectNode(connId: string, db: string, t: TableMeta): TreeNode {
  return {
    key: `obj:${connId}:${db}:${t.name}`,
    kind: 'object',
    label: t.name,
    database: db,
    table: t,
  };
}

// ---------- 扁平化 ----------

export interface FlatNode {
  node: TreeNode;
  depth: number;
  /** 是否有子节点（决定三角是否可点） */
  hasChildren: boolean;
  expanded: boolean;
  /** 父节点 key（根为空） */
  parentKey: string | null;
}

/**
 * 全树扁平化（**忽略展开状态**）—— 搜索态专用（P0-2）。
 *
 * 🔴 为什么不能复用 `flattenTree(roots, expanded)`：它只输出「已展开」的行。
 *    默认只展开到库层，于是**未展开库里的表按表名搜零结果** —— 用户判定
 *    「搜索坏了」。搜索是「在整棵树里找」，前提就是整棵树都在候选集里。
 */
export function flattenAll(roots: TreeNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentKey: string | null) => {
    for (const n of nodes) {
      const children = n.children ?? [];
      out.push({ node: n, depth, hasChildren: children.length > 0, expanded: children.length > 0, parentKey });
      if (children.length > 0) walk(children, depth + 1, n.key);
    }
  };
  walk(roots, 0, null);
  return out;
}

/**
 * 把树压平为可视行。
 *
 * 只进入 `expanded` 的节点 —— 未展开的分支整段跳过，这是虚拟滚动树能撑住
 * 上万节点的关键（不构造不可见行）。
 */
export function flattenTree(
  roots: TreeNode[],
  expanded: ReadonlySet<string>,
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentKey: string | null) => {
    for (const n of nodes) {
      const children = n.children ?? [];
      const hasChildren = children.length > 0;
      const isExpanded = hasChildren && expanded.has(n.key);
      out.push({ node: n, depth, hasChildren, expanded: isExpanded, parentKey });
      if (isExpanded) walk(children, depth + 1, n.key);
    }
  };
  walk(roots, 0, null);
  return out;
}

// ---------- 展开记忆（D1） ----------

/**
 * 首次展开策略：**展开到数据库层**（D1）。
 * 分组与连接默认展开，库下面的"表/视图/..."不展开 —— 否则 128 张表会一次性糊在屏幕上。
 */
export function defaultExpanded(roots: TreeNode[]): Set<string> {
  const set = new Set<string>();
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const hasChildren = (n.children ?? []).length > 0;
      if (hasChildren && depth < 2) {
        // depth 0=分组 1=连接 2=数据库 → 展开 0/1，把"数据库层"露出来
        set.add(n.key);
      }
      if (n.kind === 'group' || n.kind === 'connection') walk(n.children ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return set;
}

export interface ExpansionMemory {
  /** 版本，结构变化时整体作废 */
  version: number;
  /** 连接 id → 该连接下展开的节点 key 集合 */
  byConnection: Record<string, string[]>;
  /** 最近打开的对象 key，用于滚动定位 */
  lastOpened?: string | null;
}

export const EXPANSION_MEMORY_VERSION = 1;

export function emptyMemory(): ExpansionMemory {
  return { version: EXPANSION_MEMORY_VERSION, byConnection: {}, lastOpened: null };
}

/** 连接 id 之外的分组节点 key 单独存（分组是全局的，不挂在任何连接下） */
export function saveExpansion(
  memory: ExpansionMemory,
  expanded: ReadonlySet<string>,
  connectionIds: string[],
): ExpansionMemory {
  const byConnection: Record<string, string[]> = {};
  for (const id of connectionIds) {
    const prefix = `db:${id}:`;
    const keys = [...expanded].filter((k) => k.startsWith(prefix) || k.startsWith(`kind:${id}:`));
    if (keys.length > 0) byConnection[id] = keys;
  }
  return { ...memory, version: EXPANSION_MEMORY_VERSION, byConnection };
}

/**
 * 恢复展开状态。
 *
 * 只恢复**仍然存在的节点 key** —— 表被删了/改名了，旧 key 自然失效，
 * 静默丢弃即可，不该报错也不该让树抖。
 */
export function restoreExpansion(
  memory: ExpansionMemory | null | undefined,
  roots: TreeNode[],
  connectionIds: string[],
): Set<string> {
  if (!memory || memory.version !== EXPANSION_MEMORY_VERSION) return defaultExpanded(roots);

  const valid = new Set(collectKeys(roots));
  const set = new Set<string>([...expandedGroupsAndConnections(roots)]);
  for (const id of connectionIds) {
    for (const k of memory.byConnection[id] ?? []) {
      if (valid.has(k)) set.add(k);
    }
  }
  return set;
}

function collectKeys(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n.key);
      walk(n.children ?? []);
    }
  };
  walk(roots);
  return out;
}

/** 分组与连接节点始终展开（它们是容器，收起来会让用户找不到库） */
function expandedGroupsAndConnections(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'group' || n.kind === 'connection') {
        out.push(n.key);
        walk(n.children ?? []);
      }
    }
  };
  walk(roots);
  return out;
}

/** 切换展开：返回新的 Set（不可变，避免 React 漏渲染） */
export function toggleExpanded(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 展开某节点的所有祖先（搜索定位用） */
export function expandAncestors(
  expanded: ReadonlySet<string>,
  roots: TreeNode[],
  key: string,
): Set<string> {
  const parentOf = new Map<string, string | null>();
  const walk = (nodes: TreeNode[], parent: string | null) => {
    for (const n of nodes) {
      parentOf.set(n.key, parent);
      walk(n.children ?? [], n.key);
    }
  };
  walk(roots, null);
  if (!parentOf.has(key)) return new Set(expanded);

  const next = new Set(expanded);
  let cur = parentOf.get(key) ?? null;
  while (cur) {
    next.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return next;
}

// ---------- 搜索 ----------

/**
 * 拼音首字母匹配（§6.2.2：`dd` → `订单`）。
 *
 * 实现口径：**显式汉字 → 首字母映射，只覆盖数据库领域常见字**。
 *
 * 为什么不引拼音词典：全量转换要带几百 KB 词表，直接与"首屏 bundle ≤1.5MB"的
 * 硬约束冲突，而搜表名其实只需要这些高频字。
 * 为什么不用 Unicode 区段猜首字母：试过，**会错** —— 例如"单"(U+5355) 按区段
 * 落进 b 区，实际是 d。猜错比不支持更糟，用户会以为功能坏了。
 *
 * 未命中的字跳过（不占首字母位），最终退化为子串匹配，不影响搜索正确性。
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
  引: 'y', 外: 'w', 键: 'j', 主: 'z',
};

function pinyinFirstLetters(s: string): string {
  let out = '';
  for (const ch of s) {
    const hit = PINYIN_FIRST_LETTER[ch];
    if (hit) out += hit;
    else if (/[a-z]/i.test(ch)) out += ch.toLowerCase();
    // 未命中的汉字跳过：宁可少匹配，也不要猜错
  }
  return out;
}

export interface TreeSearchOptions {
  /** Q2：按字段名搜表（需要 columnIndex） */
  columnIndex?: Record<string, string[]>;
  /** 结果上限，防止上万表时列表爆炸 */
  limit?: number;
}

export interface TreeSearchHit {
  key: string;
  label: string;
  /** 路径：连接 / 库 */
  path: string;
  /** 命中原因 */
  matchedBy: 'name' | 'column';
  table?: TableMeta;
  /**
   * 命中节点的类型（P0-2）。容器节点（分组/连接/库）也能被搜到：
   * 命中它们时 UI 应「选中 + 展开」，而不是当成可打开的表。
   */
  kind?: TreeNodeKind;
  /** 列命中（Q2）专有：命中字段所在的库与表 —— 树里没有对应节点，由渲染层跳转 */
  database?: string;
  tableName?: string;
}

/**
 * 搜索树节点。
 *
 * P0-2（审计）：**全树可见 + 容器名可搜**。
 *  - 旧实现只搜对象节点（表/视图/…），于是连接名、库名、分组名在任何维度都搜不到；
 *  - 现在连容器节点一起搜（命中后 UI 表现为「可点击行」，点击 = 选中 + 展开）。
 *
 * 命中字段名时（Q2）返回的是**包含该字段的表**，而不是字段本身。
 */
export function searchTree(
  roots: TreeNode[],
  query: string,
  opts: TreeSearchOptions = {},
): TreeSearchHit[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [];

  const limit = opts.limit ?? 200;
  const hits: TreeSearchHit[] = [];
  const seen = new Set<string>();

  const push = (n: TreeNode, path: string, matchedBy: 'name' | 'column') => {
    if (hits.length >= limit || seen.has(n.key)) return;
    seen.add(n.key);
    hits.push({ key: n.key, label: n.label, path, matchedBy, table: n.table, kind: n.kind });
  };

  const walk = (nodes: TreeNode[], path: string) => {
    for (const n of nodes) {
      const lower = n.label.toLowerCase();
      const nameHit = lower.includes(q) || pinyinFirstLetters(n.label).startsWith(q);
      if (n.kind === 'object' && n.table) {
        if (nameHit) push(n, path, 'name');
      } else if (n.kind === 'connection' || n.kind === 'database' || n.kind === 'group') {
        // 容器节点也参战：搜「本地测试」「order_db」必须命中
        if (nameHit) push(n, path, 'name');
      }
      const nextPath = n.kind === 'connection' ? n.label : n.kind === 'database' ? `${path} / ${n.label}` : path;
      walk(n.children ?? [], nextPath);
    }
  };
  walk(roots, '');

  // Q2：按字段名反查表
  if (opts.columnIndex) {
    for (const [colName, tables] of Object.entries(opts.columnIndex)) {
      if (!colName.toLowerCase().includes(q)) continue;
      for (const qualified of tables) {
        const [db, table] = qualified.split('.');
        const hit: TreeSearchHit = {
          key: `col:${db}.${table}.${colName}`,
          label: `${table}（含字段 ${colName}）`,
          path: db ?? '',
          matchedBy: 'column',
          database: db,
          tableName: table,
        };
        if (seen.has(hit.key)) continue;
        seen.add(hit.key);
        if (hits.length < limit) hits.push(hit);
      }
    }
  }

  return hits;
}

/** 搜索时过滤扁平列表：保留命中节点及其祖先链 */
export function filterFlatByQuery(flat: FlatNode[], hits: TreeSearchHit[]): FlatNode[] {
  if (hits.length === 0) return [];
  const hitKeys = new Set(hits.map((h) => h.key));
  const parentOf = new Map<string, string | null>();
  for (const f of flat) parentOf.set(f.node.key, f.parentKey);

  const keep = new Set<string>();
  for (const k of hitKeys) {
    let cur: string | null | undefined = k;
    while (cur) {
      keep.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  return flat.filter((f) => keep.has(f.node.key));
}

/**
 * Q2 的列索引：字段名 → 命中表清单（`db.table`）。
 *
 * 由渲染层从 schema 缓存一次性建好传给 `searchTree` —— 纯内存 Map，
 * 不做模糊、不做分词，匹配规则统一走 searchTree 里的 `includes`。
 * 同一张表同一个字段名只记一次（字段名重复出现在多列时去重）。
 */
export function buildColumnIndex(
  schemas: Record<string, DatabaseMeta[]>,
): Record<string, string[]> {
  const idx = new Map<string, Set<string>>();
  for (const dbs of Object.values(schemas)) {
    for (const db of dbs) {
      for (const t of db.tables) {
        for (const c of t.columns) {
          let set = idx.get(c.name);
          if (!set) {
            set = new Set();
            idx.set(c.name, set);
          }
          set.add(`${db.name}.${t.name}`);
        }
      }
    }
  }
  return Object.fromEntries([...idx].map(([k, v]) => [k, [...v]]));
}

// ---------- 危险操作（§6.2.2） ----------

export type ConfirmLevel = 'none' | 'confirm' | 'typeToConfirm';

/**
 * 危险操作需要几层确认。
 * 删除表 / 截断表：二次确认；生产环境（红色标签）再加一层——需手动输入表名。
 */
export function confirmLevelFor(action: 'dropTable' | 'truncateTable', danger: boolean): ConfirmLevel {
  if (action !== 'dropTable' && action !== 'truncateTable') return 'none';
  return danger ? 'typeToConfirm' : 'confirm';
}

// ---------- 多选（v0.6.0）----------

/**
 * 树上一次"点击"的修饰键意图。
 *
 * 抽成显式类型而不是直接把 React 的 MouseEvent 传进来：
 * 选择规则是纯逻辑，放core 里能离线单测（渲染层只负责把 event 翻译成它）。
 */
export type SelectionIntent =
  /** 无修饰键单击：唯一选中（且成为 shift 的锚点） */
  | 'replace'
  /** ⌘/Ctrl 点击：切换该行的选中态（点已选的 = 取消选中） */
  | 'toggle'
  /** ⇧ 点击：从锚点起**按可见顺序**切成区间 */
  | 'range';

/** 把鼠标事件的修饰键翻译成选择意图。⌘ 与 Ctrl 同义（macOS 惯用 ⌘，其他平台 Ctrl） */
export function selectionIntentOf(e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): SelectionIntent {
  if (e.shiftKey) return 'range';
  if (e.metaKey || e.ctrlKey) return 'toggle';
  return 'replace';
}

/**
 * 树上一次点击后的新选中集合。
 *
 * 三种语义（对齐 Finder / VSCode 的成熟惯例）：
 *  - replace：清空后只留这一行，锚点移到这一行
 *  - toggle：并入/移出，**锚点不动**（连点多个 ⌘ 后按 ⇧，区间应从锚点算起）
 *  - range ：从锚点到本行取一段。**锚点缺失时退化为 replace** ——
 *    ���户 ⇧ 点了一行、还没点过别的，此时没有"起点"的概念，退化成单选最符合直觉
 *
 * @param visibleKeys 当前**可见行**的 key 有序列表（区间按可见顺序，不能按全树顺序）
 * @param selected    当前选中集合
 * @param anchorKey   上一次 replace 点击的行 key；null = 还没有锚点
 */
export function nextSelection(
  visibleKeys: readonly string[],
  selected: ReadonlySet<string>,
  anchorKey: string | null,
  targetKey: string,
  intent: SelectionIntent,
): { selected: Set<string>; anchorKey: string | null } {
  if (intent === 'replace') {
    return { selected: new Set([targetKey]), anchorKey: targetKey };
  }

  if (intent === 'toggle') {
    const next = new Set(selected);
    if (next.has(targetKey)) next.delete(targetKey);
    else next.add(targetKey);
    // 锚点刻意不动：⌘ 点选多个后按 ⇧，区间应从最初那行算起
    return { selected: next, anchorKey };
  }

  // range
  if (anchorKey == null || !visibleKeys.includes(anchorKey)) {
    return { selected: new Set([targetKey]), anchorKey: targetKey };
  }
  const a = visibleKeys.indexOf(anchorKey);
  const b = visibleKeys.indexOf(targetKey);
  if (a < 0 || b < 0) {
    // 锚点或目标不在可见列表里（搜索过滤后发生）→ 退化为单选，别给用户一个空区间
    return { selected: new Set([targetKey]), anchorKey: targetKey };
  }
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  // 🔴 区间是**替换**而不是并入（Finder 行为）：否则 ⇧ 永远只会越选越多，
  //   用户没法把选区缩小回去。
  return { selected: new Set(visibleKeys.slice(lo, hi + 1)), anchorKey };
}

/**
 * 全选当前可见行中属于指定分组的表节点（"全选本组"）。
 *
 * 只收`kind === 'table'` —— 视图/存储过程/函数没有"批量删表"的入口，
 * 把它们混进来会让批量删除列表出现用户没预期的对象。
 *
 * @param tableKeys 本组内所有表节点的 key（由调用方按可见顺序给出）
 */
export function selectAllTables(tableKeys: readonly string[]): Set<string> {
  return new Set(tableKeys);
}
