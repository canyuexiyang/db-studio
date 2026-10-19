import { describe, it, expect } from 'vitest';
import {
  snapshotCellValue,
  pendingText,
  diffCellValues,
  copyTargetTitle,
  copyTargetLabel,
  pendingUnavailableReason,
  type PendingCellValue,
} from './cellValueSource';

/**
 * T31 判定口径的证伪测试：每个分支都对应一种「UI 会贴错文案」的实现错误。
 */

describe('snapshotCellValue · 形态判定（红线 6：NULL/空串/二进制）', () => {
  it('null 与 undefined 都判 null，展示 NULL', () => {
    expect(snapshotCellValue(null)).toEqual({ text: 'NULL', shape: 'null', byteLength: null });
    expect(snapshotCellValue(undefined)).toEqual({ text: 'NULL', shape: 'null', byteLength: null });
  });

  it('空串判 empty，与 null 严格区分', () => {
    expect(snapshotCellValue('')).toEqual({ text: '', shape: 'empty', byteLength: null });
    expect(snapshotCellValue('').shape).not.toBe(snapshotCellValue(null).shape);
  });

  it('Uint8Array 判 binary 且不生成垃圾展示文本（String(Uint8Array) 缺陷）', () => {
    const b = new Uint8Array([137, 80, 78, 71]);
    const s = snapshotCellValue(b);
    expect(s.shape).toBe('binary');
    expect(s.byteLength).toBe(4);
    // 🔴 如果实现退化为 String(value)，text 会是 "137,80,78,71" —— 这条能抓到
    expect(s.text).toBe('');
  });

  it('ArrayBuffer 判 binary 且 byteLength 用视图长度', () => {
    const s = snapshotCellValue(new ArrayBuffer(8));
    expect(s.shape).toBe('binary');
    expect(s.byteLength).toBe(8);
  });

  it('数字转展示文本（BIGINT 以字符串到达时是 text）', () => {
    expect(snapshotCellValue('9007199254740993').text).toBe('9007199254740993');
  });
});

describe('diffCellValues · 四分支', () => {
  it('宿主未提供（undefined）→ pendingProvided=false，note 如实说未知（不假装一致）', () => {
    const d = diffCellValues('旧值', undefined);
    expect(d.pendingProvided).toBe(false);
    expect(d.hasPending).toBe(false);
    expect(d.differs).toBe(false);
    expect(d.note).toContain('未提供');
  });

  it('dirty=false → 一致', () => {
    const d = diffCellValues('x', { dirty: false, value: 'x' });
    expect(d).toMatchObject({ pendingProvided: true, hasPending: false, differs: false });
    expect(d.note).toContain('没有未提交的修改');
  });

  it('dirty=true 且展示文本相同 → hasPending 但 differs=false（不吓唬人）', () => {
    const d = diffCellValues('abc', { dirty: true, value: 'abc' });
    expect(d.hasPending).toBe(true);
    expect(d.differs).toBe(false);
    expect(d.note).toContain('内容与库中原值一致');
  });

  it('dirty=true 且不同 → differs=true，note 指向「当前待提交值」', () => {
    const d = diffCellValues('abc', { dirty: true, value: 'xyz' });
    expect(d.differs).toBe(true);
    expect(d.note).toContain('当前待提交值');
  });

  it('🔴 原值空串 vs 待提交 null 是有差异（红线 6）', () => {
    const d = diffCellValues('', { dirty: true, value: null });
    expect(d.differs).toBe(true);
  });

  it('🔴 原值 null vs 待提交空串也是有差异（反向）', () => {
    const d = diffCellValues(null, { dirty: true, value: '' });
    expect(d.differs).toBe(true);
  });

  it('二进制原值：保守报有差异，note 报字节数不输出待提交值原文', () => {
    const d = diffCellValues(new Uint8Array([1, 2, 3]), { dirty: true, value: '文本' });
    expect(d.differs).toBe(true);
    expect(d.note).toContain('3 字节');
    expect(d.note).toContain('不做文本比对');
  });

  it('invalid 时 note 带校验失败原因', () => {
    const d = diffCellValues('a', { dirty: true, value: 'b', invalid: '日期格式不合法' });
    expect(d.note).toContain('日期格式不合法');
  });
});

describe('copyTargetTitle / copyTargetLabel / pendingUnavailableReason', () => {
  it('original 侧的 title 永远说明「不含未保存编辑」', () => {
    expect(copyTargetTitle('original', diffCellValues('a', { dirty: true, value: 'b' }))).toContain('库中原值');
  });

  it('pending 侧：未提供 / 无修改 / 有修改 三种 title 各自明确', () => {
    expect(copyTargetTitle('pending', diffCellValues('a', undefined))).toContain('未提供');
    expect(copyTargetTitle('pending', diffCellValues('a', { dirty: false, value: 'a' }))).toContain('相同');
    expect(copyTargetTitle('pending', diffCellValues('a', { dirty: true, value: 'b' }))).toContain('尚未保存入库');
  });

  it('label 短文案区分两侧', () => {
    expect(copyTargetLabel('original')).toBe('复制库中原值');
    expect(copyTargetLabel('pending')).toBe('复制当前待提交值');
  });

  it('pendingUnavailableReason：未提供 → 原因；无待提交 → 原因；有 → null', () => {
    expect(pendingUnavailableReason(diffCellValues('a', undefined))).toContain('未提供');
    expect(pendingUnavailableReason(diffCellValues('a', { dirty: false, value: 'a' }))).toContain('没有未提交的修改');
    expect(pendingUnavailableReason(diffCellValues('a', { dirty: true, value: 'b' }))).toBeNull();
  });
});

describe('pendingText', () => {
  it('null 显示 NULL，空串保持空串', () => {
    const p: PendingCellValue = { dirty: true, value: null };
    expect(pendingText(p)).toBe('NULL');
    expect(pendingText({ dirty: true, value: '' })).toBe('');
  });
});
