/**
 * Toast 分级（P1-11）。
 *
 * 现场：成功消息（「已提交：影响 3 行」）和错误消息共用同一块橙色警示底、
 * 常驻不消失，下一条来了才被顶掉。用户看不出「刚才那下成了还是炸了」。
 *
 * 这里把「这句话该用什么语气」做成纯函数，由文案推断 —— 调用点有上百处，
 * 逐个补 tone 参数必然漏；推断规则可单测、可回溯。需要精确语义的调用点
 * 仍可显式传 tone 覆盖。
 */

export type ToastTone = 'ok' | 'warn' | 'error';

/** 命中即判 error（顺序敏感：「已跳过…被拦截」要先被 warn 规则截走） */
const ERROR_HINTS = [
  '失败',
  '错误',
  '出错',
  '异常',
  '无法',
  '不允许',
  '不支持',
  '不能',
  '不可',
  '找不到',
  '未找到',
  '拒绝',
  '超时',
  '不合法',
  '没有可',
  '不一致',
  '不存在',
];

/** 命中即判 warn —— 部分成功 / 被跳过 / 需要留意，但不是错误 */
const WARN_HINTS = ['跳过', '部分', '仍有', '注意', '建议', '已取消'];

export function inferToastTone(text: string): ToastTone {
  const t = (text ?? '').trim();
  if (!t) return 'warn';
  if (WARN_HINTS.some((k) => t.includes(k))) return 'warn';
  if (ERROR_HINTS.some((k) => t.includes(k))) return 'error';
  if (t.startsWith('已') || t.startsWith('成功') || t.includes('完成')) return 'ok';
  return 'warn';
}

/**
 * 自动消失时长（ms）。`null` = 常驻待手动关闭。
 *
 * 只让**成功**类自动消失：错误信息是排查现场的唯一线索，自动消失等于把证据藏起来。
 */
export function toastAutoDismissMs(tone: ToastTone): number | null {
  return tone === 'ok' ? 3500 : null;
}

/** 语气 → 样式类名（样式在 styles.css 的 .banner 段） */
export function toastClass(tone: ToastTone): string {
  return tone === 'ok' ? 'banner shell-banner toast-ok' : tone === 'error' ? 'banner shell-banner toast-error' : 'banner shell-banner toast-warn';
}
