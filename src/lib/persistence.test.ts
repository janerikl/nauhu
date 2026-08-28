import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { saveProject, loadProject, clearProject } from "./persistence";
import type { Clip, Track } from "./timeline-math";
import type { MediaSource } from "../store/editorStore";

const tracks: Track[] = [
  { id: "video-1", name: "Video", kind: "video" },
  { id: "audio-1", name: "Audio", kind: "audio" },
];

const makeSource = (overrides: Partial<MediaSource> = {}): MediaSource => ({
  id: "src-1",
  name: "clip.mp4",
  url: "blob:fake-original",
  duration: 10,
  kind: "video",
  blob: new Blob(["fake video bytes"], { type: "video/mp4" }),
  ...overrides,
});

const makeClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: "clip-1",
  trackId: "video-1",
  sourceId: "src-1",
  sourceName: "clip.mp4",
  sourceIn: 0,
  sourceOut: 10,
  start: 0,
  color: "#6366f1",
  ...overrides,
});

describe("persistence", () => {
  beforeEach(async () => {
    await clearProject();
  });

  it("returns null when nothing has been saved", async () => {
    expect(await loadProject()).toBeNull();
  });

  it("round-trips tracks, clips, zoom, and source metadata", async () => {
    const source = makeSource();
    const clip = makeClip();

    await saveProject({ tracks, clips: [clip], zoom: 80, sources: [source] });
    const loaded = await loadProject();

    expect(loaded).not.toBeNull();
    expect(loaded!.tracks).toEqual(tracks);
    expect(loaded!.clips).toEqual([clip]);
    expect(loaded!.zoom).toBe(80);
    expect(loaded!.sources).toHaveLength(1);
    expect(loaded!.sources[0].id).toBe(source.id);
    expect(loaded!.sources[0].name).toBe(source.name);
    expect(loaded!.sources[0].duration).toBe(source.duration);
  });

  it("persists the actual media blob, not just a reference", async () => {
    const source = makeSource();
    await saveProject({ tracks, clips: [], zoom: 60, sources: [source] });

    const loaded = await loadProject();
    const loadedBlob = loaded!.sources[0].blob;
    const text = await loadedBlob.text();
    expect(text).toBe("fake video bytes");
    // A fresh object URL should be created for the reloaded blob, not reused verbatim.
    expect(loaded!.sources[0].url).not.toBe(source.url);
  });

  it("does not rewrite a media blob that was already saved", async () => {
    const source = makeSource();
    await saveProject({ tracks, clips: [], zoom: 60, sources: [source] });
    // Save again with the same source id but a different blob instance/content.
    const mutatedSource = makeSource({ blob: new Blob(["different bytes"]) });
    await saveProject({ tracks, clips: [], zoom: 60, sources: [mutatedSource] });

    const loaded = await loadProject();
    const text = await loaded!.sources[0].blob.text();
    expect(text).toBe("fake video bytes");
  });

  it("clearProject removes both project and media data", async () => {
    await saveProject({ tracks, clips: [makeClip()], zoom: 60, sources: [makeSource()] });
    await clearProject();
    expect(await loadProject()).toBeNull();
  });
});
