/**
 * 主进程 SSH 隧道管理器 —— 把 core-ssh-tunnel 接到连接配置上
 *
 * 职责边界（刻意这么切）：
 *  - `core-ssh-tunnel` 只认"已经拿到的密钥文本"，不碰文件系统、不碰钥匙串
 *  - 本文件负责【读私钥文件】与【解密 passphrase】，然后把结果喂给隧道
 *  - `session-registry` 只拿到一个 `TunnelManager` 接口，不认识 ssh2
 *
 * 这样切的原因：私钥读取与凭据解密是**有副作用且会失败**的动作，
 * 必须与"纯协议逻辑"分开，否则隧道包就没法用替身跑单测。
 *
 * 红线：
 *  1. **私钥只存路径，不存内容**（PRD §6.1.2）。路径进 connections.json 无害，
 *     私钥内容进磁盘才是事故。
 *  2. 明文密码/passphrase 只在一次调用的栈里存在，绝不写日志。
 *  3. 私钥权限过宽要**警告**（core-connection 已判定），这里不静默使用 ——
 *     SSH 服务端本来也会拒绝过宽权限的私钥，提前说比事后报认证失败好。
 */

import { readFileSync, statSync } from 'node:fs';
import {
  SshTunnel,
  TunnelError,
  DEFAULT_TUNNEL_TIMEOUT_MS,
  type SshTunnelConfig,
} from '@dbstudio/core-ssh-tunnel';
import type { ConnectionConfig } from '@dbstudio/core-connection';
import type { TunnelHandle } from '@dbstudio/core-driver-mysql';
import type { TunnelManager } from './session-registry.js';

/** 读私钥文件失败时的具体原因（UI 要能区分"不存在"和"没权限"） */
export class SshKeyReadError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SshKeyReadError';
  }
}

/** 依赖注入 —— 读文件与解密都可替身，单测不必碰真实磁盘/钥匙串 */
export interface TunnelManagerDeps {
  /** 读私钥文件内容。默认走 fs.readFileSync */
  readKeyFile?: (path: string) => string;
  /** 取 SSH 明文凭据（密码 / passphrase） */
  credentials: (cfg: ConnectionConfig) => Promise<{ password: string | null; passphrase: string | null }>;
  /** 隧道建立超时（ms）。默认 10s（PRD §6.1.2） */
  timeoutMs?: number;
  /**
   * ssh2 模块加载器。默认懒加载真 ssh2。
   *
   * ⚠️ 这个注入点不是"为了测试方便"——它是**唯一能验证我们没传错参数**
   * 的地方。替身若照着被测代码的假设实现，只会跟代码一起错；
   * 所以真机验证（scripts/e2e-ssh.mjs）必须并行存在。
   */
  loadSshModule?: () => Promise<import('@dbstudio/core-ssh-tunnel').SshModuleLike>;
}

function defaultReadKeyFile(path: string): string {
  let mode: number | null = null;
  try {
    mode = statSync(path).mode;
  } catch {
    // 拿不到 mode 也要继续尝试读 —— 有些虚拟文件系统不报 mode
  }
  // 🔴 权限过宽直接拒绝，不静默使用。
  //    SSH 服务端本来也会拒绝，与其让用户对着"认证失败"猜，
  //    不如在这里把原因和修复命令说清楚（PRD §6.1.2）。
  if (mode != null && mode & 0o077) {
    throw new SshKeyReadError(
      `私钥文件权限过宽（${(mode & 0o777).toString(8)}），请执行：chmod 600 ${path}`,
      path,
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * 把连接配置翻译成隧道配置。
 *
 * 🔴 私钥认证时必须读到非空内容。读到空串会让 ssh2 报一个
 *    "Cannot parse privateKey" 的错，而真正原因是文件是空的 ——
 *    这种错位提示浪费过我一次排查时间，所以这里提前拦住。
 */
export async function buildTunnelConfig(
  cfg: ConnectionConfig,
  deps: Pick<TunnelManagerDeps, 'readKeyFile' | 'credentials' | 'timeoutMs'>,
): Promise<SshTunnelConfig> {
  const ssh = cfg.ssh;
  const read = deps.readKeyFile ?? defaultReadKeyFile;
  const { password, passphrase } = await deps.credentials(cfg);

  let privateKey: string | null = null;
  if (ssh.authType === 'privateKey') {
    if (!ssh.privateKeyPath) {
      throw new SshKeyReadError('私钥认证必须选择私钥文件', '');
    }
    privateKey = read(ssh.privateKeyPath);
    if (!privateKey || privateKey.trim() === '') {
      throw new SshKeyReadError(`私钥文件为空：${ssh.privateKeyPath}`, ssh.privateKeyPath);
    }
  }

  return {
    host: ssh.host,
    port: ssh.port,
    user: ssh.user,
    authType: ssh.authType,
    // 🔴 认证方式是互斥的：私钥认证时不带 password，反之亦然。
    //    两种凭据一起发给服务端，会让 ssh2 依次尝试 —— 表现为
    //    "明明配了私钥却因为密码错误被拒"，排查方向完全跑偏。
    password: ssh.authType === 'password' ? password : null,
    privateKey: ssh.authType === 'privateKey' ? privateKey : null,
    passphrase: ssh.authType === 'privateKey' ? passphrase : null,
    connectTimeoutMs: deps.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
  };
}

/**
 * 主进程隧道管理器。
 *
 * 每条连接一条 SshTunnel；tunnel 挂到驱动上，由 driver.close() 释放，
 * registry 还有一层兜底（建连失败时它自己关）。
 */
export class SshTunnelManager implements TunnelManager {
  constructor(private readonly deps: TunnelManagerDeps) {}

  async open(
    cfg: ConnectionConfig,
    target: { host: string; port: number },
  ): Promise<{ tunnel: TunnelHandle; streamFactory: () => Promise<unknown> } | null> {
    return this.openWithModule(cfg, target, this.deps.loadSshModule);
  }

  /** 显式传入 ssh2 模块加载器（测试替身走这里） */
  async openWithModule(
    cfg: ConnectionConfig,
    target: { host: string; port: number },
    loadModule: (() => Promise<import('@dbstudio/core-ssh-tunnel').SshModuleLike>) | undefined,
  ): Promise<{ tunnel: TunnelHandle; streamFactory: () => Promise<unknown> } | null> {
    if (!cfg.ssh?.enabled) return null;

    const tunnelCfg = await buildTunnelConfig(cfg, this.deps);
    const tunnel = new SshTunnel(tunnelCfg, { loadModule });

    // 建隧道失败要自己收尾：此刻还没有驱动接管它
    try {
      await tunnel.connect();
    } catch (e) {
      await tunnel.close().catch(() => undefined);
      throw e instanceof TunnelError
        ? e
        : new TunnelError(String((e as any)?.message ?? e), 'SSH_FAILED', e);
    }

    return {
      tunnel,
      // 每次调用开一条新 channel —— 主连接与 KILL QUERY 管理连接各要一条
      streamFactory: async () => (await tunnel.openChannel(target)).stream,
    };
  }
}

/** SSH 隧道是否已启用（UI 与诊断用） */
export function tunnelEnabled(cfg: ConnectionConfig): boolean {
  return cfg.ssh?.enabled === true;
}
