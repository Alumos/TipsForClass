# 班级公告大屏 · 可运行试点版

默认 Windows 使用方式为**绑定后完全后台托盘待机 + 被动提醒浮层**。不显示常驻公告墙、公告卡或时钟；只有收到新消息或定时消息到点生效时才出现约 15 秒提醒：居中窗口约 760×480、正文大字，右上角浮窗约 460×300。提醒不抢课件焦点，默认鼠标穿透和设备语音静音，刷新或重连不补弹历史。浏览器预览连接同一个真实 Go API，但截图只能证明网页行为，不能证明 Windows 原生窗口尺寸、托盘、焦点或鼠标穿透。

## 本地启动

需要 Node.js 22.12+（当前构建在 Node 26 执行）。先按根目录说明启动 Go API，本地联调时把绑定表单里的服务地址改成 `http://127.0.0.1:8080/api/v1`；打包给班级使用的安装包默认填 `https://notice.alumos.cn/api/v1`，教师只需输入绑定码。

```sh
cd display
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，由小程序管理员生成 6 位绑定码后绑定。PIN 在绑定时设置为 6–12 位数字，无默认 PIN。忘记 PIN 需由管理员吊销设备、清除本机应用数据并重新绑定。

```sh
npm test
npm run build
npm run tauri:dev     # 需要本机安装 Rust
```

## Windows 构建与使用

桌面端已从 Electron 换成 Tauri 2，安装包约 30 MB（Electron 版为 138 MB）。

- 日常构建：`.github/workflows/tauri.yml`，推送到 main 覆盖 `tauri-latest` 测试通道
- 正式发布：推 `v*` 标签，生成 `Setup.<版本>.exe` 与 `SHA256SUMS.txt`
- 本地打包：`npm run tauri:build`，产物在 `src-tauri/target/release/bundle/nsis/`

安装包未做代码签名，Windows 可能提示 SmartScreen。WebView2 运行时通常随 Edge 预装，缺失时安装器会联网补齐；完全离线的机房可用 `WebView2 offline runtime` 工作流导出官方离线包。

页面来源是 `http://tauri.localhost`，因此服务端 `ALLOWED_ORIGINS` 必须包含它，否则绑定会报 `Failed to fetch`。

首次启动显示绑定界面，绑定成功自动收回托盘。已绑定后，启动、刷新和断线重连都保持完全后台待机，不显示常驻公告墙、公告卡或时钟。托盘菜单用于暂停/恢复提醒、进入维护设置和确认退出。新消息和定时生效消息按逐条选择的展示位置出现约 15 秒的非交互提醒：居中窗口约 760×480、正文大字，右上角浮窗约 460×300。提醒使用 `showInactive`，不可聚焦、鼠标穿透且不出现在任务栏。已有快照、刷新和断线重连不会补弹历史；只有新消息或明确重播的新 generation 可提醒一次。

两类提醒都直接显示公告正文，文本按纯文本渲染，不把关键内容截成必须另开界面才能查看的摘要。居中窗口使用大字正文并居中显示；右上角保持短时、易读的小浮窗。不得依赖常驻公告卡、自动轮换或自动公告墙承载内容；超长正文和名单需在约 15 秒的提醒窗口内完成可读性验收。

## 已实现的真实链路

- 绑定、快照、一次性 WS 票据、WS ready 后缓冲事件，再以快照水位切换；十进制 seq 用 BigInt 比较。
- 30 秒心跳，WS 断开暂停新语音；HTTP 降级快照每 60 秒恢复状态。服务端校时使用单调时钟，离线重启在校时前不展示姓名；断网 10 分钟后隐藏呼叫/名单。
- 快照/事件替换、撤回、到期、新 generation 中止旧播报。静默时段跳过，不补播；设备默认静音回执 `skipped/device_muted`。
- 播报账本按 epoch/message/generation/round 去重，最多两轮、轮次间隔 3 秒；崩溃时 playing 按 `crash_uncertain` 跳过。Windows 子进程使用受控 JSON stdin/stdout 和 requestId 完成回调，禁止 shell 拼接；中文语音缺失明确失败。浏览器仅提供标注的 Web Speech 中文预览回退。
- 回执先持久化再每批最多 50 条上报，成功后删除。同步接收只产生 received；真正可见的提醒浮窗经两帧渲染才发 displayed，学生点「已读」时补一次 displayed 后收起。
- 外壳换成 Tauri 2：业务引擎跑在主窗口的 WebView2 里，Rust 只负责窗口、托盘与语音。设备凭据与缓存存在 WebView2 的 localStorage（应用私有目录，未做系统级加密）；界面看不到 token。语音通过 `ClassroomTts.exe` 调用 Windows SAPI。
- 维护 PIN 使用随机盐 PBKDF2-SHA256，5 次错误锁定 60 秒，5 分钟无操作退出。暂停、开启语音、语音测试、重同步与确认解绑可用。

## 验证与交付边界

`npm test` 覆盖水位与缓冲撤回、重播 generation、快照不误报 displayed、回执批量上限、epoch 恢复、默认静音、崩溃账本、离线不播、撤回中断、静默时区、长文本换行、URL 校验、隐藏窗口回执与浮层提醒时长预算。`npm run build` 执行 `vue-tsc` 类型检查与 Vite 构建。

这是单校可运行 pilot，不声称完成生产增强。当前没有在 Windows 10/11 实机验证安装、中文声音、声卡变化、PPT 焦点、显示缩放和多屏。TTS 适配器源码在本次 macOS 开发环境未编译执行；缺失适配器时会显示明确能力状态并回执失败，不伪造 played。实际物理声音不保证恰好一次。

尚未交付生产签名、签名自动更新/回滚、自动登录启动配置、多显示器偏好、日志导出、缓存迁移演练和 72 小时稳定性报告。语音失败当前写明确 failed，不提供自动语音引擎重试；管理员可从教师端发起新 generation。Windows 使用前需运行真实 PPT/课件进行不抢焦点验收，并按学校设备情况安装中文语音。缓存包含学生资料，safeStorage 只保护凭据，不代表整个数据库加密。

依赖审计：移除 electron 与 electron-builder 后 `npm audit` 为 0 项。

浏览器回归需额外验证 UI 控制器保持非 Vue 深代理、绑定表单以普通对象跨 IPC、刷新历史不补弹、15 秒收起，以及维护操作不出现 structuredClone 未处理异常。核心状态机测试不能替代这类 UI 与原生焦点验证。
