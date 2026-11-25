//! WASAPI loopback + microphone capture, mixed and AAC-encoded into the
//! rolling ring buffer and/or direct MP4 recording stream.
//!
//! Drift tracking:
//! WASAPI hands every packet a QPC timestamp taken by the audio engine itself.
//! We convert that stamp with the same [`QpcClock`] epoch used for video, and
//! report smoothed clock-vs-PTS drift into `SharedState::audio_drift_tenths_ms`.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::recorder::{
    EncodedPacket, QpcClock, RecorderError, RollingRingBuffer, TrackKind, HNS_PER_SECOND,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const AAC_BYTES_PER_SECOND: u32 = 24_000; // 192 kbit/s stereo

pub fn enumerate_audio_devices() -> Vec<AudioDevice> {
    imp::enumerate_audio_devices()
}

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl AudioCapture {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        system: bool,
        mic: bool,
        game_gain: Arc<AtomicU32>,
        mic_gain: Arc<AtomicU32>,
        mic_device: Arc<parking_lot::RwLock<Option<String>>>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        ring_enabled: Arc<AtomicBool>,
        direct_tx: Arc<Mutex<Option<SyncSender<EncodedPacket>>>>,
        generation: Arc<AtomicU32>,
        status: Arc<Mutex<Option<String>>>,
        drift_tenths_ms: Arc<AtomicI32>,
        clock: Arc<QpcClock>,
        performance_mode: bool,
        privacy_gate: Arc<AtomicBool>,
    ) -> Result<Self, RecorderError> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        if system || mic {
            let stop_c = Arc::clone(&stop);
            let gg_c = Arc::clone(&game_gain);
            let mg_c = Arc::clone(&mic_gain);
            let md_c = Arc::clone(&mic_device);
            let ring_c = Arc::clone(&ring);
            let re_c = Arc::clone(&ring_enabled);
            let dt_c = Arc::clone(&direct_tx);
            let gen_c = Arc::clone(&generation);
            let status_c = Arc::clone(&status);
            let drift_c = Arc::clone(&drift_tenths_ms);
            let clock_c = Arc::clone(&clock);
            let gate_c = Arc::clone(&privacy_gate);
            let h = std::thread::Builder::new()
                .name("kage-audio".into())
                .spawn(move || {
                    imp::run(
                        system,
                        mic,
                        gg_c,
                        mg_c,
                        md_c,
                        stop_c,
                        ring_c,
                        re_c,
                        dt_c,
                        gen_c,
                        status_c,
                        drift_c,
                        clock_c,
                        performance_mode,
                        gate_c,
                    );
                })
                .map_err(|e| RecorderError::Other(format!("audio thread: {e}")))?;
            handles.push(h);
        }

        Ok(Self { stop, handles })
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Release);
        for h in self.handles {
            let _ = h.join();
        }
    }
}

// Windows WASAPI and AAC MFT implementation

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL, THREAD_PRIORITY_NORMAL,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };

    /// RAII guard for COM apartment initialization. Only uninitializes if this
    /// call actually succeeded (S_OK or S_FALSE); skips on RPC_E_CHANGED_MODE.
    struct ComGuard(bool);
    impl ComGuard {
        unsafe fn init() -> Self {
            Self(CoInitializeEx(None, COINIT_MULTITHREADED).is_ok())
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    /// RAII guard for Media Foundation startup/shutdown paired with COM.
    struct MfAudioGuard;
    impl MfAudioGuard {
        unsafe fn init() -> windows::core::Result<Self> {
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)?;
            Ok(Self)
        }
    }
    impl Drop for MfAudioGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
            }
        }
    }

    /// RAII guard for `CoTaskMemAlloc`-backed pointers (`GetMixFormat`, `GetId`).
    struct CoTaskPtr<T>(*mut T);
    impl<T> Drop for CoTaskPtr<T> {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CoTaskMemFree(Some(self.0 as *const std::ffi::c_void));
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(super) fn enumerate_audio_devices() -> Vec<AudioDevice> {
        let mut devices = Vec::new();
        unsafe {
            let _com = ComGuard::init();
            let enumerator: IMMDeviceEnumerator =
                match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    Ok(e) => e,
                    Err(_) => return devices,
                };

            let default_id = enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .ok()
                .and_then(|d| d.GetId().ok())
                .map(|pw| {
                    let _guard = CoTaskPtr(pw.0);
                    pw.to_string().unwrap_or_default()
                });

            let collection = match enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) {
                Ok(c) => c,
                Err(_) => return devices,
            };

            let count = collection.GetCount().unwrap_or(0);
            for i in 0..count {
                if let Ok(device) = collection.Item(i) {
                    let id = match device.GetId() {
                        Ok(pw) => {
                            let _guard = CoTaskPtr(pw.0);
                            pw.to_string().unwrap_or_default()
                        }
                        Err(_) => continue,
                    };
                    let name = device
                        .OpenPropertyStore(windows::Win32::System::Com::STGM(0))
                        .ok()
                        .and_then(|store| store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok())
                        .map(|pv| pv.to_string())
                        .unwrap_or_else(|| "Unknown Microphone".to_string());

                    let is_default = default_id.as_deref() == Some(&id);
                    devices.push(AudioDevice {
                        id,
                        name,
                        is_default,
                    });
                }
            }
        }
        devices
    }

    const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: windows::core::GUID =
        windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

    pub(super) struct Endpoint {
        pub(super) client: IAudioClient,
        pub(super) capture: IAudioCaptureClient,
        pub(super) channels: u32,
        pub(super) rate: u32,
        pub(super) float: bool,
        pub(super) bits: u32,
        pub(super) resample_phase: f64,
        pub(super) prev_frame: [f32; 2],
        pub(super) has_prev: bool,
        pub(super) temp_stereo: Vec<f32>,
        pub(super) temp_i16: Vec<f32>,
    }

    pub(super) unsafe fn open_endpoint(
        loopback: bool,
        device_id: Option<&str>,
    ) -> windows::core::Result<Endpoint> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = if loopback {
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?
        } else if let Some(id) = device_id.filter(|s| !s.is_empty() && *s != "default") {
            let hstring = windows::core::HSTRING::from(id);
            match enumerator.GetDevice(&hstring) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!(
                        "[kage::audio] specific capture device '{id}' not found ({e}), falling back to default"
                    );
                    enumerator
                        .GetDefaultAudioEndpoint(eCapture, eConsole)
                        .or_else(|_| enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications))?
                }
            }
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .or_else(|_| enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications))?
        };

        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let mix = client.GetMixFormat()?;
        let _mix_guard = CoTaskPtr(mix);
        let wf = &*mix;

        let flags = if loopback {
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        } else {
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        };

        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            20_0000, // 20 ms buffer in 100 ns units
            0,
            mix,
            None,
        )?;

        let capture: IAudioCaptureClient = client.GetService()?;
        let channels = wf.nChannels as u32;
        let rate = wf.nSamplesPerSec;
        let bits = wf.wBitsPerSample as u32;

        let float = if wf.wFormatTag == 0xFFFE {
            if (wf.cbSize as usize) < 22 {
                false
            } else {
                let ext = mix as *const WAVEFORMATEXTENSIBLE;
                let subformat = std::ptr::addr_of!((*ext).SubFormat).read_unaligned();
                subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            }
        } else {
            wf.wFormatTag == 3
        };

        client.Start()?;

        Ok(Endpoint {
            client,
            capture,
            channels,
            rate,
            float,
            bits,
            resample_phase: 0.0,
            prev_frame: [0.0, 0.0],
            has_prev: false,
            temp_stereo: Vec::new(),
            temp_i16: Vec::new(),
        })
    }

    fn resample_stereo(
        src: &[f32],
        in_rate: u32,
        out_rate: u32,
        phase: &mut f64,
        prev_frame: &mut [f32; 2],
        has_prev: &mut bool,
        out: &mut Vec<f32>,
    ) {
        if in_rate == out_rate || src.is_empty() {
            if let Some(last) = src.chunks_exact(2).last() {
                *prev_frame = [last[0], last[1]];
                *has_prev = true;
            }
            out.extend_from_slice(src);
            return;
        }
        let in_frames = src.len() / 2;
        if in_frames == 0 {
            return;
        }
        let ratio = in_rate as f64 / out_rate as f64;
        let mut p = *phase;
        if *has_prev {
            while p < in_frames as f64 {
                let idx = p.floor() as usize;
                let frac = (p - idx as f64) as f32;
                let (l0, r0) = if idx == 0 {
                    (prev_frame[0], prev_frame[1])
                } else {
                    let k = (idx - 1) * 2;
                    (src[k], src[k + 1])
                };
                let (l1, r1) = if idx < in_frames {
                    let k = idx * 2;
                    (src[k], src[k + 1])
                } else {
                    let k = (in_frames - 1) * 2;
                    (src[k], src[k + 1])
                };
                out.push(l0 + (l1 - l0) * frac);
                out.push(r0 + (r1 - r0) * frac);
                p += ratio;
            }
            *phase = (p - in_frames as f64).max(0.0);
        } else if in_frames >= 2 {
            while p < (in_frames - 1) as f64 {
                let idx = p.floor() as usize;
                let frac = (p - idx as f64) as f32;
                let i0 = idx * 2;
                let i1 = (idx + 1) * 2;
                out.push(src[i0] + (src[i1] - src[i0]) * frac);
                out.push(src[i0 + 1] + (src[i1 + 1] - src[i0 + 1]) * frac);
                p += ratio;
            }
            *phase = (p - (in_frames - 1) as f64).max(0.0);
        }
        let last = (in_frames - 1) * 2;
        *prev_frame = [src[last], src[last + 1]];
        *has_prev = true;
    }

    unsafe fn drain_endpoint(
        ep: &mut Endpoint,
        out: &mut Vec<f32>,
        qpc_first: &mut Option<i64>,
    ) -> bool {
        loop {
            let packet = match ep.capture.GetNextPacketSize() {
                Ok(p) => p,
                Err(e) => {
                    log::warn!(
                        "[kage::audio] GetNextPacketSize failed (device may be reset/disconnected): {e}"
                    );
                    return false;
                }
            };
            if packet == 0 {
                return true;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut dev_pos = 0u64;
            let mut qpc = 0u64;
            if let Err(e) = ep.capture.GetBuffer(
                &mut data,
                &mut frames,
                &mut flags,
                Some(&mut dev_pos),
                Some(&mut qpc),
            ) {
                log::warn!("[kage::audio] GetBuffer failed: {e}");
                return false;
            }
            if qpc_first.is_none() && qpc != 0 {
                *qpc_first = Some(qpc as i64);
            }

            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let n = frames as usize * ep.channels as usize;
            let frames_channels = frames as usize * CHANNELS as usize;

            if n == 0 || ep.channels == 0 {
                let _ = ep.capture.ReleaseBuffer(frames);
                continue;
            }

            let decode_samples = |dst: &mut Vec<f32>| {
                dst.clear();
                if ep.float && ep.bits == 32 {
                    let src = data as *const f32;
                    for i in 0..n {
                        dst.push(std::ptr::read_unaligned(src.add(i)));
                    }
                } else if !ep.float && ep.bits == 16 {
                    let src = data as *const i16;
                    for i in 0..n {
                        dst.push(std::ptr::read_unaligned(src.add(i)) as f32 / 32768.0);
                    }
                } else if !ep.float && ep.bits == 24 {
                    for i in 0..n {
                        let off = i * 3;
                        let b0 = *data.add(off) as i32;
                        let b1 = (*data.add(off + 1) as i32) << 8;
                        let b2 = ((*data.add(off + 2) as i8) as i32) << 16;
                        dst.push((b0 | b1 | b2) as f32 / 8_388_608.0);
                    }
                } else if !ep.float && ep.bits == 32 {
                    let src = data as *const i32;
                    for i in 0..n {
                        dst.push(std::ptr::read_unaligned(src.add(i)) as f32 / 2_147_483_648.0);
                    }
                } else {
                    dst.resize(n, 0.0);
                }
            };

            if ep.rate == SAMPLE_RATE {
                if silent || data.is_null() {
                    out.resize(out.len() + frames_channels, 0.0);
                } else {
                    decode_samples(&mut ep.temp_i16);
                    downmix(&ep.temp_i16, ep.channels, out);
                }
            } else {
                ep.temp_stereo.clear();
                if silent || data.is_null() {
                    ep.temp_stereo.resize(frames_channels, 0.0);
                } else {
                    decode_samples(&mut ep.temp_i16);
                    downmix(&ep.temp_i16, ep.channels, &mut ep.temp_stereo);
                }
                resample_stereo(
                    &ep.temp_stereo,
                    ep.rate,
                    SAMPLE_RATE,
                    &mut ep.resample_phase,
                    &mut ep.prev_frame,
                    &mut ep.has_prev,
                    out,
                );
            }
            let _ = ep.capture.ReleaseBuffer(frames);
        }
    }

    fn downmix(src: &[f32], channels: u32, out: &mut Vec<f32>) {
        match channels {
            0 => {}
            1 => {
                for s in src {
                    out.push(*s);
                    out.push(*s);
                }
            }
            2 => out.extend_from_slice(src),
            n => {
                let n = n as usize;
                for frame in src.chunks_exact(n) {
                    let c = frame.get(2).copied().unwrap_or(0.0) * 0.707;
                    let l = frame[0] + c + frame.get(4).copied().unwrap_or(0.0) * 0.707;
                    let r = frame[1] + c + frame.get(5).copied().unwrap_or(0.0) * 0.707;
                    out.push(l.clamp(-1.0, 1.0));
                    out.push(r.clamp(-1.0, 1.0));
                }
            }
        }
    }

    /// Media Foundation AAC encoder MFT wrapper (PCM16 stereo 48 kHz -> AAC-LC).
    /// Preallocates its output buffer/sample so steady-state encoding creates
    /// zero per-frame COM heap allocations, and releases `ManuallyDrop` outputs
    /// on *every* exit path of `ProcessOutput` (including `NEED_MORE_INPUT`).
    struct AacEncoder {
        transform: IMFTransform,
        in_buf: IMFMediaBuffer,
        in_sample: IMFSample,
        in_cap: u32,
        out_buf: IMFMediaBuffer,
        out_sample: IMFSample,
        out_cap: u32,
    }

    impl AacEncoder {
        unsafe fn new() -> windows::core::Result<Self> {
            let transform: IMFTransform = CoCreateInstance(
                &AACMFTEncoder,
                None,
                windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
            )?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2)?;
            in_type.SetUINT32(
                &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                SAMPLE_RATE * CHANNELS * 2,
            )?;

            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            out_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            out_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            out_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
            out_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
            out_type.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;

            transform.SetOutputType(0, &out_type, 0)?;
            transform.SetInputType(0, &in_type, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            let in_cap = 1024 * CHANNELS * 2;
            let in_buf = MFCreateMemoryBuffer(in_cap)?;
            let in_sample = MFCreateSample()?;
            in_sample.AddBuffer(&in_buf)?;

            let out_cap = transform
                .GetOutputStreamInfo(0)
                .map(|i| i.cbSize.max(4096))
                .unwrap_or(4096);
            let out_buf = MFCreateMemoryBuffer(out_cap)?;
            let out_sample = MFCreateSample()?;
            out_sample.AddBuffer(&out_buf)?;

            Ok(Self {
                transform,
                in_buf,
                in_sample,
                in_cap,
                out_buf,
                out_sample,
                out_cap,
            })
        }

        unsafe fn encode(
            &mut self,
            pcm: &[i16],
            pts_hns: i64,
            mut sink: impl FnMut(&[u8], i64, i64),
        ) -> windows::core::Result<()> {
            let bytes = (pcm.len() * 2) as u32;
            if bytes > self.in_cap {
                self.in_buf = MFCreateMemoryBuffer(bytes)?;
                self.in_sample = MFCreateSample()?;
                self.in_sample.AddBuffer(&self.in_buf)?;
                self.in_cap = bytes;
            }
            let mut ptr: *mut u8 = std::ptr::null_mut();
            self.in_buf.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, ptr, bytes as usize);
            self.in_buf.Unlock()?;
            self.in_buf.SetCurrentLength(bytes)?;

            let duration =
                (pcm.len() as i64 / CHANNELS as i64) * HNS_PER_SECOND / SAMPLE_RATE as i64;
            self.in_sample.SetSampleTime(pts_hns)?;
            self.in_sample.SetSampleDuration(duration)?;
            self.transform.ProcessInput(0, &self.in_sample, 0)?;

            loop {
                let mut status = 0u32;
                let info = self.transform.GetOutputStreamInfo(0)?;
                let needed = info.cbSize.max(4096);
                if needed > self.out_cap {
                    self.out_buf = MFCreateMemoryBuffer(needed)?;
                    self.out_sample = MFCreateSample()?;
                    self.out_sample.AddBuffer(&self.out_buf)?;
                    self.out_cap = needed;
                }
                let _ = self.out_buf.SetCurrentLength(0);

                let mut out = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(Some(self.out_sample.clone())),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                }];

                let result = self.transform.ProcessOutput(0, &mut out, &mut status);
                // Return COM refs lent to MFT on every exit path, including NEED_MORE_INPUT.
                drop(std::mem::ManuallyDrop::take(&mut out[0].pSample));
                drop(std::mem::ManuallyDrop::take(&mut out[0].pEvents));
                match result {
                    Ok(()) => {}
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) => return Err(e),
                }

                let t = self.out_sample.GetSampleTime().unwrap_or(pts_hns);
                let d = self.out_sample.GetSampleDuration().unwrap_or(duration);
                let contiguous = self.out_sample.ConvertToContiguousBuffer()?;
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut cur = 0u32;
                contiguous.Lock(&mut p, None, Some(&mut cur))?;
                if cur > 0 && !p.is_null() {
                    let payload = std::slice::from_raw_parts(p, cur as usize);
                    sink(payload, t, d);
                }
                let _ = contiguous.Unlock();
            }
        }
    }

    impl Drop for AacEncoder {
        fn drop(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
    }

    unsafe fn open_reported(
        loopback: bool,
        device_id: Option<&str>,
        status: &Mutex<Option<String>>,
    ) -> Result<Option<Endpoint>, ()> {
        match open_endpoint(loopback, device_id) {
            Ok(ep) => Ok(Some(ep)),
            Err(e) => {
                let msg = if loopback {
                    format!("system audio loopback unavailable: {e}")
                } else {
                    format!("microphone unavailable: {e}")
                };
                *status.lock() = Some(msg.clone());
                log::warn!("[kage::audio] {msg}");
                Err(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn run(
        system: bool,
        mic: bool,
        game_gain: Arc<AtomicU32>,
        mic_gain: Arc<AtomicU32>,
        mic_device: Arc<parking_lot::RwLock<Option<String>>>,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        ring_enabled: Arc<AtomicBool>,
        direct_tx: Arc<Mutex<Option<SyncSender<EncodedPacket>>>>,
        generation: Arc<AtomicU32>,
        status: Arc<Mutex<Option<String>>>,
        drift_tenths_ms: Arc<AtomicI32>,
        clock: Arc<QpcClock>,
        performance_mode: bool,
        privacy_gate: Arc<AtomicBool>,
    ) {
        unsafe {
            let priority = if performance_mode {
                THREAD_PRIORITY_NORMAL
            } else {
                THREAD_PRIORITY_ABOVE_NORMAL
            };
            let _ = SetThreadPriority(GetCurrentThread(), priority);

            let poll_ms: u64 = if performance_mode { 10 } else { 8 };

            let _com = ComGuard::init();
            let _mf = match MfAudioGuard::init() {
                Ok(m) => m,
                Err(_) => {
                    *status.lock() = Some("Media Foundation failed to start".into());
                    return;
                }
            };

            let mut loopback: Option<Endpoint> = None;
            let mut microphone: Option<Endpoint> = None;
            let mut encoder: Option<AacEncoder> = None;
            let mut last_attempt = std::time::Instant::now() - std::time::Duration::from_secs(2);
            let mut current_mic_id = mic_device.read().clone();

            const FRAME_SAMPLES: usize = 1024 * CHANNELS as usize;
            let frame_duration_hns: i64 = (1024 * HNS_PER_SECOND) / SAMPLE_RATE as i64;

            let mut sys_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut mic_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut mixed_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut pcm = Vec::<i16>::with_capacity(FRAME_SAMPLES);
            let mut qpc_first: Option<i64> = None;
            let mut drift_tick: u32 = 0;

            let mut next_pts = clock.now_hns();

            while !stop.load(Ordering::Acquire) {
                let requested_mic_id = mic_device.read().clone();
                if requested_mic_id != current_mic_id {
                    current_mic_id = requested_mic_id;
                    if let Some(ep) = microphone.take() {
                        let _ = ep.client.Stop();
                    }
                    last_attempt = std::time::Instant::now() - std::time::Duration::from_secs(2);
                }

                if last_attempt.elapsed() >= std::time::Duration::from_secs(1) {
                    last_attempt = std::time::Instant::now();
                    if system && loopback.is_none() {
                        if let Ok(Some(ep)) = open_reported(true, None, &status) {
                            loopback = Some(ep);
                        }
                    }
                    if mic && microphone.is_none() {
                        if let Ok(Some(ep)) = open_reported(false, current_mic_id.as_deref(), &status)
                        {
                            microphone = Some(ep);
                        }
                    }
                    if encoder.is_none() && (loopback.is_some() || microphone.is_some()) {
                        match AacEncoder::new() {
                            Ok(e) => {
                                encoder = Some(e);
                            }
                            Err(e) => {
                                *status.lock() = Some(format!("AAC encoder unavailable: {e}"));
                                log::warn!("[kage::audio] AAC MFT: {e}");
                            }
                        }
                    }
                    if encoder.is_some()
                        && (!system || loopback.is_some())
                        && (!mic || microphone.is_some())
                    {
                        *status.lock() = None;
                    }
                }

                if loopback.is_none() && microphone.is_none() {
                    next_pts = clock.now_hns();
                    std::thread::sleep(std::time::Duration::from_millis(poll_ms));
                    continue;
                }

                let sys_start_idx = sys_pending.len();
                if let Some(ep) = loopback.as_mut() {
                    if !drain_endpoint(ep, &mut sys_pending, &mut qpc_first) {
                        loopback = None;
                    }
                }
                let mic_start_idx = mic_pending.len();
                if let Some(ep) = microphone.as_mut() {
                    if !drain_endpoint(ep, &mut mic_pending, &mut qpc_first) {
                        microphone = None;
                    }
                }

                let gg = game_gain.load(Ordering::Acquire) as f32 * 0.001;
                let mg = mic_gain.load(Ordering::Acquire) as f32 * 0.001;
                if gg != 1.0 && sys_pending.len() > sys_start_idx {
                    for s in sys_pending.iter_mut().skip(sys_start_idx) {
                        *s = (*s * gg).clamp(-1.0, 1.0);
                    }
                }
                if mg != 1.0 && mic_pending.len() > mic_start_idx {
                    for s in mic_pending.iter_mut().skip(mic_start_idx) {
                        *s = (*s * mg).clamp(-1.0, 1.0);
                    }
                }

                if system && mic {
                    let both_active =
                        loopback.is_some() && gg > 0.0 && microphone.is_some() && mg > 0.0;
                    let mix_gain = if both_active { 0.707 } else { 1.0 };

                    let common = sys_pending.len().min(mic_pending.len());
                    for i in 0..common {
                        mixed_pending
                            .push(((sys_pending[i] + mic_pending[i]) * mix_gain).clamp(-1.0, 1.0));
                    }
                    sys_pending.drain(..common);
                    mic_pending.drain(..common);

                    if sys_pending.is_empty() && mic_pending.len() >= FRAME_SAMPLES {
                        let take = (mic_pending.len() / FRAME_SAMPLES) * FRAME_SAMPLES;
                        for s in mic_pending.drain(..take) {
                            mixed_pending.push((s * mix_gain).clamp(-1.0, 1.0));
                        }
                    }
                    if mic_pending.is_empty() && sys_pending.len() >= FRAME_SAMPLES {
                        let take = (sys_pending.len() / FRAME_SAMPLES) * FRAME_SAMPLES;
                        for s in sys_pending.drain(..take) {
                            mixed_pending.push((s * mix_gain).clamp(-1.0, 1.0));
                        }
                    }
                } else if system {
                    mixed_pending.append(&mut sys_pending);
                } else if mic {
                    mixed_pending.append(&mut mic_pending);
                }

                let now_hns = clock.now_hns();
                let mut virtual_pts = next_pts
                    + ((mixed_pending.len() / FRAME_SAMPLES) as i64) * frame_duration_hns;
                if now_hns > virtual_pts + frame_duration_hns {
                    if now_hns - virtual_pts > HNS_PER_SECOND * 2 {
                        next_pts = now_hns;
                        mixed_pending.clear();
                    } else {
                        while now_hns > virtual_pts + frame_duration_hns
                            && mixed_pending.len() < FRAME_SAMPLES * 4
                        {
                            mixed_pending.resize(mixed_pending.len() + FRAME_SAMPLES, 0.0);
                            virtual_pts += frame_duration_hns;
                        }
                    }
                }

                if sys_pending.len() > FRAME_SAMPLES * 16 {
                    sys_pending.drain(..sys_pending.len() - FRAME_SAMPLES * 16);
                }
                if mic_pending.len() > FRAME_SAMPLES * 16 {
                    mic_pending.drain(..mic_pending.len() - FRAME_SAMPLES * 16);
                }
                if mixed_pending.len() > FRAME_SAMPLES * 32 {
                    mixed_pending.drain(..mixed_pending.len() - FRAME_SAMPLES * 32);
                }

                let Some(enc) = encoder.as_mut() else {
                    std::thread::sleep(std::time::Duration::from_millis(poll_ms));
                    continue;
                };

                while mixed_pending.len() >= FRAME_SAMPLES {
                    pcm.clear();
                    pcm.extend(
                        mixed_pending
                            .drain(..FRAME_SAMPLES)
                            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
                    );

                    let pts = next_pts;
                    next_pts += frame_duration_hns;

                    // Update real A/V clock drift every ~20 AAC frames (~426 ms).
                    drift_tick = drift_tick.wrapping_add(1);
                    if drift_tick % 20 == 0 {
                        let drift_tenths = ((clock.now_hns() - next_pts) / 1_000) as i32;
                        drift_tenths_ms.store(drift_tenths, Ordering::Relaxed);
                    }

                    if privacy_gate.load(Ordering::Acquire) {
                        continue;
                    }

                    let use_ring = ring_enabled.load(Ordering::Acquire);
                    let direct_sender = direct_tx.lock().clone();
                    if !use_ring && direct_sender.is_none() {
                        continue;
                    }

                    let gen = generation.load(Ordering::Acquire);
                    let ring_ref = &ring;
                    if let Err(e) = enc.encode(&pcm, pts, |payload, t, d| {
                        let pkt = EncodedPacket {
                            track: TrackKind::Audio,
                            data: Arc::from(payload),
                            pts_hns: t,
                            duration_hns: d,
                            keyframe: true,
                            generation: gen,
                        };
                        if let Some(tx) = direct_sender.as_ref() {
                            if use_ring {
                                let _ = tx.try_send(pkt.clone());
                            } else {
                                let _ = tx.try_send(pkt);
                                return;
                            }
                        }
                        if use_ring {
                            ring_ref.lock().push(pkt);
                        }
                    }) {
                        log::warn!("[kage::audio] AAC encode error: {e}");
                    }
                }

                std::thread::sleep(std::time::Duration::from_millis(poll_ms));
            }

            if let Some(ep) = loopback.as_ref() {
                let _ = ep.client.Stop();
            }
            if let Some(ep) = microphone.as_ref() {
                let _ = ep.client.Stop();
            }
            drop(encoder);
        }
    }
}

// Non-Windows / simulation stub

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn enumerate_audio_devices() -> Vec<AudioDevice> {
        vec![
            AudioDevice {
                id: "default".into(),
                name: "Default Microphone (Simulated)".into(),
                is_default: true,
            },
            AudioDevice {
                id: "headset_mic".into(),
                name: "Headset Microphone (Simulated)".into(),
                is_default: false,
            },
        ]
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn run(
        _system: bool,
        _mic: bool,
        _game_gain: Arc<AtomicU32>,
        _mic_gain: Arc<AtomicU32>,
        _mic_device: Arc<parking_lot::RwLock<Option<String>>>,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        ring_enabled: Arc<AtomicBool>,
        direct_tx: Arc<Mutex<Option<SyncSender<EncodedPacket>>>>,
        generation: Arc<AtomicU32>,
        _status: Arc<Mutex<Option<String>>>,
        drift_tenths_ms: Arc<AtomicI32>,
        _clock: Arc<QpcClock>,
        _performance_mode: bool,
        privacy_gate: Arc<AtomicBool>,
    ) {
        let frame_hns = 1024 * HNS_PER_SECOND / SAMPLE_RATE as i64;
        let mut pts = 0i64;
        drift_tenths_ms.store(12, Ordering::Relaxed); // 1.2 ms nominal simulated drift
        while !stop.load(Ordering::Acquire) {
            if !privacy_gate.load(Ordering::Acquire) {
                let use_ring = ring_enabled.load(Ordering::Acquire);
                let direct_sender = direct_tx.lock().clone();
                if use_ring || direct_sender.is_some() {
                    let pkt = EncodedPacket {
                        track: TrackKind::Audio,
                        data: Arc::from(vec![0u8; 384].into_boxed_slice()),
                        pts_hns: pts,
                        duration_hns: frame_hns,
                        keyframe: true,
                        generation: generation.load(Ordering::Acquire),
                    };
                    if let Some(tx) = direct_sender.as_ref() {
                        if use_ring {
                            let _ = tx.try_send(pkt.clone());
                        } else {
                            let _ = tx.try_send(pkt);
                            pts += frame_hns;
                            std::thread::sleep(std::time::Duration::from_millis(21));
                            continue;
                        }
                    }
                    if use_ring {
                        ring.lock().push(pkt);
                    }
                }
            }
            pts += frame_hns;
            std::thread::sleep(std::time::Duration::from_millis(21));
        }
    }
}
