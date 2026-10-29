/**
 * 分组整理（P2-29）纯逻辑单测。
 *
 * 重点不在「改一个字符串」，而在两条会毁数据的边界：
 *  1. **按段匹配** —— `生产` 不能把 `生产环境` 下的连接也改掉；
 *  2. **子树跟随** —— 重命名父分组时，`父/子` 必须变成 `新父/子`，而不是被拍平成 `新父`。
 */

import { describe, it, expect } from 'vitest';
import {
  addEmptyGroup,
  childGroupPath,
  groupDisplayName,
  isInGroup,
  normalizeGroupPath,
  removeEmptyGroupSubtree,
  renameEmptyGroups,
  renameGroupPatch,
} from './connectionGroups';

describe('路径归一化', () => {
  it('去空白、去空段、合并斜杠', () => {
    expect(normalizeGroupPath(' 生产 / 订单 ')).toBe('生产/订单');
    expect(normalizeGroupPath('//a//b//')).toBe('a/b');
    expect(normalizeGroupPath('dev')).toBe('dev');
  });

  it('空串 / 只有斜杠 / 含冒号 → null（冒号是树 key 分段符）', () => {
    expect(normalizeGroupPath('')).toBeNull();
    expect(normalizeGroupPath('  /  ')).toBeNull();
    expect(normalizeGroupPath('a:b')).toBeNull();
  });

  it('超长段（> 64）拒绝', () => {
    expect(normalizeGroupPath('a'.repeat(65))).toBeNull();
    expect(normalizeGroupPath('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('显示名 / 子路径', () => {
    expect(groupDisplayName('生产/订单')).toBe('订单');
    expect(groupDisplayName('')).toBe('');
    expect(childGroupPath('生产', '订单')).toBe('生产/订单');
    expect(childGroupPath('', '订单')).toBe('订单');
    expect(childGroupPath('生产', '')).toBe('生产');
  });
});

describe('按段前缀匹配（不能把兄弟分组一起改掉）', () => {
  it('自身与后代命中，同前缀的兄弟不命中', () => {
    expect(isInGroup('生产', '生产')).toBe(true);
    expect(isInGroup('生产/订单', '生产')).toBe(true);
    // 🔴 反例：'生产环境' 不是 '生产' 的后代
    expect(isInGroup('生产环境', '生产')).toBe(false);
    expect(isInGroup('生产环境/订单', '生产')).toBe(false);
    expect(isInGroup(null, '生产')).toBe(false);
  });
});

describe('重命名分组：算出要改的连接', () => {
  const conns = [
    { id: 'a', group: '生产' },
    { id: 'b', group: '生产/订单' },
    { id: 'c', group: '生产环境' },
    { id: 'd', group: null },
  ];

  it('只改目标分组的连接，子树保留后半段', () => {
    expect(renameGroupPatch(conns, '生产', 'prod')).toEqual([
      { id: 'a', group: 'prod' },
      { id: 'b', group: 'prod/订单' },
    ]);
    // 对照：'生产环境' 与未分组不受影响
    const ids = renameGroupPatch(conns, '生产', 'prod').map((p) => p.id);
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
  });

  it('重命名成子路径（把分组下移一层）也成立', () => {
    expect(renameGroupPatch(conns, '生产', '环境/生产')).toEqual([
      { id: 'a', group: '环境/生产' },
      { id: 'b', group: '环境/生产/订单' },
    ]);
  });

  it('改成空串 = 移回未分组（group: null）', () => {
    expect(renameGroupPatch(conns, '生产', '')).toEqual([
      { id: 'a', group: null },
      { id: 'b', group: '订单' },
    ]);
  });

  it('未分组（from 为空）不是可重命名实体 → 空补丁', () => {
    expect(renameGroupPatch(conns, '', 'x')).toEqual([]);
  });

  it('没有变化的连接不进补丁（避免无意义的批量保存）', () => {
    expect(renameGroupPatch([{ id: 'a', group: 'dev' }], 'dev', 'dev')).toEqual([]);
  });
});

describe('空分组清单随重命名/删除同步', () => {
  it('重命名时空分组跟着走，并去重排序', () => {
    expect(renameEmptyGroups(['生产', '生产/空', '别的'], '生产', 'prod')).toEqual(['prod', 'prod/空', '别的']);
  });

  it('改成空串时，顶层空分组直接消失', () => {
    expect(renameEmptyGroups(['生产', '生产/空'], '生产', '')).toEqual(['空']);
  });

  it('新建去重；删除连同子分组', () => {
    expect(addEmptyGroup(['b'], 'a')).toEqual(['a', 'b']);
    expect(addEmptyGroup(['a'], 'a')).toEqual(['a']);
    expect(removeEmptyGroupSubtree(['a', 'a/b', 'ab', 'c'], 'a')).toEqual(['ab', 'c']);
  });
});
