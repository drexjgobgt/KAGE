/**
 * TypeScript mirrors of the Rust structs in `src-tauri/src/media/*` and
 * `src-tauri/src/settings.rs`.
 */

export type EncoderVendor =
  | "nvenc"
  | "amd-amf"
  | "intel-qsv"
  | "media-foundation-software"
  | "unavailable";

export type EngineStateName =
  | "idle"
  | "starting"
  | "buffering"
  | "flushing"
  | "recovering"
  | "error";

export interface EncoderInfo {
  vendor: EncoderVendor;
  friendly_name: string;
  codec: string;
  hardware: boolean;
  adapter_name: string;
  dedicated_vram_mb: number;
}

export interface EngineStats {
  state: EngineStateName;
  encoder: EncoderInfo;
  width: number;
  height: number;
  target_fps: number;
  bitrate_kbps: number;
  performance_mode: boolean;
  integrated_gpu: boolean;
  capture_fps: number;
  buffer_seconds: number;
  buffered_seconds: number;
  ring_bytes: number;
  ring_frames: number;
  process_rss_bytes: number;
  encode_ms_avg: number;
  gpu_submit_ms_avg: number;
  dropped_frames: number;
  device_resets: number;
  audio_system: boolean;
  audio_mic: boolean;
  audio_drift_ms: number;
  audio_error: string | null;
  privacy_active: boolean;
  uptime_seconds: number;
  last_error: string | null;
  recording_active: boolean;
  recording_seconds: number;
  recording_bytes: number;
  recording_path: string | null;
}

export interface ClipMetadata {
  id: string;
  path: string;
  file_name: string;
  title: string;
  duration_seconds: number;
  size_bytes: number;
  created_unix_ms: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  game: string | null;
  thumbnail: string | null;
  favorite: boolean;
  tags: string[];
  preview_url?: string;
}

export interface TrimResult {
  path: string;
  file_name: string;
  duration_seconds: number;
  size_bytes: number;
  elapsed_ms: number;
  snapped_start_seconds: number;
}

export interface SplitResult {
  partA: TrimResult;
  partB: TrimResult;
}

export interface ClipSavedPayload {
  clip: ClipMetadata;
  flushMs: number;
  triggeredBy: "hotkey" | "record-hotkey" | "record-ui" | "ui" | "tray" | string;
  openTrimmer?: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  refresh_hz: number;
  primary: boolean;
  adapter: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AppSettings {
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
  monitorIndex: number;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  outputDir: string;
  hotkeySave: string;
  hotkeyToggle: string;
  hotkeyRecord: string;
  openTrimmerAfterSave: boolean;
  minimizeToTray: boolean;
  autostartBuffer: boolean;
  playSaveSound: boolean;
  alwaysOnTop: boolean;
  profiles: CaptureProfile[];
  profileMap: ProfileMapEntry[];
  autoSwitchProfiles: boolean;
  launchAtStartup: boolean;
  autoCleanupDays: number;
  organizeByGame: boolean;
  autosaveOnGameExit: boolean;
  performanceMode: boolean;
  privacyPauseWhenUnfocused: boolean;
  gameVolume: number;
  micVolume: number;
  micDeviceId?: string | null;
  adaptiveEco: boolean;
  ecoBatteryThresholdPct: number;
  ecoRamFreeGbs: number;
}

export interface PowerState {
  onBattery: boolean;
  batteryPercent: number;
  availableRamBytes: number;
  totalRamBytes: number;
}

export interface CaptureProfile {
  id: string;
  name: string;
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
}

export interface ProfileMapEntry {
  profileId: string;
  exeName: string;
}

export interface ForegroundGame {
  exe: string;
  title: string;
}

export const VENDOR_LABEL: Record<EncoderVendor, string> = {
  nvenc: "NVIDIA NVENC",
  "amd-amf": "AMD AMF",
  "intel-qsv": "Intel Quick Sync",
  "media-foundation-software": "MF Software",
  unavailable: "Unavailable",
};
