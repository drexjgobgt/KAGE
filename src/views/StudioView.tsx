import type { CSSProperties } from "react";
import { formatBytes, formatDuration } from "../lib/format";
import type { AppSettings, ClipMetadata, EngineStats } from "../lib/types";
import { VENDOR_LABEL } from "../lib/types";
import GalleryGrid from "../components/GalleryGrid";
import {
  IconMic,
  IconRecordDot,
  IconSave,
  IconScissors,
  IconStopSquare,
  IconVolume,
} from "../components/Icons";

interface StudioViewProps {
  stats: EngineStats;
  settings: AppSettings;
  clips: ClipMetadata[];
  clipsLoading: boolean;
  clipsError: string | null;
  diskFreeBytes: number | null;
  busy: boolean;
  sessionSaves: number;
  sessionBytes: number;
  onSaveReplay: (maxSeconds?: number) => void;
  onToggleRecord: () => void;
  onToggleBuffer: () => void;
  onPatchSettings: (patch: Partial<AppSettings>) => void;
  onOpenClip: (clip: ClipMetadata) => void;
  onCopyClip: (clip: ClipMetadata) => void;
  onRevealClip: (clip: ClipMetadata) => void;
  onOpenExternalClip: (clip: ClipMetadata) => void;
  onDeleteClip: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
  onOpenLibrary: () => void;
  onImportVideo: () => void;
  onRetryClips: () => void;
}

const QUICK_DURATIONS = [15, 30, 60] as const;

export function StudioView({
  stats,
  settings,
  clips,
  clipsLoading,
  clipsError,
  diskFreeBytes,
  busy,
  sessionSaves,
  sessionBytes,
  onSaveReplay,
  onToggleRecord,
  onToggleBuffer,
  onPatchSettings,
  onOpenClip,
  onCopyClip,
  onRevealClip,
  onOpenExternalClip,
  onDeleteClip,
  onToggleFavorite,
  onOpenLibrary,
  onImportVideo,
  onRetryClips,
}: StudioViewProps) {
  const armed =
    (stats.state === "buffering" || stats.state === "flushing") &&
    stats.ring_enabled;
  const recording = stats.recording_active;
  const fillScale =
    stats.buffer_seconds > 0
      ? Math.min(1, Math.max(0, stats.buffered_seconds / stats.buffer_seconds))
      : 0;
  const fillPct = Math.round(fillScale * 100);

  let heroTitle = "Capture Deck Standby";
  let heroSubtitle = `Press ${settings.hotkeyToggle} to arm the ${settings.bufferSeconds}s shadow buffer, or ${settings.hotkeyRecord} for direct MP4 capture.`;

  if (recording && armed) {
    heroTitle = "Recording + Shadow Replay";
    heroSubtitle = `Direct MP4 stream (${formatDuration(stats.recording_seconds)}) alongside live ${settings.bufferSeconds}s rolling buffer at ${stats.capture_fps.toFixed(0)} fps.`;
  } else if (recording) {
    heroTitle = "Direct MP4 Recording";
    heroSubtitle = `Streaming directly to disk (${formatBytes(stats.recording_bytes)} written) with 0 MB shadow ring RAM.`;
  } else if (stats.privacy_active) {
    heroTitle = "Privacy Gate Active";
    heroSubtitle = "Rolling history cleared while Windows desktop or KAGE Studio holds focus.";
  } else if (armed) {
    heroTitle = "Shadow Buffer Armed";
    heroSubtitle = `${formatDuration(stats.buffered_seconds)} cached across ${stats.ring_frames} packets (${formatBytes(stats.ring_bytes)} RAM, ${stats.capture_fps.toFixed(1)} fps).`;
  } else if (stats.state === "recovering") {
    heroTitle = "Recovering Capture Session";
    heroSubtitle = "Reacquiring DXGI desktop duplication after display mode or adapter reset.";
  } else if (stats.state === "error") {
    heroTitle = "Capture Pipeline Fault";
    heroSubtitle = stats.last_error || "Open Signal Flow Telemetry for adapter or encoder details.";
  }

  const encoderLabel =
    stats.state === "idle" && stats.encoder.vendor === "unavailable"
      ? "Standby"
      : `${VENDOR_LABEL[stats.encoder.vendor]} ${stats.encoder.codec}`;

  const gameGainPct = Math.min(100, Math.max(0, Math.round(settings.gameVolume)));
  const micGainPct = Math.min(100, Math.max(0, Math.round(settings.micVolume)));
  const recentClips = clips.slice(0, 4);

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Hero Double-Bezel Capture Deck with Diagonal Shutter Cut */}
      <section aria-label="Capture Deck" className="bezel-outer">
        <div className="bezel-inner kage-slash p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]">
                <span className="text-[#E6C29F]">{encoderLabel}</span>
                {stats.width > 0 && stats.height > 0 && (
                  <>
                    <span className="text-[#6E655E]">/</span>
                    <span className="text-[#B5AA9F] tabular-nums">
                      {stats.width}x{stats.height} {stats.target_fps}fps
                    </span>
                  </>
                )}
                <span className="text-[#6E655E]">/</span>
                <span className="text-[#B5AA9F] tabular-nums">
                  {(stats.bitrate_kbps / 1000).toFixed(0)} Mbps
                </span>
              </div>

              <h1 className="font-display mt-2 text-[42px] leading-[1.06] tracking-[-0.01em] text-[#F3ECE4]">
                {heroTitle}
              </h1>
              <p className="mt-2 text-[13px] leading-relaxed text-[#B5AA9F]">
                {heroSubtitle}
              </p>
            </div>

            {/* Session Stats Pill */}
            <div className="rounded-[12px] border border-[#282320] bg-[#0D0B0A] px-4 py-3 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#94897E]">
                This Session
              </div>
              <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-[#F3ECE4]">
                {sessionSaves} saved ({formatBytes(sessionBytes)})
              </div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#B5AA9F]">
                {diskFreeBytes !== null ? `${formatBytes(diskFreeBytes)} free` : "Disk telemetry pending"}
              </div>
            </div>
          </div>

          {/* Distinct Mode Cards: Rolling Replay Window vs Direct MP4 Recording */}
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {/* Rolling Replay Buffer Card */}
            <div className="flex flex-col justify-between gap-3 rounded-[10px] border border-[#282320] bg-[#0D0B0A] p-4">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[#B5AA9F]">Rolling Replay Window</span>
                  <span className="font-mono tabular-nums text-[#F3ECE4]">
                    {formatDuration(stats.buffered_seconds)} / {formatDuration(stats.buffer_seconds)} ({fillPct}%)
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#1A1715] border border-[#282320]">
                  <div
                    className="h-full w-full origin-left rounded-full bg-[#E6C29F] transition-transform duration-200"
                    style={{
                      transform: `scaleX(${armed ? Math.max(0.03, fillScale) : 0})`,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-[#94897E]">
                  <span>Ring RAM: {formatBytes(stats.ring_bytes)}</span>
                  <span>Capture: {stats.capture_fps.toFixed(1)} fps</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#282320]">
                <button
                  type="button"
                  disabled={busy || !armed || stats.buffered_seconds < 0.5}
                  onClick={() => onSaveReplay()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:bg-[#282320] disabled:text-[#94897E] transition-colors"
                >
                  <IconSave className="h-3.5 w-3.5" />
                  <span>Save Full</span>
                  <kbd className="rounded bg-[#0A0908]/15 px-1.5 py-0.5 font-mono text-[10px]">
                    {settings.hotkeySave}
                  </kbd>
                </button>

                {QUICK_DURATIONS.filter((sec) => sec < settings.bufferSeconds).map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    disabled={busy || !armed || stats.buffered_seconds < 1}
                    onClick={() => onSaveReplay(sec)}
                    className="rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-2.5 py-1.5 text-xs font-medium tabular-nums text-[#F3ECE4] hover:border-[#E6C29F] disabled:opacity-45 transition-colors"
                  >
                    Last {sec}s
                  </button>
                ))}

                <button
                  type="button"
                  disabled={busy}
                  onClick={onToggleBuffer}
                  className="ml-auto rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] hover:bg-[#1A1715] disabled:opacity-50 transition-colors"
                >
                  {armed ? "Disarm" : "Arm"}
                </button>
              </div>
            </div>

            {/* Direct MP4 Recording Card */}
            <div
              className={`flex flex-col justify-between gap-3 rounded-[10px] border p-4 ${
                recording
                  ? "border-[#C92A32]/70 bg-[#1B1011]"
                  : "border-[#282320] bg-[#0D0B0A]"
              }`}
            >
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className={recording ? "font-semibold text-[#FF6B6F]" : "font-medium text-[#B5AA9F]"}>
                    Direct MP4 Recording
                  </span>
                  <span className="font-mono tabular-nums text-[#F3ECE4]">
                    {recording
                      ? `${formatDuration(stats.recording_seconds)} (${formatBytes(stats.recording_bytes)})`
                      : `Shortcut ${settings.hotkeyRecord}`}
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#1A1715] border border-[#282320]">
                  <div
                    className="h-full w-full origin-left rounded-full bg-[#C92A32] transition-transform duration-200"
                    style={{ transform: `scaleX(${recording ? 1 : 0})` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums text-[#94897E]">
                  <span className="min-w-0 truncate" title={stats.recording_path ?? ""}>
                    {recording && stats.recording_path
                      ? stats.recording_path
                      : "Writes directly to disk with 0 ring RAM"}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">
                    {(stats.bitrate_kbps / 1000).toFixed(0)} Mbps
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#282320]">
                <span className="text-[11px] text-[#B5AA9F]">
                  {recording
                    ? stats.ring_enabled
                      ? "Sharing encoder with Replay Buffer"
                      : "Direct-Only mode active"
                    : "Works from Idle or while Armed"}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onToggleRecord}
                  className={`kage-rec-btn inline-flex items-center gap-2 border px-4 py-1.5 text-xs font-semibold transition-colors ${
                    recording
                      ? "border-[#FF6B6F] bg-[#C92A32] text-white hover:bg-[#D9363E]"
                      : "border-[#C92A32]/75 bg-[#1A1212] text-[#FF6B6F] hover:border-[#FF6B6F] hover:bg-[#261617]"
                  } disabled:opacity-50`}
                >
                  {recording ? <IconStopSquare /> : <IconRecordDot />}
                  <span>{recording ? "Stop Recording" : "Start Recording"}</span>
                  <kbd
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      recording ? "bg-black/25 text-white" : "border border-[#282320] bg-[#12100E] text-[#F3ECE4]"
                    }`}
                  >
                    {settings.hotkeyRecord}
                  </kbd>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Audio Mixer Row */}
      <section aria-label="Audio Mix and Footprint" className="bezel-outer">
        <div className="bezel-inner grid gap-4 p-4 md:grid-cols-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onPatchSettings({ captureSystemAudio: !settings.captureSystemAudio })}
              aria-label={settings.captureSystemAudio ? "Mute game audio capture" : "Enable game audio capture"}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border transition-colors ${
                settings.captureSystemAudio
                  ? "border-[#E6C29F]/70 bg-[#1A1715] text-[#E6C29F]"
                  : "border-[#6E655E] bg-[#0D0B0A] text-[#94897E]"
              }`}
            >
              <IconVolume muted={!settings.captureSystemAudio} />
            </button>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[#F3ECE4]">Game Audio</span>
                <span className="font-mono tabular-nums text-[#B5AA9F]">
                  {settings.captureSystemAudio ? `${gameGainPct}%` : "Muted"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={gameGainPct}
                style={{ "--range-pct": `${gameGainPct}%` } as CSSProperties}
                disabled={!settings.captureSystemAudio}
                onChange={(e) => onPatchSettings({ gameVolume: Number(e.target.value) })}
                aria-label="Game audio gain"
                className="kage-range mt-2 w-full"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onPatchSettings({ captureMicrophone: !settings.captureMicrophone })}
              aria-label={settings.captureMicrophone ? "Disable microphone capture" : "Enable microphone capture"}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border transition-colors ${
                settings.captureMicrophone
                  ? "border-[#E6C29F]/70 bg-[#1A1715] text-[#E6C29F]"
                  : "border-[#6E655E] bg-[#0D0B0A] text-[#94897E]"
              }`}
            >
              <IconMic muted={!settings.captureMicrophone} />
            </button>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[#F3ECE4]">Microphone</span>
                <span className="font-mono tabular-nums text-[#B5AA9F]">
                  {settings.captureMicrophone ? `${micGainPct}%` : "Off"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={micGainPct}
                style={{ "--range-pct": `${micGainPct}%` } as CSSProperties}
                disabled={!settings.captureMicrophone}
                onChange={(e) => onPatchSettings({ micVolume: Number(e.target.value) })}
                aria-label="Microphone gain"
                className="kage-range mt-2 w-full"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Recent Captures */}
      <section aria-label="Recent Captures" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-2xl text-[#F3ECE4]">Recent Captures</h2>
            <p className="text-xs text-[#94897E]">
              Open any clip or drag and drop an MP4 or MOV file to trim exact Start and End times
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onImportVideo}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#E6C29F]/60 bg-[#241D15] px-3 py-1.5 text-xs font-medium text-[#E6C29F] hover:border-[#E6C29F]"
            >
              <IconScissors className="h-3.5 w-3.5" />
              <span>Trim Video File</span>
            </button>
            {clips.length > 4 && (
              <button
                type="button"
                onClick={onOpenLibrary}
                className="rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#E6C29F] hover:border-[#E6C29F]"
              >
                View All ({clips.length})
              </button>
            )}
          </div>
        </div>

        {clipsError ? (
          <div className="bezel-outer">
            <div className="bezel-inner flex items-center justify-between gap-4 p-5">
              <div>
                <div className="text-sm font-semibold text-[#FF6B6F]">
                  Could not load recent clips
                </div>
                <p className="mt-1 text-xs text-[#B5AA9F]">{clipsError}</p>
              </div>
              <button
                type="button"
                onClick={onRetryClips}
                className="rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4]"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <GalleryGrid
            clips={recentClips}
            loading={clipsLoading}
            compact
            hotkeySave={settings.hotkeySave}
            hotkeyRecord={settings.hotkeyRecord}
            onOpen={onOpenClip}
            onSelect={() => {}}
            onCopy={onCopyClip}
            onReveal={onRevealClip}
            onOpenExternal={onOpenExternalClip}
            onDelete={onDeleteClip}
            onToggleFavorite={onToggleFavorite}
          />
        )}
      </section>
    </div>
  );
}
