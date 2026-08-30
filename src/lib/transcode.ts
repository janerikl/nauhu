import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { loadFFmpeg } from "./ffmpeg-export";

/** Codecs Chrome (esp. on Linux) generally can't decode natively, so the <video> element plays audio but renders no frame. */
const UNSUPPORTED_VIDEO_CODECS = ["hevc", "h265"];

/** Parses the codec name out of ffmpeg's stderr stream-info line, e.g. "Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080". */
export function parseVideoCodec(ffmpegLog: string): string | null {
  const match = ffmpegLog.match(/Stream #\d+:\d+(?:\[[^\]]+\])?(?:\(\w+\))?: Video: (\w+)/);
  return match ? match[1].toLowerCase() : null;
}

export function isUnsupportedVideoCodec(codec: string | null): boolean {
  return codec !== null && UNSUPPORTED_VIDEO_CODECS.includes(codec);
}

/** Runs `ffmpeg -i` on the file to read its stream info, without decoding/writing any output. */
async function probeVideoCodec(ff: FFmpeg, file: File): Promise<string | null> {
  const inputName = `probe-input-${Math.random().toString(36).slice(2, 9)}`;
  await ff.writeFile(inputName, await fetchFile(file));

  let log = "";
  const onLog = ({ message }: { message: string }) => {
    log += message + "\n";
  };
  ff.on("log", onLog);
  try {
    // `-i` with no output is expected to exit non-zero; the stream info we
    // need is printed to stderr before that failure.
    await ff.exec(["-i", inputName]).catch(() => {});
  } finally {
    ff.off("log", onLog);
    await ff.deleteFile(inputName).catch(() => {});
  }
  return parseVideoCodec(log);
}

/** Re-encodes the video stream to H.264 while copying audio untouched, for codecs the browser can't decode natively. */
async function transcodeToH264(ff: FFmpeg, file: File): Promise<Blob> {
  const inputName = `transcode-input-${Math.random().toString(36).slice(2, 9)}`;
  const outputName = `transcode-output-${Math.random().toString(36).slice(2, 9)}.mp4`;
  await ff.writeFile(inputName, await fetchFile(file));
  await ff.exec(["-i", inputName, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", outputName]);
  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});
  return new Blob([data as Uint8Array], { type: "video/mp4" });
}

/**
 * Ensures a video file is in a browser-decodable format. Returns the
 * original file untouched for already-supported codecs (the common case),
 * or a transcoded H.264 blob for codecs like HEVC that Chrome can't decode.
 */
export async function ensurePlayableVideo(
  file: File,
  onStatusChange?: (status: "probing" | "converting" | "done") => void
): Promise<File | Blob> {
  onStatusChange?.("probing");
  const ff = await loadFFmpeg();
  const codec = await probeVideoCodec(ff, file);
  if (!isUnsupportedVideoCodec(codec)) {
    onStatusChange?.("done");
    return file;
  }
  onStatusChange?.("converting");
  const blob = await transcodeToH264(ff, file);
  onStatusChange?.("done");
  return blob;
}
