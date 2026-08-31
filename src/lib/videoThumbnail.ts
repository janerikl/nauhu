/** Grabs a single frame from a video file at `time` seconds as a small JPEG data URL. */
export function captureVideoFrame(
  url: string,
  time: number,
  width = 320,
  height = 180,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const finish = (result: string | undefined) => {
      clearTimeout(timeout);
      video.onseeked = null;
      video.onerror = null;
      resolve(result);
    };
    const timeout = setTimeout(() => finish(undefined), 4000);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(Math.max(0, time), Math.max(0, (video.duration || 0) - 0.05));
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        finish(undefined);
      }
    };
    video.onerror = () => finish(undefined);
  });
}

/** Grabs a mid-point frame from a video file for use as a static thumbnail. */
export function captureVideoThumbnail(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    probe.src = url;
    const timeout = setTimeout(() => resolve(undefined), 4000);
    probe.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve(captureVideoFrame(url, Math.min(0.5, (probe.duration || 1) / 2)));
    };
    probe.onerror = () => {
      clearTimeout(timeout);
      resolve(undefined);
    };
  });
}

/**
 * Given the pixel width available and the visible source range, returns the
 * source timestamps (seconds) to render as filmstrip frames - one roughly
 * every `intervalPx` pixels, always including the first frame.
 */
export function filmstripTimestamps(
  width: number,
  sourceIn: number,
  sourceOut: number,
  intervalPx = 100,
): number[] {
  const span = Math.max(0, sourceOut - sourceIn);
  if (width <= 0 || span <= 0) return [];
  const count = Math.max(1, Math.floor(width / intervalPx) + 1);
  if (count === 1) return [sourceIn];
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => sourceIn + i * step);
}
