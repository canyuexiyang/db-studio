/**
 * 导出「范围口径」统一解析（T40）
 *
 * 为什么单独一层：导出弹窗要同时回答三个问题，而它们过去散在 UI 与 worker 里：
 *  1. 导哪些行 —— 选区 / 当前已加载 / 全部匹配（外加 E4 整库）；
 *  2. 行从哪来 —— **快照**（网格里已经有的行，导完不再查库）还是**重查**
 *    （服务端再跑一次 SQL）；两者的结果可以不一样，必须让用户看见；
 *  3. 导哪些列 —— 全列还是网格当前可见列。
 * 三件事都是纯数据变换，放这里才能被单测钉住；UI 只负责把选项与原因显示出来。
 *
 * 🔴 快照 vs 重查不是文案差异：查询结果导出走 worker 重跑 SQL，NOW()/RAND()/
 *    导出期间的并发写入都会让文件与屏幕上看到的结果不同（REQ §5 X03/X04）。
 *    所以每个范围都带 `source` 标记，UI 必须原样告诉用户，不能含糊成「导出结果」。
 *
 * 🔴 列裁剪必须连行一起裁：快照行是按「全列」存的数组，只过滤列名会让表头
 *    （2 列）与数据（4 列）错位 —— 文件能打开但列全串位，属于数据损坏。
 */

import { buildColumnScopedExportSql, buildFilteredExportSql } from './exportSql';

/** 导出行范围。整库（E4）保留为独立口径，它没有「列」概念 */
export type ExportScopeId = 'selection' | 'loaded' | 'matched' | 'database';

/** 数据来源：snapshot = 导出眼前这份结果；requery = 服务端重新执行查询 */
export type ExportSource = 'snapshot' | 'requery';

export interface ExportColumn {
  name: string;
  dataType?: string;
}

/** 判定选项可用性所需的宿主能力（缺什么就禁用什么，并给出原因） */
export interface ScopeFacts {
  /** 自定义 SQL 结果集（B7）：没有表上下文，只有原 SQL */
  hasSql: boolean;
  /** 有表上下文（表 tab / 树右键的表） */
  hasTable: boolean;
  /**
   * 0.7.3（P1-24）：有**库**上下文但没有具体表（树右键「导出整库…」）。
   *
   * 为什么单独一个字段：整库导出的可用性此前绑在 `hasTable` 上，于是「在库节点上
   * 导出整库」这条最自然的路径反而点不了整库（既没表也没有 SQL）。库级入口的
   * 整库是**唯一**有意义的范围，其余三项应如实禁用。
   */
  hasDatabase?: boolean;
  /** 有生效的筛选条件 */
  filterActive: boolean;
  /** 网格选区行数；null = 宿主没有选区快照 */
  selectionRowCount: number | null;
  /** 网格当前已加载行数；null = 宿主没有当前 payload */
  loadedRowCount: number | null;
  /** 网格当前可见列数；null = 网格未上报可见列 */
  visibleColumnCount: number | null;
  /** 结果集列数 */
  columnCount: number;
}

export interface ScopeOption {
  id: ExportScopeId;
  label: string;
  /** 一句话说明：必须写清是快照还是重查 */
  hint: string;
  source: ExportSource;
  enabled: boolean;
  /** enabled=false 时必有值：告诉用户为什么点不了 */
  disabledReason: string | null;
}

export interface ColumnScopeOption {
  enabled: boolean;
  /** enabled=false 时必有值 */
  reason: string | null;
  /** 可见列数（null = 网格未上报） */
  visible: number | null;
  total: number;
}

/**
 * 四个行范围选项（顺序即 UI 顺序）。
 *
 * 快照类（选区/当前已加载）依赖宿主把行交给导出；没有就禁用 —— 禁用原因必须
 * 说清「当前结果集不支持快照」，不能假装成「已加载」然后偷偷去重查。
 */
export function describeScopeOptions(facts: ScopeFacts): ScopeOption[] {
  const { hasSql, hasTable, filterActive, selectionRowCount, loadedRowCount } = facts;

  const selectionHint =
    selectionRowCount != null && selectionRowCount > 0
      ? `快照：只导出网格里选中的 ${selectionRowCount.toLocaleString()} 行，不再查库。`
      : '快照：只导出网格里选中的行，不再查库。';
  const loadedHint =
    loadedRowCount != null && loadedRowCount > 0
      ? `快照：导出网格当前已加载的 ${loadedRowCount.toLocaleString()} 行，不再查库。`
      : '快照：导出网格当前已加载的行，不再查库。';

  const matchedHint = hasSql
    ? '重查：重新执行上面这条 SQL 导出全部结果行 —— 不是屏幕上这份结果的快照，NOW()/RAND() 与期间的数据变化都会进文件。'
    : filterActive
      ? '重查：按当前筛选条件重新查询整表 —— 不是当前已加载内容的快照，导出期间的数据变化会进文件。'
      : loadedRowCount != null
        ? '重查：重新查询整表全部行 —— 不是当前已加载内容的快照（网格只加载了一页），导出期间的数据变化会进文件。'
        : '重查：重新查询整表全部行 —— 不是快照，导出期间的数据变化会进文件。';

  return [
    {
      id: 'selection',
      label: '选区',
      hint: selectionHint,
      source: 'snapshot',
      enabled: selectionRowCount != null && selectionRowCount > 0,
      disabledReason:
        selectionRowCount == null
          ? '当前视图没有选区快照（网格未把选中行交给导出），暂不能只导选区'
          : selectionRowCount === 0
            ? '当前没有选中的行'
            : null,
    },
    {
      id: 'loaded',
      label: '当前已加载',
      hint: loadedHint,
      source: 'snapshot',
      enabled: loadedRowCount != null && loadedRowCount > 0,
      disabledReason:
        loadedRowCount == null
          ? '当前视图没有已加载行快照（网格未把当前结果交给导出），暂不能按已加载导出'
          : loadedRowCount === 0
            ? '当前没有已加载的行'
            : null,
    },
    {
      id: 'matched',
      label: '全部匹配',
      hint: matchedHint,
      source: 'requery',
      enabled: hasSql || hasTable,
      disabledReason: hasSql || hasTable ? null : '没有表或查询结果，无法按全部匹配导出',
    },
    {
      id: 'database',
      label: '整库',
      hint: '重查：逐表重新查询并导出结构与数据 —— 不是快照，导出期间的数据变化会进文件。',
      source: 'requery',
      // 0.7.3：库级入口（有库无表）也应能用 —— 那正是「整库」这个范围存在的理由
      enabled: !hasSql && (hasTable || facts.hasDatabase === true),
      disabledReason: hasSql
        ? '查询结果没有库范围（整库备份请从表或库入口发起）'
        : hasTable || facts.hasDatabase === true
          ? null
          : '需要表或库上下文',
    },
  ];
}

/**
 * 「仅可见列」开关的可用性。
 *
 * 为什么重查自定义 SQL 时禁用：列集合由那条 SQL 决定，裁剪只能改写用户语句
 * （加/换 SELECT 列表），与 T44「不自动改写任意 SQL 破坏语义」冲突。
 */
export function describeColumnScope(
  facts: Pick<ScopeFacts, 'hasSql' | 'visibleColumnCount' | 'columnCount'>,
  scope: ExportScopeId,
): ColumnScopeOption {
  const base = { visible: facts.visibleColumnCount, total: facts.columnCount };
  if (scope === 'database') {
    return { ...base, enabled: false, reason: '整库导出逐表输出全列，没有「可见列」概念' };
  }
  if (facts.hasSql && scope === 'matched') {
    return { ...base, enabled: false, reason: '重查自定义 SQL 时列由该语句决定，改写列清单会破坏语义' };
  }
  if (facts.visibleColumnCount == null) {
    return { ...base, enabled: false, reason: '网格未上报可见列，暂不能只导可见列' };
  }
  if (facts.visibleColumnCount === 0) {
    return { ...base, enabled: false, reason: '网格当前没有可见列' };
  }
  if (facts.columnCount === 0) {
    return { ...base, enabled: false, reason: '缺少结果集列定义，无法只导可见列' };
  }
  return { ...base, enabled: true, reason: null };
}

export interface ResolveExportInput {
  scope: ExportScopeId;
  database: string;
  tableName?: string | null;
  /** 已生效的 WHERE 子句（不含关键字；空串 = 无筛选） */
  where?: string;
  /** 自定义查询的原始 SQL（B7）；非空即走重查，绝不改写 */
  querySql?: string | null;
  /** 快照行（scope=selection/loaded 必传），数组对齐 columns */
  rows?: readonly (readonly unknown[])[] | null;
  /** 全列（顺序 = 网格列顺序） */
  columns?: readonly ExportColumn[];
  /** 网格当前可见列名（网格显示顺序） */
  visibleColumns?: readonly string[] | null;
  /** 只导出可见列 */
  onlyVisibleColumns?: boolean;
}

export interface ResolvedExport {
  scope: ExportScopeId;
  /** 快照 or 重查 —— UI 与日志都以它为准 */
  source: ExportSource;
  /** 重查：交给 worker 的 SQL；null = worker 用 `SELECT * FROM db.table` */
  sql: string | null;
  /** 快照：要写出的行（已按可见列裁好） */
  rows: readonly (readonly unknown[])[] | null;
  /** 输出列（顺序 = 网格列顺序的可见子序列） */
  columns: ExportColumn[];
  /** 快照的精确行数；重查要跑完才知道，为 null */
  rowCount: number | null;
}

/**
 * 把「范围 + 能力」解析成一条可执行的导出计划。
 *
 * @throws Error 中文原因：范围与数据不匹配（例如没有选区快照却要求导选区）
 */
export function resolveExport(input: ResolveExportInput): ResolvedExport {
  const { scope, database } = input;
  const allColumns = input.columns ? [...input.columns] : [];
  const onlyVisible = input.onlyVisibleColumns === true;
  const querySql = input.querySql?.trim() ?? '';

  // ---- 整库：逐表重查，没有列概念 ----
  if (scope === 'database') {
    if (onlyVisible) throw new Error('整库导出不支持「仅可见列」');
    if (querySql) throw new Error('查询结果没有整库范围');
    return { scope, source: 'requery', sql: null, rows: null, columns: [], rowCount: null };
  }

  // ---- 快照：只写网格里已有的行，不再查库 ----
  if (scope === 'selection' || scope === 'loaded') {
    const rows = input.rows;
    if (!rows) {
      throw new Error(scope === 'selection' ? '没有选区快照，无法只导出选区' : '没有已加载行快照，无法按已加载导出');
    }
    if (rows.length === 0) {
      throw new Error(scope === 'selection' ? '选区为空，没有可导出的行' : '当前没有已加载的行');
    }
    if (allColumns.length === 0) throw new Error('缺少结果集列定义，无法导出快照');
    const { columns: outColumns, indexes } = pickColumns(allColumns, input.visibleColumns, onlyVisible);
    return {
      scope,
      source: 'snapshot',
      sql: null,
      // 列裁剪必须连行一起裁（只裁表头会让表头与数据错位）
      rows: indexes ? rows.map((row) => indexes.map((i) => row[i])) : rows,
      columns: outColumns,
      rowCount: rows.length,
    };
  }

  // ---- 全部匹配：服务端重查 ----
  if (querySql) {
    if (onlyVisible) throw new Error('重查自定义 SQL 时列由该语句决定，不能只导出可见列');
    return { scope, source: 'requery', sql: querySql, rows: null, columns: allColumns, rowCount: null };
  }

  const tableName = input.tableName ?? '';
  if (!tableName) throw new Error('没有表上下文，无法按全部匹配导出');
  const where = input.where?.trim() ?? '';
  const picked = pickColumns(allColumns, input.visibleColumns, onlyVisible);
  return {
    scope,
    source: 'requery',
    // 只导可见列时必须由我们自己写 SELECT 列表 —— worker 的 SELECT * 不受列裁剪影响
    sql: onlyVisible
      ? buildColumnScopedExportSql(database, tableName, where, picked.columns.map((c) => c.name))
      : buildFilteredExportSql(database, tableName, where),
    rows: null,
    columns: picked.columns,
    rowCount: null,
  };
}

/**
 * 按「可见列名集合」筛列，并给出每个保留列在原始行数组里的下标。
 * 顺序保持网格列顺序（隐藏列只是不显示，不重排）。
 */
function pickColumns(
  columns: readonly ExportColumn[],
  visible: readonly string[] | null | undefined,
  onlyVisible: boolean,
): { columns: ExportColumn[]; indexes: number[] | null } {
  if (!onlyVisible) return { columns: [...columns], indexes: null };
  if (!visible) throw new Error('网格未上报可见列，无法只导出可见列');
  if (visible.length === 0) throw new Error('网格当前没有可见列，无法导出');
  if (columns.length === 0) throw new Error('缺少结果集列定义，无法只导出可见列');

  const known = new Set(columns.map((c) => c.name));
  const unknown = visible.filter((n) => !known.has(n));
  if (unknown.length > 0) throw new Error(`可见列不在结果集中：${unknown.join('、')}`);

  const wanted = new Set(visible);
  const kept: { column: ExportColumn; index: number }[] = [];
  columns.forEach((column, index) => {
    if (wanted.has(column.name)) kept.push({ column, index });
  });
  if (kept.length === 0) throw new Error('可见列与结果集列没有交集，无法导出');
  return { columns: kept.map((k) => k.column), indexes: kept.map((k) => k.index) };
}
