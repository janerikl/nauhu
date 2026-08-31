import { useEffect, useRef, useState } from "react";
import { captureVideoFrame, filmstripTimestamps } from "../lib/videoThumbnail";

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
  /** seconds into the source where the visible clip region starts */
  sourceIn: number;
  /** seconds into the source where the visible clip region ends */
  sourceOut: number;
  width: number;
  height: number;
}

export function Filmstrip({ sourceId, url, sourceIn, sourceOut, width, height }: FilmstripProps) {
  const [frames, setFrames] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (width < MIN_WIDTH) {
      setFrames([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      let cancelled = false;
      const timestamps = filmstripTimestamps(width, sourceIn, sourceOut, FRAME_INTERVAL_PX);
      Promise.all(timestamps.map((t) => getFrame(sourceId, url, t))).then((results) => {
        if (cancelled) return;
        setFrames(results.filter((f): f is string => !!f));
      });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [sourceId, url, sourceIn, sourceOut, width]);

  if (width < MIN_WIDTH || frames.length === 0) return null;

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
