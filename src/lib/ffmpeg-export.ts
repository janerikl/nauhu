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
const AUDIO_SAMPLE_RATE = 44100;

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
 * Encodes one clip's trimmed/scaled range to its own standalone mp4 segment,
 * at the shared export resolution/fps/codec. Every segment also carries an
 * audio stream at a common sample rate/channel layout - real audio for a
 * video clip that still owns its sound, or a silent placeholder for a still
 * image or a video clip whose audio was split onto the audio track
 * (`clip.mutedVideo`) - so segments always share the same stream layout for
 * the plain stream-copy concat that follows.
 */
async function encodeClipSegment(
  ff: FFmpeg,
  clip: Clip,
  source: MediaSource,
  inputName: string,
  outputName: string
): Promise<void> {
  const duration = clip.sourceOut - clip.sourceIn;
  const isImage = source.kind === "image";
  const args = isImage
    ? ["-loop", "1", "-t", String(duration), "-i", inputName]
    : ["-ss", String(clip.sourceIn), "-t", String(duration), "-i", inputName];

  const silentAudioArgs = ["-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`];
  const audioEncodeArgs = ["-c:a", "aac", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2"];

  if (!isImage && !clip.mutedVideo) {
    // Try to carry the clip's own embedded audio through first.
    const code = await ff.exec([
      ...args,
      "-vf", SCALE_FILTER,
      "-r", String(EXPORT_FPS),
      "-map", "0:v",
      "-map", "0:a",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      ...audioEncodeArgs,
      outputName,
    ]);
    if (code === 0) return;
    // Source has no audio stream (e.g. a silent video) - fall through to the
    // silent-placeholder path below instead of leaving a partial/failed file.
  }

  await ff.exec([
    ...args,
    ...silentAudioArgs,
    "-vf", SCALE_FILTER,
    "-r", String(EXPORT_FPS),
    "-map", "0:v",
    "-map", "1:a",
    "-shortest",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...audioEncodeArgs,
    outputName,
  ]);
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

    await encodeClipSegment(ff, clip, source, inputName, outputName);
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

  // Composite any other video tracks on top of the primary track: each of
  // their clips is encoded standalone, then layered in with ffmpeg's
  // `overlay` filter, shifted (-itsoffset) and windowed (`enable=between`) to
  // land at the same point on the primary track's gapless output timeline
  // (via the same start/end time mapping the text burn-in below uses).
  const overlayTrackIds = tracks.filter((t) => t.kind === "video" && t.id !== trackId).map((t) => t.id);
  const overlayClips = clips
    .filter((c) => overlayTrackIds.includes(c.trackId))
    .sort((a, b) => a.start - b.start)
    .filter((c) => {
      const source = sources.find((s) => s.id === c.sourceId);
      return source && c.sourceOut - c.sourceIn > 0;
    });

  let compositedOutputName = "output.mp4";
  if (overlayClips.length > 0) {
    const overlayInputs: string[] = [];
    const overlayWindows: { outStart: number; outEnd: number }[] = [];
    for (let i = 0; i < overlayClips.length; i++) {
      const clip = overlayClips[i];
      const source = sources.find((s) => s.id === clip.sourceId)!;
      const isImage = source.kind === "image";
      const inputName = `ov-in-${i}.${isImage ? "jpg" : "mp4"}`;
      const outputName = `ov-seg-${i}.mp4`;
      await ff.writeFile(inputName, await fetchFile(source.url));
      await encodeClipSegment(ff, clip, source, inputName, outputName);
      await ff.deleteFile(inputName);
      overlayInputs.push(outputName);
      overlayWindows.push({
        outStart: mapTimeToExport(clip.start, segmentSpans),
        outEnd: mapTimeToExport(clipEnd(clip), segmentSpans),
      });
    }

    const inputArgs: string[] = ["-i", "output.mp4"];
    overlayInputs.forEach((name, i) => {
      inputArgs.push("-itsoffset", String(overlayWindows[i].outStart), "-i", name);
    });

    let lastLabel = "0:v";
    const filterParts: string[] = [];
    overlayInputs.forEach((_, i) => {
      const { outStart, outEnd } = overlayWindows[i];
      const nextLabel = `v${i + 1}`;
      filterParts.push(
        `[${lastLabel}][${i + 1}:v]overlay=x=0:y=0:enable='between(t,${outStart},${outEnd})'[${nextLabel}]`
      );
      lastLabel = nextLabel;
    });

    await ff.exec([
      ...inputArgs,
      "-filter_complex", filterParts.join(";"),
      "-map", `[${lastLabel}]`,
      "-map", "0:a",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "overlayoutput.mp4",
    ]);
    for (const name of overlayInputs) await ff.deleteFile(name);
    compositedOutputName = "overlayoutput.mp4";
  }

  const textTrackIds = new Set(tracks.filter((t) => t.kind === "text").map((t) => t.id));
  const textClips = clips.filter((c) => c.text && textTrackIds.has(c.trackId));

  let finalOutputName = compositedOutputName;
  if (textClips.length > 0) {
    await ff.writeFile("font.ttf", await fetchFile(FONT_FILE_URL));
    const filters = textClips.map((clip) => {
      const outStart = mapTimeToExport(clip.start, segmentSpans);
      const outEnd = mapTimeToExport(clipEnd(clip), segmentSpans);
      return buildDrawtextFilter(clip, outStart, outEnd);
    });
    await ff.exec([
      "-i", compositedOutputName,
      "-vf", filters.join(","),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "textoutput.mp4",
    ]);
    await ff.deleteFile("font.ttf");
    finalOutputName = "textoutput.mp4";
  }

  // Mix every audio-track clip (music, narration, and any video clip's
  // split-out sound - see mutedVideo) into the export's audio, each delayed
  // to its position on the gapless export timeline via the same
  // start/end mapping the overlay/text steps above use. The base audio
  // already baked into `finalOutputName` (real per-segment audio, silent
  // where split/absent) is mixed in too so nothing already-correct is lost.
  const audioTrackIds = new Set(tracks.filter((t) => t.kind === "audio").map((t) => t.id));
  const audioClips = clips
    .filter((c) => audioTrackIds.has(c.trackId))
    .sort((a, b) => a.start - b.start)
    .filter((c) => {
      const source = sources.find((s) => s.id === c.sourceId);
      return source && c.sourceOut - c.sourceIn > 0;
    });

  let mixedOutputName = finalOutputName;
  if (audioClips.length > 0) {
    const mixInputNames: string[] = [];
    const mixDelaysMs: number[] = [];
    for (let i = 0; i < audioClips.length; i++) {
      const clip = audioClips[i];
      const source = sources.find((s) => s.id === clip.sourceId)!;
      const duration = clip.sourceOut - clip.sourceIn;
      const rawInputName = `mix-in-${i}.dat`;
      const segName = `mix-seg-${i}.m4a`;
      await ff.writeFile(rawInputName, await fetchFile(source.url));
      const code = await ff.exec([
        "-ss", String(clip.sourceIn),
        "-t", String(duration),
        "-i", rawInputName,
        "-vn",
        "-c:a", "aac",
        "-ar", String(AUDIO_SAMPLE_RATE),
        "-ac", "2",
        segName,
      ]);
      await ff.deleteFile(rawInputName);
      if (code !== 0) continue; // source has no audio stream to extract - skip it
      mixInputNames.push(segName);
      mixDelaysMs.push(Math.round(mapTimeToExport(clip.start, segmentSpans) * 1000));
    }

    if (mixInputNames.length > 0) {
      const inputArgs: string[] = ["-i", finalOutputName];
      mixInputNames.forEach((name) => inputArgs.push("-i", name));

      const delayLabels = mixInputNames.map((_, i) => {
        const ms = Math.max(0, mixDelaysMs[i]);
        return `[${i + 1}:a]adelay=${ms}|${ms}[ad${i}]`;
      });
      const mixInputs = "[0:a]" + mixInputNames.map((_, i) => `[ad${i}]`).join("");
      const filterComplex =
        delayLabels.join(";") +
        `;${mixInputs}amix=inputs=${mixInputNames.length + 1}:duration=first:dropout_transition=0[aout]`;

      await ff.exec([
        ...inputArgs,
        "-filter_complex", filterComplex,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "mixoutput.mp4",
      ]);
      for (const name of mixInputNames) await ff.deleteFile(name);
      mixedOutputName = "mixoutput.mp4";
    }
  }
  onProgress?.(1);

  const data = await ff.readFile(mixedOutputName);

  for (const n of segmentNames) await ff.deleteFile(n);
  await ff.deleteFile("list.txt");
  await ff.deleteFile("output.mp4");
  if (compositedOutputName !== "output.mp4") await ff.deleteFile(compositedOutputName);
  if (finalOutputName !== "output.mp4" && finalOutputName !== compositedOutputName) {
    await ff.deleteFile(finalOutputName);
  }
  if (mixedOutputName !== finalOutputName) await ff.deleteFile(mixedOutputName);

  return new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
}
