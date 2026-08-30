import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./editorStore";

const resetStore = () => {
  useEditorStore.setState({
    sources: [],
    folders: [],
    tracks: [
      { id: "video-1", name: "Video", kind: "video" },
      { id: "audio-1", name: "Audio", kind: "audio" },
    ],
    clips: [],
    playhead: 0,
    isPlaying: false,
    selectedClipId: null,
    transitions: [],
    undoStack: [],
    redoStack: [],
  });
};

describe("editorStore splitClipAtPlayhead", () => {
  beforeEach(resetStore);

  it("allows splitting the same original clip multiple times in sequence", () => {
    const { addSource, addClipToTimeline, splitClipAtPlayhead, setPlayhead } =
      useEditorStore.getState();

    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 10, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", "video-1");

    const originalId = useEditorStore.getState().clips[0].id;

    setPlayhead(4);
    splitClipAtPlayhead(originalId);
    expect(useEditorStore.getState().clips).toHaveLength(2);

    // Selection should now follow whichever piece the playhead landed in,
    // so a second split further along keeps working without reselecting.
    const selectedAfterFirstSplit = useEditorStore.getState().selectedClipId;
    expect(selectedAfterFirstSplit).not.toBeNull();

    setPlayhead(7);
    splitClipAtPlayhead(selectedAfterFirstSplit!);
    expect(useEditorStore.getState().clips).toHaveLength(3);

    const durations = useEditorStore
      .getState()
      .clips.map((c) => Number((c.sourceOut - c.sourceIn).toFixed(2)))
      .sort((a, b) => a - b);
    expect(durations).toEqual([3, 3, 4]);
  });
});

describe("editorStore trimClip", () => {
  beforeEach(resetStore);

  it("clamps the playhead back inside a clip trimmed shorter from the end", () => {
    const { addSource, addClipToTimeline, trimClip, setPlayhead } = useEditorStore.getState();

    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", "video-1");
    const clipId = useEditorStore.getState().clips[0].id;

    setPlayhead(9);
    trimClip(clipId, "out", 4);

    const state = useEditorStore.getState();
    const clip = state.clips[0];
    expect(state.playhead).toBeLessThan(4);
    expect(state.playhead).toBeGreaterThanOrEqual(clip.start);
  });

  it("clamps the playhead forward when trimming the in-point past it", () => {
    const { addSource, addClipToTimeline, trimClip, setPlayhead } = useEditorStore.getState();

    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", "video-1");
    const clipId = useEditorStore.getState().clips[0].id;

    setPlayhead(1);
    trimClip(clipId, "in", 5);

    const state = useEditorStore.getState();
    const clip = state.clips[0];
    expect(state.playhead).toBe(clip.start);
  });
});

describe("editorStore track management", () => {
  beforeEach(resetStore);

  it("adds additional video tracks with distinct ids and incrementing names", () => {
    const { addTrack } = useEditorStore.getState();
    addTrack("video");
    addTrack("video");

    const videoTracks = useEditorStore.getState().tracks.filter((t) => t.kind === "video");
    expect(videoTracks).toHaveLength(3);
    expect(new Set(videoTracks.map((t) => t.id)).size).toBe(3);
    expect(videoTracks.map((t) => t.name)).toEqual(["Video", "Video 2", "Video 3"]);
  });

  it("removing a track also removes its clips", () => {
    const { addTrack, addSource, addClipToTimeline, removeTrack } = useEditorStore.getState();
    addTrack("video");
    const newTrackId = useEditorStore.getState().tracks.at(-1)!.id;

    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 5, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", newTrackId);
    expect(useEditorStore.getState().clips).toHaveLength(1);

    removeTrack(newTrackId);
    expect(useEditorStore.getState().tracks.find((t) => t.id === newTrackId)).toBeUndefined();
    expect(useEditorStore.getState().clips).toHaveLength(0);
  });
});

describe("editorStore undo/redo", () => {
  beforeEach(resetStore);

  it("undoes and redoes adding a clip", () => {
    const { addSource, addClipToTimeline, undo, redo } = useEditorStore.getState();
    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 10, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", "video-1");
    expect(useEditorStore.getState().clips).toHaveLength(1);

    undo();
    expect(useEditorStore.getState().clips).toHaveLength(0);

    redo();
    expect(useEditorStore.getState().clips).toHaveLength(1);
  });

  it("restores a removed track and its clips on undo", () => {
    const { addTrack, addSource, addClipToTimeline, removeTrack, undo } = useEditorStore.getState();
    addTrack("video");
    const newTrackId = useEditorStore.getState().tracks.at(-1)!.id;
    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 5, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", newTrackId);

    removeTrack(newTrackId);
    expect(useEditorStore.getState().tracks.find((t) => t.id === newTrackId)).toBeUndefined();

    undo();
    const state = useEditorStore.getState();
    expect(state.tracks.find((t) => t.id === newTrackId)).toBeDefined();
    expect(state.clips).toHaveLength(1);
  });

  it("steps back through multiple actions in order and forward again", () => {
    const { addSource, addClipToTimeline, splitClipAtPlayhead, setPlayhead, undo, redo } =
      useEditorStore.getState();
    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 10, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });
    addClipToTimeline("src-1", "video-1");
    const clipId = useEditorStore.getState().clips[0].id;
    setPlayhead(4);
    splitClipAtPlayhead(clipId);
    expect(useEditorStore.getState().clips).toHaveLength(2);

    undo(); // undo split
    expect(useEditorStore.getState().clips).toHaveLength(1);
    undo(); // undo add clip
    expect(useEditorStore.getState().clips).toHaveLength(0);

    redo(); // redo add clip
    expect(useEditorStore.getState().clips).toHaveLength(1);
    redo(); // redo split
    expect(useEditorStore.getState().clips).toHaveLength(2);
  });

  it("clears the redo stack once a new action is taken after an undo", () => {
    const { addTrack, undo, redo } = useEditorStore.getState();
    addTrack("video");
    addTrack("video");
    undo();
    expect(useEditorStore.getState().redoStack).toHaveLength(1);

    addTrack("audio");
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
    redo();
    expect(useEditorStore.getState().tracks).toHaveLength(useEditorStore.getState().tracks.length);
  });

  it("clears undo/redo history on hydrate", () => {
    const { addTrack, hydrate } = useEditorStore.getState();
    addTrack("video");
    expect(useEditorStore.getState().undoStack.length).toBeGreaterThan(0);

    hydrate({
      id: "proj-1",
      name: "Other Project",
      tracks: [{ id: "video-1", name: "Video", kind: "video" }],
      clips: [],
      sources: [],
      zoom: 60,
    });

    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  it("does nothing when the undo/redo stacks are empty", () => {
    const { undo, redo } = useEditorStore.getState();
    const before = useEditorStore.getState();
    undo();
    redo();
    expect(useEditorStore.getState().clips).toEqual(before.clips);
    expect(useEditorStore.getState().tracks).toEqual(before.tracks);
  });
});

describe("editorStore addClipToTimeline track kind routing", () => {
  beforeEach(resetStore);

  it("routes a video source dropped on the audio track to a video track instead", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "audio-1");

    const clips = useEditorStore.getState().clips;
    const videoClip = clips.find((c) => c.trackId === "video-1");
    expect(videoClip).toBeDefined();
  });

  it("routes an audio source dropped on the video track to the audio track instead", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    addSource({ id: "src-1", name: "clip.mp3", url: "blob:fake", duration: 10, kind: "audio", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "video-1");

    const clips = useEditorStore.getState().clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].trackId).toBe("audio-1");
  });

  it("does nothing when no track of the required kind exists", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    useEditorStore.setState({ tracks: [{ id: "audio-1", name: "Audio", kind: "audio" }] });
    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "audio-1");

    expect(useEditorStore.getState().clips).toHaveLength(0);
  });

  it("keeps an image source on a video track", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    addSource({ id: "src-1", name: "photo.png", url: "blob:fake", duration: 5, kind: "image", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "video-1");

    const clips = useEditorStore.getState().clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].trackId).toBe("video-1");
  });
});

describe("editorStore addClipToTimeline video audio split", () => {
  beforeEach(resetStore);

  it("splits a video clip's audio onto the audio track and mutes the video clip", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "video-1", 2);

    const clips = useEditorStore.getState().clips;
    expect(clips).toHaveLength(2);

    const videoClip = clips.find((c) => c.trackId === "video-1")!;
    const audioClip = clips.find((c) => c.trackId === "audio-1")!;
    expect(videoClip.mutedVideo).toBe(true);
    expect(audioClip.mutedVideo).toBeFalsy();
    expect(audioClip.sourceId).toBe("src-1");
    expect(audioClip.start).toBe(2);
    expect(audioClip.sourceIn).toBe(videoClip.sourceIn);
    expect(audioClip.sourceOut).toBe(videoClip.sourceOut);
  });

  it("creates an audio track for the split when none exists", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    useEditorStore.setState({ tracks: [{ id: "video-1", name: "Video", kind: "video" }] });
    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "video-1");

    const state = useEditorStore.getState();
    const audioTrack = state.tracks.find((t) => t.kind === "audio");
    expect(audioTrack).toBeDefined();
    expect(state.clips.some((c) => c.trackId === audioTrack!.id)).toBe(true);
  });

  it("does not split audio for a plain audio-source clip", () => {
    const { addSource, addClipToTimeline } = useEditorStore.getState();
    addSource({ id: "src-1", name: "clip.mp3", url: "blob:fake", duration: 10, kind: "audio", folder: "Ungrouped", addedAt: Date.now(), blob: new Blob() });

    addClipToTimeline("src-1", "audio-1");

    const clips = useEditorStore.getState().clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].mutedVideo).toBeFalsy();
  });
});
