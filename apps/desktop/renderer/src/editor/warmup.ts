/**
 * 编辑器 chunk 预热器（E3：懒加载 ≤300ms）
 *
 * 为什么单独一个文件、且**不 import 任何 CodeMirror 模块**：
 *
 *   预热的价值全在「提前把 chunk 解析完」。如果这个文件自己引了编辑器，
 *   那它一进首屏就等于把 CodeMirror 拖进首屏 —— 直接违反 E2 的
 *   「CodeMirror 首屏 0 字节」。所以它只能是一个**会发起动态 import 的
 *   极薄外壳**，本身几十字节。
 *
 * 预热 ≠ 预加载：这里只 `import()`，不建编辑器实例、不碰 DOM。
 * 换来的是用户点「查询」时只剩挂载成本（实测 35ms）。
 */

let warmed = false;

/**
 * 空闲时预热。
 *
 * 时机用 `requestIdleCallback`：首屏渲染期间抢带宽是最坏的选择，
 * 宁可晚一点也绝不能拖慢首屏。不支持的环境降级 setTimeout。
 */
export function warmupEditorChunk(): void {
  if (warmed) return;
  warmed = true;

  const run = (): void => {
    // 失败无所谓 —— 用户真用到时会再走一次正常路径
    void import('./SqlEditorCore')
      .then(() => {
        /**
         * 打标记给门禁断言用。
         *
         * 不能用 `performance.getEntriesByType('resource')` 判断预热是否完成 ——
         * Chromium 在 file:// 协议下**不记录**模块加载的 resource timing
         * （隐私限制），那样测永远是假阴性。这里自己记账才可靠。
         */
        (globalThis as Record<string, unknown>).__dbstudioEditorWarmed = true;
      })
      .catch(() => undefined);
  };

  /**
   * 🔴 不用 requestIdleCallback，直接 setTimeout(0)。
   *
   * 这是实测推翻的第二个直觉：先用了 `requestIdleCallback(timeout:0)`，
   * 结果门禁里 `预热=false` —— 点击时 chunk 根本还没被请求。
   * 原因是 idle 回调排在【连接列表 IPC + schema 反序列化 + 树渲染】之后，
   * 而这几件事在冷启动时会连续占满主线程好几秒（连接越多越久）。
   * 也就是说"空闲"在启动阶段是**迟迟不来的**。
   *
   * 改用 setTimeout(0)：下一个宏任务就跑。此时首屏 DOM 已经提交，
   * React 的首次渲染已经完成，抢不到用户的渲染时间；
   * 而 chunk 解析是一次独立的模块求值，不与后续交互争抢。
   *
   * 代价：启动后 ~300ms 内会多一次 377KB 的解析（不阻塞交互，且只此一次）。
   * 收益：用户点「查询」时从 323ms 降到 ~35ms。
   */
  setTimeout(run, 0);
}
