import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { kage } from "../lib/bridge";
import { formatBytes, formatDuration } from "../lib/format";
import type { ClipMetadata } from "../lib/types";
import {
  IconCamera,
  IconClose,
  IconCopy,
  IconExternal,
  IconPause,
  IconPlay,
  IconPlus,
  IconScissors,
  IconSearch,
  IconStar,
  IconTrash,
} from "./Icons";

interface Props {
  clip: ClipMetadata;
  flushMs?: number;
  onClose: () => void;
  onTrimSaved: () => void;
  onDeleted: (clip: ClipMetadata) => void;
  onRenamed: (oldPath: string, next: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
  onUpdateTags: (clip: ClipMetadata, tags: string[]) => void;
  onToast: (kind: "ok" | "err" | "warn" | "info", title: string, detail?: string) => void;
}

export function ClipTrimmerModal({
  clip,
  flushMs,
  onClose,
  onTrimSaved,
  onDeleted,
  onRenamed,
  onToggleFavorite,
  onUpdateTags,
  onToast,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [title, setTitle] = useState(clip.title);
  const [duration, setDuration] = useState(Math.max(0.5, clip.duration_seconds));
  const [playhead, setPlayhead] = useState(0);
  const [inTime, setInTime] = useState(0);
  const [outTime, setOutTime] = useState(Math.max(0.5, clip.duration_seconds));
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | undefined>(clip.preview_url);
  const [newTag, setNewTag] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(clip.title);
    const d = Math.max(0.5, clip.duration_seconds);
    setDuration(d);
    setPlayhead(0);
    setInTime(0);
    setOutTime(d);
    setVideoSrc(clip.preview_url);
    setConfirmDelete(false);
  }, [clip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimSpan = useMemo(() => Math.max(0.5, outTime - inTime), [inTime, outTime]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (v.paused) {
      if (v.currentTime < inTime || v.currentTime >= outTime) {
        v.currentTime = inTime;
      }
      void v.play();
    } else {
      v.pause();
    }
  };

  const handleRename = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === clip.title) return;
    setBusy(true);
    try {
      const newPath = await kage.renameClip(clip.path, trimmed);
      const updated: ClipMetadata = {
        ...clip,
        path: newPath,
        file_name: newPath.split(/[/\\]/).pop() || clip.file_name,
        title: trimmed,
      };
      onRenamed(clip.path, updated);
      onToast("ok", "Clip renamed", updated.file_name);
    } catch (e) {
      onToast("err", "Rename failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleTrim = async (overwrite: boolean) => {
    if (outTime - inTime < 0.25) {
      onToast("warn", "Trim span too short", "Select at least 0.25s between In and Out.");
      return;
    }
    setBusy(true);
    try {
      // Release the Windows file handle held by <video> before overwrite replaces the MP4.
      if (overwrite && videoRef.current) {
        videoRef.current.pause();
        setVideoSrc(undefined);
        await new Promise((r) => setTimeout(r, 80));
      }
      const res = await kage.trimClip(clip.path, inTime, outTime, overwrite);
      onToast(
        "ok",
        overwrite ? "Clip overwritten losslessly" : "Trimmed copy saved",
        `${res.file_name} (${formatDuration(res.duration_seconds)}, ${res.elapsed_ms.toFixed(0)} ms)`,
      );
      onTrimSaved();
      onClose();
    } catch (e) {
      setVideoSrc(clip.preview_url);
      onToast("err", "Trim failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSplit = async () => {
    const at = Math.min(Math.max(0.3, playhead), Math.max(0.3, duration - 0.3));
    setBusy(true);
    try {
      const res = await kage.splitClip(clip.path, at);
      onToast(
        "ok",
        "Clip split into two parts",
        `${res.partA.file_name} and ${res.partB.file_name}`,
      );
      onTrimSaved();
      onClose();
    } catch (e) {
      onToast("err", "Split failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSnapshot = async () => {
    setBusy(true);
    try {
      const pngB64 = await kage.extractFramePng(clip.path, playhead, 1920);
      if (!pngB64) {
        onToast("info", "Frame snapshot unavailable", "Browser preview has no local video frame decoder.");
        return;
      }
      const savedPath = await kage.snapshotToOutput(pngB64, clip.title);
      onToast("ok", "PNG frame snapshot saved", savedPath);
    } catch (e) {
      onToast("err", "Snapshot failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAddTag = () => {
    const clean = newTag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!clean) return;
    if (clip.tags.includes(clean)) {
      setNewTag("");
      return;
    }
    onUpdateTags(clip, [...clip.tags, clean].slice(0, 8));
    setNewTag("");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kage-trimmer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0A0908]/80 backdrop-blur-md p-4 animate-pop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bezel-outer w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="bezel-inner flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-[#282320] px-5 py-3.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <input
                id="kage-trimmer-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void handleRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                aria-label="Clip title"
                className="min-w-0 flex-1 rounded-[8px] border border-transparent bg-transparent px-2 py-1 font-display text-2xl text-[#F3ECE4] hover:border-[#282320] focus:border-[#E6C29F] focus:bg-[#0A0908] focus:outline-none"
              />
              {flushMs !== undefined && (
                <span className="shrink-0 rounded-[6px] border border-[#4ADE80]/30 bg-[#101A14] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[#4ADE80]">
                  Saved in {flushMs.toFixed(1)} ms
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onToggleFavorite(clip)}
                aria-label={clip.favorite ? "Remove from favourites" : "Add to favourites"}
                className={`grid h-8 w-8 place-items-center rounded-[8px] border transition-colors ${
                  clip.favorite
                    ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                    : "border-[#282320] bg-[#1A1715] text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4]"
                }`}
              >
                <IconStar filled={clip.favorite} />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close trimmer"
                className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#282320] bg-[#1A1715] text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4]"
              >
                <IconClose />
              </button>
            </div>
          </div>

          {/* Video viewport */}
          <div className="relative bg-[#0A0908] aspect-video max-h-[240px] w-full flex items-center justify-center border-b border-[#282320]">
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                playsInline
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0) {
                    setDuration(d);
                    setOutTime(d);
                  }
                }}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setPlayhead(t);
                  if (t >= outTime && !e.currentTarget.paused) {
                    e.currentTarget.pause();
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlay}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-center px-6">
                <div className="font-display text-2xl text-[#F3ECE4]">{clip.title}</div>
                <div className="font-mono text-xs tabular-nums text-[#94897E]">
                  {clip.width}x{clip.height} at {clip.fps}fps / {formatDuration(duration)} / {formatBytes(clip.size_bytes)}
                </div>
                <p className="max-w-sm text-xs text-[#B5AA9F]">
                  Simulated preview clip. Use In and Out controls below to test lossless trimming and splitting.
                </p>
              </div>
            )}
          </div>

          {/* Scrubber & Trim Range */}
          <div className="flex flex-col gap-3 p-4 overflow-y-auto">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between font-mono text-xs tabular-nums text-[#B5AA9F]">
                <span>Playhead: {formatDuration(playhead)}</span>
                <span>
                  Range: {formatDuration(inTime)} to {formatDuration(outTime)} ({formatDuration(trimSpan)} selected)
                </span>
              </div>

              {/* Playhead scrubber */}
              <input
                type="range"
                min={0}
                max={duration}
                step={0.05}
                value={Math.min(playhead, duration)}
                style={{
                  "--range-pct": `${duration > 0 ? Math.min(100, (playhead / duration) * 100) : 0}%`,
                } as CSSProperties}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setPlayhead(next);
                  if (videoRef.current) videoRef.current.currentTime = next;
                }}
                aria-label="Playhead position"
                className="kage-range w-full"
              />

              {/* In / Out controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <label className="flex items-center gap-2 rounded-[8px] border border-[#282320] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <span className="w-12 font-mono text-[#94897E]">IN</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, outTime - 0.3)}
                    step={0.05}
                    value={inTime}
                    style={{
                      "--range-pct": `${outTime > 0.3 ? Math.min(100, (inTime / Math.max(0.1, outTime - 0.3)) * 100) : 0}%`,
                    } as CSSProperties}
                    onChange={(e) => setInTime(Number(e.target.value))}
                    className="kage-range flex-1"
                  />
                  <span className="w-14 text-right font-mono tabular-nums text-[#F3ECE4]">
                    {formatDuration(inTime)}
                  </span>
                </label>

                <label className="flex items-center gap-2 rounded-[8px] border border-[#282320] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <span className="w-12 font-mono text-[#94897E]">OUT</span>
                  <input
                    type="range"
                    min={Math.min(duration, inTime + 0.3)}
                    max={duration}
                    step={0.05}
                    value={outTime}
                    style={{
                      "--range-pct": `${duration - (inTime + 0.3) > 0 ? Math.min(100, ((outTime - Math.min(duration, inTime + 0.3)) / (duration - Math.min(duration, inTime + 0.3))) * 100) : 100}%`,
                    } as CSSProperties}
                    onChange={(e) => setOutTime(Number(e.target.value))}
                    className="kage-range flex-1"
                  />
                  <span className="w-14 text-right font-mono tabular-nums text-[#F3ECE4]">
                    {formatDuration(outTime)}
                  </span>
                </label>
              </div>
            </div>

            {/* Tags row */}
            <div className="flex flex-wrap items-center gap-2 border-y border-[#282320] py-3">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[#94897E]">
                Tags
              </span>
              {clip.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onUpdateTags(clip, clip.tags.filter((x) => x !== t))}
                  title={`Remove #${t}`}
                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#282320] bg-[#1A1715] px-2 py-0.5 font-mono text-[11px] text-[#E6C29F] hover:border-[#C92A32] hover:text-[#FF6B6F]"
                >
                  <span>#{t}</span>
                  <span aria-hidden="true">x</span>
                </button>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAddTag();
                }}
                className="inline-flex items-center gap-1"
              >
                <input
                  type="text"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="Add tag..."
                  maxLength={24}
                  aria-label="New clip tag"
                  className="w-28 rounded-[6px] border border-[#282320] bg-[#0A0908] px-2 py-1 text-xs text-[#F3ECE4] placeholder:text-[#94897E] focus:border-[#E6C29F] focus:outline-none"
                />
                <button
                  type="submit"
                  aria-label="Add tag"
                  className="grid h-7 w-7 place-items-center rounded-[6px] border border-[#6E655E] bg-[#1A1715] text-[#F3ECE4] hover:border-[#E6C29F]"
                >
                  <IconPlus className="h-3.5 w-3.5" />
                </button>
              </form>
            </div>

            {/* Bottom Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {videoSrc && (
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F]"
                  >
                    {playing ? <IconPause /> : <IconPlay />}
                    <span>{playing ? "Pause" : "Play"}</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSplit()}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] disabled:opacity-50"
                >
                  <IconScissors className="h-3.5 w-3.5" />
                  <span>Split at Playhead</span>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSnapshot()}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] disabled:opacity-50"
                >
                  <IconCamera className="h-3.5 w-3.5" />
                  <span>PNG Frame</span>
                </button>

                <button
                  type="button"
                  onClick={() => void kage.copyClip(clip.path).then(() => onToast("ok", "Copied to clipboard", clip.file_name))}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#282320] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4]"
                >
                  <IconCopy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </button>

                <button
                  type="button"
                  onClick={() => void kage.revealClip(clip.path)}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#282320] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4]"
                >
                  <IconSearch className="h-3.5 w-3.5" />
                  <span>Explorer</span>
                </button>

                <button
                  type="button"
                  onClick={() => void kage.openClip(clip.path)}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#282320] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#6E655E] hover:text-[#F3ECE4]"
                >
                  <IconExternal className="h-3.5 w-3.5" />
                  <span>Player</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!confirmDelete ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#C92A32]/50 bg-[#1A1011] px-3 py-1.5 text-xs font-medium text-[#FF6B6F] hover:border-[#FF6B6F]"
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                    <span>Delete</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDeleted(clip)}
                    className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#C92A32] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#D9363E]"
                  >
                    Confirm Delete
                  </button>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTrim(true)}
                  className="rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3.5 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] disabled:opacity-50"
                >
                  Overwrite Original
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTrim(false)}
                  className="rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:bg-[#282320] disabled:text-[#94897E]"
                >
                  Save Trimmed Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
