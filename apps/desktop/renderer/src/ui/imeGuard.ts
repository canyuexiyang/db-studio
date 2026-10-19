/**
 * T13 / §8.3「中文输入」：输入法组合期的按键判定。
 *
 * ## 为什么必须有这一个模块
 *
 * 用中文/日文输入法打字时，用户按 Enter 是**确认候选词**，不是「确认/提交」。
 * 但 Chromium 对组合期内的按键**照常派发 `keydown`** —— 区别只在两个字段：
 *
 *  - `event.isComposing === true`（标准）
 *  - `event.keyCode === 229`（旧 WebKit / 部分输入法的兼容信号）
 *
 * 于是「双击单元格 → 打拼音 → Enter」这条最日常的操作，会在候选还没落地时
 * 就 `commitEdit()`；在命令面板里则可能直接**执行选中命令**（比如「删除表」）。
 *
 * 🔴 全仓此前**零处**判断这两个字段（`grep isComposing` 无结果）。这不是"少写一行"，
 *    是"漏了一整类输入方式"，而它只在中文/日文/韩文用户手上才复现 —— 英文键盘的
 *    自动化测试永远绿。
 *
 * ## 用法
 *
 * 只判「要不要因组合期而**放行**（不处理）」，不改变任何按键语义：
 *
 * ```ts
 * if (isImeComposing(e)) return;        // 组合期的 Enter/Esc 一律交给输入法
 * ```
 *
 * 已由 CodeMirror 自己处理组合期的编辑器（`SqlEditorCore`）**也要判**：
 * CM6 的 `view.composing` 只在「已产生过一次输入」后为真，而 `keydown` 可能先到。
 */

/** 只取需要判定的字段，避免依赖完整 KeyboardEvent（便于单测构造） */
export interface ComposeAwareKeyEvent {
  /** 标准字段：组合中为 true */
  isComposing?: boolean;
  /** 兼容字段：组合期为 229 */
  keyCode?: number;
  /**
   * 🔴 React 合成事件的真实字段在这里。
   *
   * React 的 `SyntheticKeyboardEvent` **不转发 `isComposing`** —— 它的类型定义里
   * 只有 key/code/location/ctrlKey/shiftKey/altKey/metaKey/repeat/locale/charCode/
   * keyCode/which/getModifierState，读 `e.isComposing` 恒为 `undefined`。
   * 于是所有挂在 JSX `onKeyDown` 上的处理点（网格、树、各弹窗、命令面板）拿到
   * 的守卫结果都是 false —— **守卫写了等于没写**，而单元测试用普通对象构造
   * 永远发现不了（只有真机 + React 才暴露）。必须显式下沉到 `nativeEvent`。
   */
  nativeEvent?: ComposeAwareKeyEvent | null;
}

/**
 * 当前按键是否发生在输入法组合期（此时应把按键**留给输入法**）。
 *
 * 三个条件任一成立即为真：
 *  1. 表层 `isComposing`（原生事件 / CM6 / window 监听）
 *  2. 表层 `keyCode === 229`（组合期的历史约定值；部分输入法只给这个）
 *  3. `nativeEvent` 上的同两项（React 合成事件唯一能读到真实值的地方）
 */
export function isImeComposing(e: ComposeAwareKeyEvent | null | undefined): boolean {
  if (!e) return false;
  if (e.isComposing === true || e.keyCode === 229) return true;
  const n = e.nativeEvent;
  if (!n) return false;
  return n.isComposing === true || n.keyCode === 229;
}
