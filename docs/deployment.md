# 国内 VPS 部署：Docker Compose

本项目服务端是一个轻量 Go 进程，数据库使用 SQLite。生产试点只需一个 API 容器；启用内置 Caddy 后，再加一个 HTTPS 反向代理容器。数据保存在固定 Docker 卷 `tipsforclass-notice-data`，升级容器不会删除公告、教师、班级或设备数据。

## 1. 服务器与域名准备

建议配置：Ubuntu 22.04/24.04 x64、1–2 vCPU、1–2 GB 内存、20 GB 磁盘。实际容量和并发仍需按学校规模压测。

大陆服务器对外提供网站/API 前，域名通常需要完成 **ICP 备案**，并确认服务内容、主体资质和学校要求。微信小程序还要求 HTTPS，不能使用 IP、`localhost` 或自签名证书。

准备一个域名，例如 `notice.example.edu.cn`，为它添加指向 VPS 公网 IPv4 的 `A` 记录。确认 DNS 生效后再申请证书：

```sh
dig +short notice.example.edu.cn
```

安全组或防火墙至少放行 `22/tcp`、`80/tcp`、`443/tcp` 和 `443/udp`。Caddy 申请和续期证书需要 80/443 可达。

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

## 3. 获取代码与填写密钥

```sh
sudo mkdir -p /opt/tipsforclass
sudo chown "$USER":"$USER" /opt/tipsforclass
git clone https://github.com/Alumos/TipsForClass.git /opt/tipsforclass
cd /opt/tipsforclass
cp .env.production.example .env
chmod 600 .env
```

编辑 `.env`，至少完成以下项目：

```dotenv
APP_MODE=production
WECHAT_APP_ID=你的小程序AppID
WECHAT_APP_SECRET=你的小程序AppSecret
TOKEN_PEPPER=至少32字符的随机值
BOOTSTRAP_CODE=至少16字符的一次性初始化码
ALLOWED_ORIGINS=https://你的域名
NOTICE_DOMAIN=你的域名
```

生成两个服务端随机值：

```sh
openssl rand -hex 32
openssl rand -hex 16
```

第一条输出填入 `TOKEN_PEPPER`，第二条填入 `BOOTSTRAP_CODE`。`WECHAT_APP_SECRET` 必须与小程序 AppID 配套，并且只能放在服务端；不能写进小程序、Windows 安装包或 GitHub 源码。

`BOOTSTRAP_CODE` 只用于创建首位管理员。初始化完成后应保存到密码管理器中，不要发给普通教师。更换 `TOKEN_PEPPER` 会使现有教师会话和设备令牌失效。

## 4. 构建并启动

推荐在国内 VPS 上从源码构建，减少对境外镜像仓库的依赖：

```sh
cd /opt/tipsforclass
docker compose --profile proxy up -d --build
```

这会启动：

- `api`：Go 服务端，仅通过 Docker 网络和宿主机的 `127.0.0.1:8080` 暴露；
- `caddy`：监听公网 80/443，把 `/api/*`、`/ws/*`、`/healthz`、`/readyz` 转发给 API，并自动管理 HTTPS 证书。

首次启动检查：

```sh
docker compose ps
docker compose logs -f api
docker compose logs -f caddy
curl -fsS https://你的域名/healthz
```

正常响应应包含 `"ready":true` 和 `"mode":"production"`。如果证书失败，先检查 DNS、备案、80/443 端口和安全组；不要为了临时通过而关闭小程序 HTTPS 校验后正式发布。

如果暂时不使用域名，只启动本机 API：

```sh
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
```

这种模式只适合本机联调，不能作为小程序生产 API。

## 5. 使用 GitHub Actions 构建的镜像

仓库的 `Server image` 工作流会：

1. 使用 Docker Compose 构建服务端；
2. 以 demo 模式启动容器并检查 `/healthz`；
3. 推送 `ghcr.io/alumos/tipsforclass-api` 的提交 SHA、`latest` 和版本标签；
4. 上传可离线部署的镜像压缩包。

在 Actions 对应运行记录底部下载 `classroom-notice-api-linux-amd64-*`，上传 VPS 后：

```sh
docker load < classroom-notice-api-linux-amd64.tar.gz
docker compose --profile proxy up -d --no-build
```

压缩包同时包含提交 SHA 和 `latest` 两个标签；`.env` 保持默认 `IMAGE_TAG=latest` 即可直接启动。若希望锁定某次构建，可把 `IMAGE_TAG` 改为 Actions 中对应的提交 SHA，再执行同一启动命令。

当前 GHCR 包可直接匿名读取。生产部署建议在 `.env` 中把 `IMAGE_TAG` 固定到已验证版本，例如：

```dotenv
IMAGE_TAG=v0.1.1
```

然后拉取并启动：

```sh
docker compose pull api
docker compose --profile proxy up -d --no-build
```

`latest` 跟随 `main` 的最新成功构建；固定版本标签便于回滚。Actions 导出的离线镜像压缩包目前包含提交 SHA 和 `latest` 标签，使用离线包时保持 `IMAGE_TAG=latest`，或先给导入镜像补充与 `.env` 一致的标签。

若包保持私有，需要在 GitHub 创建至少具有 `read:packages` 权限的令牌：

```sh
echo '你的GitHub令牌' | docker login ghcr.io -u Alumos --password-stdin
```

国内 VPS 若无法稳定访问 GHCR，优先使用上面的“源码本地构建”或 Actions 导出的离线镜像。

## 6. 更新与回滚

更新源码并重新构建：

```sh
cd /opt/tipsforclass
git pull --ff-only
docker compose --profile proxy up -d --build
docker image prune -f
```

SQLite 数据卷不会随容器重建而删除。发布新版本前应先备份；数据库结构目前是试点版，没有成熟的自动降级迁移，回滚应用版本前先在测试库验证旧版本能否读取新库。

查看状态：

```sh
docker compose ps
docker compose logs --tail=200 api
docker stats --no-stream
```

## 7. 备份与恢复

备份时必须先停止 API，避免只复制到 WAL 中的半份事务。Caddy 可以继续运行：

```sh
cd /opt/tipsforclass
mkdir -p backups
docker compose stop api
docker run --rm \
  -v tipsforclass-notice-data:/data:ro \
  -v /opt/tipsforclass/backups:/backup \
  alpine:3.22 \
  sh -c 'tar -czf /backup/notice-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .'
docker compose --profile proxy start api
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
docker compose --profile proxy up -d --no-build
```

恢复旧数据库后，可在 `.env` 中设置一个新的 `SYNC_EPOCH` UUID 并重启，使所有大屏放弃旧水位重新同步。

## 8. 首次生产初始化

1. 在微信公众平台完成小程序合法域名配置。
2. 小程序使用生产 API 域名并关闭演示登录。
3. 首位管理员用真实微信登录，账号先进入待审核状态。
4. 调用首次初始化接口或使用页面提示，提交 `BOOTSTRAP_CODE` 与管理员姓名。
5. 创建教室和班级，导入 XLSX 学生名册。
6. 审批其他教师、分配教室权限。
7. 在小程序生成大屏绑定码，在 Windows 客户端绑定。
8. 使用虚构学生做发布、显示、撤回、重启和断网验收，再导入真实名册。

## 9. 上线前必须核对

- `.env` 没有提交到 Git，文件权限为 `600`；
- `APP_MODE=production`，演示登录不可用；
- 域名使用有效 HTTPS 证书，API 与 WSS 都可达；
- 小程序 AppID 与 `WECHAT_APP_ID` 一致；
- `TOKEN_PEPPER` 已随机生成并妥善保存；
- 首位管理员初始化后不再向他人传播 `BOOTSTRAP_CODE`；
- VPS 安全组没有把 `8080` 直接暴露到公网；
- 已配置数据库备份、磁盘告警和日志查看；
- 已按 [Windows 验收](windows-acceptance.md) 在真实课件环境测试；
- 已按 [小程序发布教程](miniapp-release.md) 完成体验版与审核。
