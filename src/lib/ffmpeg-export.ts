import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { Clip } from "./timeline-math";
import type { MediaSource } from "../store/editorStore";

let ffmpeg: FFmpeg | null = null;

export async function loadFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  const instance = new FFmpeg();
  if (onLog) instance.on("log", ({ message }) => onLog(message));
  const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  await instance.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpeg = instance;
  return instance;
}

const EXPORT_WIDTH = 1920;
const EXPORT_HEIGHT = 1080;
const EXPORT_FPS = 30;

/** Scales/pads any source frame size to the fixed export resolution so every segment shares identical params for concat. */
const SCALE_FILTER = `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

/**
 * Exports the video track by trimming each clip to its in/out range and
 * concatenating them in timeline order, producing a single mp4. Every clip
 * (video or still image) is re-encoded to a common resolution/framerate/codec
 * so the segments can be concatenated with a plain stream copy afterward.
 */
export async function exportTimeline(
  clips: Clip[],
  sources: MediaSource[],
  trackId: string,
  onProgress?: (ratio: number) => void
): Promise<Blob> {
  const ff = await loadFFmpeg();
  const trackClips = clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
  if (trackClips.length === 0) throw new Error("No clips to export");

  const exportableClips = trackClips.filter((c) => {
    const source = sources.find((s) => s.id === c.sourceId);
    return source && c.sourceOut - c.sourceIn > 0;
  });
  const totalDuration = exportableClips.reduce((sum, c) => sum + (c.sourceOut - c.sourceIn), 0);
  // Encoding each segment accounts for ~95% of the work; the final stream-copy concat is fast.
  const ENCODE_WEIGHT = 0.95;
  let durationDone = 0;
  let currentDuration = 0;

  ff.on("progress", ({ progress }) => {
    const clamped = Math.min(1, Math.max(0, progress));
    const overall = totalDuration > 0
      ? ((durationDone + clamped * currentDuration) / totalDuration) * ENCODE_WEIGHT
      : 0;
    onProgress?.(Math.min(1, Math.max(0, overall)));
  });

  const segmentNames: string[] = [];
  const writtenInputs = new Set<string>();
  for (let i = 0; i < trackClips.length; i++) {
    const clip = trackClips[i];
    const source = sources.find((s) => s.id === clip.sourceId);
    if (!source) continue;
    const duration = clip.sourceOut - clip.sourceIn;
    if (duration <= 0) continue;
    currentDuration = duration;

    const isImage = source.kind === "image";
    const ext = isImage ? "jpg" : "mp4";
    const inputName = `in-${i}.${ext}`;
    const outputName = `seg-${i}.mp4`;
    if (!writtenInputs.has(inputName)) {
      await ff.writeFile(inputName, await fetchFile(source.url));
      writtenInputs.add(inputName);
    }

    const args = isImage
      ? [
          "-loop", "1",
          "-t", String(duration),
          "-i", inputName,
        ]
      : [
          "-ss", String(clip.sourceIn),
          "-t", String(duration),
          "-i", inputName,
        ];

    await ff.exec([
      ...args,
      "-vf", SCALE_FILTER,
      "-r", String(EXPORT_FPS),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      outputName,
    ]);
    segmentNames.push(outputName);
    await ff.deleteFile(inputName);
    writtenInputs.delete(inputName);
    durationDone += duration;
  }

  if (segmentNames.length === 0) throw new Error("No exportable clips found");

  const listContent = segmentNames.map((n) => `file '${n}'`).join("\n");
  await ff.writeFile("list.txt", listContent);
  await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "output.mp4"]);
  onProgress?.(1);

  const data = await ff.readFile("output.mp4");

  for (const n of segmentNames) await ff.deleteFile(n);
  await ff.deleteFile("list.txt");
  await ff.deleteFile("output.mp4");

  return new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
}
