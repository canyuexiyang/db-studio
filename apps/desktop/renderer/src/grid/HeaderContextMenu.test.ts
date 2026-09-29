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

function render(patch: Partial<HeaderContextMenuProps>): string {
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
  return renderToStaticMarkup(h(HeaderContextMenu, props));
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
