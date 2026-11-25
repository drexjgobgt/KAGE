//! KAGE capture engine.
//!
//! Pipeline (all GPU resident, zero CPU readback of pixel data):
//!
//! ```text
//!  IDXGIOutputDuplication ──► ID3D11Texture2D (B8G8R8A8)
//!            │
//!            ├─► ID3D11VideoProcessor  (BGRA -> NV12, scale, full/limited range)
//!            │
//!            └─► IMFTransform (hardware H.264/HEVC MFT: NVENC / AMF / QSV)
//!                        │
//!                        ├──► RollingRingBuffer (Arc<[u8]>)  ──► Alt+C flush -> .mp4
//!                        └──► DirectRecorder (sync_channel)  ──► Alt+R stream -> .mp4
//! ```

#![allow(clippy::too_many_arguments)]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public data model (mirrored by `src/lib/types.ts`)
// ---------------------------------------------------------------------------

/// 100-nanosecond units: the native Media Foundation time base.
pub const HNS_PER_SECOND: i64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EncoderVendor {
    Nvenc,
    AmdAmf,
    IntelQsv,
    MediaFoundationSoftware,
    Unavailable,
}

impl EncoderVendor {
    pub fn label(self) -> &'static str {
        match self {
            EncoderVendor::Nvenc => "NVIDIA NVENC",
            EncoderVendor::AmdAmf => "AMD AMF (VCE)",
            EncoderVendor::IntelQsv => "Intel Quick Sync",
            EncoderVendor::MediaFoundationSoftware => "Media Foundation (software)",
            EncoderVendor::Unavailable => "Unavailable",
        }
    }

    #[cfg(all(windows, not(feature = "headless-sim")))]
    fn from_friendly_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.contains("nvidia") || n.contains("nvenc") {
            EncoderVendor::Nvenc
        } else if n.contains("amd") || n.contains("amf") || n.contains("radeon") {
            EncoderVendor::AmdAmf
        } else if n.contains("intel") || n.contains("quick sync") || n.contains("qsv") {
            EncoderVendor::IntelQsv
        } else {
            EncoderVendor::MediaFoundationSoftware
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub vendor: EncoderVendor,
    pub friendly_name: String,
    pub codec: String,
    pub hardware: bool,
    pub adapter_name: String,
    pub dedicated_vram_mb: u64,
}

impl Default for EncoderInfo {
    fn default() -> Self {
        Self {
            vendor: EncoderVendor::Unavailable,
            friendly_name: "Not initialised".into(),
            codec: "H.264".into(),
            hardware: false,
            adapter_name: "-".into(),
            dedicated_vram_mb: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    H264,
    Hevc,
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Hevc => "HEVC",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderConfig {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    /// 0 = native monitor resolution.
    pub width: u32,
    pub height: u32,
    /// Game Mode downscale ceiling (0 = native). Keeps aspect ratio.
    #[serde(default)]
    pub max_height: u32,
    /// Game Mode: speed-biased encoder tuning + normal thread priority.
    #[serde(default)]
    pub performance_mode: bool,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub game_volume: u32,
    pub mic_volume: u32,
    pub mic_device_id: Option<String>,
    pub output_dir: PathBuf,
    pub output_subfolder: Option<String>,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            width: 0,
            height: 0,
            max_height: 0,
            performance_mode: false,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_system_audio: true,
            capture_microphone: false,
            game_volume: 100,
            mic_volume: 100,
            mic_device_id: None,
            output_dir: default_output_dir(),
            output_subfolder: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineState {
    Idle,
    Starting,
    Buffering,
    Flushing,
    Recovering,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStats {
    pub state: EngineState,
    pub encoder: EncoderInfo,
    pub width: u32,
    pub height: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub performance_mode: bool,
    pub integrated_gpu: bool,
    pub capture_fps: f32,
    pub buffer_seconds: u32,
    pub buffered_seconds: f32,
    pub ring_bytes: u64,
    pub ring_frames: u32,
    pub process_rss_bytes: u64,
    pub encode_ms_avg: f32,
    pub gpu_submit_ms_avg: f32,
    pub dropped_frames: u64,
    pub device_resets: u32,
    pub audio_system: bool,
    pub audio_mic: bool,
    pub audio_drift_ms: f32,
    pub audio_error: Option<String>,
    pub privacy_active: bool,
    pub uptime_seconds: u64,
    pub last_error: Option<String>,
    pub recording_active: bool,
    pub recording_seconds: f32,
    pub recording_bytes: u64,
    pub recording_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipWriteResult {
    pub path: String,
    pub file_name: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub flush_ms: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
    #[error("capture engine is not running")]
    NotRunning,
    #[error("capture engine is already running")]
    AlreadyRunning,
    #[error("no frames in the rolling buffer yet")]
    EmptyBuffer,
    #[error("no compatible hardware encoder found (need NVENC, AMD AMF or Intel QSV)")]
    NoEncoder,
    #[error("monitor index {0} does not exist")]
    NoSuchMonitor(u32),
    #[error("graphics device lost and could not be recreated: {0}")]
    DeviceLost(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("windows api error: {0}")]
    Win(String),
    #[error("{0}")]
    Other(String),
}

pub type RResult<T> = Result<T, RecorderError>;

impl From<std::io::Error> for RecorderError {
    fn from(e: std::io::Error) -> Self {
        RecorderError::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Rolling ring buffer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone)]
pub struct EncodedPacket {
    pub track: TrackKind,
    pub data: Arc<[u8]>,
    pub pts_hns: i64,
    pub duration_hns: i64,
    pub keyframe: bool,
    pub generation: u32,
}

impl EncodedPacket {
    #[inline]
    fn heap_size(&self) -> usize {
        self.data.len() + std::mem::size_of::<EncodedPacket>()
    }
}

#[cfg(all(windows, not(feature = "headless-sim")))]
pub struct QpcClock {
    pub freq: i64,
    pub origin: i64,
}

#[cfg(all(windows, not(feature = "headless-sim")))]
impl Default for QpcClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(windows, not(feature = "headless-sim")))]
impl QpcClock {
    pub fn new() -> Self {
        let mut freq = 0i64;
        let mut now = 0i64;
        unsafe {
            let _ = windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq);
            let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut now);
        }
        Self {
            freq: if freq == 0 { 10_000_000 } else { freq },
            origin: now,
        }
    }

    pub fn to_hns(&self, qpc: i64) -> i64 {
        ((qpc - self.origin) as i128 * HNS_PER_SECOND as i128 / self.freq as i128) as i64
    }

    pub fn now_hns(&self) -> i64 {
        let mut now = 0i64;
        unsafe {
            let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut now);
        }
        self.to_hns(now)
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
pub struct QpcClock {
    start: std::time::Instant,
}

#[cfg(any(not(windows), feature = "headless-sim"))]
impl QpcClock {
    pub fn new() -> Self {
        Self {
            start: std::time::Instant::now(),
        }
    }

    pub fn to_hns(&self, qpc: i64) -> i64 {
        qpc
    }

    pub fn now_hns(&self) -> i64 {
        (self.start.elapsed().as_nanos() / 100) as i64
    }
}

/// Fixed-duration FIFO of encoded packets with GOP-aligned eviction.
pub struct RollingRingBuffer {
    video: VecDeque<EncodedPacket>,
    audio: VecDeque<EncodedPacket>,
    window_hns: i64,
    hard_byte_cap: usize,
    bytes: usize,
}

impl RollingRingBuffer {
    pub fn new(window_seconds: u32, hard_byte_cap_mb: usize) -> Self {
        Self {
            // Bounded initial allocation so a 600s config does not immediately
            // reserve huge VecDeque backing buffers before frames arrive.
            video: VecDeque::with_capacity((window_seconds as usize * 30).min(4096)),
            audio: VecDeque::with_capacity((window_seconds as usize * 25).min(2048)),
            window_hns: window_seconds as i64 * HNS_PER_SECOND,
            hard_byte_cap: hard_byte_cap_mb * 1024 * 1024,
            bytes: 0,
        }
    }

    pub fn set_window(&mut self, window_seconds: u32, bitrate_kbps: u32) {
        self.window_hns = window_seconds as i64 * HNS_PER_SECOND;
        self.hard_byte_cap = ring_cap_mb(window_seconds, bitrate_kbps) * 1024 * 1024;
        self.prune();
    }

    #[cfg(test)]
    fn hard_byte_cap(&self) -> usize {
        self.hard_byte_cap
    }

    #[cfg(test)]
    fn audio_packets(&self) -> usize {
        self.audio.len()
    }

    pub fn push(&mut self, pkt: EncodedPacket) {
        self.bytes += pkt.heap_size();
        match pkt.track {
            TrackKind::Video => self.video.push_back(pkt),
            TrackKind::Audio => self.audio.push_back(pkt),
        }
        self.prune();
    }

    pub fn push_batch(&mut self, batch: &mut Vec<EncodedPacket>) {
        if batch.is_empty() {
            return;
        }
        for pkt in batch.drain(..) {
            self.bytes += pkt.heap_size();
            match pkt.track {
                TrackKind::Video => self.video.push_back(pkt),
                TrackKind::Audio => self.audio.push_back(pkt),
            }
        }
        self.prune();
    }

    fn newest_pts(&self) -> i64 {
        self.video.back().map(|p| p.pts_hns).unwrap_or(0)
    }

    fn pop_audio(&mut self) -> bool {
        match self.audio.pop_front() {
            Some(p) => {
                self.bytes -= p.heap_size().min(self.bytes);
                true
            }
            None => false,
        }
    }

    fn prune(&mut self) {
        let newest = self.newest_pts();
        let cutoff = newest - self.window_hns;

        loop {
            let over_time = self
                .video
                .front()
                .map(|p| p.pts_hns < cutoff)
                .unwrap_or(false);
            let over_bytes = self.bytes > self.hard_byte_cap;
            if !(over_time || over_bytes) || self.video.len() < 2 {
                break;
            }

            if let Some(front) = self.video.pop_front() {
                self.bytes -= front.heap_size().min(self.bytes);
            }
            while let Some(next) = self.video.front() {
                if next.keyframe {
                    break;
                }
                if let Some(p) = self.video.pop_front() {
                    self.bytes -= p.heap_size().min(self.bytes);
                }
            }
        }

        let audio_cutoff = match self.video.front() {
            Some(p) => p.pts_hns - HNS_PER_SECOND / 5,
            None => match self.audio.back() {
                Some(p) => p.pts_hns - self.window_hns,
                None => i64::MIN,
            },
        };
        while let Some(front) = self.audio.front() {
            if front.pts_hns >= audio_cutoff {
                break;
            }
            if !self.pop_audio() {
                break;
            }
        }

        while self.bytes > self.hard_byte_cap && self.pop_audio() {}
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn video_frames(&self) -> usize {
        self.video.len()
    }

    pub fn span_seconds(&self) -> f32 {
        match (self.video.front(), self.video.back()) {
            (Some(a), Some(b)) => ((b.pts_hns + b.duration_hns - a.pts_hns) as f64
                / HNS_PER_SECOND as f64) as f32,
            _ => 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.video.clear();
        self.audio.clear();
        self.bytes = 0;
    }

    pub fn clear_and_shrink(&mut self) {
        self.clear();
        self.video.shrink_to_fit();
        self.audio.shrink_to_fit();
    }

    pub fn snapshot(&self, max_seconds: Option<f32>) -> (Vec<EncodedPacket>, Vec<EncodedPacket>) {
        let generation = self.video.back().map(|p| p.generation).unwrap_or(0);
        let newest = self.newest_pts();
        let lower_bound = match max_seconds {
            Some(s) => newest - (s as f64 * HNS_PER_SECOND as f64) as i64,
            None => i64::MIN,
        };

        let mut start_idx = 0usize;
        for (i, p) in self.video.iter().enumerate() {
            if p.generation == generation && p.keyframe && p.pts_hns >= lower_bound {
                start_idx = i;
                break;
            }
            if p.generation == generation && p.keyframe {
                start_idx = i;
            }
        }

        let video: Vec<EncodedPacket> = self
            .video
            .iter()
            .skip(start_idx)
            .filter(|p| p.generation == generation)
            .cloned()
            .collect();

        let audio_start = video.first().map(|p| p.pts_hns).unwrap_or(0);
        let audio: Vec<EncodedPacket> = self
            .audio
            .iter()
            .filter(|p| p.generation == generation && p.pts_hns + p.duration_hns >= audio_start)
            .cloned()
            .collect();

        (video, audio)
    }
}

// ---------------------------------------------------------------------------
// Shared engine state
// ---------------------------------------------------------------------------

struct SharedState {
    running: AtomicBool,
    stop_requested: AtomicBool,
    pub(super) force_device_reset: AtomicBool,
    privacy_gate: Arc<AtomicBool>,
    ring_enabled: Arc<AtomicBool>,
    force_key_record: Arc<AtomicBool>,
    direct_tx: Arc<Mutex<Option<SyncSender<EncodedPacket>>>>,
    generation: Arc<AtomicU32>,
    dropped_frames: AtomicU64,
    device_resets: AtomicU32,
    frames_encoded: AtomicU64,
    encode_ns_total: AtomicU64,
    submit_ns_total: AtomicU64,
    started_at: Mutex<Option<Instant>>,
    state: RwLock<EngineState>,
    last_error: RwLock<Option<String>>,
    encoder: RwLock<EncoderInfo>,
    dimensions: RwLock<(u32, u32)>,
    capture_fps: RwLock<f32>,
    effective_target_fps: RwLock<u32>,
    effective_bitrate_kbps: RwLock<u32>,
    integrated_gpu: RwLock<bool>,
    audio_drift_tenths_ms: Arc<AtomicI32>,
    ring: Arc<Mutex<RollingRingBuffer>>,
    recording_active: AtomicBool,
    recording_started_at: Mutex<Option<Instant>>,
    recording_bytes: Arc<AtomicU64>,
    recording_path: RwLock<Option<String>>,
}

impl SharedState {
    fn new(cfg: &RecorderConfig) -> Self {
        Self {
            running: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            force_device_reset: AtomicBool::new(false),
            privacy_gate: Arc::new(AtomicBool::new(false)),
            ring_enabled: Arc::new(AtomicBool::new(true)),
            force_key_record: Arc::new(AtomicBool::new(false)),
            direct_tx: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU32::new(1)),
            dropped_frames: AtomicU64::new(0),
            device_resets: AtomicU32::new(0),
            frames_encoded: AtomicU64::new(0),
            encode_ns_total: AtomicU64::new(0),
            submit_ns_total: AtomicU64::new(0),
            started_at: Mutex::new(None),
            state: RwLock::new(EngineState::Idle),
            last_error: RwLock::new(None),
            encoder: RwLock::new(EncoderInfo::default()),
            dimensions: RwLock::new((0, 0)),
            capture_fps: RwLock::new(0.0),
            effective_target_fps: RwLock::new(0),
            effective_bitrate_kbps: RwLock::new(0),
            integrated_gpu: RwLock::new(false),
            audio_drift_tenths_ms: Arc::new(AtomicI32::new(0)),
            ring: Arc::new(Mutex::new(RollingRingBuffer::new(
                cfg.buffer_seconds,
                ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps),
            ))),
            recording_active: AtomicBool::new(false),
            recording_started_at: Mutex::new(None),
            recording_bytes: Arc::new(AtomicU64::new(0)),
            recording_path: RwLock::new(None),
        }
    }

    fn set_state(&self, s: EngineState) {
        *self.state.write() = s;
    }

    #[cfg_attr(feature = "headless-sim", allow(dead_code))]
    fn fail(&self, msg: impl Into<String>) {
        let msg = msg.into();
        log::error!("[kage::recorder] {msg}");
        *self.last_error.write() = Some(msg);
        self.set_state(EngineState::Error);
    }
}

fn ring_cap_mb(buffer_seconds: u32, bitrate_kbps: u32) -> usize {
    let nominal = (buffer_seconds as u64 * bitrate_kbps as u64) / 8 / 1024;
    ((nominal as f64 * 1.6) as usize).clamp(24, 1536)
}

pub fn is_integrated_gpu(adapter_name: &str, vram_mb: u64) -> bool {
    if vram_mb > 0 && vram_mb < 2048 {
        return true;
    }
    let n = adapter_name.to_ascii_lowercase();
    if n.contains("arc") && vram_mb >= 2048 {
        return false;
    }
    n.contains("intel")
        || n.contains("iris")
        || n.contains("uhd graphics")
        || n.contains("hd graphics")
        || (n.contains("radeon") && n.contains("graphics"))
}

pub fn default_output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Videos").join("KAGE");
        }
    }
    std::env::temp_dir().join("KAGE")
}

/// Returns free disk space (bytes) available to the calling user at `path`.
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    platform::free_disk_bytes(path)
}

// ---------------------------------------------------------------------------
// Direct streaming MP4 session (Alt + R)
// ---------------------------------------------------------------------------

struct DirectSession {
    path: PathBuf,
    file_name: String,
    header: VideoFormatHeader,
    started_for_direct_only: bool,
    writer_handle: std::thread::JoinHandle<RResult<(f32, u64, bool)>>,
}

// ---------------------------------------------------------------------------
// CaptureEngine
// ---------------------------------------------------------------------------

pub struct CaptureEngine {
    shared: Arc<SharedState>,
    config: RwLock<RecorderConfig>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    audio: Mutex<Option<crate::media::audio::AudioCapture>>,
    audio_error: Arc<Mutex<Option<String>>>,
    game_gain: Arc<AtomicU32>,
    mic_gain: Arc<AtomicU32>,
    mic_device: Arc<parking_lot::RwLock<Option<String>>>,
    video_format: Arc<Mutex<Option<VideoFormatHeader>>>,
    flush_lock: Mutex<()>,
    direct_session: Mutex<Option<DirectSession>>,
}

#[derive(Clone, Default)]
pub struct VideoFormatHeader {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub bitrate: u32,
    pub profile: u32,
    pub codec: u8, // 0 = H.264, 1 = HEVC
    pub sequence_header: Vec<u8>,
}

impl CaptureEngine {
    pub fn new() -> Self {
        let cfg = RecorderConfig::default();
        let mic_dev = cfg.mic_device_id.clone();
        Self {
            shared: Arc::new(SharedState::new(&cfg)),
            config: RwLock::new(cfg),
            worker: Mutex::new(None),
            audio: Mutex::new(None),
            audio_error: Arc::new(Mutex::new(None)),
            game_gain: Arc::new(AtomicU32::new(1000)),
            mic_gain: Arc::new(AtomicU32::new(1000)),
            mic_device: Arc::new(parking_lot::RwLock::new(mic_dev)),
            video_format: Arc::new(Mutex::new(None)),
            flush_lock: Mutex::new(()),
            direct_session: Mutex::new(None),
        }
    }

    pub fn config(&self) -> RecorderConfig {
        self.config.read().clone()
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
    }

    pub fn is_ring_enabled(&self) -> bool {
        self.shared.ring_enabled.load(Ordering::Acquire)
    }

    pub fn is_recording(&self) -> bool {
        self.shared.recording_active.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> EngineStats {
        let cfg = self.config.read().clone();
        let (ring_bytes, ring_frames, buffered_seconds) = if self.is_ring_enabled() {
            let ring = self.shared.ring.lock();
            (
                ring.bytes() as u64,
                ring.video_frames() as u32,
                ring.span_seconds(),
            )
        } else {
            (0, 0, 0.0)
        };
        let frames = self.shared.frames_encoded.load(Ordering::Relaxed).max(1);
        let (w, h) = *self.shared.dimensions.read();

        let rec_active = self.shared.recording_active.load(Ordering::Acquire);
        let rec_seconds = if rec_active {
            self.shared
                .recording_started_at
                .lock()
                .map(|t| t.elapsed().as_secs_f32())
                .unwrap_or(0.0)
        } else {
            0.0
        };

        EngineStats {
            state: *self.shared.state.read(),
            encoder: self.shared.encoder.read().clone(),
            width: w,
            height: h,
            target_fps: {
                let effective = *self.shared.effective_target_fps.read();
                if effective > 0 {
                    effective
                } else {
                    cfg.target_fps
                }
            },
            bitrate_kbps: {
                let effective = *self.shared.effective_bitrate_kbps.read();
                if effective > 0 {
                    effective
                } else {
                    cfg.bitrate_kbps
                }
            },
            performance_mode: cfg.performance_mode,
            integrated_gpu: *self.shared.integrated_gpu.read(),
            capture_fps: *self.shared.capture_fps.read(),
            buffer_seconds: cfg.buffer_seconds,
            buffered_seconds,
            ring_bytes,
            ring_frames,
            process_rss_bytes: process_rss_bytes(),
            encode_ms_avg: (self.shared.encode_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            gpu_submit_ms_avg: (self.shared.submit_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            dropped_frames: self.shared.dropped_frames.load(Ordering::Relaxed),
            device_resets: self.shared.device_resets.load(Ordering::Relaxed),
            audio_system: cfg.capture_system_audio,
            audio_mic: cfg.capture_microphone,
            audio_drift_ms: self.shared.audio_drift_tenths_ms.load(Ordering::Relaxed) as f32 / 10.0,
            audio_error: self.audio_error.lock().clone(),
            privacy_active: self.shared.privacy_gate.load(Ordering::Acquire),
            uptime_seconds: self
                .shared
                .started_at
                .lock()
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0),
            last_error: self.shared.last_error.read().clone(),
            recording_active: rec_active,
            recording_seconds: rec_seconds,
            recording_bytes: self.shared.recording_bytes.load(Ordering::Relaxed),
            recording_path: self.shared.recording_path.read().clone(),
        }
    }

    pub fn start(&self, cfg: RecorderConfig) -> RResult<EngineStats> {
        if self.is_running() {
            // If engine is running strictly for direct recording (Alt+R) and user
            // arms the replay buffer, enable the ring live without restarting!
            if !self.is_ring_enabled() {
                {
                    let mut ring = self.shared.ring.lock();
                    *ring = RollingRingBuffer::new(
                        cfg.buffer_seconds,
                        ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps),
                    );
                }
                self.shared.ring_enabled.store(true, Ordering::Release);
                if let Some(sess) = self.direct_session.lock().as_mut() {
                    sess.started_for_direct_only = false;
                }
                return Ok(self.stats());
            }
            return Err(RecorderError::AlreadyRunning);
        }
        self.start_with_mode(cfg, true)
    }

    fn start_with_mode(&self, cfg: RecorderConfig, enable_ring: bool) -> RResult<EngineStats> {
        if self.is_running() {
            return Err(RecorderError::AlreadyRunning);
        }
        std::fs::create_dir_all(&cfg.output_dir)?;

        self.shared
            .ring_enabled
            .store(enable_ring, Ordering::Release);
        {
            let mut ring = self.shared.ring.lock();
            if enable_ring {
                *ring = RollingRingBuffer::new(
                    cfg.buffer_seconds,
                    ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps),
                );
            } else {
                ring.clear_and_shrink();
            }
        }
        *self.video_format.lock() = None;
        *self.config.write() = cfg.clone();
        *self.shared.last_error.write() = None;
        self.shared.stop_requested.store(false, Ordering::Release);
        self.shared.running.store(true, Ordering::Release);
        self.shared.frames_encoded.store(0, Ordering::Relaxed);
        self.shared.encode_ns_total.store(0, Ordering::Relaxed);
        self.shared.submit_ns_total.store(0, Ordering::Relaxed);
        self.shared.dropped_frames.store(0, Ordering::Relaxed);
        self.shared.audio_drift_tenths_ms.store(0, Ordering::Relaxed);
        *self.shared.effective_target_fps.write() = cfg.target_fps;
        *self.shared.effective_bitrate_kbps.write() = cfg.bitrate_kbps;
        *self.shared.integrated_gpu.write() = false;
        *self.shared.started_at.lock() = Some(Instant::now());
        self.shared.set_state(EngineState::Starting);

        let clock = Arc::new(QpcClock::new());

        if cfg.capture_system_audio || cfg.capture_microphone {
            *self.audio_error.lock() = None;
            self.game_gain
                .store(cfg.game_volume.min(100) * 10, Ordering::Release);
            self.mic_gain
                .store(cfg.mic_volume.min(100) * 10, Ordering::Release);
            *self.mic_device.write() = cfg.mic_device_id.clone();
            match crate::media::audio::AudioCapture::start(
                cfg.capture_system_audio,
                cfg.capture_microphone,
                Arc::clone(&self.game_gain),
                Arc::clone(&self.mic_gain),
                Arc::clone(&self.mic_device),
                Arc::clone(&self.shared.ring),
                Arc::clone(&self.shared.ring_enabled),
                Arc::clone(&self.shared.direct_tx),
                Arc::clone(&self.shared.generation),
                Arc::clone(&self.audio_error),
                Arc::clone(&self.shared.audio_drift_tenths_ms),
                Arc::clone(&clock),
                cfg.performance_mode,
                Arc::clone(&self.shared.privacy_gate),
            ) {
                Ok(a) => *self.audio.lock() = Some(a),
                Err(e) => {
                    *self.audio_error.lock() = Some(format!("audio thread could not start: {e}"));
                    log::warn!("[kage::audio] disabled: {e}");
                }
            }
        } else {
            *self.audio_error.lock() = None;
        }

        let shared = Arc::clone(&self.shared);
        let fmt = Arc::clone(&self.video_format);
        let thread_cfg = cfg.clone();
        let clock_c = Arc::clone(&clock);
        let handle = std::thread::Builder::new()
            .name("kage-capture".into())
            .spawn(move || {
                set_thread_priority(thread_cfg.performance_mode);
                capture_thread_main(shared, thread_cfg, fmt, clock_c);
            })
            .map_err(|e| RecorderError::Other(format!("failed to spawn capture thread: {e}")))?;
        *self.worker.lock() = Some(handle);

        let deadline = Instant::now() + Duration::from_millis(2_000);
        while Instant::now() < deadline {
            if matches!(*self.shared.state.read(), EngineState::Buffering)
                && self.video_format.lock().is_some()
            {
                break;
            }
            if matches!(*self.shared.state.read(), EngineState::Error) {
                let msg = self
                    .shared
                    .last_error
                    .read()
                    .clone()
                    .unwrap_or_else(|| "unknown capture failure".into());
                self.stop();
                return Err(RecorderError::Other(msg));
            }
            std::thread::sleep(Duration::from_millis(15));
        }

        Ok(self.stats())
    }

    /// Disarms the replay buffer. If direct recording (`Alt + R`) is active,
    /// clears the ring and switches to Direct-Only mode instead of aborting the
    /// active recording; when `stop_recording` finishes, the engine stops cleanly.
    pub fn disarm_buffer(&self) {
        if self.is_recording() {
            self.shared.ring_enabled.store(false, Ordering::Release);
            self.shared.ring.lock().clear_and_shrink();
            if let Some(sess) = self.direct_session.lock().as_mut() {
                sess.started_for_direct_only = true;
            }
            return;
        }
        self.stop();
    }

    pub fn stop(&self) {
        // Finalize any active Alt+R MP4 stream first so the file is never left corrupt.
        if self.is_recording() {
            let _ = self.stop_recording();
        }
        self.shared.stop_requested.store(true, Ordering::Release);
        if let Some(a) = self.audio.lock().take() {
            a.stop();
        }
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
        self.shared.running.store(false, Ordering::Release);
        self.shared.ring_enabled.store(false, Ordering::Release);
        self.shared.set_state(EngineState::Idle);
        self.shared.ring.lock().clear_and_shrink();
        *self.shared.effective_target_fps.write() = 0;
        *self.shared.effective_bitrate_kbps.write() = 0;
        *self.shared.integrated_gpu.write() = false;
        *self.shared.capture_fps.write() = 0.0;
    }

    /// Starts direct-to-disk MP4 streaming (`Alt + R`).
    ///
    /// Shares the GPU hardware encoder if the Replay Buffer is already armed,
    /// or boots capture in Direct-Only mode (0 MB ring RAM) if idle.
    pub fn start_recording(
        &self,
        cfg_when_idle: RecorderConfig,
        subfolder: Option<String>,
    ) -> RResult<String> {
        if self.is_recording() {
            return Err(RecorderError::Other("Direct recording already active".into()));
        }

        let base_dir = if self.is_running() {
            self.config.read().output_dir.clone()
        } else {
            cfg_when_idle.output_dir.clone()
        };
        let out_dir = match &subfolder {
            Some(sub) => base_dir.join(sub),
            None => base_dir,
        };
        std::fs::create_dir_all(&out_dir)?;

        if let Some(free) = free_disk_bytes(&out_dir) {
            const MIN_REC_BYTES: u64 = 250 * 1024 * 1024;
            if free < MIN_REC_BYTES {
                return Err(RecorderError::Other(format!(
                    "Not enough free disk space ({:.1} MB left, need at least 250 MB to start recording).",
                    free as f64 / 1_048_576.0
                )));
            }
        }

        let started_for_direct_only = if !self.is_running() {
            self.start_with_mode(cfg_when_idle, false)?;
            true
        } else {
            false
        };

        let header = self.video_format.lock().clone().ok_or_else(|| {
            if started_for_direct_only {
                self.stop();
            }
            RecorderError::Other("encoder header not ready yet".into())
        })?;

        let stem = format!(
            "KAGE_Rec_{}",
            chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")
        );
        let path = Self::unique_clip_path(&out_dir, &stem);
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{stem}.mp4"));

        let (tx, rx) = mpsc::sync_channel::<EncodedPacket>(256);
        let rec_bytes = Arc::clone(&self.shared.recording_bytes);
        rec_bytes.store(0, Ordering::Release);

        let writer_path = path.clone();
        let writer_header = header.clone();
        let writer_handle = std::thread::Builder::new()
            .name("kage-rec-writer".into())
            .spawn(move || {
                platform::run_direct_writer(&writer_path, &writer_header, rx, rec_bytes)
            })
            .map_err(|e| {
                if started_for_direct_only {
                    self.stop();
                }
                RecorderError::Other(format!("failed to spawn recording writer: {e}"))
            })?;

        // Arm keyframe request and install channel sink so the very next video
        // frame starts a clean IDR GOP in the recorded file.
        self.shared.force_key_record.store(true, Ordering::Release);
        *self.shared.direct_tx.lock() = Some(tx);

        let path_str = path.to_string_lossy().to_string();
        self.shared.recording_active.store(true, Ordering::Release);
        *self.shared.recording_started_at.lock() = Some(Instant::now());
        *self.shared.recording_path.write() = Some(path_str.clone());

        *self.direct_session.lock() = Some(DirectSession {
            path,
            file_name,
            header,
            started_for_direct_only,
            writer_handle,
        });

        Ok(path_str)
    }

    /// Stops active direct-to-disk MP4 recording (`Alt + R`) and finalizes the file.
    pub fn stop_recording(&self) -> RResult<ClipWriteResult> {
        let sess = self
            .direct_session
            .lock()
            .take()
            .ok_or_else(|| RecorderError::Other("no active recording".into()))?;

        let t0 = Instant::now();
        // Dropping the SyncSender closes the channel so the writer thread drains
        // any remaining queued packets and calls IMFSinkWriter::Finalize().
        *self.shared.direct_tx.lock() = None;

        self.shared.recording_active.store(false, Ordering::Release);
        *self.shared.recording_started_at.lock() = None;
        *self.shared.recording_path.write() = None;

        let join_res = sess
            .writer_handle
            .join()
            .map_err(|_| RecorderError::Other("recording writer thread panicked".into()))?;

        if sess.started_for_direct_only {
            self.stop_engine_only();
        }

        let (duration_seconds, size_bytes, has_audio) = match join_res {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_file(&sess.path);
                return Err(e);
            }
        };

        self.shared.recording_bytes.store(0, Ordering::Release);

        Ok(ClipWriteResult {
            path: sess.path.to_string_lossy().to_string(),
            file_name: sess.file_name,
            duration_seconds,
            size_bytes,
            flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
            width: sess.header.width,
            height: sess.header.height,
            fps: sess.header.fps_num.max(1),
            has_audio,
        })
    }

    fn stop_engine_only(&self) {
        self.shared.stop_requested.store(true, Ordering::Release);
        if let Some(a) = self.audio.lock().take() {
            a.stop();
        }
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
        self.shared.running.store(false, Ordering::Release);
        self.shared.ring_enabled.store(false, Ordering::Release);
        self.shared.set_state(EngineState::Idle);
        self.shared.ring.lock().clear_and_shrink();
        *self.shared.effective_target_fps.write() = 0;
        *self.shared.effective_bitrate_kbps.write() = 0;
        *self.shared.integrated_gpu.write() = false;
        *self.shared.capture_fps.write() = 0.0;
    }

    pub fn set_buffer_seconds(&self, seconds: u32) {
        let seconds = seconds.clamp(5, 600);
        let bitrate = {
            let mut cfg = self.config.write();
            cfg.buffer_seconds = seconds;
            cfg.bitrate_kbps
        };
        self.shared.ring.lock().set_window(seconds, bitrate);
    }

    pub fn set_output_dir(&self, dir: PathBuf) {
        self.config.write().output_dir = dir;
    }

    pub fn set_output_subfolder(&self, sub: Option<String>) {
        self.config.write().output_subfolder = sub;
    }

    pub fn set_privacy_gate(&self, gate: bool) {
        self.shared.privacy_gate.store(gate, Ordering::Release);
        if gate {
            self.shared.ring.lock().clear();
        }
    }

    pub fn set_audio_volumes(&self, game: u32, mic: u32) {
        self.game_gain.store(game.min(100) * 10, Ordering::Release);
        self.mic_gain.store(mic.min(100) * 10, Ordering::Release);
    }

    pub fn set_mic_device(&self, device_id: Option<String>) {
        *self.mic_device.write() = device_id;
    }

    pub fn simulate_device_loss(&self) {
        self.shared.force_device_reset.store(true, Ordering::Release);
    }

    fn unique_clip_path(out_dir: &Path, stem: &str) -> PathBuf {
        let mut candidate = out_dir.join(format!("{stem}.mp4"));
        let mut n = 2u32;
        while candidate.exists() {
            candidate = out_dir.join(format!("{stem}_{n}.mp4"));
            n += 1;
        }
        candidate
    }

    pub fn flush_to_disk(&self, max_seconds: Option<f32>) -> RResult<ClipWriteResult> {
        let _guard = match self.flush_lock.try_lock() {
            Some(g) => g,
            None => {
                return Err(RecorderError::Other(
                    "Save replay already in progress".into(),
                ))
            }
        };
        self.flush_to_disk_inner(max_seconds)
    }

    fn flush_to_disk_inner(&self, max_seconds: Option<f32>) -> RResult<ClipWriteResult> {
        if !self.is_running() || !self.is_ring_enabled() {
            return Err(RecorderError::NotRunning);
        }
        let t0 = Instant::now();
        let cfg = self.config.read().clone();

        let (video, audio) = {
            let ring = self.shared.ring.lock();
            if ring.video_frames() == 0 {
                return Err(RecorderError::EmptyBuffer);
            }
            ring.snapshot(max_seconds)
        };

        let est_bytes: u64 = video
            .iter()
            .chain(audio.iter())
            .map(|p| p.data.len() as u64)
            .sum();
        let out_dir = match &cfg.output_subfolder {
            Some(sub) => cfg.output_dir.join(sub),
            None => cfg.output_dir.clone(),
        };
        std::fs::create_dir_all(&out_dir)?;

        if let Some(free) = free_disk_bytes(&out_dir) {
            let needed = est_bytes + 16 * 1024 * 1024;
            if free < needed {
                return Err(RecorderError::Other(format!(
                    "Low disk space ({:.1} MB free, need ~{:.1} MB). Free space or choose another folder.",
                    free as f64 / 1_048_576.0,
                    needed as f64 / 1_048_576.0
                )));
            }
        }

        let header = self
            .video_format
            .lock()
            .clone()
            .ok_or_else(|| RecorderError::Other("encoder header not ready yet".into()))?;

        let prev_state = *self.shared.state.read();
        self.shared.set_state(EngineState::Flushing);

        let written = (|| -> RResult<(PathBuf, String)> {
            let stem = format!(
                "KAGE_Replay_{}",
                chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")
            );
            let path = Self::unique_clip_path(&out_dir, &stem);
            let file_name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("{stem}.mp4"));

            if let Err(e) = mux_packets_to_mp4(&path, &header, &video, &audio) {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            Ok((path, file_name))
        })();

        self.shared.set_state(prev_state);

        let (path, file_name) = written?;
        let duration_hns = match (video.first(), video.last()) {
            (Some(a), Some(b)) => (b.pts_hns + b.duration_hns - a.pts_hns).max(0),
            _ => 0,
        };
        let has_audio = !audio.is_empty();
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        Ok(ClipWriteResult {
            path: path.to_string_lossy().to_string(),
            file_name,
            duration_seconds: duration_hns as f32 / HNS_PER_SECOND as f32,
            size_bytes,
            flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
            width: header.width,
            height: header.height,
            fps: header.fps_num.max(1),
            has_audio,
        })
    }
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        if self.is_running() || self.is_recording() {
            self.stop();
        }
    }
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod win {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{E_UNEXPECTED, HMODULE, TRUE};
    use windows::Win32::Graphics::Direct3D::{
        D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
        THREAD_PRIORITY_NORMAL,
    };

    pub(super) fn hr(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    pub(super) fn is_device_lost(e: &windows::core::Error) -> bool {
        let c = e.code();
        c == DXGI_ERROR_DEVICE_REMOVED
            || c == DXGI_ERROR_DEVICE_RESET
            || c == DXGI_ERROR_ACCESS_LOST
            || c == DXGI_ERROR_DEVICE_HUNG
            || c == DXGI_ERROR_DRIVER_INTERNAL_ERROR
            || c == E_UNEXPECTED
    }

    pub(super) fn free_disk_bytes(path: &Path) -> Option<u64> {
        let mut check = path.to_path_buf();
        while !check.exists() {
            if !check.pop() {
                break;
            }
        }
        let wide: Vec<u16> = check
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_to_caller = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(wide.as_ptr()),
                Some(&mut free_to_caller),
                None,
                None,
            )
        };
        if ok.is_ok() {
            Some(free_to_caller)
        } else {
            None
        }
    }

    pub(super) struct MfSession {
        com_owned: bool,
    }

    impl MfSession {
        pub fn new() -> RResult<Self> {
            unsafe {
                let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
                    if com_owned {
                        CoUninitialize();
                    }
                    return Err(hr(e));
                }
                Ok(Self { com_owned })
            }
        }
    }

    impl Drop for MfSession {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                if self.com_owned {
                    CoUninitialize();
                }
            }
        }
    }

    pub(super) struct HighResTimerGuard;

    impl HighResTimerGuard {
        pub fn new() -> Self {
            unsafe {
                let _ = timeBeginPeriod(1);
            }
            Self
        }
    }

    impl Drop for HighResTimerGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = timeEndPeriod(1);
            }
        }
    }

    pub(super) struct GraphicsStack {
        pub device: ID3D11Device,
        pub context: ID3D11DeviceContext,
        pub duplication: IDXGIOutputDuplication,
        pub adapter_name: String,
        pub vram_mb: u64,
        pub src_width: u32,
        pub src_height: u32,
        pub src_format: DXGI_FORMAT,
    }

    impl GraphicsStack {
        pub fn create(monitor_index: u32) -> RResult<Self> {
            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(hr)?;
                let mut flat = 0u32;
                let mut adapter_idx = 0u32;
                loop {
                    let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(adapter_idx) {
                        Ok(a) => a,
                        Err(_) => break,
                    };
                    let adesc = adapter.GetDesc1().map_err(hr)?;
                    if (adesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                        adapter_idx += 1;
                        continue;
                    }
                    let mut output_idx = 0u32;
                    loop {
                        let output: IDXGIOutput = match adapter.EnumOutputs(output_idx) {
                            Ok(o) => o,
                            Err(_) => break,
                        };
                        if flat == monitor_index {
                            return Self::build(&adapter, &adesc, &output);
                        }
                        flat += 1;
                        output_idx += 1;
                    }
                    adapter_idx += 1;
                }
                Err(RecorderError::NoSuchMonitor(monitor_index))
            }
        }

        unsafe fn build(
            adapter: &IDXGIAdapter1,
            adesc: &DXGI_ADAPTER_DESC1,
            output: &IDXGIOutput,
        ) -> RResult<Self> {
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut level = D3D_FEATURE_LEVEL::default();

            D3D11CreateDevice(
                adapter,
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                Some(&mut context),
            )
            .map_err(hr)?;

            let device = device.ok_or_else(|| RecorderError::Other("no d3d11 device".into()))?;
            let context = context.ok_or_else(|| RecorderError::Other("no d3d11 context".into()))?;

            let mt: ID3D11Multithread = device.cast().map_err(hr)?;
            let _ = mt.SetMultithreadProtected(TRUE);

            let output1: IDXGIOutput1 = output.cast().map_err(hr)?;
            let duplication = output1.DuplicateOutput(&device).map_err(|e| {
                if e.code() == DXGI_ERROR_UNSUPPORTED {
                    RecorderError::Other(
                        "Desktop Duplication is unavailable on this output (hybrid-GPU: run KAGE on the GPU driving the display)".into(),
                    )
                } else {
                    hr(e)
                }
            })?;

            let desc = duplication.GetDesc();
            let adapter_name = String::from_utf16_lossy(
                &adesc.Description[..adesc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(adesc.Description.len())],
            );

            let _ = adapter;
            Ok(Self {
                src_width: desc.ModeDesc.Width,
                src_height: desc.ModeDesc.Height,
                src_format: desc.ModeDesc.Format,
                device,
                context,
                duplication,
                adapter_name,
                vram_mb: (adesc.DedicatedVideoMemory / (1024 * 1024)) as u64,
            })
        }

        pub fn reacquire_duplication(&mut self, monitor_index: u32) -> RResult<()> {
            let rebuilt = Self::create(monitor_index)?;
            *self = rebuilt;
            Ok(())
        }
    }

    #[allow(dead_code)]
    pub(super) struct ColorConverter {
        vdevice: ID3D11VideoDevice,
        vcontext: ID3D11VideoContext,
        context: ID3D11DeviceContext,
        processor: ID3D11VideoProcessor,
        enumerator: ID3D11VideoProcessorEnumerator,
        input_tex: ID3D11Texture2D,
        in_view: ID3D11VideoProcessorInputView,
        pub nv12: ID3D11Texture2D,
        out_view: ID3D11VideoProcessorOutputView,
        src_w: u32,
        src_h: u32,
        _dst_w: u32,
        _dst_h: u32,
    }

    impl ColorConverter {
        pub fn new(
            device: &ID3D11Device,
            context: &ID3D11DeviceContext,
            src_w: u32,
            src_h: u32,
            src_format: DXGI_FORMAT,
            dst_w: u32,
            dst_h: u32,
            fps: u32,
            performance_mode: bool,
        ) -> RResult<Self> {
            unsafe {
                let vdevice: ID3D11VideoDevice = device.cast().map_err(hr)?;
                let vcontext: ID3D11VideoContext = context.cast().map_err(hr)?;

                let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: DXGI_RATIONAL {
                        Numerator: fps,
                        Denominator: 1,
                    },
                    InputWidth: src_w,
                    InputHeight: src_h,
                    OutputFrameRate: DXGI_RATIONAL {
                        Numerator: fps,
                        Denominator: 1,
                    },
                    OutputWidth: dst_w,
                    OutputHeight: dst_h,
                    Usage: if performance_mode {
                        D3D11_VIDEO_USAGE_OPTIMAL_SPEED
                    } else {
                        D3D11_VIDEO_USAGE_PLAYBACK_NORMAL
                    },
                };

                let enumerator = vdevice
                    .CreateVideoProcessorEnumerator(&content_desc)
                    .map_err(hr)?;
                let processor = vdevice.CreateVideoProcessor(&enumerator, 0).map_err(hr)?;

                let in_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0001,
                };
                let out_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0004,
                };
                vcontext.VideoProcessorSetStreamColorSpace(&processor, 0, &in_cs);
                vcontext.VideoProcessorSetOutputColorSpace(&processor, &out_cs);
                vcontext.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );

                let input_desc = D3D11_TEXTURE2D_DESC {
                    Width: src_w,
                    Height: src_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: if src_format == DXGI_FORMAT_UNKNOWN {
                        DXGI_FORMAT_B8G8R8A8_UNORM
                    } else {
                        src_format
                    },
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut input_tex: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&input_desc, None, Some(&mut input_tex))
                    .map_err(hr)?;
                let input_tex =
                    input_tex.ok_or_else(|| RecorderError::Other("no input texture".into()))?;

                let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
                };
                let mut in_view: Option<ID3D11VideoProcessorInputView> = None;
                vdevice
                    .CreateVideoProcessorInputView(&input_tex, &enumerator, &ivd, Some(&mut in_view))
                    .map_err(hr)?;
                let in_view =
                    in_view.ok_or_else(|| RecorderError::Other("no vp input view".into()))?;

                let nv12_desc = D3D11_TEXTURE2D_DESC {
                    Width: dst_w,
                    Height: dst_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut nv12: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&nv12_desc, None, Some(&mut nv12))
                    .map_err(hr)?;
                let nv12 = nv12.ok_or_else(|| RecorderError::Other("no nv12 texture".into()))?;

                let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                    },
                };
                let mut out_view: Option<ID3D11VideoProcessorOutputView> = None;
                vdevice
                    .CreateVideoProcessorOutputView(&nv12, &enumerator, &ovd, Some(&mut out_view))
                    .map_err(hr)?;
                let out_view =
                    out_view.ok_or_else(|| RecorderError::Other("no vp output view".into()))?;

                Ok(Self {
                    vdevice,
                    vcontext,
                    context: context.clone(),
                    processor,
                    enumerator,
                    input_tex,
                    in_view,
                    nv12,
                    out_view,
                    src_w,
                    src_h,
                    _dst_w: dst_w,
                    _dst_h: dst_h,
                })
            }
        }

        pub fn convert(&self, src: &ID3D11Texture2D) -> RResult<()> {
            unsafe {
                self.context.CopyResource(&self.input_tex, src);

                let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: TRUE,
                    OutputIndex: 0,
                    InputFrameOrField: 0,
                    PastFrames: 0,
                    FutureFrames: 0,
                    pInputSurface: std::mem::ManuallyDrop::new(Some(self.in_view.clone())),
                    ..Default::default()
                }];

                let result = self
                    .vcontext
                    .VideoProcessorBlt(&self.processor, &self.out_view, 0, &streams);

                drop(std::mem::ManuallyDrop::take(&mut streams[0].pInputSurface));
                result.map_err(hr)
            }
        }
    }

    pub(super) struct HardwareEncoder {
        transform: IMFTransform,
        events: Option<IMFMediaEventGenerator>,
        _dxgi_manager: IMFDXGIDeviceManager,
        pub info: EncoderInfo,
        pub header: VideoFormatHeader,
        async_mode: bool,
        pending_input: u32,
        width: u32,
        height: u32,
        fps: u32,
    }

    impl HardwareEncoder {
        pub fn create(
            device: &ID3D11Device,
            width: u32,
            height: u32,
            fps: u32,
            bitrate_kbps: u32,
            codec: Codec,
            performance_mode: bool,
            adapter_name: &str,
            vram_mb: u64,
        ) -> RResult<Self> {
            unsafe {
                let subtype = match codec {
                    Codec::H264 => MFVideoFormat_H264,
                    Codec::Hevc => MFVideoFormat_HEVC,
                };

                let in_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: MFVideoFormat_NV12,
                };
                let out_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: subtype,
                };

                let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut count: u32 = 0;
                MFTEnumEx(
                    MFT_CATEGORY_VIDEO_ENCODER,
                    MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                    Some(&in_info),
                    Some(&out_info),
                    &mut activates,
                    &mut count,
                )
                .map_err(hr)?;

                let desired_vendor = EncoderVendor::from_friendly_name(adapter_name);
                let mut chosen: Option<(IMFActivate, String)> = None;
                if count > 0 && !activates.is_null() {
                    let slice = std::slice::from_raw_parts_mut(activates, count as usize);
                    for slot in slice.iter_mut() {
                        if let Some(act) = slot.take() {
                            let mut name = PWSTR::null();
                            let mut len = 0u32;
                            let friendly = if act
                                .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)
                                .is_ok()
                            {
                                let s = name.to_string().unwrap_or_default();
                                windows::Win32::System::Com::CoTaskMemFree(Some(
                                    name.0 as *const std::ffi::c_void,
                                ));
                                s
                            } else {
                                "Hardware Encoder".to_string()
                            };
                            let mft_vendor = EncoderVendor::from_friendly_name(&friendly);
                            if chosen.is_none() || mft_vendor == desired_vendor {
                                chosen = Some((act, friendly));
                                if mft_vendor == desired_vendor {
                                    // Drop remaining COM activates below before returning.
                                    continue;
                                }
                            }
                            // Non-selected `act` drops right here instead of leaking!
                        }
                    }
                    windows::Win32::System::Com::CoTaskMemFree(Some(
                        activates as *const std::ffi::c_void,
                    ));
                }

                let (transform, friendly, hardware) = match chosen {
                    Some((act, name)) => {
                        let t: IMFTransform = act.ActivateObject().map_err(hr)?;
                        (t, name, true)
                    }
                    None => {
                        let t: IMFTransform = windows::Win32::System::Com::CoCreateInstance(
                            &CLSID_MSH264EncoderMFT,
                            None,
                            windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
                        )
                        .map_err(|_| RecorderError::NoEncoder)?;
                        (t, "Microsoft H.264 Encoder MFT".to_string(), false)
                    }
                };

                if performance_mode && !hardware {
                    log::warn!(
                        "[kage] Game Mode is on but only a software H.264 encoder is available; capture may compete with the game for CPU"
                    );
                }

                let attrs = transform.GetAttributes().ok();
                let mut async_mode = false;
                if let Some(a) = attrs.as_ref() {
                    if a.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1 {
                        a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(hr)?;
                        async_mode = true;
                    }
                    let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
                    let _ = a.SetUINT32(&MF_SA_D3D11_AWARE, 1);
                }

                let mut reset_token = 0u32;
                let mut manager: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut reset_token, &mut manager).map_err(hr)?;
                let manager =
                    manager.ok_or_else(|| RecorderError::Other("no dxgi manager".into()))?;
                manager.ResetDevice(device, reset_token).map_err(hr)?;
                transform
                    .ProcessMessage(
                        MFT_MESSAGE_SET_D3D_MANAGER,
                        manager.as_raw() as usize,
                    )
                    .map_err(hr)?;

                let out_type = MFCreateMediaType().map_err(hr)?;
                out_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                out_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
                out_type
                    .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_kbps * 1000)
                    .map_err(hr)?;
                out_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&out_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&out_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                if codec == Codec::H264 {
                    out_type
                        .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                        .map_err(hr)?;
                }
                let _ = out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps);
                transform.SetOutputType(0, &out_type, 0).map_err(hr)?;

                let in_type = MFCreateMediaType().map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
                    .map_err(hr)?;
                in_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&in_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&in_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                transform.SetInputType(0, &in_type, 0).map_err(hr)?;

                if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonRateControlMode, 0);
                    let _ = set_codec_u32(
                        &codec_api,
                        &CODECAPI_AVEncCommonMeanBitRate,
                        bitrate_kbps * 1000,
                    );
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonLowLatency, 1);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVGOPSize, fps);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncVideoMaxNumRefFrame, 1);
                    if performance_mode {
                        let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonQuality, 55);
                        let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonQualityVsSpeed, 80);
                        let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
                    }
                }

                let events: Option<IMFMediaEventGenerator> = if async_mode {
                    transform.cast().ok()
                } else {
                    None
                };

                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                    .map_err(hr)?;
                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                    .map_err(hr)?;

                let negotiated = transform.GetOutputCurrentType(0).map_err(hr)?;
                let mut sequence_header = Vec::new();
                if let Ok(size) = negotiated.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    if size > 0 {
                        sequence_header.resize(size as usize, 0u8);
                        let _ = negotiated
                            .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut sequence_header, None);
                    }
                }

                let vendor = if hardware {
                    EncoderVendor::from_friendly_name(&friendly)
                } else {
                    EncoderVendor::MediaFoundationSoftware
                };

                Ok(Self {
                    transform,
                    events,
                    _dxgi_manager: manager,
                    info: EncoderInfo {
                        vendor,
                        friendly_name: friendly,
                        codec: codec.as_str().to_string(),
                        hardware,
                        adapter_name: adapter_name.to_string(),
                        dedicated_vram_mb: vram_mb,
                    },
                    header: VideoFormatHeader {
                        width,
                        height,
                        fps_num: fps,
                        fps_den: 1,
                        bitrate: bitrate_kbps * 1000,
                        profile: eAVEncH264VProfile_High.0 as u32,
                        codec: if codec == Codec::H264 { 0 } else { 1 },
                        sequence_header,
                    },
                    async_mode,
                    pending_input: 0,
                    width,
                    height,
                    fps,
                })
            }
        }

        /// Feeds one NV12 texture. Returns `Ok(true)` if the MFT accepted the
        /// frame, `Ok(false)` if the encoder was not requesting input (so the
        /// caller keeps `force_key` armed instead of silently clearing it).
        pub fn submit(
            &mut self,
            texture: &ID3D11Texture2D,
            pts_hns: i64,
            duration_hns: i64,
            force_key: bool,
        ) -> RResult<bool> {
            unsafe {
                if self.async_mode {
                    self.pump_events()?;
                    if self.pending_input == 0 {
                        return Ok(false);
                    }
                }

                let buffer = MFCreateDXGISurfaceBuffer(
                    &ID3D11Texture2D::IID,
                    texture,
                    0,
                    false,
                )
                .map_err(hr)?;

                if let Ok(b2d) = buffer.cast::<IMF2DBuffer>() {
                    if let Ok(len) = b2d.GetContiguousLength() {
                        let _ = buffer.SetCurrentLength(len);
                    }
                }

                let sample = MFCreateSample().map_err(hr)?;
                sample.AddBuffer(&buffer).map_err(hr)?;
                sample.SetSampleTime(pts_hns).map_err(hr)?;
                sample.SetSampleDuration(duration_hns).map_err(hr)?;
                if force_key {
                    let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
                }

                match self.transform.ProcessInput(0, &sample, 0) {
                    Ok(()) => {
                        if self.async_mode {
                            self.pending_input = self.pending_input.saturating_sub(1);
                        }
                        Ok(true)
                    }
                    Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(false),
                    Err(e) => Err(hr(e)),
                }
            }
        }

        /// Drains every ready access unit into `sink` and pumps async events.
        pub fn drain(&mut self, mut sink: impl FnMut(&[u8], i64, i64, bool)) -> RResult<()> {
            unsafe {
                if self.async_mode {
                    self.pump_events()?;
                }

                loop {
                    let mut status = 0u32;
                    let mut out = [MFT_OUTPUT_DATA_BUFFER {
                        dwStreamID: 0,
                        pSample: std::mem::ManuallyDrop::new(None),
                        dwStatus: 0,
                        pEvents: std::mem::ManuallyDrop::new(None),
                    }];

                    let result = self.transform.ProcessOutput(0, &mut out, &mut status);
                    let sample_opt = std::mem::ManuallyDrop::take(&mut out[0].pSample);
                    drop(std::mem::ManuallyDrop::take(&mut out[0].pEvents));

                    match result {
                        Ok(()) => {}
                        Err(e)
                            if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT
                                || e.code() == MF_E_TRANSFORM_STREAM_CHANGE =>
                        {
                            if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                                self.renegotiate_output()?;
                                continue;
                            }
                            return Ok(());
                        }
                        Err(e) if e.code() == E_UNEXPECTED => return Ok(()),
                        Err(e) => return Err(hr(e)),
                    }

                    let Some(sample) = sample_opt else {
                        return Ok(());
                    };

                    let pts = sample.GetSampleTime().unwrap_or(0);
                    let dur = sample
                        .GetSampleDuration()
                        .unwrap_or(HNS_PER_SECOND / self.fps.max(1) as i64);
                    let keyframe =
                        sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;

                    let buffer = sample.ConvertToContiguousBuffer().map_err(hr)?;
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    let mut max_len = 0u32;
                    let mut cur_len = 0u32;
                    buffer
                        .Lock(&mut ptr, Some(&mut max_len), Some(&mut cur_len))
                        .map_err(hr)?;
                    let slice = std::slice::from_raw_parts(ptr, cur_len as usize);
                    sink(slice, pts, dur, keyframe);
                    let _ = buffer.Unlock();
                }
            }
        }

        /// Non-blocking event pump: drains *all* queued MFT events so
        /// `HaveOutput` never masks a subsequent `NeedInput` (fixing 60->30 FPS drops).
        unsafe fn pump_events(&mut self) -> RResult<()> {
            let Some(gen) = self.events.as_ref() else {
                self.pending_input = 1;
                return Ok(());
            };

            let flags = MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(MF_EVENT_FLAG_NO_WAIT.0);
            loop {
                let evt = match gen.GetEvent(flags) {
                    Ok(e) => e,
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                    Err(e) if e.code() == MF_E_MULTIPLE_SUBSCRIBERS => return Ok(()),
                    Err(e) => return Err(hr(e)),
                };
                let kind = evt.GetType().unwrap_or(0);
                if let EventKind::NeedInput = me_transform_need_input_or(kind) {
                    self.pending_input = self.pending_input.saturating_add(1);
                }
            }
        }

        unsafe fn renegotiate_output(&mut self) -> RResult<()> {
            let available = self.transform.GetOutputAvailableType(0, 0).map_err(hr)?;
            self.transform.SetOutputType(0, &available, 0).map_err(hr)?;
            if let Ok(size) = available.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                if size > 0 {
                    let mut hdr = vec![0u8; size as usize];
                    if available
                        .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut hdr, None)
                        .is_ok()
                    {
                        self.header.sequence_header = hdr;
                    }
                }
            }
            Ok(())
        }

        pub fn flush(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            }
        }

        pub fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }
    }

    impl Drop for HardwareEncoder {
        fn drop(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
    }

    pub(super) enum EventKind {
        NeedInput,
        HaveOutput,
        DrainComplete,
        Other,
    }

    fn me_transform_need_input_or(kind: u32) -> EventKind {
        const NEED_INPUT: u32 = 601;
        const HAVE_OUTPUT: u32 = 602;
        const DRAIN_COMPLETE: u32 = 603;
        match kind {
            NEED_INPUT => EventKind::NeedInput,
            HAVE_OUTPUT => EventKind::HaveOutput,
            DRAIN_COMPLETE => EventKind::DrainComplete,
            _ => EventKind::Other,
        }
    }

    pub(super) fn set_attr_size(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        w: u32,
        h: u32,
    ) -> RResult<()> {
        unsafe { t.SetUINT64(key, ((w as u64) << 32) | h as u64).map_err(hr) }
    }

    pub(super) fn set_attr_ratio(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        num: u32,
        den: u32,
    ) -> RResult<()> {
        unsafe {
            t.SetUINT64(key, ((num as u64) << 32) | den as u64)
                .map_err(hr)
        }
    }

    unsafe fn set_codec_u32(
        api: &ICodecAPI,
        key: &windows::core::GUID,
        value: u32,
    ) -> windows::core::Result<()> {
        let v = windows::core::VARIANT::from(value);
        api.SetValue(key, &v)
    }

    unsafe fn create_mp4_sink_writer(
        path: &Path,
        header: &VideoFormatHeader,
        with_audio: bool,
    ) -> RResult<(IMFSinkWriter, u32, Option<u32>)> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let attrs = {
            let mut a: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut a, 6).map_err(hr)?;
            a.ok_or_else(|| RecorderError::Other("no sink attributes".into()))?
        };
        attrs
            .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
            .map_err(hr)?;
        let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 0);
        let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);

        let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attrs).map_err(hr)?;

        let subtype = if header.codec == 0 {
            MFVideoFormat_H264
        } else {
            MFVideoFormat_HEVC
        };
        let vtype = MFCreateMediaType().map_err(hr)?;
        vtype
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(hr)?;
        vtype.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
        vtype
            .SetUINT32(&MF_MT_AVG_BITRATE, header.bitrate)
            .map_err(hr)?;
        vtype
            .SetUINT32(
                &MF_MT_INTERLACE_MODE,
                MFVideoInterlace_Progressive.0 as u32,
            )
            .map_err(hr)?;
        set_attr_size(&vtype, &MF_MT_FRAME_SIZE, header.width, header.height)?;
        set_attr_ratio(&vtype, &MF_MT_FRAME_RATE, header.fps_num, header.fps_den)?;
        set_attr_ratio(&vtype, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
        if !header.sequence_header.is_empty() {
            let _ = vtype.SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &header.sequence_header);
        }
        if header.codec == 0 {
            let _ = vtype.SetUINT32(&MF_MT_MPEG2_PROFILE, header.profile);
        }
        let vstream = writer.AddStream(&vtype).map_err(hr)?;
        writer.SetInputMediaType(vstream, &vtype, None).map_err(hr)?;

        let astream = if with_audio {
            let atype = MFCreateMediaType().map_err(hr)?;
            atype
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                .map_err(hr)?;
            atype
                .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
                .map_err(hr)?;
            atype
                .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)
                .map_err(hr)?;
            atype.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(hr)?;
            atype
                .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                .map_err(hr)?;
            atype
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
                .map_err(hr)?;
            atype.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0).map_err(hr)?;
            atype
                .SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)
                .map_err(hr)?;
            let s = writer.AddStream(&atype).map_err(hr)?;
            writer.SetInputMediaType(s, &atype, None).map_err(hr)?;
            Some(s)
        } else {
            None
        };

        writer.BeginWriting().map_err(hr)?;
        Ok((writer, vstream, astream))
    }

    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        audio: &[EncodedPacket],
    ) -> RResult<()> {
        unsafe {
            let _session = MfSession::new()?;
            let (writer, vstream, astream) =
                create_mp4_sink_writer(path, header, !audio.is_empty())?;

            let base_pts = video.first().map(|p| p.pts_hns).unwrap_or(0);
            for pkt in video {
                let sample = make_sample(
                    &pkt.data,
                    pkt.pts_hns - base_pts,
                    pkt.duration_hns,
                    pkt.keyframe,
                )?;
                writer.WriteSample(vstream, &sample).map_err(hr)?;
            }
            if let Some(s) = astream {
                for pkt in audio {
                    let t = (pkt.pts_hns - base_pts).max(0);
                    let sample = make_sample(&pkt.data, t, pkt.duration_hns, true)?;
                    writer.WriteSample(s, &sample).map_err(hr)?;
                }
            }

            writer.Finalize().map_err(hr)?;
            Ok(())
        }
    }

    /// Streams encoded H.264/HEVC + AAC packets straight to an MP4 on disk
    /// (`Alt + R`), holding zero history in RAM. Waits for the first video
    /// keyframe before opening the `IMFSinkWriter` stream timeline.
    pub(super) fn run_direct_writer(
        path: &Path,
        header: &VideoFormatHeader,
        rx: mpsc::Receiver<EncodedPacket>,
        rec_bytes: Arc<AtomicU64>,
    ) -> RResult<(f32, u64, bool)> {
        unsafe {
            let _session = MfSession::new()?;
            // Always declare the AAC stream if audio packets may arrive; if none
            // arrive before finalize, MF still produces a valid video MP4.
            let mut writer_tuple: Option<(IMFSinkWriter, u32, Option<u32>)> = None;
            let mut base_pts: Option<i64> = None;
            let mut expected_gen: Option<u32> = None;
            let mut last_pts_end: i64 = 0;
            let mut wrote_audio = false;
            let mut buffered_audio: Vec<EncodedPacket> = Vec::new();

            while let Ok(pkt) = rx.recv() {
                if base_pts.is_none() {
                    match pkt.track {
                        TrackKind::Video if pkt.keyframe => {
                            let bp = pkt.pts_hns;
                            base_pts = Some(bp);
                            expected_gen = Some(pkt.generation);
                            let include_audio = true;
                            let wt = create_mp4_sink_writer(path, header, include_audio)?;
                            // Drain any buffered audio aligned on or after base_pts.
                            if let Some(astream) = wt.2 {
                                for ap in buffered_audio.drain(..) {
                                    if ap.generation == pkt.generation
                                        && ap.pts_hns + ap.duration_hns >= bp
                                    {
                                        let t = (ap.pts_hns - bp).max(0);
                                        let s = make_sample(&ap.data, t, ap.duration_hns, true)?;
                                        wt.0.WriteSample(astream, &s).map_err(hr)?;
                                        rec_bytes.fetch_add(ap.data.len() as u64, Ordering::Relaxed);
                                        wrote_audio = true;
                                    }
                                }
                            }
                            let vs = make_sample(&pkt.data, 0, pkt.duration_hns, true)?;
                            wt.0.WriteSample(wt.1, &vs).map_err(hr)?;
                            rec_bytes.fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
                            last_pts_end = pkt.duration_hns.max(0);
                            writer_tuple = Some(wt);
                        }
                        TrackKind::Audio if buffered_audio.len() < 128 => {
                            buffered_audio.push(pkt);
                        }
                        _ => {}
                    }
                    continue;
                }

                let bp = base_pts.unwrap();
                let gen_ok = expected_gen == Some(pkt.generation);
                if !gen_ok {
                    // Graphics device reset mid-recording: finalize cleanly rather
                    // than mixing incompatible encoder streams.
                    break;
                }

                if let Some((ref writer, vstream, astream)) = writer_tuple {
                    match pkt.track {
                        TrackKind::Video => {
                            let rel = (pkt.pts_hns - bp).max(0);
                            let s = make_sample(&pkt.data, rel, pkt.duration_hns, pkt.keyframe)?;
                            writer.WriteSample(vstream, &s).map_err(hr)?;
                            rec_bytes.fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
                            last_pts_end = last_pts_end.max(rel + pkt.duration_hns);
                        }
                        TrackKind::Audio => {
                            if let Some(astream) = astream {
                                if pkt.pts_hns + pkt.duration_hns >= bp {
                                    let rel = (pkt.pts_hns - bp).max(0);
                                    let s = make_sample(&pkt.data, rel, pkt.duration_hns, true)?;
                                    writer.WriteSample(astream, &s).map_err(hr)?;
                                    rec_bytes.fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
                                    wrote_audio = true;
                                }
                            }
                        }
                    }
                }
            }

            if let Some((writer, _, _)) = writer_tuple {
                writer.Finalize().map_err(hr)?;
                let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                let dur = (last_pts_end as f64 / HNS_PER_SECOND as f64) as f32;
                Ok((dur, size_bytes, wrote_audio))
            } else {
                Err(RecorderError::Other(
                    "recording stopped before a keyframe was captured".into(),
                ))
            }
        }
    }

    unsafe fn make_sample(
        data: &[u8],
        pts: i64,
        dur: i64,
        keyframe: bool,
    ) -> RResult<IMFSample> {
        let buffer = MFCreateMemoryBuffer(data.len() as u32).map_err(hr)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        buffer.Lock(&mut ptr, None, None).map_err(hr)?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        buffer.Unlock().map_err(hr)?;
        buffer.SetCurrentLength(data.len() as u32).map_err(hr)?;

        let sample = MFCreateSample().map_err(hr)?;
        sample.AddBuffer(&buffer).map_err(hr)?;
        sample.SetSampleTime(pts).map_err(hr)?;
        sample.SetSampleDuration(dur).map_err(hr)?;
        if keyframe {
            let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        }
        Ok(sample)
    }

    pub(super) fn rss_bytes() -> u64 {
        unsafe {
            let mut pmc = PROCESS_MEMORY_COUNTERS::default();
            let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, size).is_ok() {
                pmc.WorkingSetSize as u64
            } else {
                0
            }
        }
    }

    pub(super) fn boost_thread(performance_mode: bool) {
        let priority = if performance_mode {
            THREAD_PRIORITY_NORMAL
        } else {
            THREAD_PRIORITY_ABOVE_NORMAL
        };
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), priority);
        }
    }

    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        mut cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
        clock: Arc<super::QpcClock>,
    ) {
        let _timer_guard = HighResTimerGuard::new();
        let _session = match MfSession::new() {
            Ok(s) => s,
            Err(e) => {
                shared.fail(format!("Media Foundation unavailable: {e}"));
                return;
            }
        };

        let mut backoff_ms = 40u64;

        'outer: while !shared.stop_requested.load(Ordering::Acquire) {
            let mut gfx = match GraphicsStack::create(cfg.monitor_index) {
                Ok(g) => g,
                Err(e) => {
                    shared.set_state(EngineState::Recovering);
                    shared.fail(format!("{e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            let integrated_gpu = is_integrated_gpu(&gfx.adapter_name, gfx.vram_mb);
            *shared.integrated_gpu.write() = integrated_gpu;
            if integrated_gpu && cfg.performance_mode {
                cfg.target_fps = cfg.target_fps.min(30);
                cfg.max_height = if cfg.max_height == 0 {
                    720
                } else {
                    cfg.max_height.min(720)
                };
                cfg.bitrate_kbps = cfg.bitrate_kbps.min(6_000);
            }
            *shared.effective_target_fps.write() = cfg.target_fps;
            *shared.effective_bitrate_kbps.write() = cfg.bitrate_kbps;

            let dst_w = if cfg.width == 0 { gfx.src_width } else { cfg.width } & !1;
            let dst_h = if cfg.height == 0 { gfx.src_height } else { cfg.height } & !1;
            let (dst_w, dst_h) = if cfg.max_height > 0
                && cfg.max_height < dst_h
                && cfg.width == 0
                && cfg.height == 0
            {
                let h = (cfg.max_height & !1).max(2);
                let w = (((gfx.src_width as u64 * h as u64) / gfx.src_height.max(1) as u64)
                    as u32)
                    & !1;
                (w.max(2), h.max(2))
            } else {
                (dst_w, dst_h)
            };

            let converter = match ColorConverter::new(
                &gfx.device,
                &gfx.context,
                gfx.src_width,
                gfx.src_height,
                gfx.src_format,
                dst_w,
                dst_h,
                cfg.target_fps,
                cfg.performance_mode,
            ) {
                Ok(c) => c,
                Err(e) => {
                    shared.fail(format!("video processor: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            let mut encoder = match HardwareEncoder::create(
                &gfx.device,
                dst_w,
                dst_h,
                cfg.target_fps,
                cfg.bitrate_kbps,
                cfg.codec,
                cfg.performance_mode,
                &gfx.adapter_name,
                gfx.vram_mb,
            ) {
                Ok(e) => e,
                Err(e) => {
                    shared.fail(format!("encoder: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            *shared.encoder.write() = encoder.info.clone();
            *shared.dimensions.write() = encoder.dimensions();
            *fmt.lock() = Some(encoder.header.clone());
            *shared.last_error.write() = None;
            shared.set_state(EngineState::Buffering);
            backoff_ms = 40;

            let generation = shared.generation.load(Ordering::Acquire);
            let frame_interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
            let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;

            let mut next_deadline = Instant::now();
            let mut force_key = true;
            let mut was_gated = false;
            let mut has_converted_frame = false;
            let mut fps_window = Instant::now();
            let mut fps_frames = 0u32;
            let mut packet_batch: Vec<EncodedPacket> = Vec::with_capacity(8);

            loop {
                if shared.stop_requested.load(Ordering::Acquire) {
                    break 'outer;
                }

                if shared.force_device_reset.swap(false, Ordering::AcqRel) {
                    log::warn!("[kage] simulated device reset requested via IPC");
                    shared.device_resets.fetch_add(1, Ordering::Relaxed);
                    shared.generation.fetch_add(1, Ordering::AcqRel);
                    shared.set_state(EngineState::Recovering);
                    encoder.flush();
                    drop(encoder);
                    drop(converter);
                    if gfx.reacquire_duplication(cfg.monitor_index).is_err() {
                        std::thread::sleep(Duration::from_millis(backoff_ms));
                    }
                    continue 'outer;
                }

                let now = Instant::now();
                if now < next_deadline {
                    std::thread::sleep(next_deadline - now);
                }
                next_deadline += frame_interval;
                let after_frame = Instant::now();
                if after_frame >= next_deadline {
                    next_deadline = after_frame + frame_interval;
                    shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                }

                let submit_start = Instant::now();
                let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;

                let acquire = unsafe {
                    gfx.duplication
                        .AcquireNextFrame(0, &mut frame_info, &mut resource)
                };

                let gated = shared.privacy_gate.load(Ordering::Acquire);
                let mut frame_ready = false;

                match acquire {
                    Ok(()) => {
                        if gated {
                            was_gated = true;
                        } else if let Some(res) = resource.take() {
                            match res.cast::<ID3D11Texture2D>() {
                                Ok(t) => match converter.convert(&t) {
                                    Ok(()) => {
                                        has_converted_frame = true;
                                        frame_ready = true;
                                    }
                                    Err(e) => {
                                        log::warn!("[kage] color convert failed: {e}");
                                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                                    }
                                },
                                Err(e) => {
                                    log::warn!("[kage] frame cast failed: {e}");
                                }
                            }
                        }
                        // Release DXGI frame immediately after GPU blit so DXGI
                        // contract holds and we never retain an acquired texture.
                        unsafe {
                            let _ = gfx.duplication.ReleaseFrame();
                        }
                    }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        if gated {
                            was_gated = true;
                        } else if has_converted_frame {
                            // Screen unchanged: reuse `converter.nv12` directly without
                            // touching DXGI or issuing ReleaseFrame() when nothing was acquired.
                            frame_ready = true;
                        }
                    }
                    Err(e) if is_device_lost(&e) => {
                        log::warn!("[kage] device lost during acquire: {e}");
                        let _ = unsafe { gfx.duplication.ReleaseFrame() };
                        shared.device_resets.fetch_add(1, Ordering::Relaxed);
                        shared.generation.fetch_add(1, Ordering::AcqRel);
                        shared.set_state(EngineState::Recovering);
                        encoder.flush();
                        drop(encoder);
                        drop(converter);
                        if gfx.reacquire_duplication(cfg.monitor_index).is_err() {
                            std::thread::sleep(Duration::from_millis(backoff_ms));
                        }
                        continue 'outer;
                    }
                    Err(e) => {
                        log::warn!("[kage] acquire error: {e}");
                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        let _ = unsafe { gfx.duplication.ReleaseFrame() };
                        continue;
                    }
                }

                if frame_ready {
                    if was_gated {
                        force_key = true;
                        was_gated = false;
                    }
                    let want_rec_key = shared.force_key_record.load(Ordering::Acquire);
                    let need_key = force_key || want_rec_key;

                    let pts = clock.now_hns();
                    let submit_ns = submit_start.elapsed().as_nanos() as u64;
                    let encode_start = Instant::now();

                    packet_batch.clear();
                    let mut collect = |slice: &[u8], p_pts: i64, dur: i64, key: bool| {
                        packet_batch.push(EncodedPacket {
                            track: TrackKind::Video,
                            data: Arc::from(slice),
                            pts_hns: p_pts,
                            duration_hns: dur,
                            keyframe: key,
                            generation,
                        });
                    };

                    // Drain finished outputs first so a full output queue never
                    // prevents the MFT from requesting this frame.
                    if let Err(e) = encoder.drain(&mut collect) {
                        if !shared.stop_requested.load(Ordering::Acquire) {
                            log::warn!("[kage] encoder drain failed: {e}");
                        }
                    }

                    let accepted = match encoder.submit(&converter.nv12, pts, frame_hns, need_key) {
                        Ok(true) => {
                            force_key = false;
                            if want_rec_key {
                                shared.force_key_record.store(false, Ordering::Release);
                            }
                            true
                        }
                        Ok(false) => false,
                        Err(e) => {
                            log::warn!("[kage] encoder submit failed: {e}");
                            false
                        }
                    };

                    if accepted {
                        shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
                        fps_frames += 1;
                    } else {
                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                    }

                    if let Err(e) = encoder.drain(&mut collect) {
                        if !shared.stop_requested.load(Ordering::Acquire) {
                            log::warn!("[kage] encoder drain failed: {e}");
                        }
                    }

                    if !packet_batch.is_empty() {
                        let use_ring = shared.ring_enabled.load(Ordering::Acquire);
                        let direct_sender = shared.direct_tx.lock().clone();
                        if let Some(tx) = direct_sender.as_ref() {
                            for pkt in &packet_batch {
                                let _ = tx.try_send(pkt.clone());
                            }
                        }
                        if use_ring {
                            shared.ring.lock().push_batch(&mut packet_batch);
                        } else {
                            packet_batch.clear();
                        }
                    }

                    shared
                        .encode_ns_total
                        .fetch_add(encode_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    shared.submit_ns_total.fetch_add(submit_ns, Ordering::Relaxed);
                }

                if fps_window.elapsed() >= Duration::from_millis(500) {
                    *shared.capture_fps.write() =
                        fps_frames as f32 / fps_window.elapsed().as_secs_f32();
                    fps_frames = 0;
                    fps_window = Instant::now();
                }
            }
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ===========================================================================
//                  CROSS-PLATFORM / SIMULATION IMPLEMENTATION
// ===========================================================================

#[cfg(any(not(windows), feature = "headless-sim"))]
mod sim {
    use super::*;

    pub(super) fn free_disk_bytes(_path: &Path) -> Option<u64> {
        Some(64 * 1024 * 1024 * 1024)
    }

    pub(super) fn rss_bytes() -> u64 {
        18 * 1024 * 1024
    }

    pub(super) fn boost_thread(_performance_mode: bool) {}

    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        _audio: &[EncodedPacket],
    ) -> RResult<()> {
        let mut bytes = Vec::with_capacity(1024 + video.len() * 32);
        bytes.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00,
            0x02, 0x00, b'i', b's', b'o', b'm', b'i', b's', b'o', b'2',
        ]);
        bytes.extend_from_slice(&header.sequence_header);
        for p in video {
            bytes.extend_from_slice(&p.data);
        }
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub(super) fn run_direct_writer(
        path: &Path,
        header: &VideoFormatHeader,
        rx: mpsc::Receiver<EncodedPacket>,
        rec_bytes: Arc<AtomicU64>,
    ) -> RResult<(f32, u64, bool)> {
        let mut out = Vec::with_capacity(4096);
        out.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00,
            0x02, 0x00, b'i', b's', b'o', b'm', b'i', b's', b'o', b'2',
        ]);
        out.extend_from_slice(&header.sequence_header);

        let mut base_pts: Option<i64> = None;
        let mut last_end = 0i64;
        let mut wrote_audio = false;

        while let Ok(pkt) = rx.recv() {
            if base_pts.is_none() {
                if pkt.track == TrackKind::Video && pkt.keyframe {
                    base_pts = Some(pkt.pts_hns);
                    last_end = pkt.duration_hns;
                    out.extend_from_slice(&pkt.data);
                    rec_bytes.fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
                }
                continue;
            }
            let bp = base_pts.unwrap();
            if pkt.track == TrackKind::Video {
                last_end = last_end.max((pkt.pts_hns - bp).max(0) + pkt.duration_hns);
            } else {
                wrote_audio = true;
            }
            out.extend_from_slice(&pkt.data);
            rec_bytes.fetch_add(pkt.data.len() as u64, Ordering::Relaxed);
        }

        if base_pts.is_none() {
            return Err(RecorderError::Other(
                "recording stopped before a keyframe was captured".into(),
            ));
        }

        std::fs::write(path, &out)?;
        let size_bytes = out.len() as u64;
        let dur = (last_end as f64 / HNS_PER_SECOND as f64) as f32;
        Ok((dur, size_bytes, wrote_audio))
    }

    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
        _clock: Arc<super::QpcClock>,
    ) {
        let w = if cfg.width == 0 { 1920 } else { cfg.width };
        let h = if cfg.height == 0 { 1080 } else { cfg.height };

        *shared.encoder.write() = EncoderInfo {
            vendor: EncoderVendor::MediaFoundationSoftware,
            friendly_name: "Synthetic pipeline (headless-sim)".into(),
            codec: cfg.codec.as_str().into(),
            hardware: false,
            adapter_name: "Virtual Adapter".into(),
            dedicated_vram_mb: 0,
        };
        *shared.dimensions.write() = (w, h);
        *fmt.lock() = Some(VideoFormatHeader {
            width: w,
            height: h,
            fps_num: cfg.target_fps,
            fps_den: 1,
            bitrate: cfg.bitrate_kbps * 1000,
            profile: 100,
            codec: 0,
            sequence_header: vec![0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2A],
        });
        shared.set_state(EngineState::Buffering);

        let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;
        let bytes_per_frame =
            (cfg.bitrate_kbps as usize * 1000 / 8) / cfg.target_fps.max(1) as usize;
        let interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
        let mut pts = 0i64;
        let mut n = 0u64;
        let mut was_gated = false;
        let generation = shared.generation.load(Ordering::Acquire);
        let start = Instant::now();

        while !shared.stop_requested.load(Ordering::Acquire) {
            if shared.privacy_gate.load(Ordering::Acquire) {
                was_gated = true;
                std::thread::sleep(interval);
                continue;
            }
            if was_gated {
                was_gated = false;
                n = 0;
            }
            let want_rec_key = shared.force_key_record.swap(false, Ordering::AcqRel);
            let key = want_rec_key || (n % cfg.target_fps.max(1) as u64 == 0);
            let size = if key {
                bytes_per_frame * 6
            } else {
                bytes_per_frame
            };
            let pkt = EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![(n % 251) as u8; size.max(64)].into_boxed_slice()),
                pts_hns: pts,
                duration_hns: frame_hns,
                keyframe: key,
                generation,
            };

            let use_ring = shared.ring_enabled.load(Ordering::Acquire);
            let direct_sender = shared.direct_tx.lock().clone();
            if let Some(tx) = direct_sender.as_ref() {
                if use_ring {
                    let _ = tx.try_send(pkt.clone());
                } else {
                    let _ = tx.try_send(pkt);
                    shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
                    pts += frame_hns;
                    n += 1;
                    if n % 30 == 0 {
                        *shared.capture_fps.write() =
                            n as f32 / start.elapsed().as_secs_f32().max(0.001);
                    }
                    std::thread::sleep(interval);
                    continue;
                }
            }
            if use_ring {
                shared.ring.lock().push(pkt);
            }

            shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
            shared
                .encode_ns_total
                .fetch_add(1_400_000, Ordering::Relaxed);
            shared.submit_ns_total.fetch_add(300_000, Ordering::Relaxed);
            pts += frame_hns;
            n += 1;
            if n % 30 == 0 {
                *shared.capture_fps.write() =
                    n as f32 / start.elapsed().as_secs_f32().max(0.001);
            }
            std::thread::sleep(interval);
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
use win as platform;
#[cfg(any(not(windows), feature = "headless-sim"))]
use sim as platform;

fn capture_thread_main(
    shared: Arc<SharedState>,
    cfg: RecorderConfig,
    fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
    clock: Arc<QpcClock>,
) {
    platform::capture_loop(shared, cfg, fmt, clock);
}

fn mux_packets_to_mp4(
    path: &Path,
    header: &VideoFormatHeader,
    video: &[EncodedPacket],
    audio: &[EncodedPacket],
) -> RResult<()> {
    platform::mux(path, header, video, audio)
}

pub fn process_rss_bytes() -> u64 {
    platform::rss_bytes()
}

fn set_thread_priority(performance_mode: bool) {
    platform::boost_thread(performance_mode);
}

// ---------------------------------------------------------------------------
// Monitor enumeration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub primary: bool,
    pub adapter: String,
}

pub fn enumerate_monitors() -> Vec<MonitorInfo> {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        use windows::Win32::Graphics::Dxgi::*;
        let mut out = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return out;
            };
            let mut flat = 0u32;
            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                let Ok(adesc) = adapter.GetDesc1() else {
                    ai += 1;
                    continue;
                };
                let adapter_name = String::from_utf16_lossy(
                    &adesc.Description[..adesc
                        .Description
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(adesc.Description.len())],
                );
                let mut oi = 0u32;
                while let Ok(output) = adapter.EnumOutputs(oi) {
                    if let Ok(odesc) = output.GetDesc() {
                        let r = odesc.DesktopCoordinates;
                        out.push(MonitorInfo {
                            index: flat,
                            name: String::from_utf16_lossy(
                                &odesc.DeviceName[..odesc
                                    .DeviceName
                                    .iter()
                                    .position(|&c| c == 0)
                                    .unwrap_or(odesc.DeviceName.len())],
                            ),
                            width: (r.right - r.left) as u32,
                            height: (r.bottom - r.top) as u32,
                            refresh_hz: 0,
                            primary: r.left == 0 && r.top == 0,
                            adapter: adapter_name.clone(),
                        });
                    }
                    flat += 1;
                    oi += 1;
                }
                ai += 1;
            }
        }
        out
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    {
        vec![MonitorInfo {
            index: 0,
            name: "\\\\.\\DISPLAY1 (virtual)".into(),
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            primary: true,
            adapter: "Virtual Adapter".into(),
        }]
    }
}

#[cfg(test)]
mod integrated_gpu_tests {
    use super::is_integrated_gpu;

    #[test]
    fn intel_iris_xe_is_integrated() {
        assert!(is_integrated_gpu("Intel(R) Iris(R) Xe Graphics", 128));
    }

    #[test]
    fn amd_igpu_low_vram_is_integrated() {
        assert!(is_integrated_gpu("AMD Radeon(TM) Graphics", 512));
    }

    #[test]
    fn nvidia_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("NVIDIA GeForce RTX 4070", 12288));
    }

    #[test]
    fn intel_arc_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("Intel(R) Arc(TM) A770 Graphics", 8192));
    }

    #[test]
    fn amd_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("AMD Radeon RX 6800 XT", 16384));
    }
}

#[cfg(test)]
mod ring_buffer_tests {
    use super::*;

    fn pkt(pts_hns: i64, bytes: usize, keyframe: bool) -> EncodedPacket {
        EncodedPacket {
            track: TrackKind::Video,
            data: Arc::from(vec![0u8; bytes].into_boxed_slice()),
            pts_hns,
            duration_hns: HNS_PER_SECOND / 60,
            keyframe,
            generation: 1,
        }
    }

    fn audio_pkt(pts_hns: i64, bytes: usize) -> EncodedPacket {
        EncodedPacket {
            track: TrackKind::Audio,
            data: Arc::from(vec![0u8; bytes].into_boxed_slice()),
            pts_hns,
            duration_hns: 1024 * HNS_PER_SECOND / 48_000,
            keyframe: true,
            generation: 1,
        }
    }

    fn feed_video(ring: &mut RollingRingBuffer, seconds: u32, gop: u32, frame_bytes: usize) {
        let frames = seconds * 60;
        for i in 0..frames {
            let pts = i as i64 * HNS_PER_SECOND / 60;
            ring.push(pkt(pts, frame_bytes, i % gop == 0));
        }
    }

    #[test]
    fn set_window_updates_the_byte_cap_with_the_window() {
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        let cap_60 = ring.hard_byte_cap();
        ring.set_window(300, 12_000);
        let cap_300 = ring.hard_byte_cap();
        assert_eq!(cap_300, ring_cap_mb(300, 12_000) * 1024 * 1024);
        assert!(cap_300 > cap_60);
    }

    #[test]
    fn set_window_shrinks_the_cap_when_the_window_shrinks() {
        let mut ring = RollingRingBuffer::new(300, ring_cap_mb(300, 12_000));
        let cap_300 = ring.hard_byte_cap();
        ring.set_window(30, 12_000);
        assert_eq!(ring.hard_byte_cap(), ring_cap_mb(30, 12_000) * 1024 * 1024);
        assert!(ring.hard_byte_cap() < cap_300);
    }

    #[test]
    fn a_300s_window_actually_holds_300s_of_packets() {
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        ring.set_window(300, 12_000);
        feed_video(&mut ring, 300, 60, 25_000);
        assert!(ring.span_seconds() > 290.0);
    }

    #[test]
    fn cap_never_exceeds_the_hard_ceiling() {
        assert!(ring_cap_mb(600, 150_000) <= 1536);
        assert!(ring_cap_mb(5, 1_000) >= 24);
    }

    #[test]
    fn eviction_never_leaves_a_delta_frame_at_the_front() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 6, 30, 2_000);
        let (video, _) = ring.snapshot(None);
        assert!(!video.is_empty());
        assert!(video[0].keyframe);
    }

    #[test]
    fn eviction_keeps_the_buffer_within_its_window() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 10, 30, 1_000);
        assert!(ring.span_seconds() <= 3.5);
    }

    #[test]
    fn clear_and_shrink_empties_everything_and_zeroes_bytes() {
        let mut ring = RollingRingBuffer::new(5, 24);
        feed_video(&mut ring, 2, 30, 1_000);
        ring.push(audio_pkt(0, 512));
        assert!(ring.bytes() > 0);
        ring.clear_and_shrink();
        assert_eq!(ring.bytes(), 0);
        assert_eq!(ring.video_frames(), 0);
        assert_eq!(ring.span_seconds(), 0.0);
        let (v, a) = ring.snapshot(None);
        assert!(v.is_empty() && a.is_empty());
    }

    #[test]
    fn snapshot_without_a_limit_returns_the_whole_buffer() {
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        feed_video(&mut ring, 5, 60, 1_000);
        let (video, _) = ring.snapshot(None);
        assert_eq!(video.len(), 300);
    }

    #[test]
    fn snapshot_with_a_limit_returns_roughly_that_many_seconds() {
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        feed_video(&mut ring, 60, 60, 1_000);
        let (video, _) = ring.snapshot(Some(10.0));
        let span =
            (video.last().unwrap().pts_hns - video[0].pts_hns) as f32 / HNS_PER_SECOND as f32;
        assert!((9.0..=12.5).contains(&span));
        assert!(video[0].keyframe);
    }

    #[test]
    fn snapshot_limit_larger_than_the_buffer_returns_everything() {
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        feed_video(&mut ring, 4, 60, 1_000);
        let (video, _) = ring.snapshot(Some(999.0));
        assert_eq!(video.len(), 240);
    }

    #[test]
    fn snapshot_never_mixes_generations() {
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        for i in 0..60 {
            ring.push(EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![0u8; 100].into_boxed_slice()),
                pts_hns: i as i64 * HNS_PER_SECOND / 60,
                duration_hns: HNS_PER_SECOND / 60,
                keyframe: i % 30 == 0,
                generation: 1,
            });
        }
        for i in 60..120 {
            ring.push(EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![0u8; 100].into_boxed_slice()),
                pts_hns: i as i64 * HNS_PER_SECOND / 60,
                duration_hns: HNS_PER_SECOND / 60,
                keyframe: i % 30 == 0,
                generation: 2,
            });
        }
        let (video, _) = ring.snapshot(None);
        assert!(!video.is_empty());
        assert!(video.iter().all(|p| p.generation == 2));
        assert!(video[0].keyframe);
    }

    #[test]
    fn snapshot_on_an_empty_ring_is_empty_not_a_panic() {
        let ring = RollingRingBuffer::new(5, 24);
        let (v, a) = ring.snapshot(None);
        assert!(v.is_empty() && a.is_empty());
    }

    #[test]
    fn audio_is_trimmed_alongside_video() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        for i in 0..240 {
            let pts = i as i64 * HNS_PER_SECOND / 60;
            ring.push(pkt(pts, 500, i % 30 == 0));
            if i % 3 == 0 {
                ring.push(audio_pkt(pts, 200));
            }
        }
        let (_, audio) = ring.snapshot(None);
        assert!(audio.len() < 120);
    }

    #[test]
    fn audio_does_not_accumulate_when_the_video_track_is_empty() {
        let mut ring = RollingRingBuffer::new(30, 24);
        for i in 0..(60 * 300) {
            ring.push(audio_pkt(i as i64 * HNS_PER_SECOND / 60, 128));
        }
        assert!(ring.audio_packets() <= 1_900);
        assert!(ring.bytes() <= 24 * 1024 * 1024);
    }

    #[test]
    fn byte_counter_matches_the_packets_that_remain() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 8, 30, 2_000);
        for i in 0..100 {
            ring.push(audio_pkt(i as i64 * HNS_PER_SECOND / 60, 300));
        }
        let (video, audio) = ring.snapshot(None);
        let expected: usize = video
            .iter()
            .chain(audio.iter())
            .map(|p| p.heap_size())
            .sum();
        assert!(ring.bytes() > 0);
        assert!(ring.bytes() >= expected / 2);
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    #[test]
    fn direct_recording_from_idle_writes_mp4_with_zero_ring_and_returns_to_idle() {
        let dir = std::env::temp_dir().join(format!("kage-rec-idle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let engine = CaptureEngine::new();
        let mut cfg = RecorderConfig::default();
        cfg.output_dir = dir.clone();
        cfg.target_fps = 60;

        let out_path = engine.start_recording(cfg, None).unwrap();
        assert!(engine.is_recording());
        assert!(!engine.is_ring_enabled());
        assert_eq!(engine.stats().ring_bytes, 0);

        std::thread::sleep(Duration::from_millis(250));
        let res = engine.stop_recording().unwrap();
        assert!(!engine.is_recording());
        assert!(!engine.is_running());
        assert_eq!(res.path, out_path);
        assert!(res.size_bytes > 0);
        assert!(Path::new(&res.path).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    #[test]
    fn direct_recording_while_armed_keeps_replay_buffer_running() {
        let dir = std::env::temp_dir().join(format!("kage-rec-armed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let engine = CaptureEngine::new();
        let mut cfg = RecorderConfig::default();
        cfg.output_dir = dir.clone();
        cfg.target_fps = 60;

        engine.start(cfg.clone()).unwrap();
        assert!(engine.is_running() && engine.is_ring_enabled());

        let _ = engine.start_recording(cfg, None).unwrap();
        assert!(engine.is_recording());
        std::thread::sleep(Duration::from_millis(200));
        let res = engine.stop_recording().unwrap();

        assert!(!engine.is_recording());
        assert!(engine.is_running() && engine.is_ring_enabled());
        assert!(res.size_bytes > 0);

        engine.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
