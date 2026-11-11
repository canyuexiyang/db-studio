import { describe, expect, it } from 'vitest';
import { QueryCancelGate } from './queryCancelGate';

describe('QueryCancelGate（#68 前置流程取消闸门）', () => {
  it('前置流程中请求取消 → 本地可中止（requestCancel 返回 true）', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('q1');
    expect(g.requestCancel('q1')).toBe(true); // 仍在 preflight → 本地拦
    expect(g.shouldAbort('q1')).toBe(true);
  });

  it('🔴 核心靶子：前置流程中被中止后，onRunSql 应在发给主进程前返回', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('q1');
    // 模拟 ensureConnection / import / 危险确认期间的某段 await 之后检查
    g.requestCancel('q1');
    expect(g.shouldAbort('q1')).toBe(true); // onRunSql 据此提前 return cancelled
  });

  it('对照：未请求取消时 shouldAbort 为 false（正常执行不被误拦）', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('q1');
    expect(g.shouldAbort('q1')).toBe(false);
  });

  it('🔴 执行期间取消：exitPreflight 后 requestCancel 返回 false（交给主进程 KILL）', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('q1');
    g.exitPreflight('q1'); // onRunSql 调 backend.queryRun 前注销
    // 此后取消不再被本地闸门截住 —— 必须交给主进程 cancelQuery/KILL
    expect(g.requestCancel('q1')).toBe(false);
    expect(g.shouldAbort('q1')).toBe(false);
  });

  it('未登记过的 queryId 请求取消 → false（不在前置流程）', () => {
    const g = new QueryCancelGate();
    expect(g.requestCancel('unknown')).toBe(false);
  });

  it('null/undefined queryId 一律安全（退回旧行为，不抛）', () => {
    const g = new QueryCancelGate();
    expect(() => g.enterPreflight(null)).not.toThrow();
    expect(g.requestCancel(null)).toBe(false);
    expect(g.shouldAbort(undefined)).toBe(false);
    expect(() => g.exitPreflight(null)).not.toThrow();
  });

  it('exitPreflight 幂等：重复注销、注销未登记的都不抛', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('q1');
    g.exitPreflight('q1');
    expect(() => g.exitPreflight('q1')).not.toThrow();
    expect(() => g.exitPreflight('never-registered')).not.toThrow();
  });

  it('不同 queryId 互相独立（多语句/多 tab 各自的 preflight 不串）', () => {
    const g = new QueryCancelGate();
    g.enterPreflight('a');
    g.enterPreflight('b');
    g.requestCancel('a');
    expect(g.shouldAbort('a')).toBe(true);
    expect(g.shouldAbort('b')).toBe(false); // b 没被取消
  });
});
