/**
 * Bounded in-memory thumbnail cache. Backing store is the Rust disk JPEG cache
 * (`%APPDATA%/KAGE/thumbs/`), so keeping this cap small (120) and clearing it
 * when the window hides to the tray keeps WebView2 heap low during gaming.
 */
const cache = new Map<string, string>();

const MAX = 120;

export function getCachedThumbnail(path: string): string | undefined {
  return cache.get(path);
}

export function cacheThumbnail(path: string, data: string): void {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, data);
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function deleteCachedThumbnail(path: string): void {
  cache.delete(path);
}

export function clearThumbnailCache(): void {
  cache.clear();
}
