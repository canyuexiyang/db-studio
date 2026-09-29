# Spike S4 结论报告：Electron 44 + electron-window-glass 打包与签名（arm64）

> 验证性 Spike。实测日期：2026-09-21
> 环境：macOS 27.0 (build 26A428) / Apple M5 Pro 15核 / 48GB / arm64 / Electron 44.4.3

---

## 0. 一句话结论

**S4 通过 ✅。** `electron-window-glass@1.0.0` **自带 arm64 / x64 预编译 `.node` 产物，无需 rebuild、无需完整 Xcode**；打包成 .app 后原生模块能正常加载、玻璃降级路径（try/catch）不冒泡、ad-hoc 签名后正常启动。**没有出现 P5 担心的"无预编译产物需 node-gyp 重建"问题。**

---

## 1. 预编译产物核验（对应 P5）

| 项 | 实测结果 |
|---|---|
| 包版本 | `electron-window-glass@1.0.0`（全站仅 0.1.7 / 1.0.0 两个版本） |
| 预编译产物 | ✅ `dist/electron_window_glass.darwin-arm64.node`、`dist/electron_window_glass.darwin-x64.node` |
| 模块类型 | N-API（ABI 稳定） |
| **是否需要 rebuild** | **❌ 不需要**。`npm i` 后直接可用，未执行 `electron-rebuild` |
| 安装耗时 | ~4~5s（14 个依赖） |
| 是否需要完整 Xcode | ❌ 不需要（无 node-gyp 编译步骤） |

> **P5 风险已解除**：评审担心的"仅 2 个版本、需按 Electron 44 ABI 重建"未发生，因为包作者直接发布了双架构预编译 N-API 产物。

---

## 2. ⚠️ 关键集成约束（必须写进产品代码，否则必踩）

### 2.1 该包是 **ESM-only**，`require` 会直接抛错（S1 与 S4 独立复现两次）

包的 `package.json`：
```json
"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
```
**只声明了 `import`，没有 `require` 条件。** 因此：

- ❌ `require('electron-window-glass')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`
- ✅ `await import('electron-window-glass')` → 正常，导出 `{ WindowGlass, createWindowGlass }`

**产品落地要求**：`GlassProvider` 必须用 `await import()` 动态引入。若主进程是 CJS，需改用 `.mjs` 或 `import()` 语法。这条建议写进代码注释，防止后人改回 `require`。

### 2.2 玻璃应用结果（Darwin 27.0.0 实测）

```json
{ "glass_load": { "ok": true, "exports": ["WindowGlass", "createWindowGlass"] },
  "glass_apply": { "ok": true, "kind": "glass" } }
```

- 加载成功、应用成功，返回 `kind: 'glass'`
- `GlassProvider.applyTo()` 的 try/catch 包裹有效：异常不会冒泡到 `app.whenReady()`，`window_created: true`、`errors: []`

### 2.3 交通灯（frame:false 下）

| API | 可用 | 调用抛异常 |
|---|---|---|
| `win.setWindowButtonPosition({x,y})` | ✅ | 否 |
| `win.setWindowButtonVisibility(bool)` | ✅ | 否 |
| `titleBarStyle` 构造参数 | 仅 `frame:true` | —— |

→ 与 S1 结论一致：**方案 A 应采用 `setWindowButtonPosition` + `setWindowButtonVisibility`**。

---

## 3. 🔴 版本判断修正（重要，与评审文档不符）

`docs/engineering/TECH-REVIEW-v1.0.md` §3.2 与 `docs/archive/PRD-v0.4.md` §8.1 均写：

> "当前实测环境 macOS 27.0 (26A428) 对应的 Darwin 内核版本是 **26**，按 '27' 比较会判错"

**实测反驳**：

```
$ node -e "console.log(require('os').release())"
27.0.0
$ uname -r
27.0.0
```

本机的 `os.release()` 返回 **27.0.0**（Darwin **27**），不是 26。（`26A428` 是 **build 号**，不是 Darwin 内核版本——这里应该是把 build 号误当成了内核版本号。）

| 来源 | 声称 | 实测 |
|---|---|---|
| 评审文档 | Darwin 26 | ❌ |
| `os.release()` / `uname -r` | —— | ✅ **27.0.0** |

**影响与建议**：
- **判定阈值 `>= 26` 仍然安全**（27 ≥ 26 成立，玻璃能正常启用），本次未造成功能问题——降级路径也因此没被误触发，属于"错得幸运"。
- 但**文档事实必须更正**，否则后续按"Darwin 26"去推导 macOS 版本映射会一路错下去。
- 建议表述改为：**用 `os.release()` 取 Darwin 内核主版本，判断 `>= 26`；不要依赖 build 号推断，也不要假设 Darwin 主版本等于 macOS 市场版本减一。**（历史映射：macOS 15→Darwin 24、macOS 26→Darwin 25、macOS 27→Darwin 27。）
- 代码里**不要硬编码具体数字到比较之外的地方**，阈值集中定义为常量。

---

## 4. 打包结果

| 项 | 结果 |
|---|---|
| 打包工具 | electron-builder **26.15.3** |
| 目标 | `mac` / `arm64` / `dir` |
| asar | 开启（`compression: normal`，不用 maximum） |
| 签名 | ad-hoc（`identity: null`），**未做 Developer ID 签名**（本项目纯自用单机） |
| 产物 | `dist/mac-arm64/DB Studio.app` |
| **应用体积** | **288 MB** |
| asar 内含预编译产物 | ✅ `electron_window_glass.darwin-arm64.node` + `.darwin-x64.node` 均在包内 |
| electron-builder 是否触发 rebuild | ✅ 执行了 `@electron/rebuild`（`buildFromSource=false`），但因自带 N-API 产物**未实际编译** |
| **打包后启动验证** | ✅ **通过** |

**打包后运行实测结果**（`raw/packaged-result.json`）：

```json
{ "electron_version": "44.4.3", "node_version": "24.21.0", "chrome_version": "152.0.7977.130",
  "arch": "arm64", "darwin_release": "27.0.0",
  "glass_load": { "ok": true, "exports": ["WindowGlass", "createWindowGlass"] },
  "glass_apply": { "ok": true, "kind": "glass" },
  "traffic_lights": { "setWindowButtonPosition": true, "setWindowButtonVisibility": true, "call_error": null },
  "window_created": true, "errors": [] }
```

→ 打包后原生模块加载成功、玻璃应用成功、交通灯 API 可用、`errors: []` 证明 try/catch 降级路径**未触发且未冒泡**。**D4 在打包形态下完全可用。**

> 签名说明：v1.0 为纯自用单机，不分发 MAS / 不做公证（notarization）。ad-hoc 签名 + 首次右键打开即可，符合 PRD「不做登录/团队/云同步/License」的定位。若日后要分发，需补 Developer ID + 公证，这是独立事项。

---

## 5. 复现命令

```bash
cd spike/s4-package-sign

# 依赖（预编译产物自带，无需 rebuild）
npm i electron-window-glass@1.0.0
npm i -D electron-builder

# 未打包验证（先隔离"打包"这个变量）
env -u ELECTRON_RUN_AS_NODE \
  <repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .

# 打包
npx electron-builder --mac --arm64 --dir

# 打包后启动验证
env -u ELECTRON_RUN_AS_NODE dist/mac-arm64/DB\ Studio.app/Contents/MacOS/*
```

**环境坑（本机踩到，必须照做）**：
1. 本机 shell 泄漏了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以纯 Node 模式运行 → 必须 `env -u ELECTRON_RUN_AS_NODE`。
2. 脚本化启动时 macOS 沙箱初始化失败会导致 GPU 进程崩溃并触发 FATAL 退出 → 已加 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`。**这是测量环境问题，不影响打包链路本身。**

---

## 6. 给产品/排期的结论

1. **D4 无打包阻塞**：预编译产物齐备，S1 已判定方案 A 达成，工程可直接落地。
2. **成本修正**：评审预估的"若需 node-gyp 重建则 +1~2 天"**不发生**，D4 的打包成本可下调。
3. **必须修文档**：Darwin 版本判断那段（TECH-REVIEW §3.2、PRD §8.1）事实错误，建议按 §3 更正。
4. **代码约束**：`electron-window-glass` 只能 ESM 导入 —— 写进 `GlassProvider` 注释。
