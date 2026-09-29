# 研发进展：网格交互层与可视化骨架

日期：2026-09-22 | 阶段：WBS 阶段 3（数据网格）+ 阶段 2 的 UI 部分

---

## 一、交付清单

| # | 模块 | 包 | 单测 | 状态 |
|---|---|---|---|---|
| 1 | 网格视图模型 | `core-grid-view` | 47 | ✅ |
| 2 | 剪贴板（复制/粘贴） | `core-clipboard` | 45 | ✅ |
| 3 | 筛选构建器 | `core-filter` | 33 | ✅ |
| 4 | 库表树视图模型 | `core-tree-view` | 31 | ✅ |
| 5 | 命令面板 | `core-command-palette` | 28 | ✅ |
| 6 | 标识符转义（抽包） | `core-sql-ident` | 9 | ✅ |
| 7 | React 渲染层 | `apps/desktop/renderer` | — | ✅ |

**验证结果**

- `npm run typecheck` — 0 error（根 + 渲染层两个 tsconfig 都过）
- `npm test` — **494/494**（上一轮 301 → 新增 193）
- `npm run e2e` — 真实 MySQL **48/48**（上一轮 36 → 新增 12 项）
- `npm run e2e:grid` — 网格滚动性能探针，判定通过
- `npm run e2e:ui` — **真机 UI 12/12**（新增，见 §五）

`npm run verify` 已把 UI 真机门禁一并串进去，一条命令全跑完。

---

## 二、为什么先做纯逻辑再做 UI

网格是全产品最核心的模块。本轮把可视区计算、选择、键盘导航、排序三态、
剪贴板对齐、筛选编译、树展开记忆、面板打分**全部做成零 UI 依赖的纯函数**，
于是可以在搭 React 之前用 193 个单测把所有交互边界守住。
React 组件只负责把结果画出来，不含判断逻辑。

### 刻意回避的两件事

- **能否编辑**：统一由 `core-mutation` 的 `isEditable(table)` 决定。
  渲染层不得自行判断有无主键（B5 红线，判断逻辑只有一处）
- **单元格取值**：由 `ColumnarReader` 负责（只解可视区）

---

## 三、真库实测发现（三条）

### 1. WHERE 参数必须排在 LIMIT 参数之前

`buildOpenTableSql()` 生成的 SQL 里 WHERE 在 LIMIT 之前。e2e 首次跑挂：
`syntax error near ''30''` —— 把 `'paid'` 喂给了 LIMIT。
**参数顺序是 `[...whereParams, ...limitParams]`**，反了报的错完全指向别处。

### 2. 单行无逗号的 CSV 只能靠"行首引号"识别

`"他说""你好"""` 这种输入既无逗号也无制表符，按中位数打分会退化成 TSV，
引号不被还原。补了一条 `lines.some(l => l.startsWith('"'))` 判定。

### 3. 拼音首字母不能用 Unicode 区段猜

试过区段方案，**会错**：「单」(U+5355) 按区段落进 b 区，实际是 d。
**猜错比不支持更糟** —— 用户会以为功能坏了。
改成显式汉字映射（只覆盖数据库领域常见字，不引词典，避免与
"首屏 bundle ≤1.5MB"冲突），未命中退化为子串匹配。

---

## 四、真库性能：只解可视区得到验证

新增 `npm run e2e:grid`（`scripts/e2e-perf-grid.mjs`），5 次采样 P50：

| 结果集 | 编码耗时 | 载荷体积 | 首屏解码 | 滚到底部解码 |
|---|---|---|---|---|
| 3,000 | 5.4ms | 511 KB | 0.112ms | 0.028ms |
| 30,000 | 46.3ms | 5.3 MB | 0.105ms | 0.022ms |
| 100,000 | 176.8ms | 17.7 MB | 0.096ms | **0.021ms** |

**结果集涨 33 倍，解码耗时恒定在 0.02~0.11ms**（倍数 0.2×，反而更短——
首屏要建列视图，滚到底部时视图已缓存）。
若有人偷偷调 `decodeAll` / `materialize`，探针会因耗时线性增长而失败。

> 与 S1 的分工：S1 测 **DOM 渲染帧率**（需 Electron+GUI，120.5 FPS）；
> 本探针测 **数据层耗时**（无需 GUI，CI 可跑）。

---

## 五、顺手修的工程问题

### 1. mysql2 被拖进浏览器 bundle

渲染层引 `core-driver-mysql` 转义列名 → Vite 构建报
`stream/tls/crypto/zlib 被 externalize`。

**根因**：标识符转义是纯字符串逻辑，却和驱动耦合在一起。
抽出零依赖的 **`core-sql-ident`**，构建模块数 **157 → 30**，
`core-driver-mysql` 保留 re-export 维持兼容。

### 2. 首屏体积

渲染层 `265 KB / gzip 85 KB`，远低于 S2 的 1.5MB 未压缩硬约束。
把 `chunkSizeWarningLimit` 设成 700，让这条约束在构建期可见。

---

## 五之二、真机 UI 验证与 R1 风险解除

单测过了不代表页面能跑。用 Playwright 驱动本机已有的 Chromium（复用
`~/Library/Caches/ms-playwright`，不重复下载浏览器）打开了真实页面，
脚本固化为 **`npm run e2e:ui`**。

### 🟢 R1 风险正式解除

上一轮标记的红线是："S1 探针是每帧 28 行**裸网格**，真实单元格含脏标记 /
斜体 NULL / 富样式，富样式可能吃掉预算"。实测：

| 指标 | S1 裸网格探针 | **本轮真实网格** | 预算 |
|---|---|---|---|
| P50 帧间隔 | 8.3ms | **8.3ms** | ≤16.7ms |
| 换算 FPS | 120.5 | **120.5** | ≥55（120Hz 屏 ≥100） |
| P95 | — | 14.9ms | — |
| 掉帧率 | 0% | **0%** | 0% |

**富样式没有吃掉任何预算**，与 S1 完全相等。R1 从"待复测"转为"已解除"。

> 帧率必须**有头模式**测：headless Chromium 走虚拟 vsync，数字没有意义。
> 脚本在 `DB_STUDIO_UI_HEADLESS=1` 下只记录不断言，方便 CI 用。

### 真机验证抓出的两个真 bug（单测测不到）

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | **⌘S / ⌘K 时灵时不灵** | 键盘处理只挂在 `.grid-viewport` 上；焦点落在树、工具栏、弹窗里就失效。PRD §9.2「键盘优先」的硬伤 | 在 `App` 上挂 **window 级** keydown 监听 |
| 2 | **编辑提交后方向键全失效** | 编辑器 `input` 卸载后焦点落回 `body`，网格的 keydown 再也收不到 | `commitEdit()` 末尾把焦点还给 viewport |

两个都是**焦点治理**问题 —— 单测模拟不到真实焦点流转，只有真机点一遍才会暴露。
这正是把 UI 门禁并进 `verify` 的理由。

### 顺带清掉的

- 表头残留一个 `display:none` 的索引 `<span>`（开发期调试产物）
- CSP 报 404：缺 favicon。补了 `public/favicon.svg`（不用空 `data:` URI，
  会被 `default-src 'self'` 挡掉并刷控制台错误）

### 12 项断言覆盖

虚拟滚动（5 万行只渲染 40~51 行）、滚动后内容更新、NULL 斜体、双击编辑、
脏标记、⌘S 预演弹窗且含 UPDATE、⌘K 开、Esc 关、排序三态、帧率、控制台无错。

---

## 六、IPC 接线（本轮后半，头号阻塞解除）

渲染层此前吃 `demoData.ts`。本轮接上真主进程，**渲染层组件一行没改** ——
当初"接 IPC 只需换后端"的设计兑现了。

### 链路与产物

```
shared/ipc-channels.ts  ← 通道契约（ESM + CJS 双份，测试守卫两边一致）
        ↓
preload.cjs  ← contextBridge 暴露 window.dbStudio
        ↓
ipc-handlers.ts  ← 全部返回 IpcResult，异常绝不外抛给渲染层
        ↓
session-registry / connection-store / history / secret
        ↓
backend.ts（渲染层唯一入口，hasIpc() 自动选 IPC 或 demo）
```

| 产物 | 体积 | 说明 |
|---|---|---|
| `dist/main/main.cjs` | 84 KB | **必须 CJS**（Electron 的 ESM 入口不提供命名导出） |
| `dist/preload/preload.cjs` | 4.8 KB | sandbox:true 下只能是 CJS |
| `renderer/dist/` | 271 KB / gzip 87 KB | S2 硬约束 1.5MB 未压缩，余量充足 |

### 真机 e2e（`npm run e2e:app`，25 项）

真 Electron 窗口 + 真 MySQL fixture（1000 万行大表 + 自建临时库），
覆盖：preload 桥接、safeStorage 契约、建连、introspect、列式传输跨进程、
**只读拦截穿透渲染层**、真写库回读、历史（含失败 SQL 也记录）、
无键表、渲染层 DOM、控制台无错。

---

## 七、真机抓到的 4 个真 bug（单测全绿也照样漏）

这是本轮最有价值的部分 —— **562 个单测全绿，真机一跑崩了 4 处**。

### 1. Electron 44 破坏性变更：safeStorage 异步解密返回对象

`decryptStringAsync()` 返回 `{ result, shouldReEncrypt }`，**不是 string**。
本项目按旧签名写死接口，于是**整个对象被当成密码传给 mysql2**，
报 `The "data" argument must be of type string`。

**最值得警惕的**：单测替身也按旧签名实现，**跟被测代码一起错**，
197 行测试全绿、一上真机就崩。

> **替身照着被测代码的错误理解来实现，测试就失去了意义。**

修法：`normalizeAsyncDecrypt()` 兼容两种形态（旧版返回裸串也不能废）；
`shouldReEncrypt=true` 时按官方语义**再解一次**，并回调上层把密文用新密钥
重新加密落盘（`ConnectionStore.replaceCipher()`）—— 否则老密文会一直
停留在被轮换掉的旧密钥上，违背密钥轮换的安全意图。
另在真机 e2e 加了契约断言，防 Electron 再升级时签名悄悄变。

### 2. file:// 下产物路径必须是相对

Vite 默认的 `/assets/xxx.js` 在 `file://` 下解析到**磁盘根目录**，
JS 根本没加载（`#root` 空、页面全白）。

⚠️ 两个坑连在一起：
- `base` 是 Vite **顶层**字段，**写进 `build.base` 不报错但静默失效**
- 产物里的 `crossorigin` 属性在 file:// 下会让模块脚本被拒绝加载

**这类故障极具迷惑性**：主进程 IPC 全部照常工作，
用"调接口全通"的验证方式完全测不出来。

### 3. CSP 挡掉构建抽离的 CSS

只写 `style-src 'unsafe-inline'` 会拦掉 Vite 抽出的独立 `.css` 文件
→ 页面有结构无样式。改为**构建期注入**（`apply:'build'`）——
dev 模式绝不能注入，否则挡掉 Vite 的 HMR 客户端和 react-refresh
内联脚本，dev 直接白屏。

### 4. 排序三态走不完第二轮

`loadTable` 无条件 `setSorts([])`，而**排序触发的重拉走同一个函数** ——
服务端刚按新排序返回，客户端立刻把状态清空，表头箭头消失。
修：加 `keepSort` 参数，只有换表才重置。

---

## 八、环境坑（换机器必踩）

| 现象 | 根因 | 解法 |
|---|---|---|
| 进程 **SIGTRAP** 自杀，`FATAL: GPU process isn't usable` | 宿主沙箱不允许 Chromium 再套子进程沙箱，GPU 进程连环崩。最小复现（空 app + data URL）也 100% 崩 | 自动化加 **`--no-sandbox`** |
| `Cannot find module 'electron'` | 宿主导出 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成纯 Node | e2e 里 `delete env.ELECTRON_RUN_AS_NODE` |
| 第二次启动立刻退出 | 单实例锁被上一轮残留进程占住 | `DB_STUDIO_NO_SINGLE_LOCK=1` |
| renderer 的 `window` 报 TS2304 | 根 tsconfig 把 renderer 也扫了，但缺 DOM lib | 两套 tsconfig 各管各的 |

> **`--no-sandbox` 的代价要说清楚**：这一步关掉的是 Chromium 渲染进程沙箱，
> 意味着真机 e2e **无法验证沙箱相关的安全行为**。本脚本的目标是
> 「IPC 接线 + 列式载荷跨进程 + 只读拦截」，不依赖沙箱，可以接受；
> 人工验收时不跑该脚本，仍是带沙箱的。

---

## 九、运行方式

```bash
npm run verify            # 一条命令全跑完（约 20 秒）
npm run typecheck         # 两套 tsconfig：core + renderer
npm test                  # 571/571
npm run e2e               # 48/48 真库冒烟，需 fixture 在 13306
npm run e2e:grid          # 网格解码性能探针
npm run e2e:ui            # UI 真机 15 项（会弹 Chromium 窗口约 10 秒）
npm run e2e:app           # Electron 真机 25 项
npm run build             # renderer + main + preload
npm start                 # 构建后启动真应用

cd apps/desktop/renderer && npx vite    # 渲染层 dev server（demo 数据）
```

缺 `playwright-core` / Chromium / fixture 时，两个真机脚本**跳过并提示，
不算失败** —— 逻辑门禁由 `npm test` 负责。

---

## 十、下一步

| 项 | 说明 |
|---|---|
| **SQL 编辑器** | CodeMirror 6，**必须懒加载**（首屏 bundle 最大单点增量）。当前 271KB / 上限 1.5MB，接完重测 S2 |
| 右侧详情面板 | 表信息 / 字段详情 / 单元格完整值 |
| 筛选器 UI | 逻辑已就绪，差图形化条件构建器 |
| SSH 隧道 | ssh2 尚未接入，目前只有配置与私钥权限校验 |
| ~~IPC 接线~~ | ✅ **已完成**（2026-09-22）：25 项真机断言全绿 |
| ~~🔴 R1 风险复测~~ | ✅ **已解除**：真实网格 P50 8.3ms / 120.5 FPS / 掉帧率 0% |
| 🔴 焦点治理回归 | 新增交互组件时必须复查 focus 流转，尤其是弹窗开/关后焦点该回哪 |

---

## 十一、方法论沉淀（比这轮代码更值钱）

1. **替身不能照着被测代码的假设实现** —— 那样它只会跟被测代码一起错。
   凡是对**外部 API 形态**的假设，都必须有一条真机断言看着它
2. **"调接口全通" ≠ "页面能用"** —— 渲染层 JS 压根没加载时，
   主进程 IPC 照样全绿。**真机门禁必须断言 DOM 真的渲染出来了**
3. **e2e 失败时先 dump 现场**（`#root` innerHTML + 控制台错误），
   别对着一句 `waitForSelector timeout` 猜 —— 本轮 4 个 bug 有 3 个
   是靠 dump 才看清的
4. **断言语义，不断言实现细节** —— 硬编码密文字面值的测试，
   在替身换 salt 格式时全红，而产品行为其实完全正确
