#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export GOCACHE="${GOCACHE:-$project_root/.tools/go-build}"
export GOMODCACHE="${GOMODCACHE:-$project_root/.tools/go-mod}"
mkdir -p "$GOCACHE" "$GOMODCACHE"
echo '检查 Go 服务……'
(cd "$project_root/server" && go test ./... && go vet ./...)
echo '检查小程序结构与逻辑……'
node "$project_root/scripts/check-miniapp-structure.mjs"
(cd "$project_root/miniapp" && npm test)
echo '检查大屏……'
(cd "$project_root/display" && npm test && npm run build)
echo '检查完成。Windows 实机、微信开发者工具和真实微信配置仍需单独验收。'
