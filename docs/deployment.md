# 国内 VPS 部署：Docker Compose

本项目服务端是一个轻量 Go 进程，数据库使用 SQLite。生产试点只需一个 API 容器，HTTPS 由 CDN 或本机反代负责，compose 里不含代理。数据保存在固定 Docker 卷 `tipsforclass-notice-data`，升级容器不会删除公告、教师、班级或设备数据。

## 1. 服务器与域名准备

建议配置：Ubuntu 22.04/24.04 x64、1–2 vCPU、1–2 GB 内存、20 GB 磁盘。实际容量和并发仍需按学校规模压测。

大陆服务器对外提供网站/API 前，域名通常需要完成 **ICP 备案**，并确认服务内容、主体资质和学校要求。微信小程序还要求 HTTPS，不能使用 IP、`localhost` 或自签名证书。

准备一个域名，例如 `notice.example.edu.cn`，为它添加指向 VPS 公网 IPv4 的 `A` 记录。确认 DNS 生效后再申请证书：

```sh
dig +short notice.example.edu.cn
```

安全组至少放行 `22/tcp` 和 API 端口 `18080/tcp`。走 CDN 回源时不需要开 80/443；只有在本机直接申请 Let's Encrypt 证书时，才需要放行 `80/tcp`、`443/tcp` 和 `443/udp`。

## 2. 安装 Docker

Ubuntu 可先尝试系统仓库：

```sh
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

退出并重新登录后检查：

```sh
docker version
docker compose version
```

若发行版没有 `docker-compose-v2` 包，请按 Docker 官方文档安装 Docker Engine 和 Compose 插件。国内网络若访问 Docker Hub 不稳定，可使用 VPS 厂商提供的、经过核验的镜像加速配置；不要使用来源不明的公共镜像源。

## 3. 准备 compose.yaml

服务器上只需要一个 `compose.yaml`，不用克隆仓库，也不用建 `.env`：所有变量都写在 `environment` 里。

```sh
sudo mkdir -p /opt/tipsforclass
cd /opt/tipsforclass
# 本地改好 compose.yaml 后上传：
# scp compose.yaml root@服务器IP:/opt/tipsforclass/
```

启动前把三个 `changeme` 换成真实值：

```dotenv
WECHAT_APP_SECRET: 小程序后台 → 开发管理 → 开发设置 → 重置后复制
TOKEN_PEPPER: openssl rand -hex 32
BOOTSTRAP_CODE: openssl rand -hex 16
```

`WECHAT_APP_ID` 已填好。`WECHAT_APP_SECRET` 只能放在服务端，不能写进小程序或 Windows 安装包；`TOKEN_PEPPER` 更换后所有教师会话和设备令牌失效；`BOOTSTRAP_CODE` 只在创建首位管理员时用一次，之后不要再外传。

这份文件含密钥：服务器上保留真实值，**不要 push 到公开仓库**，仓库里保持 `changeme` 占位。

## 4. 启动

compose 默认使用 GitHub Actions 构建好的成品镜像，不在服务器上编译源码，只启动 API，通过高位端口对外提供 HTTP：

```sh
cd /opt/tipsforclass
docker compose up -d
curl -fsS http://127.0.0.1:18080/healthz
```

正常响应应包含 `"ready":true` 和 `"mode":"production"`。端口由 `compose.yaml` 的 `ports` 控制（默认 18080），容器内始终监听 8080。

服务端只提供 API，没有首页：浏览器直接打开 `http://IP:18080/` 会看到纯文本 `404 page not found`，这是正常的，说明容器已经在响应请求。判断是否健康请看 `/healthz`，不要看根路径。

### 4.0 从 0.1.x 升级到 0.2 必须清空数据

0.2 去掉了「教室」实体，班级直接归属学校，数据库结构 `user_version` 从 2 变成 3。`schema.sql` 只做 `CREATE TABLE IF NOT EXISTS`，**不会改造旧表**。用旧库启动会被拦下并报：

```
数据库结构版本为 2，当前程序需要版本 3；请清空数据后重启
```

确认可以丢弃数据后执行（`-v` 会删除命名卷，公告、教师、设备、名册全部清空）：

```sh
docker compose down -v
docker compose pull
docker compose up -d
```

清空后需要重新走一次首次初始化：微信登录 → 用 `BOOTSTRAP_CODE` 激活管理员 → 建班级 → 导名册 → 生成绑定码。旧版 Windows 大屏和体验版小程序也必须一起升级，否则字段对不上。

拉取 GHCR 慢或超时，改用 Actions 运行记录底部下载的离线镜像包：

```sh
docker load < classroom-notice-api-linux-amd64.tar.gz
docker compose up -d
```

更新版本：

```sh
docker compose pull && docker compose up -d
```

### 4.1 外网无端口 HTTPS：备案域名 + CDN 回源

微信服务器域名只认 `https://域名`，不接受 IP 和 `http`。端口其实可以配（`https://域名:16666` 能保存也能用），但校园网出口经常只放行 80/443，一旦用了高位端口，就会出现“办公室能开、教室打不开”的现场故障。所以正式使用时，让外部访问回到标准 443：**备案域名 + CDN + HTTP 回源到 18080**。

前置条件：加速域名必须是已备案域名。主域名已备案时，子域名可直接接入，不用重新备案。

以 EdgeOne 为例（其他 CDN 配置项名称不同，逻辑一样）：

1. **加速域名**：填 `notice.example.com`，加速区域选“全球（含中国大陆）”，未备案域名只能选境外节点。
2. **源站**：类型选 `IP/域名`，填 VPS 公网 IP；回源协议选 **HTTP**；回源端口填 **18080**。官方文档写明回源端口不限制，只需源站该端口可连通（默认才是 80/443）。
3. **回源 HOST**：用加速域名即可，Go 服务不校验 Host。
4. **缓存**：`/api/*`、`/ws/*`、`/healthz`、`/readyz` 全部设为**不缓存**。开了缓存会出现“换了账号还是旧数据”“发布后大屏看到上一条”这类难查的问题。
5. **网络优化**：开启 **WebSocket**（大屏长连接必须），开启“客户端 IP 头部”并保持默认的 `EO-Client-IP`，否则服务端日志里全是节点 IP。
6. **HTTPS**：控制台申请免费证书并自动续期，绑定 443。外部访问就是 `https://notice.example.com`，无端口。
7. **DNS**：把 `notice.example.com` CNAME 到 CDN 分配的地址，等状态变成已生效。

接入后改两处，即可与域名对齐：

```yaml
environment:
  ALLOWED_ORIGINS: "https://notice.example.com,http://tauri.localhost,tauri://localhost"
ports:
  - "18080:8080"
```

小程序后台 `request 合法域名` 填 `https://notice.example.com`，**不带端口**——不带端口时请求 URL 里也不能出现端口，包括 `:443`，否则校验直接失败；`socket 合法域名` 填 `wss://notice.example.com`，wss 不校验端口。

**收一下暴露面**：HTTP 回源意味着 CDN 到源站这一段是明文，18080 不要对全网开放。安全组只放行 CDN 回源网段，或在规则引擎加一个自定义回源 Header，源站只接受带该 Header 的请求。

回源不通按顺序排查：安全组是否放行 18080 → `curl -H 'Host: notice.example.com' http://127.0.0.1:18080/healthz` 是否正常 → CDN 后台回源协议和端口是否填错。CDN 报 522 是 TCP 连不上源站，524 是连上了但响应超时。

### 4.2 不用 CDN 时：本机反向代理

没有 CDN、又有固定公网 IP 时，也可以在本机加一层反代，并把 `ports` 改成 `127.0.0.1:18080:8080`：

- Caddy：把 `deploy/Caddyfile` 复制到 `/etc/caddy/Caddyfile`，用 `NOTICE_DOMAIN=你的域名 caddy run --config Caddyfile` 启动，证书自动申请；
- nginx：用 `deploy/nginx-notice.conf` 的片段，`proxy_pass` 指向 `127.0.0.1:18080`。

两者都要求域名已完成备案并解析到本机，否则 Let's Encrypt 的 HTTP-01 验证会被阻断，证书申请不下来。

## 5. 使用 GitHub Actions 构建的镜像

仓库的 `Server image` 工作流会：

1. 构建服务端镜像；
2. 以 demo 模式启动容器并检查 `/healthz`；
3. 推送 `ghcr.io/alumos/tipsforclass-api` 的提交 SHA、`latest` 和版本标签；
4. 上传可离线部署的镜像压缩包。

`compose.yaml` 默认就用这个镜像，直接启动即可：

```sh
docker compose pull && docker compose up -d
```

在 Actions 运行记录底部下载 `classroom-notice-api-linux-amd64-*.tar.gz` 时，走离线方式：

```sh
docker load < classroom-notice-api-linux-amd64.tar.gz
docker compose up -d
```

压缩包同时包含提交 SHA 和 `latest` 两个标签，`image` 保持 `:latest` 即可直接启动。想锁定某次构建，把 compose.yaml 的 `image` 改成对应版本标签：

```yaml
image: ghcr.io/alumos/tipsforclass-api:v0.1.1
```

当前 GHCR 包可直接匿名读取。若包改为私有，需要至少具有 `read:packages` 权限的令牌：

```sh
echo '你的GitHub令牌' | docker login ghcr.io -u Alumos --password-stdin
```

国内 VPS 若无法稳定访问 GHCR，优先使用 Actions 导出的离线镜像。

`latest` 跟随 `main` 的最新成功构建；固定版本标签便于回滚。Actions 导出的离线镜像压缩包包含提交 SHA 和 `latest` 标签，使用离线包时保持 `:latest`，或先给导入的镜像补上与 `image` 一致的标签。

若包保持私有，需要在 GitHub 创建至少具有 `read:packages` 权限的令牌：

```sh
echo '你的GitHub令牌' | docker login ghcr.io -u Alumos --password-stdin
```

国内 VPS 若无法稳定访问 GHCR，优先使用上面的“源码本地构建”或 Actions 导出的离线镜像。

## 6. 更新与回滚

拉取新镜像并重建容器：

```sh
cd /opt/tipsforclass
docker compose pull
docker compose up -d
docker image prune -f
```

回滚时把 `compose.yaml` 的 `image` 改成上一个已验证的版本标签，再执行同样两条命令。

SQLite 数据卷不会随容器重建而删除。发布新版本前应先备份；数据库结构目前是试点版，没有成熟的自动降级迁移，回滚应用版本前先在测试库验证旧版本能否读取新库。

查看状态：

```sh
docker compose ps
docker compose logs --tail=200 api
docker stats --no-stream
```

## 7. 备份与恢复

备份时必须先停止 API，避免只复制到 WAL 中的半份事务：

```sh
cd /opt/tipsforclass
mkdir -p backups
docker compose stop api
docker run --rm \
  -v tipsforclass-notice-data:/data:ro \
  -v /opt/tipsforclass/backups:/backup \
  alpine:3.22 \
  sh -c 'tar -czf /backup/notice-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .'
docker compose start api
```

备份含教师、学生、设备凭据摘要和公告数据，应加密保存并限制访问。定期在另一台机器做恢复演练。

恢复会覆盖现有数据库，只能在确认备份正确且接受数据回退时执行：

```sh
docker compose stop api
docker run --rm \
  -v tipsforclass-notice-data:/data \
  -v /opt/tipsforclass/backups:/backup:ro \
  alpine:3.22 \
  sh -c 'rm -rf /data/* && tar -xzf /backup/替换为备份文件名.tar.gz -C /data'
docker compose up -d
```

恢复旧数据库后，可在 `compose.yaml` 的 `environment` 中加一个新的 `SYNC_EPOCH` UUID 并重启，使所有大屏放弃旧水位重新同步。

## 8. 首次生产初始化

1. 在微信公众平台完成小程序合法域名配置（需要 HTTPS 域名，见 4.1）。
2. 小程序使用生产 API 域名并关闭演示登录。
3. 首位管理员用真实微信登录，账号先进入待审核状态。
4. 调用首次初始化接口或使用页面提示，提交 `BOOTSTRAP_CODE` 与管理员姓名。
5. 创建教室和班级，导入 XLSX 学生名册。
6. 审批其他教师、分配教室权限。
7. 在小程序生成大屏绑定码，在 Windows 客户端绑定。
8. 使用虚构学生做发布、显示、撤回、重启和断网验收，再导入真实名册。

## 9. 上线前必须核对

- `compose.yaml` 里的 `WECHAT_APP_SECRET`、`TOKEN_PEPPER`、`BOOTSTRAP_CODE` 均已替换，且没有提交到公开仓库；
- `APP_MODE=production`，演示登录不可用；
- 启用 HTTPS 时，域名证书有效，API 与 WSS 都可达；
- 小程序 AppID 与 `WECHAT_APP_ID` 一致；
- `TOKEN_PEPPER` 已随机生成并妥善保存；
- 首位管理员初始化后不再向他人传播 `BOOTSTRAP_CODE`；
- 清楚 HTTP 直连只用于自测：明文端口不要长期承载真实学生信息；
- 接入 CDN 时，`/api`、`/ws` 已设为不缓存，WebSocket 已开启，18080 未对全网开放；
- 已配置数据库备份、磁盘告警和日志查看；
- 已按 [Windows 验收](windows-acceptance.md) 在真实课件环境测试；
- 已按 [小程序发布教程](miniapp-release.md) 完成体验版与审核。
