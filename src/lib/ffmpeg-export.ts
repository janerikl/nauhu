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

/**
 * Exports the video track by trimming each clip to its in/out range and
 * concatenating them in timeline order, producing a single mp4.
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

  ff.on("progress", ({ progress }) => onProgress?.(progress));

  const segmentNames: string[] = [];
  for (let i = 0; i < trackClips.length; i++) {
    const clip = trackClips[i];
    const source = sources.find((s) => s.id === clip.sourceId);
    if (!source) continue;
    const inputName = `in-${i}.mp4`;
    const outputName = `seg-${i}.mp4`;
    await ff.writeFile(inputName, await fetchFile(source.url));
    await ff.exec([
      "-ss",
      String(clip.sourceIn),
      "-to",
      String(clip.sourceOut),
      "-i",
      inputName,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputName,
    ]);
    segmentNames.push(outputName);
  }

  const listContent = segmentNames.map((n) => `file '${n}'`).join("\n");
  await ff.writeFile("list.txt", listContent);
  await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "output.mp4"]);

  const data = await ff.readFile("output.mp4");
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
}
