# @dbstudio/desktop

Electron 主进程骨架 / IPC 框架 / 窗口与玻璃。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §2.1 / §3.2 + Spike **S1 / S4** 实测结论

## 安全基线

```ts
webPreferences: {
  nodeIntegration: false,   // 渲染进程拿不到 Node
  contextIsolation: true,
  sandbox: true,
  preload: 'preload.cjs',   // ⚠️ 必须是 .cjs
}
```

⚠️ **sandbox 开启时 preload 必须是 CommonJS**，ESM preload 会失败。这是 `preload.cjs` 后缀的由来，不要改成 `.mjs`。

## IPC 契约

`src/shared/ipc-channels.ts` 是通道名的**单一来源**，主/渲染/preload 三方共用。

因为 preload 必须是 CJS，通道表有两份（`.ts` 与 `.cjs`）。**测试里有对比校验** —— 改漏一处测试会红，避免"preload 与主进程对不上"这类静默失败。

所有 invoke 都收敛成 `IpcResult<T>` 判别联合，渲染侧不必满屏 try/catch。

## 窗口：方案 A（S1 实测已拍板）

```ts
{
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  roundedCorners: false,
  vibrancy: undefined,      // ⚠️ 绝不能开：与 transparent 冲突会模糊错乱
  titleBarStyle: undefined, // 仅 frame:true 可用，与玻璃形态冲突
}
```

**S1 实测**：四组对照 P50 均为 **120.5 FPS、掉帧率 0%**，已贴满 120Hz 上限。透明+玻璃与不透明对照**完全相等** → **B1 冲突不成立** → D4 达成。

## 玻璃降级路径（强制要求）

`applyGlass()` **永不抛异常** —— 这是硬要求，否则应用起不来。四条降级路径都有测试覆盖：

| 情况 | mode | reason |
|---|---|---|
| 非 macOS | `none` | 平台不支持 |
| Darwin < 26 | `css` | 系统版本不足 |
| 用户手动关闭 | `css` | 设置项 |
| 原生模块加载失败 | `css` | 异常信息（截断到 120 字符） |

⚠️ **`electron-window-glass` 是 ESM-only**：`exports` 只声明 `import`。用 `require` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（S1 与 S4 各自独立复现）。必须 `await import()`。

## 交通灯

`frame:false` 下用 `setWindowButtonPosition({x,y})` + `setWindowButtonVisibility(true)` —— 这是唯一可用且不抛异常的组合（S1 实测）。
**不要用 `titleBarStyle`**（仅 `frame:true` 可用）。

## 🔴 Darwin 版本判断（S4 实测更正）

文档原称「Darwin 内核版本是 26，按 27 比较会判错」。**实测反驳**：

```
os.release() → 27.0.0      uname -r → 27.0.0
sw_vers → ProductVersion 27.0, BuildVersion 26A428
```

本机 Darwin 是 **27**，不是 26。原文把 **build 号 `26A428` 误当成了内核版本号**。

阈值 `>= 26` 仍然安全（27 ≥ 26），玻璃正常启用，本次未造成功能问题。但判据必须写对：**用 `os.release()` 取内核主版本，不依赖 build 号，也不假设 Darwin 主版本 = macOS 市场版本减一**。

## FPS 保护降级

`onLowFps(fps)`：原生模式下测得 FPS < 50 时自动降级为 CSS 并说明原因。本机 S1 未触发（120.5 FPS），作为**跨机型保险**保留。

## 测试

```bash
npm test   # 21 passed
```

`window.test.ts` 用 `vi.mock` 拦掉 `electron`（无 GUI 环境无法构造 BrowserWindow），只测纯逻辑：Darwin 版本解析、玻璃支持判定、**四条降级路径不抛异常**、FPS 保护。
