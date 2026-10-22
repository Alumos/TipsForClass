#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v go >/dev/null 2>&1; then
  echo '未找到 Go。macOS 可运行 brew install go，然后重新启动。' >&2
  exit 1
fi
cd "$project_root/server"
export APP_MODE=demo
export HTTP_ADDR="${HTTP_ADDR:-127.0.0.1:8080}"
export DATABASE_PATH="${DATABASE_PATH:-$project_root/server/data/notice.db}"
export GOCACHE="${GOCACHE:-$project_root/.tools/go-build}"
export GOMODCACHE="${GOMODCACHE:-$project_root/.tools/go-mod}"
mkdir -p "$project_root/server/data" "$GOCACHE" "$GOMODCACHE"
printf '启动本地演示服务：http://%s\n' "$HTTP_ADDR"
echo '演示模式允许本机模拟管理员登录；不要把此服务暴露到互联网。按 Ctrl+C 停止。'
exec go run ./cmd/server
