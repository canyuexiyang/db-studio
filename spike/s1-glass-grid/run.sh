#!/usr/bin/env bash
# S1 FPS 探针运行器。必须用根目录已装好的 electron 44 二进制启动；
# 注意：本机环境泄漏了 ELECTRON_RUN_AS_NODE=1，会让 electron 误以 node 模式运行，
# 必须 env -u 去掉。同时需要 --no-sandbox 等开关（见 main.js）。
set -u
ROOT=/Users/guhui/software/ai-project/work-buddy/database-app
EB="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
HERE="$ROOT/spike/s1-glass-grid"
env -u ELECTRON_RUN_AS_NODE "$EB" "$HERE/main.mjs" "$@"
