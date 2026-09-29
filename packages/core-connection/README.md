# core-connection — 连接配置与生命周期

PRD §6.1。纯逻辑，不依赖 Electron、不依赖任何驱动。

## 职责

1. **配置模型** `ConnectionConfig`：字段、默认值、分组、颜色标签、只读开关
2. **校验** `validateConnectionConfig()`：返回 issue 列表（error 阻塞保存 / warning 可保存）
3. **生命周期状态机** `ConnectionRuntime`
4. **分组树** `buildGroupTree()`（§6.2.1：分组 → 连接，支持嵌套）

## 三条硬约束

### 1. 配置里永不明文密码

`ConnectionConfig` **只有** `passwordEnc`（base64 密文）与 `promptEveryTime`。
明文只在 `core-secret` 解密后的内存里短暂存在。

`validateConnectionConfig` 会对 `passwordEnc` 做 base64 形态检查，
发现疑似明文直接 error —— 这是"工程验收：配置文件不含明文密码"的静态防线。

### 2. 时钟与定时器注入

`ConnectionRuntime` 构造接受 `Clock`。生产传 `systemClock`，
测试传可控时钟，这样 1s/2s/4s 退避与 10 分钟空闲断开**不需要真的 sleep**。

```ts
const { clock, advance } = fakeClock();
const rt = new ConnectionRuntime('c1', clock);
rt.connect(); rt.onConnected(); rt.onNetworkBreak();
advance(1000);              // 第 1 次重连触发
```

### 3. SSH 私钥权限是 warning 不是 error

权限过宽（group/other 位非 0）→ warning + `chmod 600` 修复命令。
**不静默使用，也不阻塞保存**（§6.1.2）。

## 状态机

```
idle ──connect()──> connecting ──onConnected()──> connected ⇄ busy
                        │                            │
              onConnectFailed()            onNetworkBreak()  (最多 3 次)
                        ▼                            ▼
                     failed                    disconnected ──> failed(重试耗尽)
```

- 重连间隔固定 `[1000, 2000, 4000]`，`onConnected()` 重置计数
- `disconnect()` 后回 `idle`，可再次 `connect()`
- `idleTimeoutMs` 默认 10 分钟，仅 `connected` 态计时；`beginQuery/endQuery` 会刷新

## 用法

```ts
const issues = validateConnectionConfig(cfg, { sshKeyMode: 0o644, fileExists: fs.existsSync });
if (hasBlockingError(issues)) return;   // 禁止保存
```
