/**
 * CodeMirror 6 编辑器内核 —— **只被动态 import 引用，绝不静态引入**。
 *
 * 这是 E1/E2 的落地点：
 *  - 本文件（连同 CodeMirror 全套）只出现在 lazy chunk 里，首屏一个字节都不占
 *  - 单独成文件就是为了这个边界 —— 谁在别处 `import` 它，谁就破坏 S2 硬约束
 *
 * 对外只暴露一个 `createSqlEditor()`，返回 imperative 句柄。
 * 不用 React 组件包 CodeMirror 是有意的：编辑器实例必须跨渲染存活，
 * 让 React 管它的生命周期会在每次父组件重渲染时打架。
 *
 * 本轮（S 板块 + P1-C）新增能力的三条共同纪律：
 *  1. **不新增任何静态 import 到首屏**。新增的纯逻辑全部来自 `@dbstudio/core-sql-editor/*`
 *     子入口，只在本文件（lazy chunk）里 import —— 面板侧只通过 imperative 句柄调用。
 *  2. **热路径不手写 DOM 遍历**。高亮走 HighlightStyle / MatchDecorator，诊断走
 *     Decoration + StateField，hover 走 hoverTooltip —— 全部是 CodeMirror 自己的机制。
 *  3. **宁可漏报不可误报**（V16）。诊断只在此处做，规则见 `filterPartialDiagnostics`。
 */

import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  hoverTooltip,
  MatchDecorator,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import { EditorState, Compartment, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { sql, MySQL } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import { buildCompletions, wordBefore, contextTableOf, statementAt } from '@dbstudio/core-sql-editor';
//
// 🔴 为什么这四个子入口走【相对路径】而不是 `@dbstudio/core-sql-editor/formatter`
//    这样的别名：本仓库根 `vitest.config.ts` 的 `resolve.alias` **实际没有生效**
//    —— 实测连只存在于 alias 里的 `@dbstudio/shared-ipc` 都解析不到
//    （`Cannot find package`），也就是说 `npx vitest run` 跑起来时根本没带上
//    alias，单侧里任何子入口 import 都会炸。
//    Vite **构建**侧的 alias（vite.config.ts 用数组 + exact 正则）是好的，
//    但那管不到 vitest。相对路径与 alias 最终指向同一个文件，产物与 chunk
//    划分完全一致（check:bundle 已验证），且 tsc / vite build / vitest 三处
//    都能解析。等 vitest 的 alias 修好后，把下面四行改回子入口即可，无需改别的。
import { formatSql } from '../../../../../packages/core-sql-editor/src/formatter.ts';
import { lintSql, type LintContext, type SqlDiagnostic } from '../../../../../packages/core-sql-editor/src/lint.ts';
import { tokenizeSql, type SqlToken } from '../../../../../packages/core-sql-editor/src/tokens.ts';
import {
  aliasMap,
  columnFacts,
  columnFlags,
  qualifierAt,
  rankTables,
  tableFactsHover,
  type ColumnFact,
} from '../../../../../packages/core-sql-editor/src/hints.ts';
import type { ColumnMeta, DatabaseMeta, TableMeta } from '@dbstudio/core-schema-cache';

export interface SqlEditorOptions {
  parent: HTMLElement;
  doc: string;
  /**
   * 补全数据源 —— 纯内存，来自已有的 schema 缓存（E4）。
   *
   * 刻意做成 getter：编辑器实例要跨渲染存活，schema 刷新时只换数据不重建编辑器
   * （重建会丢光标与撤销栈）。调用方用 `get databases() { return ref.current }` 接。
   */
  get databases(): DatabaseMeta[];
  /**
   * S3：收藏表名（**只要表名**，不含 `connId:db:` 前缀）。
   *
   * 收藏只在本文件里当作 `rankTables` 的加权输入（+40 分），不改变匹配档位 ——
   * 收藏翻不过「前缀 > 子串 > 首字母 > 子序列」这条主序（core 层保证）。
   * getter 而非快照：树里加收藏后，下一次补全就能看到。
   */
  get favorites(): readonly string[];
  /**
   * 当前查询目标库（Navicat 式库下拉的值）。
   *
   * 用于：hover / 补全的库归属展示、`lintSql` 的库内表名清单。**没有就给 null** ——
   * 没有库上下文时诊断退化为「已知表为空 → unknown-* 规则自动停摆」，不会满屏红线。
   */
  get database(): string | null;
  onChange: (doc: string) => void;
  onExecute: (mode: 'all' | 'selection') => void;
  onCancel: () => void;
  onExplain: () => void;
  onToggleComment: () => void;
  /**
   * 编辑器内部产生的中文提示上浮给 React 层（宿主接到 toast）。
   *
   * 典型场景：S1 遇到 `DELIMITER` 时格式化器拒绝改写文档 —— 这种「我什么都没做」
   * 的结果必须让用户知道原因，静默失败会被当成「⌘I 坏了」。
   */
  onNotice?: (msg: string) => void;
  /**
   * 编辑器内右键（视口坐标）。宿主据此渲染菜单 —— 菜单是 React 组件，
   * 复用既有 `.ctx-menu / .ctx-item` 样式，内核不碰任何 UI。
   */
  onContextMenu?: (at: { x: number; y: number }) => void;
}

export interface SqlEditorHandle {
  getDoc(): string;
  /** B1 规格用名：与 getDoc() 等价（保留别名，避免调用方口径混乱） */
  getText(): string;
  setDoc(text: string): void;
  selection(): { from: number; to: number };
  /** 光标所在的整条语句（§6.4.1 无选中时的执行目标） */
  statementAtCursor(): string | null;
  /**
   * S1：格式化【光标所在语句】或【选区】。
   *
   * 只由用户显式触发（⌘I / 右键菜单 / 工具栏按钮）—— 绝不挂在 change 上。
   * 走 dispatch 事务而非 setDoc，因此一步 ⌘Z 就能撤回。
   */
  format(): void;
  /**
   * B6 错误定位：把文档偏移处滚进视野并把光标挪过去。
   * 纯 UI 动作 —— 只滚动与定位，不改动文档、不触发执行。
   */
  revealOffset(offset: number): void;
  focus(): void;
  destroy(): void;
}

// ===========================================================================
// 0. 小工具
// ===========================================================================

/** 表名 / 库名在内存 schema 里的定位结果 */
export interface ResolvedTable {
  table: TableMeta;
  /** 所属库名（由调用方补齐，TableMeta 本身不带库名） */
  database: string;
}

const isSig = (t: SqlToken): boolean => t.kind !== 'whitespace' && t.kind !== 'comment';

/** 单个 token 的字符串字面量是否闭合（与 lint.ts 同口径，只看 raw） */
function isClosedLiteral(raw: string): boolean {
  const q = raw[0];
  if (q !== "'" && q !== '"' && q !== '`') return false;
  if (raw.length < 2 || raw[raw.length - 1] !== q) return false;
  // `'a\'` 这种「结尾被转义」的形态实际是未闭合；反斜杠在反引号里不是转义符
  if (q !== '`') {
    let backslashes = 0;
    for (let i = raw.length - 2; i >= 1; i--) {
      if (raw[i] !== '\\') break;
      backslashes++;
    }
    if (backslashes % 2 === 1) return false;
  }
  return true;
}

/**
 * 在内存 schema 里按名字找表（大小写不敏感）。
 *
 * 查找顺序：**当前库优先**，其次全库 —— 与用户在「已选库」下的心理预期一致，
 * 也保证 `orders` 不会先命中另一个库的同名表。
 */
export function findTableByName(
  databases: readonly DatabaseMeta[],
  database: string | null,
  name: string,
): ResolvedTable | null {
  const lower = name.toLowerCase();
  if (lower === '') return null;
  const dbs = databases ?? [];
  if (database !== null) {
    const db = dbs.find((d) => d.name === database);
    if (db) {
      const hit = (db.tables ?? []).find((tb) => tb && tb.name.toLowerCase() === lower);
      if (hit) return { table: hit, database: db.name };
    }
  }
  for (const db of dbs) {
    const hit = (db.tables ?? []).find((tb) => tb && tb.name.toLowerCase() === lower);
    if (hit) return { table: hit, database: db.name };
  }
  return null;
}

/** 按名字找库（大小写不敏感），给 `db.` 前缀补全用 */
export function findDatabaseByName(databases: readonly DatabaseMeta[], name: string): DatabaseMeta | null {
  const lower = name.toLowerCase();
  if (lower === '') return null;
  for (const db of databases ?? []) {
    if (db && db.name.toLowerCase() === lower) return db;
  }
  return null;
}

/** 收集本语句里出现的表（别名的真实表名优先，其次 contextTableOf 的推断） */
function statementTables(
  databases: readonly DatabaseMeta[],
  database: string | null,
  stmt: string,
): ResolvedTable[] {
  const out: ResolvedTable[] = [];
  const seen = new Set<string>();
  const push = (name: string | null): void => {
    if (name === null || name === '') return;
    const hit = findTableByName(databases, database, name);
    if (hit === null) return;
    const key = `${hit.database}.${hit.table.name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hit);
  };
  // 别名映射的值是真实表名（`FROM orders o` → o ⇒ orders），比正则推断可靠
  for (const name of Object.values(aliasMap(stmt))) push(name);
  push(contextTableOf(stmt));
  return out;
}

// ===========================================================================
// S1. 格式化
// ===========================================================================

/** 一次格式化的作用区间 */
export interface FormatTarget {
  from: number;
  to: number;
  /** 送入 formatSql 的原文（未经任何 trim/改写） */
  text: string;
}

/**
 * 决定这一下格式化要作用于哪一段。
 *
 *  - 有选区 → 选区原文（原样送入，不在外层 trim —— 幂等由 core 保证，外层一动就破）
 *  - 无选区 → 光标所在语句（与 ⌘R 的执行目标同口径，用户不用重新理解概念）
 *  - 空选区 / 空白 → null（调用方给「没有可格式化的内容」提示）
 */
export function formatTargetOf(doc: string, sel: { from: number; to: number }): FormatTarget | null {
  if (sel.to > sel.from) {
    const text = doc.slice(sel.from, sel.to);
    if (text.trim() === '') return null;
    return { from: sel.from, to: sel.to, text };
  }
  const span = statementAt(doc, sel.from);
  if (span === null || span.text.trim() === '') return null;
  return { from: span.from, to: span.to, text: span.text };
}

// ===========================================================================
// V16. 诊断（防抖 + 未写完的语句不报错）
// ===========================================================================

/** 防抖窗口：250~400ms 之间取 300 —— 够避开连击，又不至于让用户等 */
export const LINT_DEBOUNCE_MS = 300;

/**
 * 允许「合法地结束一条语句」的关键字。
 *
 * 没有这张表，`ORDER BY id DESC` / `WHERE x IS NULL` 会被判成"没写完"从而压制
 * 诊断 —— 那是漏报过头。表里的词都是**后面不可能再跟操作数**的收尾词。
 */
const TERMINAL_KEYWORDS = new Set(['ASC', 'DESC', 'NULL', 'TRUE', 'FALSE', 'END']);

/**
 * 判断一条语句「看起来写完了没有」。
 *
 * 判据只看**最后一个有效 token**（空白与注释透明）：
 *  - 标识符 / 引号标识符 / 数字 / `*` / 闭合字符串 / `)` → 写完
 *  - ASC / DESC / NULL / TRUE / FALSE / END → 写完（收尾关键字）
 *  - 其余（关键字、运算符、逗号、左括号、未闭合字符串）→ **没写完**
 *
 * 为什么用这么粗的判据：V16 的红线是「用户刚敲下 `SELECT ` 两个字符时不许满屏
 * 红线」。`SELECT ` / `WHERE ` / `a = ` / `FROM (` 都是还没写完的形状，一律压制
 * 才不会误报；代价是漏报一小部分（正在敲的语句不报错），这正是宁可漏报的方向。
 */
export function looksCompleteStatement(text: string): boolean {
  const toks = tokenizeSql(text).filter(isSig);
  if (toks.length === 0) return false;
  const last = toks[toks.length - 1];
  switch (last.kind) {
    case 'ident':
    case 'quoted-ident':
    case 'number':
    case 'function':
      return true;
    case 'string':
      return isClosedLiteral(last.raw);
    case 'operator':
      // `SELECT *` 的 `*` 是运算符 token，但它是完整的投影列表
      return last.raw === '*';
    case 'punct':
      return last.raw === ')';
    case 'keyword':
      return TERMINAL_KEYWORDS.has(last.upper ?? last.raw.toUpperCase());
    default:
      return false;
  }
}

/**
 * 压掉「光标正在输入的那条语句」里的诊断。
 *
 * 规则（写死在这里，逐条有单测）：
 *  1. 语句**以分号结尾**（`statementAt().terminated`）→ 用户明确写完了，不压制；
 *  2. 否则若 `looksCompleteStatement()` 为真 → 不压制；
 *  3. 否则（既没分号又没写完）→ **整条语句内的诊断全部丢弃**，其它语句照常报。
 *
 * 第 3 条是「宁可漏报不可误报」的落点：用户敲 `SELECT ` 的那一瞬间，lintSql 会
 * 报 `FROM 后面缺少表名`，但那只是"还没敲到"，不是错误。等他敲完
 * （`SELECT * FROM orders`）或敲上分号，诊断立刻出现。
 */
export function filterPartialDiagnostics(
  sql: string,
  cursor: number,
  diags: readonly SqlDiagnostic[],
): SqlDiagnostic[] {
  if (diags.length === 0) return [];
  const span = statementAt(sql, cursor);
  if (span === null) return diags.slice();
  if (span.terminated) return diags.slice();
  if (looksCompleteStatement(span.text)) return diags.slice();
  return diags.filter((d) => d.to <= span.from || d.from >= span.to);
}

/** 诊断下标夹进文档范围，并保证 from < to（Decoration.mark 不接受空区间） */
function clampDiag(d: SqlDiagnostic, docLength: number): { from: number; to: number } | null {
  const from = Math.max(0, Math.min(d.from, docLength));
  const to = Math.max(from + 1, Math.min(d.to, docLength));
  if (from >= docLength) return null;
  return { from, to };
}

/** 诊断 → 波浪/虚线下划线。类名交给 styles.css 收口，这里只给语义 */
function diagnosticsToDecorations(diags: readonly SqlDiagnostic[], docLength: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const d of diags) {
    const r = clampDiag(d, docLength);
    if (r === null) continue;
    ranges.push(
      Decoration.mark({
        class: d.severity === 'error' ? 'cm-sql-diag cm-sql-diag-error' : 'cm-sql-diag cm-sql-diag-warning',
      }).range(r.from, r.to),
    );
  }
  if (ranges.length === 0) return Decoration.none;
  return Decoration.set(ranges, true);
}

/** 诊断投递（防抖线程 → 编辑器状态）。同一个 StateEffect 保证只走一次事务 */
const setDiagnostics = StateEffect.define<readonly SqlDiagnostic[]>();

/**
 * 诊断状态。**只存诊断数组**，装饰由 `EditorView.decorations.compute` 派生 ——
 * 单一数据源，不会出现「装饰还在、数组已换」的错位。
 */
const diagnosticsField = StateField.define<readonly SqlDiagnostic[]>({
  create: () => [],
  update(list, tr) {
    // 整篇替换（历史回填 / 片段注入 / setDoc）：旧诊断指向的是旧文档，
    // 映射过去就是一堆错位的红线 —— 直接清空，等防抖重算
    if (tr.docChanged) {
      let fullReplace = true;
      tr.changes.iterChanges((fromA, toA) => {
        if (fromA !== 0 || toA !== tr.startState.doc.length) fullReplace = false;
      });
      if (fullReplace) return [];
    }
    for (const e of tr.effects) if (e.is(setDiagnostics)) return e.value;
    return list;
  },
  provide: (f) => EditorView.decorations.compute([f], (state) => diagnosticsToDecorations(state.field(f), state.doc.length)),
});

function diagnosticAt(state: EditorState, pos: number): SqlDiagnostic | null {
  for (const d of state.field(diagnosticsField)) {
    if (pos >= d.from && pos <= d.to) return d;
  }
  return null;
}

/**
 * 防抖的 lint 驱动。
 *
 * `docChanged` 与 `selectionSet` 都重新计时：光标挪到另一条语句时，"正在输入的那
 * 条语句"变了，压制范围要跟着变。定时器在 `destroy()` 里清掉 —— 编辑器销毁后
 * 再 dispatch 是 CodeMirror 里最难查的一类崩溃。
 */
function sqlLinter(run: (view: EditorView) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private disposed = false;

      constructor(private readonly view: EditorView) {
        this.schedule(0);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet) this.schedule(LINT_DEBOUNCE_MS);
      }

      destroy(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
      }

      private schedule(ms: number): void {
        if (this.disposed) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.disposed) run(this.view);
        }, ms);
      }
    },
  );
}

// ===========================================================================
// S2. SQL 语法高亮（深浅双主题）
// ===========================================================================

export type SqlThemeName = 'light' | 'dark';

/**
 * 主题唯一权威是 `document.documentElement` 上的 `data-theme`。
 *
 * 不用 `prefers-color-scheme` / `EditorView.darkTheme`：项目里主题由 JS 显式切换
 * （`public/theme-boot.js` 首帧同步写入），媒体查询只是兜底，两边必须同解。
 */
export function readTheme(): SqlThemeName {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * 深浅两套调色板。
 *
 * 全部避开紫色 / 紫蓝（色相 260~310）设计红线：关键字走蓝、函数走青绿、字符串走
 * 砖红、数字走橙、注释走灰，与 styles.css 的 --accent / --warn / --error-bar 同源。
 * 这些值**只是兜底** —— 实际颜色走 `var(--sql-*)`，宿主在 styles.css 里可整体改。
 */
const PALETTE: Record<SqlThemeName, Record<string, string>> = {
  light: {
    kw: '#0B57D0',
    fn: '#0E7C6B',
    str: '#A5352B',
    num: '#B2500A',
    com: '#6E6E73',
    id: '#1D1D1F',
    op: '#5A5A5F',
    punct: '#6E6E73',
    type: '#0B6E99',
  },
  dark: {
    kw: '#7FB3FF',
    fn: '#56D4B8',
    str: '#FF9F95',
    num: '#FFB27A',
    com: '#8A8A8E',
    id: '#F5F5F7',
    op: '#B0B0B6',
    punct: '#98989D',
    type: '#5EB0E0',
  },
};

/** `var(--sql-kw, #0B57D0)` —— 宿主给了变量就用宿主的，没给就用本主题的兜底 */
const cssv = (name: string, fallback: string): string => `var(${name}, ${fallback})`;

/**
 * 关键字 / 字符串 / 数字 / 注释 / 标识符 / 运算符 / 标点 —— lang-sql 的 styleTags 已
 * 把这些标签挂好，这里只负责配色。
 *
 * 顺序有讲究：**越具体的标签越靠前**。`t.name`（普通标识符）放最后，否则会把
 * Builtin / QuotedIdentifier 这些带修饰的标签一起吃掉。
 */
function sqlHighlightStyle(theme: SqlThemeName): HighlightStyle {
  const p = PALETTE[theme];
  return HighlightStyle.define([
    { tag: t.keyword, color: cssv('--sql-kw', p.kw), fontWeight: '600' },
    { tag: [t.bool, t.null], color: cssv('--sql-kw', p.kw), fontWeight: '600' },
    { tag: [t.standard(t.name), t.special(t.name)], color: cssv('--sql-fn', p.fn) },
    { tag: t.typeName, color: cssv('--sql-type', p.type) },
    { tag: t.special(t.string), color: cssv('--sql-ident', p.id) }, // 反引号标识符 = 标识符，不是字符串
    { tag: t.string, color: cssv('--sql-str', p.str) },
    { tag: t.number, color: cssv('--sql-num', p.num) },
    { tag: [t.lineComment, t.blockComment, t.comment], color: cssv('--sql-com', p.com), fontStyle: 'italic' },
    { tag: t.operator, color: cssv('--sql-op', p.op) },
    { tag: [t.punctuation, t.paren, t.brace, t.squareBracket], color: cssv('--sql-punct', p.punct) },
    { tag: t.name, color: cssv('--sql-ident', p.id) },
  ]);
}

/**
 * 函数调用高亮。
 *
 * 为什么需要单独一层：lang-sql（Lezer）**没有** Function 节点，
 * `COUNT(` 里的 `COUNT` 与 `FROM orders` 里的 `orders` 同为 `Identifier`，
 * 光靠 HighlightStyle 无法区分。这里用 CodeMirror 官方的 `MatchDecorator`
 * —— 它只在可视行上跑正则并产出 Decoration，不碰 DOM，也不在滚动时重建整棵树。
 */
const NOT_FUNCTION_WORDS = new Set([
  'IN', 'VALUES', 'ON', 'AND', 'OR', 'NOT', 'AS', 'EXISTS', 'ANY', 'ALL', 'LIKE', 'SET',
  'BY', 'WHEN', 'THEN', 'ELSE', 'CASE', 'BETWEEN', 'IS', 'SELECT', 'FROM', 'WHERE',
  'JOIN', 'UNION', 'USING', 'HAVING', 'GROUP', 'ORDER', 'LIMIT', 'DISTINCT', 'RETURNING',
]);

function functionHighlight(theme: SqlThemeName): Extension {
  const p = PALETTE[theme];
  // 内联 var() 兜底：宿主在 styles.css 里定义 --sql-fn 即接管，未定义时用本主题色
  const style = `color: ${cssv('--sql-fn', p.fn)}`;
  const matcher = new MatchDecorator({
    regexp: /[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/g,
    decoration: (m) =>
      NOT_FUNCTION_WORDS.has(m[0].toUpperCase())
        ? null
        : Decoration.mark({ class: 'cm-sql-fn', attributes: { style } }),
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }
      update(u: ViewUpdate): void {
        this.decorations = matcher.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** 主题切换时整包换掉（高亮 + 函数层），跟着 `data-theme` 实时变 */
const themeCompartment = new Compartment();

function themeExtensions(theme: SqlThemeName): Extension {
  return [syntaxHighlighting(sqlHighlightStyle(theme)), functionHighlight(theme)];
}

/** 监听 `data-theme`。没有 document / MutationObserver（单测）就安静地什么都不做 */
function themeWatcher(onChange: () => void): Extension {
  return ViewPlugin.fromClass(
    class {
      private observer: MutationObserver | null = null;
      private current = readTheme();

      constructor() {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
        this.observer = new MutationObserver(() => {
          const next = readTheme();
          if (next === this.current) return;
          this.current = next;
          onChange();
        });
        this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }

      destroy(): void {
        this.observer?.disconnect();
        this.observer = null;
      }
    },
  );
}

// ===========================================================================
// S3 / S4. hover 信息（纯内存，绝不 IPC）
// ===========================================================================

export interface HoverInfo {
  /** 覆盖的原文区间（tooltip 定位用） */
  from: number;
  to: number;
  /** 标题：表名 或 `表.列` */
  title: string;
  /** 副标题：库名（用于 `db.table` 的语境提示） */
  subtitle: string | null;
  facts: ColumnFact[];
}

/**
 * 解析光标处的 hover 目标。**纯函数，只读内存 schema，不发任何 IPC**。
 *
 * 判定顺序：
 *  1. `x.y` 形态 → 先按别名（aliasMap）解析 x，再按表名解析，取该表的列 → `columnFacts`
 *  2. 独立标识符命中表名 → `tableFactsHover`
 *  3. 独立标识符命中本语句上下文表的列 → `columnFacts`
 * 认不出来返回 null（不猜，也不弹一个空 tooltip）。
 */
export function hoverInfoAt(
  databases: readonly DatabaseMeta[],
  database: string | null,
  sql: string,
  pos: number,
): HoverInfo | null {
  const toks = tokenizeSql(sql);
  let idx = -1;
  for (let k = 0; k < toks.length; k++) {
    if (pos >= toks[k].from && pos < toks[k].to) {
      idx = k;
      break;
    }
  }
  if (idx < 0) return null;
  const tok = toks[idx];
  if (tok.kind !== 'ident' && tok.kind !== 'quoted-ident') return null;
  const name = tok.value ?? tok.raw;
  if (name === '') return null;

  const lower = name.toLowerCase();

  // 1. 限定列：`o.id` / `orders.id`
  const dot = toks[idx - 1];
  const owner = toks[idx - 2];
  if (dot !== undefined && dot.kind === 'punct' && dot.raw === '.' && owner !== undefined) {
    if (owner.kind === 'ident' || owner.kind === 'quoted-ident') {
      const ownerName = owner.value ?? owner.raw;
      const stmt = statementAt(sql, pos)?.text ?? sql;
      const alias = aliasMap(stmt)[ownerName.toLowerCase()] ?? ownerName;
      const hit = findTableByName(databases, database, alias);
      const col = hit === null ? undefined : findColumn(hit.table, lower);
      if (hit !== undefined && hit !== null && col !== undefined) {
        return {
          from: tok.from,
          to: tok.to,
          title: `${hit.table.name}.${col.name}`,
          subtitle: hit.database,
          facts: columnFacts(col),
        };
      }
    }
  }

  // 2. 表名
  const asTable = findTableByName(databases, database, name);
  if (asTable !== null) {
    return {
      from: tok.from,
      to: tok.to,
      title: asTable.table.name,
      subtitle: asTable.database,
      facts: tableFactsHover(asTable.table),
    };
  }

  // 3. 本语句上下文表的列
  const stmt = statementAt(sql, pos)?.text ?? sql;
  for (const t of statementTables(databases, database, stmt)) {
    const col = findColumn(t.table, lower);
    if (col !== undefined) {
      return { from: tok.from, to: tok.to, title: `${t.table.name}.${col.name}`, subtitle: t.database, facts: columnFacts(col) };
    }
  }
  return null;
}

function findColumn(table: TableMeta, lowerName: string): ColumnMeta | undefined {
  for (const c of table.columns ?? []) {
    if (c && c.name.toLowerCase() === lowerName) return c;
  }
  return undefined;
}

// ===========================================================================
// S3. 补全位置判定
// ===========================================================================

/**
 * 这些关键字后面应该给**表**（而不是列 / 关键字）。
 *
 * 判据不是"前一个 token 是什么"，而是**往回跳过逗号与标识符后遇到的第一个关键字** ——
 * 这样 `FROM a, b` 的 `b` 也是表位置，而 `SELECT a, b` 的 `b` 不是。
 */
const TABLE_LEADERS = new Set([
  'FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'DATABASE', 'SCHEMA', 'DESCRIBE', 'TRUNCATE', 'ANALYZE',
]);

/**
 * 光标是否处在「该填表名」的位置。
 *
 * 只用 token 流，不用正则猜：**认不出就返回 false**，宁可退回通用补全，也不要在
 * 列位置塞一屏表名。
 */
export function isTablePosition(sql: string, pos: number): boolean {
  const toks = tokenizeSql(sql);
  let start = -1;
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].to <= pos) start = k;
    else break;
  }
  for (let k = start; k >= 0; k--) {
    const tok = toks[k];
    if (!isSig(tok)) continue;
    if (tok.kind === 'punct' && tok.raw === ',') continue;
    if (tok.kind === 'ident' || tok.kind === 'quoted-ident') continue;
    if (tok.kind === 'keyword') return TABLE_LEADERS.has(tok.upper ?? tok.raw.toUpperCase());
    return false;
  }
  return false;
}

/** CodeMirror 的 type 决定补全项图标 */
function completionTypeOf(kind: 'table' | 'column' | 'database' | 'keyword' | 'function'): string {
  switch (kind) {
    case 'function':
      return 'function';
    case 'keyword':
      return 'keyword';
    case 'column':
      return 'property';
    case 'database':
      return 'namespace';
    default:
      return 'class';
  }
}

/**
 * 字段候选项右侧的短标记（`columnFlags`）：PK / NN / AI / UQ / IDX。
 *
 * IDX 需要表上的索引清单，而 `TableMeta` 不带 indexes —— 拿不到就不显示，
 * 不猜（core 层是同样的口径）。
 */
export function columnDetail(col: ColumnMeta, table: TableMeta | null): string {
  const type = typeof col.dataType === 'string' && col.dataType.trim() !== '' ? col.dataType : '';
  const flags = columnFlags(col, table);
  if (flags.length === 0) return type;
  return type === '' ? flags.join(' ') : `${type} · ${flags.join(' ')}`;
}

// ===========================================================================
// 组装
// ===========================================================================

export function createSqlEditor(opts: SqlEditorOptions): SqlEditorHandle {
  // ---------- 补全源（S3 / S4）----------
  //
  // 两条性能约束（沿用 E4）：
  //  1. 只算【光标所在语句】的上下文，不算全文 —— 全文正则在大脚本上会卡
  //  2. 候选构建走 core 包的纯函数，天然带前缀过滤 + 条数上限

  /** 全库表清单（按 databases 引用缓存：schema 不变就不重新拼接） */
  let allTablesRef: readonly DatabaseMeta[] | null = null;
  let allTablesCache: ResolvedTable[] = [];
  const allTables = (): ResolvedTable[] => {
    const dbs = opts.databases;
    if (allTablesRef === dbs) return allTablesCache;
    const out: ResolvedTable[] = [];
    for (const db of dbs ?? []) {
      for (const tb of db?.tables ?? []) if (tb) out.push({ table: tb, database: db.name });
    }
    allTablesRef = dbs;
    allTablesCache = out;
    return out;
  };

  /** 字段候选（带 PK/NN/AI 标记）；prefix 为空时给全量（用户刚敲完 `.` 就在等它） */
  const columnOptions = (tables: readonly ResolvedTable[], prefix: string, limit: number): Completion[] => {
    const p = prefix.toLowerCase();
    const out: Completion[] = [];
    for (const t of tables) {
      for (const c of t.table.columns ?? []) {
        if (!c) continue;
        if (p !== '' && !c.name.toLowerCase().startsWith(p)) continue;
        out.push({
          label: c.name,
          type: 'property',
          detail: columnDetail(c, t.table),
          info: t.table.name,
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  };

  /** 表候选：`rankTables` 排序（收藏加权 + 前缀/子串/首字母/子序列分档） */
  const tableOptions = (tables: readonly TableMeta[], prefix: string, database: string | null): Completion[] => {
    const hints = rankTables(tables, prefix, {
      favorites: opts.favorites,
      database,
      // 传 databases 让 core 按对象引用反查每张表属于哪个库（`crm.orders` 不会
      // 被误标成 `shop.orders`）
      databases: opts.databases,
      limit: 60,
    });
    return hints.map((h) => ({
      label: h.name,
      type: 'class',
      detail: h.database ?? undefined,
    }));
  };

  const completionSource = (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const { from, word } = wordBefore(doc, context.pos);
    const dbName = opts.database;

    // A. `别名.` / `表.` / `库.` —— 限定前缀优先，因为它最确定
    const q = qualifierAt(doc, context.pos);
    if (q !== null) {
      const stmt = statementAt(doc, context.pos)?.text ?? doc;
      const aliases = aliasMap(stmt);
      const aliasTarget = aliases[q.qualifier.toLowerCase()] ?? q.qualifier;
      const asTable = findTableByName(opts.databases, dbName, aliasTarget);
      if (asTable !== null) {
        const cols = columnOptions([asTable], word, 200);
        if (cols.length > 0) return { from, options: cols, validFor: /^[A-Za-z0-9_$]*$/ };
        return null;
      }
      const asDb = findDatabaseByName(opts.databases, q.qualifier);
      if (asDb !== null) return { from, options: tableOptions(asDb.tables ?? [], word, asDb.name), validFor: /^[A-Za-z0-9_$]*$/ };
      return null;
    }

    // 空词也放行：刚敲完 `FROM ` 或 `o.` 时词是空的，但用户正等着看候选
    if (from === context.pos && !context.explicit) {
      if (!isTablePosition(doc, context.pos)) return null;
    }

    // B. 表位置 → 表名（收藏加权）+ 库名（打了前缀才给，避免空词时刷一屏库）
    if (isTablePosition(doc, context.pos)) {
      const db = dbName === null ? null : findDatabaseByName(opts.databases, dbName);
      const pool = db !== null ? db.tables ?? [] : allTables().map((r) => r.table);
      const options = tableOptions(pool, word, db !== null ? db.name : null);
      if (word !== '' && dbName === null) {
        const p = word.toLowerCase();
        for (const d of opts.databases ?? []) {
          if (d.name.toLowerCase().startsWith(p)) options.unshift({ label: d.name, type: 'namespace' });
        }
      }
      if (options.length > 0) return { from, options, validFor: /^[A-Za-z0-9_$]*$/ };
      return null;
    }

    // C. 其余位置 → 上下文表的字段（带标记）+ 关键字 + 函数
    const stmt = statementAt(doc, context.pos)?.text ?? doc;
    const ctxTables = statementTables(opts.databases, dbName, stmt);
    if (ctxTables.length > 0) {
      const cols = columnOptions(ctxTables, word, 200);
      const rest = buildCompletions(opts.databases, word, { contextTable: contextTableOf(stmt) })
        .filter((it) => it.kind === 'keyword' || it.kind === 'function')
        .map<Completion>((it) => ({
          label: it.label,
          type: completionTypeOf(it.kind),
          // 函数名自带括号，不要给 `NOW()` 再补一次 `()`
          apply: it.kind === 'function' ? it.label.replace(/\(\)$/, '()') : it.label,
        }));
      const options = [...cols, ...rest];
      if (options.length > 0) return { from, options, validFor: /^[A-Za-z0-9_$]*$/ };
      return null;
    }

    // D. 认不出上下文（无 schema / 语句还没成型）→ 退回 E4 的既有全量候选
    const items = buildCompletions(opts.databases, word, { contextTable: contextTableOf(stmt) });
    if (items.length === 0) return null;
    return {
      from,
      options: items.map((it) => ({
        label: it.label,
        type: completionTypeOf(it.kind),
        detail: it.detail ?? undefined,
        apply: it.kind === 'function' ? it.label.replace(/\(\)$/, '()') : it.label,
      })),
      validFor: /^[A-Za-z0-9_$]*$/,
    };
  };

  // ---------- S1 格式化 ----------

  const format = (): void => {
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    const target = formatTargetOf(doc, { from: sel.from, to: sel.to });
    if (target === null) {
      opts.onNotice?.('没有可格式化的内容');
      return;
    }
    const r = formatSql(target.text);
    // 拒绝格式化（如 DELIMITER）：**一个字符都不改**，只把原因告诉用户
    if (r.unsupported !== undefined) {
      opts.onNotice?.(r.unsupported);
      return;
    }
    if (!r.changed) return;

    // 光标定位：塌陷光标保持在语句内的**相对偏移**（换了个行但还在同一个词附近）；
    // 选区则整体选中格式化后的文本 —— 一眼能看出改了哪一段
    const offset = Math.max(0, Math.min(sel.from - target.from, r.text.length));
    view.dispatch({
      changes: { from: target.from, to: target.to, insert: r.text },
      selection:
        sel.to > sel.from
          ? { anchor: target.from, head: target.from + r.text.length }
          : { anchor: target.from + offset },
      // 单条事务 = 一步 ⌘Z 撤回；userEvent 标记便于将来按事件类型过滤
      userEvent: 'format.sql',
    });
  };

  /**
   * 快捷键（§6.4.1 / §6.4.2，全 Cmd 不用 Ctrl）。
   *
   * 必须放在 defaultKeymap **之前**才能覆盖它；
   * `Mod-Enter` 在 CM 里默认是 insertBlankLine，会被默认键吃掉。
   */
  const hotkeys = keymap.of([
    { key: 'Mod-r', preventDefault: true, run: () => { opts.onExecute('all'); return true; } },
    { key: 'Mod-Shift-r', preventDefault: true, run: () => { opts.onExecute('selection'); return true; } },
    { key: 'Mod-.', preventDefault: true, run: () => { opts.onCancel(); return true; } },
    { key: 'Mod-/', preventDefault: true, run: () => { opts.onToggleComment(); return true; } },
    { key: 'Mod-Shift-e', preventDefault: true, run: () => { opts.onExplain(); return true; } },
    // S1：⌘I 格式化。preventDefault 是必须的 —— 否则浏览器/CM 会把它当斜体快捷键
    { key: 'Mod-i', preventDefault: true, run: () => { format(); return true; } },
  ]);

  // ---------- V16 lint 上下文（只在防抖里构建）----------

  /**
   * 缓存键就是「表清单数组本身」：`DatabaseMeta.tables` 与 `allTables()` 的引用
   * 都随 schema 快照换而换，比拿 databases + database 拼字符串做键更不容易漏。
   */
  let lintListRef: readonly TableMeta[] | null = null;
  let lintTablesCache: string[] = [];
  let lintColsCache: Record<string, string[]> = {};

  const lintContext = (): LintContext => {
    const dbName = opts.database;
    const db = dbName === null ? null : findDatabaseByName(opts.databases, dbName);
    const list: readonly TableMeta[] = db !== null ? db.tables ?? [] : allTables().map((r) => r.table);
    // 🔴 schemaReady 只认「真的有表」。连库都没连上时这里一定是空 ——
    //    lintSql 随之停掉 unknown-table / unknown-column，不会满屏红线
    if (list.length === 0) return { schemaReady: false };

    if (lintListRef !== list) {
      lintListRef = list;
      const cols: Record<string, string[]> = {};
      const names: string[] = [];
      for (const tb of list) {
        names.push(tb.name);
        cols[tb.name] = (tb.columns ?? []).map((c) => c.name);
      }
      lintTablesCache = names;
      lintColsCache = cols;
    }
    return { schemaReady: true, tables: lintTablesCache, columns: lintColsCache };
  };

  const runLint = (v: EditorView): void => {
    const doc = v.state.doc.toString();
    const raw = lintSql(doc, lintContext());
    const cursor = v.state.selection.main.from;
    v.dispatch({ effects: setDiagnostics.of(filterPartialDiagnostics(doc, cursor, raw)) });
  };

  // ---------- hover（S4 + V16 文案）----------

  const buildFactDom = (info: HoverInfo): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'cm-sql-hover';
    const title = document.createElement('div');
    title.className = 'cm-sql-hover-title';
    title.textContent = info.title;
    box.appendChild(title);
    if (info.subtitle !== null && info.subtitle !== '') {
      const sub = document.createElement('div');
      sub.className = 'cm-sql-hover-sub';
      sub.textContent = info.subtitle;
      box.appendChild(sub);
    }
    for (const f of info.facts) {
      const row = document.createElement('div');
      row.className = 'cm-sql-hover-row';
      const k = document.createElement('span');
      k.className = 'cm-sql-hover-key';
      k.textContent = f.label;
      const val = document.createElement('span');
      val.className = 'cm-sql-hover-val';
      val.textContent = f.value;
      row.appendChild(k);
      row.appendChild(val);
      box.appendChild(row);
    }
    return box;
  };

  const buildDiagDom = (d: SqlDiagnostic): HTMLElement => {
    const box = document.createElement('div');
    box.className = `cm-sql-hover cm-sql-hover-diag ${d.severity === 'error' ? 'is-error' : 'is-warning'}`;
    box.textContent = d.message;
    return box;
  };

  const sqlHover = hoverTooltip((view, pos): Tooltip | null => {
    // 诊断优先：用户鼠标悬在红线上时，他要看的是"为什么红"
    const d = diagnosticAt(view.state, pos);
    if (d !== null) return { pos: d.from, end: d.to, create: () => ({ dom: buildDiagDom(d) }) };
    const info = hoverInfoAt(opts.databases, opts.database, view.state.doc.toString(), pos);
    if (info === null) return null;
    return { pos: info.from, end: info.to, above: true, create: () => ({ dom: buildFactDom(info) }) };
  });

  // ---------- 视图 ----------

  let applyTheme: (() => void) | null = null;

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: [completionSource], activateOnTyping: true }),
        sql({ dialect: MySQL, upperCaseKeywords: true }),
        // S2：主题相关的高亮整包放在 compartment 里，`data-theme` 一变就换
        themeCompartment.of(themeExtensions(readTheme())),
        themeWatcher(() => applyTheme?.()),
        // V16：防抖诊断
        diagnosticsField,
        sqlLinter(runLint),
        sqlHover,
        EditorView.lineWrapping,
        hotkeys,
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        // 右键菜单：内核只负责拦下原生菜单并上报坐标，UI 由 React 宿主渲染
        EditorView.domEventHandlers({
          contextmenu(event) {
            event.preventDefault();
            opts.onContextMenu?.({ x: event.clientX, y: event.clientY });
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });

  applyTheme = () => view.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(readTheme())) });

  return {
    getDoc: () => view.state.doc.toString(),
    getText: () => view.state.doc.toString(),
    setDoc(text: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    selection: () => {
      const r = view.state.selection.main;
      return { from: r.from, to: r.to };
    },
    statementAtCursor: () => statementAt(view.state.doc.toString(), view.state.selection.main.from)?.text ?? null,
    format,
    revealOffset(offset: number) {
      // 越界夹到文档范围内：调用方给的偏移来自另一时刻的拆分结果，文档可能已被编辑
      const pos = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({
        selection: { anchor: pos },
        // 居中滚动：错误行要一眼看到，贴边容易漏
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
