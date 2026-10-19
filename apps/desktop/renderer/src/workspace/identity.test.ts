import { describe, expect, it } from 'vitest';
import {
  NO_CONN_NAME,
  NO_DATABASE,
  NO_ENV_GROUP,
  NO_OBJECT,
  isCollapsed,
  resolveIdentity,
  saveButton,
  toolbarDensity,
  TOOLBAR_ALWAYS_VISIBLE,
  TOOLBAR_COMPACT_BELOW,
} from './identity';

const prod = { id: 'c1', name: 'prod_order', group: '生产环境', colorTag: 'red' };

function id(patch: Partial<Parameters<typeof resolveIdentity>[0]> = {}) {
  return resolveIdentity({
    connId: 'c1',
    database: 'order_db',
    object: 'order_main',
    kind: 'table',
    conn: prod,
    ...patch,
  });
}

describe('T46 resolveIdentity', () => {
  it('四段齐全时按「连接 / 环境 / 库 / 对象」顺序拼接', () => {
    const r = id();
    expect(r.connName).toBe('prod_order');
    expect(r.envLabel).toBe('生产环境');
    expect(r.envTone).toBe('prod');
    expect(r.database).toBe('order_db');
    expect(r.object).toBe('order_main');
    expect(r.plain).toBe('prod_order / 生产环境 / order_db / order_main');
  });

  it('红标签 = 生产，不论分组叫什么', () => {
    const r = id({ conn: { id: 'c3', name: 'staging', group: '测试环境', colorTag: 'red' } });
    expect(r.envTone).toBe('prod');
  });

  it('有分组但不是红标签 → normal（不能把测试库说成生产）', () => {
    const r = id({ conn: { id: 'c2', name: 'local_dev', group: '开发环境', colorTag: 'blue' } });
    expect(r.envTone).toBe('normal');
    expect(r.envLabel).toBe('开发环境');
  });

  it('连分组都没有 → unknown，而不是冒充生产/普通', () => {
    const r = id({ conn: { id: 'c9', name: 'adhoc', group: null, colorTag: null } });
    expect(r.envTone).toBe('unknown');
    expect(r.envLabel).toBe(NO_ENV_GROUP);
  });

  it('连接信息缺失时写「未命名连接」，绝不拿 connId 顶替', () => {
    const r = id({ conn: null, connId: 'c-unresolved-42' });
    expect(r.connName).toBe(NO_CONN_NAME);
    expect(r.plain).not.toContain('c-unresolved-42');
  });

  it('库/对象为空时也要占位，不能静默省略导致只剩三段', () => {
    const r = id({ database: '  ', object: '' });
    expect(r.database).toBe(NO_DATABASE);
    expect(r.object).toBe(NO_OBJECT);
    expect(r.plain.split('/').length).toBe(4);
  });

  it('对象类型参与读法：视图说「视图」，查询说「查询」', () => {
    expect(id({ kind: 'view' }).ariaLabel).toContain('视图 order_main');
    expect(id({ kind: 'query', object: '查询 3' }).ariaLabel).toContain('查询 查询 3');
  });
});

describe('T46 saveButton', () => {
  it('不可写 → 禁用并给出原因', () => {
    const r = saveButton({ dirtyCount: 2, writable: false, readOnlyReason: '该连接已标记为只读' });
    expect(r.disabled).toBe(true);
    expect(r.title).toBe('该连接已标记为只读');
    // 脏计数仍要如实反映：禁用不等于「没有改动」
    expect(r.pending).toBe(true);
  });

  it('可写且无改动 → 可点但 title 写「没有待提交的改动」', () => {
    const r = saveButton({ dirtyCount: 0, writable: true });
    expect(r.disabled).toBe(false);
    expect(r.pending).toBe(false);
    expect(r.text).toBe('保存 ⌘S');
    expect(r.title).toContain('没有待提交');
  });

  it('有改动 → 按钮上直接显示数量（不是只改 title）', () => {
    const r = saveButton({ dirtyCount: 7, writable: true });
    expect(r.text).toBe('保存 7 项 ⌘S');
    expect(r.pending).toBe(true);
  });

  it('对照：0 项与 7 项的文案必须不同（否则「显示数量」形同虚设）', () => {
    const none = saveButton({ dirtyCount: 0, writable: true });
    const some = saveButton({ dirtyCount: 7, writable: true });
    expect(none.text).not.toBe(some.text);
  });
});

describe('T46 toolbarDensity', () => {
  it('宽屏 full，紧凑 compact', () => {
    expect(toolbarDensity(1440)).toBe('full');
    expect(toolbarDensity(TOOLBAR_COMPACT_BELOW - 1)).toBe('compact');
  });

  it('宽度未知（0）按 full 处理 —— 首次测量前不能先折叠，否则工具栏会闪一下', () => {
    expect(toolbarDensity(0)).toBe('full');
  });

  it('紧凑模式只折叠低频项，核心项永不折叠', () => {
    for (const core of TOOLBAR_ALWAYS_VISIBLE) {
      expect(isCollapsed('compact', core)).toBe(false);
    }
    expect(isCollapsed('compact', 'export')).toBe(true);
    expect(isCollapsed('compact', 'paste')).toBe(true);
    // 对照组：full 模式下同一项不折叠
    expect(isCollapsed('full', 'export')).toBe(false);
  });
});
