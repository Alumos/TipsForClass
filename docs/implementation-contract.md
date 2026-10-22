# 实现契约：本地可运行试点（文档 v1.4）

基线日期：2026-10-22。本文记录当前代码已经实现、客户端必须遵守的协议与行为，是文档、联调和验收的共同事实源。目标性能与 Windows 目标环境验证仍以 `docs/verification.md` 的边界为准。

## 协作范围

- 服务端：`server/**`，Go 后端、SQLite、REST + WebSocket 与测试。
- 小程序：`miniapp/**`，微信原生 JavaScript/WXML/WXSS，不使用 npm 前端构建。
- 大屏：`display/**`，Electron + Vue 3 + TypeScript/Vite，以及 Windows 适配层源码。
- 文档与联调：`docs/**`、`scripts/**`、根目录说明和跨端 QA。

本阶段是单校、单实例、可本地运行的试点。所有公告、权限和回执走真实 API，数据真实持久化。不得把本阶段描述为已完成生产加固、Windows 签名安装包或物理机验收。

## 交付范围

- 服务端默认通过显式 `APP_MODE=demo` 提供本机演示；生产模式要求真实微信配置与内容安全检查，不开放演示登录。
- 不提交 AppSecret、设备令牌或真实学生数据；示例名册与界面人物均为虚构。
- 当前交付覆盖登录审批、教室授权、班级与 XLSX 名册、设备绑定、三类公告、编辑、删除即撤回、重播、逐消息展示位置、共享置顶与排序设置、同步、投递回执和本地安装构建。
- 图片/视频公告、家校聊天、多租户计费、跨教室呼叫学生、自动更新回滚和生产长期运维不在本阶段完成范围内。

## API 通用契约

- API Base：`http://127.0.0.1:8080/api/v1`。
- 健康检查：`GET http://127.0.0.1:8080/healthz`，位于 API 前缀之外。
- 成功响应：`{code:0,message:"ok",data:...,requestId:"..."}`。
- 失败响应为非 2xx：`{code:"SYMBOLIC_ERROR",message:"中文可读",errors?:{},requestId:"..."}`。
- 标识使用字符串，时间使用 ISO 8601；同步事件序号使用十进制字符串比较。
- 教师与设备使用不同的 Bearer token。设备 WebSocket 连接先换取短期 ticket，不在 URL 中携带长期令牌。
- JSON 请求上限为 64 KiB；XLSX 名册上传走单独 multipart 路径并执行独立大小限制。

## 教师身份与教室

### 身份

- `POST /auth/demo-login`：仅 demo 模式可用，返回 `{token,teacher,expiresAt}` 和预置管理员。
- `POST /auth/wx-login`：用微信 `code` 换取会话；新教师默认为 `pending`，审批前不能读取名册或发布。
- `POST /auth/logout`：吊销当前会话。
- `POST /admin/setup`：生产首位管理员使用一次性引导码完成初始化；兼容入口 `POST /auth/activate-admin` 指向同一逻辑。
- `GET /me`：返回教师、学校、角色、状态、授权教室和当前模式。

教师状态为 `pending`（待审核）、`active`（已通过）或 `disabled`（停用）。审批统一写入 `active`，不使用 `approved`。

### 教室与名册读取

- `GET /rooms`：返回授权教室、设备数、在线数和最后在线时间。
- `GET /classes?roomId=1`：返回教室下班级。
- `GET /students?classId=1&q=&cursor=&limit=100`：返回分页学生；默认上限 100。
- 同一教室的多位授权教师共享该教室的班级、名册，以及置顶和消息顺序设置。每条消息的展示位置属于消息自身。每次请求都会重新检查教师当前状态与教室权限。

### 展示设置

`GET /rooms/:id/display-settings` 返回：

```json
{
  "roomId": "1",
  "displayPosition": "top_right",
  "position": "top_right",
  "pinnedMessageIds": ["1024", "1023"],
  "revision": 3,
  "messageOrder": ["1024", "1023", "1025"],
  "messages": []
}
```

当前小程序的展示排序页只展示并修改置顶标记和消息顺序。每条消息在发布、复制再发或编辑时单独选择 `displayPosition`；设备按消息自身的值选择浮层位置。

`PUT /rooms/:id/display-settings` 继续接受 `{displayPosition,pinnedMessageIds}`，同时兼容 `{roomId,position,messageOrder}` 别名。规则如下：

- 消息和旧接口中的 `displayPosition` 只能为 `top_right` 或 `center`。
- 教室级 `displayPosition` 只用于旧消息和旧客户端兼容，不能作为新消息的统一展示位置，也不由当前展示排序页修改。
- 置顶最多 50 条，必须唯一、当前有效、未过期且属于同一教室。
- `pinnedMessageIds` 的数组顺序就是置顶顺序；未置顶公告按 `createdAt DESC, id DESC`，即最新消息优先。
- 客户端任意提交的 `messageOrder` 不会覆盖服务端排序。
- 每次有效修改增加 `revision`，并在同一事务写入 `room.display` 事件。
- 同教室有权限的教师读取和修改同一份置顶与排序设置。

## 公告消息

`POST /messages` 创建公告，支持 `call`、`batch`、`notice` 三种类型：

| 类型 | 界面名称 | 教室 | 学生 |
| --- | --- | --- | --- |
| `call` | 呼叫学生 | 恰好 1 个 | 1–3 名 |
| `batch` | 作业布置 | 恰好 1 个 | 1–60 名 |
| `notice` | 普通通知 | 1–20 个 | 0 名 |

请求示例：

```json
{
  "clientToken": "4fce5625-852c-43ca-a26e-a416a47c83c2",
  "type": "call",
  "roomIds": ["12"],
  "studentIds": ["301"],
  "destination": "3 楼教师办公室",
  "body": "请带上班牌",
  "displayPosition": "top_right",
  "broadcastTimes": 0,
  "startAt": "2026-10-22T09:41:00+08:00",
  "expireAt": "2026-10-22T10:21:00+08:00"
}
```

创建规则：

- 呼叫与作业必须填写 `destination`；缺少时 API 返回 400。
- `displayPosition` 可省略，省略或旧消息缺少该字段时按 `top_right` 处理；显式值只能为 `top_right` 或 `center`。
- 呼叫与作业的 `title` 由服务端生成，客户端不能提交；标题不含学生姓名。
- 个人呼叫标题为 `呼叫 · 到 <destination>`。
- 多人作业标题为 `批量作业 · <count>人 · <destination>`。
- 学生姓名写入 `speechText` 和 `targets` 快照，用于展示与语音。
- 普通通知由教师填写标题和正文，不传学生。
- 小程序语音默认 `broadcastTimes: 0`；允许值为 0、1、2，设备语音还需本地明确开启。
- 标题最多 60 字、正文 300 字、地点 40 字；公告有效期不超过 7 天，定时开始不超过未来 7 天。
- 没有在线设备时服务端拒绝创建并返回可读提示。
- 首次创建返回 201；相同教师、`clientToken` 与规范化请求命中幂等时返回 200；同一 token 配不同内容返回 409 `IDEMPOTENCY_CONFLICT`。

消息响应包含 `destination`、`displayPosition`、`targets`、`speechText`、`roomIds`、`status`、`broadcast` 等字段。`title` 是服务端结果，`speechText` 才包含选中的姓名。

相关接口：

- `GET /messages?status=&roomId=&cursor=&limit=20`
- `GET /messages/:id`
- `GET /messages/:id/delivery`
- `POST /messages/:id/update`
- `DELETE /messages/:id`
- `POST /messages/:id/revoke`
- `POST /messages/:id/rebroadcast`

“已发布”只表示服务端已保存；“已上屏”必须由设备回执确认。编辑、撤回和重播增加 `revision`；重播同时产生新的 `generation`，不能与历史播放账本混淆。

编辑只允许 `active` 且未到期的公告。消息类型、内容、学生、地点、时间、播报次数和 `displayPosition` 可按接口规则修改，但原目标教室集合不可更改；提交不同的 `roomIds` 会返回 400。编辑成功后在同一事务写入 `message.upsert` 和 `message.update` 审计。

记录页“删除”调用 `DELETE /messages/:id`，服务端把状态改为 `revoked`、增加 `revision`、从各目标教室移除置顶，并写入 `message.revoked` 事件与 `message.revoke` 审计。消息本体和投递回执保留，可在“已撤回”记录中查看；`POST /messages/:id/revoke` 作为同一撤回逻辑的兼容入口。

## 管理接口

教师与教室修改同时提供小程序可调用的 POST 别名；PATCH 保留给其他兼容客户端。小程序必须使用 `POST /:id/update`。

### 教师与设备

- `GET /admin/teachers`：列出教师、角色、状态与授权教室。
- `POST /admin/teachers/:id/update`：修改姓名、角色或状态；兼容 `PATCH`。
- `PUT /admin/teachers/:id/rooms`：覆盖授权教室集合。
- `POST /admin/rooms`：创建教室。
- `POST /admin/rooms/:id/update`：修改或停用教室；兼容 `PATCH`。
- `POST /admin/rooms/:id/bind-codes`：生成 6 位、10 分钟有效、单次使用的绑定码。
- `GET /admin/devices`、`POST /admin/devices/:id/revoke`：查看与吊销设备。

### 班级

- `POST /admin/classes`：在指定教室创建班级。
- `POST /admin/classes/:id/update`：修改名称或换教室；兼容 `PATCH`。
- `DELETE /admin/classes/:id`：删除空班级。
- 修改班级所属教室时必须提交 `confirmImpact: true`；现有公告不会随班级自动迁移。
- 删除不存在的班级返回 404；班级仍有学生时返回 409 `CLASS_IN_USE`。
- 删除成功会同时清理尚未提交的名册预览并写审计记录。

### XLSX 名册

- `POST /admin/rosters/preview`：JSON 名册预检，保留给能够直接解析表格的客户端。
- `POST /admin/rosters/xlsx`：小程序上传 multipart 字段 `classId` 与 `file`，返回预检结果与短期 `importId`。
- `POST /admin/rosters/commit`：提交 `{importId}`，幂等写入新增和更新项。

XLSX 规则：

- 仅接受 `.xlsx`，最大 5 MiB。
- 最多 1000 行非空数据，单次至少 1 行。
- 默认读取首个工作表的前两列“学号、姓名”；也识别中英文表头别名。
- 学号按文本处理并保留前导零；公式不执行。
- 文件结构或行内容错误返回 400；文件过大返回 413。
- 预检不通过时不能提交；预览按管理员和班级隔离，24 小时过期。

### 设置

`GET/PUT /admin/settings` 管理学校名、时区和静默时段。试点固定 `Asia/Shanghai`；星期使用周一 1 至周日 7，拒绝无效范围与跨午夜时段。设置修改产生 `room.config` 事件。

## 设备同步

- `POST /devices/bind`：使用 `{bindCode,installationId,label}` 换取设备 token。
- `GET /device/snapshot`：返回当前及未来有效公告、教室设置、展示设置、同步水位和服务器时间。
- `POST /device/heartbeat`：每 30 秒上报在线、应用版本、TTS 状态、已应用序号和 `syncEpoch`。
- `POST /device/ws-ticket`：换取短期连接 ticket。
- `WS /ws/device?ticket=...`：先收到 `ready`，再接收 `message.upsert`、`message.replay`、`message.revoked`、`room.config`、`room.display` 或 `force.resync`。
- `POST /device/receipts`：批量上报接收、展示、撤回、过期、抑制和播报结果。

快照和实时消息都使用最新优先排序：置顶公告按 `pinnedMessageIds` 顺序在前，其他公告按 `createdAt DESC, id DESC`。服务端会清理已撤回或过期置顶，并通过 `room.display` 同步清理后的 revision。

## 可靠同步

设备先建立 WebSocket，收到 `ready` 后缓冲事件；随后在同一数据库事务中读取快照与水位，装载缓存后只重放 `seq > watermark` 的事件，再进入实时状态。提交公告、修改设置、写入事件必须在同一事务中完成，避免提交与广播之间的漏事件。

- 持久保存最后应用序号、消息 revision 和 `syncEpoch`。
- WebSocket 断开时按退避重连，并以 60 秒快照作为降级恢复。
- 心跳发现落后或 epoch 不一致时要求完整重新同步。
- 快照恢复和断线重连只更新列表，不补弹历史公告。
- `received` 与 `displayed` 分开记录；只有浮层或卡片实际可见时才发送 `displayed`。
- 一个服务实例只使用一个 SQLite writer；多实例部署不在本阶段范围。

## 客户端界面

### 小程序

- 使用原生 JavaScript/WXML/WXSS，直接由微信开发者工具导入，无需 npm 构建。
- 底部固定“班级 / 记录 / 我的”；管理员入口位于“我的”。
- 三种发布类型为“呼叫学生 / 作业布置 / 普通通知”。
- 首页点击教室卡片后，发布页固定该教室为当前目标；普通通知的“其他教室”列表排除当前教室，重复点击会提示“当前教室无需重复选择”。
- 呼叫学生与作业布置共用同一份已选学生状态。选中 1 人显示个人呼叫，选中 2–3 人显示多人呼叫；没有独立的“批量呼叫”入口。
- 发布和编辑页逐条选择“右上角浮窗”或“居中窗口”。展示排序页只管理置顶标记和消息顺序，不管理消息展示位置。
- 记录卡提供“详情 / 编辑 / 删除”。编辑页显示“目标教室（已锁定）”；删除即撤回，并保留审计和投递记录。
- 发布页保留表单错误、24 小时账号与教室范围内的草稿；超时重试复用同一 `clientToken`。
- tabbar 使用六枚 81×81 RGBA 图标，不引入额外组件库。
- 管理页可创建、编辑、移动和删除班级，上传 XLSX 名册，管理设备绑定和静默设置。

### 公告助手

- 浏览器预览运行在 `http://127.0.0.1:5173`，用于联调页面、浮层、回执和同步。
- Electron 启动后默认留在托盘；新公告按该消息自身的 `top_right` 或 `center` 显示短时浮层，旧消息缺少字段时回退为 `top_right`。
- Electron 源码使用 `showInactive()`、不可聚焦窗口和默认鼠标穿透；浮层默认约 15 秒后隐藏，不进入全屏、不修改系统音量。
- 主窗口可见时新提醒先排队，不自动覆盖课件；关闭主窗口后应用继续驻留托盘。
- 设备语音默认静音；只有本地明确开启且消息允许、非静默时段时才播报。
- 用户可主动从托盘打开公告列表、设置或手动公告墙；手动公告墙不会自动打开。
- 托盘提供暂停/恢复提醒和退出；恢复提醒不补弹暂停期间的旧公告。
- Windows 原生焦点、穿透、TTS、安装和卸载必须在真实 Win10/11 设备验收。

## 本地演示流程

1. 运行 `./scripts/dev-server.sh`，确认 `http://127.0.0.1:8080/healthz` 返回 ready。
2. 运行 `./scripts/dev-display.sh`，打开 `http://127.0.0.1:5173`。
3. 微信开发者工具导入 `miniapp/`，使用本地演示登录。
4. 在“我的 → 管理”生成绑定码，在浏览器预览绑定屏幕。
5. 发布通知、呼叫或作业，观察逐条展示位置、投递详情；在记录卡编辑或删除，确认编辑锁定目标教室、删除后进入“已撤回”。
6. 运行 `./scripts/check.sh` 与 `node scripts/smoke.mjs` 复核代码和协议。

演示数据库默认保存在 `server/data/notice.db`。测试脚本使用临时数据库，不覆盖正在使用的演示数据。

## 课堂后台使用优先修订

Windows 教室电脑通常同时运行 PPT、WPS、浏览器或视频。系统默认采用托盘后台和短时被动提醒，而不是 kiosk 全屏。浮层不得抢占前台窗口、键盘或鼠标，也不能最小化课件、修改系统音量或阻止休眠。完整公告墙仅供用户主动查看。

首次绑定和设置页面可由用户主动获得焦点；已绑定后的新公告只能驱动非激活浮层。Windows 的独占全屏、受保护桌面和锁屏场景不承诺覆盖，相关原生行为必须物理机验收。

## 原生小程序请求兼容

微信小程序对部分自定义方法支持有限，因此教师和班级修改使用显式 `POST /:id/update` 别名。PATCH 路由可以保留给其他客户端，但不得由当前小程序调用。新增接口必须同时检查服务端权限和当前教师状态，不能依赖客户端隐藏按钮。
