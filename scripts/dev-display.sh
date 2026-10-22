#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v npm >/dev/null 2>&1; then
  echo '未找到 Node.js/npm，请先安装当前受支持的 Node.js LTS。' >&2
  exit 1
fi
cd "$project_root/display"
if [[ ! -d node_modules ]]; then
  echo '首次启动，安装大屏依赖……'
  npm ci
fi
exec npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
