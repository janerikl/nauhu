import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { clipEnd, type Clip, type Track } from "./timeline-math";
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

/** Design-space resolution: the Preview overlay scales text clips against EXPORT_HEIGHT so on-screen sizing matches the exported burn-in. */
export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
const EXPORT_FPS = 30;

/** Scales/pads any source frame size to the fixed export resolution so every segment shares identical params for concat. */
const SCALE_FILTER = `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

const TEXT_MARGIN_PX = 40;
const FONT_FILE_URL = "/fonts/DejaVuSans.ttf";

/** Maps a point in original timeline seconds to seconds in the concatenated (gapless) export output, using each exported clip's cumulative duration offset. */
interface ExportSegmentSpan {
  clip: Clip;
  outStart: number;
  outEnd: number;
}

function mapTimeToExport(t: number, segments: ExportSegmentSpan[]): number {
  for (const seg of segments) {
    if (t >= seg.clip.start && t < clipEnd(seg.clip)) {
      return seg.outStart + (t - seg.clip.start);
    }
  }
  if (segments.length === 0) return 0;
  if (t < segments[0].clip.start) return segments[0].outStart;
  return segments[segments.length - 1].outEnd;
}

/** Escapes text for ffmpeg's drawtext filter description (distinct from shell escaping - no shell is involved since args are passed as an array). */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

function buildDrawtextFilter(clip: Clip, outStart: number, outEnd: number): string {
  const style = clip.text!;
  const x =
    style.align === "left" ? String(TEXT_MARGIN_PX)
    : style.align === "right" ? `w-text_w-${TEXT_MARGIN_PX}`
    : "(w-text_w)/2";
  const y =
    style.verticalAlign === "top" ? String(TEXT_MARGIN_PX)
    : style.verticalAlign === "bottom" ? `h-text_h-${TEXT_MARGIN_PX}`
    : "(h-text_h)/2";

  const fadeIn = style.fadeIn > 0 ? style.fadeIn : 0;
  const fadeOut = style.fadeOut > 0 ? style.fadeOut : 0;
  let alphaExpr = "1";
  if (fadeIn > 0 || fadeOut > 0) {
    const inExpr = fadeIn > 0 ? `(t-${outStart})/${fadeIn}` : "1";
    const outExpr = fadeOut > 0 ? `(${outEnd}-t)/${fadeOut}` : "1";
    alphaExpr = `clip(min(${inExpr},${outExpr}),0,1)`;
  }

  return (
    `drawtext=fontfile=font.ttf` +
    `:text='${escapeDrawtext(style.content)}'` +
    `:fontsize=${style.fontSize}` +
    `:fontcolor=${style.color}` +
    `:x=${x}:y=${y}` +
    `:enable='between(t,${outStart},${outEnd})'` +
    `:alpha='${alphaExpr}'`
  );
}

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
  onProgress?: (ratio: number) => void,
  tracks: Track[] = []
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
  const segmentSpans: ExportSegmentSpan[] = [];
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
    segmentSpans.push({ clip, outStart: durationDone, outEnd: durationDone + duration });
    await ff.deleteFile(inputName);
    writtenInputs.delete(inputName);
    durationDone += duration;
  }

  if (segmentNames.length === 0) throw new Error("No exportable clips found");

  const listContent = segmentNames.map((n) => `file '${n}'`).join("\n");
  await ff.writeFile("list.txt", listContent);
  await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "output.mp4"]);

  const textTrackIds = new Set(tracks.filter((t) => t.kind === "text").map((t) => t.id));
  const textClips = clips.filter((c) => c.text && textTrackIds.has(c.trackId));

  let finalOutputName = "output.mp4";
  if (textClips.length > 0) {
    await ff.writeFile("font.ttf", await fetchFile(FONT_FILE_URL));
    const filters = textClips.map((clip) => {
      const outStart = mapTimeToExport(clip.start, segmentSpans);
      const outEnd = mapTimeToExport(clipEnd(clip), segmentSpans);
      return buildDrawtextFilter(clip, outStart, outEnd);
    });
    await ff.exec([
      "-i", "output.mp4",
      "-vf", filters.join(","),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      "textoutput.mp4",
    ]);
    await ff.deleteFile("font.ttf");
    finalOutputName = "textoutput.mp4";
  }
  onProgress?.(1);

  const data = await ff.readFile(finalOutputName);

  for (const n of segmentNames) await ff.deleteFile(n);
  await ff.deleteFile("list.txt");
  await ff.deleteFile("output.mp4");
  if (finalOutputName !== "output.mp4") await ff.deleteFile(finalOutputName);

  return new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
}
