import { describe, expect, it } from 'vitest';
import { EditHistory, HISTORY_LIMIT, clearsFor, statesFor, type EditEntry } from './editHistory';

function entry(label: string, row: number, col: number, before: string | null): EditEntry {
  return {
    label,
    changes: [
      {
        row,
        col,
        before: before === null ? null : { row, col, value: before, valueKind: 'literal' },
        after: { row, col, value: 'new', valueKind: 'literal' },
      },
    ],
  };
}

describe('T38 EditHistory', () => {
  it('空栈不能撤销/重做', () => {
    const h = new EditHistory();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it('push 后可撤销；撤销后可重做（顺序是后进先出）', () => {
    const h = new EditHistory();
    h.push(entry('第一次', 0, 0, 'a'));
    h.push(entry('第二次', 1, 0, 'b'));
    expect(h.undoLabel).toBe('第二次');
    expect(h.undo()?.label).toBe('第二次');
    expect(h.undo()?.label).toBe('第一次');
    expect(h.undo()).toBeNull();
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.label).toBe('第一次');
  });

  it('新动作让 redo 失效 —— 否则历史会分叉', () => {
    const h = new EditHistory();
    h.push(entry('A', 0, 0, 'a'));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.push(entry('B', 2, 0, 'c'));
    expect(h.canRedo).toBe(false);
  });

  it('空改动不入栈（点一下没改值不该占一格历史）', () => {
    const h = new EditHistory();
    h.push({ label: '空', changes: [] });
    expect(h.canUndo).toBe(false);
  });

  it('超过上限丢最老的，保留最新的', () => {
    const h = new EditHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.push(entry(`E${i}`, i, 0, 'x'));
    expect(h.depth.undo).toBe(HISTORY_LIMIT);
    // 最新的一定还在：连撤 HISTORY_LIMIT 次的最后一条应是 E0+5
    let last = '';
    for (let i = 0; i < HISTORY_LIMIT; i++) last = h.undo()?.label ?? '';
    expect(last).toBe('E5');
  });

  it('clear 清空两栈（保存成功后边界）', () => {
    const h = new EditHistory();
    h.push(entry('A', 0, 0, 'a'));
    h.undo();
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.depth).toEqual({ undo: 0, redo: 0 });
  });
});

describe('T38 回放方向', () => {
  const e: EditEntry = {
    label: '混合',
    changes: [
      // 原本干净 → 改成 new（撤销时必须清干净）
      { row: 0, col: 0, before: null, after: { row: 0, col: 0, value: 'new', valueKind: 'literal' } },
      // 原本有旧草稿 → 改成 new（撤销时恢复旧草稿）
      {
        row: 1,
        col: 0,
        before: { row: 1, col: 0, value: 'old', valueKind: 'literal' },
        after: { row: 1, col: 0, value: 'new', valueKind: 'literal' },
      },
    ],
  };

  it('撤销取 before、重做取 after（写反了方向会反向但类型不报错，所以单独钉）', () => {
    expect(statesFor(e, 'undo').map((s) => s.value)).toEqual(['old']);
    expect(statesFor(e, 'redo').map((s) => s.value)).toEqual(['new', 'new']);
  });

  it('撤销时 before=null 的格子要清干净，而不是写成 NULL', () => {
    expect(clearsFor(e, 'undo')).toEqual([{ row: 0, col: 0 }]);
    // 重做时两格都有值 → 没有需要清的
    expect(clearsFor(e, 'redo')).toEqual([]);
  });

  it('表达式形态要原样带回来（不能把 NOW() 降级成字符串字面量）', () => {
    const expr: EditEntry = {
      label: 'expr',
      changes: [
        {
          row: 0,
          col: 0,
          before: { row: 0, col: 0, value: 'NOW()', valueKind: 'sql-expr' },
          after: null,
        },
      ],
    };
    expect(statesFor(expr, 'undo')[0].valueKind).toBe('sql-expr');
  });
});
