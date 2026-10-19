/**
 * T25/T36 值编辑浮层的结构单测。
 *
 * 同 grid 目录其它组件：没有 jsdom，用 renderToStaticMarkup 断言**看得见的**
 * 控件状态。这里只守一条此前缺的链路：ENUM 列的浮层提交必须经过
 * `validateEnumValue` —— 非法定义值到达「好」按钮时它必须是 disabled 且
 * 原因可见（验收口径「不合法枚举不写入」；此前校验函数在生产代码零调用）。
 *
 * 交互（⌘Enter 提交、点外面关闭）跑不到 —— 那些路径上 enumError 同样由
 * commitText 内部第二道防线拦截，逻辑在组件里没法离线证伪，这里不断言。
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { ValueEditorPopover, type ValueEditorPopoverProps } from './ValueEditorPopover';
import { resolveColumnTypeInfo, type MenuItemState } from './valueEditorModel';

const OK: MenuItemState = { enabled: true, reason: '' };

function props(patch: Partial<ValueEditorPopoverProps>): ValueEditorPopoverProps {
  return {
    column: 'status',
    dataType: "enum('paid','unpaid','refunded')",
    info: resolveColumnTypeInfo({ dataType: "enum('paid','unpaid','refunded')" }),
    initialValue: 'paid',
    isInsertRow: false,
    emptyState: { enabled: false, reason: '列类型不接受空串' },
    canSetNull: true,
    useDefaultState: OK,
    useDefaultHint: '已有行：UPDATE … SET `status` = DEFAULT',
    originalValue: 'paid',
    onCommit: () => undefined,
    onDiscard: () => undefined,
    onClose: () => undefined,
    anchor: { x: 10, y: 20 },
    ...patch,
  };
}

function render(patch: Partial<ValueEditorPopoverProps>): string {
  return unescape(renderToStaticMarkup(h(ValueEditorPopover, props(patch))));
}

function unescape(s: string): string {
  return s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** 取某个 testid 的开标签（禁用态 / title 都在属性里） */
function tag(html: string, testid: string): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf('<button', i);
  const end = html.indexOf('>', i);
  return start < 0 || end < 0 ? '' : html.slice(start, end + 1);
}

describe('T25 浮层：ENUM 非法定义值不许经「好」写入', () => {
  it('当前值是定义值 → 「好」可点（对照，防一刀切禁用）', () => {
    const html = render({ initialValue: 'paid' });
    expect(tag(html, 'ce-value-editor-ok')).not.toContain('disabled');
  });

  it('初始值非法（数据比 schema 新）→ 「好」disabled 且 title 给原因', () => {
    const html = render({ initialValue: 'shipped' });
    expect(tag(html, 'ce-value-editor-ok')).toContain('disabled');
    expect(tag(html, 'ce-value-editor-ok')).toContain('不是本列定义的枚举值');
  });

  it('非法值时错误原因常驻可见（role=alert，不是只在 title 里）', () => {
    const html = render({ initialValue: 'shipped' });
    expect(html).toContain('data-testid="ce-value-editor-error"');
    expect(html).toContain('不是本列定义的枚举值');
  });

  it('当前值是 NULL → 不被枚举校验拦（「设为 NULL」是显式动作，走独立按钮）', () => {
    const html = render({ initialValue: null });
    expect(tag(html, 'ce-value-editor-ok')).not.toContain('disabled');
    expect(html).not.toContain('data-testid="ce-value-editor-error"');
  });
});
