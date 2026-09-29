# Spike S1 结论报告：方案 A 下「透明玻璃窗口 × 10000×20 虚拟滚动网格」120Hz FPS

> 决策性 Spike。本文件结论可直接贴入 Spike 总报告与 PRD §8.1.1「S1 实测结论」表。
> 实测日期：2026-09-21｜环境：macOS 27.0 (build 26A428, Darwin 26) / Apple M5 Pro 15核 / 48GB / arm64 / ProMotion 120Hz / Electron 44.4.3。

---

## 0. 一句话结论

**采用方案 A（整窗原生玻璃 + 内容区不透明），D4 达成 ✅。** 在全部四组窗口配置下，10000×20 虚拟滚动网格的 P50 均为 **120.5 FPS、掉帧率 0%**，与 120Hz 显示屏上限一致——透明 + 原生 Liquid Glass **没有产生任何可观测的 FPS 惩罚**。B1 假设的「透明窗口导致 GPU 合成关闭、网格 FPS 崩」在本栈（Electron 44 / macOS 26 / M5 Pro）对本工作负载**未成立**。

---

## 1. 四组实测 FPS 表

测量方法：rAF 采样帧间隔 → 每帧 FPS=1000/Δt；程序化 `scrollTop` 递增覆盖全程；5 轮 × ≥600 帧；P50/P95 取各轮帧 FPS 分布中位数/95 分位；掉帧率 = 帧间隔 >16.7ms 的帧占比。滚动热路径零对象分配（固定 28 行 DOM 池，仅改 `transform`/`textContent`）。

| 组 | 窗口配置 | 网格 | P50 FPS | P95 FPS | 掉帧率 | 备注 |
|---|---|---|---|---|---|---|
| **G1** | `transparent:true` + `bg #00000000` + `roundedCorners:false` + `frame:false` + **`createWindowGlass(win,{kind:'glass'})` 已应用** | 10000×20 | **120.5** | 133.3 | **0%** | 玻璃包加载并应用成功（Darwin 26） |
| **G2** | 同上但**不加玻璃**（隔离"透明"变量） | 10000×20 | **120.5** | 131.6 | **0%** | 纯透明窗口代价 |
| **G3** | `transparent:false`（不透明对照，vibrancy 关，`frame:true`） | 10000×20 | **120.5** | 131.6 | **0%** | 基线 |
| **G4** | 不透明 + 仅 100 行（测 120Hz 上限） | 100 行 | **120.5** | 131.6 | **0%** | **方法学校验：达到 ~120Hz，证明测量链路有效** |

> 每组 5 轮各自 P50 完全一致（120.5），P95 在 129.9–133.3 间，minFps≈106，无一轮出现 >16.7ms 帧。原始数据见 `raw/fps-G*.json`。

**核心对比**：G1(透明+玻璃) vs G3(不透明) → P50 120.5 vs 120.5（差异 0）；G1 vs G2(透明无玻璃) → 完全一致 → 玻璃本身也几乎零附加成本。透明的"软件合成"路径（若存在）在本工作负载下完全跟得上 120Hz。

---

## 2. 按 PRD §8.1.1 判定表给出判定结论

### 2.1 S1 实测结论表（对齐 PRD §8.1.1 格式，可直接填表）

| 项 | 值 |
|---|---|
| 实测日期 | 2026-09-21 |
| 透明 + 玻璃 P50 / P95 FPS | **120.5 / 133.3** |
| 不透明无玻璃（对照）P50 / P95 FPS | **120.5 / 131.6** |
| **判定采用方案** | **A**（整窗原生玻璃 + 内容区不透明） |
| D4 是否达成 | **✅ 达成** |

### 2.2 判定规则表（C2 确认，工程可直接执行）

| 实测 P50 FPS | 采用 | 玻璃范围 | D4 是否达成 | 额外动作 |
|---|---|---|---|---|
| ≥ 100 | **A** | 整窗原生玻璃，内容区不透明 | ✅ 达成 | 无 |

> 实测 P50 = 120.5（G1 透明+玻璃），落在 ≥100 档 → **方案 A，D4 达成**，无需降级、无需设置页 FPS 诊断兜底。

---

## 3. B1 冲突是否成立（透明窗口是否真的导致 GPU 合成关闭）

**结论：B1 的「FPS 崩」结果未出现；其底层机制（透明窗口走软件合成路径）无法用全局 chrome://gpu 直接隔离，但对本工作负载无观测影响。**

### 3.1 GPU 合成证据（自证，非仅报 FPS）

通过 `app.getGPUInfo('complete')` 与 `chrome://gpu`（递归读取 `<info-view>` shadow DOM）取得：

- **GPU 设备**：`ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, 版本27.0 版号26A428)` —— 真实硬件 GPU 存在且激活。
- **chrome://gpu Graphics Feature Status（全局）**：
  - `Canvas: Hardware accelerated`
  - `Compositing: Hardware accelerated`
  - `Rasterization: Hardware accelerated`
  - `WebGL: Hardware accelerated` / `WebGPU: Hardware accelerated`
  - `Video Decode/Encode: Hardware accelerated`

> 注：chrome://gpu 给出的是**全局**特性状态，**不反映单个 transparent 窗口的 compositor 选择**。Chromium 对 `transparent:true` 窗口历史上会回退到软件合成（这是 B1 的来源），但该全局视图无法确认"当前这个透明窗口是否走了软件路径"。

### 3.2 决定性证据是 FPS 差分

- 若 B1 成立（透明→软件合成→FPS 崩），应观察到 **G2(透明) / G1(透明+玻璃) 显著低于 G3(不透明)**。
- 实测：**G1 = G2 = G3 = 120.5 FPS，掉帧率均 0%**。透明窗口与玻璃均未引起任何 FPS 退化。
- 因此无论透明窗口内部是否走软件合成路径，**其对本网格工作负载的帧时间影响 < 0.1ms，完全在 120Hz 帧预算（8.33ms）内**。B1 担心的"网格 FPS 崩"在本栈本负载下**不成立**。

> 诚实边界：本探针为最小虚拟滚动网格（每帧仅 ~28 可见行重绘）。若未来真实单元格含图片/复杂样式，需对更重负载再校验；但 S1 要回答的"方案 A 能否在 120Hz 下撑住 10000×20 虚拟滚动"已得到 YES。

---

## 4. PRD「网格滚动 ≥55FPS / 120Hz ≥100FPS」是否可达

- **可达性：✅ 完全可达。**
  - 120Hz 屏：四组 P50 = 120.5 ≥ 100 → 达标（且贴满 120Hz 上限）。
  - 通用门槛 ≥55 FPS：远低于，余量极大。
- **修正值：无需修正。** 最小网格在所有窗口形态下均稳定保持 120Hz、0 掉帧。PRD 原门槛（≥55 / ≥100）对本负载偏保守，实测远高于此。
- 建议：在真实组件（含图片/富样式单元格）落地前，用本探针同法做一次更重负载复测，作为验收闸门。

---

## 5. 玻璃包（electron-window-glass@1.0.0）安装 / 重建 / 加载结果

- **安装**：在 `spike/s1-glass-grid/` 下 `npm i electron-window-glass@1.0.0`，**成功，耗时 ~5s**（14 个包）。
- **重建**：**无需重建**。该包自带预编译原生模块 `dist/electron_window_glass.darwin-arm64.node`（N-API，ABI 稳定），兼容 Electron 44 / Node 24。无需 `electron-rebuild`。
- **加载（关键坑，S4 相关）**：
  - 该包 `package.json` 的 `exports` **仅声明 `import`（ESM），未声明 `require`（CJS）**。用 CJS `require('electron-window-glass')` 会直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（见 `raw/fps-G1.json` 早期失败记录）。
  - **正确做法**：主进程用 ESM（`main.mjs`）通过 `await import('electron-window-glass')` 加载。本 Spike 已验证此路径在 Electron 44 上加载并应用成功（`createWindowGlass(win,{kind:'glass'})` 返回 `kind:'glass'`，`applied:true`）。
  - **`GlassProvider.applyTo()` try/catch 包裹**：已按 PRD §3.2 要求，加载与应用均包在 try/catch 内，<Darwin 26 时返回明确降级原因，不向上冒泡到 `app.whenReady()`。
  - Darwin 版本判断：用 `os.release()` 解析内核主版本（实测 `27.0.0` → `26` ≥ 26），**未硬编码"27"**。

---

## 6. 交通灯 API 实测结论（PRD §8.1 / §3.2）

在 Electron 44 / macOS 26、`frame:false` 玻璃窗口下实测：

| API | 是否可用（函数为 function） | 调用是否抛异常 | 适用窗口 |
|---|---|---|---|
| `win.setWindowButtonVisibility(true)` | ✅ 是 | ✅ 不抛 | `frame:false` |
| `win.setWindowButtonPosition({x:16,y:14}) | ✅ 是 | ✅ 不抛 | `frame:false` |
| `titleBarStyle:'hiddenInset'`（构造参数） | ✅ 构造接受不抛 | ✅ | **仅 `frame:true`** |

**结论**：方案 A 采用 `frame:false` 玻璃窗口，**应使用 `setWindowButtonPosition` + `setWindowButtonVisibility` 来显示/重定位交通灯**（这是 `frame:false` 下唯一可用且不抛异常的 API 组合）。`titleBarStyle` 只能配合 `frame:true` 使用，与透明/玻璃窗口形态冲突，故不采用。原始数据见 `raw/traffic-lights.json`。

---

## 7. 复现命令序列

> ⚠️ 环境前置条件（本机实测踩坑，必须照做）：
> 1. 本机 shell 泄漏了 `ELECTRON_RUN_AS_NODE=1`，会让 electron 误以 Node 模式运行 → 必须用 `env -u ELECTRON_RUN_AS_NODE` 启动。
> 2. macOS 沙箱权限不足会致 GPU 进程崩溃 → 已内置 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`（仅影响进程沙箱，不影响合成器本身）。
> 3. 经 shell 启动的 GUI 窗口会被 macOS 判为后台 → `document.hidden=true` 使 rAF 冻结（0Hz）。必须杀掉残留 electron 进程后用 AppleScript `tell application "Electron" to activate` 把窗口顶到前台（见 `run-visible.sh`）。G4 能跑到 ~120Hz 即证明可见性已稳住。

```bash
cd /Users/guhui/software/ai-project/work-buddy/database-app/spike/s1-glass-grid

# 依赖（仅本 spike 目录；不污染根 package.json）
npm init -y
npm i electron-window-glass@1.0.0

# 四组 FPS 测量（每组自动杀残留进程 + osascript 保活前台，跑到出 JSON 或 145s 超时）
bash run-visible.sh --group G1   # 透明 + 原生玻璃
bash run-visible.sh --group G2   # 透明无玻璃（隔离变量）
bash run-visible.sh --group G3   # 不透明对照
bash run-visible.sh --group G4   # 不透明 + 100 行（120Hz 上限校验）

# GPU 合成证据
bash run.sh --gpu        # 产出 raw/gpu-chrome.json（含 chrome://gpu 特性状态 + getGPUInfo）

# 交通灯 API 实测
bash run.sh --tl          # 产出 raw/traffic-lights.json

# 直接启动（不带 osascript 保活，仅调试用）
bash run.sh --group G3
```

原始数据：`raw/fps-G1.json` `raw/fps-G2.json` `raw/fps-G3.json` `raw/fps-G4.json` `raw/gpu-chrome.json` `raw/traffic-lights.json` `raw/run.log`。

---

## 8. 风险与建议

1. **S1 已拍板 A / D4 达成**，但建议真实网格组件（含图片/富样式单元格）落地前用同一探针做一次"重负载"复测，作为验收闸门——最小网格在 120Hz 下余量极大，不代表任意重单元格也如此。
2. **玻璃包必须是 ESM 加载**：产品代码的 `GlassProvider` 务必用 `import`/`await import` 引入 `electron-window-glass`，不要 `require`（会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。这是 S4 关心的"能否顺利集成"的实测结论。
3. 交通灯用 `setWindowButtonPosition` + `setWindowButtonVisibility`，不要碰 `titleBarStyle`（需 `frame:true`，与玻璃形态冲突）。
4. 降级路径（PRD §8.1.1）仍需保留：运行时若检测到网格 FPS < 50 自动关玻璃——本机未触发，但作为跨机型保险保留。
