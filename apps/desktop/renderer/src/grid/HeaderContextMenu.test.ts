/**
 * 列头右键菜单单测（V14「显示列类型」/ V19「按此列分组着色」两个开关项）。
 *
 * 同 DataGrid.test.ts：没有 jsdom，用 renderToStaticMarkup 做结构断言。
 * 菜单是纯展示 + 回调，静态渲染足以守住勾选态、文案与禁用态 ——
 * 这三条正是「开关型菜单项」最容易写错的地方（用户看到勾却没生效 / 禁用了却看不出原因）。
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { HeaderContextMenu, type HeaderContextMenuProps } from './HeaderContextMenu';
import { HeaderFilterContext, type HeaderFilterBridge } from './headerFilterBridge';

/**
 * bridge 参数：undefined = 不套 provider（等同于查询结果网格），
 * 传对象 = 表网格宿主已接入。
 */
function render(patch: Partial<HeaderContextMenuProps>, bridge?: HeaderFilterBridge | null): string {
  const props: HeaderContextMenuProps = {
    menu: { x: 10, y: 20, name: 'status', originalIndex: 2 },
    canSort: true,
    hasSort: true,
    canHide: true,
    frozenCount: 0,
    visiblePos: 3,
    onClose: () => undefined,
    onSort: () => undefined,
    onCopyName: () => undefined,
    onAutoFit: () => undefined,
    onHide: () => undefined,
    onFreeze: () => undefined,
    showColumnTypes: false,
    onToggleShowTypes: () => undefined,
    ...patch,
  };
  const el = h(HeaderContextMenu, props);
  return renderToStaticMarkup(bridge === undefined ? el : h(HeaderFilterContext.Provider, { value: bridge }, el));
}

describe('V14 菜单项「显示列类型」', () => {
  it('关：无勾选标记、aria-checked=false', () => {
    const html = render({ showColumnTypes: false });
    expect(html).toContain('data-testid="ctx-show-types"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('✓');
    expect(html).toContain('显示列类型');
  });

  it('开：勾选标记出现、aria-checked=true', () => {
    const html = render({ showColumnTypes: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('✓');
  });
});

describe('V19 菜单项「按此列分组着色」', () => {
  it('未开启：文案是「按此列分组着色」，无勾选', () => {
    const html = render({ groupStripeColumn: null, onToggleGroupStripe: () => undefined });
    expect(html).toContain('data-testid="ctx-group-stripe"');
    expect(html).toContain('按此列分组着色');
    expect(html).not.toContain('取消分组着色');
    expect(html).toContain('aria-checked="false"');
  });

  it('本列正在着色：文案变「取消分组着色」并带勾', () => {
    const html = render({ groupStripeColumn: 'status', onToggleGroupStripe: () => undefined });
    expect(html).toContain('取消分组着色');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('✓');
  });

  it('着色的是**别的列**时本项不勾（口径按列名比较）', () => {
    const html = render({ groupStripeColumn: 'other', onToggleGroupStripe: () => undefined });
    expect(html).toContain('按此列分组着色');
    expect(html).toContain('aria-checked="false"');
  });

  it('宿主没接线 → 禁用并给出原因（不静默 no-op）', () => {
    const html = render({ groupStripeColumn: null });
    expect(html).toContain('disabled');
    expect(html).toContain('宿主未接线');
  });
});

function bridgeOf(canSingle: boolean, canIn: boolean, reason = ''): HeaderFilterBridge {
  return { capability: () => ({ canSingle, canIn, reason }), openColumnFilter: () => undefined };
}

/**
 * 只取某一个 <button> 的标记来判禁用 —— 全串数 `disabled` 的个数会随
 * 别人新增的禁用项漂移，那样断言就失去针对性了。
 */
function itemHtml(html: string, testid: string): string {
  return html.split('<button').find((s) => s.includes(`data-testid="${testid}"`)) ?? '';
}

describe('T24 列头快筛入口（按此列筛选 / 此列多值 IN）', () => {
  it('没有宿主接入（查询结果网格）→ 两个入口都在但禁用，并写明原因', () => {
    const html = render({});
    expect(itemHtml(html, 'ctx-header-filter')).toContain('disabled');
    expect(itemHtml(html, 'ctx-header-filter-in')).toContain('disabled');
    expect(itemHtml(html, 'ctx-header-filter')).toContain('没有接入表筛选链路');
    expect(html).toContain('按此列筛选…');
    expect(html).toContain('此列多值 IN…');
  });

  it('宿主接入且列支持 → 两个入口都可点（证伪点：加了文案没接回调时这里是 disabled）', () => {
    const html = render({}, bridgeOf(true, true));
    expect(itemHtml(html, 'ctx-header-filter')).not.toContain('disabled');
    expect(itemHtml(html, 'ctx-header-filter-in')).not.toContain('disabled');
    expect(itemHtml(html, 'ctx-header-filter')).toContain('服务端筛选');
  });

  it('列不支持 IN（如 BLOB）→ 只禁用 IN 项，原因用宿主给的文案', () => {
    const html = render({}, bridgeOf(true, false, 'blob 列不支持 IN 筛选（只能判是否为空）'));
    expect(itemHtml(html, 'ctx-header-filter-in')).toContain('disabled');
    expect(itemHtml(html, 'ctx-header-filter-in')).toContain('blob 列不支持 IN 筛选');
    expect(itemHtml(html, 'ctx-header-filter')).not.toContain('disabled');
  });

  it('宿主把整列判为不可筛选（拿不到元数据）→ 两项都禁用', () => {
    const html = render({}, bridgeOf(false, false, '拿不到这一列的元数据'));
    expect(itemHtml(html, 'ctx-header-filter')).toContain('拿不到这一列的元数据');
    expect(itemHtml(html, 'ctx-header-filter-in')).toContain('disabled');
  });
});
