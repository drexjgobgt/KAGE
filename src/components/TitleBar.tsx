import { kage } from "../lib/bridge";
import { formatDuration } from "../lib/format";
import type { EngineStats } from "../lib/types";
import { IconClose, IconFolder, IconMaximize, IconMinimize } from "./Icons";

interface TitleBarProps {
  stats: EngineStats;
  minimizeToTray: boolean;
  onOpenFolder: () => void;
}

export function TitleBar({ stats, minimizeToTray, onOpenFolder }: TitleBarProps) {
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const recovering = stats.state === "recovering" || stats.state === "starting";
  const failed = stats.state === "error";

  let pillLabel = "Standby";
  let dotClass = "bg-[#94897E]";
  let textClass = "text-[#B5AA9F]";
  let borderClass = "border-[#282320] bg-[#12100E]";

  if (stats.recording_active) {
    pillLabel = `REC ${formatDuration(stats.recording_seconds)}`;
    dotClass = "bg-[#FF6B6F]";
    textClass = "text-[#FF6B6F]";
    borderClass = "border-[#C92A32]/60 bg-[#241112]";
  } else if (stats.privacy_active) {
    pillLabel = "Privacy Pause";
    dotClass = "bg-[#F5B971]";
    textClass = "text-[#F5B971]";
    borderClass = "border-[#F5B971]/40 bg-[#1B1610]";
  } else if (armed) {
    pillLabel = `Armed ${Math.round(stats.buffered_seconds)}s`;
    dotClass = "bg-[#4ADE80]";
    textClass = "text-[#4ADE80]";
    borderClass = "border-[#4ADE80]/30 bg-[#101A14]";
  } else if (recovering) {
    pillLabel = stats.state === "starting" ? "Starting" : "Recovering";
    dotClass = "bg-[#F5B971]";
    textClass = "text-[#F5B971]";
    borderClass = "border-[#F5B971]/40 bg-[#1B1610]";
  } else if (failed) {
    pillLabel = "Engine Error";
    dotClass = "bg-[#FF6B6F]";
    textClass = "text-[#FF6B6F]";
    borderClass = "border-[#FF6B6F]/45 bg-[#241112]";
  }

  return (
    <header
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        if (e.buttons === 1) void kage.startDragging();
      }}
      className="drag-region flex h-[38px] shrink-0 items-center justify-between border-b border-[#282320] bg-[#0D0B0A] px-3"
    >
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-semibold tracking-[0.22em] text-[#B5AA9F] uppercase">
          KAGE Deck
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums ${borderClass} ${textClass}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
          {pillLabel}
        </span>
        {stats.encoder.hardware && (
          <span className="hidden sm:inline text-[11px] text-[#94897E] tabular-nums">
            {stats.width}x{stats.height} {stats.target_fps}fps
          </span>
        )}
      </div>

      <div className="no-drag flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenFolder}
          title="Open output folder"
          aria-label="Open output folder"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#282320] bg-[#12100E] px-2.5 text-[11px] font-medium text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4] transition-colors"
        >
          <IconFolder className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Clips Folder</span>
        </button>

        <button
          type="button"
          onClick={() => void kage.minimize()}
          title="Minimize window"
          aria-label="Minimize window"
          className="grid h-7 w-7 place-items-center rounded-md text-[#B5AA9F] hover:bg-[#1A1715] hover:text-[#F3ECE4] transition-colors"
        >
          <IconMinimize />
        </button>

        <button
          type="button"
          onClick={() => void kage.toggleMaximize()}
          title="Maximize or restore window"
          aria-label="Maximize or restore window"
          className="grid h-7 w-7 place-items-center rounded-md text-[#B5AA9F] hover:bg-[#1A1715] hover:text-[#F3ECE4] transition-colors"
        >
          <IconMaximize />
        </button>

        <button
          type="button"
          onClick={() => void (minimizeToTray ? kage.hideToTray() : kage.quit())}
          title={minimizeToTray ? "Hide to system tray" : "Quit KAGE"}
          aria-label={minimizeToTray ? "Hide to system tray" : "Quit KAGE"}
          className="grid h-7 w-7 place-items-center rounded-md text-[#B5AA9F] hover:bg-[#C92A32] hover:text-white transition-colors"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
