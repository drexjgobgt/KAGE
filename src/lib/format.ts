export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalCs = Math.round(seconds * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Parses `SS`, `SS.cc`, `MM:SS`, `MM:SS.cc`, `HH:MM:SS`, or `HH:MM:SS.cc`
 * timecodes into seconds. Returns `null` for malformed or out-of-range input.
 */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3) return null;

  if (parts.length === 1) {
    if (!/^\d+(?:\.\d+)?$/.test(parts[0])) return null;
    const val = Number(parts[0]);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }

  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[0]) || !/^\d+(?:\.\d+)?$/.test(parts[1])) return null;
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(s) || s >= 60) return null;
    return m * 60 + s;
  }

  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+(?:\.\d+)?$/.test(parts[2])) {
    return null;
  }
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s) || m >= 60 || s >= 60) {
    return null;
  }
  return h * 3600 + m * 60 + s;
}

export function formatRelativeTime(unixMs: number): string {
  const delta = Date.now() - unixMs;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(unixMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
