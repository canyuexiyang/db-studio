/**
 * 0.8.0（P1-4 / #79）：单槽位「等待用户回答」模态的并发收口。
 *
 * ## 发现的真实缺陷（不是防御性重构）
 * `dirtyGuardResolveRef` 是**单个** ref，原注释假定「同一时刻最多一个守卫（重载是串行的）」。
 * 但有一条代码路径打破了该假设：
 *
 *   清空表（truncate）成功后会遍历**所有打开着同一张表**的标签页，
 *   逐个 `void loadTable(...)` 重载（见 App.tsx 的 onTableDestructive 收尾循环）。
 *   若其中两个标签页都有未提交改动，两次 loadTable 会先后进入脏改动守卫：
 *   第二次 `dirtyGuardResolveRef.current = resolve` **覆盖**了第一次的 resolver，
 *   于是第一个 `await` 永远不落定 —— 该标签页的这次重载**静默消失**（既不重载、
 *   也不报错、连 loading 都不亮），用户完全不知道发生了什么。Promise 还泄漏了。
 *
 * ## 修法（定点，不做全局 Map 重构）
 * 同一时刻只允许一个守卫占用；后来的请求**不排队**，直接拿兜底决定（cancel =
 * 不重载、不丢改动、保留用户已输入的脏值）。这样：
 *  - 不会再有 promise 泄漏 / 静默挂起；
 *  - 不会因为两个弹窗抢同一块 UI 而让用户困惑；
 *  - 语义对用户安全（跳过重载 ≠ 丢数据）。
 *
 * ## 为什么下沉成纯类
 * 这是「占用 / 释放 / 是否忙」的纯状态机，无 React 依赖；单测可钉住全部时序
 * （含「先来的被后来的顶掉」这一原始缺陷形态），而真实并发需要两个同表脏标签页 +
 * truncate，e2e 造起来代价高且不稳。
 */
export class SingleModalGate<Decision> {
  private current: ((d: Decision) => void) | null = null;

  /** 是否已有请求占着这个模态 */
  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * 尝试占用。成功返回 true（调用方负责之后 release 并 resolve）；
   * 已被占用返回 false —— 调用方应立即用兜底决定自行 resolve，**不要**覆盖。
   */
  tryAcquire(resolve: (d: Decision) => void): boolean {
    if (this.current !== null) return false;
    this.current = resolve;
    return true;
  }

  /** 释放并交还占用的 resolver（没有则 null）。幂等。 */
  release(): ((d: Decision) => void) | null {
    const r = this.current;
    this.current = null;
    return r;
  }
}