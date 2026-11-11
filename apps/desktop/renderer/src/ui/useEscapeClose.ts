/**
 * 模态 Esc 关闭退路（AGENTS.md §八：模态必须有 Esc + 遮罩 + 取消三条退路）。
 *
 * 与 database/DdlDialogs.tsx 里的局部实现同口径：监听挂在 window 的 keydown 上，
 * 焦点在弹窗内输入框时也能靠 Esc 退出，不必先点回遮罩。
 *
 * 使用约定：
 *  - `onClose` 必须传「遮罩点击 / 取消按钮」用的**同一个**处理函数，
 *    Esc 才能自动继承其中的未保存确认、任务取消、schema 刷新等守卫逻辑；
 *  - 运行中禁止关闭的阶段（导出 / 导入 / 脚本 running）用 `enabled=false` 关掉，
 *    与遮罩 `? undefined : onClose` 完全一致，Esc 不绕过守卫；
 *  - 只认 `Escape`，不调用 preventDefault / stopPropagation，其它按键不受影响；
 *  - 监听随组件挂载注册、卸载移除。这些模态在 App 里都是条件挂载，
 *    因此监听只在弹窗打开期间存在。
 */
import { useEffect } from 'react';

export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 守卫期不挂监听（与遮罩 `? undefined : onClose` 一致），但 cleanup 始终存在，
    // 保证卸载时一定 removeEventListener；单一返回路径也避免 effect 回调返回 void 的歧义。
    if (enabled) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);
}
