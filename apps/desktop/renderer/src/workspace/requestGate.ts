/**
 * 0.8.0（P1-2 / #46）：同一 key 的并发请求「只有最新的生效」闸门。
 *
 * ## 背景（竞态从哪来）
 * `loadTable` 是表的**唯一**数据拉取通道 —— 首开表 / 排序 / 筛选 / 右键快速筛选 /
 * 刷新 / 加载更多 / 外键跳转 / 会话恢复全部经它，每次都是
 * `await backend.queryOpenTable(...)` 然后 `ws.patchTable(tabId, …)`。
 *
 * 快速改筛选、连点刷新、或排序后立即筛选时，同一 `tabId` 会并发多次拉取。由于
 * 响应到达顺序不定，一个**慢的旧请求**可能后到，用「旧条件」的结果 patchTable
 * 覆盖掉已经写入的「新条件」结果 —— 用户看到的网格与当前筛选/排序不符，且没有任何
 * 报错（最隐蔽的一类缺陷）。
 *
 * ## 修法
 * 每次 `begin(key)` 分配一个单调递增序号；`await` 回来后 `isCurrent(key, seq)` 比对，
 * **只有仍是最新序号的响应才允许写入**；过期响应直接丢弃（不 patchTable、不动 loading
 * —— 最新的那次请求会负责收尾）。
 *
 * ## 为什么下沉成纯模块
 * 「旧慢新快」的竞态在 e2e 里难以稳定造出前置条件（项目红线：造不出前提的断言宁可
 * 不写）。把判定逻辑下沉成无 React/DOM 依赖的纯类，用单测钉住并发/过期/多 key 独立/
 * 幂等，比写一个 flaky 的时序 e2e 更可靠。
 */
export class RequestGate {
  private seqs = new Map<string, number>();

  /** 为 key 开启一次新请求，返回其序号（单调递增，从 1 开始） */
  begin(key: string): number {
    const next = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, next);
    return next;
  }

  /** seq 是否仍是 key 的最新序号（false = 已有更新的请求发起，本次应作废） */
  isCurrent(key: string, seq: number): boolean {
    return this.seqs.get(key) === seq;
  }

  /**
   * key 对应的 tab 关闭时清理，避免 Map 随历史 tab 累积。
   * （tab id 不复用，不清理也只是极小内存占用；提供 clear 供关闭路径调用。）
   */
  clear(key: string): void {
    this.seqs.delete(key);
  }
}
