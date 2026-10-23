#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 班级公告大屏 · Tauri 外壳
//!
//! 只负责窗口、托盘与语音三件事；业务引擎仍然跑在前端（Vue + TS），
//! 通过统一的 window.classroom 契约与这里通信，所以 App.vue 不需要改。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, Wry,
};

/// 轻量日志：只记窗口动作，不记公告内容。
/// 位置：%APPDATA%\school.classroom.notice\overlay.log
fn trace(message: &str) {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let dir = std::path::Path::new(&appdata).join("school.classroom.notice");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("overlay.log"))
    {
        let _ = writeln!(file, "{stamp} {message}");
    }
}

/// 最近一次提醒载荷。提醒窗口可能在页面加载完成前就收到事件，
/// 因此缓存一份，供窗口挂载后补拉。
#[derive(Default)]
struct OverlayCache(Mutex<Option<String>>);

/// 常驻的 .NET 语音适配器。沿用现有实现，避免这次换壳引入语音回归。
struct Speech {
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<BufReader<ChildStdout>>>,
    capability: Mutex<String>,
}

impl Speech {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            reader: Mutex::new(None),
            capability: Mutex::new("unknown".into()),
        }
    }
}

fn executable_root(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("windows-tts").join("ClassroomTts.exe"));
    }
    if let Ok(dir) = std::env::current_dir() {
        candidates.push(dir.join("../windows-tts/bin/publish/ClassroomTts.exe"));
        candidates.push(dir.join("windows-tts/bin/publish/ClassroomTts.exe"));
    }
    candidates
}

fn tts_path(app: &AppHandle) -> Option<PathBuf> {
    executable_root(app).into_iter().find(|path| path.exists())
}

fn spawn_speech(app: &AppHandle, speech: &Speech) -> Result<(), String> {
    if cfg!(not(windows)) {
        *speech.capability.lock().unwrap() = "not_windows_no_native_tts".into();
        return Err("当前系统没有 Windows 语音适配器".into());
    }
    let path = tts_path(app).ok_or("未找到语音适配器 ClassroomTts.exe")?;
    let mut child = Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("语音适配器启动失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("语音适配器没有输出通道")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let capability = if reader.read_line(&mut line).is_ok() {
        match serde_json::from_str::<serde_json::Value>(line.trim()) {
            Ok(value) if value["event"] == "ready" => {
                if value["chineseVoices"].as_i64().unwrap_or(0) > 0 {
                    "windows_zh_ready"
                } else {
                    "windows_no_chinese_voice"
                }
            }
            _ => "windows_adapter_unknown",
        }
    } else {
        "windows_adapter_unavailable"
    };
    *speech.capability.lock().unwrap() = capability.into();
    *speech.child.lock().unwrap() = Some(child);
    *speech.reader.lock().unwrap() = Some(reader);
    Ok(())
}

#[tauri::command]
fn speech_status(app: AppHandle, speech: tauri::State<Speech>) -> String {
    let capability = speech.capability.lock().unwrap().clone();
    if capability == "unknown" {
        let _ = spawn_speech(&app, &speech);
        return speech.capability.lock().unwrap().clone();
    }
    capability
}

#[tauri::command]
fn speech_play(app: AppHandle, speech: tauri::State<Speech>, text: String) -> Result<(), String> {
    if text.is_empty() || text.chars().count() > 800 {
        return Err("无效播报文本".into());
    }
    if speech.child.lock().unwrap().is_none() {
        spawn_speech(&app, &speech)?;
    }
    if *speech.capability.lock().unwrap() != "windows_zh_ready" {
        return Err("Windows 中文语音不可用".into());
    }
    let request_id = uuid_like();
    let command = serde_json::json!({"command":"speak","requestId":request_id,"text":text});
    {
        let mut child = speech.child.lock().unwrap();
        let process = child.as_mut().ok_or("语音适配器不可用")?;
        let stdin = process.stdin.as_mut().ok_or("语音适配器不可写")?;
        writeln!(stdin, "{command}").map_err(|_| "写入语音指令失败")?;
        stdin.flush().map_err(|_| "写入语音指令失败")?;
    }
    let mut reader_guard = speech.reader.lock().unwrap();
    let reader = reader_guard.as_mut().ok_or("语音适配器不可用")?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut line = String::new();
    loop {
        if Instant::now() > deadline {
            return Err("语音播放超时".into());
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                *speech.child.lock().unwrap() = None;
                *speech.capability.lock().unwrap() = "windows_adapter_unavailable".into();
                return Err("语音适配器已退出".into());
            }
            Ok(_) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    if value["requestId"] == request_id.as_str() {
                        return match value["event"].as_str() {
                            Some("completed") => Ok(()),
                            _ => Err("Windows 语音失败".into()),
                        };
                    }
                }
            }
            Err(_) => return Err("读取语音状态失败".into()),
        }
    }
}

#[tauri::command]
fn speech_stop(speech: tauri::State<Speech>) {
    if let Some(child) = speech.child.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{{\"command\":\"stop\"}}");
            let _ = stdin.flush();
        }
    }
}

#[tauri::command]
fn overlay_show(
    app: AppHandle,
    cache: tauri::State<OverlayCache>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    payload: String,
) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or_else(|| {
        trace("overlay_show: 找不到 overlay 窗口");
        "提醒窗口不存在"
    })?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| {
        trace(&format!("overlay_show: show 失败 {error}"));
        error.to_string()
    })?;
    trace(&format!("overlay_show: 已显示 {width}x{height} @ {x},{y}"));
    *cache.0.lock().unwrap() = Some(payload.clone());
    window
        .emit("overlay-payload", payload)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn overlay_payload(cache: tauri::State<OverlayCache>) -> Option<String> {
    cache.0.lock().unwrap().clone()
}

#[tauri::command]
fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn overlay_visible(app: AppHandle) -> bool {
    app.get_webview_window("overlay")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}


#[tauri::command]
fn main_visible(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 提醒窗口渲染完成后回报，转给主窗口写投递回执。
#[tauri::command]
fn overlay_displayed(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    app.emit_to("main", "overlay-displayed", ids)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle, settings: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if settings {
            let _ = window.emit("classroom-settings", ());
        }
    }
}

#[tauri::command]
fn hide_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn tray_menu(app: &AppHandle, autostart: bool) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", "打开设置与维护", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停提醒", true, None::<&str>)?;
    let label = if autostart {
        "开机自启：已开启"
    } else {
        "开机自启：已关闭"
    };
    let autostart_item = MenuItem::with_id(app, "autostart", label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &autostart_item, &quit])
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 绑定成功后由前端调用，让教室机重启后自动回到托盘待机。
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> bool {
    let applied = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    applied.is_ok() && app.autolaunch().is_enabled().unwrap_or(false) == enabled
}

fn build_overlay(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("班级提醒")
        .inner_size(476.0, 338.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

fn main() {
    // 隐藏到托盘后 WebView2 会节流定时器，心跳和回执会被拖慢甚至停摆。
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(Speech::new())
        .manage(OverlayCache::default())
        .setup(|app| {
            let handle = app.handle().clone();
            build_overlay(&handle)?;

            let autostart = app.autolaunch().is_enabled().unwrap_or(false);
            let menu = tray_menu(&handle, autostart)?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("缺少应用图标".into()))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("班级公告 · 大屏待机")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app.clone(), true),
                    "pause" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("classroom-toggle-pause", ());
                        }
                    }
                    "autostart" => {
                        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                        let _ = if enabled {
                            app.autolaunch().disable()
                        } else {
                            app.autolaunch().enable()
                        };
                        if let Some(tray) = app.tray_by_id("main") {
                            if let Ok(menu) = tray_menu(app, !enabled) {
                                let _ = tray.set_menu(Some(menu));
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle().clone(), false);
                    }
                })
                .build(app)?;

            // 开机自启时直接进托盘，避免每次开机闪一下设置窗。
            if !std::env::args().any(|arg| arg == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            speech_status,
            speech_play,
            speech_stop,
            overlay_show,
            overlay_payload,
            overlay_hide,
            overlay_visible,
            main_visible,
            overlay_displayed,
            show_main,
            hide_main,
            autostart_enabled,
            set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("启动班级公告大屏失败");
}
