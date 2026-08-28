import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./editorStore";

const resetStore = () => {
  useEditorStore.setState({
    sources: [],
    tracks: [
      { id: "video-1", name: "Video", kind: "video" },
      { id: "audio-1", name: "Audio", kind: "audio" },
    ],
    clips: [],
    playhead: 0,
    isPlaying: false,
    selectedClipId: null,
  });
};

describe("editorStore splitClipAtPlayhead", () => {
  beforeEach(resetStore);

  it("allows splitting the same original clip multiple times in sequence", () => {
    const { addSource, addClipToTimeline, splitClipAtPlayhead, setPlayhead } =
      useEditorStore.getState();

    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 10, kind: "video", blob: new Blob() });
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

    addSource({ id: "src-1", name: "clip.mp4", url: "blob:fake", duration: 5, kind: "video", blob: new Blob() });
    addClipToTimeline("src-1", newTrackId);
    expect(useEditorStore.getState().clips).toHaveLength(1);

    removeTrack(newTrackId);
    expect(useEditorStore.getState().tracks.find((t) => t.id === newTrackId)).toBeUndefined();
    expect(useEditorStore.getState().clips).toHaveLength(0);
  });
});
