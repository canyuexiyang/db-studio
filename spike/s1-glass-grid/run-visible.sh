#!/usr/bin/env bash
# 直接启动 electron（正确加载 main.js），用 AppleScript 反复 activate 把窗口置于前台，
# 直到产出 raw/fps-<group>.json 或超时（覆盖 benchmark 全程，处理可见性偶发后台化）。
# 用法：./run-visible.sh --group G4
set -u
ROOT=/Users/guhui/software/ai-project/work-buddy/database-app
HERE="$ROOT/spike/s1-glass-grid"
GROUP="${2:-G4}"
JSON="$HERE/raw/fps-$GROUP.json"
# 彻底清理所有 electron（主进程+helper），避免残留进程以 "Electron" 注册导致 osascript 激活到旧进程
pkill -9 -f "s1-glass-grid/main.js" 2>/dev/null || true
pkill -9 -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
pkill -9 -f "Electron Helper" 2>/dev/null || true
sleep 3
echo "remaining Electron procs: $(pgrep -f 'MacOS/Electron' | wc -l | tr -d ' ')"
rm -f "$JSON"
bash "$HERE/run.sh" "$@" &
APP_PID=$!
sleep 1.5
START=$(date +%s)
while [ ! -f "$JSON" ]; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -gt 145 ]; then echo "TIMEOUT waiting json"; break; fi
  osascript -e 'tell application "Electron" to activate' 2>/dev/null || true
  sleep 0.2
done
# 收尾：确保进程退出
kill "$APP_PID" 2>/dev/null || true
sleep 1
pkill -9 -f "s1-glass-grid/main.js" 2>/dev/null || true
echo "wrapper done; json exists=$([ -f "$JSON" ] && echo yes || echo no)"
