/**
 * T41：未保存保护状态机的单元测试。
 *
 * 🔴 每条「不会问 / 会问」都配反向对照 ——
 *    一个恒返回 `{ kind: 'proceed' }` 的实现能骗过一半断言，
 *    只有把「脏 → 必问」和「不脏 → 必不问」成对钉住才算真断言。
 */

import { describe, it, expect } from 'vitest';
import {
  NO_SQL_FILE,
  isFileDirty,
  unsavedDecision,
  resolveUnsaved,
  fileDisplayName,
  saveButtonLabel,
  fileBadgeText,
  type SqlFileState,
  type UnsavedAction,
} from './sqlFileDoc';

function stateOf(text: string, path: string | null = '/tmp/a.sql'): SqlFileState {
  return { path, savedText: text, encoding: 'utf-8', stamp: { mtimeMs: 1, size: text.length } };
}

const ACTIONS: UnsavedAction[] = ['open-another', 'reload-file', 'close-tab', 'quit-app'];

describe('T41 脏判定', () => {
  it('没打开文件（草稿）：永远不脏（对照：同文本下有文件也不脏）', () => {
    expect(isFileDirty(NO_SQL_FILE, 'SELECT 1')).toBe(false);
    expect(isFileDirty(stateOf('SELECT 1'), 'SELECT 1')).toBe(false);
  });

  it('打开文件后改了一个字：脏', () => {
    expect(isFileDirty(stateOf('SELECT 1'), 'SELECT 2')).toBe(true);
  });

  it('存盘后回到基线：不脏（对照：上面同文本改一字是脏）', () => {
    const s = stateOf('SELECT 2');
    expect(isFileDirty(s, 'SELECT 2')).toBe(false);
  });
});

describe('T41 未保存保护：不脏就直接放行', () => {
  it('四个动作在不脏时**都不问**（问了就是骚扰）', () => {
    const s = stateOf('SELECT 1');
    for (const a of ACTIONS) {
      expect(unsavedDecision(s, 'SELECT 1', a).kind, `${a} 不该弹确认`).toBe('proceed');
    }
  });

  it('草稿（无文件）即便改过也不拦 —— 没有可保存的文件目标', () => {
    for (const a of ACTIONS) {
      expect(unsavedDecision(NO_SQL_FILE, '随便写点什么', a).kind).toBe('proceed');
    }
  });
});

describe('T41 未保存保护：脏了四个分支都必问', () => {
  const s = stateOf('SELECT 1');

  it('打开另一个文件：问', () => {
    const d = unsavedDecision(s, 'SELECT 2', 'open-another');
    expect(d.kind).toBe('ask');
    // 证伪点：恒返回 proceed 的实现在这里就会红
    if (d.kind !== 'ask') throw new Error('unreachable');
    expect(d.prompt.title).toContain('a.sql');
    expect(d.prompt.detail).toContain('打开另一个文件');
  });

  it('从磁盘重新载入：问', () => {
    expect(unsavedDecision(s, 'SELECT 2', 'reload-file').kind).toBe('ask');
  });

  it('关闭标签：问', () => {
    expect(unsavedDecision(s, 'SELECT 2', 'close-tab').kind).toBe('ask');
  });

  it('退出应用：问（省掉这条就是静默丢改动）', () => {
    expect(unsavedDecision(s, 'SELECT 2', 'quit-app').kind).toBe('ask');
  });

  it('每个分支的文案都要说清是哪个动作丢改动（四条互不相同）', () => {
    const details = ACTIONS.map((a) => {
      const d = unsavedDecision(s, 'SELECT 2', a);
      return d.kind === 'ask' ? d.prompt.detail : '';
    });
    expect(new Set(details).size).toBe(ACTIONS.length);
  });
});

describe('T41 未保存保护：选择后的走向', () => {
  it('保存 → 不放弃动作，但必须先落盘', () => {
    expect(resolveUnsaved('save')).toEqual({ abort: false, saveFirst: true });
  });

  it('不保存 → 继续动作，不落盘（对照：save 的 saveFirst 是 true）', () => {
    expect(resolveUnsaved('discard')).toEqual({ abort: false, saveFirst: false });
  });

  it('取消 → 放弃动作（对照：discard 是 abort=false）', () => {
    expect(resolveUnsaved('cancel')).toEqual({ abort: true, saveFirst: false });
  });
});

describe('T41 文案', () => {
  it('文件名取 basename', () => {
    expect(fileDisplayName('/Users/me/q.sql')).toBe('q.sql');
    expect(fileDisplayName(null)).toBe('未命名');
  });

  it('保存按钮必须带「文件」二字（与「执行」一眼可分）', () => {
    expect(saveButtonLabel(stateOf('x'), false)).toContain('文件');
    expect(saveButtonLabel(stateOf('x'), true)).toContain('文件');
    expect(saveButtonLabel(NO_SQL_FILE, false)).toContain('文件');
  });

  it('脏时按钮带 * 标记，不脏时没有', () => {
    const s = stateOf('x');
    expect(saveButtonLabel(s, true).endsWith('*')).toBe(true);
    expect(saveButtonLabel(s, false).endsWith('*')).toBe(false);
  });

  it('徽标：草稿说清没关联文件，脏时说清未保存', () => {
    expect(fileBadgeText(NO_SQL_FILE, false)).toContain('草稿');
    expect(fileBadgeText(stateOf('x'), true)).toContain('未保存');
    expect(fileBadgeText(stateOf('x'), false)).not.toContain('未保存');
  });
});
