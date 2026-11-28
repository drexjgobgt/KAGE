import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, kage } from "../lib/bridge";
import { clamp, formatBytes, formatDuration, formatTimecode, parseTimecode } from "../lib/format";
import { deleteCachedThumbnail } from "../lib/thumbCache";
import type { ClipMetadata } from "../lib/types";
import {
  IconCamera,
  IconClose,
  IconCopy,
  IconExternal,
  IconFolder,
  IconPause,
  IconPlay,
  IconPlus,
  IconScissors,
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

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const MIN_SPAN_SECONDS = 0.25;

function resolveVideoSrc(clip: ClipMetadata): string | undefined {
  return clip.preview_url ?? (kage.isTauri() ? assetUrl(clip.path) : undefined);
}

type DragTarget = "playhead" | "start" | "end";

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
  const native = kage.isTauri();
  const isExternal = Boolean(clip.external);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeDragRef = useRef<DragTarget | null>(null);

  const [title, setTitle] = useState(clip.title);
  const [duration, setDuration] = useState(Math.max(0.5, clip.duration_seconds));
  const [playhead, setPlayhead] = useState(0);
  const [inTime, setInTime] = useState(0);
  const [outTime, setOutTime] = useState(Math.max(0.5, clip.duration_seconds));
  const [inDraft, setInDraft] = useState(() => formatTimecode(0));
  const [outDraft, setOutDraft] = useState(() =>
    formatTimecode(Math.max(0.5, clip.duration_seconds)),
  );
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | undefined>(() => resolveVideoSrc(clip));
  const [newTag, setNewTag] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [replaceExternal, setReplaceExternal] = useState(false);

  useEffect(() => {
    setTitle(clip.title);
    const d = Math.max(0.5, clip.duration_seconds);
    setDuration(d);
    setPlayhead(0);
    setInTime(0);
    setOutTime(d);
    setInDraft(formatTimecode(0));
    setOutDraft(formatTimecode(d));
    setVideoSrc(resolveVideoSrc(clip));
    setConfirmDelete(false);
    setKeepOriginal(false);
    setReplaceExternal(false);
  }, [clip]);

  useEffect(() => {
    setInDraft(formatTimecode(inTime));
  }, [inTime]);

  useEffect(() => {
    setOutDraft(formatTimecode(outTime));
  }, [outTime]);

  // Free native media decoder memory and blob object URLs on unmount or clip switch.
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      if (clip.external && clip.preview_url?.startsWith("blob:")) {
        URL.revokeObjectURL(clip.preview_url);
      }
    };
  }, [clip]);

  const seekVideoTo = useCallback(
    (time: number) => {
      const clamped = clamp(time, 0, duration);
      setPlayhead(clamped);
      if (videoRef.current) {
        videoRef.current.currentTime = clamped;
      }
    },
    [duration],
  );

  const applyInTime = useCallback(
    (next: number, seek = true) => {
      const clamped = clamp(next, 0, Math.max(0, outTime - MIN_SPAN_SECONDS));
      setInTime(clamped);
      setInDraft(formatTimecode(clamped));
      if (seek) seekVideoTo(clamped);
    },
    [outTime, seekVideoTo],
  );

  const applyOutTime = useCallback(
    (next: number, seek = true) => {
      const clamped = clamp(next, Math.min(duration, inTime + MIN_SPAN_SECONDS), duration);
      setOutTime(clamped);
      setOutDraft(formatTimecode(clamped));
      if (seek) seekVideoTo(clamped);
    },
    [duration, inTime, seekVideoTo],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (v.paused) {
      if (v.currentTime < inTime || v.currentTime >= outTime) {
        v.currentTime = inTime;
        setPlayhead(inTime);
      }
      void v.play();
    } else {
      v.pause();
    }
  }, [inTime, outTime, videoSrc]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const nodes = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        applyInTime(playhead, false);
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        applyOutTime(playhead, false);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekVideoTo(playhead - (e.shiftKey ? 0.1 : 0.5));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekVideoTo(playhead + (e.shiftKey ? 0.1 : 0.5));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [applyInTime, applyOutTime, onClose, playhead, seekVideoTo, togglePlay]);

  const trimSpan = useMemo(() => Math.max(0.25, outTime - inTime), [inTime, outTime]);
  const inPct = duration > 0 ? clamp((inTime / duration) * 100, 0, 100) : 0;
  const outPct = duration > 0 ? clamp((outTime / duration) * 100, 0, 100) : 100;
  const playPct = duration > 0 ? clamp((playhead / duration) * 100, 0, 100) : 0;

  const clientXToTime = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round(ratio * duration * 20) / 20;
  };

  const handleTrackPointerMove = (clientX: number) => {
    const target = activeDragRef.current;
    if (!target) return;
    const t = clientXToTime(clientX);
    if (target === "start") {
      applyInTime(t, true);
    } else if (target === "end") {
      applyOutTime(t, true);
    } else {
      seekVideoTo(t);
    }
  };

  const commitInDraft = () => {
    const parsed = parseTimecode(inDraft);
    if (parsed === null) {
      setInDraft(formatTimecode(inTime));
      return;
    }
    applyInTime(parsed, true);
  };

  const commitOutDraft = () => {
    const parsed = parseTimecode(outDraft);
    if (parsed === null) {
      setOutDraft(formatTimecode(outTime));
      return;
    }
    applyOutTime(parsed, true);
  };

  const releaseVideoLock = async () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    setPlaying(false);
    setVideoSrc(undefined);
    await new Promise((r) => setTimeout(r, 120));
  };

  const handleRename = async () => {
    if (isExternal) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === clip.title) return;
    setBusy(true);
    try {
      await releaseVideoLock();
      const newPath = await kage.renameClip(clip.path, trimmed);
      deleteCachedThumbnail(clip.path);
      const updated: ClipMetadata = {
        ...clip,
        path: newPath,
        file_name: newPath.split(/[/\\]/).pop() || clip.file_name,
        title: trimmed,
      };
      setVideoSrc(resolveVideoSrc(updated));
      onRenamed(clip.path, updated);
      onToast("ok", "Clip renamed", updated.file_name);
    } catch (e) {
      setTitle(clip.title);
      setVideoSrc(resolveVideoSrc(clip));
      onToast("err", "Rename failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleTrim = async (overwrite: boolean, destInLibrary: boolean) => {
    if (outTime - inTime < MIN_SPAN_SECONDS) {
      onToast("warn", "Trim span too short", "Select at least 0.25s between Start and End.");
      return;
    }
    setBusy(true);
    try {
      if (overwrite) {
        await releaseVideoLock();
      }
      const res = await kage.trimClip(
        clip.path,
        inTime,
        outTime,
        overwrite,
        destInLibrary,
      );
      if (overwrite && !isExternal) {
        deleteCachedThumbnail(clip.path);
      }
      const toastTitle = destInLibrary
        ? "Trimmed video saved to library"
        : overwrite
          ? "Video trimmed (original replaced)"
          : "Trimmed copy saved";
      onToast(
        "ok",
        toastTitle,
        `${res.file_name} (${formatDuration(res.duration_seconds)}, ${res.elapsed_ms.toFixed(0)} ms)`,
      );
      onTrimSaved();
      onClose();
    } catch (e) {
      setVideoSrc(resolveVideoSrc(clip));
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

  const handleDelete = async () => {
    setBusy(true);
    try {
      await releaseVideoLock();
      onDeleted(clip);
    } finally {
      setBusy(false);
    }
  };

  const handleSnapshot = async () => {
    setBusy(true);
    try {
      const pngB64 = await kage.extractFramePng(clip.path, playhead, 0);
      if (!pngB64) {
        onToast("info", "Frame snapshot unavailable", "Preview stream has no local frame decoder.");
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

  const saveButtonLabel = isExternal
    ? replaceExternal
      ? "Replace Video"
      : "Save to Library"
    : keepOriginal
      ? "Save Trimmed Copy"
      : "Save Trim";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kage-trimmer-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0A0908]/80 backdrop-blur-md p-4 animate-pop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <h2 id="kage-trimmer-heading" className="sr-only">
        Clip Trimmer: {clip.title}
      </h2>

      <div className="bezel-outer w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="bezel-inner flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-[#282320] px-5 py-3.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {isExternal ? (
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="shrink-0 rounded-[6px] border border-[#E6C29F]/40 bg-[#241D15] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#E6C29F]">
                    External Video
                  </span>
                  <span className="truncate font-display text-2xl text-[#F3ECE4]" title={clip.path}>
                    {clip.title}
                  </span>
                </div>
              ) : (
                <input
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
                  className="min-w-0 flex-1 rounded-[8px] border border-transparent bg-transparent px-2 py-1 font-display text-2xl text-[#F3ECE4] hover:border-[#6E655E] focus:border-[#E6C29F] focus:bg-[#0A0908] focus:outline-none"
                />
              )}
              {flushMs !== undefined && (
                <span className="shrink-0 rounded-[6px] border border-[#4ADE80]/30 bg-[#101A14] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[#4ADE80]">
                  Saved in {flushMs.toFixed(1)} ms
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {!isExternal && (
                <button
                  type="button"
                  onClick={() => onToggleFavorite(clip)}
                  aria-label={clip.favorite ? "Remove from favorites" : "Add to favorites"}
                  className={`grid h-8 w-8 place-items-center rounded-[8px] border transition-colors ${
                    clip.favorite
                      ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                      : "border-[#6E655E] bg-[#1A1715] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                  }`}
                >
                  <IconStar filled={clip.favorite} />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close trimmer"
                className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#6E655E] bg-[#1A1715] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
              >
                <IconClose />
              </button>
            </div>
          </div>

          {/* Video viewport */}
          <div className="relative bg-[#0A0908] aspect-video max-h-[280px] w-full flex items-center justify-center border-b border-[#282320]">
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
                    setOutDraft(formatTimecode(d));
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
                  {native
                    ? "Preparing video stream..."
                    : "Browser preview ready. Use the Start and End timeline handles below to select your trim range."}
                </p>
              </div>
            )}
          </div>

          {/* Unified Interactive Timeline & Start / End Controls */}
          <div className="flex flex-col gap-3 p-4 overflow-y-auto">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs tabular-nums text-[#B5AA9F]">
                <span>Playhead: {formatTimecode(playhead)}</span>
                <span className="text-[#E6C29F]">
                  Keep: {formatTimecode(inTime)} to {formatTimecode(outTime)} ({formatTimecode(trimSpan)})
                </span>
                <span className="text-[#94897E]">Total: {formatTimecode(duration)}</span>
              </div>

              {/* Single-axis draggable visual timeline */}
              <div
                ref={trackRef}
                role="group"
                aria-label="Trim timeline"
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).dataset.handle) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  activeDragRef.current = "playhead";
                  handleTrackPointerMove(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (activeDragRef.current) {
                    handleTrackPointerMove(e.clientX);
                  }
                }}
                onPointerUp={() => {
                  activeDragRef.current = null;
                }}
                onPointerCancel={() => {
                  activeDragRef.current = null;
                }}
                className="relative h-10 w-full cursor-pointer select-none rounded-[8px] border border-[#6E655E] bg-[#0D0B0A] overflow-hidden touch-none"
              >
                {/* Cut-out before Start */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 bg-[#0A0908]/85"
                  style={{ width: `${inPct}%` }}
                />
                {/* Cut-out after End */}
                <div
                  className="pointer-events-none absolute inset-y-0 right-0 bg-[#0A0908]/85"
                  style={{ width: `${Math.max(0, 100 - outPct)}%` }}
                />
                {/* Active kept highlight band */}
                <div
                  className="pointer-events-none absolute inset-y-0 border-y-2 border-[#E6C29F] bg-[#E6C29F]/18"
                  style={{
                    left: `${inPct}%`,
                    width: `${Math.max(0.5, outPct - inPct)}%`,
                  }}
                />
                {/* Current playhead indicator */}
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#F3ECE4] shadow-[0_0_6px_rgba(243,236,228,0.85)]"
                  style={{ left: `calc(${playPct}% - 1px)` }}
                />

                {/* Start Handle */}
                <button
                  type="button"
                  data-handle="start"
                  aria-label="Drag trim start handle"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    activeDragRef.current = "start";
                  }}
                  onPointerMove={(e) => {
                    if (activeDragRef.current === "start") {
                      handleTrackPointerMove(e.clientX);
                    }
                  }}
                  onPointerUp={() => {
                    activeDragRef.current = null;
                  }}
                  style={{ left: `calc(${inPct}% - 7px)` }}
                  className="absolute inset-y-0 z-10 flex w-3.5 cursor-ew-resize items-center justify-center rounded-l-[6px] bg-[#E6C29F] text-[#0A0908] shadow hover:bg-[#F0D2B4]"
                >
                  <span data-handle="start" className="h-4 w-0.5 rounded-full bg-[#0A0908]" />
                </button>

                {/* End Handle */}
                <button
                  type="button"
                  data-handle="end"
                  aria-label="Drag trim end handle"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    activeDragRef.current = "end";
                  }}
                  onPointerMove={(e) => {
                    if (activeDragRef.current === "end") {
                      handleTrackPointerMove(e.clientX);
                    }
                  }}
                  onPointerUp={() => {
                    activeDragRef.current = null;
                  }}
                  style={{ left: `calc(${outPct}% - 7px)` }}
                  className="absolute inset-y-0 z-10 flex w-3.5 cursor-ew-resize items-center justify-center rounded-r-[6px] bg-[#E6C29F] text-[#0A0908] shadow hover:bg-[#F0D2B4]"
                >
                  <span data-handle="end" className="h-4 w-0.5 rounded-full bg-[#0A0908]" />
                </button>
              </div>

              {/* Exact Start & End Timecode Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-0.5">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[#6E655E] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-[#E6C29F]">START</span>
                    <input
                      type="text"
                      value={inDraft}
                      onChange={(e) => setInDraft(e.target.value)}
                      onBlur={commitInDraft}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitInDraft();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label="Trim start timecode"
                      className="w-24 rounded-[6px] border border-[#6E655E] bg-[#0A0908] px-2 py-1 text-center font-mono tabular-nums text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => applyInTime(inTime - 0.5, true)}
                      className="rounded-[6px] border border-[#6E655E] bg-[#1A1715] px-2 py-1 font-mono text-[11px] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      -0.5s
                    </button>
                    <button
                      type="button"
                      onClick={() => applyInTime(inTime + 0.5, true)}
                      className="rounded-[6px] border border-[#6E655E] bg-[#1A1715] px-2 py-1 font-mono text-[11px] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      +0.5s
                    </button>
                    <button
                      type="button"
                      onClick={() => applyInTime(playhead, false)}
                      title="Shortcut: I"
                      className="rounded-[6px] border border-[#E6C29F]/60 bg-[#241D15] px-2 py-1 text-[11px] font-medium text-[#E6C29F] hover:border-[#E6C29F]"
                    >
                      Set Start [I]
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[#6E655E] bg-[#0D0B0A] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-[#E6C29F]">END</span>
                    <input
                      type="text"
                      value={outDraft}
                      onChange={(e) => setOutDraft(e.target.value)}
                      onBlur={commitOutDraft}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutDraft();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label="Trim end timecode"
                      className="w-24 rounded-[6px] border border-[#6E655E] bg-[#0A0908] px-2 py-1 text-center font-mono tabular-nums text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => applyOutTime(outTime - 0.5, true)}
                      className="rounded-[6px] border border-[#6E655E] bg-[#1A1715] px-2 py-1 font-mono text-[11px] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      -0.5s
                    </button>
                    <button
                      type="button"
                      onClick={() => applyOutTime(outTime + 0.5, true)}
                      className="rounded-[6px] border border-[#6E655E] bg-[#1A1715] px-2 py-1 font-mono text-[11px] text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      +0.5s
                    </button>
                    <button
                      type="button"
                      onClick={() => applyOutTime(playhead, false)}
                      title="Shortcut: O"
                      className="rounded-[6px] border border-[#E6C29F]/60 bg-[#241D15] px-2 py-1 text-[11px] font-medium text-[#E6C29F] hover:border-[#E6C29F]"
                    >
                      Set End [O]
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInTime(0);
                        setOutTime(duration);
                        seekVideoTo(0);
                      }}
                      className="rounded-[6px] border border-[#6E655E] bg-[#12100E] px-2 py-1 text-[11px] text-[#94897E] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Tags row (library clips only) */}
            {!isExternal && (
              <div className="flex flex-wrap items-center gap-2 border-y border-[#282320] py-2.5">
                <span className="text-[11px] uppercase tracking-[0.14em] text-[#94897E]">
                  Tags
                </span>
                {clip.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onUpdateTags(clip, clip.tags.filter((x) => x !== t))}
                    title={`Remove #${t}`}
                    aria-label={`Remove tag ${t}`}
                    className="inline-flex items-center gap-1 rounded-[6px] border border-[#6E655E] bg-[#1A1715] px-2 py-0.5 font-mono text-[11px] text-[#E6C29F] hover:border-[#C92A32] hover:text-[#FF6B6F]"
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
                    className="w-28 rounded-[6px] border border-[#6E655E] bg-[#0A0908] px-2 py-1 text-xs text-[#F3ECE4] placeholder:text-[#94897E] focus:border-[#E6C29F] focus:outline-none"
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
            )}

            {/* Bottom Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
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
                  onClick={() => void handleSnapshot()}
                  className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs font-medium text-[#F3ECE4] hover:border-[#E6C29F] disabled:opacity-50"
                >
                  <IconCamera className="h-3.5 w-3.5" />
                  <span>PNG Frame</span>
                </button>

                {!isExternal && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSplit()}
                      className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4] disabled:opacity-50"
                    >
                      <IconScissors className="h-3.5 w-3.5" />
                      <span>Split (2 files)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void kage
                          .copyClip(clip.path)
                          .then(() => onToast("ok", "Copied to clipboard", clip.file_name))
                          .catch((e) => onToast("err", "Copy failed", String(e)))
                      }
                      className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      <IconCopy className="h-3.5 w-3.5" />
                      <span>Copy</span>
                    </button>
                  </>
                )}

                {(!isExternal || native) && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void kage
                          .revealClip(clip.path)
                          .catch((e) => onToast("err", "Could not open folder", String(e)))
                      }
                      className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      <IconFolder className="h-3.5 w-3.5" />
                      <span>Explorer</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void kage
                          .openClip(clip.path)
                          .catch((e) => onToast("err", "Could not open external player", String(e)))
                      }
                      className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1.5 text-xs text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
                    >
                      <IconExternal className="h-3.5 w-3.5" />
                      <span>Player</span>
                    </button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {!isExternal &&
                  (!confirmDelete ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#C92A32]/60 bg-[#1A1011] px-3 py-1.5 text-xs font-medium text-[#FF6B6F] hover:border-[#FF6B6F]"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDelete()}
                      className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#C92A32] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#D9363E]"
                    >
                      Confirm Delete
                    </button>
                  ))}

                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[#B5AA9F] select-none">
                  <input
                    type="checkbox"
                    checked={isExternal ? replaceExternal : keepOriginal}
                    onChange={(e) =>
                      isExternal
                        ? setReplaceExternal(e.target.checked)
                        : setKeepOriginal(e.target.checked)
                    }
                    className="h-3.5 w-3.5 accent-[#E6C29F]"
                  />
                  <span>{isExternal ? "Replace original file" : "Keep original"}</span>
                </label>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void handleTrim(
                      isExternal ? replaceExternal : !keepOriginal,
                      isExternal ? !replaceExternal : false,
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:bg-[#282320] disabled:text-[#94897E]"
                >
                  <IconScissors className="h-3.5 w-3.5" />
                  <span>{busy ? "Trimming..." : saveButtonLabel}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
