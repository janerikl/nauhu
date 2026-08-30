import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  createProject,
  deleteProject,
  getLastActiveProjectId,
  listProjects,
  loadProjectById,
  renameProject,
  saveProjectById,
  setLastActiveProjectId,
} from "./persistence";
import type { Clip, Track } from "./timeline-math";
import type { MediaSource } from "../store/editorStore";

const tracks: Track[] = [
  { id: "video-1", name: "Video", kind: "video" },
  { id: "audio-1", name: "Audio", kind: "audio" },
];

const makeSource = (overrides: Partial<MediaSource> = {}): MediaSource => ({
  id: `src-${Math.random().toString(36).slice(2, 8)}`,
  name: "clip.mp4",
  url: "blob:fake-original",
  duration: 10,
  kind: "video",
  folder: "Ungrouped",
  addedAt: Date.now(),
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
  it("returns null loading an id that was never created", async () => {
    expect(await loadProjectById("does-not-exist")).toBeNull();
  });

  it("creates a project and round-trips tracks, clips, zoom, and source metadata", async () => {
    const id = await createProject("My Video");
    const source = makeSource();
    const clip = makeClip({ sourceId: source.id });

    await saveProjectById(id, "My Video", { tracks, clips: [clip], zoom: 80, sources: [source], folders: [], transitions: [] });
    const loaded = await loadProjectById(id);

    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("My Video");
    expect(loaded!.tracks).toEqual(tracks);
    expect(loaded!.clips).toEqual([clip]);
    expect(loaded!.zoom).toBe(80);
    expect(loaded!.sources).toHaveLength(1);
    expect(loaded!.sources[0].id).toBe(source.id);
    expect(loaded!.sources[0].name).toBe(source.name);
    expect(loaded!.sources[0].duration).toBe(source.duration);
  });

  it("persists the actual media blob, not just a reference", async () => {
    const id = await createProject("P1");
    const source = makeSource();
    await saveProjectById(id, "P1", { tracks, clips: [], zoom: 60, sources: [source], folders: [], transitions: [] });

    const loaded = await loadProjectById(id);
    const loadedBlob = loaded!.sources[0].blob;
    const text = await loadedBlob.text();
    expect(text).toBe("fake video bytes");
    // A fresh object URL should be created for the reloaded blob, not reused verbatim.
    expect(loaded!.sources[0].url).not.toBe(source.url);
  });

  it("does not rewrite a media blob that was already saved", async () => {
    const id = await createProject("P2");
    const source = makeSource();
    await saveProjectById(id, "P2", { tracks, clips: [], zoom: 60, sources: [source], folders: [], transitions: [] });
    // Save again with the same source id but a different blob instance/content.
    const mutatedSource = { ...source, blob: new Blob(["different bytes"]) };
    await saveProjectById(id, "P2", { tracks, clips: [], zoom: 60, sources: [mutatedSource], folders: [], transitions: [] });

    const loaded = await loadProjectById(id);
    const text = await loaded!.sources[0].blob.text();
    expect(text).toBe("fake video bytes");
  });

  it("keeps two projects' clips and media isolated from each other", async () => {
    const idA = await createProject("A");
    const idB = await createProject("B");
    const sourceA = makeSource({ name: "a.mp4" });
    const sourceB = makeSource({ name: "b.mp4" });
    const clipA = makeClip({ id: "clip-a", sourceId: sourceA.id });
    const clipB = makeClip({ id: "clip-b", sourceId: sourceB.id });

    await saveProjectById(idA, "A", { tracks, clips: [clipA], zoom: 60, sources: [sourceA], folders: [], transitions: [] });
    await saveProjectById(idB, "B", { tracks, clips: [clipB], zoom: 60, sources: [sourceB], folders: [], transitions: [] });

    const loadedA = await loadProjectById(idA);
    const loadedB = await loadProjectById(idB);
    expect(loadedA!.clips).toEqual([clipA]);
    expect(loadedB!.clips).toEqual([clipB]);
    expect(loadedA!.sources[0].name).toBe("a.mp4");
    expect(loadedB!.sources[0].name).toBe("b.mp4");
  });

  it("lists projects sorted by most recently updated", async () => {
    const idA = await createProject("First");
    await new Promise((r) => setTimeout(r, 2));
    const idB = await createProject("Second");

    const list = await listProjects();
    const ids = list.map((p) => p.id);
    expect(ids.indexOf(idB)).toBeLessThan(ids.indexOf(idA));
  });

  it("renames a project", async () => {
    const id = await createProject("Old Name");
    await renameProject(id, "New Name");
    const list = await listProjects();
    expect(list.find((p) => p.id === id)?.name).toBe("New Name");
  });

  it("deletes a project", async () => {
    const id = await createProject("Temp");
    await deleteProject(id);
    expect(await loadProjectById(id)).toBeNull();
  });

  it("tracks the last active project id", async () => {
    const id = await createProject("Active");
    await setLastActiveProjectId(id);
    expect(await getLastActiveProjectId()).toBe(id);
  });
});
