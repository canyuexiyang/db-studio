/**
 * 主进程日志 logger 测试（0.8.0 · P1-8）。
 *
 * 核心红线：**日志绝不能成为新的故障源** —— 未初始化、目录不可写、写盘失败，
 * 都必须不抛，退化为 console 或静默。用真临时目录验证「到底写没写进文件」。
 *
 * logger 是模块级单例（logFile/logDir），用 vi.resetModules + 动态 import
 * 拿干净实例，避免测试间状态串味。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

async function freshLogger() {
  vi.resetModules();
  return await import('./logger.js');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbstudio-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('主进程日志 logger', () => {
  it('未初始化时 error 不抛、退化为 console', async () => {
    const { logger } = await freshLogger();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logger.error('boom', new Error('x'))).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('initLogger 后 error 落盘到 logs/main.log，含消息与栈', async () => {
    const { logger, initLogger, logDirectory } = await freshLogger();
    initLogger(dir);
    expect(logDirectory()).toBe(join(dir, 'logs'));
    logger.error('something failed', new Error('stack here'));
    const file = join(dir, 'logs', 'main.log');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('something failed');
    expect(content).toContain('stack here');
    expect(content).toContain('error'); // level 也要落，便于 grep
  });

  it('🔴 日志目录建不出来（写盘失败）也不抛 —— 日志不能成为新故障源', async () => {
    const { logger, initLogger, logDirectory } = await freshLogger();
    // 把 logs 先占成一个**文件**，initLogger 里 mkdirSync 会失败 → logFile 退回 null
    writeFileSync(join(dir, 'logs'), 'not a dir', 'utf8');
    expect(() => initLogger(dir)).not.toThrow();
    expect(logDirectory()).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logger.error('still logged to console')).not.toThrow();
    spy.mockRestore();
  });

  it('info 也落盘（不只是 error）', async () => {
    const { logger, initLogger } = await freshLogger();
    initLogger(dir);
    logger.info('[dbstudio] 启动 v9.9.9');
    const content = readFileSync(join(dir, 'logs', 'main.log'), 'utf8');
    expect(content).toContain('启动 v9.9.9');
  });

  it('单文件超限滚动成 .1，新内容进新文件', async () => {
    const { logger, initLogger } = await freshLogger();
    initLogger(dir);
    const file = join(dir, 'logs', 'main.log');
    // 预写一个超过 1MB 上限的文件，触发下次 append 前滚动
    writeFileSync(file, 'x'.repeat(1_100_000), 'utf8');
    logger.error('after roll');
    expect(existsSync(`${file}.1`)).toBe(true);
    const now = readFileSync(file, 'utf8');
    expect(now.length).toBeLessThan(1_000_000);
    expect(now).toContain('after roll');
  });
});
