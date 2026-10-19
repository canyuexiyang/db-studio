/**
 * T28 / T29 纯逻辑单测：右键菜单模型 + 工具栏执行对象 / 目标连接环境。
 *
 * 为什么这些逻辑值得单测：它们是「禁用该不该禁」「文案说的是哪个执行对象」
 * 这两类判断的唯一落点。放进组件里就只能靠 e2e，而 e2e 造不出所有前置条件
 * （比如未连库、剪贴板不可用），那些分支就永远没人验证。
 *
 * 断言纪律：每条都断言「改坏实现就变红」的具体产物，不写恒真断言。
 */

import { describe, it, expect } from 'vitest';
import { defaultConnectionConfig, type ConnectionConfig } from '@dbstudio/core-connection';
import {
  buildSqlContextMenu,
  describeConnectionTarget,
  executionScopeLegend,
  executionTargetHint,
  runTargetLabel,
  targetOfSelection,
  type SqlMenuActionId,
  type SqlMenuContext,
} from './sqlEditorMenuModel';

// ---------- 造数据 ----------

const BASE_CTX: SqlMenuContext = {
  hasSelection: false,
  hasText: true,
  connected: true,
  running: false,
  clipboardAvailable: true,
};

function ctx(over: Partial<SqlMenuContext> = {}): SqlMenuContext {
  return { ...BASE_CTX, ...over };
}

function itemOf(items: ReturnType<typeof buildSqlContextMenu>, id: SqlMenuActionId) {
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error(`菜单里没有 ${id}`);
  return it;
}

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return { ...defaultConnectionConfig(), ...over };
}

const CONNS: ConnectionConfig[] = [
  conn({ id: 'c1', name: 'prod_order', group: '生产环境', colorTag: 'red' }),
  conn({ id: 'c2', name: 'local_dev', group: '开发环境', colorTag: 'blue' }),
  conn({ id: 'c3', name: 'staging', group: null, colorTag: 'red' }),
  conn({ id: 'c4', name: 'scratch', group: null, colorTag: null }),
];

// ===========================================================================
// T28 右键菜单
// ===========================================================================

describe('T28 buildSqlContextMenu 最小集与分组', () => {
  it('恰好覆盖任务清单的动作 + 已登记 sql-context 的「执行全部」，不多不少', () => {
    // 若有人塞进「SQL 优化」「生成测试数据」等推测动作，这里会变红
    const ids = buildSqlContextMenu(ctx()).map((i) => i.id);
    expect(ids).toEqual([
      'sql-run-all',
      'sql-run-selection',
      'sql-explain',
      'sql-format',
      'sql-comment',
      'sql-cut',
      'sql-copy',
      'sql-paste',
    ]);
  });

  it('按 执行 / 编辑 / 剪贴板 三段分组（面板据此插分隔线）', () => {
    const groups = buildSqlContextMenu(ctx()).map((i) => i.group);
    expect(groups).toEqual([
      'execution',
      'execution',
      'execution',
      'edit',
      'edit',
      'clipboard',
      'clipboard',
      'clipboard',
    ]);
  });
});

describe('T28 buildSqlContextMenu 可用性', () => {
  it('无选区：剪切/复制禁用并给出中文原因，粘贴不受影响', () => {
    const items = buildSqlContextMenu(ctx({ hasSelection: false }));
    expect(itemOf(items, 'sql-cut').enabled).toBe(false);
    expect(itemOf(items, 'sql-cut').disabledReason).toBe('没有选中文本');
    expect(itemOf(items, 'sql-copy').enabled).toBe(false);
    expect(itemOf(items, 'sql-paste').enabled).toBe(true);
  });

  it('有选区：剪切/复制转为可用，且不再带禁用原因', () => {
    const items = buildSqlContextMenu(ctx({ hasSelection: true }));
    expect(itemOf(items, 'sql-cut').enabled).toBe(true);
    expect(itemOf(items, 'sql-copy').enabled).toBe(true);
    expect(itemOf(items, 'sql-cut').disabledReason).toBeNull();
  });

  it('未连库：执行类禁用（原因「未选择连接」），但纯文本动作仍可用', () => {
    const items = buildSqlContextMenu(ctx({ connected: false }));
    for (const id of ['sql-run-all', 'sql-run-selection', 'sql-explain'] as const) {
      expect(itemOf(items, id).enabled, id).toBe(false);
      expect(itemOf(items, id).disabledReason, id).toBe('未选择连接');
    }
    // 格式化/注释改的是文档，不需要连接 —— 不能一起被连坐禁用
    expect(itemOf(items, 'sql-format').enabled).toBe(true);
    expect(itemOf(items, 'sql-comment').enabled).toBe(true);
  });

  it('空编辑器：执行类与格式化/注释都禁用，原因是「编辑器为空」', () => {
    const items = buildSqlContextMenu(ctx({ hasText: false }));
    for (const id of ['sql-run-all', 'sql-run-selection', 'sql-explain', 'sql-format', 'sql-comment'] as const) {
      expect(itemOf(items, id).enabled, id).toBe(false);
      expect(itemOf(items, id).disabledReason, id).toBe('编辑器为空');
    }
  });

  it('执行中：执行类禁用（原因「已有查询在执行」），文本动作不受影响', () => {
    // 带选区：证明 running 只拦执行类，不会连坐剪切/复制这类纯文本动作
    const items = buildSqlContextMenu(ctx({ running: true, hasSelection: true }));
    for (const id of ['sql-run-all', 'sql-run-selection', 'sql-explain'] as const) {
      expect(itemOf(items, id).disabledReason, id).toBe('已有查询在执行');
    }
    expect(itemOf(items, 'sql-format').enabled).toBe(true);
    expect(itemOf(items, 'sql-copy').enabled).toBe(true);
  });

  it('剪贴板不可用时粘贴禁用并给出原因（不是静默失败）', () => {
    const items = buildSqlContextMenu(ctx({ clipboardAvailable: false }));
    expect(itemOf(items, 'sql-paste').enabled).toBe(false);
    expect(itemOf(items, 'sql-paste').disabledReason).toBe('当前环境不支持读取剪贴板');
    // 剪贴板不可用不该连坐剪切/复制的**选区**判定（它们各自独立）
    expect(itemOf(items, 'sql-copy').enabled).toBe(false); // 此处无选区
  });

  it('🔴 红线不变量：禁用项必有原因，可用项必无原因（禁止「看着能点却没反应」）', () => {
    // 覆盖多种状态组合，任何一条破坏「disabled ⇒ 有原因」的实现都会红
    const combos: SqlMenuContext[] = [
      ctx(),
      ctx({ hasSelection: true }),
      ctx({ hasText: false }),
      ctx({ connected: false }),
      ctx({ running: true }),
      ctx({ clipboardAvailable: false }),
      ctx({ hasSelection: false, hasText: false, connected: false, running: true, clipboardAvailable: false }),
    ];
    for (const c of combos) {
      for (const it of buildSqlContextMenu(c)) {
        if (it.enabled) {
          expect(it.disabledReason, `${it.id} 可用却带原因`).toBeNull();
        } else {
          expect(typeof it.disabledReason, `${it.id} 禁用却没有原因`).toBe('string');
          expect((it.disabledReason ?? '').length, `${it.id} 原因为空串`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('「执行选中」项在无选区时文案切换为「当前语句」—— 这是三者可辨的一半', () => {
    const noSel = itemOf(buildSqlContextMenu(ctx({ hasSelection: false })), 'sql-run-selection');
    const sel = itemOf(buildSqlContextMenu(ctx({ hasSelection: true })), 'sql-run-selection');
    expect(noSel.label).toContain('当前语句');
    expect(sel.label).toBe('执行选中');
  });
});

// ===========================================================================
// T29 执行对象
// ===========================================================================

describe('T29 执行对象（全部 / 当前语句 / 选中）', () => {
  it('targetOfSelection：塌陷(0) 是语句，1 个字符就已是「选中」', () => {
    expect(targetOfSelection(0)).toBe('statement');
    expect(targetOfSelection(1)).toBe('selection');
    expect(targetOfSelection(120)).toBe('selection');
  });

  it('无选区：三者文案彼此可辨（全部 / 当前语句 / 选中 不重叠）', () => {
    const l = executionScopeLegend(0);
    expect(l.runAll).toBe('执行全部');
    expect(l.runSelection).toBe('执行当前语句');
    expect(l.active).toBe('statement');
    expect(l.hint).toBe('当前语句');
  });

  it('有选区：⌘⏎ 对象切换为「执行选中」，指示器带字符数', () => {
    const l = executionScopeLegend(7);
    expect(l.runAll).toBe('执行全部');
    expect(l.runSelection).toBe('执行选中');
    expect(l.active).toBe('selection');
    expect(l.hint).toBe('选中 7 字符');
  });

  it('runTargetLabel / executionTargetHint 与 legend 同口径（不各写一份）', () => {
    expect(runTargetLabel('all').label).toBe('执行全部');
    expect(runTargetLabel('statement').label).toBe('执行当前语句');
    expect(runTargetLabel('selection').label).toBe('执行选中');
    expect(executionTargetHint(0)).toBe('当前语句');
    expect(executionTargetHint(3)).toBe('选中 3 字符');
  });
});

// ===========================================================================
// T29 目标连接与环境
// ===========================================================================

describe('T29 describeConnectionTarget', () => {
  it('命中生产连接：给出连接名 + 分组环境 + production=true', () => {
    expect(describeConnectionTarget(CONNS, 'c1')).toEqual({
      name: 'prod_order',
      environment: '生产环境',
      production: true,
      known: true,
    });
  });

  it('命中开发连接：production=false（红标签之外都不算生产）', () => {
    const t = describeConnectionTarget(CONNS, 'c2');
    expect(t.name).toBe('local_dev');
    expect(t.environment).toBe('开发环境');
    expect(t.production).toBe(false);
  });

  it('没设分组但红标签 → 环境回退为「生产环境」（不与 isProduction 分叉）', () => {
    const t = describeConnectionTarget(CONNS, 'c3');
    expect(t.environment).toBe('生产环境');
    expect(t.production).toBe(true);
  });

  it('没分组也没标签 → 环境为空串（不硬编一个假的「默认环境」）', () => {
    const t = describeConnectionTarget(CONNS, 'c4');
    expect(t.environment).toBe('');
    expect(t.production).toBe(false);
    expect(t.name).toBe('scratch');
  });

  it('未选连接 → 明确的「未选择连接」，known=false', () => {
    const t = describeConnectionTarget(CONNS, null);
    expect(t.name).toBe('未选择连接');
    expect(t.known).toBe(false);
    expect(t.production).toBe(false);
  });

  it('连接列表里找不到（刚删 / 还没加载）→ 退化为 connId，known=false', () => {
    const t = describeConnectionTarget(CONNS, 'cx');
    expect(t.name).toBe('cx');
    expect(t.known).toBe(false);
    expect(t.production).toBe(false);
  });

  it('连接列表为空时不崩，且不谎报连接名', () => {
    const t = describeConnectionTarget([], 'c1');
    expect(t.name).toBe('c1');
    expect(t.known).toBe(false);
  });

  it('空字符串 connId 与 null 同解（不会去列表里找空 id）', () => {
    expect(describeConnectionTarget(CONNS, '').name).toBe('未选择连接');
  });
});
