/**
 * 网格 D 的渲染结构单测（V14 列头类型 / V15 来源表 tooltip / V19 条纹后缀 / V22 提示条）。
 *
 * ⚠️ 项目里没有 jsdom / testing-library（根 vitest.config.ts 未配 environment），
 *    所以这里用 **react-dom/server 的 renderToStaticMarkup** 做结构断言：
 *    它跑一次渲染、不触发 effect、不需要 DOM，足以守住「该渲染什么节点、
 *    带什么类名与文案」，正好覆盖本轮四个特性里最容易写错的拼装部分。
 *    （交互路径 —— 点菜单、点按钮 —— 由 e2e 覆盖，不由单测假装有 DOM。）
 *
 * 断言纪律：每条都断言「改坏实现就变红」的那一个具体产物（类名 / 文案 / testid），
 * 不写 `expect(html).toBeTruthy()` 这种恒真断言。
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeColumnar, type ColumnDescriptor } from '@dbstudio/core-ipc-codec';
import { DataGrid, type GridColumn, rowStripeSuffix } from './DataGrid';
import { GridDataSource, SHOW_COLUMN_TYPES_KEY } from './useGridData';
import { buildGroupStripes } from './groupStripe';

// ---------- 环境替身 ----------

function installWindowStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  return store;
}

const REAL_WINDOW = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installWindowStorage();
});

afterEach(() => {
  if (REAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, 'window', { value: REAL_WINDOW, configurable: true, writable: true });
});

// ---------- 夹具 ----------

const DESCRIPTORS: ColumnDescriptor[] = [
  { name: 'id', typeCode: 1, sourceTable: 'orders' },
  { name: 'name', typeCode: 3, sourceTable: 'users' },
  { name: 'note', typeCode: 3, sourceTable: null },
];

function makeSource(): GridDataSource {
  return new GridDataSource(
    encodeColumnar(
      [
        [1, 'alice', 'x'],
        [2, 'bob', null],
        [3, 'bob', ''],
      ],
      DESCRIPTORS,
    ),
  );
}

const QUERY_COLUMNS: GridColumn[] = [
  { name: 'id', dataType: '', width: 100 },
  { name: 'name', dataType: '', width: 150 },
  { name: 'note', dataType: '', width: 150 },
];

interface ExtraProps {
  truncated?: boolean;
  estimatedRows?: number | null;
  rowLimit?: number;
  onLoadMore?: () => void | Promise<void>;
  groupStripeColumn?: string | null;
  onToggleGroupStripe?: (col: string | null) => void;
  columns?: GridColumn[];
}

/** 渲染一次网格，返回 HTML 字符串（不可交互，只看结构） */
function render(extra: ExtraProps = {}): string {
  const props = {
    source: makeSource(),
    columns: extra.columns ?? QUERY_COLUMNS,
    editable: false,
    sorts: [],
    onSortChange: () => undefined,
    onSave: () => undefined,
    onPaste: () => undefined,
    onDeleteRows: () => undefined,
    onCellEdited: () => undefined,
    ...extra,
  };
  return renderToStaticMarkup(h(DataGrid, props));
}

// ---------- V14：列头显示数据类型（默认关） ----------

describe('V14 列头类型文本', () => {
  it('默认关：localStorage 无值时列头不渲染类型节点', () => {
    const html = render();
    expect(html).not.toContain('class="type"');
    expect(html).not.toContain('header-type');
  });

  it('开：localStorage = "1" 时列头渲染类型文本（查询结果列退回 typeCode）', () => {
    installWindowStorage({ [SHOW_COLUMN_TYPES_KEY]: '1' });
    const html = render();
    expect(html).toContain('data-testid="header-type"');
    // id 列是数字列 → F64；name/note 是字符串列 → STR
    expect(html).toContain('>F64<');
    expect(html).toContain('>STR<');
  });

  it('宿主给了 dataType（表标签的精确类型）时不显示 typeCode 名', () => {
    installWindowStorage({ [SHOW_COLUMN_TYPES_KEY]: '1' });
    const html = render({
      columns: [
        { name: 'id', dataType: 'bigint unsigned', width: 100 },
        { name: 'name', dataType: 'varchar(255)', width: 150 },
        { name: 'note', dataType: 'text', width: 150 },
      ],
    });
    expect(html).toContain('>bigint unsigned<');
    expect(html).toContain('>varchar(255)<');
    expect(html).not.toContain('>STR<');
  });

  it('拿不到类型就不显示（🔴 不许出现 undefined / UNKNOWN）', () => {
    installWindowStorage({ [SHOW_COLUMN_TYPES_KEY]: '1' });
    const html = render({
      // 整列 NULL → typeCode 0，按"没有类型信息"处理
      columns: [{ name: 'ghost', dataType: '', width: 150 }],
    });
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('UNKNOWN');
    expect(html).not.toContain('header-type');
  });

  it('开关不影响 tooltip —— 名称/类型/注释始终在 title 里', () => {
    const html = render({
      columns: [{ name: 'id', dataType: 'bigint unsigned', comment: '主键', width: 100 }],
    });
    expect(html).toContain('bigint unsigned');
    expect(html).toContain('主键');
  });
});

// ---------- V15：来源表 tooltip ----------

describe('V15 来源表 tooltip', () => {
  it('有来源表：原生 title + 自定义浮层各一份（单表查询也照常显示）', () => {
    const html = render();
    expect(html).toContain('gd-src-tip');
    expect(html).toContain('来源表：orders');
    expect(html).toContain('来源表：users');
    // 自定义浮层与原生 title 同时存在（title 里是换行拼接的同一句）
    expect(html).toContain('来源表：orders');
    expect(html).toContain('role="tooltip"');
  });

  it('sourceTable 为 null 的列不显示任何来源表提示', () => {
    const html = render({ columns: [QUERY_COLUMNS[2]] });
    expect(html).not.toContain('gd-src-tip');
    expect(html).not.toContain('来源表');
  });

  it('载荷没有列描述符信息时整体降级（不显示、不报错）', () => {
    const bare = new GridDataSource(encodeColumnar([[1, 'a']], ['c0', 'c1']));
    const html = renderToStaticMarkup(
      h(DataGrid, {
        source: bare,
        columns: [
          { name: 'c0', dataType: '', width: 100 },
          { name: 'c1', dataType: '', width: 100 },
        ],
        editable: false,
        sorts: [],
        onSortChange: () => undefined,
        onSave: () => undefined,
        onPaste: () => undefined,
        onDeleteRows: () => undefined,
        onCellEdited: () => undefined,
      }),
    );
    expect(html).not.toContain('gd-src-tip');
    expect(html).not.toContain('undefined');
  });
});

// ---------- V19：分组条纹后缀 ----------

describe('V19 行 className 分组条纹后缀', () => {
  it('后缀带前导空格（漏了就变成 grid-rowgrp-a，静默失效）', () => {
    const stripes = buildGroupStripes(['a', 'a', 'b', 'b', 'c']);
    expect(rowStripeSuffix(stripes, 0)).toBe(' grp-a');
    expect(rowStripeSuffix(stripes, 2)).toBe(' grp-b');
    expect(rowStripeSuffix(stripes, 4)).toBe(' grp-a');
  });

  it('未开启（条纹表长度 0）→ 空后缀，行 className 与原来完全一致', () => {
    const off = buildGroupStripes([], { enabled: false });
    expect(rowStripeSuffix(off, 0)).toBe('');
    expect(rowStripeSuffix(off, 99)).toBe('');
  });

  it('越界行号（虚拟滚动缓冲外）不产生类名', () => {
    const stripes = buildGroupStripes(['a', 'b']);
    expect(rowStripeSuffix(stripes, -1)).toBe('');
    expect(rowStripeSuffix(stripes, 2)).toBe('');
  });

  it('分组边界按「相邻值是否相同」翻转：1,1,2,2,3 → A,A,B,B,A', () => {
    const stripes = buildGroupStripes([1, 1, 2, 2, 3]);
    expect([0, 1, 2, 3, 4].map((r) => rowStripeSuffix(stripes, r).trim())).toEqual([
      'grp-a',
      'grp-a',
      'grp-b',
      'grp-b',
      'grp-a',
    ]);
  });

  it('开了分组列也不影响既有斑马纹类名（两条维度独立，.alt 仍按全局行号）', () => {
    const html = render({ groupStripeColumn: 'name' });
    // 静态渲染下没有可视行（viewportHeight 未知），但列头与提示条不应受影响
    expect(html).toContain('grid-header');
    expect(html).not.toContain('grp-');
  });
});

// ---------- V22：加载更多 / 大表警告 ----------

describe('V22 加载更多提示条', () => {
  it('零接线（什么都不传）→ 不出现提示条，网格外观不变', () => {
    const html = render();
    expect(html).not.toContain('load-more-bar');
  });

  it('被截断 + 接了 onLoadMore → 提示条 + 按钮', () => {
    const html = render({ truncated: true, onLoadMore: () => undefined });
    expect(html).toContain('data-testid="load-more-bar"');
    expect(html).toContain('已加载 3 行，可能还有更多');
    expect(html).toContain('data-testid="btn-load-more"');
    expect(html).toContain('>加载更多<');
  });

  it('没接 onLoadMore → 只有提示文案，绝不画点了没反应的按钮', () => {
    const html = render({ truncated: true });
    expect(html).toContain('data-testid="load-more-bar"');
    expect(html).not.toContain('btn-load-more');
    expect(html).not.toContain('加载更多');
  });

  it('行数达到 limit 且有估算 → 显示估算文案', () => {
    const html = render({ rowLimit: 3, estimatedRows: 5000, onLoadMore: () => undefined });
    expect(html).toContain('data-testid="load-more-bar"');
    expect(html).toContain('约 5,000 行（InnoDB 估算）');
    expect(html).toContain('data-testid="btn-load-more"');
  });

  it('已加载完（估算 ≤ 已加载）→ 不提示、不画按钮', () => {
    const html = render({ rowLimit: 3, estimatedRows: 3, onLoadMore: () => undefined });
    expect(html).not.toContain('load-more-bar');
  });

  it('大表警告：估算超阈值 → 警告文案出现（说明会拉全表、可能很慢）', () => {
    const html = render({ estimatedRows: 250_000, rowLimit: 3, onLoadMore: () => undefined });
    expect(html).toContain('data-testid="large-table-warn"');
    expect(html).toContain('超过 100,000 行');
    expect(html).toContain('拉全表');
    expect(html).toContain('建议先筛选');
  });

  it('提示条挂在滚动区之外（不破坏 grid-canvas 的高度换算）', () => {
    const html = render({ truncated: true, onLoadMore: () => undefined });
    const barAt = html.indexOf('gd-load-bar');
    const viewportEnd = html.lastIndexOf('grid-viewport');
    expect(barAt).toBeGreaterThan(viewportEnd);
  });
});
