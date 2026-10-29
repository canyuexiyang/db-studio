import { describe, it, expect } from 'vitest';
import { inferToastTone, toastAutoDismissMs, toastClass } from './toastTone';

describe('inferToastTone', () => {
  it('成功类文案 → ok', () => {
    expect(inferToastTone('已提交：影响 3 行，12ms')).toBe('ok');
    expect(inferToastTone('已连接 本地测试：8.0.46（38ms）')).toBe('ok');
    expect(inferToastTone('已复制 users')).toBe('ok');
  });

  it('失败类文案 → error', () => {
    expect(inferToastTone('提交失败：Duplicate entry')).toBe('error');
    expect(inferToastTone('连接失败：ECONNREFUSED')).toBe('error');
    expect(inferToastTone('找不到 dbstudio 所属的连接')).toBe('error');
    expect(inferToastTone('该表无主键/唯一键，网格只读，不支持删除')).toBe('error');
  });

  it('「已跳过」是 warn 不是 ok（部分成功既不是成功也不该报红）', () => {
    expect(inferToastTone('已跳过 3 张只读连接上的表（写语句会被主进程 AST 守卫拦截）')).toBe('warn');
    expect(inferToastTone('已取消执行')).toBe('warn');
  });

  it('中性文案 → warn（不猜成功）', () => {
    expect(inferToastTone('主题：深色')).toBe('warn');
    expect(inferToastTone('')).toBe('warn');
  });
});

describe('toastAutoDismissMs', () => {
  it('只有 ok 自动消失；error 常驻（自动消失等于藏起证据）', () => {
    expect(toastAutoDismissMs('ok')).toBe(3500);
    expect(toastAutoDismissMs('warn')).toBeNull();
    expect(toastAutoDismissMs('error')).toBeNull();
  });
});

describe('toastClass', () => {
  it('三态各自一个类，且都保留既有 .banner 外壳（不然布局会塌）', () => {
    expect(toastClass('ok')).toContain('toast-ok');
    expect(toastClass('error')).toContain('toast-error');
    expect(toastClass('warn')).toContain('toast-warn');
    for (const t of ['ok', 'warn', 'error'] as const) {
      expect(toastClass(t)).toContain('banner');
      expect(toastClass(t)).toContain('shell-banner');
    }
  });
});
