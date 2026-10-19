/**
 * T27 纯逻辑单测。
 *
 * 断言纪律（实施纪律 §1.5）：每条「会发生 X」都配「不会误伤 Y」的对照；
 * 集合类断言一律用**全等**（而不是 `toContain`）—— `toContain` 对
 * 「多关了一个标签」这种最恶劣的缺陷是绿的。
 */

import { describe, it, expect } from 'vitest';
import type { TableMeta } from '@dbstudio/core-schema-cache';
import type { WorkspaceTab } from './useWorkspaceTabs';
import {
  closeOthersIds,
  closeRightIds,
  dirtyEntriesOf,
  planBatchClose,
  objectIdentityOf,
  formatObjectIdentity,
  parseObjectIdentity,
  findTabByIdentity,
  treeKeyOfTab,
  buildTabMenuItems,
  TAB_IDENTITY_PREFIX,
} from './tabContextMenuModel';

function tableTab(
  id: string,
  connId: string,
  database: string,
  name: string,
  dirtyCount = 0,
): WorkspaceTab {
  return {
    id,
    kind: 'table',
    title: name,
    connId,
    database,
    tableName: name,
    table: { name, kind: 'table', columns: [] } as unknown as TableMeta,
    payload: null,
    sorts: [],
    filter: null,
    truncated: false,
    queryMs: null,
    loading: false,
    loadError: null,
    dirtyCount,
  };
}

function queryTab(id: string, connId: string | null, database: string | null): WorkspaceTab {
  return { id, kind: 'query', title: `查询 ${id}`, connId, database, initialSql: 'SELECT 1' };
}

/** 固定（不可关闭）标签：v0.7.0 还没有，用 T42 的形态提前钉住集合计算 */
const onlyNonPinned = (pinned: readonly string[]) => ({
  isClosable: (t: WorkspaceTab) => !pinned.includes(t.id),
});

describe('关闭其他 / 关闭右侧：目标集合计算', () => {
  const tabs = [
    tableTab('a', 'c1', 'db', 'ta'),
    tableTab('b', 'c1', 'db', 'tb'),
    tableTab('c', 'c1', 'db', 'tc'),
    tableTab('d', 'c1', 'db', 'td'),
  ];

  it('关闭其他：排除自己，其余按 tabs 原序全收', () => {
    expect(closeOthersIds(tabs, 'b')).toEqual(['a', 'c', 'd']);
    // 对照：自己绝不能出现在待关闭集合里（否则等于关了当前标签）
    expect(closeOthersIds(tabs, 'b')).not.toContain('b');
  });

  it('关闭右侧：只收严格在 target 之后的标签', () => {
    expect(closeRightIds(tabs, 'b')).toEqual(['c', 'd']);
    // 对照：左侧与自己都不在集合里
    expect(closeRightIds(tabs, 'b')).not.toContain('a');
    expect(closeRightIds(tabs, 'b')).not.toContain('b');
  });

  it('边界：target 是最后一个 → 关闭右侧为空（菜单项据此禁用）', () => {
    expect(closeRightIds(tabs, 'd')).toEqual([]);
    // 对照：同一条 tabs 里 target 不是最后一个时集合非空
    expect(closeRightIds(tabs, 'c')).toEqual(['d']);
  });

  it('边界：只剩自己 → 关闭其他与关闭右侧都为空', () => {
    const one = [tableTab('a', 'c1', 'db', 'ta')];
    expect(closeOthersIds(one, 'a')).toEqual([]);
    expect(closeRightIds(one, 'a')).toEqual([]);
  });

  it('边界：target 不在 tabs 里 → 空集合（不误伤其它标签）', () => {
    expect(closeOthersIds(tabs, 'zzz')).toEqual([]);
    expect(closeRightIds(tabs, 'zzz')).toEqual([]);
  });

  it('有不可关闭的标签：固定标签不进任何关闭集合', () => {
    const opts = onlyNonPinned(['c']);
    expect(closeOthersIds(tabs, 'b', opts)).toEqual(['a', 'd']);
    expect(closeRightIds(tabs, 'a', opts)).toEqual(['b', 'd']);
    // 对照：右侧只剩固定标签 → 空（这时「关闭右侧」必须禁用）
    const rightPinned = [tableTab('a', 'c1', 'db', 'ta'), tableTab('p', 'c1', 'db', 'tp')];
    expect(closeRightIds(rightPinned, 'a', onlyNonPinned(['p']))).toEqual([]);
  });
});

describe('批量关闭的脏清单（T27 核心验收：一次列全，不连弹十个框）', () => {
  it('多个脏表 → 一次列出全部，不是只返回第一个', () => {
    const tabs = [
      tableTab('a', 'c1', 'db', 'ta', 2),
      tableTab('b', 'c1', 'db', 'tb', 0),
      tableTab('c', 'c2', 'db', 'tc', 5),
      tableTab('d', 'c1', 'db', 'td', 1),
    ];
    const plan = planBatchClose(tabs, ['a', 'b', 'c', 'd']);
    expect(plan.dirty.map((d) => d.id)).toEqual(['a', 'c', 'd']);
    expect(plan.dirty.length).toBe(3);
    expect(plan.needsConfirm).toBe(true);
    // 对照：干净的那个既不在脏清单里
    expect(plan.dirty.map((d) => d.id)).not.toContain('b');
    // 「一次列全」的可读口径：每行带 库.表 与改动数
    expect(plan.dirty[2]).toMatchObject({ objectLabel: 'db.td', dirtyCount: 1 });
  });

  it('对照：没有脏标签 → 空清单、不弹框；有脏标签 → 弹一次框', () => {
    const clean = [tableTab('a', 'c1', 'db', 'ta', 0), tableTab('b', 'c1', 'db', 'tb', 0)];
    const cleanPlan = planBatchClose(clean, ['a', 'b']);
    expect(cleanPlan.dirty).toEqual([]);
    expect(cleanPlan.needsConfirm).toBe(false);

    const dirtyPlan = planBatchClose([tableTab('a', 'c1', 'db', 'ta', 1)], ['a']);
    expect(dirtyPlan.needsConfirm).toBe(true);
  });

  it('脏 + 干净混排：cleanIds 与 dirty 不相交，并集等于全部可关 id', () => {
    const tabs = [
      tableTab('a', 'c1', 'db', 'ta', 3),
      tableTab('b', 'c1', 'db', 'tb', 0),
      queryTab('q', 'c1', 'db'),
    ];
    const plan = planBatchClose(tabs, ['a', 'b', 'q']);
    const dirtyIds = plan.dirty.map((d) => d.id);
    expect(plan.cleanIds).toEqual(['b', 'q']);
    expect(plan.cleanIds.filter((id) => dirtyIds.includes(id))).toEqual([]);
    expect([...plan.cleanIds, ...dirtyIds].sort()).toEqual([...plan.closableIds].sort());
  });

  it('查询标签没有脏单元格概念 → 不计入脏清单', () => {
    const tabs = [queryTab('q', 'c1', 'db')];
    expect(dirtyEntriesOf(tabs, ['q'])).toEqual([]);
    expect(planBatchClose(tabs, ['q']).needsConfirm).toBe(false);
  });

  it('不可关闭的标签既不进待关集合，也不进待确认清单', () => {
    const tabs = [tableTab('a', 'c1', 'db', 'ta', 2), tableTab('p', 'c1', 'db', 'tp', 9)];
    const plan = planBatchClose(tabs, ['a', 'p'], onlyNonPinned(['p']));
    expect(plan.closableIds).toEqual(['a']);
    expect(plan.dirty.map((d) => d.id)).toEqual(['a']);
  });

  it('请求里的 id 不在 tabs 中 → 静默丢弃，不产生待确认项', () => {
    const plan = planBatchClose([tableTab('a', 'c1', 'db', 'ta')], ['a', 'ghost']);
    expect(plan.closableIds).toEqual(['a']);
  });
});

describe('完整对象身份：连接 / 库 / 表 三段', () => {
  it('格式稳定：dbstudio:// 前缀 + 三段', () => {
    const text = formatObjectIdentity({ connId: 'c1', database: 'order_db', name: 'prod_order' });
    expect(text).toBe(`${TAB_IDENTITY_PREFIX}c1/order_db/prod_order`);
    expect(parseObjectIdentity(text)).toEqual({
      connId: 'c1',
      database: 'order_db',
      name: 'prod_order',
    });
  });

  it('库名/表名含 / 与空格与中文 → 编码后仍能解析回原值', () => {
    const id = { connId: 'c 1', database: 'a/b', name: '订 单' };
    const parsed = parseObjectIdentity(formatObjectIdentity(id));
    expect(parsed).toEqual(id);
    // 证伪点：裸拼（不编码）会让 split('/') 多出一段 → 解析为 null
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}${id.connId}/${id.database}/${id.name}`)).toBeNull();
  });

  it('解析拒绝一切残缺格式', () => {
    expect(parseObjectIdentity('')).toBeNull();
    expect(parseObjectIdentity('c1/db/t')).toBeNull(); // 无前缀
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}c1/db`)).toBeNull(); // 只有两段
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}c1/db/t/x`)).toBeNull(); // 四段
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}/db/t`)).toBeNull(); // 空连接段
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}c1//t`)).toBeNull(); // 空库段
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}c1/db/`)).toBeNull(); // 空表段
    expect(parseObjectIdentity(`${TAB_IDENTITY_PREFIX}c1/db/%zz`)).toBeNull(); // 非法百分号编码
  });

  it('能被解析回查：两个连接同名库同名表不串', () => {
    const tabs = [
      tableTab('a', 'c1', 'order_db', 'prod_order'),
      tableTab('b', 'c2', 'order_db', 'prod_order'),
    ];
    const id = objectIdentityOf(tabs[1]);
    expect(id).not.toBeNull();
    const text = formatObjectIdentity(id!);
    // 证伪点：只按表名回查会命中 c1 的那张（跨环境串表）
    expect(findTabByIdentity(tabs, text)?.id).toBe('b');
    expect(tabs.find((t) => t.kind === 'table' && t.tableName === 'prod_order')?.id).toBe('a');
  });

  it('查询标签没有表身份', () => {
    expect(objectIdentityOf(queryTab('q', 'c1', 'db'))).toBeNull();
    expect(findTabByIdentity([queryTab('q', 'c1', 'db')], `${TAB_IDENTITY_PREFIX}c1/db/x`)).toBeNull();
  });
});

describe('在树定位的树节点 key', () => {
  it('表标签 → obj:<connId>:<db>:<table>', () => {
    expect(treeKeyOfTab(tableTab('a', 'c1', 'db', 'ta'))).toBe('obj:c1:db:ta');
  });

  it('查询标签：绑定了库 → db 节点；未绑定连接 → null（菜单项据此禁用）', () => {
    expect(treeKeyOfTab(queryTab('q', 'c1', 'db'))).toBe('db:c1:db');
    expect(treeKeyOfTab(queryTab('q', 'c1', null))).toBe('conn:c1');
    expect(treeKeyOfTab(queryTab('q', null, null))).toBeNull();
  });
});

describe('菜单项可用性（禁用必须带中文原因）', () => {
  const tabs = [
    tableTab('a', 'c1', 'db', 'ta'),
    tableTab('b', 'c1', 'db', 'tb'),
    tableTab('c', 'c1', 'db', 'tc'),
  ];
  const itemsFor = (tabId: string, over: Partial<Parameters<typeof buildTabMenuItems>[0]> = {}) =>
    buildTabMenuItems({
      tabs,
      tab: tabs.find((t) => t.id === tabId)!,
      activeId: tabId,
      canRevealInTree: true,
      ...over,
    });
  const item = (list: ReturnType<typeof buildTabMenuItems>, key: string) =>
    list.find((i) => i.key === key)!;

  it('没有右侧标签 → 「关闭右侧」禁用且说明原因', () => {
    const last = itemsFor('c');
    expect(item(last, 'closeRight').disabled).toBe(true);
    expect(item(last, 'closeRight').disabledReason).toContain('没有右侧标签');
    // 对照：同一条 tabs 里中间标签的「关闭右侧」可用
    expect(item(itemsFor('a'), 'closeRight').disabled).toBe(false);
  });

  it('只剩自己 → 「关闭其他」禁用且说明原因', () => {
    const only = [tableTab('a', 'c1', 'db', 'ta')];
    const list = buildTabMenuItems({ tabs: only, tab: only[0], activeId: 'a', canRevealInTree: true });
    expect(item(list, 'closeOthers').disabled).toBe(true);
    expect(item(list, 'closeOthers').disabledReason).toContain('没有其他标签');
  });

  it('其余标签都不可关闭 → 「关闭其他」禁用并说明是「不可关闭」而不是「没有」', () => {
    const pinned = [tableTab('a', 'c1', 'db', 'ta'), tableTab('p', 'c1', 'db', 'tp')];
    const list = buildTabMenuItems({
      tabs: pinned,
      tab: pinned[0],
      activeId: 'a',
      canRevealInTree: true,
      isClosable: (t) => t.id !== 'p',
    });
    expect(item(list, 'closeOthers').disabled).toBe(true);
    expect(item(list, 'closeOthers').disabledReason).toContain('不可关闭');
  });

  it('宿主未接「在树中定位」→ 该项禁用并说明原因（不做点了没反应的假菜单）', () => {
    const list = itemsFor('a', { canRevealInTree: false });
    expect(item(list, 'revealInTree').disabled).toBe(true);
    expect(item(list, 'revealInTree').disabledReason).toBeTruthy();
    // 对照：接了就可用
    expect(item(itemsFor('a'), 'revealInTree').disabled).toBe(false);
  });

  it('查询标签不能复制表身份；表标签可以', () => {
    const q = queryTab('q', 'c1', 'db');
    const qList = buildTabMenuItems({ tabs: [q], tab: q, activeId: 'q', canRevealInTree: true });
    expect(item(qList, 'copyIdentity').disabled).toBe(true);
    expect(item(qList, 'copyIdentity').disabledReason).toContain('查询标签');
    expect(item(itemsFor('a'), 'copyIdentity').disabled).toBe(false);
  });

  it('「关闭」永远可用；⌘W 只标在当前激活标签上', () => {
    expect(item(itemsFor('a'), 'close').disabled).toBe(false);
    expect(item(itemsFor('a'), 'close').shortcut).toBe('⌘W');
    expect(item(itemsFor('b', { activeId: 'a' }), 'close').shortcut).toBeUndefined();
  });
});
