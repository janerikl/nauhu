import { captureImageThumbnail } from "./imageThumbnail";
import { getPersistedThumbnail, putPersistedThumbnail } from "./persistence";

// In-memory cache so repeated lookups within a session (filmstrip re-renders,
// media bin re-renders) don't keep hitting IndexedDB for the same source.
const memoryCache = new Map<string, string>();

/**
 * Returns a small downscaled JPEG thumbnail for an image source, keyed by
 * source id. Checks the in-memory cache, then IndexedDB, and only falls back
 * to decoding the full-resolution source (and persisting the result) on a
 * true miss - e.g. the first time a source is imported.
 */
export async function getImageThumbnail(sourceId: string, url: string): Promise<string | undefined> {
  const cached = memoryCache.get(sourceId);
  if (cached) return cached;

  const persisted = await getPersistedThumbnail(sourceId);
  if (persisted) {
    memoryCache.set(sourceId, persisted);
    return persisted;
  }

  const generated = await captureImageThumbnail(url);
  if (generated) {
    memoryCache.set(sourceId, generated);
    await putPersistedThumbnail(sourceId, generated);
  }
  return generated;
}

/** Forces regeneration of a source's thumbnail (e.g. user-triggered "regenerate"). */
export async function regenerateImageThumbnail(sourceId: string, url: string): Promise<string | undefined> {
  memoryCache.delete(sourceId);
  const generated = await captureImageThumbnail(url);
  if (generated) {
    memoryCache.set(sourceId, generated);
    await putPersistedThumbnail(sourceId, generated);
  }
  return generated;
}
