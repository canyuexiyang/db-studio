import { describe, it, expect } from 'vitest';
import { IPC, ok, err, EVENT_BEFORE_CLOSE_ASK, type IpcResult } from './ipc-channels.js';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const cjs = require_('./ipc-channels.cjs');
const IPC_CJS = cjs.IPC;

describe('IPC 通道定义', () => {
  /** 这条最重要：两份通道表必须完全一致，否则 preload 与主进程对不上 */
  it('ESM 与 CJS 两份通道表完全一致（防止改漏一处）', () => {
    expect(Object.keys(IPC).sort()).toEqual(Object.keys(IPC_CJS).sort());
    for (const k of Object.keys(IPC)) {
      expect(IPC[k as keyof typeof IPC]).toBe(IPC_CJS[k]);
    }
  });

  /**
   * 单向推送通道也要两份同值 —— 它们不在 IPC map 里（见 EVENT_BEFORE_CLOSE_ASK
   * 的注释），所以上面那条"map 全等"的断言覆盖不到，必须单独守。
   */
  it('单向推送通道两份同值（EVENT_BEFORE_CLOSE_ASK）', () => {
    expect(EVENT_BEFORE_CLOSE_ASK).toBe('app:beforeCloseAsk');
    expect(cjs.EVENT_BEFORE_CLOSE_ASK).toBe(EVENT_BEFORE_CLOSE_ASK);
  });

  /**
   * 🔴 通道名全局唯一要**跨两张表**看。
   * 只比 IPC map 内部会漏掉「IPC 里的 key 与推送常量撞名」——
   * 撞名的后果是 invoke 与订阅走同一条线，静默串台。
   */
  it('通道名全局唯一（含单向推送常量，不同语义不能撞同一个通道串）', () => {
    const values = [...Object.values(IPC), EVENT_BEFORE_CLOSE_ASK];
    expect(new Set(values).size).toBe(values.length);
  });

  it('通道名都带命名空间前缀（形如 "domain:action"）', () => {
    for (const [k, v] of Object.entries(IPC)) {
      expect(v, `${k} 的通道名 "${v}" 缺少命名空间`).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    }
    expect(EVENT_BEFORE_CLOSE_ASK).toMatch(/^[a-z]+:[a-zA-Z]+$/);
  });

  it('关键通道存在（改名会让调用方静默失败）', () => {
    expect(IPC.QUERY_RUN).toBe('query:run');
    expect(IPC.EXPORT_CANCEL).toBe('export:cancel');
    expect(IPC.APP_GET_MODE).toBe('app:getMode');
    expect(IPC.SCHEMA_SEARCH_COLUMN).toBe('schema:searchColumn');
  });
});

describe('IpcResult 包装', () => {
  it('ok() 构造成功响应', () => {
    const r: IpcResult<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(42);
  });

  it('err() 构造失败响应', () => {
    const r: IpcResult<number> = err('NOT_FOUND', '没找到');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NOT_FOUND');
      expect(r.error.message).toBe('没找到');
    }
  });

  it('判别联合让 TS 能收窄类型', () => {
    const r: IpcResult<string> = ok('x');
    // 编译期就保证：ok 为 true 时只能访问 data
    expect(r.ok ? r.data : r.error.message).toBe('x');
  });
});
