# 验证记录

验证日期：2026-10-22。文档版本：v1.6。环境：macOS ARM64、Go 1.27.3、Node.js 26.10.0、npm 11.19.1、Mac Chrome；远程构建使用 GitHub Actions。

## 结论

当前代码已通过仓库内自动化测试、构建、真实 HTTP/WebSocket 联调、Mac 浏览器页面检查以及 GitHub Actions 远程构建。`v0.1.1` Release 已发布，Windows 安装包和校验清单已实际下载并核对，GHCR 版本化镜像可读取。微信开发者工具/真机、Windows 10/11 物理机安装与焦点行为、真实 VPS 部署仍待目标环境验收；代码签名和平台审核也尚未完成。

## 三端自动构建与发布

| 配置 | 已写入仓库的内容 | 本文可确认的边界 |
| --- | --- | --- |
| `Project checks`（CI） | 执行 `./scripts/check.sh` 与 `node scripts/smoke.mjs` | `main` 与 `v0.1.1` 对应提交的远程运行均成功 |
| `Server image` | Docker Compose 构建、容器 `/healthz` 检查、推送 `ghcr.io/alumos/tipsforclass-api`、导出 Linux amd64 离线镜像包及 SHA-256 | 远程构建成功；`v0.1.1` 与 `latest` 标签已推送并可读取；离线包实装仍待 VPS 验证 |
| VPS 部署 | `compose.yaml` 持久卷与健康检查；可选 Caddy profile 提供 HTTPS/WSS 反代；支持 GHCR 或离线镜像 | 真实域名、DNS、ICP 备案、证书签发/续期和 VPS 实装仍待验收 |
| `Windows installer` | `windows-2022` 编译 TTS、测试 Electron、生成 x64 NSIS 与 `SHA256SUMS.txt`；推送 `v*` 标签生成 Release | `v0.1.1` 产物与 Release 已生成，实际下载校验通过；签名、物理机安装和更新回滚仍待验收 |

`v0.1.1` 的远程运行与可核验产物已经记录；真实 VPS、Windows 物理机和微信平台结果仍只接受对应目标环境的证据。

## 已通过

| 检查 | 结果与覆盖范围 |
| --- | --- |
| `./scripts/check.sh` | 成功退出；Go 测试与 `go vet` 通过 |
| 小程序检查 | 逻辑、模板结构、页面配置和事件处理器检查通过 |
| 大屏检查与构建 | 单元测试、Vue Web 构建与 Electron TypeScript 构建通过 |
| `node scripts/smoke.mjs` | 真实 HTTP/WebSocket 核心场景通过，使用隔离的临时 SQLite 数据库 |
| Mac Chrome 浏览器联调 | `1440×1000` 下验证后台待机、居中与右上角提醒的网页渲染、正文排版、约 15 秒隐藏、刷新不补弹历史及页面无脚本错误；居中正文约 30px，右上角正文约 22px；截图只证明浏览器页面行为 |
| GitHub Actions | `main` 提交 `58efb4d` 与 `v0.1.1` 标签的 `Project checks`、`Server image`、`Windows installer` 均成功 |
| Windows Release | 实际下载 `Setup.0.1.1.exe` 与 LF 换行的 `SHA256SUMS.txt`，`shasum -a 256 -c` 返回 `OK`；SHA-256 为 `b5e9df1bc80704f101cffa56194339ab9dbc5c11c762adb40310e715b13bd25a` |
| GHCR 镜像 | `docker manifest inspect ghcr.io/alumos/tipsforclass-api:v0.1.1` 成功返回镜像清单 |

协议联调覆盖登录与未授权拒绝、设备绑定码单次消费、设备/教室隔离、公告发布、幂等冲突、投递回执去重、重播、撤回、名册预检与幂等导入以及服务重启后的持久化恢复。仓库自动化还覆盖消息级展示位置、编辑时目标教室锁定、删除即撤回、置顶清理和审计保留。小程序测试使用 Node 执行项目逻辑和模板结构检查，不等同于微信官方编译或真机运行。

浏览器联调覆盖设备绑定、WebSocket 推送、默认静音、新消息浮层、实际展示回执、约 15 秒隐藏、刷新后恢复且不补弹旧公告、撤回，以及逐消息展示位置和共享置顶/排序设置。当前证据截图：

- `artifacts/qa/display-idle-no-board.png`：绑定后后台待机，没有常驻公告墙。
- `artifacts/qa/display-center-transient.png`：约 `760×480` 居中提醒，正文约 30px。
- `artifacts/qa/display-top-right-transient.png`：约 `460×300` 右上角提醒，正文约 22px，多人逐行显示。
- `artifacts/qa/display-settings.png`：PIN 维护页和默认静音开关。

截图来自浏览器预览，只能证明网页样式、可见/隐藏、刷新不补弹等页面行为。它不能证明 Windows 原生窗口实际为约 760×480/460×300、绑定后完全托盘待机，也不能证明不抢课件焦点和鼠标穿透；这些仍须在 Win10/11 物理机验收。

## 复现

在项目根目录运行：

```bash
./scripts/check.sh
node scripts/smoke.mjs
```

浏览器联调需要可用的 Playwright 和 Chrome；可用 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，用 `CHROME_EXECUTABLE` 指定浏览器可执行文件。若使用仓库脚本：

```bash
node scripts/browser-smoke.mjs
```

脚本会启动本地临时服务和浏览器；执行前确保所需端口可用。浏览器截图不能替代 Windows 原生尺寸、显示缩放、托盘和焦点验收；目标行为是居中约 760×480、正文大字，以及右上角约 460×300 小浮窗。

## 微信开发者工具与真机待验证

- 微信开发者工具正式编译、模拟器页面跳转和原生 API 行为。
- 真实微信登录、待审核/停用状态、内容安全接口与服务器域名配置。
- 大陆公网 API 的 ICP 备案、合法 HTTPS/WSS 域名和平台主体/类目核验。
- iOS/Android 上的字体、安全区、软键盘遮挡、大字号、弱网和空状态。
- 真实学生名册、不同表格工具导出的 XLSX，以及学校实际网络和平台提审流程。

## Windows 10/11 物理机待验证

- 安装、卸载、登录自启、标准用户、还原卡和系统策略。
- 已绑定后完全托盘待机，不显示常驻公告墙、公告卡或时钟；刷新、重启和重连不补弹历史。
- 居中约 760×480、正文大字的提醒，以及右上角约 460×300 的小浮窗；两者约 15 秒自动消失。
- 托盘退出、暂停/恢复、多显示器和缩放。
- PPT/WPS/浏览器课件/视频播放时，前台窗口句柄不变、键盘输入不中断、浮层区域鼠标穿透。
- 中文 TTS、默认静音、声卡切换、音频并发、静默时段和语音失败回执。
- NSIS 安装包的安装/卸载、代码签名、更新失败回滚和数据库升级恢复；下载与 SHA-256 校验已经通过。

## 尚未验证的运维边界

长时间稳定性、资源占用、并发容量、自动备份/异机恢复、签名分发和自动更新仍未完成验收。Compose/Caddy 与三端工作流配置不能替代真实 VPS 的 DNS、ICP 备案、证书签发/续期、容器启动、备份恢复或离线镜像导入记录，也不能替代 Windows 物理机安装与小程序审核。HTML 中的 72 小时、100 间教室、200 台设备等数字是验收目标，不是本次 Mac 测试结果。具体课堂设备步骤见 [Windows 课堂设备验收](windows-acceptance.md)。
