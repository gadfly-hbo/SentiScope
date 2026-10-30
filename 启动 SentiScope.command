#!/bin/bash
# SentiScope 切片一：双击启动（阶段 1，非常驻，Ctrl+C 或关窗停止）
cd "$(dirname "$0")" || exit 1
node scripts/start.mjs
