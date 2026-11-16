#!/usr/bin/env sh
# 一键启动：第一次会问几个问题生成配置，然后启动记忆代理。
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js。请先安装 18 以上的版本：https://nodejs.org （macOS 也可以 brew install node）"
  exit 1
fi
exec node bin/companion-memory.mjs start "$@"
