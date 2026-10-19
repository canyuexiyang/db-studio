/**
 * T46：活动区的**身份条**与工具栏**密度**的唯一判定处。
 *
 * ## 为什么要单独一层
 *
 * 报告 §8.2 第 1、2 条的问题是「仅靠左树的红点不够」：侧栏可以被收窄到只剩
 * 图标，右侧详情面板还可能跟随另一个选中对象。于是用户在编辑 `prod_order`
 * 的 `order_db.order_main` 时，屏幕上**没有任何一处固定显示**「我在哪个连接、
 * 哪个环境、哪个库、哪张表」。同名库/同名表跨连接时，这是数据安全的直接风险
 * （与 T02/T03 同源）。
 *
 * 这里把「该显示什么」抽成纯函数，让渲染层只做排版：
 *  - `resolveIdentity()` —— 连接名 / 环境 / 库 / 对象，四段缺一不可，
 *    缺数据时**如实写「未命名」「未分组」**，绝不静默省略（省略 = 身份丢失）；
 *  - `saveButton()` —— 保存按钮的文案与可用性。脏计数为 0 时不能只是看起来
 *    「能点但没用」，要写成明确的无改动状态；
 *  - `toolbarDensity()` —— 工具栏变窄时把低频操作收进「更多」，但
 *    **身份条 / 保存 / 筛选永不折叠**（报告 §8.2 明确要求保住核心项）。
 *
 * ## 边界
 *
 * 本模块不读 React、不读 DOM，也不做权限判定（可写性在 `editability.ts`）。
 */

/** 身份判定需要的最小连接信息（与 ConnectionConfig 的同名子集） */
export interface IdentityConn {
  id: string;
  name: string;
  /** 连接分组即「环境」（生产环境 / 开发环境 / …）；null = 未分组 */
  group?: string | null;
  /** 红色标签 = 生产（与 App 的危险确认同一口径） */
  colorTag?: string | null;
}

export interface IdentityInput {
  connId: string;
  database: string;
  /** 表名 / 视图名 / 「查询 N」这类对象标签 */
  object: string;
  kind: 'table' | 'view' | 'query' | 'other';
  conn: IdentityConn | null;
}

export type EnvTone = 'prod' | 'normal' | 'unknown';

export interface Identity {
  /** 连接名（缺失时「未命名连接」） */
  connName: string;
  /** 环境 = 连接分组（缺失时「未分组」） */
  envLabel: string;
  /** 生产（红标签）要单独着色；未分组不给「生产」以外的暗示 */
  envTone: EnvTone;
  database: string;
  object: string;
  /** 对象类型的中文名，用于「表 · order_main」这种读法 */
  objectKindLabel: string;
  /** 四段顺序固定：连接 / 环境 / 库 / 对象 —— 屏幕阅读器与 title 共用 */
  ariaLabel: string;
  /** 可复制/可断言的单行身份文本（不含密码等敏感信息） */
  plain: string;
}

export const NO_CONN_NAME = '未命名连接';
export const NO_ENV_GROUP = '未分组';
export const NO_DATABASE = '未选库';
export const NO_OBJECT = '未选对象';

const KIND_LABEL: Record<IdentityInput['kind'], string> = {
  table: '表',
  view: '视图',
  query: '查询',
  other: '对象',
};

/**
 * 解析当前活动区的身份。
 *
 * 注意：**不猜连接名**。`conn` 为 null 时写「未命名连接」，而不是拿 connId 顶替 ——
 * 用户看到一串随机 id 只会更困惑，而且会把「连接列表还没回来」伪装成正常状态。
 */
export function resolveIdentity(input: IdentityInput): Identity {
  const connName = input.conn?.name?.trim() || NO_CONN_NAME;
  const group = input.conn?.group?.trim() || '';
  const envLabel = group || NO_ENV_GROUP;
  const isProd = input.conn?.colorTag === 'red';
  // 红标签 = 生产；有分组但不是红 = 普通环境；连分组都没有 = 未知环境
  const envTone: EnvTone = isProd ? 'prod' : group ? 'normal' : 'unknown';
  const database = input.database?.trim() || NO_DATABASE;
  const object = input.object?.trim() || NO_OBJECT;
  const objectKindLabel = KIND_LABEL[input.kind];
  return {
    connName,
    envLabel,
    envTone,
    database,
    object,
    objectKindLabel,
    ariaLabel: `连接 ${connName}，环境 ${envLabel}，库 ${database}，${objectKindLabel} ${object}`,
    plain: `${connName} / ${envLabel} / ${database} / ${object}`,
  };
}

export interface SaveButtonInput {
  /** 待提交的脏单元格数量 */
  dirtyCount: number;
  /** 当前是否可写（来自 editability.ts） */
  writable: boolean;
  /** 不可写原因（writable=false 时用作 title） */
  readOnlyReason?: string;
}

export interface SaveButton {
  text: string;
  title: string;
  disabled: boolean;
  /** true = 有改动待提交（宿主可用于高亮 primary 样式） */
  pending: boolean;
}

/**
 * 保存按钮的文案。
 *
 * 三个状态必须能一眼分开（报告 §8.2：无改动时给「合理状态」）：
 *  - 不可写：`保存 ⌘S`，禁用，title 说明原因；
 *  - 可写但无改动：`保存 ⌘S`，可用但 title 写「没有待提交改动」
 *    （**不隐藏按钮** —— 按钮忽然消失比点了没反应更让人迷惑）；
 *  - 有改动：`保存 N 项 ⌘S`，把数量直接摆在按钮上。
 */
export function saveButton(input: SaveButtonInput): SaveButton {
  const pending = input.dirtyCount > 0;
  if (!input.writable) {
    return {
      text: '保存 ⌘S',
      title: input.readOnlyReason || '当前不可写',
      disabled: true,
      pending,
    };
  }
  if (!pending) {
    return { text: '保存 ⌘S', title: '没有待提交的改动', disabled: false, pending: false };
  }
  return {
    text: `保存 ${input.dirtyCount} 项 ⌘S`,
    title: `提交 ${input.dirtyCount} 个单元格的改动（先出 SQL 预演）`,
    disabled: false,
    pending: true,
  };
}

export type ToolbarDensity = 'full' | 'compact';

/**
 * 工具栏宽度低于此值就把低频操作收进「更多」。
 *
 * 阈值取 820 而不是「窗口一半」：1440 宽的窗口在侧栏 240 + 详情 300 之后
 * 工具栏仍有约 900px，这时候折叠「粘贴」会让用户以为功能没了。
 * 只有真正挤到 800 以下（窄窗口 / 侧栏拉满 / 详情展开）才折叠。
 */
export const TOOLBAR_COMPACT_BELOW = 820;

/**
 * 工具栏密度。
 *
 * 只按**可用宽度**判定，不看窗口宽度 —— 侧栏/详情面板都能拖动，
 * 同一窗口宽度下工具栏可用空间可以差 400px 以上。
 */
export function toolbarDensity(width: number): ToolbarDensity {
  return width > 0 && width < TOOLBAR_COMPACT_BELOW ? 'compact' : 'full';
}

/**
 * 哪些按钮在紧凑模式下折叠。
 *
 * **必须保留**：命令面板、新建查询、保存、筛选、身份条。
 * 其余（导出 / 导入 / 设计 / 粘贴）进「更多」。
 */
export const TOOLBAR_ALWAYS_VISIBLE = ['palette', 'new-query', 'save', 'filter'] as const;
export const TOOLBAR_COLLAPSIBLE = ['export', 'import', 'design', 'paste'] as const;

export function isCollapsed(density: ToolbarDensity, id: string): boolean {
  if (density === 'full') return false;
  return (TOOLBAR_COLLAPSIBLE as readonly string[]).includes(id);
}
