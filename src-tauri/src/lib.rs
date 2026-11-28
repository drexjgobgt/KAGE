//! KAGE: lightweight instant replay and direct screen recorder for Windows.

pub mod clipmeta;
pub mod commands;
pub mod foreground;
pub mod hotkeys;
pub mod media;
pub mod power;
pub mod settings;

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

use commands::{AppState, EVT_DECK_HIDDEN, EVT_STATS};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,kage=debug"),
    )
    .format_timestamp_millis()
    .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkeys::on_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            build_tray(&handle)?;

            let (save_key, toggle_key, record_key, autostart, cfg) = {
                let state = handle.state::<AppState>();
                let s = state.settings.read();
                (
                    s.hotkey_save.clone(),
                    s.hotkey_toggle.clone(),
                    s.hotkey_record.clone(),
                    s.autostart_buffer,
                    s.active_profile()
                        .map(|p| s.to_profile_config(p))
                        .unwrap_or_else(|| s.to_recorder_config()),
                )
            };

            {
                use tauri_plugin_autostart::ManagerExt;
                let want = handle.state::<AppState>().settings.read().launch_at_startup;
                let autostart = handle.autolaunch();
                let is_on = autostart.is_enabled().unwrap_or(false);
                if want && !is_on {
                    let _ = autostart.enable();
                } else if !want && is_on {
                    let _ = autostart.disable();
                }
            }

            if let Err(e) = hotkeys::register_all(&handle, &save_key, &toggle_key, &record_key) {
                log::warn!("[kage] hotkey registration: {e}");
                let h = handle.clone();
                let msg = e.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(900)).await;
                    let _ = h.emit(commands::EVT_ERROR, msg);
                });
            }

            if let Some(w) = handle.get_webview_window("main") {
                let on_top = handle
                    .state::<AppState>()
                    .settings
                    .read()
                    .always_on_top;
                if on_top {
                    let _ = w.set_always_on_top(true);
                }
                if std::env::args().any(|a| a == "--minimized") {
                    let _ = w.hide();
                    let _ = handle.emit(EVT_DECK_HIDDEN, ());
                }
            }

            if let Some(state) = handle.try_state::<AppState>() {
                let dir = state.settings.read().output_dir.clone();
                allow_asset_dir(&handle, &dir);
            }

            if handle
                .state::<AppState>()
                .settings
                .read()
                .privacy_pause_when_unfocused
            {
                handle
                    .state::<AppState>()
                    .engine
                    .set_privacy_gate(commands::privacy_should_gate());
            }

            if autostart {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = h.state::<AppState>();
                    let engine = Arc::clone(&state.engine);
                    let result =
                        tauri::async_runtime::spawn_blocking(move || engine.start(cfg)).await;
                    match result {
                        Ok(Ok(stats)) => {
                            let _ = h.emit(commands::EVT_BUFFER_STATE, stats);
                        }
                        Ok(Err(e)) => {
                            let _ = h.emit(commands::EVT_ERROR, e.to_string());
                        }
                        Err(e) => {
                            let _ = h.emit(
                                commands::EVT_ERROR,
                                format!("autostart failed: {e}"),
                            );
                        }
                    }
                });
            }

            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(1000));
                loop {
                    ticker.tick().await;
                    let Some(state) = h.try_state::<AppState>() else {
                        break;
                    };
                    let deck_visible = h
                        .get_webview_window("main")
                        .map(|w| {
                            w.is_visible().unwrap_or(false)
                                && !w.is_minimized().unwrap_or(false)
                        })
                        .unwrap_or(false);
                    if !deck_visible {
                        continue;
                    }
                    let stats = state.engine.stats();
                    if let Err(e) = h.emit(EVT_STATS, stats) {
                        log::warn!("[kage] stats emit failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().try_state::<AppState>();
                let minimize = state
                    .as_ref()
                    .map(|s| s.settings.read().minimize_to_tray)
                    .unwrap_or(true);
                let capture_running = state
                    .as_ref()
                    .map(|s| s.engine.is_running())
                    .unwrap_or(false);
                if minimize && window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit(EVT_DECK_HIDDEN, ());
                    if !capture_running {
                        trim_working_set();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_replay_buffer,
            commands::stop_replay_buffer,
            commands::start_recording,
            commands::stop_recording,
            commands::toggle_recording,
            commands::get_engine_stats,
            commands::get_disk_free_bytes,
            commands::set_buffer_seconds,
            commands::save_instant_replay,
            commands::get_recorded_clips,
            commands::open_external_video,
            commands::get_clip_thumbnail,
            commands::trim_clip,
            commands::split_clip,
            commands::delete_clip,
            commands::delete_clips,
            commands::delete_all_clips,
            commands::copy_clips_to_clipboard,
            commands::set_clips_favorite,
            commands::add_clips_tag,
            commands::remove_clips_tag,
            commands::rename_clip,
            commands::extract_png_frame,
            commands::save_png_snapshot,
            commands::copy_clip_to_clipboard,
            commands::reveal_clip_in_folder,
            commands::open_output_folder,
            commands::open_clip_external,
            commands::get_settings,
            commands::update_settings,
            commands::get_monitors,
            commands::get_audio_input_devices,
            commands::get_foreground_game,
            commands::get_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::set_profile_map,
            commands::apply_profile,
            commands::cleanup_old_clips,
            commands::set_clip_favorite,
            commands::set_clip_tags,
            commands::set_privacy_gate,
            commands::get_power_state,
            commands::hide_main_window,
            commands::quit_app,
            commands::simulate_device_loss,
        ])
        .build(tauri::generate_context!())
        .expect("error while building KAGE")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    let engine = Arc::clone(&state.engine);
                    let _ = std::thread::Builder::new()
                        .name("kage-shutdown".into())
                        .spawn(move || engine.stop());
                }
            }
        });
}

fn allow_asset_dir(app: &tauri::AppHandle, dir: &str) {
    if dir.trim().is_empty() {
        return;
    }
    let path = std::path::PathBuf::from(dir);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&path, true) {
        log::warn!("[kage] could not widen asset scope to {dir}: {e}");
    }
}

/// Asks Windows to page out cold working-set pages only when capture is idle.
pub fn trim_working_set() {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    unsafe {
        use windows::Win32::System::Memory::{
            SetProcessWorkingSetSizeEx, SETPROCESSWORKINGSETSIZEEX_FLAGS,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        let _ = SetProcessWorkingSetSizeEx(
            GetCurrentProcess(),
            usize::MAX,
            usize::MAX,
            SETPROCESSWORKINGSETSIZEEX_FLAGS(0),
        );
    }
}

pub fn refresh_tray_labels(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("kage-tray") {
        let (save_k, rec_k, tog_k) = app
            .try_state::<AppState>()
            .map(|st| {
                let s = st.settings.read();
                (
                    s.hotkey_save.clone(),
                    s.hotkey_record.clone(),
                    s.hotkey_toggle.clone(),
                )
            })
            .unwrap_or_else(|| ("Alt+C".into(), "Alt+R".into(), "Alt+Shift+C".into()));
        let _ = tray.set_tooltip(Some(&format!(
            "KAGE Studio ({save_k} replay, {rec_k} record)"
        )));
        if let Ok(menu) = build_tray_menu(app, &save_k, &rec_k, &tog_k) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn build_tray_menu(
    app: &tauri::AppHandle,
    save_k: &str,
    rec_k: &str,
    tog_k: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let save = MenuItem::with_id(app, "save", format!("Save Replay\t{save_k}"), true, None::<&str>)?;
    let last30 = MenuItem::with_id(app, "save30", "Save Last 30s", true, None::<&str>)?;
    let record = MenuItem::with_id(
        app,
        "record",
        format!("Start / Stop Recording\t{rec_k}"),
        true,
        None::<&str>,
    )?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        format!("Arm / Disarm Buffer\t{tog_k}"),
        true,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, "show", "Open KAGE Studio", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open Captures Folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit KAGE", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let capture = Submenu::with_id_and_items(
        app,
        "capture",
        "Capture",
        true,
        &[&save, &last30, &record, &toggle],
    )?;
    Menu::with_items(app, &[&capture, &sep, &show, &folder, &sep, &quit])
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let (save_k, rec_k, tog_k) = app
        .try_state::<AppState>()
        .map(|st| {
            let s = st.settings.read();
            (
                s.hotkey_save.clone(),
                s.hotkey_record.clone(),
                s.hotkey_toggle.clone(),
            )
        })
        .unwrap_or_else(|| ("Alt+C".into(), "Alt+R".into(), "Alt+Shift+C".into()));
    let menu = build_tray_menu(app, &save_k, &rec_k, &tog_k)?;

    let mut builder = TrayIconBuilder::with_id("kage-tray")
        .menu(&menu)
        .tooltip(format!("KAGE Studio ({save_k} replay, {rec_k} record)"))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "save" => hotkeys::trigger_save(app.clone()),
            "record" => hotkeys::trigger_record_toggle(app.clone()),
            "save30" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = h.try_state::<AppState>() else {
                        return;
                    };
                    if let Some(msg) = commands::privacy_blocked_message(&state, None) {
                        let _ = h.emit(commands::EVT_ERROR, msg);
                        return;
                    }
                    let game_folder = commands::resolve_game_folder(&state, None);
                    state.engine.set_output_subfolder(game_folder.clone());
                    let engine = Arc::clone(&state.engine);
                    let written = tauri::async_runtime::spawn_blocking(move || {
                        engine.flush_to_disk(Some(30.0))
                    })
                    .await;
                    match written {
                        Ok(Ok(write)) => {
                            crate::hotkeys::publish_saved_clip(
                                &h,
                                &write,
                                game_folder,
                                "tray",
                                false,
                                false,
                            );
                        }
                        Ok(Err(e)) => {
                            let _ = h.emit(commands::EVT_ERROR, e.to_string());
                        }
                        Err(e) => {
                            let _ = h.emit(
                                commands::EVT_ERROR,
                                format!("flush task failed: {e}"),
                            );
                        }
                    }
                });
            }
            "toggle" => hotkeys::trigger_toggle(app.clone()),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "folder" => {
                use tauri_plugin_opener::OpenerExt;
                if let Some(state) = app.try_state::<AppState>() {
                    let dir = state.settings.read().output_dir.clone();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = app.opener().open_path(dir, None::<&str>);
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub use tauri_plugin_global_shortcut::ShortcutState as GlobalShortcutState;
const _: fn(ShortcutState) -> bool = |s| matches!(s, ShortcutState::Pressed);
