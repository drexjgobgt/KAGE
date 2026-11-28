//! Global shortcut registration.
//!
//! `Alt + C`         : flush the rolling replay buffer to disk
//! `Alt + R`         : start / stop direct MP4 recording
//! `Alt + Shift + C` : arm / disarm the replay buffer

use std::str::FromStr;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::{AppState, EVT_BUFFER_STATE, EVT_ERROR, EVT_HOTKEY, EVT_RECORDING_STATE};
use crate::media::recorder::ClipWriteResult;

pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid shortcut '{accelerator}': {e}"))
}

pub fn validate(accelerator: &str) -> Result<Shortcut, String> {
    let sc = parse(accelerator)?;
    let has_modifier = accelerator.split('+').any(|part| {
        matches!(
            part.trim().to_ascii_lowercase().as_str(),
            "alt"
                | "ctrl"
                | "control"
                | "shift"
                | "super"
                | "win"
                | "cmd"
                | "meta"
                | "option"
                | "command"
        )
    });
    if !has_modifier {
        return Err(format!(
            "'{accelerator}' needs a modifier (Alt, Ctrl, Shift or Win): Windows reserves bare keys for typing"
        ));
    }
    Ok(sc)
}

pub fn unregister_combo(app: &AppHandle, accelerator: &str) {
    if let Ok(sc) = parse(accelerator) {
        let gs = app.global_shortcut();
        if gs.is_registered(sc) {
            let _ = gs.unregister(sc);
        }
    }
}

pub fn register_combo(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let sc = validate(accelerator)?;
    let gs = app.global_shortcut();
    if gs.is_registered(sc) {
        return Ok(());
    }
    gs.register(sc)
        .map_err(|e| format!("could not register {accelerator}: {e}"))
}

/// Checks if two accelerator strings resolve to the same OS shortcut.
pub fn combos_equal(a: &str, b: &str) -> bool {
    match (parse(a), parse(b)) {
        (Ok(sa), Ok(sb)) => sa == sb,
        _ => a.trim().eq_ignore_ascii_case(b.trim()),
    }
}

/// Registers all three shortcuts independently so a single conflict does not
/// leave the remaining shortcuts dead.
pub fn register_all(
    app: &AppHandle,
    save: &str,
    toggle: &str,
    record: &str,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut errors = Vec::new();

    for (label, raw) in [
        ("Save replay", save),
        ("Arm/disarm buffer", toggle),
        ("Start/stop recording", record),
    ] {
        match validate(raw) {
            Ok(sc) => {
                if !gs.is_registered(sc) {
                    if let Err(e) = gs.register(sc) {
                        errors.push(format!(
                            "could not register {label} ({raw}): {e} (another app may own it)"
                        ));
                    }
                }
            }
            Err(e) => errors.push(e),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" | "))
    }
}

pub fn rebind(app: &AppHandle, previous: &str, next: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let sc = validate(next)?;
    let prev_sc = parse(previous).ok();
    if prev_sc.as_ref() == Some(&sc) {
        return Ok(());
    }
    gs.register(sc)
        .map_err(|e| format!("could not register {next}: {e}"))?;
    if let Some(prev) = prev_sc {
        if gs.is_registered(prev) {
            let _ = gs.unregister(prev);
        }
    }
    Ok(())
}

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }

    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let (save_key, toggle_key, record_key) = {
        let s = app_state.settings.read();
        (
            s.hotkey_save.clone(),
            s.hotkey_toggle.clone(),
            s.hotkey_record.clone(),
        )
    };

    let save_matches = parse(&save_key).map(|s| &s == shortcut).unwrap_or(false);
    let toggle_matches = parse(&toggle_key).map(|s| &s == shortcut).unwrap_or(false);
    let record_matches = parse(&record_key).map(|s| &s == shortcut).unwrap_or(false);

    if save_matches {
        let _ = app.emit(EVT_HOTKEY, save_key);
        trigger_save(app.clone());
    } else if record_matches {
        let _ = app.emit(EVT_HOTKEY, record_key);
        trigger_record_toggle(app.clone());
    } else if toggle_matches {
        let _ = app.emit(EVT_HOTKEY, toggle_key);
        trigger_toggle(app.clone());
    }
}

pub fn clip_from_write(
    write: &ClipWriteResult,
    game: Option<String>,
) -> crate::media::library::ClipMetadata {
    crate::media::library::ClipMetadata {
        id: format!(
            "{}-{}",
            write.file_name,
            chrono::Utc::now().timestamp_millis()
        ),
        path: write.path.clone(),
        file_name: write.file_name.clone(),
        title: write
            .file_name
            .trim_end_matches(".mp4")
            .replace("KAGE_Replay_", "Replay ")
            .replace("KAGE_Rec_", "Rec ")
            .replace('_', " "),
        duration_seconds: write.duration_seconds,
        size_bytes: write.size_bytes,
        created_unix_ms: chrono::Utc::now().timestamp_millis(),
        width: write.width,
        height: write.height,
        fps: write.fps,
        has_audio: write.has_audio,
        game,
        thumbnail: None,
        favorite: false,
        tags: Vec::new(),
        external: false,
    }
}

pub fn publish_saved_clip(
    app: &AppHandle,
    write: &ClipWriteResult,
    game: Option<String>,
    triggered_by: &str,
    open_trimmer: bool,
    raise_deck: bool,
) -> crate::media::library::ClipMetadata {
    let clip = clip_from_write(write, game);
    let _ = app.emit(
        crate::commands::EVT_CLIP_SAVED,
        crate::commands::ClipSavedPayload {
            clip: clip.clone(),
            flush_ms: write.flush_ms,
            triggered_by: triggered_by.to_string(),
            open_trimmer,
        },
    );
    if raise_deck {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
    clip
}

pub fn trigger_save(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };

        let (toggle_key, open_trimmer, privacy_enabled) = {
            let s = state.settings.read();
            (
                s.hotkey_toggle.clone(),
                s.open_trimmer_after_save,
                s.privacy_pause_when_unfocused,
            )
        };

        let engine = Arc::clone(&state.engine);
        if !engine.is_running() || !engine.is_ring_enabled() {
            let _ = app.emit(
                EVT_ERROR,
                format!("Replay buffer is not armed. Press Arm Buffer (or {toggle_key}) first."),
            );
            return;
        }

        let game_folder = crate::commands::resolve_game_folder(&state, None);
        state.engine.set_output_subfolder(game_folder.clone());
        let result = tauri::async_runtime::spawn_blocking(move || {
            let focused = crate::foreground::get_foreground_game();
            let focused_err = focused.clone();
            if privacy_enabled {
                let gated = focused
                    .as_ref()
                    .map(|g| {
                        let e = g.exe.to_ascii_lowercase();
                        e.starts_with("kage") || e.starts_with("explorer")
                    })
                    .unwrap_or(false);
                if gated {
                    return Err((
                        crate::media::recorder::RecorderError::Other(
                            "Privacy mode: nothing recorded because no game is focused. Focus a game to arm the buffer again."
                                .into(),
                        ),
                        focused_err,
                    ));
                }
            }
            engine
                .flush_to_disk(None)
                .map(|w| (w, focused))
                .map_err(|e| (e, focused_err))
        })
        .await;

        match result {
            Ok(Ok((write, focused))) => {
                let focused_exe = focused
                    .map(|g| g.exe.to_ascii_lowercase())
                    .unwrap_or_default();
                let safe_to_raise =
                    focused_exe.starts_with("kage") || focused_exe.starts_with("explorer");
                let raise_deck = open_trimmer && safe_to_raise;

                if !safe_to_raise {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("KAGE Replay Saved")
                        .body(format!(
                            "{} ({:.0} ms)",
                            write.file_name, write.flush_ms
                        ))
                        .show();
                }

                publish_saved_clip(&app, &write, game_folder, "hotkey", raise_deck, raise_deck);
            }
            Ok(Err((e, _))) => {
                let _ = app.emit(EVT_ERROR, e.to_string());
            }
            Err(e) => {
                let _ = app.emit(EVT_ERROR, format!("flush task failed: {e}"));
            }
        }
    });
}

pub fn trigger_record_toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let engine = Arc::clone(&state.engine);
        let is_rec = engine.is_recording();

        if is_rec {
            let res = tauri::async_runtime::spawn_blocking(move || {
                let focused = crate::foreground::get_foreground_game();
                let write = engine.stop_recording()?;
                Ok::<_, crate::media::recorder::RecorderError>((write, focused, engine.stats()))
            })
            .await;

            match res {
                Ok(Ok(((write, game_folder), focused, stats))) => {
                    let _ = app.emit(EVT_RECORDING_STATE, &stats);
                    let _ = app.emit(EVT_BUFFER_STATE, &stats);

                    let focused_exe = focused
                        .map(|g| g.exe.to_ascii_lowercase())
                        .unwrap_or_default();
                    let safe_to_raise =
                        focused_exe.starts_with("kage") || focused_exe.starts_with("explorer");
                    if !safe_to_raise {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("KAGE Recording Saved")
                            .body(format!(
                                "{} ({:.1}s)",
                                write.file_name, write.duration_seconds
                            ))
                            .show();
                    }

                    publish_saved_clip(&app, &write, game_folder, "record-hotkey", false, false);
                }
                Ok(Err(e)) => {
                    let _ = app.emit(EVT_ERROR, e.to_string());
                    let stats = state.engine.stats();
                    let _ = app.emit(EVT_RECORDING_STATE, &stats);
                }
                Err(e) => {
                    let _ = app.emit(EVT_ERROR, format!("stop recording failed: {e}"));
                }
            }
        } else {
            if let Some(msg) = crate::commands::privacy_blocked_message(&state, None) {
                let _ = app.emit(EVT_ERROR, msg);
                return;
            }
            let (cfg, record_key) = {
                let s = state.settings.read();
                (
                    s.active_profile()
                        .map(|p| s.to_profile_config(p))
                        .unwrap_or_else(|| s.to_recorder_config()),
                    s.hotkey_record.clone(),
                )
            };
            let game_folder = crate::commands::resolve_game_folder(&state, None);
            let res = tauri::async_runtime::spawn_blocking(move || {
                let focused = crate::foreground::get_foreground_game();
                let path = engine.start_recording(cfg, game_folder)?;
                Ok::<_, crate::media::recorder::RecorderError>((path, focused, engine.stats()))
            })
            .await;

            match res {
                Ok(Ok((_path, focused, stats))) => {
                    let _ = app.emit(EVT_RECORDING_STATE, &stats);
                    let _ = app.emit(EVT_BUFFER_STATE, &stats);
                    let focused_exe = focused
                        .map(|g| g.exe.to_ascii_lowercase())
                        .unwrap_or_default();
                    let safe_to_raise =
                        focused_exe.starts_with("kage") || focused_exe.starts_with("explorer");
                    if !safe_to_raise {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("KAGE Recording Started")
                            .body(format!("Press {record_key} again to stop and save MP4."))
                            .show();
                    }
                }
                Ok(Err(e)) => {
                    let _ = app.emit(EVT_ERROR, e.to_string());
                }
                Err(e) => {
                    let _ = app.emit(EVT_ERROR, format!("start recording failed: {e}"));
                }
            }
        }
    });
}

pub fn trigger_toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let engine = Arc::clone(&state.engine);
        let cfg = {
            let s = state.settings.read();
            s.active_profile()
                .map(|p| s.to_profile_config(p))
                .unwrap_or_else(|| s.to_recorder_config())
        };

        let stats = tauri::async_runtime::spawn_blocking(move || {
            if engine.is_running() && engine.is_ring_enabled() {
                engine.disarm_buffer();
            } else if let Err(e) = engine.start(cfg) {
                return Err(e.to_string());
            }
            Ok(engine.stats())
        })
        .await;

        match stats {
            Ok(Ok(s)) => {
                let _ = app.emit(EVT_BUFFER_STATE, s);
            }
            Ok(Err(e)) => {
                let _ = app.emit(EVT_ERROR, e);
            }
            Err(e) => {
                let _ = app.emit(EVT_ERROR, format!("toggle failed: {e}"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{combos_equal, validate};

    #[test]
    fn validates_modifiers_and_alt_r() {
        assert!(validate("Alt+R").is_ok());
        assert!(validate("Alt+C").is_ok());
        assert!(validate("Alt+Shift+C").is_ok());
        assert!(validate("R").is_err());
    }

    #[test]
    fn detects_equivalent_combos_case_insensitively() {
        assert!(combos_equal("Alt+R", "alt+r"));
        assert!(!combos_equal("Alt+R", "Alt+C"));
        assert!(!combos_equal("Alt+C", "Alt+Shift+C"));
    }
}
