import { memo, useCallback, useEffect, useState } from "react";
import { kage } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format";
import { cacheThumbnail, getCachedThumbnail } from "../lib/thumbCache";
import { cn } from "../utils/cn";
import { gapFor, useVirtualGrid } from "../hooks/useVirtualGrid";
import {
  IconCheck,
  IconCopy,
  IconExternal,
  IconFolder,
  IconPlay,
  IconSearch,
  IconStar,
  IconTrash,
  IconVolume,
} from "./Icons";

interface Props {
  clips: ClipMetadata[];
  loading?: boolean;
  compact?: boolean;
  totalClipsCount?: number;
  hotkeySave?: string;
  hotkeyRecord?: string;
  onResetFilters?: () => void;
  selectedPaths?: ReadonlySet<string>;
  selectMode?: boolean;
  onOpen: (clip: ClipMetadata) => void;
  onSelect: (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (clip: ClipMetadata) => void;
  onReveal: (clip: ClipMetadata) => void;
  onOpenExternal: (clip: ClipMetadata) => void;
  onDelete: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
}

function CardIconButton({
  title,
  onClick,
  danger,
  highlight,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-[6px] border text-[11px] transition-colors duration-150",
        danger
          ? "border-[#C92A32]/60 bg-[#1A1011] text-[#FF6B6F] hover:border-[#FF6B6F] hover:bg-[#C92A32] hover:text-white"
          : highlight
            ? "border-[#E6C29F]/60 bg-[#1A1510] text-[#E6C29F] hover:border-[#E6C29F] hover:bg-[#261E16]"
            : "border-[#6E655E] bg-[#12100E] text-[#B5AA9F] hover:border-[#E6C29F] hover:bg-[#1A1715] hover:text-[#F3ECE4]",
      )}
    >
      {children}
    </button>
  );
}

const ClipCard = memo(function ClipCard({
  clip,
  compact,
  selected,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: {
  clip: ClipMetadata;
  compact?: boolean;
  selected: boolean;
  selectMode: boolean;
  onOpen: (c: ClipMetadata) => void;
  onSelect: (c: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (c: ClipMetadata) => void;
  onReveal: (c: ClipMetadata) => void;
  onOpenExternal: (c: ClipMetadata) => void;
  onDelete: (c: ClipMetadata) => void;
  onToggleFavorite: (c: ClipMetadata) => void;
}) {
  const [thumb, setThumb] = useState(clip.thumbnail);

  useEffect(() => {
    if (clip.thumbnail) {
      setThumb(clip.thumbnail);
      return;
    }
    let alive = true;
    let requested = false;
    const load = () => {
      if (!alive || requested || document.visibilityState !== "visible") return;
      const cached = getCachedThumbnail(clip.path);
      if (cached) {
        setThumb(cached);
        requested = true;
        return;
      }
      requested = true;
      void kage
        .getClipThumbnail(clip.path, 1)
        .then((t) => {
          if (!alive || !t) return;
          cacheThumbnail(clip.path, t);
          setThumb(t);
        })
        .catch(() => {
          requested = false;
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [clip.path, clip.thumbnail]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (selectMode || mods.ctrl || mods.shift) {
        onSelect(clip, mods);
      } else {
        onOpen(clip);
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selectMode) onSelect(clip, { ctrl: true, shift: e.shiftKey });
        else onOpen(clip);
      } else if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        onSelect(clip, { ctrl: true, shift: e.shiftKey });
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-[12px] border transition-colors duration-150",
        selected
          ? "border-[#E6C29F] ring-2 ring-[#E6C29F]/40 bg-[#1A1612]"
          : "border-[#282320] bg-[#12100E] hover:border-[#6E655E] hover:bg-[#161311]",
      )}
    >
      <button
        type="button"
        aria-label={`${clip.title}, ${formatDuration(clip.duration_seconds)}${
          clip.game ? `, ${clip.game}` : ""
        }${clip.favorite ? ", favorite" : ""}`}
        aria-pressed={selectMode ? selected : undefined}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        className="block w-full text-left focus:outline-none"
      >
        {/* Thumbnail Viewport */}
        <div className="relative aspect-video w-full overflow-hidden bg-[#0A0908]">
          {thumb ? (
            <img
              src={thumb}
              alt={clip.title}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-[#14110F]">
              <span className="font-mono text-[10px] tracking-[0.12em] text-[#94897E]">
                PREVIEW READY
              </span>
            </div>
          )}

          {/* Play indicator on hover */}
          <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <span className="grid h-10 w-10 place-items-center rounded-full border border-[#E6C29F]/60 bg-[#0A0908]/90 text-[#E6C29F]">
              <IconPlay className="ml-0.5 h-4 w-4" />
            </span>
          </span>

          {/* Readability gradient scrim */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0A0908]/85 via-transparent to-[#0A0908]/30" />

          {/* Top-left game and favorite stack */}
          {(clip.game || clip.favorite) && (
            <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5">
              {clip.game && (
                <span className="rounded-[5px] border border-[#282320] bg-[#0A0908]/90 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-[#F3ECE4]">
                  {clip.game.toUpperCase()}
                </span>
              )}
              {clip.favorite && (
                <span
                  className="grid h-5 w-5 place-items-center rounded-[5px] bg-[#E6C29F] text-[#0A0908]"
                  title="Favorited clip"
                >
                  <IconStar filled className="h-3 w-3" />
                </span>
              )}
            </div>
          )}

          {/* Bottom overlay badges */}
          <div className="pointer-events-none absolute inset-x-2.5 bottom-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="rounded-[5px] border border-[#282320] bg-[#0A0908]/90 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[#F3ECE4]">
                {formatDuration(clip.duration_seconds)}
              </span>
              {clip.has_audio && (
                <span
                  className="flex items-center gap-1 rounded-[5px] border border-[#282320] bg-[#0A0908]/90 px-1.5 py-0.5 font-mono text-[10px] text-[#B5AA9F]"
                  title="Includes audio track"
                >
                  <IconVolume className="h-3 w-3" />
                  Audio
                </span>
              )}
            </div>
            <span className="rounded-[5px] border border-[#282320] bg-[#0A0908]/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#B5AA9F]">
              {clip.height}p{clip.fps}
            </span>
          </div>
        </div>

        {/* Metadata footer */}
        <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
          <div className="h-5 truncate text-[13px] font-medium text-[#F3ECE4]">
            {clip.title}
          </div>
          <div className="mt-1 flex h-4 items-center gap-1 overflow-hidden">
            {clip.tags.length > 0 && (
              <>
                {clip.tags.slice(0, 3).map((t) => (
                  <span
                    key={t}
                    className="shrink-0 rounded-[5px] border border-[#282320] bg-[#1A1715] px-1.5 py-px font-mono text-[10px] text-[#B5AA9F]"
                  >
                    #{t}
                  </span>
                ))}
                {clip.tags.length > 3 && (
                  <span className="shrink-0 font-mono text-[10px] text-[#94897E]">
                    +{clip.tags.length - 3}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] tabular-nums text-[#94897E]">
            <span>{formatRelativeTime(clip.created_unix_ms)}</span>
            <span>{formatBytes(clip.size_bytes)}</span>
          </div>
        </div>
      </button>

      {/* Sibling quick action overlay */}
      <div
        className={cn(
          "absolute right-2 top-2 z-10 flex items-center gap-1 transition-opacity duration-150",
          selectMode
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        {(selectMode || selected) && (
          <CardIconButton
            title={selected ? "Deselect clip" : "Select clip"}
            highlight={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(clip, { ctrl: true, shift: false });
            }}
          >
            {selected ? (
              <IconCheck className="h-3.5 w-3.5" />
            ) : (
              <span className="h-2.5 w-2.5 rounded-xs border border-[#94897E]" />
            )}
          </CardIconButton>
        )}

        <CardIconButton
          title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
          highlight={clip.favorite}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(clip);
          }}
        >
          <IconStar filled={clip.favorite} className="h-3.5 w-3.5" />
        </CardIconButton>

        <CardIconButton
          title="Open in external player"
          onClick={(e) => {
            e.stopPropagation();
            onOpenExternal(clip);
          }}
        >
          <IconExternal className="h-3.5 w-3.5" />
        </CardIconButton>

        <CardIconButton
          title="Copy video file to clipboard"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(clip);
          }}
        >
          <IconCopy className="h-3.5 w-3.5" />
        </CardIconButton>

        <CardIconButton
          title="Reveal in Explorer"
          onClick={(e) => {
            e.stopPropagation();
            onReveal(clip);
          }}
        >
          <IconFolder className="h-3.5 w-3.5" />
        </CardIconButton>

        <CardIconButton
          title="Delete clip"
          danger
          onClick={(e) => {
            e.stopPropagation();
            onDelete(clip);
          }}
        >
          <IconTrash className="h-3.5 w-3.5" />
        </CardIconButton>
      </div>
    </article>
  );
});

const GalleryGrid = memo(function GalleryGrid({
  clips,
  loading,
  compact,
  totalClipsCount,
  hotkeySave = "Alt+C",
  hotkeyRecord = "Alt+R",
  onResetFilters,
  selectedPaths,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: Props) {
  const gap = gapFor(!!compact);
  const { cols, rowPitch, totalHeight, startRow, endRow, containerRef, rowRef } =
    useVirtualGrid({ itemCount: clips.length, compact: !!compact });

  const gridClass = compact
    ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div role="status" aria-label="Loading clips" className={gridClass}>
        <span className="sr-only">Loading clips...</span>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[196px] rounded-[12px] border border-[#282320] bg-[#12100E] p-3 flex flex-col justify-end"
          >
            <div className="h-3 w-2/3 rounded bg-[#1A1715]" />
            <div className="mt-2 h-2.5 w-1/3 rounded bg-[#1A1715]" />
          </div>
        ))}
      </div>
    );
  } else if (clips.length === 0) {
    if (totalClipsCount && totalClipsCount > 0) {
      content = (
        <div className="bezel-outer">
          <div className="bezel-inner flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-[10px] border border-[#282320] bg-[#1A1715] text-[#B5AA9F]">
              <IconSearch className="h-5 w-5" />
            </div>
            <div className="text-[14px] font-semibold text-[#F3ECE4]">
              No clips match your filters
            </div>
            <p className="max-w-sm text-xs leading-relaxed text-[#B5AA9F]">
              No saved recordings match the active search query or game filter.
            </p>
            {onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="mt-1 rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] transition-colors"
              >
                Clear Search and Filters
              </button>
            )}
          </div>
        </div>
      );
    } else {
      content = (
        <div className="bezel-outer">
          <div className="bezel-inner flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="font-display text-2xl text-[#F3ECE4]">
              No captures in library yet
            </div>
            <p className="max-w-md text-xs leading-relaxed text-[#B5AA9F]">
              Press{" "}
              <kbd className="rounded border border-[#6E655E] bg-[#1A1715] px-1.5 py-0.5 font-mono text-[11px] text-[#E6C29F]">
                {hotkeySave}
              </kbd>{" "}
              to flush an instant replay, or press{" "}
              <kbd className="rounded border border-[#C92A32]/70 bg-[#1A1212] px-1.5 py-0.5 font-mono text-[11px] text-[#FF6B6F]">
                {hotkeyRecord}
              </kbd>{" "}
              to record directly to MP4.
            </p>
          </div>
        </div>
      );
    }
  } else {
    const rows: React.ReactNode[] = [];
    for (let r = startRow; r < endRow; r++) {
      const from = r * cols;
      rows.push(
        <div
          key={r}
          ref={r === startRow ? rowRef : undefined}
          className="absolute left-0 right-0 grid"
          style={{
            top: r * rowPitch,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {clips.slice(from, from + cols).map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              compact={compact}
              selected={selectedPaths?.has(clip.path) ?? false}
              selectMode={!!selectMode}
              onOpen={onOpen}
              onSelect={onSelect}
              onCopy={onCopy}
              onReveal={onReveal}
              onOpenExternal={onOpenExternal}
              onDelete={onDelete}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>,
      );
    }
    content = rows;
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight || undefined }}>
      {content}
    </div>
  );
});

export default GalleryGrid;
