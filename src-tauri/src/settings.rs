//! User settings. Stored as a single JSON file in the KAGE app-data folder.
//! No cloud, no account, no telemetry: KAGE never opens an outbound socket.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::foreground;
use crate::media::recorder::{default_output_dir, Codec, RecorderConfig};

/// One per-game capture preset. Applying a profile copies its capture values
/// into the global settings; the buffer window applies to the running engine
/// immediately, fps/bitrate/codec on the next engine start.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProfile {
    pub id: String,
    pub name: String,
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
}

/// Maps a foreground executable to a profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMapEntry {
    pub profile_id: String,
    pub exe_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub output_dir: String,
    pub hotkey_save: String,
    pub hotkey_toggle: String,
    #[serde(default = "default_hotkey_record")]
    pub hotkey_record: String,
    pub open_trimmer_after_save: bool,
    pub minimize_to_tray: bool,
    pub autostart_buffer: bool,
    pub play_save_sound: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub profiles: Vec<CaptureProfile>,
    #[serde(default)]
    pub profile_map: Vec<ProfileMapEntry>,
    #[serde(default)]
    pub auto_switch_profiles: bool,
    #[serde(default)]
    pub launch_at_startup: bool,
    #[serde(default)]
    pub auto_cleanup_days: u32,
    #[serde(default = "default_true")]
    pub organize_by_game: bool,
    #[serde(default)]
    pub autosave_on_game_exit: bool,
    #[serde(default = "default_true")]
    pub performance_mode: bool,
    #[serde(default)]
    pub privacy_pause_when_unfocused: bool,
    #[serde(default = "default_100")]
    pub game_volume: u32,
    #[serde(default = "default_100")]
    pub mic_volume: u32,
    #[serde(default)]
    pub mic_device_id: Option<String>,
    #[serde(default)]
    pub adaptive_eco: bool,
    #[serde(default = "default_30")]
    pub eco_battery_threshold_pct: u32,
    #[serde(default = "default_4")]
    pub eco_ram_free_gbs: u32,
}

fn default_hotkey_record() -> String {
    "Alt+R".into()
}

fn default_30() -> u32 {
    30
}

fn default_4() -> u32 {
    4
}

fn default_100() -> u32 {
    100
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_system_audio: true,
            capture_microphone: false,
            output_dir: default_output_dir().to_string_lossy().to_string(),
            hotkey_save: "Alt+C".into(),
            hotkey_toggle: "Alt+Shift+C".into(),
            hotkey_record: default_hotkey_record(),
            open_trimmer_after_save: true,
            minimize_to_tray: true,
            autostart_buffer: true,
            play_save_sound: true,
            always_on_top: false,
            profiles: Vec::new(),
            profile_map: Vec::new(),
            auto_switch_profiles: false,
            launch_at_startup: false,
            auto_cleanup_days: 0,
            organize_by_game: true,
            autosave_on_game_exit: false,
            performance_mode: true,
            privacy_pause_when_unfocused: false,
            game_volume: 100,
            mic_volume: 100,
            mic_device_id: None,
            adaptive_eco: false,
            eco_battery_threshold_pct: 30,
            eco_ram_free_gbs: 4,
        }
    }
}

impl Settings {
    pub fn seed_default_profiles(&mut self) {
        if !self.profiles.is_empty() {
            return;
        }
        self.profiles = vec![
            CaptureProfile {
                id: "default".into(),
                name: "Default".into(),
                buffer_seconds: self.buffer_seconds,
                target_fps: self.target_fps,
                bitrate_kbps: self.bitrate_kbps,
                codec: self.codec,
            },
            CaptureProfile {
                id: "competitivo".into(),
                name: "Competitive".into(),
                buffer_seconds: 30,
                target_fps: 60,
                bitrate_kbps: 12_000,
                codec: Codec::H264,
            },
            CaptureProfile {
                id: "cine".into(),
                name: "Cinema".into(),
                buffer_seconds: 120,
                target_fps: 60,
                bitrate_kbps: 25_000,
                codec: Codec::Hevc,
            },
        ];
    }

    pub fn profile_by_id(&self, id: &str) -> Option<&CaptureProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn profile_for_exe(&self, exe: &str) -> Option<&CaptureProfile> {
        let exe = exe.to_ascii_lowercase();
        self.profile_map
            .iter()
            .find(|m| m.exe_name.to_ascii_lowercase() == exe)
            .and_then(|m| self.profile_by_id(&m.profile_id))
    }

    pub fn active_profile(&self) -> Option<&CaptureProfile> {
        if !self.auto_switch_profiles {
            return None;
        }
        let game = foreground::get_foreground_game()?;
        self.profile_for_exe(&game.exe)
    }

    pub fn apply_profile_values(&mut self, profile: &CaptureProfile) {
        self.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
        self.target_fps = profile.target_fps.clamp(24, 240);
        self.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        self.codec = profile.codec;
    }

    pub fn to_profile_config(&self, profile: &CaptureProfile) -> RecorderConfig {
        let mut cfg = self.to_recorder_config();
        cfg.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
        cfg.target_fps = profile.target_fps.clamp(24, 240);
        cfg.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        cfg.codec = profile.codec;
        self.apply_performance_caps(&mut cfg);
        cfg
    }

    pub fn to_recorder_config(&self) -> RecorderConfig {
        let mut cfg = RecorderConfig {
            buffer_seconds: self.buffer_seconds.clamp(5, 600),
            target_fps: self.target_fps.clamp(24, 240),
            width: 0,
            height: 0,
            max_height: 0,
            performance_mode: self.performance_mode,
            bitrate_kbps: self.bitrate_kbps.clamp(1_000, 150_000),
            codec: self.codec,
            monitor_index: self.monitor_index,
            capture_system_audio: self.capture_system_audio,
            capture_microphone: self.capture_microphone,
            game_volume: self.game_volume.clamp(0, 100),
            mic_volume: self.mic_volume.clamp(0, 100),
            mic_device_id: self.mic_device_id.clone(),
            output_dir: PathBuf::from(&self.output_dir),
            output_subfolder: None,
        };
        self.apply_performance_caps(&mut cfg);
        cfg
    }

    fn apply_performance_caps(&self, cfg: &mut RecorderConfig) {
        if self.performance_mode {
            cfg.target_fps = cfg.target_fps.min(60);
            cfg.max_height = 1080;
            cfg.performance_mode = true;
        } else {
            cfg.max_height = 0;
            cfg.performance_mode = false;
        }
    }

    pub fn config_path() -> PathBuf {
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return PathBuf::from(appdata).join("KAGE").join("settings.json");
            }
        }
        std::env::temp_dir().join("KAGE").join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                log::warn!("[kage] settings parse error ({e}); using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn performance_mode_caps_replay_to_1080p60() {
        let s = Settings {
            performance_mode: true,
            target_fps: 144,
            profiles: vec![CaptureProfile {
                id: "test".into(),
                name: "Test".into(),
                buffer_seconds: 30,
                target_fps: 120,
                bitrate_kbps: 20_000,
                codec: Codec::H264,
            }],
            ..Default::default()
        };

        let cfg = s.to_recorder_config();
        assert_eq!(cfg.target_fps, 60);
        assert_eq!(cfg.max_height, 1080);
        assert!(cfg.performance_mode);

        let profile_cfg = s.to_profile_config(&s.profiles[0]);
        assert_eq!(profile_cfg.target_fps, 60, "profiles must respect Game Mode too");
        assert_eq!(profile_cfg.max_height, 1080);
    }

    #[test]
    fn performance_mode_off_keeps_native_resolution_and_fps() {
        let s = Settings {
            performance_mode: false,
            target_fps: 144,
            ..Default::default()
        };

        let cfg = s.to_recorder_config();
        assert_eq!(cfg.target_fps, 144);
        assert_eq!(cfg.max_height, 0);
        assert!(!cfg.performance_mode);
    }

    #[test]
    fn default_hotkey_record_is_alt_r() {
        let s = Settings::default();
        assert_eq!(s.hotkey_record, "Alt+R");
    }
}
