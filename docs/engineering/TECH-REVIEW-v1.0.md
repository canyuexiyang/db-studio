# DB Studio 技术评审报告 v1.0

> 评审对象：`docs/PRD-v0.3.md`（含 v0.1 需求基线）
> 评审日期：2026-09-20
> 目标环境：macOS 27.0 (build 26A428，Darwin 26) / Apple M5 Pro 15核 / 48GB / arm64
> 评审人角色：高级开发工程师（技术负责人视角）
> 结论一句话：**产品定义扎实、可以做；但 PRD 有 5 项技术前提需要修正，其中 1 项（透明窗口 × 网格 120Hz 滚动）可能推翻 D4 的落地形态，必须先做 Spike 再开工。**

---

## 〇、评审结论摘要

### 0.1 总体判断

| 维度 | 结论 |
|---|---|
| 产品定位与取舍 | ✅ 成立，技术可实现。三层取舍清晰，非目标砍得干净，工程上不会被"功能对等"拖死 |
| 差异化假设（快） | 🟡 有条件成立。冷启动 ≤1.5s、表首屏 ≤1s 可达；**网格 ≥55FPS 与 D4 原生玻璃存在直接冲突风险** |
| 性能预算 | 🟡 11 项中 6 项可达、3 项偏乐观、2 项（100万行 xlsx ≤30s、常驻 ≤250MB）需实测后重定 |
| 技术选型 | 🟡 主体可用，但有 3 处必须替换/增补（keytar → safeStorage、正则只读校验 → SQL AST 白名单、electron 41 → 44） |
| 工期 | 🔴 PRD 只评估了 D3/D4/D5 的增量，没有总量。按本文 WBS 估算单人全职 **约 3~4 个月**（AI 辅助可压缩至 2~2.5 个月） |
| 是否可开工 | **建议先做 5 项 Spike（5~7 工作日）**，S1 出结果前不要投入网格与视觉层的正式开发 |

### 0.2 阻塞级问题（P0，必须先解决才有讨论 v1 范围的意义）

| # | 问题 | 影响 | 建议动作 |
|---|---|---|---|
| **B1** | `transparent: true` 会强制 Chromium 关掉 GPU 合成、退回软件光栅化，与「网格滚动 ≥55FPS / 120Hz ≥100FPS」直接冲突 | 可能让 G2 目标与 D4 目标二选一 | **Spike S1** 先测，见 §6 |
| **B2** | `electron-window-glass` 的 API 是 **窗口级** 的（`createWindowGlass(window, …)`），没有"给侧边栏这一块区域加玻璃"的能力 | PRD §8.2「侧边栏玻璃 + 内容层非玻璃」在当前包上无法直接实现 | 改架构：整窗玻璃 + 内容区 CSS 不透明（见 §3.1） |
| **B3** | PRD 红线写「Electron ≥41」，但 **Electron 41 已于 2026-08-25 EOL** | 用一个已停止维护的版本做红线，等于一开工就背着 CVE 和支持断供 | 红线改为 **≥42，锁定 44.x** |
| **B4** | D6 只读模式用「关键字正则 + 跳过注释字符串」拦截写操作 | 正则扫 SQL 在工程上必然漏判（`CALL`/`SELECT…INTO OUTFILE`/`WITH…UPDATE`/多语句），这是**安全功能**，漏判 = 生产事故 | 改为 **SQL AST 语句类型白名单 + 解析失败即拒绝**（见 §4.2） |
| **B5** | PRD 未定义「无主键/无唯一键表」的编辑策略，但红线是「绝不整行覆盖」 | 无 PK 时无法定位行，工程上要么拒绝编辑、要么退化成全列 WHERE（仍然危险） | 补需求：无唯一键 → 网格只读 + 引导用 SQL（见 §4.1） |

### 0.3 重要问题（P1，实现期必须处理，不阻塞开工）

| # | 问题 | 建议 |
|---|---|---|
| P1 | 100万行导出 xlsx ≤30s 与 exceljs 公开基准（1M 行约 89s）差距过大 | 重测后调整预算，或换"手写 sheet XML + 流式 zip"（§5.3） |
| P2 | 常驻内存 ≤250MB（Electron 基线已约 150MB） | 结果集必须列式存储 + 后台标签数据淘汰（§5.2） |
| P3 | 长查询取消没有实现路径（MySQL 无带内取消） | 维护连接发 `KILL QUERY` + `max_execution_time` 兜底（§4.3） |
| P4 | 3000×30 结果集走 JSON IPC 会吃掉大半首屏预算 | 主进程编码列式 `ArrayBuffer`，transfer 零拷贝（§3.2） |
| P5 | `electron-window-glass` 仅 2 个版本、1.0 发布不足 1 个月，native 产物需按 Electron 44 ABI 重建 | 打包期验证预编译产物；无产物则需 Xcode CLT + node-gyp（§6 S4） |
| P6 | frameless + glass 下交通灯、窗口圆角裁切、拖动区需自行处理 | 列入 Spike，别在正式开发期才发现 |

---

## 一、依赖与版本核验

### 1.1 Electron 版本（对应 B3）

**核验结果**（releases.electronjs.org 官方排期表，2026-09-20 现值）：

| 版本 | Stable | EOL | Node | Chromium | 状态 |
|---|---|---|---|---|---|
| 41.0.0 | 2026-03-10 | **2026-08-25** | v24.14.0 | M146 | 🔴 已 EOL |
| 42.0.0 | 2026-05-05 | 2026-10-20 | v24.15.0 | M148 | ⚠️ 两个月内 EOL |
| 43.0.0 | 2026-06-30 | 2027-01-05 | v24.17.0 | M150 | 🟡 可用 |
| **44.x** | 2026-08-25 | **2027-03-02** | v24.18.1（44.1.0 为 v24.19.0） | M152 | ✅ **推荐锁定** |
| 45.0.0 | 2026-10-20 | 2027-04-27 | v24.20.0 | M156 | 观察 |

**结论**：
- PRD §7.1 / §12.3 的「Electron ≥41」红线**必须改写**。41 在今天已经 EOL，42 也只剩 1 个月。
- 建议红线表述：**Electron ≥ 42，工程锁定 44.x**。44 天然满足 `electron-window-glass` 的 ≥41 要求，也满足 macOS 26+ GPU 空转修复（38.2.0 修复线）。
- 升级策略：主版本每 6~8 周一个，建议固定「跟随 stable-1」，即新版本发布后观察 2 个小版本再升，避免踩首发坑。**不要追 alpha/beta**，这个项目没有 QA 资源。

### 1.2 `electron-window-glass`（对应 B2 / P5）

**核验结果**（npm README，v1.0.0，2026-08-22 发布，全站仅 0.1.7 / 1.0.0 两个版本）：

- 要求：macOS 26+ 才能用 `kind: 'glass'`；macOS 14+ 可用 `kind: 'backdrop'`；**Electron ≥41**。
- 低于 26 时请求 `kind: 'glass'` **会直接抛异常**（不是静默失败）——这点对降级路径是好事，可以 try/catch 捕获。
- API 形态：`createWindowGlass(window, options)`，**入参是整个 BrowserWindow**（另一个重载接受 `window.getNativeWindowHandle()`）。**没有 subview / region 级 API**。
- `cornerRadius` 会同时裁切 Electron 的 native content host，渲染内容不会溢出圆角。
- `backdrop` 走私有 Core Animation / WindowServer 符号，**不适合 MAS 分发**；`glass` 是公开 API，无此问题。PRD 选 `glass` 正确。
- MIT 协议。

**评审意见**：
1. **B2 成立**：包只提供窗口级效果。PRD §8.2 想要「侧边栏玻璃、内容层不玻璃」在当前 API 上做不到。解法见 §3.1。
2. **成熟度风险**：包只有 2 个版本、1.0 才发布 1 个月，社区验证样本极少。这不该成为阻塞（有降级路径），但要在 Spike 里验证它在 Electron 44 + arm64 上真的能跑起来，且打包后有可用产物。
3. **降级路径 PRD 已设计（GlassProvider）** ✅，但建议把降级触发条件补一条：**运行时检测到网格滚动 FPS < 50 时，允许自动关闭玻璃**（见 §3.1 方案 C）。

### 1.3 凭据存储（对应选型修正 #1）

**核验结果**：`keytar` 已停止维护（GitHub 归档），主流替代是 Electron 内置 `safeStorage`。官方建议用**异步 API**（`encryptStringAsync` / `decryptStringAsync`），原因很实在：macOS 上访问钥匙串可能弹权限确认并**阻塞当前线程**。

**建议**（替换 PRD §10 的"keytar 或 safeStorage"）：
- 统一用 `safeStorage` 异步 API，密文 base64 存进 `connections.json` 的 `passwordEnc` 字段。
- 启动顺序：`app.whenReady()` 之后先 `await safeStorage.isAsyncEncryptionAvailable()`，不可用则整连接进入"每次手动输密码、不落盘"模式（PRD §6.1.1 已定义该降级，✅ 直接复用）。
- 私钥 passphrase 同样走 safeStorage。
- 好处：少一个 native 依赖（少一个 ABI 重建风险点），包体更小。

### 1.4 本地 SQLite（历史库）

**核验结果**：`node:sqlite` 自 Node 22.13 起无需 `--experimental-sqlite`，但官方文档在 v24.14.0 仍标注 **Stability 1.1（活跃开发中）**；社区信息称 24.15+ 进入 RC。Electron 44 带 Node 24.18/24.19，**可用**。

**建议**：
- 历史库用 `node:sqlite` 的 `DatabaseSync`，**零 native 依赖、零重建**，符合"不依赖完整 Xcode"的定位。
- 只用核心 API（`DatabaseSync` / `StatementSync` / `exec` / `prepare` / `run` / `get` / `all` / `iterate`），**不要碰** `createSession` / `applyChangeset` / `createTagStore` 这类仍在演进的接口，避免升级 Electron 后 API 漂移。
- 必须 `PRAGMA journal_mode=WAL`；所有写走 prepared statement（防注入，历史 SQL 里全是用户原文）。
- Q15（要不要支持本地 SQLite 库）成本因此极低（驱动免费），建议从 P2 提到 **P1.5**，排在 Redis 之前。

### 1.5 依赖清单 diff（相对 PRD v0.1 §二）

| 变更 | 项 | 理由 |
|---|---|---|
| ❌ 移除 | `keytar` | 已停止维护，改 `safeStorage`（内置） |
| ➕ 新增 | `node-sql-parser`（或同等 MySQL/PG AST 解析器） | D6 只读校验、无 WHERE 检测、危险操作识别都需要真 AST，不能正则 |
| ➕ 新增 | `csv-parse`（流式） | CSV 导入解析，配合 Worker |
| ➕ 新增 | `iconv-lite` | CSV 的 GBK 编码（PRD §6.6.2 要求支持 GBK） |
| ➕ 新增 | `zod` | 连接配置 / 偏好设置的 schema 校验与版本迁移 |
| ➕ 新增 | `pinyin-match`（或自研 4KB 拼音首字母表） | 树搜索与命令面板的拼音首字母匹配（Q2 / D5） |
| ➕ 新增 | `archiver` 或 `zip-stream`（可选） | 若 S3 证明 exceljs 不达标，改走手写 sheet XML + 流式 zip |
| 🔄 版本 | `electron` → **44.x** | 41 已 EOL（B3） |
| 🔄 确认 | `exceljs` | 保留，但**只用 `stream.xlsx.WorkbookWriter`**，禁止 `workbook.xlsx.writeFile()` |
| ➕ 新增 | `@playwright/test`（e2e） | 红线项的自动化验证（§8） |
| ➖ 不引入 | Electron Forge / electron-updater / 崩溃上报 | v0.1 已排除，评审同意，别为了"方便"偷偷加回来 |

---

## 二、架构建议

### 2.1 进程与边界

```
┌─ 主进程（Node 24）────────────────────────────────┐
│  ConnectionManager（连接池 / SSH 隧道 / 生命周期） │
│  QueryService（执行 / 流式 / 取消 / 超时）         │
│  SchemaCache（库表字段元数据，内存 + 磁盘快照）    │
│  SqlGuard（AST 解析 → 语句类型白名单 → 拦截）     │
│  MutationBuilder（脏单元格 → UPDATE/INSERT/DELETE）│
│  HistoryStore（node:sqlite）                       │
│  SecretStore（safeStorage）                        │
└────────────── IPC（contextBridge，类型化通道）─────┘
┌─ 渲染进程（React + Zustand）──────────────────────┐
│  三栏布局 / 虚拟网格 / CodeMirror / 命令面板       │
└───────────────────────────────────────────────────┘
┌─ utilityProcess（可 kill）────────────────────────┐
│  导出 Worker / 导入解析 Worker                     │
└───────────────────────────────────────────────────┘
```

**要点**：
- 渲染进程 `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`。注意：**sandbox 开启时 preload 必须是 CommonJS**，ESM preload 会失败。
- 重活（导出/导入解析/大 JSON 格式化）放 **utilityProcess** 而不是 `worker_threads`：utilityProcess 可以 `kill()`，导出「取消」按钮因此是**真取消**而不是"跑完再丢弃"，且崩溃不拖垮主进程。
- 主进程保持"薄"：任何单条 SQL 的执行路径上不要有同步 JSON 大对象操作。

### 2.2 IPC 数据传输（对应 P4）

PRD §7 要求"表首屏 ≤1s"、§6.4.2 要求"1万行结果首行渲染 ≤500ms"。如果 3000 行 × 30 列走 JSON 结构化克隆，序列化 + 反序列化在渲染进程侧轻松吃掉 300~600ms，且峰值内存翻倍。

**建议**：主进程把结果集编码成**列式二进制**后 transfer：

```ts
// 主进程：编码
interface ColumnarPayload {
  rowCount: number;
  columns: { name: string; typeCode: number; }[];
  // nullMask: 每列一个 Uint8Array；data: 数值列 TypedArray、字符串列用 offset+utf8 拼接
  buffers: ArrayBuffer[];
}
// postMessage(..., transferList) —— 零拷贝
```

- 数值列：`Float64Array` / `BigInt64Array` + nullMask。
- 字符串列：`Uint32Array` offsets + 一段 UTF-8 `Uint8Array`，渲染时按需 `TextDecoder.decode`（只解可视区那 ~40 行）。
- 预期收益：3000×30 从 ~15MB JSON 降到 ~2~4MB 二进制，传输耗时从数百毫秒降到十毫秒级，且**支持只解码可视区**，直接服务"首行渲染 ≤500ms"。
- 这是本项目中**投入产出比最高的一项优化**，建议在 Spike S5 里就按这个形态做，别先写 JSON 版本再返工。

---

## 三、D4 原生玻璃：架构必须调整（对应 B1 / B2）

### 3.1 三种落地形态，建议按 Spike 结果二选一

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. 整窗玻璃 + 内容区不透明**（推荐优先验证） | 主窗口 `transparent: true` + `backgroundColor:'#00000000'` + `roundedCorners:false` + `createWindowGlass(win, {kind:'glass'})`；渲染层里侧边栏/工具栏/浮层用**半透明**背景，网格/编辑器/卡片用**完全不透明**背景 | 只有一个窗口，无子窗口同步问题；观感上"chrome 玻璃、内容实体"正是 Apple 的指引 | `transparent:true` 可能导致软件光栅化 → **网格 FPS 崩**（B1） |
| **B. 主窗不透明 + 玻璃子窗口** | 侧边栏/Inspector/命令面板各开一个 frameless 透明 `BrowserWindow`（`parent: mainWin`）单独加 glass | 主窗保留 GPU 合成，网格性能不受影响 | 子窗口跟随父窗口移动/缩放有可感知延迟；焦点与 z-order 管理麻烦；多窗口让 Cmd+W / Cmd+` 等快捷键语义变复杂 |
| **C. 主窗不透明 + CSS `backdrop-filter`** | 完全不用原生 glass，侧边栏用 CSS 毛玻璃 | 零 native 依赖、性能最好 | PRD 已判定"差一代"，且 PRD 明确它只是降级项 |

**建议决策流程**：
1. Spike S1 先做方案 A，**只测一件事**：透明玻璃窗口里放 10000 行 × 20 列的虚拟滚动表格，在 120Hz 下滚动，用 Chromium FPS meter + `performance` API 采样。
2. 若 P50 ≥ 100 FPS → 采用 A，D4 目标达成。
3. 若 50 ≤ P50 < 100 → 采用 A，但把玻璃限制在**侧边栏与浮层**（内容区既是不透明，视觉上本就一致），并把"网格滚动 FPS"写进设置页诊断信息。
4. 若 P50 < 50 → 采用 B（或 C），D4 降级为"侧边栏 CSS 毛玻璃 + 命令面板/浮层用原生玻璃小窗口"，**并向产品同步：原生玻璃与 120Hz 网格在本机不可兼得**。

> 这条必须在正式开发前定。因为它同时决定：窗口构造参数、渲染层的分层策略（哪些元素能透明）、以及 B1 是否会变成"G2 不达标"。

### 3.2 其他玻璃相关工程约束

- **不要同时开 `vibrancy`**（PRD 已写明，✅ 正确，且这是真实冲突，必须写进代码的注释里防止后人加回来）。
- 圆角由 glass 的 `cornerRadius` 提供，**渲染层不要自己画窗口级圆角**；内容区四角会被裁切，滚动条与右下角状态栏要留出安全边距。
- 交通灯：`frame: false` 后需自行实现原生交通灯的位置与行为，Electron 44 上的具体可用 API（`titleBarStyle` / `setWindowButtonPosition`）**需在 Spike 中实测确认**，不要凭文档想当然。
- 版本判断用 **`os.release()`（Darwin 内核版本）≥ 26**，不要解析市场版本号，也不要硬编码"27"。当前实测环境是 macOS 27.0 / build 26A428，即 Darwin 26 —— 若按"27"去比较会直接判错。
- 降级实现必须**同步 try/catch**：包在 <26 上抛的是异常，`GlassProvider.applyTo()` 里要包住，禁止让异常冒泡到 `app.whenReady()`。
- 设置页要显示当前生效模式（PRD 已要求，✅），建议同时显示"降级原因"（如：模块加载失败 / 用户关闭 / FPS 保护）。

---

## 四、核心机制的工程方案（PRD 只写了"要求"，这里给"怎么做"）

### 4.1 网格编辑红线：只提交被编辑的单元格（对应 B5）

PRD 把这条列为头号红线，但只给了"要求"，没给机制。以下是必须落到代码里的设计：

**数据结构**
```ts
type CellKey = string;               // `${rowId}::${columnName}`
interface PendingEdit {
  rowId: string | null;              // 主键/唯一键序列化后的行标识
  locate: LocateStrategy;            // 'pk' | 'unique' | 'all-columns' | 'none'
  column: string;
  oldValue: unknown;                 // 原始值（用于冲突检测与展示）
  newValue: unknown;
  invalid?: { reason: string };      // 类型校验失败原因
}
```

**行定位策略（补齐 B5 的需求缺口）**

| 表具备 | 策略 | WHERE 构造 | 可否编辑 |
|---|---|---|---|
| 单列主键 | `pk` | `WHERE pk = ?` | ✅ |
| 非空唯一键 | `unique` | `WHERE uk1 = ? AND uk2 = ?` | ✅ |
| 复合唯一但可空 | `unique` | 同上，但含 NULL 的列改 `IS NULL` | ✅，提示"可空唯一键，存在歧义风险" |
| **无任何唯一键** | `none` | —— | ❌ **网格只读**，顶部提示"该表无主键/唯一键，无法安全定位行，请使用 SQL 编辑" |

> 最后一行是 PRD 缺的。Navicat 在这类表上的行为正是历史上事故来源之一。**没有唯一键就不允许网格编辑**，这是唯一能保证红线的方式，也让"红线"在工程上可验收。

**冲突检测（顺带实现，成本几乎为零）**

生成的 UPDATE 带上被编辑列的原值：
```sql
UPDATE `order` SET `status` = ? WHERE `id` = ? AND `status` = ?;
```
- `affectedRows === 1` → 成功。
- `affectedRows === 0` → **行已被删除或该列已被他人修改** → 标记冲突，保留改动，提示用户刷新后重新编辑。
- `affectedRows > 1` → 立即中止并回滚整批（这说明定位条件不唯一，属于 bug，绝不能继续）。
- 排除列：`FLOAT/DOUBLE/JSON/BLOB/GEOMETRY` 的原值不进 WHERE（浮点与二进制比较不可靠），这些列只做主键定位。

**批量提交语义**
- 一轮保存（Cmd+S）内的所有改动 → **单事务**提交；任一失败整轮回滚，脏标记保留，错误定位到具体行与列。
- PRD §6.3.4 要求"保存失败应精确定位到失败行，保留其他改动不丢失" —— 注意这与"单事务"有张力：**事务回滚意味着其他单元格的改动在库里也没生效**。建议表述改为：**UI 层保留全部脏标记**（不清除），提示"已回滚，共 N 处改动未生效，第 X 行 Y 列失败：原因…"，让用户修完这一处再整体提交。这是"不丢失用户劳动"的正确解法，也和 PRD 意图一致。
- 新增行：先 INSERT，拿回 `insertId` 后作为该行的 rowId，后续编辑才算可定位。**不支持"改一半的新行 + 改一半的旧行"混在同一轮保存里的部分成功** —— 顺序执行、失败即停。

### 4.2 只读模式拦截：从正则改成 AST 白名单（对应 B4）

PRD §6.1.6 建议"识别 INSERT/UPDATE/… 关键字则拒绝，校验前跳过注释与字符串"。**这套在工程上不可靠**，理由：

- 漏判（会造成实际写入）：`CALL proc()`、`SELECT … INTO OUTFILE`、`SELECT … FOR UPDATE`、PG 的 `WITH … UPDATE`、`TRUNCATE` 之外的 `LOAD DATA`、`CREATE TEMPORARY TABLE`、以及多语句中的第二条（`SELECT 1; DROP TABLE t`）。
- 误判（会让只读模式难用）：字段名/表名/字符串里含 `update`、`delete` 等词。
- 手写"跳过注释与字符串"的词法器 = 自己写半个 SQL 解析器，是典型的隐性大坑。

**建议实现**：
1. 用 `node-sql-parser`（MySQL / PostgreSQL 方言）解析出 AST，读 `ast.type` 得到语句类型。
2. **语句类型白名单**（而不是写操作黑名单）：
   ```
   select, show, describe, desc, explain, use, set(仅限安全变量白名单)
   ```
   不在白名单内 → 拒绝。这样 `CALL` / `INTO OUTFILE` / 未来的新语法天然被拦住。
3. **多语句**：先按分号拆分（复用 SQL 编辑器已有的拆分逻辑），**逐条**解析，任何一条不在白名单就整批拒绝。
4. **解析失败 → 拒绝执行**（fail-closed），并提示"无法判定该语句是否为只读，已阻止执行"。宁可误拦，不可漏放。
5. `SET` 要小心：MySQL 里 `SET autocommit=0`、`SET @@…` 有副作用，建议只允许一个明确的小白名单（如 `SET NAMES`、`SET SESSION time_zone`），其余一律拒绝。
6. 可选纵深防御（需在你的 MySQL 版本上验证后再启用）：连接建立后执行 `SET SESSION TRANSACTION READ ONLY`（若服务端支持），作为第二道闸。**不要把它当作唯一防线**，因为它的作用域受 autocommit 与事务边界影响，行为不直观。

> UI 置灰（PRD 已要求）保留，但它是"体验层"，不是"安全层"。安全层只有第 2~4 步。

### 4.3 长查询取消与超时（对应 P3）

MySQL 协议**没有带内取消**：一条查询发出后，同一条连接必须等它返回，无法中断。PRD §6.4.2 要求"Cmd+. 取消执行"和"30s 超时提示"，实现路径 PRD 没给：

- **取消**：每个连接额外维护一条**管理连接**。用户取消时，用管理连接执行 `KILL QUERY <原连接的 connection_id>`。原连接的 query 会以 error 返回，前端按"已取消"处理。
- **超时提示**：到 30s 时**不 KILL**（PRD 明确"不自动 kill"，✅ 正确，慢查询可能是有意跑的），只弹提示；用户选择"继续等待"或"取消"。
- **兜底**：连接选项里设置 `SET SESSION max_execution_time=<ms>`（MySQL 5.7.4+，毫秒，仅对 SELECT 生效）作为硬上限，防止忘记取消的连接长期占用资源。**需在目标 MySQL 版本上验证可用性**再默认开启，否则降级为纯前端计时。
- **流式结果**：导出与大结果集必须用 `connection.query(sql).stream()` 边收边写，禁止一次性缓冲到内存。

### 4.4 mysql2 连接参数（直接决定数据正确性）

PRD 未定义驱动参数，这会导致 BIGINT 精度丢失、时区错乱、JSON 被二次解析等问题。建议固定：

```ts
{
  // 精度
  supportBigNumbers: true,
  bigNumberStrings: true,     // BIGINT 一律字符串，避免 >2^53 精度丢失
  decimalNumbers: false,      // DECIMAL 保持字符串（默认即是）
  // 时间
  dateStrings: true,          // 不做 Date 对象转换，保留服务端原文（含 DATETIME(6) 微秒）
  timezone: 'local',
  // JSON
  jsonStrings: true,          // 保留 JSON 原文，避免驱动自动 JSON.parse 丢精度/丢格式
  // 安全
  multipleStatements: false,  // 默认禁多语句；.sql 脚本导入走单独开关的专用连接
  // 性能
  rowsAsArray: true,          // 大结果集用数组而非对象，省内存省 GC（网格/导出路径）
}
```

- `dateStrings: true` 后，网格里日期显示的就是服务端原文，编辑时也按原文回填，避免"看的是 UTC、写回去变本地时间"的经典事故。
- `rowsAsArray` 与 §2.2 的列式编码天然契合，建议网格与导出路径统一用它；SQL 编辑器的小结果集可用对象模式方便调试。

### 4.5 Schema 缓存与补全

- 连接成功后**异步**拉取一次：库列表 → 表/视图/存储过程 → 字段（名/类型/可空/默认值/注释/主键/唯一键）→ 索引、外键按需拉。
- 落盘快照（`app.getPath('userData')/schema-cache/<connId>.json`），下次打开**先渲染快照再后台刷新**，直接服务"树首屏 ≤500ms"（§6.1.5）。
- 快照要有版本号与 TTL（建议 7 天），过期则显示"元数据可能过期"并提供刷新入口。
- 补全元数据走同一份缓存；补齐 Q2（按字段名搜表）只需再加一个 `columnName → tableName[]` 倒排索引，成本约 0.5 天。

### 4.6 SSH 隧道

- 隧道与 DB 连接必须**成对管理**：`ConnectionManager` 里维护 `tunnelId ↔ connectionId` 映射，`before-quit` 与连接关闭时都 `end()`。
- `ssh2` 需配置 `keepaliveInterval` / `keepaliveCountMax`，否则网络断开后隧道会变成"僵尸"，表现是"连着但所有查询超时"。
- 私钥文件权限检查（PRD 已要求，✅）用 `fs.stat().mode & 0o077` 判定。

---

## 五、性能预算复核

逐条给结论（M5 Pro / macOS 27 / 120Hz）：

| PRD 指标 | 评审结论 | 说明 |
|---|---|---|
| 冷启动 ≤1500ms（P50） | 🟡 **可达但紧** | 见下方 §5.1，必须做懒加载才有戏 |
| 连接恢复 ≤1000ms | ✅ 可达 | 本地 MySQL；快照 + 异步刷新即可 |
| 表首屏 ≤1000ms | 🟡 可达 | 依赖 §2.2 列式传输；JSON 传输会不达标 |
| 网格滚动 ≥55 FPS | 🔴 **与 D4 冲突** | 见 B1 / Spike S1 |
| 排序/筛选 ≤1500ms | ✅ 可达 | 服务端执行 + 索引字段；主要针对"带索引"，无索引全表排序不保证 |
| 结果首行渲染 ≤500ms | ✅ 可达 | 前提是列式 + 只解码可视区 |
| 编辑器首字符 ≤16ms | ✅ 可达 | CodeMirror 6 常规水平 |
| 自动补全 ≤100ms | ✅ 可达 | 纯本地缓存 |
| 常驻内存 ≤250MB | 🟡 **偏乐观** | 见 §5.2 |
| 100万行 xlsx ≤30s | 🔴 **大概率不可达** | 见 §5.3 |
| 窗口缩放/切标签 ≤100ms | ✅ 可达 | 但要保证标签切换不重建网格实例（用 keep-alive + 数据淘汰） |

### 5.1 冷启动（目标 ≤1.5s）

必须做的四件事，缺一件基本就没戏：

1. **驱动懒加载**：`mysql2` / `ssh2` / `pg` 等在**首次连接时** `await import()`，不在 `app.whenReady()` 里 require。这是最大的一块（原生模块 + 大 JS 解析）。
2. **CodeMirror 懒加载**：编辑器相关包动态 import，首次打开查询标签时才载入。
3. **历史库延迟打开**：`node:sqlite` 的 `DatabaseSync` 在首屏渲染完成后再开（或首次访问历史时开）。
4. **不要在启动路径上做任何网络 / DNS / 钥匙串同步调用**：`safeStorage.isAsyncEncryptionAvailable()` 是异步的，别在启动同步路径里 await 它挡住窗口创建。

另外两点：
- `asar` 打包建议开启，但 `compression` 用默认而非 `maximum`（最高压缩会显著拖慢首次启动）。
- 测的是**第二次及以后的启动**。首次启动受 Gatekeeper 校验/ translocation 影响，不应计入。

### 5.2 常驻内存（目标 ≤250MB）

Electron 空壳基线约 150MB，只剩 100MB 给应用。这是预算里最紧的一条：

- 网格数据必须**列式**（§2.2），对象数组形态下 3000×30 轻松占 30~60MB。
- **后台标签数据淘汰**：切走的标签只保留 schema + 前 100 行预览，切回时重新拉取（本地库 <300ms，可接受）。
- 查询历史与片段在 SQLite 里，不常驻内存。
- 导出走 utilityProcess，进程结束内存即释放，不污染常驻。
- 建议把指标改为"**空闲 5 分钟后 ≤250MB**"，而不是"任意时刻 ≤250MB"（刚跑完一个 10 万行查询时超一点是合理的）。

### 5.3 导出（PRD：100万行 xlsx ≤30s / 峰值 ≤500MB）

**这与公开基准有数量级差距。** 第三方基准（exceljs 流式）：10 万行 ≈ 12s / 45MB，50 万行 ≈ 45s，100 万行 ≈ 89s / 92MB。即使 M5 更快，30s 内跑完 100 万行也偏乐观。

建议：
1. **Spike S3 实测**（100万行 × 12 列，M5 本地）：只测 `stream.xlsx.WorkbookWriter`。
2. 优化开关（成本低，效果明显）：`useSharedStrings: false` + `useStyles: false`，逐行 `addRow().commit()`，不构造样式对象。
3. 若仍 >30s，两条路：
   - **改预算**：100 万行 ≤60s（导出是后台任务，60s 用户可接受），或把验收口径改成"50 万行 ≤30s"。
   - **换实现**：手写 sheet XML（inline string，不用 sharedStrings）+ `archiver` 流式 zip。xlsx 本质是 zip 包 XML，绕开 exceljs 的对象模型通常能快 2~3 倍，代价是失去样式能力（导出场景可接受）。
4. **进程隔离**：导出放 `utilityProcess`，用 `kill()` 实现真取消（worker_threads 做不到干净取消）。
5. 无论哪条路，PRD 的"峰值内存 ≤500MB"在流式写入下应该很轻松（基准 92MB），这条可以保留。

### 5.4 导入（D3：5万行 × 12 列 ≤60s / ≤600MB）

- 分批 INSERT（1000 行/批，50 批）在 M5 上 60s 内可达，✅ 预算合理。
- **唯一键冲突预检必须批量化**：PRD §6.6.2 第 3 步要求"唯一键冲突需查库确认"，如果逐行查就是 5 万次往返 → 必挂。改成每 1000 行一次 `SELECT uk FROM t WHERE uk IN (?, ?, …)`。
- 解析放 utilityProcess（xlsx 用 exceljs 流式读，csv 用 `csv-parse` 流式）；预览前 20 行只需读前 20 行，总行数从 sheet dimension 或第一遍扫描拿。
- 大文件（>10 万行）的"预估耗时"提示，先用前 1000 行线性外推即可，别追求精确。

---

## 六、Spike 计划（建议 5~7 工作日，先于正式开发）

| # | Spike | 要回答的问题 | 预估 | 失败则 |
|---|---|---|---|---|
| **S1** | **透明玻璃窗口 × 虚拟网格滚动** | 方案 A 下 10000 行 × 20 列在 120Hz 滚动的 P50 FPS 是多少？ | 1.5d | 转方案 B/C，同步产品 D4 降级 |
| **S2** | **冷启动骨架** | 空壳 + 懒加载策略下，冷启动 P50 能否 ≤1.5s？`electron-builder` 打包后呢？ | 1d | 目标改为 ≤2.0s，或砍掉启动期的某个懒加载项 |
| **S3** | **100万行 xlsx 导出** | exceljs 流式在 M5 上的真实耗时？加 `useSharedStrings:false` 后能到多少？ | 1d | 改预算或换手写 XML + zip |
| **S4** | **打包与签名** | Electron 44 + `electron-window-glass` 在 arm64 上是否有可用预编译产物？无产物时 Xcode CLT 重建是否顺利？ad-hoc 签名后能否正常启动？ | 1d | D4 走 CSS 降级；或接受"仅 arm64 + 手动右键打开" |
| **S5** | **10M 行 fixture + IPC 首屏** | Docker MySQL 8 + 1000 万行种子数据能否快速造出来？列式 ArrayBuffer 传输 + 首屏渲染总耗时？ | 1.5d | 调整首屏预算或降低默认加载行数（Q16） |

> S1 与 S5 是**决策性**的，另外三项是**验证性**的。若时间只够两项，做 S1 和 S5。

S5 的 fixture 建议：`docker compose` 起 MySQL 8（配置 `innodb_buffer_pool_size` 给足），用存储过程批量灌 1000 万行（预计 10~20 分钟、磁盘 2~3GB），一次生成后保留 volume，后续所有性能测试都用它。**没有这个 fixture，"千万行表"的所有性能验收都是空谈。**

---

## 七、工期评估与里程碑

PRD 只估了 D3(+3~5d) / D4(+1~2d) / D5(+2~3d) 三项增量，没有总量。以下是按本文方案的全量 WBS（单人，工作日）：

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 0 | Spike（§六） | 5~7 |
| 1 | 工程骨架 / IPC 框架 / 三栏布局 / 设置与存储层 | 6~8 |
| 2 | 连接管理（直连 + SSH + SSL + 生命周期 + safeStorage） | 8~10 |
| 3 | 库表树（懒加载 + 搜索 + D1 展开记忆 + 右键菜单） | 6~8 |
| 4 | **数据网格**（虚拟滚动 + 排序筛选 + 特殊类型 + **编辑红线** + D2 粘贴） | 15~18 |
| 5 | SQL 编辑器（CodeMirror + 补全 + 选中执行 + 取消 + EXPLAIN + 历史/片段） | 10~12 |
| 6 | 表设计器（字段/索引/外键/DDL 预览） | 6~8 |
| 7 | 导出（4 格式 + 进度 + 取消） | 4~6 |
| 8 | D3 导入向导（4 步） | 5~7 |
| 9 | D5 命令面板 | 2~3 |
| 10 | D6 只读模式（AST 白名单 + UI 拦截） | 3~4 |
| 11 | D4 玻璃落地（若 S1 顺利；含交通灯/圆角/降级） | 3~5 |
| 12 | 打包 / 签名 / 性能达标调优 / e2e 红线测试 | 5~7 |
| **合计** | | **≈ 78~103 工作日** |

- 单人全职约 **4~5 个月**；AI 辅助（代码生成 + 测试生成）经验上可压缩 30~40%，约 **2.5~3 个月**。
- **排期建议**：把 D3（导入）退到 **v1.1**（PRD 自己留了这个口子），v1.0 立即可省 5~7 天且降低风险。D4 若 S1 不顺利，退 CSS 方案可再省 3~5 天。
- 同意 PRD Q13 的串行策略（MySQL 打透 → PG → Redis → Mongo），但**建议 v1.0 只锁 MySQL**，PG 之前先跑一轮 v1.0 的真实自用（至少两周），用真实痛点校准 v1.1，而不是按文档想象。

---

## 八、验收补充：PRD 缺失的工程验收项

PRD §12 的功能验收写得不错，但以下工程项缺失，建议补进 v1.0 门槛：

- [ ] **无主键/唯一键的表，网格只读并给出明确提示**（B5）
- [ ] **只读模式下 `CALL` / `SELECT … INTO OUTFILE` / 多语句第二条写操作，全部被拦截**（B4）
- [ ] 只读模式下解析器报错时，语句被拒绝执行（fail-closed）
- [ ] 编辑保存时，被他人修改过的行被识别为冲突且不覆盖（affectedRows=0）
- [ ] BIGINT 超过 2^53 的值在网格与导出中保持精确（不出现 …000 尾数）
- [ ] `DATETIME(6)` 微秒位在查看与编辑中不丢失
- [ ] JSON 字段中的大整数不被 `JSON.parse` 损精度
- [ ] 长查询取消后，服务端该查询确实被终止（`SHOW PROCESSLIST` 验证）
- [ ] 应用退出后无 SSH 隧道孤儿进程
- [ ] 导出中途取消，输出文件不存在或明确标记为未完成（不留半截 xlsx）
- [ ] 配置文件中不出现任何明文密码（`grep` 验证）
- [ ] 打包产物在 arm64 上能正常启动（含原生模块加载、玻璃降级路径）
- [ ] 冷启动取**第二次及以后**的 P50

**自动化建议**：上述前 8 项 + PRD 三条红线，用 Playwright 驱动 Electron 写 e2e（配合 Docker fixture）。这个项目没有测试同学，红线项只能靠自动化守住 —— 尤其是"只提交被编辑单元格"这条，改一次网格代码就可能回归。

---

## 九、对 PRD 剩余 10 项开放问题的技术意见

| # | 问题 | 技术意见 | 成本 |
|---|---|---|---|
| Q2 | 按字段名搜表 | **做**。schema 缓存加 `column → tables` 倒排索引，纯本地，不影响性能 | 0.5d |
| Q3 | 冻结列 | **做**。网格布局本来就要分"左侧固定区 + 滚动区"，不做反而要特判。v1 冻结首列即可 | 1d（与网格同做） |
| Q5 | 历史记录失败语句 | **做**。失败语句是最需要复用的，不记反而反直觉 | ~0 |
| Q6 | Excel 超长文本/非法字符 | **必须做 B（截断 + 坐标报告）**。这不是体验问题：xlsx 单元格上限 32767 字符，非法控制字符会让文件损坏打不开 | 0.5~1d |
| Q8 | 表单视图 | **不做**。同意 PRD。右侧面板 + 冻结列足够 | 0 |
| Q11 | 应用名称 | 无技术意见。建议尽快定，因为会影响 bundleId、钥匙串条目名、userData 路径，**改名要迁移数据** | 0（但越早越好） |
| Q13 | 阶段排期 | 同意串行。建议 v1.0 只做 MySQL + 真实自用两周后再开 v1.1 | — |
| Q14 | AI 能力 | 同意"不做但预留入口"。补充：预留只需在编辑器右键菜单加一个禁用项，**不要**提前引入 LLM SDK 依赖 | ~0 |
| Q15 | 本地 SQLite | **建议从 P2 提到 P1.5**。因为 `node:sqlite` 是内置的，驱动零成本，主要工作量是树/网格适配 | 3~5d（PG 之前插队） |
| Q16 | 默认加载 3000 行 | 同意 3000 + 可配。补充：做成"上次选择记忆"比做成设置项更省事 | ~0 |

---

## 十、PRD 需修订项清单（建议产品据此更新到 v0.4）

| 位置 | 现状 | 建议修订 |
|---|---|---|
| §7.1 / §12.3 | Electron ≥41 | **Electron ≥42，锁定 44.x**（41 已 EOL） |
| §8.1 / §8.2 | 侧边栏玻璃 + 内容层非玻璃 | 改为"**整窗原生玻璃 + 内容层不透明**"，并写明方案 B/C 的降级顺序 |
| §6.1.6 | 正则关键字校验 | 改为"**SQL AST 语句类型白名单 + 解析失败拒绝**"，删除正则方案 |
| §6.3.4 | 红线：只提交被编辑单元格 | 补充**行定位策略表**与"无唯一键则网格只读" |
| §6.3.4 | "保存失败应保留其他改动不丢失" | 改为"整轮回滚，UI 保留全部脏标记 + 精确定位失败处" |
| §7 | 100万行 xlsx ≤30s | 待 S3 实测后重定（预备口径：≤60s 或 50万行 ≤30s） |
| §7 | 常驻内存 ≤250MB | 明确为"**空闲 5 分钟后** ≤250MB" |
| §6.4.2 | 长查询取消 | 补充实现路径（管理连接 `KILL QUERY` + `max_execution_time` 兜底） |
| §2 / §十 | keytar 或 safeStorage | 统一 **safeStorage 异步 API** |
| §6.1.5 | 树首屏 ≤500ms | 补充依赖"schema 磁盘快照 + 后台刷新" |
| §12 | 验收清单 | 并入 §八 的 13 项工程验收 |
| 新增 | —— | 新增一节"**驱动连接参数规范**"（§4.4） |

---

## 十一、评审签字结论

- **产品定义**：通过。定位、取舍、北极星指标都清晰，工程上不会失控。
- **技术方案**：**有条件通过**。必须先完成 Spike S1（玻璃 × 网格 FPS）与 S5（fixture + 首屏），这两项决定 D4 形态与 G1/G2 目标能否同时成立。
- **可以开始写代码的部分**（不依赖 Spike 结论）：连接管理层、safeStorage、Schema 缓存、SQL AST 校验模块、历史库、导出 utilityProcess 骨架 —— 这些都是纯逻辑，不受窗口方案影响，可以并行开工。
- **不要先写的部分**：网格视觉层、玻璃相关代码、任何窗口构造参数的固化。

> 一句话给产品：**这台机器上"原生玻璃"和"120Hz 顺滑网格"可能只能要一个，Spike 一周内给你答案；在此之前别把 D4 当成既定事实写进排期承诺。**
