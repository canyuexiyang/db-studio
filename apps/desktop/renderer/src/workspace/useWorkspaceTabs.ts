/**
 * 多标签工作区状态（P0-4，PRD §三栏布局 + §9.1 快捷键）
 *
 * 模型：
 *  - table tab：connId/database/tableName + 已加载数据（payload/sorts/filter/truncated/queryMs）
 *               —— 切换保留全部状态（PRD：「关闭/切接保留状态」）
 *  - query tab：编辑器文档由 SqlEditorPanel 实例自持（DOM 隐藏保留），
 *               这里只存 id/title/connId/database
 *
 * 关闭语义（PRD §8.5）：table tab 有脏单元格 → 调用方必须先确认（App 层接
 * confirmDanger / window.confirm），本 hook 只提供数据，不做 UI。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ColumnarPayload } from '@dbstudio/core-ipc-codec';
import type { SortSpec } from '@dbstudio/core-grid-view';
import type { FilterModel } from '@dbstudio/core-filter';
import type { TableMeta } from '@dbstudio/core-schema-cache';

export interface TableTabState {
  id: string;
  kind: 'table';
  title: string;
  connId: string;
  database: string;
  tableName: string;
  /** 打开时取的元数据（schema 刷新后由调用方更新） */
  table: TableMeta;
  // ---- 数据状态（切换保留） ----
  payload: ColumnarPayload | null;
  sorts: SortSpec[];
  filter: FilterModel | null;
  truncated: boolean;
  queryMs: number | null;
  loading: boolean;
  /**
   * T47：最近一次加载的**真实错误**（null = 没出错）。
   *
   * 为什么进 tab 状态而不是只 toast：空白区要能区分「零行」与「查挂了」。
   * 只靠 toast 的话，用户关掉提示后面对空白网格无从判断，切走再切回来
   * 更是完全看不到失败过。
   */
  loadError: string | null;
  /** 脏单元格计数（关闭拦截用） */
  dirtyCount: number;
}

export interface QueryTabState {
  id: string;
  kind: 'query';
  title: string;
  /** null = 未绑定连接（用户还没连过库时开的首个查询页） */
  connId: string | null;
  database: string | null;
  initialSql: string;
}

export type WorkspaceTab = TableTabState | QueryTabState;

let tabSeq = 0;
function nextTabId(kind: 'table' | 'query'): string {
  tabSeq += 1;
  return `${kind === 'table' ? 't' : 'q'}${tabSeq}`;
}

export interface WorkspaceTabsApi {
  tabs: WorkspaceTab[];
  activeId: string | null;
  active: WorkspaceTab | null;
  /** 同库同名表已开 → 复用（聚焦），否则新开 */
  openTable(connId: string, database: string, table: TableMeta): { id: string; needsLoad: boolean };
  newQuery(connId: string | null, database: string | null, initialSql?: string): string;
  closeTab(id: string): void;
  activate(id: string): void;
  /** 切换到左/右邻 tab（⌘Shift+[ / ]） */
  cycle(delta: -1 | 1): void;
  /** 跳到第 N 个（⌘1..9） */
  jumpTo(index: number): void;
  /** 更新某个 tab 的局部状态（table tab 数据刷新） */
  patchTable(id: string, patch: Partial<TableTabState>): void;
  /** query tab 改连接/库上下文 */
  patchQuery(id: string, patch: Partial<QueryTabState>): void;
  getTable(id: string): TableTabState | null;
}

export function useWorkspaceTabs(): WorkspaceTabsApi {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  /**
   * 打开表 tab。
   *
   * 🔴 返回 `needsLoad` 而不是让调用方读 tabsRef：`setTabs` 是异步调度，
   *    调用方在 openTable 之后立刻 `getTable(id)` 拿到的是【旧引用】（null），
   *    首次打开表会因此永远不触发数据加载（真机抓到的 P0-4 集成 bug）。
   *    needsLoad 由本函数在 setTabs 之前算好，调用方不必再读状态。
   */
  const openTable = useCallback(
    (connId: string, database: string, table: TableMeta): { id: string; needsLoad: boolean } => {
      // 复用：同连接同库同表 → 聚焦既有 tab（Navicat 习惯）
      const existing = tabsRef.current.find(
        (t): t is TableTabState =>
          t.kind === 'table' && t.connId === connId && t.database === database && t.tableName === table.name,
      );
      if (existing) {
        // 元数据可能刷新过（新建列等），跟上
        setTabs((ts) => ts.map((t) => (t.id === existing.id && t.kind === 'table' ? { ...t, table } : t)));
        setActiveId(existing.id);
        return { id: existing.id, needsLoad: existing.payload === null };
      }
      const id = nextTabId('table');
      const tab: TableTabState = {
        id,
        kind: 'table',
        title: table.name,
        connId,
        database,
        tableName: table.name,
        table,
        payload: null,
        sorts: [],
        filter: null,
        truncated: false,
        queryMs: null,
        loading: false,
        loadError: null,
        dirtyCount: 0,
      };
      setTabs((ts) => [...ts, tab]);
      setActiveId(id);
      return { id, needsLoad: true };
    },
    [],
  );

  const newQuery = useCallback(
    (connId: string | null, database: string | null, initialSql = 'SELECT * FROM '): string => {
      const id = nextTabId('query');
      const tab: QueryTabState = { id, kind: 'query', title: `查询 ${tabSeq}`, connId, database, initialSql };
      setTabs((ts) => [...ts, tab]);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      if (idx < 0) return ts;
      const next = ts.filter((t) => t.id !== id);
      // 关掉的是激活 tab → 激活邻位（优先右，没有则左）
      setActiveId((cur) => {
        if (cur !== id) return cur;
        return next[Math.min(idx, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const cycle = useCallback((delta: -1 | 1) => {
    const cur = tabsRef.current;
    if (cur.length === 0) return;
    const idx = cur.findIndex((t) => t.id === activeId);
    const next = cur[(idx + delta + cur.length) % cur.length];
    if (next) setActiveId(next.id);
  }, [activeId]);

  const jumpTo = useCallback((index: number) => {
    const t = tabsRef.current[index];
    if (t) setActiveId(t.id);
  }, []);

  const patchTable = useCallback((id: string, patch: Partial<TableTabState>) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'table' ? { ...t, ...patch } : t)));
  }, []);

  const patchQuery = useCallback((id: string, patch: Partial<QueryTabState>) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'query' ? { ...t, ...patch } : t)));
  }, []);

  const getTable = useCallback(
    (id: string): TableTabState | null => {
      const t = tabsRef.current.find((x) => x.id === id);
      return t && t.kind === 'table' ? t : null;
    },
    [],
  );

  const active = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);

  return {
    tabs,
    activeId,
    active,
    openTable,
    newQuery,
    closeTab,
    activate,
    cycle,
    jumpTo,
    patchTable,
    patchQuery,
    getTable,
  };
}
