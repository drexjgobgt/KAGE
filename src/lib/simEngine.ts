/**
 * Browser-side simulation of the Rust capture engine.
 * Loaded lazily ONLY when running outside Tauri (e.g. `npm run dev` in a
 * browser for UI preview and click-through verification).
 */

import type {
  CaptureProfile,
  ClipMetadata,
  EngineStats,
  EngineStateName,
  ForegroundGame,
  ProfileMapEntry,
} from "./types";

type Listener<T> = (payload: T) => void;

const FPS = 60;

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

interface Leg {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

export class SimEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private legs: Leg[] = [];
  private mime = "";
  private running = false;
  private ringEnabled = true;
  private startedAt = 0;
  private frameCount = 0;
  private lastFpsSample = 0;
  private measuredFps = 0;
  private tickHandle: number | null = null;
  private statsListeners = new Set<Listener<EngineStats>>();
  private clips: ClipMetadata[] = [];
  private state: EngineStateName = "idle";
  private lastError: string | null = null;
  private deviceResets = 0;
  private droppedFrames = 0;
  privacyGated = false;

  private recordingActive = false;
  private recordingStartedAt = 0;
  private recordingChunks: Blob[] = [];
  private recordingRecorder: MediaRecorder | null = null;
  private recordingBytes = 0;
  private recordingPath: string | null = null;
  private startedForDirectOnly = false;

  bufferSeconds = 60;
  targetFps = FPS;
  bitrateKbps = 12_000;
  codec: "h264" | "hevc" = "h264";
  organizeByGame = true;

  private profiles: CaptureProfile[] = [
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
  ];
  private profileMap: ProfileMapEntry[] = [
    { profileId: "competitivo", exeName: "cs2.exe" },
  ];

  private drawScene(t: number) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const { width: w, height: h } = canvas;

    ctx.fillStyle = "#0A0908";
    ctx.fillRect(0, 0, w, h);

    // Diagonal split matching KAGE aesthetic
    ctx.fillStyle = "#12100E";
    ctx.beginPath();
    ctx.moveTo(w * 0.55, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w, h);
    ctx.lineTo(w * 0.22, h);
    ctx.closePath();
    ctx.fill();

    // Horizon grid
    ctx.strokeStyle = "rgba(230, 194, 159, 0.26)";
    ctx.lineWidth = 1.4;
    const horizon = h * 0.54;
    for (let i = 0; i < 20; i++) {
      const p = ((i / 20 + (t * 0.00012) % (1 / 20)) % 1) ** 2.1;
      const y = horizon + p * (h - horizon);
      ctx.globalAlpha = 0.14 + p * 0.45;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Animated reticle
    const cx = w / 2 + Math.sin(t * 0.001) * (w * 0.18);
    const cy = h * 0.42 + Math.cos(t * 0.0013) * 44;
    ctx.fillStyle = "#E6C29F";
    ctx.fillRect(cx - 18, cy - 18, 36, 36);
    ctx.fillStyle = "#E5484D";
    ctx.beginPath();
    ctx.arc(cx + 38, cy, 10, 0, Math.PI * 2);
    ctx.fill();

    const hudX = Math.round((w - 340) / 2);
    const hudY = Math.round(h * 0.68);
    ctx.fillStyle = "rgba(10, 9, 8, 0.78)";
    ctx.fillRect(hudX, hudY, 340, 76);
    ctx.strokeStyle = "#282320";
    ctx.strokeRect(hudX, hudY, 340, 76);
    ctx.fillStyle = "#E6C29F";
    ctx.font = "600 18px sans-serif";
    ctx.fillText("KAGE STUDIO CAPTURE", hudX + 22, hudY + 32);
    ctx.fillStyle = "#F3ECE4";
    ctx.font = "500 14px sans-serif";
    ctx.fillText(
      `T+${((t - this.startedAt) / 1000).toFixed(2)}s / ${this.measuredFps.toFixed(0)} FPS`,
      hudX + 22,
      hudY + 56,
    );
  }

  private loop = (t: number) => {
    if (!this.running) return;
    this.drawScene(t);
    this.frameCount++;
    if (t - this.lastFpsSample > 500) {
      this.measuredFps = (this.frameCount * 1000) / (t - this.lastFpsSample);
      this.frameCount = 0;
      this.lastFpsSample = t;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private spawnLeg() {
    if (!this.stream || !this.mime || !this.ringEnabled) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        videoBitsPerSecond: this.bitrateKbps * 1000,
      });
    } catch {
      return;
    }
    const leg: Leg = { recorder, chunks: [], startedAt: performance.now() };
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) leg.chunks.push(e.data);
    };
    recorder.start(1000);
    this.legs.push(leg);
  }

  private rotateLegs() {
    if (!this.ringEnabled) return;
    const now = performance.now();
    const windowMs = this.bufferSeconds * 1000;
    if (this.legs.length === 0) {
      this.spawnLeg();
      return;
    }
    const newest = this.legs[this.legs.length - 1];
    if (now - newest.startedAt >= windowMs) this.spawnLeg();
    while (this.legs.length > 2 && now - this.legs[0].startedAt > windowMs * 2) {
      const old = this.legs.shift();
      try {
        old?.recorder.stop();
      } catch {
        /* ignore */
      }
    }
  }

  private ringBytes(): number {
    if (!this.ringEnabled) return 0;
    return this.legs.reduce(
      (acc, leg) => acc + leg.chunks.reduce((a, c) => a + c.size, 0),
      0,
    );
  }

  private bufferedSeconds(): number {
    if (!this.ringEnabled || this.legs.length === 0) return 0;
    const oldest = this.legs[0];
    return Math.min(this.bufferSeconds, (performance.now() - oldest.startedAt) / 1000);
  }

  async start(bufferSeconds: number, targetFps: number, enableRing = true): Promise<EngineStats> {
    this.bufferSeconds = bufferSeconds;
    this.targetFps = targetFps;
    if (this.running) {
      if (enableRing && !this.ringEnabled) {
        this.ringEnabled = true;
        this.startedForDirectOnly = false;
        this.spawnLeg();
      }
      return this.stats();
    }

    this.ringEnabled = enableRing;
    this.state = "starting";
    this.lastError = null;

    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.startedAt = performance.now();
      this.lastFpsSample = this.startedAt;
      this.running = true;
      this.raf = requestAnimationFrame(this.loop);

      this.mime = pickMimeType();
      if (this.mime && typeof canvas.captureStream === "function") {
        this.stream = canvas.captureStream(targetFps);
        if (enableRing) this.spawnLeg();
      }
    } else {
      this.startedAt = performance.now();
      this.running = true;
    }

    this.state = "buffering";
    if (this.tickHandle === null && typeof window !== "undefined") {
      this.tickHandle = window.setInterval(() => {
        this.rotateLegs();
        if (this.recordingActive) {
          this.recordingBytes += Math.round((this.bitrateKbps * 1000) / 8 / 4);
        }
        const s = this.stats();
        this.statsListeners.forEach((l) => l(s));
      }, 250);
    }
    return this.stats();
  }

  stop(): EngineStats {
    if (this.recordingActive) {
      this.ringEnabled = false;
      this.legs.forEach((leg) => {
        try {
          leg.recorder.stop();
        } catch {
          /* ignore */
        }
      });
      this.legs = [];
      this.startedForDirectOnly = true;
      return this.stats();
    }
    return this.stopAll();
  }

  private stopAll(): EngineStats {
    this.running = false;
    this.ringEnabled = false;
    if (typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.raf);
    }
    this.legs.forEach((leg) => {
      try {
        leg.recorder.stop();
      } catch {
        /* ignore */
      }
    });
    this.legs = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.state = "idle";
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    return this.stats();
  }

  async startRecording(): Promise<EngineStats> {
    if (this.recordingActive) throw new Error("Direct recording already active");
    if (!this.running) {
      this.startedForDirectOnly = true;
      await this.start(this.bufferSeconds, this.targetFps, false);
    } else {
      this.startedForDirectOnly = false;
    }

    this.recordingChunks = [];
    this.recordingBytes = 0;
    this.recordingStartedAt = performance.now();
    this.recordingActive = true;

    const stamp = this.timestamp();
    this.recordingPath = `C:\\Users\\You\\Videos\\KAGE\\KAGE_Rec_${stamp}.mp4`;

    if (this.stream && this.mime) {
      try {
        const rec = new MediaRecorder(this.stream, {
          mimeType: this.mime,
          videoBitsPerSecond: this.bitrateKbps * 1000,
        });
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            this.recordingChunks.push(e.data);
          }
        };
        rec.start(500);
        this.recordingRecorder = rec;
      } catch {
        this.recordingRecorder = null;
      }
    }
    return this.stats();
  }

  async stopRecording(): Promise<{ clip: ClipMetadata; flushMs: number }> {
    if (!this.recordingActive) throw new Error("Not currently recording");
    const t0 = performance.now();
    const duration = Math.max(0.5, (performance.now() - this.recordingStartedAt) / 1000);
    let url: string | undefined;
    let size = this.recordingBytes;

    if (this.recordingRecorder) {
      const rec = this.recordingRecorder;
      this.recordingRecorder = null;
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        try {
          rec.stop();
        } catch {
          resolve();
        }
      });
      if (this.recordingChunks.length > 0) {
        const blob = new Blob(this.recordingChunks, { type: this.mime || "video/webm" });
        size = blob.size;
        url = URL.createObjectURL(blob);
      }
    }

    this.recordingChunks = [];
    this.recordingActive = false;
    const savedPath = this.recordingPath ?? `C:\\Users\\You\\Videos\\KAGE\\KAGE_Rec_${this.timestamp()}.mp4`;
    this.recordingPath = null;
    this.recordingBytes = 0;

    if (this.startedForDirectOnly) {
      this.startedForDirectOnly = false;
      this.stopAll();
    }

    const fileName = savedPath.split("\\").pop() ?? "KAGE_Rec.mp4";
    const clip: ClipMetadata = {
      id: `${fileName}-${Date.now()}`,
      path: savedPath,
      file_name: fileName,
      title: fileName.replace(/\.mp4$/i, "").replace("KAGE_Rec_", "Rec ").replace(/_/g, " "),
      duration_seconds: duration,
      size_bytes: Math.max(size, 48_000),
      created_unix_ms: Date.now(),
      width: 1920,
      height: 1080,
      fps: this.targetFps,
      has_audio: true,
      game: this.organizeByGame ? (this.foregroundGame()?.exe.replace(/\.exe$/i, "") ?? null) : null,
      thumbnail: this.canvas ? this.canvas.toDataURL("image/jpeg", 0.72) : null,
      favorite: false,
      tags: [],
      preview_url: url,
    };
    this.clips = [clip, ...this.clips];
    return { clip, flushMs: performance.now() - t0 };
  }

  private timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
      now.getMinutes(),
    ).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
  }

  isRunning() {
    return this.running;
  }

  setBufferSeconds(seconds: number) {
    this.bufferSeconds = seconds;
  }

  stats(): EngineStats {
    const buffered = this.bufferedSeconds();
    const jitter = (Math.sin(performance.now() / 900) + 1) * 0.35;
    return {
      state: this.state,
      encoder: {
        vendor: "nvenc",
        friendly_name: "NVIDIA H.264 Encoder MFT (simulated)",
        codec: "H.264",
        hardware: true,
        adapter_name: "Simulated RTX Adapter",
        dedicated_vram_mb: 8192,
      },
      width: 1920,
      height: 1080,
      target_fps: this.targetFps,
      bitrate_kbps: this.bitrateKbps,
      performance_mode: true,
      integrated_gpu: false,
      capture_fps: this.running ? this.measuredFps || this.targetFps : 0,
      buffer_seconds: this.bufferSeconds,
      buffered_seconds: buffered,
      ring_bytes: this.ringBytes(),
      ring_frames: Math.round(buffered * this.targetFps),
      process_rss_bytes:
        (this.running ? 34 : 17) * 1024 * 1024 + this.ringBytes() * 0.04,
      encode_ms_avg: this.running ? 1.1 + jitter * 0.4 : 0,
      gpu_submit_ms_avg: this.running ? 0.24 + jitter * 0.12 : 0,
      dropped_frames: this.droppedFrames,
      device_resets: this.deviceResets,
      audio_system: true,
      audio_mic: false,
      audio_drift_ms: this.running ? Math.sin(performance.now() / 4200) * 1.4 : 0,
      audio_error: null,
      privacy_active: this.privacyGated,
      ring_enabled: this.ringEnabled,
      uptime_seconds: this.running ? (performance.now() - this.startedAt) / 1000 : 0,
      last_error: this.lastError,
      recording_active: this.recordingActive,
      recording_seconds: this.recordingActive
        ? (performance.now() - this.recordingStartedAt) / 1000
        : 0,
      recording_bytes: this.recordingBytes,
      recording_path: this.recordingPath,
    };
  }

  onStats(listener: Listener<EngineStats>): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  setPrivacyGate(gate: boolean) {
    this.privacyGated = gate;
    if (gate) {
      this.legs.forEach((leg) => {
        try {
          leg.recorder.stop();
        } catch {
          /* ignore */
        }
      });
      this.legs = [];
    } else if (this.ringEnabled) {
      this.spawnLeg();
    }
  }

  setFavorite(path: string, favorite: boolean) {
    const clip = this.find(path);
    if (clip) clip.favorite = favorite;
  }

  setTags(path: string, tags: string[]) {
    const clip = this.find(path);
    if (!clip) return;
    const seen = new Set<string>();
    clip.tags = tags
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !seen.has(t) && !!seen.add(t))
      .slice(0, 12);
  }

  async save(
    maxSeconds?: number,
    gameOverride?: string,
  ): Promise<{ clip: ClipMetadata; flushMs: number }> {
    if (!this.running || !this.ringEnabled) {
      throw new Error("Replay buffer is not armed. Press Arm Buffer first.");
    }
    if (this.privacyGated) {
      throw new Error(
        "Privacy mode: nothing recorded because no game is focused. Focus a game to arm the buffer again.",
      );
    }
    const t0 = performance.now();
    const leg = this.legs[0];

    let url: string | undefined;
    let size = 0;
    let duration = Math.min(
      maxSeconds ?? this.bufferSeconds,
      this.bufferedSeconds() || 1,
    );

    if (leg && leg.chunks.length > 0) {
      try {
        leg.recorder.requestData();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 60));
      const blob = new Blob(leg.chunks, { type: this.mime || "video/webm" });
      size = blob.size;
      url = URL.createObjectURL(blob);
      duration = Math.min(duration, (performance.now() - leg.startedAt) / 1000);
    } else {
      size = Math.round((duration * (this.bitrateKbps * 1000)) / 8);
    }

    const stamp = this.timestamp();
    const fileName = `KAGE_Replay_${stamp}.mp4`;

    const game = this.organizeByGame
      ? (gameOverride ?? this.foregroundGame()?.exe.replace(/\.exe$/i, "") ?? null)
      : null;

    const clip: ClipMetadata = {
      id: `${fileName}-${Date.now()}`,
      path: game
        ? `C:\\Users\\You\\Videos\\KAGE\\${game}\\${fileName}`
        : `C:\\Users\\You\\Videos\\KAGE\\${fileName}`,
      file_name: fileName,
      title: `Replay ${stamp.replace("_", " ")}`,
      duration_seconds: duration,
      size_bytes: size,
      created_unix_ms: Date.now(),
      width: 1920,
      height: 1080,
      fps: this.targetFps,
      has_audio: true,
      game,
      thumbnail: this.canvas ? this.canvas.toDataURL("image/jpeg", 0.62) : null,
      favorite: false,
      tags: [],
      preview_url: url,
    };

    this.clips = [clip, ...this.clips];
    return { clip, flushMs: performance.now() - t0 };
  }

  list(): ClipMetadata[] {
    return this.clips;
  }

  find(path: string): ClipMetadata | undefined {
    return this.clips.find((c) => c.path === path);
  }

  delete(path: string) {
    const target = this.clips.find((c) => c.path === path);
    if (target?.preview_url) URL.revokeObjectURL(target.preview_url);
    this.clips = this.clips.filter((c) => c.path !== path);
  }

  cleanupOldClips(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const before = this.clips.length;
    const keep = this.clips.filter((c) => c.created_unix_ms >= cutoff);
    for (const c of this.clips) {
      if (c.created_unix_ms < cutoff && c.preview_url) URL.revokeObjectURL(c.preview_url);
    }
    this.clips = keep;
    return before - keep.length;
  }

  clearAll(): number {
    const count = this.clips.length;
    for (const c of this.clips) {
      if (c.preview_url) URL.revokeObjectURL(c.preview_url);
    }
    this.clips = [];
    return count;
  }

  rename(path: string, newName: string): string {
    const target = this.clips.find((c) => c.path === path);
    if (!target) throw new Error("clip not found");
    const clean = newName.replace(/[\\/:*?"<>|]/g, "");
    const name = clean.toLowerCase().endsWith(".mp4") ? clean : `${clean}.mp4`;
    target.file_name = name;
    target.path = target.path.replace(/[^\\/]+\.mp4$/, () => name);
    target.title = name.replace(/\.mp4$/i, "").replace(/_/g, " ");
    return target.path;
  }

  trim(
    path: string,
    start: number,
    end: number,
    suffix = "_trim",
    overwrite = false,
  ): ClipMetadata {
    const source = this.clips.find((c) => c.path === path);
    if (!source) throw new Error("clip not found");
    const duration = Math.max(0.1, end - start);
    const size = Math.round(
      source.size_bytes * (duration / Math.max(source.duration_seconds, 0.1)),
    );
    if (overwrite) {
      source.duration_seconds = duration;
      source.size_bytes = size;
      source.created_unix_ms = Date.now();
      return { ...source };
    }
    const fileName = source.file_name.replace(/\.mp4$/, `${suffix}.mp4`);
    const clip: ClipMetadata = {
      ...source,
      id: `${fileName}-${Date.now()}`,
      path: source.path.replace(/\.mp4$/, `${suffix}.mp4`),
      file_name: fileName,
      title: `${source.title} (${suffix.replace(/^_/, "")})`,
      duration_seconds: duration,
      size_bytes: size,
      created_unix_ms: Date.now(),
    };
    this.clips = [clip, ...this.clips];
    return clip;
  }

  simulateDeviceLoss() {
    this.deviceResets += 1;
    this.droppedFrames += 3;
    this.state = "recovering";
    window.setTimeout(() => {
      this.state = this.running ? "buffering" : "idle";
    }, 1400);
  }

  foregroundGame(): ForegroundGame | null {
    const phase = Math.floor(performance.now() / 20_000) % 4;
    switch (phase) {
      case 0:
        return { exe: "cs2.exe", title: "Counter-Strike 2" };
      case 1:
        return { exe: "explorer.exe", title: "Program Manager" };
      case 2:
        return { exe: "dota2.exe", title: "Dota 2" };
      default:
        return { exe: "explorer.exe", title: "Program Manager" };
    }
  }

  getProfiles(): CaptureProfile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  getProfileMap(): ProfileMapEntry[] {
    return this.profileMap.map((m) => ({ ...m }));
  }

  saveProfile(profile: CaptureProfile) {
    const id = profile.id.trim().toLowerCase();
    if (!id) throw new Error("profile id cannot be empty");
    const clean: CaptureProfile = {
      ...profile,
      id,
      name: profile.name.trim() || id,
      bufferSeconds: Math.min(600, Math.max(5, profile.bufferSeconds)),
      targetFps: Math.min(240, Math.max(24, profile.targetFps)),
      bitrateKbps: Math.min(150_000, Math.max(1_000, profile.bitrateKbps)),
    };
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i >= 0) this.profiles[i] = clean;
    else this.profiles.push(clean);
  }

  deleteProfile(profileId: string) {
    this.profiles = this.profiles.filter((p) => p.id !== profileId);
    this.profileMap = this.profileMap.filter((m) => m.profileId !== profileId);
  }

  setProfileMap(map: ProfileMapEntry[]) {
    this.profileMap = map.map((m) => ({ ...m }));
  }

  applyProfile(profileId: string) {
    const p = this.profiles.find((x) => x.id === profileId);
    if (!p) throw new Error(`profile '${profileId}' not found`);
    this.bufferSeconds = p.bufferSeconds;
    this.targetFps = p.targetFps;
    this.bitrateKbps = p.bitrateKbps;
    this.codec = p.codec;
  }
}

export const simEngine = new SimEngine();
