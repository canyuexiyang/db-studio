# DB Studio 开发进度 — 2026-09-24：SSH 隧道（ssh2）落地

## 结论

`ssh2` 已接入并打通端到端。`npm run verify` 全绿（退出码 0）：

| 门禁 | 数量 | 结果 |
|---|---|---|
| 单测 | **674**（原 618，新增 56） | ✅ |
| 首屏体积（`check:bundle`） | 7 | ✅ 281.3KB / 1465KB |
| 真库冒烟 `e2e` | 48 | ✅ |
| **SSH 真机 `e2e:ssh`（新增）** | **18** | ✅ |
| 网格性能 `e2e:grid` | — | ✅ 只解可视区恒定 |
| UI 真机 `e2e:ui` | 29 | ✅ |
| Electron 真机 `e2e:app` | 31 | ✅ |

## 新增 / 改动的文件

| 文件 | 说明 |
|---|---|
| `packages/core-ssh-tunnel/` | **新包**。ssh2 客户端封装，28 单测 |
| `packages/core-driver-mysql/src/index.ts` | `streamFactory` 注入 + `tunnel` 挂载（`close()` 一并释放） |
| `apps/desktop/src/main/tunnel-manager.ts` | **新文件**。读私钥 / 解密 passphrase / 开隧道，13 单测 |
| `apps/desktop/src/main/session-registry.ts` | `DriverFactory` 支持 async；隧道与连接成对管理 |
| `apps/desktop/src/main/connection-store.ts` | 新增 `sshCredentialsFor()`（SSH 凭据独立于 DB 密码） |
| `apps/desktop/src/main/main.ts` | 接线 `SshTunnelManager` |
| `apps/desktop/src/shared/ipc-channels.ts` | 新增 `SSH_FAILED` 错误码 |
| `scripts/e2e-ssh.mjs` | **新门禁**。起真 ssh2.Server 转发到真 MySQL |
| `apps/desktop/vite.main.config.ts` | `ssh2` 加入 external |

## 方案

不做"起本地端口转发监听"，而是把 SSH channel **直接作为 mysql2 的底层流**：
`ssh2.Client.forwardOut()` → 拿到的 `Channel` 是一个 Duplex → 传给 mysql2 的
`stream` 选项。省掉一次本机 TCP 回环，也没有端口占用与冲突问题。

主连接与 `KILL QUERY` 管理连接各开一条独立 channel（`CONNECTION_ID` 实测不同）。

## 🔴 本轮踩到并修掉的真机问题

### 1. mysql2 的 `stream` 传函数是**同步调用**

```js
// mysql2/lib/base/connection.js
} else if (typeof opts.config.stream === 'function') {
  this.stream = opts.config.stream(opts);   // ← 同步！返回值必须是 stream 对象
```

传一个返回 Promise 的工厂 → mysql2 拿到 Promise → `this.stream.on(...)`
直接抛 `this.stream.on is not a function`。
**必须先 await 出 channel，再以对象形式传 `stream`。** 这是 `openChannel()` 必须
async 的原因。

### 2. `forwardOut` 的回调不保证被调用

服务端关掉 `AllowTcpForwarding` 时，有的实现既不 accept 也不 reject ——
回调永远不来，Promise 永久挂起。**真实表现：连接一直转圈，不成功也不报错。**
单测替身必然测不出来（是我们让替身挂住的）。已给转发阶段加独立超时。
真机门禁里这一项挂在【4】被看门狗逮到。

### 3. CJS 产物下 `await import('ssh2')` 命名导出不完整

同样的代码，ESM（tsx 跑脚本）下命名导出完整；**主进程打包成 CJS 后**
只有 `Client` 少数几项，`utils` / `Server` 都跑到 `mod.default` 上了。

```js
// ESM:  Object.keys = [AgentProtocol, Client, utils, Server, ...]
// CJS:  Object.keys = [AgentProtocol, BaseAgent, Client, createAgent, default]
//                                     ↑ utils/Server 只在 default 里
```

与 Electron 44 的 `safeStorage.decryptStringAsync()` 返回对象是同一类事故：
**对外部模块导出形态的假设，必须有真机断言看着**。已在 `e2e:ssh` §5 加断言，
并把解包逻辑抽成 `pickSshClient()` 单独守契约。

### 4. 认证方式是互斥的

私钥认证时不该同时把 SSH 密码发出去 —— 两种凭据一起发，ssh2 会依次尝试，
表现为"明明配了私钥却因为密码错误被拒"，排查方向完全跑偏。单测先红后修实现。

## 设计取舍

- **依赖方向单向**：`core-ssh-tunnel` 不认识连接配置，`core-driver-mysql`
  不认识 ssh2（只认 `TunnelHandle` 这个"能关"的最小契约），
  翻译工作放在主进程的 `tunnel-manager.ts`。
- **私钥只存路径不存内容**，读文件与权限校验在 `tunnel-manager` 做。
- **隧道挂在驱动上**，`driver.close()` 一并释放；`session-registry` 再兜一次
  （建连失败时驱动不持有隧道）。双层兜底对应 PRD §6.1.2「不残留孤儿进程」红线。
- **测试连接也走隧道**：否则"测试通过但真连失败"，最难排查。

## 未覆盖（诚实列出）

- **渲染层没有 SSH 配置表单**。当前 UI 还没有连接编辑器（新建/编辑连接面板
  尚未实现），SSH 配置字段模型与校验已在 `core-connection` 就位，
  但界面入口缺失 —— 这是下一个可开工项。
- 私钥**带 passphrase** 的真机用例：本轮起 ssh2.Server 时用的是无口令私钥，
  带 passphrase 的路径只有单测覆盖（替身），真机未验。
- 跳板机的"二次跳转"（SSH → SSH → DB）不支持，PRD 也没要求。
