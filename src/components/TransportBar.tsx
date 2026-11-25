import { formatBytes, formatDuration } from "../lib/format";
import type { AppSettings, EngineStats } from "../lib/types";
import { IconRecordDot, IconSave, IconStopSquare } from "./Icons";

interface TransportBarProps {
  stats: EngineStats;
  settings: AppSettings;
  busy: boolean;
  onSaveReplay: () => void;
  onToggleRecord: () => void;
  onToggleBuffer: () => void;
}

export function TransportBar({
  stats,
  settings,
  busy,
  onSaveReplay,
  onToggleRecord,
  onToggleBuffer,
}: TransportBarProps) {
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const recording = stats.recording_active;
  const fillPct =
    stats.buffer_seconds > 0
      ? Math.min(100, Math.round((stats.buffered_seconds / stats.buffer_seconds) * 100))
      : 0;

  return (
    <footer className="flex h-[68px] shrink-0 items-center justify-between gap-4 border-t border-[#282320] bg-[#0D0B0A] px-4">
      {/* Left: Buffer & Recording Live Readout */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 text-xs font-medium text-[#F3ECE4]">
            <span
              className={`h-2 w-2 rounded-full ${
                recording
                  ? "bg-[#FF6B6F]"
                  : armed
                    ? "bg-[#4ADE80]"
                    : "bg-[#94897E]"
              }`}
            />
            {recording ? (
              <span className="text-[#FF6B6F] tabular-nums">
                REC {formatDuration(stats.recording_seconds)} ({formatBytes(stats.recording_bytes)})
              </span>
            ) : armed ? (
              <span className="tabular-nums">
                Buffer {Math.round(stats.buffered_seconds)}s / {stats.buffer_seconds}s ({fillPct}%)
              </span>
            ) : (
              <span className="text-[#B5AA9F]">Replay Buffer Disarmed</span>
            )}
          </div>
          <div className="mt-1 hidden md:flex items-center gap-2 text-[11px] text-[#94897E] tabular-nums">
            <span>{stats.capture_fps.toFixed(0)} fps</span>
            <span aria-hidden="true">/</span>
            <span>{(stats.bitrate_kbps / 1000).toFixed(0)} Mbps</span>
            <span aria-hidden="true">/</span>
            <span>Ring {formatBytes(stats.ring_bytes)}</span>
          </div>
        </div>
      </div>

      {/* Center: Primary Actions (Champagne Save Replay + Tactical Alt+R REC + Arm) */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          disabled={busy || !armed || stats.buffered_seconds < 0.5}
          onClick={onSaveReplay}
          className="inline-flex items-center gap-2 rounded-full bg-[#E6C29F] px-5 py-2 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:bg-[#282320] disabled:text-[#94897E] transition-colors"
        >
          <IconSave className="h-3.5 w-3.5" />
          <span>Save Replay</span>
          <kbd className="rounded bg-[#0A0908]/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold">
            {settings.hotkeySave}
          </kbd>
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={onToggleRecord}
          className={`kage-rec-btn inline-flex items-center gap-2 border px-3.5 py-2 text-xs font-semibold transition-colors ${
            recording
              ? "border-[#FF6B6F] bg-[#C92A32] text-white hover:bg-[#D9363E]"
              : "border-[#C92A32]/70 bg-[#1A1212] text-[#FF6B6F] hover:border-[#FF6B6F] hover:bg-[#261617]"
          } disabled:opacity-50`}
        >
          {recording ? <IconStopSquare /> : <IconRecordDot />}
          <span>{recording ? "STOP REC" : "REC"}</span>
          <kbd
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              recording ? "bg-black/25 text-white" : "bg-[#12100E] text-[#F3ECE4] border border-[#282320]"
            }`}
          >
            {settings.hotkeyRecord}
          </kbd>
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={onToggleBuffer}
          className="rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-2 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] hover:bg-[#1A1715] disabled:opacity-50 transition-colors"
        >
          {armed ? "Disarm" : "Arm"}
          <kbd className="ml-2 hidden lg:inline rounded border border-[#282320] bg-[#0D0B0A] px-1.5 py-0.5 font-mono text-[10px] text-[#B5AA9F]">
            {settings.hotkeyToggle}
          </kbd>
        </button>
      </div>
    </footer>
  );
}
