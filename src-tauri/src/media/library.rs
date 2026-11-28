//! Clip library: metadata scanning, disk-cached JPEG thumbnails, and lossless
//! (stream-copy) trimming.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::recorder::{RecorderError, RResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipMetadata {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub created_unix_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
    pub game: Option<String>,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimResult {
    pub path: String,
    pub file_name: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub elapsed_ms: f32,
    pub snapped_start_seconds: f32,
}

pub fn scan_directory(dir: &Path, with_thumbnails: bool) -> RResult<Vec<ClipMetadata>> {
    let clips = scan_directory_impl(dir, with_thumbnails, &ProbeCache::path())?;
    prune_thumb_cache(&clips);
    Ok(clips)
}

fn scan_directory_impl(
    dir: &Path,
    with_thumbnails: bool,
    cache_path: &Path,
) -> RResult<Vec<ClipMetadata>> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
        return Ok(Vec::new());
    }
    let mut cache = ProbeCache::load_from(cache_path);
    let mut clips = Vec::new();
    let mut dirty = false;
    let mut seen = std::collections::HashSet::new();
    scan_into(
        dir,
        dir,
        0,
        with_thumbnails,
        &mut clips,
        &mut cache,
        &mut seen,
        &mut dirty,
    )?;
    let before = cache.entries.len();
    cache.entries.retain(|k, _| seen.contains(k));
    if cache.entries.len() != before {
        dirty = true;
    }
    if dirty {
        cache.save_to(cache_path);
    }
    clips.sort_by_key(|c| std::cmp::Reverse(c.created_unix_ms));
    Ok(clips)
}

#[allow(clippy::too_many_arguments)]
fn scan_into(
    root: &Path,
    dir: &Path,
    depth: u32,
    with_thumbnails: bool,
    out: &mut Vec<ClipMetadata>,
    cache: &mut ProbeCache,
    seen: &mut std::collections::HashSet<String>,
    dirty: &mut bool,
) -> RResult<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth < 2 {
                let _ = scan_into(
                    root,
                    &path,
                    depth + 1,
                    with_thumbnails,
                    out,
                    cache,
                    seen,
                    dirty,
                );
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let is_video = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "mkv" | "mov"))
            .unwrap_or(false);
        if !is_video {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let created_unix_ms = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let key = path.to_string_lossy().to_string();
        seen.insert(key.clone());
        let mod_ms = modified_ms(&meta);
        let size = meta.len();
        let probe = match cache.entries.get(&key) {
            Some(c) if c.size_bytes == size && c.modified_ms == mod_ms && mod_ms != 0 => {
                c.probe.clone()
            }
            _ => {
                let p = probe(&path).unwrap_or_default();
                cache.entries.insert(
                    key.clone(),
                    CachedProbe {
                        size_bytes: size,
                        modified_ms: mod_ms,
                        probe: p.clone(),
                    },
                );
                *dirty = true;
                p
            }
        };
        let thumbnail = if with_thumbnails {
            extract_thumbnail(&path, (probe.duration_seconds * 0.25).clamp(0.2, 8.0)).ok()
        } else {
            None
        };

        let game = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .filter(|rel| !rel.as_os_str().is_empty())
            .map(|rel| rel.to_string_lossy().to_string());
        let id_key = key.clone();

        out.push(ClipMetadata {
            id: format!("{:x}", fnv1a(id_key.as_bytes()) ^ created_unix_ms as u64),
            path: path.to_string_lossy().to_string(),
            title: pretty_title(&file_name),
            file_name,
            duration_seconds: probe.duration_seconds,
            size_bytes: meta.len(),
            created_unix_ms,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            has_audio: probe.has_audio,
            game,
            thumbnail,
            favorite: false,
            tags: Vec::new(),
            external: false,
        });
    }
    Ok(())
}

pub fn delete_clip(path: &Path) -> RResult<()> {
    std::fs::remove_file(path)?;
    Ok(())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

fn pretty_title(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    stem.replace("KAGE_Replay_", "Replay ")
        .replace("KAGE_Rec_", "Rec ")
        .replace("ClipFlow_", "Clip ")
        .replace('_', " ")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub duration_seconds: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedProbe {
    size_bytes: u64,
    modified_ms: i64,
    probe: ProbeResult,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProbeCache {
    entries: std::collections::HashMap<String, CachedProbe>,
}

impl ProbeCache {
    fn path() -> PathBuf {
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return PathBuf::from(appdata).join("KAGE").join("probe_cache.json");
            }
        }
        std::env::temp_dir().join("KAGE").join("probe_cache.json")
    }

    fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save_to(&self, path: &Path) {
        let Ok(json) = serde_json::to_string(self) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, &json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn thumb_cache_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("KAGE").join("thumbs");
        }
    }
    std::env::temp_dir().join("KAGE").join("thumbs")
}

fn thumb_cache_file(dir: &Path, path: &Path, size_bytes: u64, modified_ms: i64) -> PathBuf {
    let key = format!("{}|{}|{}", path.to_string_lossy(), size_bytes, modified_ms);
    dir.join(format!("{:016x}.jpg", fnv1a(key.as_bytes())))
}

fn prune_thumb_cache(clips: &[ClipMetadata]) {
    let dir = thumb_cache_dir();
    if !dir.exists() {
        return;
    }
    let mut keep = std::collections::HashSet::with_capacity(clips.len());
    for c in clips {
        let p = Path::new(&c.path);
        let mod_ms = std::fs::metadata(p).map(|m| modified_ms(&m)).unwrap_or(0);
        if mod_ms != 0 {
            let f = thumb_cache_file(&dir, p, c.size_bytes, mod_ms);
            if let Some(name) = f.file_name().and_then(|s| s.to_str()) {
                keep.insert(name.to_string());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(s) = name.to_str() {
                if (s.ends_with(".jpg") && !keep.contains(s)) || s.ends_with(".tmp") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Default for ProbeResult {
    fn default() -> Self {
        Self {
            duration_seconds: 0.0,
            width: 0,
            height: 0,
            fps: 0,
            has_audio: false,
        }
    }
}

pub fn suggested_trim_path_in_dir(dir: &Path, source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    let mut candidate = dir.join(format!("{stem}_trim.mp4"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}_trim{n}.mp4"));
        n += 1;
    }
    candidate
}

pub fn suggested_trim_path(source: &Path) -> PathBuf {
    let dir = source.parent().unwrap_or_else(|| Path::new("."));
    suggested_trim_path_in_dir(dir, source)
}

pub fn metadata_for_file(path: &Path, output_dir: &Path) -> RResult<ClipMetadata> {
    let meta = std::fs::metadata(path)?;
    let info = probe(path)?;
    let created_unix_ms = meta
        .created()
        .or_else(|_| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let canon_file = std::fs::canonicalize(path).ok();
    let canon_root = std::fs::canonicalize(output_dir).ok();
    let external = match (&canon_file, &canon_root) {
        (Some(f), Some(r)) => !f.starts_with(r),
        _ => true,
    };
    let game = if !external {
        canon_file
            .as_ref()
            .zip(canon_root.as_ref())
            .and_then(|(f, r)| f.parent().and_then(|p| p.strip_prefix(r).ok()))
            .filter(|rel| !rel.as_os_str().is_empty())
            .map(|rel| rel.to_string_lossy().to_string())
    } else {
        None
    };
    let key = path.to_string_lossy().to_string();
    Ok(ClipMetadata {
        id: format!("{:x}", fnv1a(key.as_bytes()) ^ created_unix_ms as u64),
        path: key,
        title: pretty_title(&file_name),
        file_name,
        duration_seconds: info.duration_seconds,
        size_bytes: meta.len(),
        created_unix_ms,
        width: info.width,
        height: info.height,
        fps: info.fps,
        has_audio: info.has_audio,
        game,
        thumbnail: None,
        favorite: false,
        tags: Vec::new(),
        external,
    })
}

// Windows Media Foundation implementation

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use crate::media::recorder::HNS_PER_SECOND;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct Mf {
        com_owned: bool,
    }
    impl Mf {
        fn enter() -> RResult<Self> {
            unsafe {
                let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
                    if com_owned {
                        CoUninitialize();
                    }
                    return Err(RecorderError::Win(e.message().to_string()));
                }
                Ok(Mf { com_owned })
            }
        }
    }
    impl Drop for Mf {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                if self.com_owned {
                    CoUninitialize();
                }
            }
        }
    }

    fn wide(p: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        let s = p.to_string_lossy();
        let clean = match s.strip_prefix(r"\\?\") {
            Some(rest) if !rest.to_ascii_uppercase().starts_with("UNC\\") => Path::new(rest),
            _ => p,
        };
        clean
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn err(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    unsafe fn open_reader(path: &Path, compressed: bool, hardware: bool) -> RResult<IMFSourceReader> {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 4).map_err(err)?;
        let attrs = attrs.ok_or_else(|| RecorderError::Other("reader attrs".into()))?;
        if !compressed {
            attrs
                .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
                .map_err(err)?;
        }
        if hardware {
            attrs
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(err)?;
        }
        let w = wide(path);
        MFCreateSourceReaderFromURL(PCWSTR(w.as_ptr()), &attrs).map_err(err)
    }

    pub(super) fn probe(path: &Path) -> RResult<ProbeResult> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(path, true, true)?;
            let mut out = ProbeResult::default();

            if let Ok(v) = reader.GetPresentationAttribute(
                MF_SOURCE_READER_MEDIASOURCE.0 as u32,
                &MF_PD_DURATION,
            ) {
                if let Ok(hval) =
                    windows::Win32::System::Com::StructuredStorage::PropVariantToInt64(&v)
                {
                    out.duration_seconds = hval as f32 / HNS_PER_SECOND as f32;
                }
            }

            if let Ok(t) = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
            {
                if let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                    out.width = (size >> 32) as u32;
                    out.height = (size & 0xFFFF_FFFF) as u32;
                }
                if let Ok(rate) = t.GetUINT64(&MF_MT_FRAME_RATE) {
                    let num = (rate >> 32) as u32;
                    let den = (rate & 0xFFFF_FFFF) as u32;
                    out.fps = num.checked_div(den).unwrap_or(num);
                }
            }
            out.has_audio = reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0)
                .is_ok();
            Ok(out)
        }
    }

    fn decode_frame_rgb(
        path: &Path,
        at_seconds: f32,
        max_width: u32,
    ) -> RResult<(Vec<u8>, u32, u32)> {
        let _mf = Mf::enter()?;
        let seek_secs = if at_seconds.is_finite() {
            at_seconds.max(0.0)
        } else {
            0.0
        };

        unsafe {
            let mut reader_opt = None;
            let mut last_err = None;
            for hardware in [true, false] {
                let r = match open_reader(path, false, hardware) {
                    Ok(r) => r,
                    Err(e) => {
                        last_err = Some(e);
                        continue;
                    }
                };
                if let Err(e) = r
                    .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                    .map_err(err)
                    .and_then(|_| {
                        r.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
                            .map_err(err)
                    })
                    .and_then(|_| {
                        let rgb = MFCreateMediaType().map_err(err)?;
                        rgb.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                            .map_err(err)?;
                        rgb.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                            .map_err(err)?;
                        r.SetCurrentMediaType(
                            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                            None,
                            &rgb,
                        )
                        .map_err(err)
                    })
                {
                    last_err = Some(e);
                    continue;
                }
                reader_opt = Some(r);
                break;
            }
            let reader = reader_opt
                .ok_or_else(|| last_err.unwrap_or_else(|| RecorderError::Other("reader init failed".into())))?;

            let pos = (seek_secs as f64 * HNS_PER_SECOND as f64) as i64;
            let var = windows::core::PROPVARIANT::from(pos);
            let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &var);

            let mut current = reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .map_err(err)?;

            let mut sample: Option<IMFSample> = None;
            for pass in 0..2 {
                if pass == 1 {
                    let zero = windows::core::PROPVARIANT::from(0i64);
                    let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &zero);
                }
                for _ in 0..48 {
                    let mut stream_index = 0u32;
                    let mut flags = 0u32;
                    let mut ts = 0i64;
                    let mut s: Option<IMFSample> = None;
                    reader
                        .ReadSample(
                            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                            0,
                            Some(&mut stream_index),
                            Some(&mut flags),
                            Some(&mut ts),
                            Some(&mut s),
                        )
                        .map_err(err)?;
                    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32) != 0 {
                        if let Ok(updated) = reader
                            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                        {
                            current = updated;
                        }
                    }
                    if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                        break;
                    }
                    if s.is_some() {
                        sample = s;
                        break;
                    }
                }
                if sample.is_some() || pos == 0 {
                    break;
                }
            }

            let size = current.GetUINT64(&MF_MT_FRAME_SIZE).map_err(err)?;
            let w = (size >> 32) as u32;
            let h = (size & 0xFFFF_FFFF) as u32;
            if w == 0 || h == 0 {
                return Err(RecorderError::Other("thumbnail: zero frame size".into()));
            }

            let sample = sample.ok_or_else(|| RecorderError::Other("thumbnail: no frame".into()))?;
            let buffer = sample.ConvertToContiguousBuffer().map_err(err)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
            if ptr.is_null() || len == 0 {
                let _ = buffer.Unlock();
                return Err(RecorderError::Other("thumbnail: empty frame buffer".into()));
            }
            let src = std::slice::from_raw_parts(ptr, len as usize);

            let default_stride = current
                .GetUINT32(&MF_MT_DEFAULT_STRIDE)
                .map(|u| u as i32)
                .unwrap_or((w * 4) as i32);
            let stride = default_stride.unsigned_abs().max(w * 4) as usize;
            let bottom_up = default_stride < 0;

            let target_w = if max_width == 0 { w } else { max_width.min(w) };
            let target_h = ((target_w as f32) * h as f32 / w as f32).round().max(1.0) as u32;
            let mut rgb_buf = vec![0u8; (target_w * target_h * 3) as usize];
            for y in 0..target_h {
                let raw_sy = (y as u64 * h as u64 / target_h as u64) as usize;
                let sy = if bottom_up {
                    (h as usize).saturating_sub(1 + raw_sy)
                } else {
                    raw_sy
                };
                for x in 0..target_w {
                    let sx = (x as u64 * w as u64 / target_w as u64) as usize;
                    let si = sy * stride + sx * 4;
                    if si + 2 < src.len() {
                        let di = ((y * target_w + x) * 3) as usize;
                        rgb_buf[di] = src[si + 2];
                        rgb_buf[di + 1] = src[si + 1];
                        rgb_buf[di + 2] = src[si];
                    }
                }
            }
            let _ = buffer.Unlock();
            Ok((rgb_buf, target_w, target_h))
        }
    }

    pub(super) fn extract_frame_png(
        path: &Path,
        at_seconds: f32,
        max_width: u32,
    ) -> RResult<String> {
        let (rgb_buf, target_w, target_h) = decode_frame_rgb(path, at_seconds, max_width)?;
        let mut png = Vec::new();
        {
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                &mut png,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Adaptive,
            );
            image::ImageEncoder::write_image(
                encoder,
                &rgb_buf,
                target_w,
                target_h,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| RecorderError::Other(format!("png encode: {e}")))?;
        }
        use base64::Engine;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        ))
    }

    pub(super) fn extract_frame_jpeg_bytes(
        path: &Path,
        at_seconds: f32,
        max_width: u32,
    ) -> RResult<Vec<u8>> {
        let (rgb_buf, target_w, target_h) = decode_frame_rgb(path, at_seconds, max_width)?;
        let mut jpg = Vec::with_capacity(16 * 1024);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 82);
        image::ImageEncoder::write_image(
            encoder,
            &rgb_buf,
            target_w,
            target_h,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| RecorderError::Other(format!("jpeg encode: {e}")))?;
        Ok(jpg)
    }

    unsafe fn clone_aac_media_type(src: &IMFMediaType) -> RResult<IMFMediaType> {
        let atype = MFCreateMediaType().map_err(err)?;
        atype
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(err)?;
        atype
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(err)?;
        for key in [
            &MF_MT_AUDIO_SAMPLES_PER_SECOND,
            &MF_MT_AUDIO_NUM_CHANNELS,
            &MF_MT_AUDIO_BITS_PER_SAMPLE,
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            &MF_MT_AUDIO_BLOCK_ALIGNMENT,
            &MF_MT_AAC_PAYLOAD_TYPE,
            &MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
        ] {
            if let Ok(v) = src.GetUINT32(key) {
                let _ = atype.SetUINT32(key, v);
            }
        }
        if let Ok(sz) = src.GetBlobSize(&MF_MT_USER_DATA) {
            if sz > 0 {
                let mut blob = vec![0u8; sz as usize];
                if src.GetBlob(&MF_MT_USER_DATA, &mut blob, None).is_ok() {
                    let _ = atype.SetBlob(&MF_MT_USER_DATA, &blob);
                }
            }
        }
        Ok(atype)
    }

    fn trim_stream_copy_imp(
        source: &Path,
        dest: &Path,
        start: f32,
        end: f32,
    ) -> RResult<(f32, f32)> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(source, true, true)?;
            let mut video_stream_idx = None;
            let mut audio_stream_idx = None;
            for i in 0..16 {
                if let Ok(st) = reader.GetNativeMediaType(i, 0) {
                    if let Ok(major) = st.GetGUID(&MF_MT_MAJOR_TYPE) {
                        if major == MFMediaType_Video && video_stream_idx.is_none() {
                            video_stream_idx = Some(i);
                        } else if major == MFMediaType_Audio && audio_stream_idx.is_none() {
                            audio_stream_idx = Some(i);
                        }
                    }
                }
            }
            let video_stream_idx =
                video_stream_idx.ok_or_else(|| RecorderError::Other("no video stream".into()))?;

            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(err)?;
            reader
                .SetStreamSelection(video_stream_idx, true)
                .map_err(err)?;

            let video_type = reader
                .GetNativeMediaType(video_stream_idx, 0)
                .map_err(err)?;

            let mut audio_type = if let Some(idx) = audio_stream_idx {
                let _ = reader.SetStreamSelection(idx, true);
                reader.GetNativeMediaType(idx, 0).ok()
            } else {
                None
            };

            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 4).map_err(err)?;
            let attrs = attrs.ok_or_else(|| RecorderError::Other("sink attrs".into()))?;
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .map_err(err)?;
            let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);

            let w = wide(dest);
            let writer =
                MFCreateSinkWriterFromURL(PCWSTR(w.as_ptr()), None, &attrs).map_err(err)?;

            let v_out = writer.AddStream(&video_type).map_err(err)?;
            writer
                .SetInputMediaType(v_out, &video_type, None)
                .map_err(err)?;

            let a_out = match audio_type.as_ref() {
                Some(t) => {
                    let try_add = |mt: &IMFMediaType| -> RResult<u32> {
                        let s = writer.AddStream(mt).map_err(err)?;
                        writer.SetInputMediaType(s, mt, None).map_err(err)?;
                        Ok(s)
                    };
                    match try_add(t) {
                        Ok(s) => Some(s),
                        Err(_) => match clone_aac_media_type(t).and_then(|c| try_add(&c)) {
                            Ok(s) => Some(s),
                            Err(e) => {
                                log::warn!(
                                    "[kage::trim] skipping audio stream due to incompatible input type: {e}"
                                );
                                if let Some(idx) = audio_stream_idx {
                                    let _ = reader.SetStreamSelection(idx, false);
                                }
                                audio_type = None;
                                None
                            }
                        },
                    }
                }
                None => None,
            };
            let _ = audio_type;

            writer.BeginWriting().map_err(err)?;

            let start_hns = (start.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let end_hns = (end.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let var = windows::core::PROPVARIANT::from(start_hns);
            reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &var)
                .map_err(err)?;

            let mut base: Option<i64> = None;
            let mut snapped = start;
            let mut last_end = start_hns;
            let mut video_done = false;
            let mut audio_done = a_out.is_none();

            loop {
                let mut stream_index = 0u32;
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut sample),
                    )
                    .map_err(err)?;

                if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    if stream_index == video_stream_idx {
                        video_done = true;
                    } else if Some(stream_index) == audio_stream_idx {
                        audio_done = true;
                    } else {
                        break;
                    }
                    if video_done && audio_done {
                        break;
                    }
                    continue;
                }
                let Some(sample) = sample else { continue };

                if stream_index == video_stream_idx {
                    if ts > end_hns {
                        video_done = true;
                        if audio_done {
                            break;
                        }
                        continue;
                    }
                    if base.is_none() {
                        let is_clean =
                            sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(1) == 1;
                        if start > 0.05 && !is_clean {
                            continue;
                        }
                        base = Some(ts);
                        snapped = ts as f32 / HNS_PER_SECOND as f32;
                    }
                } else if Some(stream_index) == audio_stream_idx {
                    if ts > end_hns {
                        audio_done = true;
                        if video_done {
                            break;
                        }
                        continue;
                    }
                    if base.is_none() {
                        continue;
                    }
                } else {
                    continue;
                }

                let rebased = (ts - base.unwrap()).max(0);
                sample.SetSampleTime(rebased).map_err(err)?;
                last_end = last_end.max(ts + sample.GetSampleDuration().unwrap_or(0));

                let target = if stream_index == video_stream_idx {
                    Some(v_out)
                } else {
                    a_out
                };
                if let Some(t) = target {
                    writer.WriteSample(t, &sample).map_err(err)?;
                }
            }

            let base_ts = base.ok_or_else(|| {
                RecorderError::Other("no video frames found in the selected range".into())
            })?;
            writer.Finalize().map_err(err)?;
            let duration = (last_end - base_ts).max(0) as f32 / HNS_PER_SECOND as f32;
            Ok((duration, snapped))
        }
    }

    fn trim_precise_imp(
        source: &Path,
        dest: &Path,
        start: f32,
        end: f32,
    ) -> RResult<(f32, f32)> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(source, false, true)
                .or_else(|_| open_reader(source, false, false))?;
            let mut video_stream_idx = None;
            let mut audio_stream_idx = None;
            for i in 0..16 {
                if let Ok(st) = reader.GetNativeMediaType(i, 0) {
                    if let Ok(major) = st.GetGUID(&MF_MT_MAJOR_TYPE) {
                        if major == MFMediaType_Video && video_stream_idx.is_none() {
                            video_stream_idx = Some(i);
                        } else if major == MFMediaType_Audio && audio_stream_idx.is_none() {
                            audio_stream_idx = Some(i);
                        }
                    }
                }
            }
            let video_stream_idx =
                video_stream_idx.ok_or_else(|| RecorderError::Other("no video stream".into()))?;

            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(err)?;
            reader
                .SetStreamSelection(video_stream_idx, true)
                .map_err(err)?;

            let native_video = reader.GetNativeMediaType(video_stream_idx, 0).map_err(err)?;
            let nv12_req = MFCreateMediaType().map_err(err)?;
            nv12_req
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(err)?;
            nv12_req
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
                .map_err(err)?;
            reader
                .SetCurrentMediaType(video_stream_idx, None, &nv12_req)
                .map_err(err)?;
            let nv12_in = reader.GetCurrentMediaType(video_stream_idx).map_err(err)?;

            let size = nv12_in
                .GetUINT64(&MF_MT_FRAME_SIZE)
                .or_else(|_| native_video.GetUINT64(&MF_MT_FRAME_SIZE))
                .map_err(err)?;
            let raw_w = (size >> 32) as u32;
            let raw_h = (size & 0xFFFF_FFFF) as u32;
            let w = (raw_w & !1).max(16);
            let h = (raw_h & !1).max(16);

            let (fps_num, fps_den) = native_video
                .GetUINT64(&MF_MT_FRAME_RATE)
                .ok()
                .map(|r| ((r >> 32) as u32, (r & 0xFFFF_FFFF) as u32))
                .filter(|(n, d)| *n > 0 && *d > 0)
                .unwrap_or((60, 1));
            let frame_hns = (HNS_PER_SECOND * fps_den as i64) / fps_num.max(1) as i64;
            let bitrate = native_video
                .GetUINT32(&MF_MT_AVG_BITRATE)
                .ok()
                .filter(|&b| b >= 1_000_000)
                .unwrap_or(((w as u64 * h as u64 * 6) as u32).clamp(2_000_000, 35_000_000));

            let mut target_sr = 48_000u32;
            let mut target_ch = 2u32;
            let mut pcm_in: Option<IMFMediaType> = None;
            if let Some(a_idx) = audio_stream_idx {
                if reader.SetStreamSelection(a_idx, true).is_ok() {
                    if let Ok(native_audio) = reader.GetNativeMediaType(a_idx, 0) {
                        let native_sr = native_audio
                            .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
                            .unwrap_or(48_000);
                        let native_ch = native_audio
                            .GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)
                            .unwrap_or(2);
                        target_sr = if native_sr == 44_100 { 44_100 } else { 48_000 };
                        target_ch = if native_ch == 1 { 1 } else { 2 };
                    }
                    let setup_pcm = || -> RResult<IMFMediaType> {
                        let req = MFCreateMediaType().map_err(err)?;
                        req.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                            .map_err(err)?;
                        req.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
                            .map_err(err)?;
                        req.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, target_sr)
                            .map_err(err)?;
                        req.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, target_ch)
                            .map_err(err)?;
                        req.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                            .map_err(err)?;
                        reader
                            .SetCurrentMediaType(a_idx, None, &req)
                            .map_err(err)?;
                        reader.GetCurrentMediaType(a_idx).map_err(err)
                    };
                    match setup_pcm() {
                        Ok(mt) => pcm_in = Some(mt),
                        Err(e) => {
                            log::warn!("[kage::trim] precise audio setup skipped: {e}");
                            let _ = reader.SetStreamSelection(a_idx, false);
                        }
                    }
                }
            }

            let open_writer = |hw: bool| -> RResult<(IMFSinkWriter, u32, Option<u32>)> {
                let mut attrs: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attrs, 4).map_err(err)?;
                let attrs = attrs.ok_or_else(|| RecorderError::Other("sink attrs".into()))?;
                attrs
                    .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                    .map_err(err)?;
                let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
                let _ = attrs.SetUINT32(
                    &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                    if hw { 1 } else { 0 },
                );

                let w_dest = wide(dest);
                let writer = MFCreateSinkWriterFromURL(PCWSTR(w_dest.as_ptr()), None, &attrs)
                    .map_err(err)?;

                let v_out_mt = MFCreateMediaType().map_err(err)?;
                v_out_mt
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(err)?;
                v_out_mt
                    .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
                    .map_err(err)?;
                v_out_mt
                    .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                    .map_err(err)?;
                v_out_mt
                    .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                    .map_err(err)?;
                v_out_mt
                    .SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64)
                    .map_err(err)?;
                v_out_mt
                    .SetUINT64(&MF_MT_FRAME_RATE, ((fps_num as u64) << 32) | fps_den as u64)
                    .map_err(err)?;
                v_out_mt
                    .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1u64)
                    .map_err(err)?;
                let _ = v_out_mt.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32);
                let _ = v_out_mt.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps_num.max(1));
                let v_out = writer.AddStream(&v_out_mt).map_err(err)?;
                writer
                    .SetInputMediaType(v_out, &nv12_in, None)
                    .map_err(err)?;

                let a_out = match pcm_in.as_ref() {
                    Some(in_mt) => {
                        let add_aac = || -> RResult<u32> {
                            let aac = MFCreateMediaType().map_err(err)?;
                            aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                                .map_err(err)?;
                            aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
                                .map_err(err)?;
                            aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, target_sr)
                                .map_err(err)?;
                            aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, target_ch)
                                .map_err(err)?;
                            aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                                .map_err(err)?;
                            aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
                                .map_err(err)?;
                            let _ = aac.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0);
                            let _ = aac.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29);
                            let s = writer.AddStream(&aac).map_err(err)?;
                            writer.SetInputMediaType(s, in_mt, None).map_err(err)?;
                            Ok(s)
                        };
                        match add_aac() {
                            Ok(s) => Some(s),
                            Err(e) => {
                                log::warn!("[kage::trim] skipping precise audio stream: {e}");
                                None
                            }
                        }
                    }
                    None => None,
                };

                writer.BeginWriting().map_err(err)?;
                Ok((writer, v_out, a_out))
            };

            let (writer, v_out, a_out) = open_writer(true).or_else(|_| {
                let _ = std::fs::remove_file(dest);
                open_writer(false)
            })?;

            if a_out.is_none() {
                if let Some(a_idx) = audio_stream_idx {
                    let _ = reader.SetStreamSelection(a_idx, false);
                }
            }

            let start_hns = (start.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let end_hns = (end.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let seek_pos = (start_hns - HNS_PER_SECOND / 2).max(0);
            let var = windows::core::PROPVARIANT::from(seek_pos);
            reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &var)
                .map_err(err)?;

            let mut base: Option<i64> = None;
            let mut snapped = start;
            let mut last_end = start_hns;
            let mut wrote_video = 0usize;
            let mut video_done = false;
            let mut audio_done = a_out.is_none();
            let mut pending_audio: std::collections::VecDeque<(IMFSample, i64, i64)> =
                std::collections::VecDeque::with_capacity(64);

            loop {
                let mut stream_index = 0u32;
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut sample),
                    )
                    .map_err(err)?;

                if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32) != 0 {
                    if stream_index == video_stream_idx {
                        if let Ok(updated) = reader.GetCurrentMediaType(video_stream_idx) {
                            let _ = writer.SetInputMediaType(v_out, &updated, None);
                        }
                    } else if Some(stream_index) == audio_stream_idx {
                        if let Some(ao) = a_out {
                            if let Ok(updated) = reader.GetCurrentMediaType(stream_index) {
                                let _ = writer.SetInputMediaType(ao, &updated, None);
                            }
                        }
                    }
                }

                if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    if stream_index == video_stream_idx {
                        video_done = true;
                    } else if Some(stream_index) == audio_stream_idx {
                        audio_done = true;
                    } else {
                        break;
                    }
                    if video_done && audio_done {
                        break;
                    }
                    continue;
                }
                let Some(sample) = sample else { continue };

                if stream_index == video_stream_idx {
                    if ts >= end_hns {
                        video_done = true;
                        if audio_done {
                            break;
                        }
                        continue;
                    }
                    let dur = sample.GetSampleDuration().unwrap_or(frame_hns).max(1);
                    if ts + dur <= start_hns {
                        continue;
                    }
                    let base_ts = match base {
                        Some(b) => b,
                        None => {
                            base = Some(ts);
                            snapped = ts as f32 / HNS_PER_SECOND as f32;
                            if let Some(ao) = a_out {
                                while let Some((asample, ats, adur)) = pending_audio.pop_front() {
                                    if ats + adur > ts && ats < end_hns {
                                        let rebased = (ats - ts).max(0);
                                        let _ = asample.SetSampleTime(rebased);
                                        writer.WriteSample(ao, &asample).map_err(err)?;
                                    }
                                }
                            } else {
                                pending_audio.clear();
                            }
                            ts
                        }
                    };
                    let clipped_dur = if ts + dur > end_hns {
                        (end_hns - ts).max(1)
                    } else {
                        dur
                    };
                    let _ = sample.SetSampleDuration(clipped_dur);
                    sample
                        .SetSampleTime((ts - base_ts).max(0))
                        .map_err(err)?;
                    last_end = last_end.max(ts + clipped_dur);
                    writer.WriteSample(v_out, &sample).map_err(err)?;
                    wrote_video += 1;
                } else if Some(stream_index) == audio_stream_idx {
                    if let Some(ao) = a_out {
                        if ts >= end_hns {
                            audio_done = true;
                            if video_done {
                                break;
                            }
                            continue;
                        }
                        let dur = sample.GetSampleDuration().unwrap_or(0);
                        if ts + dur <= start_hns {
                            continue;
                        }
                        if let Some(base_ts) = base {
                            sample
                                .SetSampleTime((ts - base_ts).max(0))
                                .map_err(err)?;
                            writer.WriteSample(ao, &sample).map_err(err)?;
                        } else {
                            if pending_audio.len() >= 64 {
                                pending_audio.pop_front();
                            }
                            pending_audio.push_back((sample, ts, dur));
                        }
                    }
                }
            }

            let base_ts = base.filter(|_| wrote_video > 0).ok_or_else(|| {
                RecorderError::Other("no video frames found in the selected range".into())
            })?;
            writer.Finalize().map_err(err)?;
            let duration = (last_end - base_ts).max(0) as f32 / HNS_PER_SECOND as f32;
            Ok((duration, snapped))
        }
    }

    pub(super) fn trim(
        source: &Path,
        dest: &Path,
        start: f32,
        end: f32,
    ) -> RResult<(f32, f32)> {
        if start <= 0.05 {
            match trim_stream_copy_imp(source, dest, start, end) {
                Ok(v) => Ok(v),
                Err(copy_err) => {
                    log::warn!(
                        "[kage::trim] stream-copy failed ({copy_err}); retrying frame-accurate transcode"
                    );
                    let _ = std::fs::remove_file(dest);
                    trim_precise_imp(source, dest, start, end)
                }
            }
        } else {
            match trim_precise_imp(source, dest, start, end) {
                Ok(v) => Ok(v),
                Err(prec_err) => {
                    log::warn!(
                        "[kage::trim] precise trim failed ({prec_err}); falling back to keyframe stream copy"
                    );
                    let _ = std::fs::remove_file(dest);
                    trim_stream_copy_imp(source, dest, start, end)
                }
            }
        }
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn probe(path: &Path) -> RResult<ProbeResult> {
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Ok(ProbeResult {
            duration_seconds: (len as f32 * 8.0 / 12_000_000.0).max(0.5),
            width: 1920,
            height: 1080,
            fps: 60,
            has_audio: true,
        })
    }

    pub(super) fn extract_frame_png(
        _path: &Path,
        _at: f32,
        _max_width: u32,
    ) -> RResult<String> {
        Err(RecorderError::Other("frame extraction requires Windows".into()))
    }

    pub(super) fn extract_frame_jpeg_bytes(
        _path: &Path,
        _at: f32,
        _max_width: u32,
    ) -> RResult<Vec<u8>> {
        Err(RecorderError::Other("frame extraction requires Windows".into()))
    }

    pub(super) fn trim(source: &Path, dest: &Path, start: f32, end: f32) -> RResult<(f32, f32)> {
        let bytes = std::fs::read(source)?;
        let probe = probe(source)?;
        let total = probe.duration_seconds.max(0.001);
        let a = ((start / total).clamp(0.0, 1.0) * bytes.len() as f32) as usize;
        let b = ((end / total).clamp(0.0, 1.0) * bytes.len() as f32) as usize;
        std::fs::write(
            dest,
            &bytes[a.min(bytes.len())..b.min(bytes.len()).max(a.min(bytes.len()))],
        )?;
        Ok(((end - start).max(0.0), start))
    }
}

pub fn probe(path: &Path) -> RResult<ProbeResult> {
    imp::probe(path)
}

/// Disk-cached JPEG thumbnail (~<=360 px) for the gallery cards.
pub fn extract_thumbnail(path: &Path, at_seconds: f32) -> RResult<String> {
    extract_thumbnail_in(path, at_seconds, &thumb_cache_dir())
}

fn extract_thumbnail_in(path: &Path, at_seconds: f32, cache_dir: &Path) -> RResult<String> {
    use base64::Engine;
    let default_seek = (at_seconds - 1.0).abs() < 0.05;
    if default_seek {
        if let Ok(meta) = std::fs::metadata(path) {
            let mod_ms = modified_ms(&meta);
            if mod_ms != 0 {
                let cached = thumb_cache_file(cache_dir, path, meta.len(), mod_ms);
                if let Ok(bytes) = std::fs::read(&cached) {
                    return Ok(format!(
                        "data:image/jpeg;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    ));
                }
                let jpg = imp::extract_frame_jpeg_bytes(path, at_seconds, 360)?;
                let _ = std::fs::create_dir_all(cache_dir);
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let tmp = cached.with_extension(format!("jpg.{}.{stamp}.tmp", std::process::id()));
                if std::fs::write(&tmp, &jpg).is_ok() {
                    let _ = std::fs::rename(&tmp, &cached);
                }
                return Ok(format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&jpg)
                ));
            }
        }
    }
    let jpg = imp::extract_frame_jpeg_bytes(path, at_seconds, 360)?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&jpg)
    ))
}

pub fn extract_frame_png(path: &Path, at_seconds: f32, max_width: u32) -> RResult<String> {
    imp::extract_frame_png(path, at_seconds, max_width)
}

pub fn trim_stream_copy(
    source: &Path,
    dest: &Path,
    start: f32,
    end: f32,
) -> RResult<TrimResult> {
    if !start.is_finite() || !end.is_finite() || end <= start {
        return Err(RecorderError::Other(
            "trim end must be greater than trim start".into(),
        ));
    }
    if !source.exists() {
        return Err(RecorderError::Io(format!(
            "source clip not found: {}",
            source.display()
        )));
    }
    let t0 = std::time::Instant::now();
    let (duration, snapped) = match imp::trim(source, dest, start, end) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(dest);
            return Err(e);
        }
    };
    let size_bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResult {
        path: dest.to_string_lossy().to_string(),
        file_name: dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        duration_seconds: duration,
        size_bytes,
        elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
        snapped_start_seconds: snapped,
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        scan_directory_impl, suggested_trim_path, thumb_cache_file, ProbeCache,
    };

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kage-lib-test-{}-{tag}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn suggests_basename_trim_mp4_when_free() {
        let dir = temp_dir("free");
        let src = dir.join("clutch.mp4");
        std::fs::write(&src, b"x").unwrap();
        let got = suggested_trim_path(&src);
        assert_eq!(got, dir.join("clutch_trim.mp4"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn never_reuses_an_existing_trim_file() {
        let dir = temp_dir("collision");
        let src = dir.join("clutch.mp4");
        std::fs::write(&src, b"x").unwrap();

        std::fs::write(dir.join("clutch_trim.mp4"), b"x").unwrap();
        assert_eq!(suggested_trim_path(&src), dir.join("clutch_trim2.mp4"));

        std::fs::write(dir.join("clutch_trim2.mp4"), b"x").unwrap();
        assert_eq!(suggested_trim_path(&src), dir.join("clutch_trim3.mp4"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_halves_get_distinct_names() {
        let dir = temp_dir("split");
        let src = dir.join("match.mp4");
        std::fs::write(&src, b"x").unwrap();

        let part_a = suggested_trim_path(&src);
        std::fs::write(&part_a, b"x").unwrap();
        let part_b = suggested_trim_path(&src);
        assert_ne!(part_a, part_b);
        assert_eq!(part_a, dir.join("match_trim.mp4"));
        assert_eq!(part_b, dir.join("match_trim2.mp4"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn handles_sources_without_parent_or_stem() {
        let got = suggested_trim_path(Path::new("bare.mp4"));
        assert_eq!(got, PathBuf::from("bare_trim.mp4"));
    }

    fn write_fake_clip(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, vec![0u8; bytes]).unwrap();
        p
    }

    fn cache_path(dir: &Path) -> PathBuf {
        dir.join("probe_cache.json")
    }

    fn key_of(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn cache_miss_writes_and_persists_entries() {
        let dir = temp_dir("miss");
        write_fake_clip(&dir, "a.mp4", 1000);
        write_fake_clip(&dir, "b.mp4", 2000);

        let clips = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();
        assert_eq!(clips.len(), 2);

        let cache = ProbeCache::load_from(&cache_path(&dir));
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.entries.contains_key(&key_of(&dir.join("a.mp4"))));
        assert!(cache.entries.contains_key(&key_of(&dir.join("b.mp4"))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unchanged_scan_hits_cache_without_rewriting_it() {
        let dir = temp_dir("hit");
        write_fake_clip(&dir, "a.mp4", 1000);
        let _ = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();

        let before = std::fs::metadata(cache_path(&dir))
            .unwrap()
            .modified()
            .unwrap();
        let clips = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();
        let after = std::fs::metadata(cache_path(&dir))
            .unwrap()
            .modified()
            .unwrap();

        assert_eq!(clips.len(), 1);
        assert_eq!(before, after);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn changed_file_reprobes_and_updates_its_entry() {
        let dir = temp_dir("reprobe");
        let p = write_fake_clip(&dir, "a.mp4", 1000);
        let _ = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();

        std::fs::write(&p, vec![0u8; 5000]).unwrap();
        let clips = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].size_bytes, 5000);

        let cache = ProbeCache::load_from(&cache_path(&dir));
        assert_eq!(cache.entries[&key_of(&p)].size_bytes, 5000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deleted_clips_are_pruned_from_the_cache() {
        let dir = temp_dir("prune");
        write_fake_clip(&dir, "keep.mp4", 1000);
        let gone = write_fake_clip(&dir, "gone.mp4", 2000);
        let _ = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();
        assert!(ProbeCache::load_from(&cache_path(&dir))
            .entries
            .contains_key(&key_of(&gone)));

        std::fs::remove_file(&gone).unwrap();
        let clips = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();
        assert_eq!(clips.len(), 1);
        assert!(!ProbeCache::load_from(&cache_path(&dir))
            .entries
            .contains_key(&key_of(&gone)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let dir = temp_dir("atomic");
        write_fake_clip(&dir, "a.mp4", 1000);
        let _ = scan_directory_impl(&dir, false, &cache_path(&dir)).unwrap();

        let cp = cache_path(&dir);
        assert!(cp.exists());
        assert!(!cp.with_extension("json.tmp").exists());
        let cache = ProbeCache::load_from(&cp);
        assert_eq!(cache.entries.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn thumb_cache_key_changes_when_size_or_mtime_changes() {
        let dir = temp_dir("thumbkey");
        let clip = dir.join("clip.mp4");
        let a = thumb_cache_file(&dir, &clip, 1000, 100);
        let b = thumb_cache_file(&dir, &clip, 2000, 100);
        let c = thumb_cache_file(&dir, &clip, 1000, 200);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.to_string_lossy().ends_with(".jpg"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(all(windows, not(feature = "headless-sim")))]
    #[test]
    fn real_clip_probe_snapshot_trim_and_split_succeed() {
        let clip = Path::new(r"D:\ClipFlow\chrome\KAGE_Replay_2026-11-25_15-47-25.mp4");
        if !clip.exists() {
            return;
        }
        let info = super::probe(clip).expect("probe real clip");
        assert!(info.duration_seconds > 1.0);
        assert!(info.width > 0 && info.height > 0);

        let png_mid = super::extract_frame_png(clip, 1.0, 0).expect("extract_frame_png mid");
        assert!(png_mid.starts_with("data:image/png;base64,"));
        let png_end =
            super::extract_frame_png(clip, info.duration_seconds, 0).expect("extract_frame_png end");
        assert!(png_end.starts_with("data:image/png;base64,"));

        let thumb = super::extract_thumbnail(clip, 1.0).expect("extract_thumbnail");
        assert!(thumb.starts_with("data:image/jpeg;base64,"));

        let out_dir = temp_dir("real-mp4-ops");
        let trimmed = out_dir.join("trimmed.mp4");
        let res_trim = super::trim_stream_copy(clip, &trimmed, 1.0, 5.0).expect("trim real clip");
        assert!(res_trim.size_bytes > 0);
        assert!(super::probe(&trimmed).expect("probe trimmed").duration_seconds > 0.5);

        let mid = info.duration_seconds * 0.5;
        let part_a = out_dir.join("part_a.mp4");
        let part_b = out_dir.join("part_b.mp4");
        let ra = super::trim_stream_copy(clip, &part_a, 0.0, mid).expect("split part A");
        let rb = super::trim_stream_copy(clip, &part_b, mid, info.duration_seconds)
            .expect("split part B");
        assert!(ra.size_bytes > 0 && rb.size_bytes > 0);
        assert!(super::probe(&part_a).expect("probe part A").duration_seconds > 0.5);
        assert!(super::probe(&part_b).expect("probe part B").duration_seconds > 0.5);

        std::fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn suggested_trim_path_in_dir_targets_library_folder() {
        let lib = temp_dir("lib-target");
        let ext_dir = temp_dir("ext-src");
        let ext = ext_dir.join("gameplay.mov");
        std::fs::write(&ext, b"x").unwrap();

        let p1 = super::suggested_trim_path_in_dir(&lib, &ext);
        assert_eq!(p1, lib.join("gameplay_trim.mp4"));
        std::fs::write(&p1, b"y").unwrap();
        let p2 = super::suggested_trim_path_in_dir(&lib, &ext);
        assert_eq!(p2, lib.join("gameplay_trim2.mp4"));

        std::fs::remove_dir_all(&lib).ok();
        std::fs::remove_dir_all(&ext_dir).ok();
    }

    #[cfg(all(windows, not(feature = "headless-sim")))]
    #[test]
    fn real_clip_precise_trim_respects_exact_start_and_end() {
        let candidate_dirs = [
            Path::new(r"D:\ClipFlow\valorant-win64-shipping"),
            Path::new(r"D:\ClipFlow\chrome"),
        ];
        let clip = candidate_dirs
            .iter()
            .filter_map(|d| std::fs::read_dir(d).ok())
            .flatten()
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
                    && p.metadata().map(|m| m.len() > 2_000_000).unwrap_or(false)
            });
        let Some(clip) = clip else {
            return;
        };
        let info = super::probe(&clip).expect("probe clip");
        if info.duration_seconds < 7.0 {
            return;
        }
        let out_dir = temp_dir("precise-trim");
        let dest = out_dir.join("precise_out.mp4");
        let res = super::trim_stream_copy(&clip, &dest, 2.35, 5.85).expect("precise trim");
        assert!(res.size_bytes > 0);
        assert!(
            (res.snapped_start_seconds - 2.35).abs() <= 0.15,
            "expected start near 2.35s, got {}",
            res.snapped_start_seconds
        );
        let probed = super::probe(&dest).expect("probe precise output");
        assert!(
            (probed.duration_seconds - 3.5).abs() <= 0.35,
            "expected trimmed duration near 3.5s, got {}",
            probed.duration_seconds
        );
        std::fs::remove_dir_all(&out_dir).ok();
    }
}
