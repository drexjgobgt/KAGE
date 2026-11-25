//! Every Tauri IPC handler lives here. Each returns `Result<T, String>`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::clipmeta::{ClipMetaEntry, ClipMetaStore};
use crate::foreground::ForegroundGame;
use crate::media::library::{self, ClipMetadata, TrimResult};
use crate::media::recorder::{
    enumerate_monitors, free_disk_bytes, CaptureEngine, ClipWriteResult, Codec, EngineStats,
    MonitorInfo,
};
use crate::settings::{CaptureProfile, ProfileMapEntry, Settings};

pub struct AppState {
    pub engine: Arc<CaptureEngine>,
    pub settings: RwLock<Settings>,
    pub clip_meta: Mutex<ClipMetaStore>,
}

impl AppState {
    pub fn new() -> Self {
        let mut settings = Settings::load();
        settings.seed_default_profiles();
        let _ = settings.save();
        Self {
            engine: Arc::new(CaptureEngine::new()),
            settings: RwLock::new(settings),
            clip_meta: Mutex::new(ClipMetaStore::load()),
        }
    }

    pub fn output_dir(&self) -> PathBuf {
        PathBuf::from(self.settings.read().output_dir.clone())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub const EVT_CLIP_SAVED: &str = "kage://clip-saved";
pub const EVT_STATS: &str = "kage://stats";
pub const EVT_ERROR: &str = "kage://error";
pub const EVT_HOTKEY: &str = "kage://hotkey";
pub const EVT_BUFFER_STATE: &str = "kage://buffer-state";
pub const EVT_RECORDING_STATE: &str = "kage://recording-state";
pub const EVT_DECK_HIDDEN: &str = "kage://deck-hidden";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSavedPayload {
    pub clip: ClipMetadata,
    pub flush_ms: f32,
    pub triggered_by: String,
    #[serde(default)]
    pub open_trimmer: bool,
}

// ---------------------------------------------------------------------------
// Buffer & direct recording lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
    buffer_seconds: u32,
    target_fps: u32,
) -> Result<EngineStats, String> {
    let cfg = {
        let mut s = state.settings.write();
        s.buffer_seconds = buffer_seconds.clamp(5, 600);
        s.target_fps = target_fps.clamp(24, 240);
        let _ = s.save();
        s.to_recorder_config()
    };
    std::fs::create_dir_all(&cfg.output_dir).map_err(|e| e.to_string())?;

    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || engine.start(cfg))
        .await
        .map_err(|e| format!("engine task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub async fn stop_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<EngineStats, String> {
    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || {
        engine.disarm_buffer();
        engine.stats()
    })
    .await
    .map_err(|e| format!("engine task panicked: {e}"))?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub async fn start_recording(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<EngineStats, String> {
    let cfg = {
        let s = state.settings.read();
        s.active_profile()
            .map(|p| s.to_profile_config(p))
            .unwrap_or_else(|| s.to_recorder_config())
    };
    let game_folder = resolve_game_folder(&state, None);
    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || -> Result<EngineStats, String> {
        engine
            .start_recording(cfg, game_folder)
            .map_err(|e| e.to_string())?;
        Ok(engine.stats())
    })
    .await
    .map_err(|e| format!("recording start panicked: {e}"))??;

    let _ = app.emit(EVT_RECORDING_STATE, &stats);
    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub async fn stop_recording(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ClipMetadata, String> {
    let game_folder = resolve_game_folder(&state, None);
    let engine = Arc::clone(&state.engine);
    let (result, stats) = tauri::async_runtime::spawn_blocking(move || {
        let w = engine.stop_recording().map_err(|e| e.to_string())?;
        Ok::<_, String>((w, engine.stats()))
    })
    .await
    .map_err(|e| format!("recording stop panicked: {e}"))??;

    let _ = app.emit(EVT_RECORDING_STATE, &stats);
    let _ = app.emit(EVT_BUFFER_STATE, &stats);

    let clip = crate::hotkeys::publish_saved_clip(
        &app,
        &result,
        game_folder,
        "record-ui",
        false,
        false,
    );
    Ok(clip)
}

#[tauri::command]
pub async fn toggle_recording(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<EngineStats, String> {
    if state.engine.is_recording() {
        let _ = stop_recording(state.clone(), app.clone()).await?;
        Ok(state.engine.stats())
    } else {
        start_recording(state, app).await
    }
}

#[tauri::command]
pub fn get_engine_stats(state: State<'_, AppState>) -> Result<EngineStats, String> {
    Ok(state.engine.stats())
}

#[tauri::command]
pub fn get_disk_free_bytes(state: State<'_, AppState>) -> Result<Option<u64>, String> {
    let dir = state.output_dir();
    Ok(free_disk_bytes(&dir))
}

#[tauri::command]
pub fn set_buffer_seconds(state: State<'_, AppState>, seconds: u32) -> Result<(), String> {
    state.engine.set_buffer_seconds(seconds.clamp(5, 600));
    Ok(())
}

// ---------------------------------------------------------------------------
// The Alt+C flush path
// ---------------------------------------------------------------------------

pub fn sanitize_file_stem(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn game_folder_name(exe: &str) -> Option<String> {
    let exe = exe.to_ascii_lowercase();
    if exe.starts_with("kage") {
        return None;
    }
    let stem = match exe.rfind('.') {
        Some(i) if i > 0 => &exe[..i],
        _ => exe.as_str(),
    };
    let sanitized: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = sanitized.trim_matches('-').to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

pub fn resolve_game_folder(state: &AppState, game_override: Option<&str>) -> Option<String> {
    let s = state.settings.read();
    if !s.organize_by_game {
        return None;
    }
    if let Some(g) = game_override {
        return game_folder_name(g);
    }
    crate::foreground::foreground_exe().and_then(|exe| game_folder_name(&exe))
}

pub fn privacy_should_gate() -> bool {
    match crate::foreground::foreground_exe() {
        Some(e) => e.starts_with("kage") || e.starts_with("explorer"),
        None => false,
    }
}

pub fn privacy_blocked_message(state: &AppState, game_override: Option<&str>) -> Option<String> {
    let s = state.settings.read();
    if !s.privacy_pause_when_unfocused {
        return None;
    }
    if game_override.is_some() {
        return None;
    }
    if privacy_should_gate() {
        Some(
            "Privacy mode: nothing recorded because no game is focused. Focus a game to arm the buffer again."
                .to_string(),
        )
    } else {
        None
    }
}

#[tauri::command]
pub async fn save_instant_replay(
    state: State<'_, AppState>,
    app: AppHandle,
    max_seconds: Option<f32>,
    triggered_by: Option<String>,
    game_override: Option<String>,
) -> Result<ClipMetadata, String> {
    if let Some(msg) = privacy_blocked_message(&state, game_override.as_deref()) {
        return Err(msg);
    }
    let game_folder = resolve_game_folder(&state, game_override.as_deref());
    state.engine.set_output_subfolder(game_folder.clone());

    let engine = Arc::clone(&state.engine);
    let result: ClipWriteResult = tauri::async_runtime::spawn_blocking(move || {
        engine.flush_to_disk(max_seconds).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("flush task panicked: {e}"))??;

    let open_trimmer = match triggered_by.as_deref() {
        None | Some("ui") => state.settings.read().open_trimmer_after_save,
        _ => false,
    };
    let clip = crate::hotkeys::publish_saved_clip(
        &app,
        &result,
        game_folder,
        triggered_by.as_deref().unwrap_or("ui"),
        open_trimmer,
        false,
    );

    log::info!(
        "[kage] saved {} ({:.1}s, {:.1} MB) in {:.1} ms",
        clip.file_name,
        clip.duration_seconds,
        clip.size_bytes as f32 / 1_048_576.0,
        result.flush_ms
    );

    Ok(clip)
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_recorded_clips(
    state: State<'_, AppState>,
    with_thumbnails: Option<bool>,
) -> Result<Vec<ClipMetadata>, String> {
    let dir = state.output_dir();
    let thumbs = with_thumbnails.unwrap_or(true);
    let mut clips = tauri::async_runtime::spawn_blocking(move || {
        library::scan_directory(&dir, thumbs).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("scan task panicked: {e}"))??;
    state.clip_meta.lock().merge_into(&mut clips);
    Ok(clips)
}

#[tauri::command]
pub async fn get_clip_thumbnail(path: String, at_seconds: Option<f32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_thumbnail(Path::new(&path), at_seconds.unwrap_or(1.0))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("thumbnail task panicked: {e}"))?
}

fn split_at_seconds(duration_seconds: f32, at_seconds: f32) -> Result<f32, String> {
    if duration_seconds <= 0.4 {
        return Err("clip is too short to split".to_string());
    }
    Ok(at_seconds.clamp(0.2, duration_seconds - 0.2))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub part_a: TrimResult,
    pub part_b: TrimResult,
}

#[tauri::command]
pub async fn split_clip(source_path: String, at_seconds: f32) -> Result<SplitResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        if !source.exists() {
            return Err(format!("source clip not found: {source_path}"));
        }
        let duration = library::probe(&source)
            .map_err(|e| e.to_string())?
            .duration_seconds;
        let at = split_at_seconds(duration, at_seconds)?;

        let part_a = library::trim_stream_copy(
            &source,
            &library::suggested_trim_path(&source),
            0.0,
            at,
        )
        .map_err(|e| e.to_string())?;

        std::thread::sleep(std::time::Duration::from_millis(40));

        let dest_b = library::suggested_trim_path(&source);
        let part_b = match library::trim_stream_copy(&source, &dest_b, at, duration) {
            Ok(b) => b,
            Err(e) => {
                let _ = std::fs::remove_file(PathBuf::from(&part_a.path));
                let _ = std::fs::remove_file(&dest_b);
                return Err(e.to_string());
            }
        };

        Ok(SplitResult { part_a, part_b })
    })
    .await
    .map_err(|e| format!("split task panicked: {e}"))?
}

#[tauri::command]
pub async fn trim_clip(
    source_path: String,
    start_time: f32,
    end_time: f32,
    overwrite: Option<bool>,
) -> Result<TrimResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        let overwrite = overwrite.unwrap_or(false);
        let dest = if overwrite {
            source.with_extension("trim.tmp.mp4")
        } else {
            library::suggested_trim_path(&source)
        };

        let mut result = library::trim_stream_copy(&source, &dest, start_time, end_time)
            .map_err(|e| e.to_string())?;

        if overwrite {
            if let Err(e) = std::fs::rename(&dest, &source) {
                let _ = std::fs::remove_file(&dest);
                return Err(e.to_string());
            }
            result.path = source.to_string_lossy().to_string();
            result.file_name = source
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("trim task panicked: {e}"))?
}

#[tauri::command]
pub async fn delete_clip(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::delete_clip(Path::new(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

#[tauri::command]
pub async fn delete_all_clips(state: State<'_, AppState>) -> Result<u32, String> {
    let dir = state.output_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let clips = library::scan_directory(&dir, false).map_err(|e| e.to_string())?;
        let mut deleted = 0u32;
        for c in &clips {
            if library::delete_clip(Path::new(&c.path)).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

#[tauri::command]
pub async fn rename_clip(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dest = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let stem = sanitize_file_stem(&new_name, "");
        if stem.is_empty() {
            return Err("clip name cannot be empty".into());
        }
        let name = if stem.to_ascii_lowercase().ends_with(".mp4") {
            stem
        } else {
            format!("{stem}.mp4")
        };
        let dest = src
            .parent()
            .ok_or_else(|| "clip has no parent directory".to_string())?
            .join(name);
        std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        Ok(dest)
    })
    .await
    .map_err(|e| format!("rename task panicked: {e}"))??;

    state
        .clip_meta
        .lock()
        .migrate(&path, &dest.to_string_lossy());
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_clip_to_clipboard(path: String) -> Result<(), String> {
    clipboard::copy_files(&[PathBuf::from(path)])
}

#[tauri::command]
pub fn copy_clips_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let clips: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    clipboard::copy_files(&clips)
}

#[tauri::command]
pub async fn delete_clips(paths: Vec<String>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut deleted = 0u32;
        for p in &paths {
            if library::delete_clip(Path::new(p)).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

#[tauri::command]
pub fn set_clips_favorite(
    state: State<'_, AppState>,
    paths: Vec<String>,
    favorite: bool,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().set_favorite_many(&paths, favorite))
}

#[tauri::command]
pub fn add_clips_tag(
    state: State<'_, AppState>,
    paths: Vec<String>,
    tag: String,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().add_tag_many(&paths, &tag))
}

#[tauri::command]
pub fn remove_clips_tag(
    state: State<'_, AppState>,
    paths: Vec<String>,
    tag: String,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().remove_tag_many(&paths, &tag))
}

#[tauri::command]
pub fn reveal_clip_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_output_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_clip_external(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn extract_png_frame(
    path: String,
    at_seconds: Option<f32>,
    max_width: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_frame_png(
            Path::new(&path),
            at_seconds.unwrap_or(0.0),
            max_width.unwrap_or(0),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("snapshot task panicked: {e}"))?
}

#[tauri::command]
pub async fn save_png_snapshot(
    state: State<'_, AppState>,
    png_base64: String,
    base_name: String,
) -> Result<String, String> {
    let dir = state.output_dir();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use base64::Engine;
        let raw = png_base64.trim_start_matches("data:image/png;base64,");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| format!("invalid png data: {e}"))?;
        if bytes.len() < 8 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
            return Err("payload is not a PNG image".into());
        }
        let stem = sanitize_file_stem(&base_name, "snapshot");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut path = dir.join(format!("{stem}.png"));
        let mut n = 2u32;
        while path.exists() {
            path = dir.join(format!("{stem}_{n}.png"));
            n += 1;
        }
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("snapshot task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Settings / system
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.read().clone())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub buffer_seconds: Option<u32>,
    pub target_fps: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub codec: Option<Codec>,
    pub monitor_index: Option<u32>,
    pub capture_system_audio: Option<bool>,
    pub capture_microphone: Option<bool>,
    pub output_dir: Option<String>,
    pub open_trimmer_after_save: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub autostart_buffer: Option<bool>,
    pub play_save_sound: Option<bool>,
    pub hotkey_save: Option<String>,
    pub hotkey_toggle: Option<String>,
    pub hotkey_record: Option<String>,
    pub always_on_top: Option<bool>,
    pub auto_switch_profiles: Option<bool>,
    pub launch_at_startup: Option<bool>,
    pub auto_cleanup_days: Option<u32>,
    pub organize_by_game: Option<bool>,
    pub autosave_on_game_exit: Option<bool>,
    pub performance_mode: Option<bool>,
    pub privacy_pause_when_unfocused: Option<bool>,
    pub game_volume: Option<u32>,
    pub mic_volume: Option<u32>,
    pub mic_device_id: Option<String>,
    pub adaptive_eco: Option<bool>,
    pub eco_battery_threshold_pct: Option<u32>,
    pub eco_ram_free_gbs: Option<u32>,
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let prev = state.settings.read().clone();
    let mut s = prev.clone();

    let next_save = patch.hotkey_save.clone().unwrap_or_else(|| s.hotkey_save.clone());
    let next_toggle = patch
        .hotkey_toggle
        .clone()
        .unwrap_or_else(|| s.hotkey_toggle.clone());
    let next_record = patch
        .hotkey_record
        .clone()
        .unwrap_or_else(|| s.hotkey_record.clone());

    if crate::hotkeys::combos_equal(&next_save, &next_toggle) {
        return Err(format!(
            "Save replay and arm/disarm hotkeys cannot share '{next_save}'"
        ));
    }
    if crate::hotkeys::combos_equal(&next_save, &next_record) {
        return Err(format!(
            "Save replay and recording hotkeys cannot share '{next_save}'"
        ));
    }
    if crate::hotkeys::combos_equal(&next_toggle, &next_record) {
        return Err(format!(
            "Arm/disarm and recording hotkeys cannot share '{next_toggle}'"
        ));
    }

    if let Some(v) = patch.buffer_seconds {
        s.buffer_seconds = v.clamp(5, 600);
    }
    if let Some(v) = patch.target_fps {
        s.target_fps = v.clamp(24, 240);
    }
    if let Some(v) = patch.bitrate_kbps {
        s.bitrate_kbps = v.clamp(1_000, 150_000);
    }
    if let Some(v) = patch.codec {
        s.codec = v;
    }
    if let Some(v) = patch.monitor_index {
        s.monitor_index = v;
    }
    if let Some(v) = patch.capture_system_audio {
        s.capture_system_audio = v;
    }
    if let Some(v) = patch.capture_microphone {
        s.capture_microphone = v;
    }
    if let Some(v) = patch.output_dir.clone() {
        std::fs::create_dir_all(&v).map_err(|e| e.to_string())?;
        s.output_dir = v;
    }
    if let Some(v) = patch.open_trimmer_after_save {
        s.open_trimmer_after_save = v;
    }
    if let Some(v) = patch.minimize_to_tray {
        s.minimize_to_tray = v;
    }
    if let Some(v) = patch.autostart_buffer {
        s.autostart_buffer = v;
    }
    if let Some(v) = patch.play_save_sound {
        s.play_save_sound = v;
    }
    if let Some(v) = patch.always_on_top {
        s.always_on_top = v;
    }
    if let Some(v) = patch.auto_switch_profiles {
        s.auto_switch_profiles = v;
    }
    if let Some(v) = patch.auto_cleanup_days {
        s.auto_cleanup_days = v;
    }
    if let Some(v) = patch.organize_by_game {
        s.organize_by_game = v;
    }
    if let Some(v) = patch.autosave_on_game_exit {
        s.autosave_on_game_exit = v;
    }
    if let Some(v) = patch.performance_mode {
        s.performance_mode = v;
    }
    if let Some(v) = patch.privacy_pause_when_unfocused {
        s.privacy_pause_when_unfocused = v;
    }
    if let Some(v) = patch.game_volume {
        s.game_volume = v.clamp(0, 100);
    }
    if let Some(v) = patch.mic_volume {
        s.mic_volume = v.clamp(0, 100);
    }
    if let Some(v) = patch.mic_device_id.clone() {
        s.mic_device_id = if v.trim().is_empty() || v == "default" {
            None
        } else {
            Some(v)
        };
    }
    if let Some(v) = patch.adaptive_eco {
        s.adaptive_eco = v;
    }
    if let Some(v) = patch.eco_battery_threshold_pct {
        s.eco_battery_threshold_pct = v.clamp(5, 100);
    }
    if let Some(v) = patch.eco_ram_free_gbs {
        s.eco_ram_free_gbs = v.clamp(1, 32);
    }

    // Rebind hotkeys with rollback tracking so a failure on any subsequent step
    // (autostart registry or settings.json write) restores OS shortcuts cleanly.
    let mut rebound: Vec<(String, String)> = Vec::new();
    if let Some(v) = patch.hotkey_save.clone() {
        crate::hotkeys::rebind(&app, &s.hotkey_save, &v)?;
        rebound.push((s.hotkey_save.clone(), v.clone()));
        s.hotkey_save = v;
    }
    if let Some(v) = patch.hotkey_toggle.clone() {
        if let Err(e) = crate::hotkeys::rebind(&app, &s.hotkey_toggle, &v) {
            for (old, new) in rebound.into_iter().rev() {
                let _ = crate::hotkeys::rebind(&app, &new, &old);
            }
            return Err(e);
        }
        rebound.push((s.hotkey_toggle.clone(), v.clone()));
        s.hotkey_toggle = v;
    }
    if let Some(v) = patch.hotkey_record.clone() {
        if let Err(e) = crate::hotkeys::rebind(&app, &s.hotkey_record, &v) {
            for (old, new) in rebound.into_iter().rev() {
                let _ = crate::hotkeys::rebind(&app, &new, &old);
            }
            return Err(e);
        }
        rebound.push((s.hotkey_record.clone(), v.clone()));
        s.hotkey_record = v;
    }

    if let Some(v) = patch.launch_at_startup {
        s.launch_at_startup = v;
        use tauri_plugin_autostart::ManagerExt;
        let res = if v {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        if let Err(e) = res {
            for (old, new) in rebound.into_iter().rev() {
                let _ = crate::hotkeys::rebind(&app, &new, &old);
            }
            return Err(format!("could not update launch at startup: {e}"));
        }
    }

    if let Err(e) = s.save() {
        for (old, new) in rebound.into_iter().rev() {
            let _ = crate::hotkeys::rebind(&app, &new, &old);
        }
        return Err(e);
    }

    if patch.buffer_seconds.is_some() {
        state.engine.set_buffer_seconds(s.buffer_seconds);
    }
    if let Some(dir) = patch.output_dir {
        state.engine.set_output_dir(std::path::PathBuf::from(&dir));
        crate::allow_asset_dir(&app, &dir);
    }
    if let Some(v) = patch.always_on_top {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(v);
        }
    }
    if let Some(v) = patch.privacy_pause_when_unfocused {
        if v {
            state.engine.set_privacy_gate(privacy_should_gate());
        } else {
            state.engine.set_privacy_gate(false);
        }
    }
    if patch.game_volume.is_some() || patch.mic_volume.is_some() {
        state.engine.set_audio_volumes(s.game_volume, s.mic_volume);
    }
    if patch.mic_device_id.is_some() {
        state.engine.set_mic_device(s.mic_device_id.clone());
    }

    *state.settings.write() = s.clone();
    Ok(s)
}

#[tauri::command]
pub fn get_power_state() -> Result<crate::power::PowerState, String> {
    crate::power::read_power_state()
}

#[tauri::command]
pub fn set_clip_favorite(
    state: State<'_, AppState>,
    path: String,
    favorite: bool,
) -> Result<ClipMetaEntry, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("clip not found: {path}"));
    }
    state.clip_meta.lock().set_favorite(&path, favorite)
}

#[tauri::command]
pub fn set_clip_tags(
    state: State<'_, AppState>,
    path: String,
    tags: Vec<String>,
) -> Result<ClipMetaEntry, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("clip not found: {path}"));
    }
    state.clip_meta.lock().set_tags(&path, tags)
}

#[tauri::command]
pub fn set_privacy_gate(state: State<'_, AppState>, gate: bool) -> Result<(), String> {
    state.engine.set_privacy_gate(gate);
    Ok(())
}

#[tauri::command]
pub async fn cleanup_old_clips(state: State<'_, AppState>, days: u32) -> Result<u32, String> {
    let dir = state.output_dir();
    let days = days.max(1);
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    tauri::async_runtime::spawn_blocking(move || {
        let clips = library::scan_directory(&dir, false).map_err(|e| e.to_string())?;
        let mut deleted = 0u32;
        for c in &clips {
            let created = chrono::DateTime::from_timestamp_millis(c.created_unix_ms);
            if let Some(created) = created {
                if created < cutoff && library::delete_clip(Path::new(&c.path)).is_ok() {
                    deleted += 1;
                }
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("cleanup task panicked: {e}"))?
}

#[tauri::command]
pub async fn get_foreground_game() -> Result<Option<ForegroundGame>, String> {
    tauri::async_runtime::spawn_blocking(crate::foreground::get_foreground_game)
        .await
        .map_err(|e| format!("foreground query panicked: {e}"))
}

#[tauri::command]
pub fn get_profiles(state: State<'_, AppState>) -> Result<Vec<CaptureProfile>, String> {
    Ok(state.settings.read().profiles.clone())
}

#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: CaptureProfile,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let id = profile.id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("profile id cannot be empty".into());
    }
    let mut profile = profile;
    profile.id = id.clone();
    if profile.name.trim().is_empty() {
        profile.name = id.clone();
    } else {
        profile.name = profile.name.trim().to_string();
    }
    profile.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
    profile.target_fps = profile.target_fps.clamp(24, 240);
    profile.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);

    if let Some(existing) = s.profiles.iter_mut().find(|p| p.id == id) {
        *existing = profile;
    } else {
        s.profiles.push(profile);
    }
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub fn delete_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let before = s.profiles.len();
    s.profiles.retain(|p| p.id != profile_id);
    if s.profiles.len() == before {
        return Err(format!("profile '{profile_id}' not found"));
    }
    s.profile_map.retain(|m| m.profile_id != profile_id);
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub fn set_profile_map(
    state: State<'_, AppState>,
    map: Vec<ProfileMapEntry>,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<ProfileMapEntry> = map
        .into_iter()
        .filter_map(|m| {
            let exe = m.exe_name.trim().to_ascii_lowercase();
            if exe.is_empty() || s.profile_by_id(&m.profile_id).is_none() {
                return None;
            }
            if !seen.insert(exe.clone()) {
                return None;
            }
            Some(ProfileMapEntry {
                profile_id: m.profile_id,
                exe_name: exe,
            })
        })
        .collect();
    s.profile_map = cleaned;
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub fn apply_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let profile = s
        .profile_by_id(&profile_id)
        .cloned()
        .ok_or_else(|| format!("profile '{profile_id}' not found"))?;
    s.apply_profile_values(&profile);
    state.engine.set_buffer_seconds(s.buffer_seconds);
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    tauri::async_runtime::spawn_blocking(enumerate_monitors)
        .await
        .map_err(|e| format!("monitor query panicked: {e}"))
}

#[tauri::command]
pub async fn get_audio_input_devices() -> Result<Vec<crate::media::audio::AudioDevice>, String> {
    tauri::async_runtime::spawn_blocking(crate::media::audio::enumerate_audio_devices)
        .await
        .map_err(|e| format!("audio device query panicked: {e}"))
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let _ = app.emit(EVT_DECK_HIDDEN, ());
    crate::trim_working_set();
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Clipboard (CF_HDROP)
// ---------------------------------------------------------------------------

mod clipboard {
    use std::path::PathBuf;

    #[cfg(all(windows, not(feature = "headless-sim")))]
    pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::{GlobalFree, HANDLE};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::DROPFILES;

        for p in paths {
            if !p.exists() {
                return Err(format!("clip not found: {}", p.display()));
            }
        }

        let mut wide: Vec<u16> = Vec::new();
        for p in paths {
            wide.extend(p.as_os_str().encode_wide());
            wide.push(0);
        }
        wide.push(0);

        let header = std::mem::size_of::<DROPFILES>();
        let total = header + wide.len() * 2;

        unsafe {
            OpenClipboard(None).map_err(|e| format!("OpenClipboard: {e}"))?;
            let result = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard: {e}"))?;
                let hmem =
                    GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("GlobalAlloc: {e}"))?;
                let ptr = GlobalLock(hmem);
                if ptr.is_null() {
                    let _ = GlobalFree(hmem);
                    return Err("GlobalLock returned null".into());
                }
                std::ptr::write_bytes(ptr as *mut u8, 0, total);
                let df = ptr as *mut DROPFILES;
                (*df).pFiles = header as u32;
                (*df).fWide = true.into();
                std::ptr::copy_nonoverlapping(
                    wide.as_ptr(),
                    (ptr as *mut u8).add(header) as *mut u16,
                    wide.len(),
                );
                let _ = GlobalUnlock(hmem);
                if let Err(e) = SetClipboardData(CF_HDROP.0 as u32, HANDLE(hmem.0)) {
                    let _ = GlobalFree(hmem);
                    return Err(format!("SetClipboardData: {e}"));
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
        for p in paths {
            if !p.exists() {
                return Err(format!("clip not found: {}", p.display()));
            }
        }
        let names: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        log::info!("[kage] (stub) copied {} to clipboard", names.join(", "));
        Ok(())
    }
}

#[tauri::command]
pub fn simulate_device_loss(state: State<'_, AppState>) {
    state.engine.simulate_device_loss();
}

#[cfg(test)]
mod tests {
    use super::split_at_seconds;

    #[test]
    fn rejects_clips_too_short_to_split() {
        assert!(split_at_seconds(0.4, 0.2).is_err());
        assert!(split_at_seconds(0.3, 0.1).is_err());
        assert!(split_at_seconds(0.0, 0.0).is_err());
    }

    #[test]
    fn passes_through_playheads_inside_the_media() {
        assert_eq!(split_at_seconds(10.0, 5.0).unwrap(), 5.0);
        assert_eq!(split_at_seconds(60.0, 30.0).unwrap(), 30.0);
        assert_eq!(split_at_seconds(10.0, 3.25).unwrap(), 3.25);
    }

    #[test]
    fn clamps_playhead_to_a_minimum_half_length() {
        assert_eq!(split_at_seconds(10.0, 0.0).unwrap(), 0.2);
        assert_eq!(split_at_seconds(10.0, -5.0).unwrap(), 0.2);
        assert_eq!(split_at_seconds(10.0, 9.9).unwrap(), 9.8);
        assert_eq!(split_at_seconds(10.0, 999.0).unwrap(), 9.8);
    }

    #[test]
    fn clamp_keeps_both_halves_inside_the_media() {
        for at in [-100.0, -0.1, 0.0, 0.2, 1.0, 5.0, 9.8, 10.0, 100.0] {
            let cut = split_at_seconds(10.0, at).unwrap();
            assert!(cut >= 0.2);
            assert!(cut <= 9.8);
        }
    }
}
