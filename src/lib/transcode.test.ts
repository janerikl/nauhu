import { describe, it, expect } from "vitest";
import { parseVideoCodec, isUnsupportedVideoCodec } from "./transcode";

const HEVC_LOG = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'probe-input':
  Duration: 00:00:05.02, start: 0.000000, bitrate: 24169 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), yuv420p(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 23910 kb/s, 59.94 fps, 59.94 tbr, 90k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)`;

const H264_LOG = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'probe-input':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 5000 kb/s, 30 fps, 30 tbr, 90k tbn (default)
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`;

const AUDIO_ONLY_LOG = `Input #0, mp3, from 'probe-input':
  Duration: 00:00:03.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s`;

describe("parseVideoCodec", () => {
  it("extracts hevc from a Samsung-style HEVC stream log", () => {
    expect(parseVideoCodec(HEVC_LOG)).toBe("hevc");
  });

  it("extracts h264 from a standard H.264 stream log", () => {
    expect(parseVideoCodec(H264_LOG)).toBe("h264");
  });

  it("returns null when there is no video stream", () => {
    expect(parseVideoCodec(AUDIO_ONLY_LOG)).toBeNull();
  });
});

describe("isUnsupportedVideoCodec", () => {
  it("flags hevc as unsupported", () => {
    expect(isUnsupportedVideoCodec("hevc")).toBe(true);
  });

  it("does not flag h264 as unsupported", () => {
    expect(isUnsupportedVideoCodec("h264")).toBe(false);
  });

  it("does not flag null (no video stream) as unsupported", () => {
    expect(isUnsupportedVideoCodec(null)).toBe(false);
  });
});
