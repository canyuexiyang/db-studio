/**
 * 主进程结构化错误日志（0.8.0 · P1-8）。
 *
 * 🔴 为什么要它：此前所有 IPC 错误只在 `DB_STUDIO_E2E === '1'` 时 `console.error`，
 *    打包后的生产环境**零日志** —— 用户报「连不上 / 保存失败」时我们手里只有渲染层
 *    收敛后的 message，没有主进程栈，无从排查。这里把错误落到 `userData/logs/`。
 *
 * 设计约束：
 *  - **绝不因写日志失败而拖垮主流程**：所有 IO 都 try/catch 吞掉，日志是辅助不是关键路径。
 *  - 用模块级单例：`wrap` 是模块级函数，无法通过依赖注入拿 logger；`initLogger` 在
 *    main.ts 里 app ready 后调一次，未初始化时 error() 退化为 console（测试环境安全）。
 *  - 简单按大小滚动：单文件超过上限就滚动成 `.1`，只保留 1 份历史，够自查即可。
 *
 * 刻意不引第三方日志库（pino/winston）：自用工具，几行 fs 足够，不为首屏外的主进程
 * 再背一个依赖闭包（对齐 electron-updater 那次「16 个依赖闭包」的教训）。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 单个日志文件上限（约 1MB）。超过就滚动，避免无限增长。 */
const MAX_BYTES = 1_000_000;

let logFile: string | null = null;
let logDir: string | null = null;

/** 在 app ready、拿到 userData 目录后调用一次。之后 error() 才真正落盘。 */
export function initLogger(userDataDir: string): void {
  try {
    logDir = join(userDataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    logFile = join(logDir, 'main.log');
  } catch {
    // 连日志目录都建不出来：退回 console，不阻断启动
    logFile = null;
    logDir = null;
  }
}

/** 日志文件目录（UI 的「在访达中显示日志」用）。未初始化返回 null。 */
export function logDirectory(): string | null {
  return logDir;
}

/** 单文件超限就滚动成 .1（只留一份历史）。失败静默 —— 大不了这个文件继续长大。 */
function rollIfNeeded(): void {
  if (!logFile) return;
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      const rolled = `${logFile}.1`;
      if (existsSync(rolled)) renameSync(rolled, `${rolled}.old`);
      renameSync(logFile, rolled);
    }
  } catch {
    /* 滚动失败不影响继续追加 */
  }
}

function line(level: string, message: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  let tail = '';
  if (extra !== undefined) {
    if (extra instanceof Error) tail = `\n${extra.stack ?? extra.message}`;
    else if (typeof extra === 'string') tail = ` ${extra}`;
    else {
      try {
        tail = ` ${JSON.stringify(extra)}`;
      } catch {
        tail = ` ${String(extra)}`;
      }
    }
  }
  return `[${ts}] ${level} ${message}${tail}\n`;
}

/**
 * 记一条日志。未初始化（如纯单测环境）时退化为 console，绝不抛。
 * 生产环境同时写文件 + console（打包后 console 进不了终端，但保留无害）。
 */
export function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  const text = line(level, message, extra);
  if (level === 'error') console.error(text.trimEnd());
  else if (level === 'warn') console.warn(text.trimEnd());
  if (!logFile) return;
  try {
    rollIfNeeded();
    appendFileSync(logFile, text, 'utf8');
  } catch {
    // 写盘失败静默：日志本身不能成为新的故障源
  }
}

export const logger = {
  info: (m: string, e?: unknown) => log('info', m, e),
  warn: (m: string, e?: unknown) => log('warn', m, e),
  error: (m: string, e?: unknown) => log('error', m, e),
};
