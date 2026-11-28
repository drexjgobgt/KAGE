import { useState, type CSSProperties } from "react";
import { formatBytes } from "../lib/format";
import type {
  AppSettings,
  AudioDevice,
  EngineStats,
  MonitorInfo,
  PowerState,
} from "../lib/types";
import { IconFolder, IconMonitor, IconRefresh } from "../components/Icons";

interface SettingsViewProps {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  audioDevices: AudioDevice[];
  powerNow: PowerState | null;
  diskFreeBytes: number | null;
  busy: boolean;
  onPatchSettings: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onChooseOutputFolder: () => void;
  onOpenOutputFolder: () => void;
  onCleanupNow: () => void;
}

type HotkeyField = "hotkeySave" | "hotkeyRecord" | "hotkeyToggle";

function formatKeyEvent(e: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key) || mods.length === 0) {
    return null;
  }

  let main: string;
  if (/^Key[A-Z]$/.test(e.code)) {
    main = e.code.slice(3);
  } else if (/^Digit[0-9]$/.test(e.code)) {
    main = e.code.slice(5);
  } else if (e.code === "Space") {
    main = "Space";
  } else if (/^F\d{1,2}$/.test(e.code)) {
    main = e.code;
  } else {
    main = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  return [...mods, main].join("+");
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <div className="text-xs font-medium text-[#F3ECE4]">{label}</div>
        <div className="text-[11px] text-[#94897E]">{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[#E6C29F]"
      />
    </label>
  );
}

export function SettingsView({
  settings,
  stats,
  monitors,
  audioDevices,
  powerNow,
  diskFreeBytes,
  busy,
  onPatchSettings,
  onRestartEngine,
  onChooseOutputFolder,
  onOpenOutputFolder,
  onCleanupNow,
}: SettingsViewProps) {
  const [capturing, setCapturing] = useState<HotkeyField | null>(null);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  const engineRunning = stats.state !== "idle";
  const needsEngineRestart =
    engineRunning &&
    (stats.target_fps !== settings.targetFps ||
      Math.round(stats.bitrate_kbps) !== Math.round(settings.bitrateKbps) ||
      stats.encoder.codec.toLowerCase() !== settings.codec ||
      stats.performance_mode !== settings.performanceMode ||
      stats.audio_system !== settings.captureSystemAudio ||
      stats.audio_mic !== settings.captureMicrophone);

  const assignHotkey = (field: HotkeyField, combo: string) => {
    const others: HotkeyField[] = (["hotkeySave", "hotkeyRecord", "hotkeyToggle"] as const).filter(
      (f) => f !== field,
    );
    const conflict = others.find(
      (f) => settings[f].trim().toLowerCase() === combo.trim().toLowerCase(),
    );
    if (conflict) {
      setHotkeyError(`"${combo}" is already assigned to another shortcut.`);
      setCapturing(null);
      return;
    }
    setHotkeyError(null);
    setCapturing(null);
    onPatchSettings({ [field]: combo });
  };

  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <h1 className="font-display text-4xl leading-none text-[#F3ECE4]">
          Settings
        </h1>
        <p className="mt-1.5 text-xs text-[#B5AA9F]">
          Hotkeys, GPU video pipeline, audio routing, storage safety, and power policy.
        </p>
      </div>

      {needsEngineRestart && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[#F5B971]/60 bg-[#1B1610] px-4 py-3 text-xs"
        >
          <div>
            <span className="font-semibold text-[#F5B971]">Restart Engine Required: </span>
            <span className="text-[#F3ECE4]">
              New FPS, bitrate, codec, or audio routing changes apply after restarting capture.
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onRestartEngine}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#E6C29F] px-3.5 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:opacity-50"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            <span>Restart Engine</span>
          </button>
        </div>
      )}

      {/* Global Shortcuts */}
      <section aria-label="Global Hotkeys" className="bezel-outer">
        <div className="bezel-inner flex flex-col gap-3 p-5">
          <div>
            <h2 className="font-display text-2xl text-[#F3ECE4]">Global Shortcuts</h2>
            <p className="text-xs text-[#94897E]">
              Click a shortcut button, then press a modifier plus key combination (e.g. Alt+R).
            </p>
          </div>

          {hotkeyError && (
            <div
              role="alert"
              className="rounded-[8px] border border-[#FF6B6F]/50 bg-[#241112] px-3 py-2 text-xs text-[#FF6B6F]"
            >
              {hotkeyError}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            {(
              [
                {
                  field: "hotkeySave",
                  title: "Save Instant Replay",
                  desc: "Flush rolling buffer to MP4",
                },
                {
                  field: "hotkeyRecord",
                  title: "Start / Stop Recording",
                  desc: "Stream continuous MP4 to disk",
                },
                {
                  field: "hotkeyToggle",
                  title: "Arm / Disarm Buffer",
                  desc: "Release or allocate rolling ring",
                },
              ] as const
            ).map(({ field, title, desc }) => {
              const active = capturing === field;
              return (
                <div
                  key={field}
                  className="flex flex-col justify-between gap-2 rounded-[10px] border border-[#282320] bg-[#0D0B0A] p-3"
                >
                  <div>
                    <div className="text-xs font-medium text-[#F3ECE4]">{title}</div>
                    <div className="text-[11px] text-[#94897E]">{desc}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setHotkeyError(null);
                      setCapturing(active ? null : field);
                    }}
                    onKeyDown={(e) => {
                      if (!active) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.key === "Escape") {
                        setCapturing(null);
                        return;
                      }
                      const combo = formatKeyEvent(e);
                      if (combo) assignHotkey(field, combo);
                    }}
                    className={`rounded-[8px] border px-3 py-1.5 font-mono text-xs font-semibold transition-colors ${
                      active
                        ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                        : "border-[#6E655E] bg-[#1A1715] text-[#F3ECE4] hover:border-[#E6C29F]"
                    }`}
                  >
                    {active ? "Press Keys..." : settings[field]}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Capture & Video */}
      <section aria-label="Capture and Video" className="bezel-outer">
        <div className="bezel-inner flex flex-col gap-4 p-5">
          <h2 className="font-display text-2xl text-[#F3ECE4]">
            Capture and Encoder
          </h2>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between">
                <span className="font-medium text-[#F3ECE4]">Rolling Buffer Window</span>
                <span className="font-mono tabular-nums text-[#E6C29F]">
                  {settings.bufferSeconds}s
                </span>
              </div>
              <input
                type="range"
                min={15}
                max={300}
                step={15}
                value={settings.bufferSeconds}
                style={{
                  "--range-pct": `${Math.min(100, Math.max(0, ((settings.bufferSeconds - 15) / (300 - 15)) * 100))}%`,
                } as CSSProperties}
                onChange={(e) =>
                  onPatchSettings({ bufferSeconds: Number(e.target.value) })
                }
                className="kage-range w-full"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between">
                <span className="font-medium text-[#F3ECE4]">Target Bitrate</span>
                <span className="font-mono tabular-nums text-[#E6C29F]">
                  {(settings.bitrateKbps / 1000).toFixed(0)} Mbps
                </span>
              </div>
              <input
                type="range"
                min={6000}
                max={60000}
                step={2000}
                value={settings.bitrateKbps}
                style={{
                  "--range-pct": `${Math.min(100, Math.max(0, ((settings.bitrateKbps - 6000) / (60000 - 6000)) * 100))}%`,
                } as CSSProperties}
                onChange={(e) =>
                  onPatchSettings({ bitrateKbps: Number(e.target.value) })
                }
                className="kage-range w-full"
              />
            </label>

            <div className="flex flex-col gap-1.5 text-xs">
              <span className="font-medium text-[#F3ECE4]">Frame Rate</span>
              <div
                role="group"
                aria-label="Target frame rate"
                className="grid h-[38px] grid-cols-3 gap-1.5 rounded-[10px] border border-[#6E655E] bg-[#0A0908] p-1"
              >
                {[
                  { fps: 30, hint: "Light" },
                  { fps: 60, hint: "Balanced" },
                  { fps: 120, hint: "High Hz" },
                ].map(({ fps, hint }) => {
                  const selected = settings.targetFps === fps;
                  return (
                    <button
                      key={fps}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onPatchSettings({ targetFps: fps })}
                      className={`rounded-[7px] px-2 text-center font-mono text-xs transition-colors ${
                        selected
                          ? "border border-[#E6C29F] bg-[#241D15] font-semibold text-[#E6C29F]"
                          : "border border-transparent text-[#B5AA9F] hover:bg-[#141210] hover:text-[#F3ECE4]"
                      }`}
                    >
                      <span>{fps} FPS</span>
                      <span className="ml-1 hidden xl:inline text-[10px] text-[#94897E]">
                        ({hint})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1.5 text-xs">
              <span className="font-medium text-[#F3ECE4]">Video Codec</span>
              <select
                value={settings.codec}
                onChange={(e) =>
                  onPatchSettings({ codec: e.target.value as "h264" | "hevc" })
                }
                className="h-[38px] rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-3 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
              >
                <option value="h264">H.264 (Maximum Discord / Editor compatibility)</option>
                <option value="hevc">HEVC / H.265 (Smaller file footprint)</option>
              </select>
            </label>
          </div>

          <div className="grid gap-3 pt-1">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#F3ECE4]">
                <IconMonitor className="h-3.5 w-3.5 text-[#E6C29F]" />
                Display Monitor
              </span>
              <select
                value={settings.monitorIndex}
                onChange={(e) =>
                  onPatchSettings({ monitorIndex: Number(e.target.value) })
                }
                className="h-[38px] rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-3 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
              >
                {monitors.map((m) => (
                  <option key={m.index} value={m.index}>
                    {m.name} ({m.width}x{m.height}
                    {m.refresh_hz > 0 ? ` ${m.refresh_hz}Hz` : ""}
                    {m.primary ? ", Primary" : ""})
                  </option>
                ))}
              </select>
            </label>

            <div className="divide-y divide-[#282320] border-t border-[#282320] pt-1">
              <ToggleRow
                label="Game Performance Mode"
                hint="Caps capture at 1080p 60fps so ultrawide 4K/1440p displays do not contend with games."
                checked={settings.performanceMode}
                onChange={(v) => onPatchSettings({ performanceMode: v })}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Audio & Storage */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Audio Settings" className="bezel-outer">
          <div className="bezel-inner flex h-full flex-col gap-3 p-5">
            <h2 className="font-display text-2xl text-[#F3ECE4]">Audio Routing</h2>
            <div className="divide-y divide-[#282320]">
              <ToggleRow
                label="Capture System / Game Audio"
                hint="Captures desktop and game sound into the AAC stereo mix."
                checked={settings.captureSystemAudio}
                onChange={(v) => onPatchSettings({ captureSystemAudio: v })}
              />
              <ToggleRow
                label="Capture Microphone"
                hint="Mixes selected input device live with system audio."
                checked={settings.captureMicrophone}
                onChange={(v) => onPatchSettings({ captureMicrophone: v })}
              />
            </div>

            <label className="mt-1 flex flex-col gap-1.5 text-xs">
              <span className="font-medium text-[#F3ECE4]">Microphone Input Device</span>
              <select
                value={settings.micDeviceId ?? ""}
                onChange={(e) =>
                  onPatchSettings({
                    micDeviceId: e.target.value ? e.target.value : null,
                  })
                }
                className="h-[38px] rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-3 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
              >
                <option value="">Windows Default Communications / Capture</option>
                {audioDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section aria-label="Storage Settings" className="bezel-outer">
          <div className="bezel-inner flex h-full flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-2xl text-[#F3ECE4]">Storage</h2>
              {diskFreeBytes !== null && (
                <span className="font-mono text-xs tabular-nums text-[#E6C29F]">
                  {formatBytes(diskFreeBytes)} free
                </span>
              )}
            </div>

            <div className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-3 py-2 font-mono text-xs text-[#B5AA9F] truncate" title={settings.outputDir}>
              {settings.outputDir}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onChooseOutputFolder}
                className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F]"
              >
                <IconFolder className="h-3.5 w-3.5" />
                <span>Change Folder</span>
              </button>
              <button
                type="button"
                onClick={onOpenOutputFolder}
                className="rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
              >
                Open in Explorer
              </button>
              <button
                type="button"
                disabled={busy || settings.autoCleanupDays <= 0}
                onClick={onCleanupNow}
                className="rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] disabled:opacity-40"
              >
                Run Cleanup Now
              </button>
            </div>

            <label className="mt-1 flex items-center justify-between gap-4 text-xs">
              <div>
                <div className="font-medium text-[#F3ECE4]">Auto-cleanup Retention</div>
                <div className="text-[11px] text-[#94897E]">
                  Delete un-starred clips older than this many days (0 keeps forever).
                </div>
              </div>
              <input
                type="number"
                min={0}
                max={365}
                value={settings.autoCleanupDays}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onPatchSettings({
                    autoCleanupDays: Number.isFinite(n)
                      ? Math.min(365, Math.max(0, Math.round(n)))
                      : 0,
                  });
                }}
                className="w-20 rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-2.5 py-1.5 text-right font-mono text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
              />
            </label>

            <div className="divide-y divide-[#282320] border-t border-[#282320]">
              <ToggleRow
                label="Organize Clips by Game Subfolder"
                hint="Creates subfolders under Output Directory per detected game."
                checked={settings.organizeByGame}
                onChange={(v) => onPatchSettings({ organizeByGame: v })}
              />
              <ToggleRow
                label="Open Trimmer After Save"
                hint="Opens modal trimmer after UI or desktop save (never steals game focus)."
                checked={settings.openTrimmerAfterSave}
                onChange={(v) => onPatchSettings({ openTrimmerAfterSave: v })}
              />
              <ToggleRow
                label="Subtle Save Chime"
                hint="Plays a brief two-note chime when replay or recording finishes."
                checked={settings.playSaveSound}
                onChange={(v) => onPatchSettings({ playSaveSound: v })}
              />
            </div>
          </div>
        </section>
      </div>

      {/* Privacy, Power & App Shell */}
      <section aria-label="Privacy Power and Behavior" className="bezel-outer">
        <div className="bezel-inner flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-2xl text-[#F3ECE4]">
              Privacy, ECO Power and Desktop Shell
            </h2>
            {powerNow && (
              <span className="font-mono text-xs tabular-nums text-[#B5AA9F]">
                {powerNow.onBattery ? `Battery ${powerNow.batteryPercent}%` : "AC Power"} / Free RAM {(powerNow.availableRamBytes / 1024 ** 3).toFixed(1)} GB
              </span>
            )}
          </div>

          <div className="divide-y divide-[#282320]">
            <ToggleRow
              label="Privacy Gate When Desktop Focused"
              hint="Clears ring buffer and pauses replay capture while KAGE or Windows desktop owns focus."
              checked={settings.privacyPauseWhenUnfocused}
              onChange={(v) => onPatchSettings({ privacyPauseWhenUnfocused: v })}
            />
            <ToggleRow
              label="Auto-Save Last 30s on Game Exit"
              hint="Automatically flushes a replay clip when a tracked full-screen game closes."
              checked={settings.autosaveOnGameExit}
              onChange={(v) => onPatchSettings({ autosaveOnGameExit: v })}
            />
            <ToggleRow
              label="Adaptive ECO Capture"
              hint="Shrinks replay buffer automatically when laptop battery or free system RAM drops below threshold."
              checked={settings.adaptiveEco}
              onChange={(v) => onPatchSettings({ adaptiveEco: v })}
            />
            {settings.adaptiveEco && (
              <div className="grid gap-3 py-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-[8px] border border-[#282320] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <span className="text-[#B5AA9F]">Battery threshold (%)</span>
                  <input
                    type="number"
                    min={5}
                    max={90}
                    value={settings.ecoBatteryThresholdPct}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      onPatchSettings({
                        ecoBatteryThresholdPct: Number.isFinite(n)
                          ? Math.min(90, Math.max(5, Math.round(n)))
                          : 30,
                      });
                    }}
                    className="w-20 rounded-[6px] border border-[#6E655E] bg-[#0A0908] px-2 py-1 text-right font-mono text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-[8px] border border-[#282320] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <span className="text-[#B5AA9F]">Min free RAM (GB)</span>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={settings.ecoRamFreeGbs}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      onPatchSettings({
                        ecoRamFreeGbs: Number.isFinite(n)
                          ? Math.min(64, Math.max(1, Math.round(n)))
                          : 4,
                      });
                    }}
                    className="w-20 rounded-[6px] border border-[#6E655E] bg-[#0A0908] px-2 py-1 text-right font-mono text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                  />
                </label>
              </div>
            )}
            <ToggleRow
              label="Minimize to System Tray on Close"
              hint="Trims WebView working-set pages when hidden so idle RAM drops sharply."
              checked={settings.minimizeToTray}
              onChange={(v) => onPatchSettings({ minimizeToTray: v })}
            />
            <ToggleRow
              label="Autostart Replay Buffer on Launch"
              hint="Arms rolling replay buffer immediately when KAGE starts."
              checked={settings.autostartBuffer}
              onChange={(v) => onPatchSettings({ autostartBuffer: v })}
            />
            <ToggleRow
              label="Launch KAGE at Windows Startup"
              hint="Starts minimized in background ready for Alt+C and Alt+R."
              checked={settings.launchAtStartup}
              onChange={(v) => onPatchSettings({ launchAtStartup: v })}
            />
            <ToggleRow
              label="Keep Deck Always on Top"
              hint="Pins the KAGE Studio window above normal desktop windows."
              checked={settings.alwaysOnTop}
              onChange={(v) => onPatchSettings({ alwaysOnTop: v })}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#282320] pt-3 text-xs text-[#94897E]">
            <span>KAGE Studio v2.0.3</span>
            <span>Local capture engine without cloud uploads or telemetry.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
