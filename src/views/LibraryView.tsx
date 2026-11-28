import { useMemo, useState } from "react";
import { kage } from "../lib/bridge";
import { formatBytes } from "../lib/format";
import type { GalleryState, SortKey } from "../lib/galleryState";
import type { ClipMetadata } from "../lib/types";
import GalleryGrid from "../components/GalleryGrid";
import {
  IconCheck,
  IconCopy,
  IconRefresh,
  IconScissors,
  IconSearch,
  IconStar,
  IconTag,
  IconTrash,
} from "../components/Icons";

interface LibraryViewProps {
  clips: ClipMetadata[];
  loading: boolean;
  error: string | null;
  gallery: GalleryState;
  onGalleryChange: (patch: Partial<GalleryState>) => void;
  onResetFilters: () => void;
  selectedPaths: ReadonlySet<string>;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  onSelectClip: (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }, visibleOrder: string[]) => void;
  onSelectAll: (clips: ClipMetadata[]) => void;
  onClearSelection: () => void;
  onOpenClip: (clip: ClipMetadata) => void;
  onCopyClip: (clip: ClipMetadata) => void;
  onRevealClip: (clip: ClipMetadata) => void;
  onOpenExternalClip: (clip: ClipMetadata) => void;
  onDeleteClip: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
  onBatchCopy: () => void;
  onBatchFavorite: (fav: boolean) => void;
  onBatchTag: (tag: string, remove?: boolean) => void;
  onBatchDelete: () => void;
  onRefresh: () => void;
  onImportVideo: () => void;
  hotkeySave: string;
  hotkeyRecord: string;
}

export function LibraryView({
  clips,
  loading,
  error,
  gallery,
  onGalleryChange,
  onResetFilters,
  selectedPaths,
  selectMode,
  onToggleSelectMode,
  onSelectClip,
  onSelectAll,
  onClearSelection,
  onOpenClip,
  onCopyClip,
  onRevealClip,
  onOpenExternalClip,
  onDeleteClip,
  onToggleFavorite,
  onBatchCopy,
  onBatchFavorite,
  onBatchTag,
  onBatchDelete,
  onRefresh,
  onImportVideo,
  hotkeySave,
  hotkeyRecord,
}: LibraryViewProps) {
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [batchTagInput, setBatchTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);

  const games = useMemo(() => {
    const set = new Set<string>();
    for (const c of clips) {
      if (c.game) set.add(c.game);
    }
    if (gallery.gameFilter !== "all" && gallery.gameFilter) {
      set.add(gallery.gameFilter);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [clips, gallery.gameFilter]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const c of clips) {
      for (const t of c.tags) set.add(t);
    }
    if (gallery.tagFilter) {
      set.add(gallery.tagFilter);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [clips, gallery.tagFilter]);

  const filtered = useMemo(() => {
    const q = gallery.query.trim().toLowerCase();
    const list = clips.filter((c) => {
      if (gallery.favOnly && !c.favorite) return false;
      if (gallery.audioOnly && !c.has_audio) return false;
      if (gallery.gameFilter !== "all" && (c.game ?? "") !== gallery.gameFilter) return false;
      if (gallery.tagFilter && !c.tags.includes(gallery.tagFilter)) return false;
      if (q) {
        const hay = `${c.title} ${c.file_name} ${c.game ?? ""} ${c.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return [...list].sort((a, b) => {
      switch (gallery.sortKey) {
        case "oldest":
          return a.created_unix_ms - b.created_unix_ms;
        case "largest":
          return b.size_bytes - a.size_bytes;
        case "smallest":
          return a.size_bytes - b.size_bytes;
        case "longest":
          return b.duration_seconds - a.duration_seconds;
        case "shortest":
          return a.duration_seconds - b.duration_seconds;
        default:
          return b.created_unix_ms - a.created_unix_ms;
      }
    });
  }, [clips, gallery]);

  const totalBytes = useMemo(
    () => filtered.reduce((acc, c) => acc + c.size_bytes, 0),
    [filtered],
  );
  const visibleOrder = useMemo(() => filtered.map((c) => c.path), [filtered]);

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-none text-[#F3ECE4]">
            Clip Library
          </h1>
          <p className="mt-1.5 font-mono text-xs tabular-nums text-[#94897E]">
            {filtered.length} of {clips.length} clips ({formatBytes(totalBytes)}) or drag MP4 / MOV anywhere to trim
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onImportVideo}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#E6C29F] px-3.5 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4]"
          >
            <IconScissors className="h-3.5 w-3.5" />
            <span>Trim Video File</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh clip list"
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            aria-pressed={gallery.compact}
            onClick={() => onGalleryChange({ compact: !gallery.compact })}
            className="rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#B5AA9F] hover:border-[#E6C29F] hover:text-[#F3ECE4]"
          >
            {gallery.compact ? "Comfort Grid" : "Compact Grid"}
          </button>

          <button
            type="button"
            aria-pressed={selectMode}
            onClick={onToggleSelectMode}
            className={`inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors ${
              selectMode
                ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                : "border-[#6E655E] bg-[#12100E] text-[#F3ECE4] hover:border-[#E6C29F]"
            }`}
          >
            <IconCheck className="h-3.5 w-3.5" />
            <span>{selectMode ? "Done Selecting" : "Select Clips"}</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bezel-outer">
        <div className="bezel-inner flex flex-wrap items-center gap-2 p-2.5">
          <div className="relative min-w-[150px] flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94897E]" />
            <input
              type="search"
              value={gallery.query}
              onChange={(e) => onGalleryChange({ query: e.target.value })}
              placeholder="Search title, game, or tag..."
              aria-label="Search clips"
              className="w-full rounded-[8px] border border-[#6E655E] bg-[#0A0908] py-1.5 pl-8 pr-3 text-xs text-[#F3ECE4] placeholder:text-[#94897E] focus:border-[#E6C29F] focus:outline-none"
            />
          </div>

          <button
            type="button"
            aria-pressed={gallery.favOnly}
            onClick={() => onGalleryChange({ favOnly: !gallery.favOnly })}
            className={`inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors ${
              gallery.favOnly
                ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                : "border-[#6E655E] bg-[#0A0908] text-[#B5AA9F] hover:border-[#E6C29F]"
            }`}
          >
            <IconStar filled={gallery.favOnly} className="h-3.5 w-3.5" />
            <span>Favorites</span>
          </button>

          <button
            type="button"
            aria-pressed={gallery.audioOnly}
            onClick={() => onGalleryChange({ audioOnly: !gallery.audioOnly })}
            className={`rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-colors ${
              gallery.audioOnly
                ? "border-[#E6C29F] bg-[#241D15] text-[#E6C29F]"
                : "border-[#6E655E] bg-[#0A0908] text-[#B5AA9F] hover:border-[#E6C29F]"
            }`}
          >
            With Audio
          </button>

          <select
            value={gallery.gameFilter}
            onChange={(e) => onGalleryChange({ gameFilter: e.target.value })}
            aria-label="Filter by game"
            className="rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-2.5 py-1.5 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
          >
            <option value="all">All Games</option>
            {games.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>

          {tags.length > 0 && (
            <select
              value={gallery.tagFilter ?? ""}
              onChange={(e) =>
                onGalleryChange({ tagFilter: e.target.value ? e.target.value : null })
              }
              aria-label="Filter by tag"
              className="rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-2.5 py-1.5 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
            >
              <option value="">All Tags</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          )}

          <select
            value={gallery.sortKey}
            onChange={(e) => onGalleryChange({ sortKey: e.target.value as SortKey })}
            aria-label="Sort clips"
            className="rounded-[8px] border border-[#6E655E] bg-[#0A0908] px-2.5 py-1.5 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="largest">Largest File</option>
            <option value="smallest">Smallest File</option>
            <option value="longest">Longest Duration</option>
            <option value="shortest">Shortest Duration</option>
          </select>
        </div>
      </div>

      {/* Multi-select Batch Action Bar */}
      {(selectMode || selectedPaths.size > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[#E6C29F]/50 bg-[#1A1612] px-4 py-2.5 text-xs">
          <div className="flex items-center gap-3">
            <span className="font-mono font-semibold tabular-nums text-[#E6C29F]">
              {selectedPaths.size} selected
            </span>
            <button
              type="button"
              onClick={() => onSelectAll(filtered)}
              className="text-[#F3ECE4] underline-offset-2 hover:underline"
            >
              Select All ({filtered.length})
            </button>
            {selectedPaths.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  onClearSelection();
                  setConfirmBatchDelete(false);
                }}
                className="text-[#B5AA9F] hover:text-[#F3ECE4]"
              >
                Clear
              </button>
            )}
          </div>

          {selectedPaths.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onBatchCopy}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1 text-[#F3ECE4] hover:border-[#E6C29F]"
              >
                <IconCopy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </button>

              <button
                type="button"
                onClick={() => onBatchFavorite(true)}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1 text-[#E6C29F] hover:border-[#E6C29F]"
              >
                <IconStar filled className="h-3.5 w-3.5" />
                <span>Star</span>
              </button>

              <button
                type="button"
                aria-expanded={showTagInput}
                onClick={() => setShowTagInput((s) => !s)}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[#6E655E] bg-[#12100E] px-2.5 py-1 text-[#F3ECE4] hover:border-[#E6C29F]"
              >
                <IconTag className="h-3.5 w-3.5" />
                <span>Tag</span>
              </button>

              {showTagInput && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (batchTagInput.trim()) {
                      onBatchTag(batchTagInput.trim());
                      setBatchTagInput("");
                      setShowTagInput(false);
                    }
                  }}
                  className="inline-flex items-center gap-1"
                >
                  <input
                    type="text"
                    value={batchTagInput}
                    onChange={(e) => setBatchTagInput(e.target.value)}
                    placeholder="tag name"
                    className="w-24 rounded-[6px] border border-[#E6C29F] bg-[#0A0908] px-2 py-1 text-xs text-[#F3ECE4] focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded-[6px] bg-[#E6C29F] px-2.5 py-1 font-semibold text-[#0A0908]"
                  >
                    Apply
                  </button>
                </form>
              )}

              {!confirmBatchDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmBatchDelete(true)}
                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#C92A32]/60 bg-[#1A1011] px-2.5 py-1 text-[#FF6B6F] hover:border-[#FF6B6F]"
                >
                  <IconTrash className="h-3.5 w-3.5" />
                  <span>Delete</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmBatchDelete(false);
                    onBatchDelete();
                  }}
                  className="rounded-[6px] bg-[#C92A32] px-3 py-1 font-semibold text-white hover:bg-[#D9363E]"
                >
                  Confirm Delete ({selectedPaths.size})
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error State or Virtualized Grid */}
      {error ? (
        <div className="bezel-outer">
          <div className="bezel-inner flex items-center justify-between gap-4 p-5">
            <div>
              <div className="text-sm font-semibold text-[#FF6B6F]">
                Library scan failed
              </div>
              <p className="mt-1 text-xs text-[#B5AA9F]">{error}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void kage.openOutputFolder().catch(() => {})}
                className="rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs text-[#F3ECE4]"
              >
                Open Folder
              </button>
              <button
                type="button"
                onClick={onRefresh}
                className="rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908]"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : (
        <GalleryGrid
          clips={filtered}
          loading={loading}
          compact={gallery.compact}
          totalClipsCount={clips.length}
          hotkeySave={hotkeySave}
          hotkeyRecord={hotkeyRecord}
          onResetFilters={onResetFilters}
          selectedPaths={selectedPaths}
          selectMode={selectMode}
          onOpen={onOpenClip}
          onSelect={(clip, mods) => onSelectClip(clip, mods, visibleOrder)}
          onCopy={onCopyClip}
          onReveal={onRevealClip}
          onOpenExternal={onOpenExternalClip}
          onDelete={onDeleteClip}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </div>
  );
}
