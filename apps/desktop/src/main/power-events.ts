/**
 * 0.8.0（P1-8 / #78）：系统电源事件 → 连接生命周期。
 *
 * 承诺出处：`docs/RELEASES.md:177`、`docs/product/REQ-0.7.1-修复迭代.md:357,377,536`
 * —— 合盖睡眠不释放连接，彻底处理需监听 powerMonitor，排进 0.8.0。
 *
 * ## 决策（为什么是"suspend 释放、resume 不主动重连"）
 *  - **suspend（休眠/合盖）**：主动释放所有活连接。不释放的两个后果 ——
 *    ① 每条连接白占服务端一个连接名额；② SSH 隧道在睡眠期间变成孤儿进程
 *    （AGENTS §四.7 红线）。
 *  - **resume（唤醒）**：**不**主动全量重连。唤醒瞬间若一次性重连所有连接，
 *    会造成连接风暴（且很多连接用户当下根本不会用）。改为靠既有的
 *    `ensureConnection`：用户下次操作某连接时按需温和重连。
 *  - **lock-screen / unlock-screen（锁屏/解锁）**：**不**释放。锁屏 ≠ 休眠，
 *    机器仍在运行，激进断连会让"解锁回来连接全没了"，体验很差。
 *
 * ## 为什么抽成模块 + 依赖注入
 *  Electron 的 `powerMonitor` 只能在 app ready 后访问、且无法在单测里真实触发。
 *  这里把「事件源」与「释放动作」都做成注入参数，决策逻辑（suspend→释放、
 *  resume→不重连、幂等、返回释放数）就能被单测钉住，不必起 Electron。
 */

/** 释放所有活连接的动作（生产环境传 SessionRegistry.releaseAllForSuspend） */
export type ReleaseAllFn = () => Promise<string[]>;

/** 最小事件源接口：只需能挂/摘 suspend 与 resume 监听 */
export interface PowerEventSource {
  on(event: 'suspend' | 'resume', listener: () => void): void;
  removeListener?(event: 'suspend' | 'resume', listener: () => void): void;
}

export interface PowerEventsOptions {
  source: PowerEventSource;
  releaseAll: ReleaseAllFn;
  /** 可选日志钩子（生产传 logger） */
  log?: {
    info?: (msg: string, extra?: unknown) => void;
    warn?: (msg: string, extra?: unknown) => void;
  };
}

export interface PowerEventsHandle {
  /** 手动卸载监听（退出清理用） */
  dispose(): void;
  /** 仅供测试：模拟一次 suspend（返回被释放的连接数） */
  triggerSuspend(): Promise<number>;
  /** 仅供测试：模拟一次 resume（不释放，返回 0） */
  triggerResume(): Promise<number>;
}

/**
 * 安装电源事件监听。返回句柄可 dispose，并暴露供测试直接触发的方法。
 *
 * 🔴 幂等：suspend 期间若已在释放中（releaseInFlight），重复的 suspend 事件不再
 *    叠加第二次释放 —— 系统在某些机型上会连发 suspend/resume。
 */
export function installPowerEvents(opts: PowerEventsOptions): PowerEventsHandle {
  const { source, releaseAll, log } = opts;
  let releaseInFlight = false;

  const onSuspend = async (): Promise<number> => {
    if (releaseInFlight) {
      log?.info?.('[power] suspend 重入，跳过（已有释放进行中）');
      return 0;
    }
    releaseInFlight = true;
    try {
      const released = await releaseAll();
      log?.info?.(`[power] 休眠：已释放 ${released.length} 个连接`, released);
      return released.length;
    } catch (e) {
      // 释放失败不该抛出到 Electron 事件循环（会变成 unhandledRejection）
      log?.warn?.('[power] 休眠释放连接失败（不阻断）', e);
      return 0;
    } finally {
      releaseInFlight = false;
    }
  };

  const onResume = (): void => {
    // 刻意不主动重连：唤醒后靠 ensureConnection 按需温和恢复，避免连接风暴。
    log?.info?.('[power] 唤醒：不主动重连，连接将在下次操作时按需恢复');
  };

  const suspendListener = (): void => void onSuspend();
  const resumeListener = (): void => onResume();
  source.on('suspend', suspendListener);
  source.on('resume', resumeListener);

  return {
    dispose() {
      source.removeListener?.('suspend', suspendListener);
      source.removeListener?.('resume', resumeListener);
    },
    triggerSuspend: () => onSuspend(),
    triggerResume: async () => {
      onResume();
      return 0;
    },
  };
}
