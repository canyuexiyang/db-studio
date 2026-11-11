/**
 * 0.8.0（P1-4 / #68）：SQL 执行「前置流程」期间的可中止闸门。
 *
 * ## 要解决的问题（时序）
 * 点「执行」到查询真正落到主进程之间，渲染层要走一段**前置流程**：
 *   ensureConnection（可能建 SSH 隧道，~1.5s）→ 动态 import 危险分级器 → 危险确认。
 * 这段时间里，SqlEditorPanel 已经 `setRunning(true)`、queryIdRef 也已生成，
 * 取消按钮可点；但主进程的 `running` 映射里**还没有**这个 queryId
 * （`runQuery` 尚未被调用）。此时点取消 → `cancelQuery` 找不到句柄 → 返回 false，
 * 查询照样会在前置流程走完后发出去。#39 已让这种情况**如实**提示「取消未生效」，
 * 但取消本身没生效。
 *
 * ## 为什么在渲染层修（而不是主进程）
 * 主进程只凭一个 queryId 字符串，**无法区分**「前置流程中、即将注册的合法 id」与
 * 「已结束/根本不存在的 id」——两者都不在 running 里。要在主进程区分，必须让渲染层
 * 在发起前就声明 queryId（= #79 的 per-query 生命周期，需要新 IPC 协议）。
 * 而前置流程的状态**本来就在渲染层**（onRunSql 是 App 的回调），所以在渲染层拦最自然：
 * 取消时若该 queryId 仍在前置流程，就本地标记中止，onRunSql 在每段 await 后检查、
 * 命中则**在发给主进程之前**返回 cancelled。零新 IPC、不动主进程与通道契约。
 *
 * ## 为什么下沉成纯类
 * 「登记 / 请求取消 / 是否中止 / 注销」是纯状态机，无 React/DOM 依赖，单测可钉住
 * 全部分支（含「取消发生在真正执行期间应交给主进程」的对照），比造 SSH 隧道的
 * flaky 时序 e2e 可靠。
 */
export class QueryCancelGate {
  /** 正处于前置流程（尚未发给主进程）的 queryId */
  private readonly inPreflight = new Set<string>();
  /** 前置流程期间已被请求取消的 queryId */
  private readonly aborted = new Set<string>();

  /** onRunSql 进入前置流程时登记（queryId 缺失则忽略，退回旧行为） */
  enterPreflight(queryId: string | null | undefined): void {
    if (queryId) this.inPreflight.add(queryId);
  }

  /**
   * 取消请求。若该 queryId 仍在前置流程 → 标记中止并返回 true（本地可中止，
   * 调用方据此如实提示「已发送取消」）；否则返回 false（查询已在主进程执行，
   * 交给 KILL QUERY）。
   */
  requestCancel(queryId: string | null | undefined): boolean {
    if (queryId && this.inPreflight.has(queryId)) {
      this.aborted.add(queryId);
      return true;
    }
    return false;
  }

  /** onRunSql 在每段 await 之后检查：该 queryId 是否已被请求中止 */
  shouldAbort(queryId: string | null | undefined): boolean {
    return !!queryId && this.aborted.has(queryId);
  }

  /**
   * 注销（幂等）。两个调用点：
   *  1. onRunSql 真正调用 backend.queryRun **之前** —— 之后取消要交给主进程 KILL，
   *     不能再被本地闸门截住（否则执行期间的取消会失效）；
   *  2. onRunSql 的 finally / 早退路径 —— 防止前置流程异常退出后残留登记。
   */
  exitPreflight(queryId: string | null | undefined): void {
    if (!queryId) return;
    this.inPreflight.delete(queryId);
    this.aborted.delete(queryId);
  }
}
