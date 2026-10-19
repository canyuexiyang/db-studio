/**
 * 条件条 / 快筛浮层的结构单测（T24 + T26）。
 *
 * 同 HeaderContextMenu.test.ts：没有 jsdom，用 `renderToStaticMarkup` 断言结构。
 * 交互（点 ✕ / 点应用）跑不到 —— 那些行为下沉在 `filterBarModel` 里由纯函数单测守住，
 * 这里只守「看得见的控件与它的禁用态/文案」：
 *  · 徽标上必须同时出现已生效值与草稿值（否则用户分不清）；
 *  · 做不到的事必须 disabled + 中文原因（红线：不许有看起来可点却没回调的控件）。
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import type { FilterCondition, FilterModel } from '@dbstudio/core-filter';
import type { ColumnMeta } from '@dbstudio/core-schema-cache';
import { FilterBar, type FilterBarProps } from './FilterBar';

function cond(patch: Partial<FilterCondition> & { id: string; column: string }): FilterCondition {
  return { operator: 'eq', value: '1', ...patch };
}

function model(...conditions: FilterCondition[]): FilterModel {
  return { groups: [{ id: 'g1', logic: 'AND', conditions }] };
}

function col(name: string, dataType: string): ColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    defaultValue: null,
    comment: null,
    isPrimaryKey: false,
    isUnique: false,
    autoIncrement: false,
    charset: null,
    collation: null,
  };
}

const COLUMNS = [col('id', 'bigint'), col('status', "enum('active','banned')"), col('blob_col', 'blob')];

function render(patch: Partial<FilterBarProps>): string {
  const props: FilterBarProps = {
    applied: model(cond({ id: 'c1', column: 'status', value: 'active' })),
    draft: null,
    loading: false,
    previewLabel: "WHERE `status` = 'active'",
    columns: COLUMNS,
    onRemoveCondition: () => undefined,
    onClearAll: () => undefined,
    onApplyModel: () => undefined,
    ...patch,
  };
  /**
   * React 会把属性与文本里的引号转成实体（`'` → `&#x27;`）。
   * 断言还原后再比 —— 否则「看起来对」的中文/引号断言会莫名其妙地红。
   */
  return unescapeHtml(renderToStaticMarkup(h(FilterBar, props)));
}

function unescapeHtml(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 取某个元素的**开标签**（含属性，到 '>' 为止）：禁用态与 title 都在属性里。
 * 不能按 `<span` 切分 —— 徽标内部还有嵌套的 span / button，那样只能拿到半截。
 */
function tag(html: string, testid: string, tagName = 'button'): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf(`<${tagName}`, i);
  const end = html.indexOf('>', i);
  return start < 0 || end < 0 ? '' : html.slice(start, end + 1);
}

/** 取某个元素的**整块**（含子节点，到闭合标签为止）—— 下拉的 <option> 要这么取 */
function block(html: string, testid: string, tagName = 'select'): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf(`<${tagName}`, i);
  const end = html.indexOf(`</${tagName}>`, i);
  return start < 0 || end < 0 ? '' : html.slice(start, end + tagName.length + 3);
}

describe('T26 条件条：已生效徽标', () => {
  it('每条条件一个徽标，带 cond-id / state，并有删除按钮', () => {
    const html = render({});
    expect(html).toContain('data-testid="fb-bar-chip"');
    expect(html).toContain('data-cond-id="c1"');
    expect(html).toContain('data-state="applied"');
    expect(html).toContain('data-testid="fb-bar-chip-del"');
    expect(html).toContain("`status` = 'active'");
  });

  it('WHERE 预览仍在 .filter-bar .preview 上（scripts/e2e-ui.mjs 依赖这个结构）', () => {
    const html = render({});
    expect(html).toContain('class="preview"');
    expect(html).toContain("WHERE `status` = 'active'");
  });

  it('多值 IN 条件带 IN 标记', () => {
    const html = render({
      applied: model(cond({ id: 'c1', column: 'id', operator: 'in', values: ['1', '2'] })),
      previewLabel: "WHERE `id` IN ('1', '2')",
    });
    expect(html).toContain('>IN<');
    expect(html).toContain("`id` IN ('1', '2')");
  });

  it('未填完的条件显示「未填完」而不是假装生效', () => {
    const html = render({ applied: model(cond({ id: 'c1', column: '', value: 'x' })), previewLabel: '' });
    expect(html).toContain('>未填完<');
    expect(html).toContain('data-state="incomplete"');
  });

  it('重查在途 → 状态条标 pending（不让新条件配旧数据看起来已生效）', () => {
    const html = render({ loading: true });
    expect(html).toContain('正在应用筛选');
    expect(html).toContain('data-tone="pending"');
    expect(html).toContain('data-state="pending"');
  });

  it('没有条件时「清空」禁用并给原因', () => {
    const html = render({ applied: null, previewLabel: '' });
    expect(html).toContain('data-testid="fb-bar-clear"');
    expect(tag(html, 'fb-bar-clear')).toContain('disabled');
    expect(tag(html, 'fb-bar-clear')).toContain('没有条件可清空');
  });
});

describe('T26 条件条：草稿与已生效必须分得开', () => {
  it('草稿改了同一条的值 → 徽标上同时出现已生效值与草稿值', () => {
    const html = render({
      applied: model(cond({ id: 'c1', column: 'status', value: 'active' })),
      draft: model(cond({ id: 'c1', column: 'status', value: 'banned' })),
    });
    // 证伪点：组件若只画「当前模型」的值，就不会有 draft 这一段
    expect(html).toContain('data-testid="fb-bar-chip-draft"');
    expect(html).toContain("`status` = 'active'");
    expect(html).toContain("草稿：`status` = 'banned'");
    expect(html).toContain('data-state="draft-changed"');
  });

  it('草稿与已生效一致 → 不出现草稿段（改回原值要能收敛）', () => {
    const applied = model(cond({ id: 'c1', column: 'status', value: 'active' }));
    const html = render({ applied, draft: applied });
    expect(html).not.toContain('fb-bar-chip-draft');
    expect(html).toContain('data-state="applied"');
  });

  it('只在草稿里新增 → 标 draft-new，且没有已生效值', () => {
    const html = render({
      applied: model(cond({ id: 'c1', column: 'status', value: 'active' })),
      draft: model(
        cond({ id: 'c1', column: 'status', value: 'active' }),
        cond({ id: 'c2', column: 'id', operator: 'gt', value: '10' }),
      ),
    });
    expect(html).toContain('data-kind="new"');
    expect(html).toContain('data-state="draft-new"');
    expect(html).toContain('草稿新增：');
  });

  it('草稿里删掉的 → 标 draft-removed', () => {
    const html = render({
      applied: model(cond({ id: 'c1', column: 'status', value: 'active' })),
      draft: { groups: [{ id: 'g1', logic: 'AND', conditions: [] }] },
    });
    expect(html).toContain('data-kind="removed"');
    expect(html).toContain('草稿中已移除');
  });
});

describe('T24 列头快筛浮层', () => {
  it('多值 IN 模式：给出值输入框、NOT IN 开关与规则摘要', () => {
    const html = render({ quick: { column: 'id', mode: 'in' } });
    expect(html).toContain('data-testid="fb-qf"');
    expect(html).toContain('data-testid="fb-qf-values"');
    expect(html).toContain('data-testid="fb-qf-negate"');
    expect(html).toContain('data-testid="fb-qf-summary"');
    // 还没输入 → 应用按钮必须禁用并说明，不能是一个点了没反应的按钮
    expect(tag(html, 'fb-qf-apply')).toContain('disabled');
    expect(html).toContain('请输入至少一个值');
  });

  it('单值模式：操作符下拉按列类型给（数值列没有「包含」）', () => {
    const html = render({ quick: { column: 'id', mode: 'single' } });
    expect(html).toContain('data-testid="fb-qf-op"');
    expect(html).toContain('data-testid="fb-qf-value"');
    // 只看下拉里的选项：整串里「包含」会命中 title 的说明文字
    // >xx< 只匹配 <option> 的可见文案，绕开 title 里的说明文字
    expect(block(html, 'fb-qf-op', 'select')).toContain('>大于<');
    expect(block(html, 'fb-qf-op', 'select')).not.toContain('>包含<');
  });

  it('文本列才有「包含」', () => {
    const html = render({ quick: { column: 'status', mode: 'single' } });
    expect(block(html, 'fb-qf-op', 'select')).toContain('>包含<');
  });

  it('二进制列不支持 IN → 多值按钮禁用并给原因，且自动退回单值模式', () => {
    const html = render({ quick: { column: 'blob_col', mode: 'in' } });
    expect(tag(html, 'fb-qf-mode-in')).toContain('disabled');
    expect(tag(html, 'fb-qf-mode-in')).toContain('不支持 IN 筛选');
    // 退回单值：出现值输入框而不是值列表
    expect(html).toContain('data-testid="fb-qf-value"');
    expect(html).not.toContain('data-testid="fb-qf-values"');
  });

  it('单值模式没填值 → 应用禁用并提示 NULL / 空串的写法', () => {
    const html = render({ quick: { column: 'status', mode: 'single' } });
    expect(tag(html, 'fb-qf-apply')).toContain('disabled');
    expect(html).toContain("查 NULL 写 NULL，查空串写 ''");
  });

  it('「在完整筛选器中编辑」没接宿主 → 禁用并写明原因（不静默 no-op）', () => {
    const html = render({ quick: { column: 'id', mode: 'single' } });
    expect(tag(html, 'fb-qf-builder')).toContain('disabled');
    expect(tag(html, 'fb-qf-builder')).toContain('宿主未接入筛选构建器');
  });

  it('接了宿主 → 该入口可点', () => {
    const html = render({ quick: { column: 'id', mode: 'single' }, onOpenBuilder: () => undefined });
    expect(tag(html, 'fb-qf-builder')).not.toContain('disabled');
  });

  it('浮层关着时不渲染（保持条件条是「简短」的一条）', () => {
    expect(render({})).not.toContain('data-testid="fb-qf"');
  });
});
