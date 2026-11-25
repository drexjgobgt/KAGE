/**
 * Typed IPC bridge for KAGE Studio.
 * In Tauri, calls native Rust commands via `window.__TAURI__`.
 * Outside Tauri (browser preview), lazily imports `simEngine`.
 */

import type {
  AppSettings,
  AudioDevice,
  CaptureProfile,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  ForegroundGame,
  MonitorInfo,
  PowerState,
  ProfileMapEntry,
  SplitResult,
  TrimResult,
} from "./types";

type TauriGlobal = {
  core: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
  event: {
    listen: <T>(
      event: string,
      handler: (e: { payload: T }) => void,
    ) => Promise<() => void>;
  };
  window?: {
    getCurrentWindow: () => {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      hide: () => Promise<void>;
      startDragging: () => Promise<void>;
    };
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  (typeof window.__TAURI__ !== "undefined" ||
    typeof window.__TAURI_INTERNALS__ !== "undefined");

function tauri(): TauriGlobal {
  const t = window.__TAURI__;
  if (!t) throw new Error("Tauri API unavailable");
  return t;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(cmd, args);
}

let simPromise: Promise<typeof import("./simEngine")> | null = null;
async function getSim() {
  if (!simPromise) simPromise = import("./simEngine");
  const mod = await simPromise;
  return mod.simEngine;
}

export function assetUrl(path: string): string {
  if (!path) return "";
  if (isTauri()) {
    const convert = window.__TAURI__?.core.convertFileSrc;
    if (convert) return convert(path);
    return `http://asset.localhost/${encodeURIComponent(path)}`;
  }
  return "";
}

type Handler<T> = (payload: T) => void;
const localBus = new Map<string, Set<Handler<unknown>>>();

function emitLocal<T>(channel: string, payload: T) {
  localBus.get(channel)?.forEach((h) => h(payload as unknown));
}

function onLocal<T>(channel: string, handler: Handler<T>): () => void {
  const set = localBus.get(channel) ?? new Set();
  set.add(handler as Handler<unknown>);
  localBus.set(channel, set);
  return () => set.delete(handler as Handler<unknown>);
}

async function listen<T>(channel: string, handler: Handler<T>): Promise<() => void> {
  if (isTauri()) {
    return tauri().event.listen<T>(channel, (e) => handler(e.payload));
  }
  return onLocal(channel, handler);
}

export const CHANNELS = {
  clipSaved: "kage://clip-saved",
  stats: "kage://stats",
  error: "kage://error",
  hotkey: "kage://hotkey",
  bufferState: "kage://buffer-state",
  recordingState: "kage://recording-state",
  deckHidden: "kage://deck-hidden",
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  bufferSeconds: 60,
  targetFps: 60,
  bitrateKbps: 12_000,
  codec: "h264",
  monitorIndex: 0,
  captureSystemAudio: true,
  captureMicrophone: false,
  outputDir: "C:\\Users\\You\\Videos\\KAGE",
  hotkeySave: "Alt+C",
  hotkeyToggle: "Alt+Shift+C",
  hotkeyRecord: "Alt+R",
  openTrimmerAfterSave: true,
  minimizeToTray: true,
  autostartBuffer: true,
  playSaveSound: true,
  alwaysOnTop: false,
  profiles: [
    {
      id: "default",
      name: "Default",
      bufferSeconds: 60,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "competitivo",
      name: "Competitive",
      bufferSeconds: 30,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "cine",
      name: "Cinema",
      bufferSeconds: 120,
      targetFps: 60,
      bitrateKbps: 25_000,
      codec: "hevc",
    },
  ],
  profileMap: [],
  autoSwitchProfiles: false,
  launchAtStartup: false,
  autoCleanupDays: 0,
  organizeByGame: true,
  autosaveOnGameExit: false,
  performanceMode: true,
  privacyPauseWhenUnfocused: false,
  gameVolume: 100,
  micVolume: 100,
  micDeviceId: null,
  adaptiveEco: false,
  ecoBatteryThresholdPct: 30,
  ecoRamFreeGbs: 4,
};

let browserSettings: AppSettings = { ...DEFAULT_SETTINGS };

export const kage = {
  isTauri,

  async startBuffer(bufferSeconds: number, targetFps: number): Promise<EngineStats> {
    if (isTauri()) {
      return invoke<EngineStats>("start_replay_buffer", { bufferSeconds, targetFps });
    }
    const sim = await getSim();
    const stats = await sim.start(bufferSeconds, targetFps, true);
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async stopBuffer(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("stop_replay_buffer");
    const sim = await getSim();
    const stats = sim.stop();
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async startRecording(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("start_recording");
    const sim = await getSim();
    const stats = await sim.startRecording();
    emitLocal(CHANNELS.recordingState, stats);
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async stopRecording(): Promise<ClipMetadata> {
    if (isTauri()) return invoke<ClipMetadata>("stop_recording");
    const sim = await getSim();
    const { clip, flushMs } = await sim.stopRecording();
    const stats = sim.stats();
    emitLocal(CHANNELS.recordingState, stats);
    emitLocal(CHANNELS.bufferState, stats);
    emitLocal<ClipSavedPayload>(CHANNELS.clipSaved, {
      clip,
      flushMs,
      triggeredBy: "record-ui",
      openTrimmer: false,
    });
    return clip;
  },

  async toggleRecording(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("toggle_recording");
    const sim = await getSim();
    if (sim.stats().recording_active) {
      await kage.stopRecording();
      return sim.stats();
    }
    return kage.startRecording();
  },

  async getStats(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("get_engine_stats");
    const sim = await getSim();
    return sim.stats();
  },

  async getDiskFreeBytes(): Promise<number | null> {
    if (isTauri()) return invoke<number | null>("get_disk_free_bytes");
    return 184 * 1024 * 1024 * 1024;
  },

  async setBufferSeconds(seconds: number): Promise<void> {
    if (isTauri()) {
      await invoke("set_buffer_seconds", { seconds });
      return;
    }
    const sim = await getSim();
    sim.setBufferSeconds(seconds);
    browserSettings = { ...browserSettings, bufferSeconds: seconds };
  },

  async saveInstantReplay(
    maxSeconds?: number,
    triggeredBy: string = "ui",
    gameOverride?: string,
  ): Promise<ClipMetadata> {
    if (isTauri()) {
      return invoke<ClipMetadata>("save_instant_replay", {
        maxSeconds,
        triggeredBy,
        gameOverride,
      });
    }
    const sim = await getSim();
    const { clip, flushMs } = await sim.save(maxSeconds, gameOverride);
    emitLocal<ClipSavedPayload>(CHANNELS.clipSaved, { clip, flushMs, triggeredBy });
    return clip;
  },

  async getClips(withThumbnails = true): Promise<ClipMetadata[]> {
    if (isTauri()) return invoke<ClipMetadata[]>("get_recorded_clips", { withThumbnails });
    const sim = await getSim();
    return sim.list();
  },

  async getClipThumbnail(path: string, atSeconds = 1): Promise<string | null> {
    if (isTauri()) {
      return invoke<string>("get_clip_thumbnail", { path, atSeconds }).catch(() => null);
    }
    const sim = await getSim();
    return sim.find(path)?.thumbnail ?? null;
  },

  async splitClip(sourcePath: string, atSeconds: number): Promise<SplitResult> {
    if (isTauri()) {
      return invoke<SplitResult>("split_clip", { sourcePath, atSeconds });
    }
    const sim = await getSim();
    const a = sim.trim(sourcePath, 0, atSeconds, "_partA");
    const b = sim.trim(
      sourcePath,
      atSeconds,
      sim.find(sourcePath)?.duration_seconds ?? atSeconds + 1,
      "_partB",
    );
    return {
      partA: {
        path: a.path,
        file_name: a.file_name,
        duration_seconds: a.duration_seconds,
        size_bytes: a.size_bytes,
        elapsed_ms: 0,
        snapped_start_seconds: 0,
      },
      partB: {
        path: b.path,
        file_name: b.file_name,
        duration_seconds: b.duration_seconds,
        size_bytes: b.size_bytes,
        elapsed_ms: 0,
        snapped_start_seconds: atSeconds,
      },
    };
  },

  async trimClip(
    sourcePath: string,
    startTime: number,
    endTime: number,
    overwrite = false,
  ): Promise<TrimResult> {
    if (isTauri()) {
      return invoke<TrimResult>("trim_clip", {
        sourcePath,
        startTime,
        endTime,
        overwrite,
      });
    }
    const sim = await getSim();
    const t0 = performance.now();
    const clip = sim.trim(sourcePath, startTime, endTime, "_trim", overwrite);
    return {
      path: clip.path,
      file_name: clip.file_name,
      duration_seconds: clip.duration_seconds,
      size_bytes: clip.size_bytes,
      elapsed_ms: performance.now() - t0,
      snapped_start_seconds: startTime,
    };
  },

  async deleteClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("delete_clip", { path });
      return;
    }
    const sim = await getSim();
    sim.delete(path);
  },

  async deleteClips(paths: string[]): Promise<number> {
    if (isTauri()) return invoke<number>("delete_clips", { paths });
    const sim = await getSim();
    let n = 0;
    for (const p of paths) {
      sim.delete(p);
      n += 1;
    }
    return n;
  },

  async copyClips(paths: string[]): Promise<void> {
    if (isTauri()) {
      await invoke("copy_clips_to_clipboard", { paths });
      return;
    }
    await navigator.clipboard?.writeText(paths.join("\n"));
  },

  async setClipsFavorite(paths: string[], favorite: boolean): Promise<number> {
    if (isTauri()) return invoke<number>("set_clips_favorite", { paths, favorite });
    const sim = await getSim();
    let n = 0;
    for (const p of paths) {
      sim.setFavorite(p, favorite);
      n += 1;
    }
    return n;
  },

  async addClipsTag(paths: string[], tag: string): Promise<number> {
    if (isTauri()) return invoke<number>("add_clips_tag", { paths, tag });
    const sim = await getSim();
    let n = 0;
    for (const p of paths) {
      const clip = sim.find(p);
      if (!clip || clip.tags.includes(tag)) continue;
      sim.setTags(p, [...clip.tags, tag]);
      n += 1;
    }
    return n;
  },

  async removeClipsTag(paths: string[], tag: string): Promise<number> {
    if (isTauri()) return invoke<number>("remove_clips_tag", { paths, tag });
    const sim = await getSim();
    let n = 0;
    for (const p of paths) {
      const clip = sim.find(p);
      if (!clip || !clip.tags.includes(tag)) continue;
      sim.setTags(
        p,
        clip.tags.filter((t) => t !== tag),
      );
      n += 1;
    }
    return n;
  },

  async deleteAllClips(): Promise<number> {
    if (isTauri()) return invoke<number>("delete_all_clips");
    const sim = await getSim();
    return sim.clearAll();
  },

  async renameClip(path: string, newName: string): Promise<string> {
    if (isTauri()) return invoke<string>("rename_clip", { path, newName });
    const sim = await getSim();
    return sim.rename(path, newName);
  },

  async extractFramePng(
    path: string,
    atSeconds: number,
    maxWidth = 0,
  ): Promise<string> {
    if (isTauri()) {
      return invoke<string>("extract_png_frame", {
        path,
        atSeconds,
        maxWidth,
      });
    }
    const sim = await getSim();
    const clip = sim.find(path);
    const src = clip?.preview_url;
    if (!src) throw new Error("no preview stream available for this clip");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("could not load clip preview"));
      video.load();
    });
    video.currentTime = Math.min(Math.max(atSeconds, 0), video.duration || 0);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      window.setTimeout(resolve, 800);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  },

  async snapshotToOutput(pngBase64: string, baseName: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>("save_png_snapshot", { pngBase64, baseName });
    }
    const a = document.createElement("a");
    a.href = pngBase64;
    a.download = `${baseName.replace(/\.png$/i, "") || "snapshot"}.png`;
    a.click();
    return `downloaded ${a.download}`;
  },

  async copyClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("copy_clip_to_clipboard", { path });
      return;
    }
    await navigator.clipboard?.writeText(path);
  },

  async revealClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("reveal_clip_in_folder", { path });
      return;
    }
    await navigator.clipboard?.writeText(path);
  },

  async openOutputFolder(): Promise<void> {
    if (isTauri()) {
      await invoke("open_output_folder");
      return;
    }
    await navigator.clipboard?.writeText(browserSettings.outputDir);
  },

  async openClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_clip_external", { path });
    }
  },

  async getSettings(): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("get_settings");
    return browserSettings;
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("update_settings", { patch });
    browserSettings = { ...browserSettings, ...patch };
    const sim = await getSim();
    if (patch.bufferSeconds !== undefined) sim.setBufferSeconds(patch.bufferSeconds);
    if (patch.targetFps !== undefined) sim.targetFps = patch.targetFps;
    if (patch.bitrateKbps !== undefined) sim.bitrateKbps = patch.bitrateKbps;
    if (patch.codec !== undefined) sim.codec = patch.codec;
    if (patch.organizeByGame !== undefined) sim.organizeByGame = patch.organizeByGame;
    if (patch.privacyPauseWhenUnfocused === false) sim.setPrivacyGate(false);
    return browserSettings;
  },

  async getForegroundGame(): Promise<ForegroundGame | null> {
    if (isTauri()) return invoke<ForegroundGame | null>("get_foreground_game");
    const sim = await getSim();
    return sim.foregroundGame();
  },

  async getProfiles(): Promise<CaptureProfile[]> {
    if (isTauri()) return invoke<CaptureProfile[]>("get_profiles");
    return browserSettings.profiles;
  },

  async saveProfile(profile: CaptureProfile): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("save_profile", { profile });
    const sim = await getSim();
    sim.saveProfile(profile);
    browserSettings = { ...browserSettings, profiles: sim.getProfiles() };
    return browserSettings;
  },

  async deleteProfile(profileId: string): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("delete_profile", { profileId });
    const sim = await getSim();
    sim.deleteProfile(profileId);
    browserSettings = { ...browserSettings, profiles: sim.getProfiles() };
    return browserSettings;
  },

  async setProfileMap(map: ProfileMapEntry[]): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("set_profile_map", { map });
    const sim = await getSim();
    sim.setProfileMap(map);
    browserSettings = { ...browserSettings, profileMap: sim.getProfileMap() };
    return browserSettings;
  },

  async applyProfile(profileId: string): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("apply_profile", { profileId });
    const sim = await getSim();
    sim.applyProfile(profileId);
    const profile = sim.getProfiles().find((p) => p.id === profileId);
    browserSettings = {
      ...browserSettings,
      bufferSeconds: sim.bufferSeconds,
      targetFps: sim.targetFps,
      bitrateKbps: sim.bitrateKbps,
      codec: profile?.codec ?? browserSettings.codec,
    };
    return browserSettings;
  },

  async cleanupOldClips(days: number): Promise<number> {
    if (isTauri()) return invoke<number>("cleanup_old_clips", { days });
    const sim = await getSim();
    return sim.cleanupOldClips(days);
  },

  async setPrivacyGate(gate: boolean): Promise<void> {
    if (isTauri()) {
      await invoke("set_privacy_gate", { gate });
      return;
    }
    const sim = await getSim();
    sim.setPrivacyGate(gate);
  },

  async setClipFavorite(path: string, favorite: boolean): Promise<void> {
    if (isTauri()) {
      await invoke("set_clip_favorite", { path, favorite });
      return;
    }
    const sim = await getSim();
    sim.setFavorite(path, favorite);
  },

  async getPowerState(): Promise<PowerState> {
    if (isTauri()) return invoke<PowerState>("get_power_state");
    return {
      onBattery: false,
      batteryPercent: 100,
      availableRamBytes: 8 * 1024 * 1024 * 1024,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
    };
  },

  async setClipTags(path: string, tags: string[]): Promise<void> {
    if (isTauri()) {
      await invoke("set_clip_tags", { path, tags });
      return;
    }
    const sim = await getSim();
    sim.setTags(path, tags);
  },

  async notify(title: string, body?: string): Promise<void> {
    if (!isTauri()) return;
    try {
      const mod = await import("@tauri-apps/plugin-notification");
      let granted = await mod.isPermissionGranted();
      if (!granted) {
        granted = (await mod.requestPermission()) === "granted";
      }
      if (granted) {
        mod.sendNotification({ title, body });
      }
    } catch {
      /* ignore */
    }
  },

  async getMonitors(): Promise<MonitorInfo[]> {
    if (isTauri()) return invoke<MonitorInfo[]>("get_monitors");
    return [
      {
        index: 0,
        name: "\\\\.\\DISPLAY1",
        width: 2560,
        height: 1440,
        refresh_hz: 165,
        primary: true,
        adapter: "Simulated RTX Adapter",
      },
      {
        index: 1,
        name: "\\\\.\\DISPLAY2",
        width: 1920,
        height: 1080,
        refresh_hz: 60,
        primary: false,
        adapter: "Simulated RTX Adapter",
      },
    ];
  },

  async getAudioInputDevices(): Promise<AudioDevice[]> {
    if (isTauri()) return invoke<AudioDevice[]>("get_audio_input_devices");
    return [
      { id: "default", name: "Default (System Default)", isDefault: true },
      { id: "mock_realtek", name: "Microphone (Realtek Audio)", isDefault: false },
    ];
  },

  async minimize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().minimize();
  },

  async toggleMaximize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().toggleMaximize();
  },

  async hideToTray(): Promise<void> {
    if (isTauri()) {
      await invoke("hide_main_window");
    }
  },

  async startDragging(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().startDragging();
  },

  async quit(): Promise<void> {
    if (isTauri()) await invoke("quit_app");
  },

  async simulateDeviceLoss(): Promise<void> {
    if (isTauri()) {
      await invoke("simulate_device_loss");
      return;
    }
    const sim = await getSim();
    sim.simulateDeviceLoss();
  },

  async onStats(handler: Handler<EngineStats>): Promise<() => void> {
    if (isTauri()) return listen<EngineStats>(CHANNELS.stats, handler);
    const sim = await getSim();
    return sim.onStats(handler);
  },
  onClipSaved(handler: Handler<ClipSavedPayload>) {
    return listen<ClipSavedPayload>(CHANNELS.clipSaved, handler);
  },
  onError(handler: Handler<string>) {
    return listen<string>(CHANNELS.error, handler);
  },
  onHotkey(handler: Handler<string>) {
    return listen<string>(CHANNELS.hotkey, handler);
  },
  onBufferState(handler: Handler<EngineStats>) {
    return listen<EngineStats>(CHANNELS.bufferState, handler);
  },
  onRecordingState(handler: Handler<EngineStats>) {
    return listen<EngineStats>(CHANNELS.recordingState, handler);
  },
  onDeckHidden(handler: Handler<void>) {
    return listen<void>(CHANNELS.deckHidden, handler);
  },
  emitLocalHotkey(accelerator: string) {
    emitLocal(CHANNELS.hotkey, accelerator);
  },
  emitLocalError(message: string) {
    emitLocal(CHANNELS.error, message);
  },
};

export type KageApi = typeof kage;
