import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ClipTrimmerModal } from "./components/ClipTrimmerModal";
import { Sidebar, type AppTab } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { TransportBar } from "./components/TransportBar";
import { DEFAULT_SETTINGS, kage } from "./lib/bridge";
import { formatBytes, formatDuration } from "./lib/format";
import {
  DEFAULT_GALLERY_STATE,
  loadGalleryState,
  saveGalleryState,
  type GalleryState,
} from "./lib/galleryState";
import { decideEco, EcoHysteresis } from "./lib/powerPolicy";
import { PrivacyGateHysteresis, shouldGateForForeground } from "./lib/privacyGate";
import { EMPTY_SELECTION, selectionReducer } from "./lib/selection";
import { playSaveSound } from "./lib/sound";
import { clearThumbnailCache } from "./lib/thumbCache";
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
} from "./lib/types";
import { LibraryView } from "./views/LibraryView";
import { ProfilesView } from "./views/ProfilesView";
import { SettingsView } from "./views/SettingsView";
import { StudioView } from "./views/StudioView";
import { TelemetryView } from "./views/TelemetryView";

const EMPTY_STATS: EngineStats = {
  state: "idle",
  encoder: {
    vendor: "unavailable",
    friendly_name: "Standby",
    codec: "H.264",
    hardware: false,
    adapter_name: "--",
    dedicated_vram_mb: 0,
  },
  width: 0,
  height: 0,
  target_fps: DEFAULT_SETTINGS.targetFps,
  bitrate_kbps: DEFAULT_SETTINGS.bitrateKbps,
  performance_mode: DEFAULT_SETTINGS.performanceMode,
  integrated_gpu: false,
  capture_fps: 0,
  buffer_seconds: DEFAULT_SETTINGS.bufferSeconds,
  buffered_seconds: 0,
  ring_bytes: 0,
  ring_frames: 0,
  process_rss_bytes: 0,
  encode_ms_avg: 0,
  gpu_submit_ms_avg: 0,
  dropped_frames: 0,
  device_resets: 0,
  audio_system: DEFAULT_SETTINGS.captureSystemAudio,
  audio_mic: DEFAULT_SETTINGS.captureMicrophone,
  audio_drift_ms: 0,
  audio_error: null,
  privacy_active: false,
  ring_enabled: false,
  uptime_seconds: 0,
  last_error: null,
  recording_active: false,
  recording_seconds: 0,
  recording_bytes: 0,
  recording_path: null,
};

interface Toast {
  id: number;
  kind: "ok" | "err" | "warn" | "info";
  title: string;
  detail?: string;
}

const PRIVACY_HYSTERESIS_MS = 10_000;
const ECO_HYSTERESIS_MS = 10_000;
const MODIFIER_NAMES = new Set(["alt", "ctrl", "control", "shift", "win", "meta"]);

function matchesShortcut(e: KeyboardEvent, accel: string): boolean {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return false;
  const parts = accel
    .split("+")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const nonMods = parts.filter((t) => !MODIFIER_NAMES.has(t));
  if (parts.length < 2 || nonMods.length !== 1) return false;
  const targetKey = nonMods[0];
  const codeNorm = /^key[a-z]$/i.test(e.code)
    ? e.code.slice(3).toLowerCase()
    : /^digit[0-9]$/i.test(e.code)
      ? e.code.slice(5)
      : e.code.toLowerCase();
  return (
    parts.includes("alt") === e.altKey &&
    (parts.includes("ctrl") || parts.includes("control")) === e.ctrlKey &&
    parts.includes("shift") === e.shiftKey &&
    (parts.includes("win") || parts.includes("meta")) === e.metaKey &&
    (e.key.toLowerCase() === targetKey || codeNorm === targetKey)
  );
}

export default function App() {
  const native = kage.isTauri();
  const [tab, setTab] = useState<AppTab>("studio");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<EngineStats>(EMPTY_STATS);
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [clipsLoading, setClipsLoading] = useState(true);
  const [clipsError, setClipsError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [diskFreeBytes, setDiskFreeBytes] = useState<number | null>(null);
  const [foreground, setForeground] = useState<ForegroundGame | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>("default");
  const [powerNow, setPowerNow] = useState<PowerState | null>(null);
  const [ecoActive, setEcoActive] = useState(false);

  const [gallery, setGallery] = useState<GalleryState>(() => loadGalleryState());
  const [selection, dispatchSelection] = useReducer(
    selectionReducer,
    EMPTY_SELECTION,
  );
  const [selectMode, setSelectMode] = useState(false);
  const selectedPaths = useMemo(
    () => new Set<string>(selection.selected),
    [selection.selected],
  );

  const [activeClip, setActiveClip] = useState<ClipMetadata | null>(null);
  const [activeFlushMs, setActiveFlushMs] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [sessionSaves, setSessionSaves] = useState(0);
  const [sessionBytes, setSessionBytes] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toastSeq = useRef(1);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const activeClipRef = useRef(activeClip);
  activeClipRef.current = activeClip;
  const privacyHysteresis = useRef<PrivacyGateHysteresis | null>(null);
  if (privacyHysteresis.current === null) {
    privacyHysteresis.current = new PrivacyGateHysteresis(PRIVACY_HYSTERESIS_MS);
  }
  const ecoHysteresis = useRef<EcoHysteresis | null>(null);
  if (ecoHysteresis.current === null) {
    ecoHysteresis.current = new EcoHysteresis(ECO_HYSTERESIS_MS);
  }
  const ecoAppliedBuffer = useRef<number | null>(null);

  const pushToast = useCallback(
    (kind: Toast["kind"], title: string, detail?: string) => {
      const id = toastSeq.current++;
      setToasts((prev) => [...prev.slice(-3), { id, kind, title, detail }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4200);
    },
    [],
  );

  const refreshDiskFree = useCallback(async () => {
    try {
      const bytes = await kage.getDiskFreeBytes();
      setDiskFreeBytes(bytes);
    } catch {
      /* disk telemetry optional */
    }
  }, []);

  const refreshClips = useCallback(async () => {
    setClipsLoading(true);
    setClipsError(null);
    try {
      const list = await kage.getClips(false);
      setClips(list);
    } catch (e) {
      setClipsError(String(e));
    } finally {
      setClipsLoading(false);
    }
  }, []);

  // Bootstrap settings, devices, clips, and simulated engine
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded: AppSettings | null = null;
      try {
        const [s, st, mons, devs, free] = await Promise.all([
          kage.getSettings(),
          kage.getStats(),
          kage.getMonitors(),
          kage.getAudioInputDevices(),
          kage.getDiskFreeBytes(),
        ]);
        if (cancelled) return;
        loaded = s;
        setSettings(s);
        setStats(st);
        setMonitors(mons);
        setAudioDevices(devs);
        setDiskFreeBytes(free);
      } catch (e) {
        if (!cancelled) pushToast("warn", "Settings load fallback", String(e));
      }

      try {
        const days = loaded?.autoCleanupDays ?? 0;
        if (days > 0) {
          const deleted = await kage.cleanupOldClips(days);
          if (deleted > 0 && !cancelled) {
            pushToast(
              "warn",
              `Auto-cleanup removed ${deleted} clip${deleted === 1 ? "" : "s"}`,
              `Older than ${days} days.`,
            );
          }
        }
      } catch {
        /* best-effort cleanup */
      }

      if (!cancelled) await refreshClips();

      if (!kage.isTauri() && !cancelled) {
        try {
          const st = await kage.startBuffer(
            loaded?.bufferSeconds ?? DEFAULT_SETTINGS.bufferSeconds,
            loaded?.targetFps ?? DEFAULT_SETTINGS.targetFps,
          );
          if (!cancelled) setStats(st);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushToast, refreshClips]);

  // Engine and tray event listeners
  useEffect(() => {
    const offs: Array<() => void> = [];
    let disposed = false;
    const attach = (p: Promise<() => void>) => {
      void p
        .then((off) => {
          if (disposed) off();
          else offs.push(off);
        })
        .catch(() => {});
    };

    attach(kage.onStats((s) => setStats(s)));
    attach(kage.onBufferState((s) => setStats(s)));
    attach(kage.onRecordingState((s) => setStats(s)));
    attach(
      kage.onClipSaved((payload: ClipSavedPayload) => {
        setClips((prev) => [
          payload.clip,
          ...prev.filter((c) => c.path !== payload.clip.path),
        ]);
        setSessionSaves((n) => n + 1);
        setSessionBytes((b) => b + payload.clip.size_bytes);
        void refreshDiskFree();
        if (settingsRef.current.playSaveSound) playSaveSound();
        const isDirectRec = payload.triggeredBy.startsWith("record");
        pushToast(
          "ok",
          isDirectRec
            ? "Recording saved to MP4"
            : `Replay saved in ${payload.flushMs.toFixed(1)} ms`,
          `${payload.clip.file_name} (${formatDuration(payload.clip.duration_seconds)}, ${formatBytes(
            payload.clip.size_bytes,
          )})`,
        );
        if (payload.openTrimmer ?? settingsRef.current.openTrimmerAfterSave) {
          setActiveClip(payload.clip);
          setActiveFlushMs(isDirectRec ? undefined : payload.flushMs);
        }
      }),
    );
    attach(kage.onError((msg) => pushToast("err", "Engine error", String(msg))));
    attach(kage.onHotkey((accel) => pushToast("info", `${accel} triggered`)));
    attach(
      kage.onDeckHidden(() => {
        clearThumbnailCache();
      }),
    );

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [pushToast, refreshDiskFree]);

  // Track hidden/minimized visibility for WebView idle cost and disk checks
  useEffect(() => {
    const syncVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      document.documentElement.dataset.deckIdle = hidden ? "true" : "false";
      if (!hidden) void refreshDiskFree();
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshDiskFree();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.clearInterval(iv);
    };
  }, [refreshDiskFree]);

  // Engine Actions
  const handleSaveReplay = useCallback(
    async (maxSeconds?: number) => {
      setBusy(true);
      try {
        await kage.saveInstantReplay(maxSeconds, "ui");
      } catch (e) {
        pushToast("err", "Replay save failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [pushToast],
  );

  const handleToggleBuffer = useCallback(async () => {
    setBusy(true);
    try {
      const armed =
        (stats.state === "buffering" || stats.state === "flushing") &&
        stats.ring_enabled;
      const next = armed
        ? await kage.stopBuffer()
        : await kage.startBuffer(settings.bufferSeconds, settings.targetFps);
      setStats(next);
      pushToast(
        armed ? "warn" : "ok",
        armed ? "Buffer disarmed" : "Buffer armed",
        armed
          ? "Rolling ring history released from RAM."
          : `${settings.bufferSeconds}s rolling window active.`,
      );
    } catch (e) {
      pushToast("err", "Buffer toggle failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [stats.state, stats.ring_enabled, settings.bufferSeconds, settings.targetFps, pushToast]);

  const handleToggleRecord = useCallback(async () => {
    setBusy(true);
    try {
      const wasRec = stats.recording_active;
      const next = await kage.toggleRecording();
      setStats(next);
      if (!wasRec) {
        pushToast(
          "info",
          "Direct recording started",
          `Press ${settings.hotkeyRecord} or Stop Recording to finish MP4.`,
        );
      }
    } catch (e) {
      pushToast("err", "Recording failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [stats.recording_active, settings.hotkeyRecord, pushToast]);

  const handleRestartEngine = useCallback(() => {
    setBusy(true);
    const s = settingsRef.current;
    void kage
      .stopBuffer()
      .then(() => kage.startBuffer(s.bufferSeconds, s.targetFps))
      .then((next) => {
        setStats(next);
        pushToast("ok", "Engine restarted", next.encoder.friendly_name);
      })
      .catch((e) => pushToast("err", "Restart failed", String(e)))
      .finally(() => setBusy(false));
  }, [pushToast]);

  // Browser preview keyboard shim for Alt+C / Alt+R / Alt+Shift+C
  useEffect(() => {
    if (kage.isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const s = settingsRef.current;
      if (matchesShortcut(e, s.hotkeySave)) {
        e.preventDefault();
        kage.emitLocalHotkey(s.hotkeySave);
        void handleSaveReplay();
      } else if (matchesShortcut(e, s.hotkeyRecord)) {
        e.preventDefault();
        kage.emitLocalHotkey(s.hotkeyRecord);
        void handleToggleRecord();
      } else if (matchesShortcut(e, s.hotkeyToggle)) {
        e.preventDefault();
        kage.emitLocalHotkey(s.hotkeyToggle);
        void handleToggleBuffer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSaveReplay, handleToggleBuffer, handleToggleRecord]);

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await kage.updateSettings(patch);
        setSettings(next);
        if (patch.bufferSeconds || patch.targetFps || patch.bitrateKbps || patch.codec) {
          setActiveProfileId(null);
        }
        if (patch.outputDir) {
          void refreshDiskFree();
          void refreshClips();
        }
      } catch (e) {
        pushToast("err", "Could not persist settings", String(e));
      }
    },
    [pushToast, refreshClips, refreshDiskFree],
  );

  // Profiles & Foreground Polling (opt-in)
  const applyProfile = useCallback(
    async (
      profileId: string,
      source: "manual" | "auto" = "manual",
      gameExe?: string | null,
    ) => {
      if (busy) return;
      try {
        const prev = settingsRef.current;
        const next = await kage.applyProfile(profileId);
        setSettings(next);
        setActiveProfileId(profileId);
        const profile = next.profiles.find((p) => p.id === profileId);
        const needsRestart =
          !!profile &&
          (profile.codec !== prev.codec ||
            profile.bitrateKbps !== prev.bitrateKbps ||
            profile.targetFps !== prev.targetFps);
        pushToast(
          "ok",
          profile ? `${profile.name} profile active` : "Profile applied",
          needsRestart
            ? `Buffer ${next.bufferSeconds}s live. Restart engine in Settings or Telemetry for codec or FPS changes.`
            : `Buffer ${next.bufferSeconds}s at ${next.targetFps}fps live now.`,
        );
        const exe = gameExe ?? foreground?.exe;
        if (source === "auto" && profile && exe) {
          void kage.notify(`${profile.name} profile active`, `${exe}: buffer ${next.bufferSeconds}s`);
        }
      } catch (e) {
        pushToast("err", "Could not apply profile", String(e));
      }
    },
    [busy, foreground, pushToast],
  );

  const applyProfileRef = useRef(applyProfile);
  applyProfileRef.current = applyProfile;

  const needsForegroundPoll =
    settings.autoSwitchProfiles ||
    settings.privacyPauseWhenUnfocused ||
    settings.autosaveOnGameExit ||
    tab === "profiles";

  useEffect(() => {
    if (!needsForegroundPoll) {
      setForeground(null);
      return;
    }
    let cancelled = false;
    let lastFocusedExe: string | null = null;
    let focusedSince = Date.now();
    let lastSwitchExe: string | null = null;
    let lastApplyAt = 0;
    let lastAutosaveAt = 0;

    const tick = async () => {
      if (cancelled) return;
      let game: ForegroundGame | null = null;
      try {
        game = await kage.getForegroundGame();
      } catch {
        return;
      }
      if (cancelled) return;
      setForeground((prev) =>
        prev && game && prev.exe === game.exe && prev.title === game.title
          ? prev
          : !prev && !game
            ? prev
            : game,
      );
      const exe = game?.exe ?? "";

      if (
        lastFocusedExe &&
        !shouldGateForForeground(lastFocusedExe) &&
        exe !== lastFocusedExe &&
        settingsRef.current.autosaveOnGameExit
      ) {
        const now = Date.now();
        if (now - focusedSince > 10_000 && now - lastAutosaveAt > 60_000) {
          lastAutosaveAt = now;
          try {
            await kage.saveInstantReplay(30, "autosave", lastFocusedExe);
            pushToast("ok", "Auto-saved on game exit", `${lastFocusedExe}: last 30s saved`);
          } catch {
            /* buffer disarmed */
          }
        }
      }
      if (exe !== lastFocusedExe) {
        lastFocusedExe = exe;
        focusedSince = Date.now();
      }

      if (settingsRef.current.privacyPauseWhenUnfocused) {
        const gate = privacyHysteresis.current!.tick(
          true,
          shouldGateForForeground(exe),
        );
        if (gate !== null) {
          try {
            await kage.setPrivacyGate(gate);
            privacyHysteresis.current!.commit(gate);
            pushToast(
              "info",
              gate ? "Privacy mode paused" : "Privacy mode resumed",
              gate
                ? "Desktop or KAGE focused. Rolling history cleared."
                : "Game capture resumed.",
            );
          } catch {
            /* retry next poll */
          }
        }
      } else {
        const gate = privacyHysteresis.current!.tick(false, false);
        if (gate !== null) {
          await kage.setPrivacyGate(false).catch(() => {});
        }
      }

      if (!settingsRef.current.autoSwitchProfiles || !exe || exe === lastSwitchExe) return;
      lastSwitchExe = exe;
      const now = Date.now();
      if (now - lastApplyAt < 4000) return;
      const { profiles, profileMap } = settingsRef.current;
      const entry = profileMap.find((m) => m.exeName.toLowerCase() === exe);
      const target = entry ? profiles.find((p) => p.id === entry.profileId) : null;
      if (target && target.id !== activeProfileIdRef.current) {
        lastApplyAt = now;
        await applyProfileRef.current(target.id, "auto", exe);
      } else if (!target && activeProfileIdRef.current && activeProfileIdRef.current !== "default") {
        const def = profiles.find((p) => p.id === "default");
        if (def) {
          lastApplyAt = now;
          await applyProfileRef.current(def.id, "auto", exe);
        }
      }
    };
    void tick();
    const iv = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [needsForegroundPoll, pushToast]);

  // Adaptive ECO Polling (opt-in)
  useEffect(() => {
    if (!settings.adaptiveEco) {
      if (ecoAppliedBuffer.current !== null) {
        ecoAppliedBuffer.current = null;
        void kage.setBufferSeconds(settingsRef.current.bufferSeconds).catch(() => {});
      }
      setEcoActive(false);
      setPowerNow(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      let power: PowerState;
      try {
        power = await kage.getPowerState();
      } catch {
        return;
      }
      if (cancelled) return;
      setPowerNow(power);
      const s = settingsRef.current;
      const decision = decideEco(power, s);
      const flip = ecoHysteresis.current!.tick(decision.active);
      if (flip === null) return;

      const target = flip ? decision.ecoBufferSeconds : s.bufferSeconds;
      try {
        await kage.setBufferSeconds(target);
        ecoHysteresis.current!.commit(flip);
        ecoAppliedBuffer.current = target;
        setEcoActive(flip);
        pushToast(
          "info",
          flip ? "ECO mode active" : "ECO mode off",
          flip
            ? `${decision.reason === "battery" ? "Battery low" : "Low free RAM"}: buffer set to ${target}s.`
            : `Full ${s.bufferSeconds}s buffer restored.`,
        );
      } catch {
        /* retry next poll */
      }
    };
    void tick();
    const iv = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [settings.adaptiveEco, pushToast]);

  const updateGallery = useCallback((patch: Partial<GalleryState>) => {
    setGallery((prev) => {
      const next = { ...prev, ...patch };
      saveGalleryState(next);
      return next;
    });
  }, []);

  const chooseOutputFolder = useCallback(async () => {
    if (!native) {
      pushToast("info", "Browser preview", "Run the KAGE desktop app to browse system folders.");
      return;
    }
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: "Choose KAGE output folder",
      });
      if (typeof dir === "string" && dir.length > 0) {
        await patchSettings({ outputDir: dir });
        pushToast("ok", "Output folder updated", dir);
      }
    } catch (e) {
      pushToast("err", "Could not change folder", String(e));
    }
  }, [native, patchSettings, pushToast]);

  const handleOpenClip = useCallback((c: ClipMetadata) => {
    setActiveClip(c);
    setActiveFlushMs(undefined);
  }, []);

  const handleCopyClip = useCallback(
    (c: ClipMetadata) => {
      void kage
        .copyClip(c.path)
        .then(() => pushToast("ok", "Copied to clipboard", c.file_name))
        .catch((e) => pushToast("err", "Copy failed", String(e)));
    },
    [pushToast],
  );

  const handleRevealClip = useCallback(
    (c: ClipMetadata) => {
      void kage
        .revealClip(c.path)
        .catch((e) => pushToast("err", "Could not open Explorer", String(e)));
    },
    [pushToast],
  );

  const handleOpenExternalClip = useCallback(
    (c: ClipMetadata) => {
      void kage
        .openClip(c.path)
        .catch((e) => pushToast("err", "Could not launch player", String(e)));
    },
    [pushToast],
  );

  const handleDeleteClip = useCallback(
    (c: ClipMetadata) => {
      void kage
        .deleteClip(c.path)
        .then(() => {
          setClips((prev) => prev.filter((x) => x.path !== c.path));
          dispatchSelection({ type: "clear" });
          if (activeClipRef.current?.path === c.path) setActiveClip(null);
          pushToast("warn", "Clip deleted", c.file_name);
          void refreshDiskFree();
        })
        .catch((e) => pushToast("err", "Delete failed", String(e)));
    },
    [pushToast, refreshDiskFree],
  );

  const handleToggleFavorite = useCallback(
    (c: ClipMetadata) => {
      const next = !c.favorite;
      setClips((prev) =>
        prev.map((x) => (x.path === c.path ? { ...x, favorite: next } : x)),
      );
      setActiveClip((cur) => (cur && cur.path === c.path ? { ...cur, favorite: next } : cur));
      void kage
        .setClipFavorite(c.path, next)
        .catch((e) => pushToast("err", "Could not update favorite", String(e)));
    },
    [pushToast],
  );

  const activeProfileName =
    settings.profiles.find((p) => p.id === activeProfileId)?.name ?? null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0A0908] text-[#F3ECE4]">
      <TitleBar
        stats={stats}
        minimizeToTray={settings.minimizeToTray}
        onOpenFolder={() =>
          void kage
            .openOutputFolder()
            .catch((e) => pushToast("err", "Could not open folder", String(e)))
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          tab={tab}
          onTabChange={setTab}
          clipCount={clips.length}
          stats={stats}
          diskFreeBytes={diskFreeBytes}
          activeProfileName={activeProfileName}
          ecoActive={ecoActive}
        />

        <main className="min-w-0 flex-1 overflow-y-auto bg-[#0A0908]">
          {tab === "studio" && (
            <StudioView
              stats={stats}
              settings={settings}
              clips={clips}
              clipsLoading={clipsLoading}
              clipsError={clipsError}
              diskFreeBytes={diskFreeBytes}
              busy={busy}
              sessionSaves={sessionSaves}
              sessionBytes={sessionBytes}
              onSaveReplay={(sec) => void handleSaveReplay(sec)}
              onToggleRecord={() => void handleToggleRecord()}
              onToggleBuffer={() => void handleToggleBuffer()}
              onPatchSettings={(p) => void patchSettings(p)}
              onOpenClip={handleOpenClip}
              onCopyClip={handleCopyClip}
              onRevealClip={handleRevealClip}
              onOpenExternalClip={handleOpenExternalClip}
              onDeleteClip={handleDeleteClip}
              onToggleFavorite={handleToggleFavorite}
              onOpenLibrary={() => setTab("library")}
              onRetryClips={() => void refreshClips()}
            />
          )}

          {tab === "library" && (
            <LibraryView
              clips={clips}
              loading={clipsLoading}
              error={clipsError}
              gallery={gallery}
              onGalleryChange={updateGallery}
              onResetFilters={() => updateGallery(DEFAULT_GALLERY_STATE)}
              selectedPaths={selectedPaths}
              selectMode={selectMode}
              onToggleSelectMode={() => {
                setSelectMode((s) => !s);
                dispatchSelection({ type: "clear" });
              }}
              onSelectClip={(clip, mods, visibleOrder) =>
                dispatchSelection({
                  type: "click",
                  path: clip.path,
                  order: visibleOrder,
                  ctrl: mods.ctrl,
                  shift: mods.shift,
                })
              }
              onSelectAll={(visible) =>
                dispatchSelection({
                  type: "select-all",
                  order: visible.map((c) => c.path),
                })
              }
              onClearSelection={() => dispatchSelection({ type: "clear" })}
              onOpenClip={handleOpenClip}
              onCopyClip={handleCopyClip}
              onRevealClip={handleRevealClip}
              onOpenExternalClip={handleOpenExternalClip}
              onDeleteClip={handleDeleteClip}
              onToggleFavorite={handleToggleFavorite}
              onBatchCopy={() =>
                void kage
                  .copyClips(selection.selected)
                  .then(() =>
                    pushToast("ok", `Copied ${selection.selected.length} clips to clipboard`),
                  )
                  .catch((e) => pushToast("err", "Batch copy failed", String(e)))
              }
              onBatchFavorite={(fav) =>
                void kage
                  .setClipsFavorite(selection.selected, fav)
                  .then(() => {
                    setClips((prev) =>
                      prev.map((c) =>
                        selectedPaths.has(c.path) ? { ...c, favorite: fav } : c,
                      ),
                    );
                  })
                  .catch((e) => pushToast("err", "Batch favorite failed", String(e)))
              }
              onBatchTag={(tag) =>
                void kage
                  .addClipsTag(selection.selected, tag)
                  .then(() => void refreshClips())
                  .catch((e) => pushToast("err", "Batch tag failed", String(e)))
              }
              onBatchDelete={() =>
                void kage
                  .deleteClips(selection.selected)
                  .then((count) => {
                    setClips((prev) => prev.filter((c) => !selectedPaths.has(c.path)));
                    dispatchSelection({ type: "clear" });
                    pushToast("warn", `Deleted ${count} clips`);
                    void refreshDiskFree();
                  })
                  .catch((e) => pushToast("err", "Batch delete failed", String(e)))
              }
              onRefresh={() => void refreshClips()}
              hotkeySave={settings.hotkeySave}
              hotkeyRecord={settings.hotkeyRecord}
            />
          )}

          {tab === "profiles" && (
            <ProfilesView
              settings={settings}
              activeProfileId={activeProfileId}
              foreground={foreground}
              busy={busy}
              onPatchSettings={(p) => void patchSettings(p)}
              onApplyProfile={(id) => void applyProfile(id, "manual")}
              onSaveProfile={async (profile: CaptureProfile) => {
                try {
                  const next = await kage.saveProfile(profile);
                  setSettings(next);
                  pushToast("ok", "Profile saved", profile.name);
                  return true;
                } catch (e) {
                  pushToast("err", "Save failed", String(e));
                  return false;
                }
              }}
              onDeleteProfile={(id) =>
                void kage
                  .deleteProfile(id)
                  .then((next) => {
                    setSettings(next);
                    pushToast("warn", "Profile deleted", id);
                  })
                  .catch((e) => pushToast("err", "Delete failed", String(e)))
              }
              onSetProfileMap={(map: ProfileMapEntry[]) =>
                void kage
                  .setProfileMap(map)
                  .then(setSettings)
                  .catch((e) => pushToast("err", "Could not update mappings", String(e)))
              }
              onRefreshForeground={() =>
                void kage
                  .getForegroundGame()
                  .then(setForeground)
                  .catch((e) => pushToast("err", "Foreground query failed", String(e)))
              }
            />
          )}

          {tab === "telemetry" && (
            <TelemetryView
              stats={stats}
              diskFreeBytes={diskFreeBytes}
              busy={busy}
              onRestartEngine={handleRestartEngine}
              onSimulateDeviceLoss={() =>
                void kage
                  .simulateDeviceLoss()
                  .then(() => kage.getStats())
                  .then((next) => {
                    setStats(next);
                    pushToast("info", "Device recovery simulated");
                  })
                  .catch((e) => pushToast("err", "Recovery failed", String(e)))
              }
            />
          )}

          {tab === "settings" && (
            <SettingsView
              settings={settings}
              stats={stats}
              monitors={monitors}
              audioDevices={audioDevices}
              powerNow={powerNow}
              diskFreeBytes={diskFreeBytes}
              busy={busy}
              onPatchSettings={(p) => void patchSettings(p)}
              onRestartEngine={handleRestartEngine}
              onChooseOutputFolder={() => void chooseOutputFolder()}
              onOpenOutputFolder={() =>
                void kage
                  .openOutputFolder()
                  .catch((e) => pushToast("err", "Could not open folder", String(e)))
              }
              onCleanupNow={() =>
                void kage
                  .cleanupOldClips(settings.autoCleanupDays)
                  .then((n) => {
                    pushToast("info", `Cleanup removed ${n} old clip${n === 1 ? "" : "s"}`);
                    void refreshClips();
                  })
                  .catch((e) => pushToast("err", "Cleanup failed", String(e)))
              }
            />
          )}
        </main>
      </div>

      <TransportBar
        stats={stats}
        settings={settings}
        busy={busy}
        onSaveReplay={() => void handleSaveReplay()}
        onToggleRecord={() => void handleToggleRecord()}
        onToggleBuffer={() => void handleToggleBuffer()}
      />

      {activeClip && (
        <ClipTrimmerModal
          clip={activeClip}
          flushMs={activeFlushMs}
          onClose={() => setActiveClip(null)}
          onTrimSaved={() => void refreshClips()}
          onDeleted={handleDeleteClip}
          onRenamed={(oldPath, next) => {
            setClips((prev) =>
              prev.map((x) => (x.path === oldPath ? next : x)),
            );
            setActiveClip(next);
          }}
          onToggleFavorite={handleToggleFavorite}
          onUpdateTags={(c, nextTags) => {
            setClips((prev) =>
              prev.map((x) => (x.path === c.path ? { ...x, tags: nextTags } : x)),
            );
            setActiveClip((cur) => (cur && cur.path === c.path ? { ...cur, tags: nextTags } : cur));
            void kage
              .setClipTags(c.path, nextTags)
              .catch((e) => pushToast("err", "Tag update failed", String(e)));
          }}
          onToast={pushToast}
        />
      )}

      {/* Non-blocking live region toasts */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-20 right-4 z-40 flex w-80 flex-col gap-2"
      >
        {toasts.map((t) => {
          const border =
            t.kind === "err"
              ? "border-[#FF6B6F]/70 bg-[#241112]"
              : t.kind === "warn"
                ? "border-[#F5B971]/60 bg-[#1B1610]"
                : t.kind === "ok"
                  ? "border-[#4ADE80]/50 bg-[#101A14]"
                  : "border-[#E6C29F]/50 bg-[#1A1715]";
          return (
            <div
              key={t.id}
              className={`pointer-events-auto rounded-[10px] border px-3.5 py-2.5 text-xs shadow-lg animate-toast ${border}`}
            >
              <div className="font-semibold text-[#F3ECE4]">{t.title}</div>
              {t.detail && (
                <div className="mt-0.5 text-[11px] text-[#B5AA9F] break-all">
                  {t.detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
