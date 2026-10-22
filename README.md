# 教室公告双端系统

文档版本：v1.5；基线日期：2026-10-22。

教师通过微信原生小程序发布公告，Windows 公告助手绑定后完全在系统托盘后台待机，不显示常驻公告墙、公告卡或时钟。收到新消息或定时消息到点生效时，才按消息选择的展示方式出现约 15 秒提醒：居中窗口约 760×480 并使用大字正文，右上角浮窗约 460×300。提醒不抢课件焦点、默认鼠标穿透和设备语音静音，刷新或重连不补弹历史消息。Go 服务端负责身份权限、SQLite 持久化、REST/WebSocket 同步与投递回执。

当前状态为**可自动构建、待目标环境验收的试点**。GitHub Actions 已覆盖项目检查、Go 服务端 Docker 镜像和 Windows NSIS 安装包；微信开发者工具真机验收、微信审核与 Windows 10/11 物理机验收仍需在目标环境完成。开发说明见 [classroom-notice-dev-spec.html](classroom-notice-dev-spec.html)，实现事实与剩余边界见 [实现状态](docs/implementation-status.md)，验证证据见 [验证记录](docs/verification.md)。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| `server/` | Go 标准 HTTP 服务、SQLite、REST/WebSocket、权限与持久化 |
| `miniapp/` | 微信原生 JavaScript/WXML/WXSS 小程序，无 npm 前端构建 |
| `display/` | Vue 3 大屏浏览器预览与 Electron 桌面应用 |
| `scripts/` | 本地启动、结构检查、协议联调与浏览器测试 |
| `deploy/` | Caddy HTTPS 反向代理配置 |
| `.github/workflows/` | 项目检查、Docker 镜像和 Windows 安装包自动构建 |
| `docs/` | 第一次运行、生产部署、小程序发布、接口契约、实施状态与验收步骤 |

小程序底部为“班级 / 记录 / 我的”三个入口。发布页提供三种类型：

| 类型 | 范围 | 当前规则 |
| --- | --- | --- |
| 呼叫学生 | 1–3 名学生，一个教室 | 选 1 人显示个人呼叫，选 2–3 人显示多人呼叫；没有单独的“批量呼叫”入口 |
| 作业布置 | 1–60 名学生，一个教室 | 与呼叫学生共用已选学生状态 |
| 普通通知 | 1–20 个授权教室 | 不需要选择学生 |

呼叫与作业都要求填写地点。服务端生成 `呼叫 · 到 <地点>` 或 `批量作业 · <人数>人 · <地点>` 标题，标题不含学生姓名；姓名保存在 `speechText` 与目标快照中。语音默认 `broadcastTimes: 0`，需用户明确开启。

## 发布与记录

- 首页点击教室卡片后，发布页会把该教室固定为当前目标；普通通知的“其他教室”列表排除当前教室，重复点击当前教室会提示无需再次选择。
- 每条消息在发布和编辑时单独选择“右上角浮窗”或“居中窗口”。展示排序页只管理置顶标记和消息顺序；教室级 `displayPosition` 仅保留给旧消息和旧客户端兼容。
- 记录卡提供“详情 / 编辑 / 删除”。编辑时原目标教室保持锁定，服务端拒绝更改 `roomIds`；删除调用 `DELETE /messages/:id`，实际语义是撤回。
- 删除后消息从所有目标教室的有效列表移除，置顶被清理，状态改为 `revoked` 并写入 `message.revoke` 审计；消息与投递回执仍可在“已撤回”记录中查看。
- 同一教室的多位授权教师共享该教室的班级、名册，以及置顶和消息顺序设置。

## 本机启动

已安装 Go、Node.js 和 npm 后，在项目根目录打开两个终端。

终端一启动服务端：

```bash
./scripts/dev-server.sh
```

终端二启动大屏浏览器预览：

```bash
./scripts/dev-display.sh
```

本机地址固定如下：

- 健康检查：`http://127.0.0.1:8080/healthz`
- API 根地址：`http://127.0.0.1:8080/api/v1`
- 大屏浏览器预览：`http://127.0.0.1:5173`

两个终端都要保持运行。用微信开发者工具导入 `miniapp/`，选择本地演示登录，在“我的 → 管理”中生成绑定码，再到浏览器预览完成设备绑定。完整步骤见 [第一次运行教程](docs/first-run.md)。

演示管理员不需要真实微信认证，**只能在本机使用**，不能暴露到公网。真实微信登录还需要自己的 AppID、仅保存在服务端的 AppSecret、HTTPS API 域名与平台配置。

## 三端构建与发布

- **Go 服务端：**`Server image` 工作流用 Docker Compose 构建镜像、执行健康检查、推送到 GHCR，并上传可离线部署的镜像包。国内 VPS 的完整步骤见 [Docker Compose 部署](docs/deployment.md)。
- **Windows 大屏：**`Windows installer` 工作流在 `windows-2022` 编译中文 TTS 适配器、测试 Electron 并生成 x64 NSIS 安装包。推送 `v*` 标签时自动创建 GitHub Release；普通提交可从 Actions 运行记录下载 30 天有效的安装包。
- **微信小程序：**`Project checks` 工作流执行结构和逻辑测试。发布需要自己的 AppID、合法 HTTPS/WSS 域名、微信开发者工具上传、体验版测试和平台审核，步骤见 [微信小程序发布教程](docs/miniapp-release.md)。

首次部署前复制 `.env.production.example` 为 `.env` 并填写密钥。不要提交 `.env`、AppSecret、学生名册或生产数据库。

## 已自动验证

`./scripts/check.sh` 当前通过：

- Go 测试与 `go vet`；
- 小程序逻辑、模板结构、页面配置和事件处理器检查；
- 大屏测试及 Vue/Electron 构建。

`node scripts/smoke.mjs` 使用真实 HTTP/WebSocket 和临时 SQLite 数据库验证核心协议场景。Mac Chrome 在 `1440×1000` 下验证了后台待机、两种提醒位置的网页渲染、约 15 秒隐藏、刷新不补弹历史以及页面无脚本错误；居中正文约 30px，右上角正文约 22px。浏览器截图只证明网页行为；Windows 原生尺寸、完全托盘待机和焦点行为仍需 Win10/11 实机验收。具体结果与截图见 [验证记录](docs/verification.md)。

这些结果不能证明以下项目已完成：

- 微信开发者工具正式编译、真实微信登录、iOS/Android 真机与平台提审；
- Windows 10/11 物理机上的完全托盘待机、约 760×480/460×300 原生提醒尺寸、焦点不抢占、鼠标穿透、多显示器、TTS、安装包与卸载；
- 真实学校网络下的长期稳定性、容量、备份恢复、签名分发和自动更新。

## 三种运行阶段

- **本地演示：**本机 API、模拟教师身份和虚构名册，用于学习和联调。
- **微信开发测试：**自己的小程序 AppID、真实微信登录、服务端凭据与可访问域名。
- **学校部署：**正式服务器、账号审批、域名与资质、备份，以及 Windows 设备验收。

请先跑通本地演示，再配置真实微信身份。AppSecret 只能放在服务端，不要写入小程序、截图或聊天。

## 参考文档

- [第一次运行](docs/first-run.md)
- [Docker Compose 国内 VPS 部署](docs/deployment.md)
- [微信小程序发布教程](docs/miniapp-release.md)
- [实现契约](docs/implementation-contract.md)
- [实现状态](docs/implementation-status.md)
- [验证记录](docs/verification.md)
- [Windows 课堂设备验收](docs/windows-acceptance.md)
- [用户参考案例与待对齐项](docs/reference-case.md)
