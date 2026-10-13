import { describe, it, expect } from 'vitest';
import {
  isValidSnippetName,
  snippetNameTooLongMessage,
  SNIPPET_NAME_MAX,
} from './snippet-name.js';

describe('片段命名规则', () => {
  it('常规用途描述合法', () => {
    expect(isValidSnippetName('按状态统计订单')).toBe(true);
    expect(isValidSnippetName('慢查询排查')).toBe(true);
  });

  it('空/纯空白非法', () => {
    expect(isValidSnippetName('')).toBe(false);
    expect(isValidSnippetName('   ')).toBe(false);
    expect(isValidSnippetName('\t')).toBe(false);
  });

  it('恰好 25 字合法，26 字非法（边界）', () => {
    expect(isValidSnippetName('a'.repeat(SNIPPET_NAME_MAX))).toBe(true);
    expect(isValidSnippetName('a'.repeat(SNIPPET_NAME_MAX + 1))).toBe(false);
  });

  it('25 个汉字合法', () => {
    expect(isValidSnippetName('一'.repeat(SNIPPET_NAME_MAX))).toBe(true);
    expect(isValidSnippetName('一'.repeat(SNIPPET_NAME_MAX + 1))).toBe(false);
  });

  /**
   * 🔴 这条是"按码点计数"的全部理由：
   * 25 个 emoji 的 length 是 50（代理对），按 length 判会误拒。
   */
  it('25 个 emoji 合法（按码点算，用 length 会误判成 50）', () => {
    const emoji = '😀'.repeat(SNIPPET_NAME_MAX);
    expect(emoji.length).toBe(SNIPPET_NAME_MAX * 2); // 前提：length 确实翻倍
    expect(isValidSnippetName(emoji)).toBe(true);
  });

  it('🔴 错误输入：26 个 emoji 必须被拒（否则上限形同虚设）', () => {
    expect(isValidSnippetName('😀'.repeat(SNIPPET_NAME_MAX + 1))).toBe(false);
  });

  it('含换行/制表符非法（会撑坏弹窗的单行展示）', () => {
    expect(isValidSnippetName('对账\n明细')).toBe(false);
    expect(isValidSnippetName('对账\t明细')).toBe(false);
  });

  it('首尾空白不算字数（trim 后判定）', () => {
    expect(isValidSnippetName('  对账  ')).toBe(true);
    // 前后空格 + 25 字 = trim 后仍 25 字
    expect(isValidSnippetName(`  ${'a'.repeat(SNIPPET_NAME_MAX)}  `)).toBe(true);
  });

  it('超长提示给出实际字数（用户不用自己数）', () => {
    expect(snippetNameTooLongMessage('a'.repeat(30))).toContain('30');
    expect(snippetNameTooLongMessage('a'.repeat(30))).toContain(String(SNIPPET_NAME_MAX));
    // emoji 也按码点数，不能报成 60
    expect(snippetNameTooLongMessage('😀'.repeat(30))).toContain('30');
  });
});
