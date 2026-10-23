# Tauri 外壳（实验阶段）

这里是把 Electron 换成 Tauri 2 的骨架，目标是安装包从 138 MB 降到 10 MB 量级。

## 现状

- **已就绪**：托盘菜单（打开/暂停/退出）、主窗口、透明置顶提醒窗口、鼠标穿透、
  单实例、语音适配器调用、`cargo check` 通过。
- **已接线**：`src/tauri/bridge.ts` 提供与 Electron 相同的 `window.classroom` 契约，
  引擎跑在主窗口 WebView2 里，提醒窗口收到 `overlay-payload` 后渲染，回执经主窗口转发。
- **待验收**：鼠标穿透、不抢焦点、语音出声、托盘暂停这四件事只能在 Windows 真机上确认。
- Electron 版本仍是唯一的正式发布路径，`Windows installer` 工作流不受影响。

## 为什么不是简单替换

Electron 里业务引擎跑在主进程（Node），Tauri 没有 Node。所以换壳要连带调整：

1. 引擎移到主窗口的 WebView2 里跑（它只用 fetch / WebSocket / crypto.subtle，都支持）；
2. 提醒的弹出策略（收到新消息 → 算位置 → 显示浮层 → 回执）从 `electron/main.ts` 搬到前端；
3. 设备令牌的存储从 sql.js + safeStorage 换成 WebView2 的 localStorage；
4. 语音改成调用 Rust 侧的 `speech_play`，内部仍然拉起 `ClassroomTts.exe`。

## 命令

```sh
cd display
npm run build                     # 先生成 dist/
npx --yes @tauri-apps/cli@^2 dev  # 本机调试（需要 Rust）
npx --yes @tauri-apps/cli@^2 build
```

Windows 打包走 `.github/workflows/tauri.yml`，手动触发，产物在 Actions 的 Artifacts 里。

## 已知风险

- WebView2 运行时：安装器用 `embedBootstrapper`，引导程序（约 1.8 MB）已内嵌，但运行时本身仍要从微软 CDN 下载。
  Win11 与装了新 Edge 的 Win10 一般已自带；机房断网时用 `.github/workflows/webview2-offline.yml`
  导出官方离线运行时，U 盘拷过去手工装一次即可。
- 隐藏到托盘后 WebView2 可能节流定时器，影响心跳；上线前要设置
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-background-timer-throttling` 并实测。
- 透明窗口在 Windows 上首帧可能闪烁，需要真机调。
