# Spike S1 — 方案 A 透明玻璃窗口 × 10000×20 虚拟滚动网格 120Hz FPS 探针

最小 FPS 探针（纯 HTML + 原生 JS，无 React/Vite），用于回答 PRD §8.1.1 决策树：
**方案 A 下，透明 + 原生 Liquid Glass 窗口里放 10000×20 虚拟滚动表格，120Hz 滚动 P50 多少？**

## 文件

- `main.mjs` — Electron 主进程（ESM）：按 `--group` 构造窗口、跑探针、抓 chrome://gpu、测交通灯。`await import('electron-window-glass')` 加载玻璃包。
- `index.html` / `renderer.js` — 虚拟滚动网格 + rAF FPS 采样。`renderer.js` 用 `require('electron')` 上报结果（主进程 `nodeIntegration:true`）。
- `run.sh` — 用根目录已装好的 Electron 44 二进制启动（自动 `env -u ELECTRON_RUN_AS_NODE`）。
- `run-visible.sh` — 启动后循环 `osascript activate` 把窗口顶到前台（绕过 macOS 把 shell 启动的 GUI 判为后台导致 rAF 冻结），跑到产出 JSON 或 145s。
- `raw/` — 原始数据：`fps-G1..G4.json`、`gpu-chrome.json`、`traffic-lights.json`、`run.log`。
- `RESULTS.md` — 结论（可直接贴总报告）。

## 运行

```bash
cd /Users/guhui/software/ai-project/work-buddy/database-app/spike/s1-glass-grid
npm init -y && npm i electron-window-glass@1.0.0   # 预编译原生模块，无需 rebuild

bash run-visible.sh --group G1   # 透明 + 玻璃
bash run-visible.sh --group G2   # 透明无玻璃
bash run-visible.sh --group G3   # 不透明对照
bash run-visible.sh --group G4   # 不透明 + 100 行（120Hz 上限校验）
bash run.sh --gpu                 # chrome://gpu 证据
bash run.sh --tl                  # 交通灯 API
```

## 关键环境坑（已在脚本/代码内处理）

1. 本机 shell 泄漏 `ELECTRON_RUN_AS_NODE=1` → 必须 `env -u ELECTRON_RUN_AS_NODE` 启动（见 `run.sh`）。
2. macOS 沙箱 → 主进程已加 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`。
3. shell 启动的 GUI 窗口会被 macOS 判后台 → `rAF` 冻结；`run-visible.sh` 用 `osascript 'tell application "Electron" to activate'` + 杀残留进程解决。
4. `electron-window-glass` 仅 ESM 导出 → 主进程必须是 `.mjs` 并用 `import`，CJS `require` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

## 测量方法

rAF 采样帧间隔 → 每帧 FPS=1000/Δt；程序化 `scrollTop` 递增覆盖全程（不靠人手拖）；5 轮 × ≥600 帧；P50/P95 取每帧 FPS 分布；掉帧率 = 帧间隔 >16.7ms 占比。滚动热路径零对象分配（固定行 DOM 池，仅改 `transform`/`textContent`）。
