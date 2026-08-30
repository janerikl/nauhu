import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { clipEnd, type Clip, type Track, type TimelineTransition, type TransitionType } from "./timeline-math";
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

  // A clip's own fade-to-black (see Clip.fadeOutBlack) is baked in here as
  // ffmpeg's native fade filter, timed relative to this segment's own
  // 0-based duration - it has nothing to do with a second clip, unlike the
  // (currently unimplemented in export) two-clip Transition blends.
  const fadeOutBlack = clip.fadeOutBlack && clip.fadeOutBlack > 0 ? Math.min(clip.fadeOutBlack, duration) : 0;
  const vf =
    fadeOutBlack > 0
      ? `${SCALE_FILTER},fade=t=out:st=${duration - fadeOutBlack}:d=${fadeOutBlack}:color=black`
      : SCALE_FILTER;

  const silentAudioArgs = ["-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`];
  const audioEncodeArgs = ["-c:a", "aac", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2"];

  if (!isImage && !clip.mutedVideo) {
    // Try to carry the clip's own embedded audio through first.
    const code = await ff.exec([
      ...args,
      "-vf", vf,
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
    "-vf", vf,
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

/** Builds the `-i` input args for a raw (unscaled) sub-range [subIn, subOut) of a clip's own source media. */
function subRangeInputArgs(source: MediaSource, subIn: number, subOut: number): string[] {
  const duration = subOut - subIn;
  return source.kind === "image"
    ? ["-loop", "1", "-t", String(duration)]
    : ["-ss", String(subIn), "-t", String(duration)];
}

/**
 * Encodes a silent (video-only), scale/pad/fps-normalized sub-range of a
 * clip's source - the common building block every transition type below
 * blends together. `subIn`/`subOut` are in the SOURCE's own time (i.e.
 * `clip.sourceIn`-relative), not timeline time.
 */
async function encodeNormalizedVideo(
  ff: FFmpeg,
  source: MediaSource,
  subIn: number,
  subOut: number,
  rawInputName: string,
  outputName: string
): Promise<void> {
  await ff.writeFile(rawInputName, await fetchFile(source.url));
  await ff.exec([
    ...subRangeInputArgs(source, subIn, subOut),
    "-i", rawInputName,
    "-vf", `${SCALE_FILTER},fps=${EXPORT_FPS}`,
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputName,
  ]);
  await ff.deleteFile(rawInputName);
}

/**
 * Named ffmpeg `xfade` transitions confirmed (by direct pixel-level testing
 * against this ffmpeg build) to reproduce the Preview's own compositeTransition
 * math exactly: `fade` is a plain linear alpha blend, `wiperight` reveals the
 * incoming clip growing from the left edge, `slideleft` translates the
 * outgoing clip left while the incoming clip enters from the right - all
 * confirmed frame-by-frame, not just at the transition's midpoint. `fadeToBlack`
 * and `zoom` have no built-in xfade equivalent that matches (fadeToBlack's
 * built-in "fadeblack" uses a different curve; there's no linear
 * simultaneous-fade+scale built-in at all) and are built separately below.
 */
function xfadeNameFor(type: TransitionType): "fade" | "wiperight" | "slideleft" | null {
  switch (type) {
    case "crossfade": return "fade";
    case "wipe": return "wiperight";
    case "slide": return "slideleft";
    default: return null;
  }
}

/** crossfade/wipe/slide: normalize each side's own last/first `duration` seconds, then blend with the matching named xfade transition. */
async function encodeXfadeTransitionVideo(
  ff: FFmpeg,
  xfadeName: "fade" | "wiperight" | "slideleft",
  duration: number,
  prevSource: MediaSource,
  prevSubIn: number,
  nextSource: MediaSource,
  nextSubIn: number,
  outputName: string
): Promise<void> {
  const aName = "trans-a.mp4";
  const bName = "trans-b.mp4";
  await encodeNormalizedVideo(ff, prevSource, prevSubIn, prevSubIn + duration, "trans-a-in", aName);
  await encodeNormalizedVideo(ff, nextSource, nextSubIn, nextSubIn + duration, "trans-b-in", bName);
  await ff.exec([
    "-i", aName,
    "-i", bName,
    "-filter_complex", `xfade=transition=${xfadeName}:duration=${duration}:offset=0`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputName,
  ]);
  await ff.deleteFile(aName);
  await ff.deleteFile(bName);
}

/**
 * A 2x2 solid-black PNG, generated once and reused as a fake still-image
 * "source" for fadeToBlack below. Built from a canvas rather than ffmpeg's
 * own `color=...` lavfi generator - that generator was found, by direct
 * testing, to leave ffmpeg's wasm heap in a state where the very next
 * unrelated encode call fails (reproducible across fresh page loads); a
 * plain image input goes through the same already-proven-stable `-loop 1`
 * path every still-image clip uses elsewhere in this file.
 */
let blackImageDataUrl: string | null = null;
function getBlackImageDataUrl(): string {
  if (blackImageDataUrl) return blackImageDataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, 2, 2);
  blackImageDataUrl = canvas.toDataURL("image/png");
  return blackImageDataUrl;
}

/**
 * fadeToBlack: built as two chained linear fades through an explicit black
 * clip (outgoing clip -> black over the first half, black -> incoming clip
 * over the second half), concatenated - this reproduces the Preview's own
 * two-phase fadeToBlack math exactly, using only the `fade` xfade transition
 * (verified linear/stable) rather than ffmpeg's differently-curved built-in
 * "fadeblack", or a hand-written per-pixel expression (found, by direct
 * testing, to hit float/rounding edge-case glitches near 0/1 progress).
 */
async function encodeFadeToBlackTransitionVideo(
  ff: FFmpeg,
  duration: number,
  prevSource: MediaSource,
  prevSubIn: number,
  nextSource: MediaSource,
  nextSubIn: number,
  outputName: string
): Promise<void> {
  const half = duration / 2;
  const aName = "trans-a.mp4";
  const bName = "trans-b.mp4";
  const black1Name = "trans-black1.mp4";
  const black2Name = "trans-black2.mp4";
  const blackSource: MediaSource = { id: "black", kind: "image", name: "black", url: getBlackImageDataUrl() } as MediaSource;
  await encodeNormalizedVideo(ff, prevSource, prevSubIn, prevSubIn + half, "trans-a-in", aName);
  await encodeNormalizedVideo(ff, nextSource, nextSubIn, nextSubIn + half, "trans-b-in", bName);
  await encodeNormalizedVideo(ff, blackSource, 0, half, "trans-black1-in", black1Name);
  await encodeNormalizedVideo(ff, blackSource, 0, half, "trans-black2-in", black2Name);
  await ff.exec([
    "-i", aName,
    "-i", bName,
    "-i", black1Name,
    "-i", black2Name,
    "-filter_complex",
    `[0:v][2:v]xfade=transition=fade:duration=${half}:offset=0[p1];` +
      `[3:v][1:v]xfade=transition=fade:duration=${half}:offset=0[p2];` +
      `[p1][p2]concat=n=2:v=1:a=0[vout]`,
    "-map", "[vout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputName,
  ]);
  await ff.deleteFile(aName);
  await ff.deleteFile(bName);
  await ff.deleteFile(black1Name);
  await ff.deleteFile(black2Name);
}

/**
 * zoom: the Preview simultaneously scales each side about its own center
 * (outgoing growing 1.0->1.3, incoming shrinking 1.3->1.0) while linearly
 * alpha-blending them - ffmpeg's declarative filter graph can't vary a
 * `scale` filter's output size continuously within one stream (its output
 * dimensions are fixed once negotiated), so this is instead rendered one
 * output frame at a time: each frame gets its own exact (static) scale
 * factor and blend weight computed in JS, then the still frames are
 * reassembled into a video. Slower than the other transitions, but exact.
 */
async function encodeZoomTransitionVideo(
  ff: FFmpeg,
  duration: number,
  prevSource: MediaSource,
  prevSubIn: number,
  nextSource: MediaSource,
  nextSubIn: number,
  outputName: string
): Promise<void> {
  const aName = "zoom-a.mp4";
  const bName = "zoom-b.mp4";
  await encodeNormalizedVideo(ff, prevSource, prevSubIn, prevSubIn + duration, "zoom-a-in", aName);
  await encodeNormalizedVideo(ff, nextSource, nextSubIn, nextSubIn + duration, "zoom-b-in", bName);

  const frameCount = Math.max(1, Math.round(duration * EXPORT_FPS));
  await ff.exec(["-i", aName, "-start_number", "0", "-vf", `fps=${EXPORT_FPS}`, "zoom-a-%04d.png"]);
  await ff.exec(["-i", bName, "-start_number", "0", "-vf", `fps=${EXPORT_FPS}`, "zoom-b-%04d.png"]);

  const pad = (n: number) => String(n).padStart(4, "0");
  for (let i = 0; i < frameCount; i++) {
    const p = frameCount > 1 ? i / (frameCount - 1) : 1;
    const scaleA = 1 + p * 0.3;
    const scaleB = 1.3 - p * 0.3;
    const wa = Math.round(EXPORT_WIDTH * scaleA);
    const ha = Math.round(EXPORT_HEIGHT * scaleA);
    const wb = Math.round(EXPORT_WIDTH * scaleB);
    const hb = Math.round(EXPORT_HEIGHT * scaleB);
    await ff.exec([
      "-i", `zoom-a-${pad(i)}.png`,
      "-i", `zoom-b-${pad(i)}.png`,
      "-filter_complex",
      `[0:v]scale=${wa}:${ha},crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT}[za];` +
        `[1:v]scale=${wb}:${hb},crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT}[zb];` +
        `[za][zb]blend=all_expr='A*(1-${p})+B*(${p})'`,
      "-frames:v", "1",
      `zoom-out-${pad(i)}.png`,
    ]);
    await ff.deleteFile(`zoom-a-${pad(i)}.png`);
    await ff.deleteFile(`zoom-b-${pad(i)}.png`);
  }

  await ff.exec([
    "-framerate", String(EXPORT_FPS),
    "-start_number", "0",
    "-i", "zoom-out-%04d.png",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputName,
  ]);
  for (let i = 0; i < frameCount; i++) await ff.deleteFile(`zoom-out-${pad(i)}.png`);
  await ff.deleteFile(aName);
  await ff.deleteFile(bName);
}

/**
 * Hard-cuts audio at the transition's midpoint (see the export-transitions
 * feature's audio scope: video blends, audio just cuts) - the outgoing
 * clip's own trailing audio for the first half, the incoming clip's own
 * leading audio for the second half, each falling back to silence if that
 * side's source has no audio stream, matching `encodeClipSegment`'s own
 * real-audio-then-silent-fallback approach.
 */
async function encodeTransitionAudio(
  ff: FFmpeg,
  duration: number,
  prevSource: MediaSource,
  prevSubIn: number,
  nextSource: MediaSource,
  nextSubIn: number,
  outputName: string
): Promise<void> {
  const half = duration / 2;
  const audioEncodeArgs = ["-c:a", "aac", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2"];

  async function encodeHalf(source: MediaSource, subIn: number, halfOutputName: string): Promise<void> {
    if (source.kind === "image") {
      await ff.exec([
        "-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
        "-t", String(half),
        ...audioEncodeArgs,
        halfOutputName,
      ]);
      return;
    }
    const rawInputName = `${halfOutputName}-in.dat`;
    await ff.writeFile(rawInputName, await fetchFile(source.url));
    const code = await ff.exec([
      "-ss", String(subIn), "-t", String(half), "-i", rawInputName,
      "-vn",
      ...audioEncodeArgs,
      halfOutputName,
    ]);
    await ff.deleteFile(rawInputName);
    if (code !== 0) {
      await ff.exec([
        "-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
        "-t", String(half),
        ...audioEncodeArgs,
        halfOutputName,
      ]);
    }
  }

  // prevSubIn marks the start of prevClip's own last `duration` seconds - its
  // trailing `half` (the audio's first half) starts `half` seconds later.
  await encodeHalf(prevSource, prevSubIn + half, "trans-audio-a.m4a");
  await encodeHalf(nextSource, nextSubIn, "trans-audio-b.m4a");
  await ff.writeFile("trans-audio-list.txt", "file 'trans-audio-a.m4a'\nfile 'trans-audio-b.m4a'\n");
  await ff.exec(["-f", "concat", "-safe", "0", "-i", "trans-audio-list.txt", "-c", "copy", outputName]);
  await ff.deleteFile("trans-audio-a.m4a");
  await ff.deleteFile("trans-audio-b.m4a");
  await ff.deleteFile("trans-audio-list.txt");
}

/**
 * Encodes one clip-pair Transition's full `duration`-second blended segment
 * (video + hard-cut audio, muxed together) - a drop-in replacement for a
 * plain concat boundary between `prevClip` and `nextClip`, using each side's
 * own last/first `duration` seconds of source.
 */
async function encodeTransitionSegment(
  ff: FFmpeg,
  type: TransitionType,
  duration: number,
  prevSource: MediaSource,
  prevSubIn: number,
  nextSource: MediaSource,
  nextSubIn: number,
  outputName: string
): Promise<void> {
  const videoName = "trans-video.mp4";
  const audioName = "trans-audio.m4a";
  const xfadeName = xfadeNameFor(type);
  if (xfadeName) {
    await encodeXfadeTransitionVideo(ff, xfadeName, duration, prevSource, prevSubIn, nextSource, nextSubIn, videoName);
  } else if (type === "fadeToBlack") {
    await encodeFadeToBlackTransitionVideo(ff, duration, prevSource, prevSubIn, nextSource, nextSubIn, videoName);
  } else {
    await encodeZoomTransitionVideo(ff, duration, prevSource, prevSubIn, nextSource, nextSubIn, videoName);
  }
  await encodeTransitionAudio(ff, duration, prevSource, prevSubIn, nextSource, nextSubIn, audioName);
  await ff.exec([
    "-i", videoName,
    "-i", audioName,
    "-map", "0:v",
    "-map", "1:a",
    "-c", "copy",
    outputName,
  ]);
  await ff.deleteFile(videoName);
  await ff.deleteFile(audioName);
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
  tracks: Track[] = [],
  transitions: TimelineTransition[] = []
): Promise<Blob> {
  const ff = await loadFFmpeg();
  const trackClips = clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
  if (trackClips.length === 0) throw new Error("No clips to export");

  // Only same-track transitions are blended here (cross-track transitions
  // already have a separate, unrelated meaning via the overlay-compositing
  // step below, and mixing the two would be a different feature).
  const trackClipIds = new Set(trackClips.map((c) => c.id));
  const tailTransitionByClipId = new Map<string, TimelineTransition>();
  const headTransitionByClipId = new Map<string, TimelineTransition>();
  for (const t of transitions) {
    if (t.trackId !== trackId) continue;
    if (!trackClipIds.has(t.prevClipId) || !trackClipIds.has(t.nextClipId)) continue;
    tailTransitionByClipId.set(t.prevClipId, t);
    headTransitionByClipId.set(t.nextClipId, t);
  }

  // A clip's own exported duration is its full sourceIn/sourceOut range minus
  // whatever head/tail is instead covered by an adjoining transition's own
  // blended segment (see below) - so the two never double-count the overlap.
  const ownDuration = (clip: Clip): number => {
    const head = headTransitionByClipId.get(clip.id)?.duration ?? 0;
    const tail = tailTransitionByClipId.get(clip.id)?.duration ?? 0;
    return Math.max(0, clip.sourceOut - clip.sourceIn - head - tail);
  };

  const exportableClips = trackClips.filter((c) => sources.find((s) => s.id === c.sourceId));
  const totalDuration =
    exportableClips.reduce((sum, c) => sum + ownDuration(c), 0) +
    [...tailTransitionByClipId.values()].reduce((sum, t) => sum + t.duration, 0);
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
  for (let i = 0; i < trackClips.length; i++) {
    const clip = trackClips[i];
    const source = sources.find((s) => s.id === clip.sourceId);
    if (!source) continue;

    // A head transition's blended segment was already produced while
    // processing the previous clip (as its tail transition, below) - this
    // clip only contributes its own reduced sourceIn/sourceOut range.
    const headTransition = headTransitionByClipId.get(clip.id);
    const duration = ownDuration(clip);
    if (duration > 0) {
      currentDuration = duration;
      const effectiveSourceIn = clip.sourceIn + (headTransition?.duration ?? 0);
      const effectiveClip: Clip = { ...clip, sourceIn: effectiveSourceIn, sourceOut: effectiveSourceIn + duration };

      const isImage = source.kind === "image";
      const ext = isImage ? "jpg" : "mp4";
      const inputName = `in-${i}.${ext}`;
      const outputName = `seg-${i}.mp4`;
      await ff.writeFile(inputName, await fetchFile(source.url));
      await encodeClipSegment(ff, effectiveClip, source, inputName, outputName);
      segmentNames.push(outputName);
      // NOTE: uses this clip's own (possibly transition-reduced) duration, not
      // its full sourceOut-sourceIn range - so text/overlay/audio clips whose
      // window falls inside a transition's overlap can be mistimed by up to
      // that transition's duration. A worthwhile trade against the
      // alternative (tracking sub-clip-precision spans through every
      // downstream mapping step) for how rarely that actually coincides.
      segmentSpans.push({ clip, outStart: durationDone, outEnd: durationDone + duration });
      await ff.deleteFile(inputName);
      durationDone += duration;
    }

    const tailTransition = tailTransitionByClipId.get(clip.id);
    if (tailTransition) {
      const nextClip = clips.find((c) => c.id === tailTransition.nextClipId);
      const nextSource = nextClip && sources.find((s) => s.id === nextClip.sourceId);
      if (nextClip && nextSource) {
        currentDuration = tailTransition.duration;
        const outputName = `seg-${i}-transition.mp4`;
        await encodeTransitionSegment(
          ff,
          tailTransition.type,
          tailTransition.duration,
          source,
          clip.sourceOut - tailTransition.duration,
          nextSource,
          nextClip.sourceIn,
          outputName
        );
        segmentNames.push(outputName);
        durationDone += tailTransition.duration;
      }
    }
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
