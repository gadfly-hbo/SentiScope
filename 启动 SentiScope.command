#!/bin/bash
# SentiScope 一键启动（阶段 1，非常驻）
# 已在运行：直接打开管理界面；未运行：启动服务并自动唤起前端。
cd "$(dirname "$0")" || exit 1

if curl -sf -m 1 http://127.0.0.1:4180/health >/dev/null 2>&1; then
  echo "[SentiScope] 已在运行，直接打开管理界面。"
  open http://127.0.0.1:4180
  exit 0
fi

exec node scripts/start.mjs
