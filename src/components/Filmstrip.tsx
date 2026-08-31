import { useEffect, useRef, useState } from "react";
import { captureVideoFrame, filmstripTimestamps } from "../lib/videoThumbnail";
import { getImageThumbnail } from "../lib/thumbnailCache";

// Frames are cached per source id so re-renders (drag, trim, zoom) don't
// re-seek the video file each time the same timestamp is needed again.
const frameCache = new Map<string, Map<number, string>>();

const MIN_WIDTH = 40;
const FRAME_INTERVAL_PX = 100;
const DEBOUNCE_MS = 200;

async function getFrame(sourceId: string, url: string, time: number): Promise<string | undefined> {
  let bySource = frameCache.get(sourceId);
  if (!bySource) {
    bySource = new Map();
    frameCache.set(sourceId, bySource);
  }
  const cached = bySource.get(time);
  if (cached) return cached;
  const frame = await captureVideoFrame(url, time);
  if (frame) bySource.set(time, frame);
  return frame;
}

interface FilmstripProps {
  sourceId: string;
  url: string;
  /** static-image sources have one frame, repeated across every slot */
  kind: "video" | "image";
  /** seconds into the source where the visible clip region starts */
  sourceIn: number;
  /** seconds into the source where the visible clip region ends */
  sourceOut: number;
  width: number;
  height: number;
}

export function Filmstrip({ sourceId, url, kind, sourceIn, sourceOut, width, height }: FilmstripProps) {
  const [videoFrames, setVideoFrames] = useState<string[]>([]);
  const [imageThumb, setImageThumb] = useState<string | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (kind !== "video" || width < MIN_WIDTH) {
      setVideoFrames([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      let cancelled = false;
      const timestamps = filmstripTimestamps(width, sourceIn, sourceOut, FRAME_INTERVAL_PX);
      Promise.all(timestamps.map((t) => getFrame(sourceId, url, t))).then((results) => {
        if (cancelled) return;
        setVideoFrames(results.filter((f): f is string => !!f));
      });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [kind, sourceId, url, sourceIn, sourceOut, width]);

  useEffect(() => {
    if (kind !== "image") return;
    let cancelled = false;
    getImageThumbnail(sourceId, url).then((thumb) => {
      if (!cancelled) setImageThumb(thumb);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, sourceId, url]);

  if (width < MIN_WIDTH) return null;

  // A static image has no timeline to seek, so every slot repeats the same
  // downscaled thumbnail - no per-timestamp capture or debounce needed.
  const frames =
    kind === "image"
      ? imageThumb
        ? Array(filmstripTimestamps(width, sourceIn, sourceOut, FRAME_INTERVAL_PX).length).fill(imageThumb)
        : []
      : videoFrames;

  if (frames.length === 0) return null;

  return (
    <div className="clip-filmstrip" style={{ width, height }}>
      {frames.map((frame, i) => (
        <div
          key={i}
          className="filmstrip-frame"
          style={{ backgroundImage: `url(${frame})`, width: `${100 / frames.length}%` }}
        />
      ))}
    </div>
  );
}
