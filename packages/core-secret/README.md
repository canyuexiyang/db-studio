# @dbstudio/core-secret

凭据存储（`safeStorage`）。

> 依据：`docs/engineering/TECH-REVIEW-v1.0.md` §1.3（替换已停止维护的 keytar）

## 三条关键设计

### 1. 统一用**异步** API

`encryptStringAsync` / `decryptStringAsync`。原因很实在：macOS 上访问钥匙串可能弹权限确认并**阻塞当前线程**，同步 API 会卡住主进程 —— 直接违背「冷启动 ≤1.5s」和「不卡 UI」。

无异步 API 时自动回退 `sync-fallback` 并在 `reason` 里说明。

### 2. 不可用 → 密码**不落盘**

`isEncryptionAvailable()` 为 false 时，整连接进入「每次手动输密码」模式（PRD §6.1.1 已定义该降级）。

`sealSecrets()` 在此情况下返回 `{ passwordEnc: null, promptEveryTime: true }` —— **绝不存明文**。测试断言序列化后的 JSON 里不含明文。

### 3. 依赖注入，不直接 import electron

`SecretStore` 接收一个 `SafeStorageLike` 实例。好处：测试环境可注入 fake，主进程外也能跑，将来换实现不用改调用方。

## 模式

| mode | 含义 |
|---|---|
| `async` | 异步加解密（最优） |
| `sync-fallback` | 环境无异步 API，回退同步（可能短暂阻塞） |
| `unavailable` | 加密不可用 → 不落盘 |

`init()` 必须在 `app.whenReady()` 之后调用，但**不要为了等它而阻塞窗口创建**（PRD §7.2）。

## `scanForPlaintextSecrets`（PRD 工程验收项）

静态自检：递归扫描配置对象，检出 `password` / `passwd` / `pwd` / `passphrase` / `secret` / `token` / `privateKey` 等字段名（大小写不敏感）。用于 CI 或启动自检，保证配置文件里不出现明文密码。

`*Enc` 结尾的字段不算明文（`badKeys` 用精确匹配，不含 `Enc` 后缀）。

## 测试

```bash
npm test   # 17 passed
```

覆盖：三种模式探测、异步/同步往返、Unicode 与恶意字符串无损、不可用时拒绝加解密、绝不落明文、明文扫描。
