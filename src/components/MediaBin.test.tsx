/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MediaBin } from "./MediaBin";
import { useEditorStore } from "../store/editorStore";

/** Node's built-in global `localStorage` (guarded by --localstorage-file)
 * shadows jsdom's real Storage implementation in this environment, so swap
 * in a plain in-memory stand-in for tests instead of relying on the global. */
function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

const resetStore = () => {
  useEditorStore.setState({
    sources: [],
    tracks: [
      { id: "video-1", name: "Video", kind: "video" },
      { id: "audio-1", name: "Audio", kind: "audio" },
    ],
    clips: [],
  });
};

describe("MediaBin", () => {
  beforeEach(() => {
    resetStore();
    vi.stubGlobal("localStorage", makeMemoryStorage());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a distinct icon per media kind", () => {
    useEditorStore.getState().addSource({
      id: "src-img",
      name: "photo.png",
      url: "blob:fake",
      duration: 5,
      kind: "image",
      folder: "Ungrouped",
      blob: new Blob(),
    });
    useEditorStore.getState().addSource({
      id: "src-vid",
      name: "clip.mp4",
      url: "blob:fake",
      duration: 10,
      kind: "video",
      folder: "Ungrouped",
      blob: new Blob(),
    });
    useEditorStore.getState().addSource({
      id: "src-aud",
      name: "song.mp3",
      url: "blob:fake",
      duration: 20,
      kind: "audio",
      folder: "Ungrouped",
      blob: new Blob(),
    });

    render(<MediaBin />);

    const imageItem = screen.getByText("photo.png").closest(".media-item")!;
    const videoItem = screen.getByText("clip.mp4").closest(".media-item")!;
    const audioItem = screen.getByText("song.mp3").closest(".media-item")!;

    expect(imageItem.querySelector("svg.lucide-image")).toBeTruthy();
    expect(videoItem.querySelector("svg.lucide-video")).toBeTruthy();
    expect(audioItem.querySelector("svg.lucide-music")).toBeTruthy();
  });

  it("groups media items by folder with correct counts", () => {
    useEditorStore.getState().addSource({
      id: "src-1",
      name: "a.png",
      url: "blob:fake",
      duration: 5,
      kind: "image",
      folder: "Intro",
      blob: new Blob(),
    });
    useEditorStore.getState().addSource({
      id: "src-2",
      name: "b.png",
      url: "blob:fake",
      duration: 5,
      kind: "image",
      folder: "Intro",
      blob: new Blob(),
    });
    useEditorStore.getState().addSource({
      id: "src-3",
      name: "c.mp4",
      url: "blob:fake",
      duration: 5,
      kind: "video",
      folder: "B-roll",
      blob: new Blob(),
    });

    render(<MediaBin />);

    expect(screen.getByText("Intro")).toBeTruthy();
    expect(screen.getByText("B-roll")).toBeTruthy();
    const introHeader = screen.getByText("Intro").closest(".media-folder-header")!;
    expect(introHeader.textContent).toContain("2");
    const brollHeader = screen.getByText("B-roll").closest(".media-folder-header")!;
    expect(brollHeader.textContent).toContain("1");
  });

  it("collapses and expands a folder on click, hiding/showing its items", () => {
    useEditorStore.getState().addSource({
      id: "src-1",
      name: "a.png",
      url: "blob:fake",
      duration: 5,
      kind: "image",
      folder: "Intro",
      blob: new Blob(),
    });

    render(<MediaBin />);

    expect(screen.getByText("a.png")).toBeTruthy();

    fireEvent.click(screen.getByText("Intro"));
    expect(screen.queryByText("a.png")).toBeNull();

    fireEvent.click(screen.getByText("Intro"));
    expect(screen.getByText("a.png")).toBeTruthy();
  });

  it("persists collapsed folder state across remounts", () => {
    useEditorStore.getState().addSource({
      id: "src-1",
      name: "a.png",
      url: "blob:fake",
      duration: 5,
      kind: "image",
      folder: "Intro",
      blob: new Blob(),
    });

    const { unmount } = render(<MediaBin />);
    fireEvent.click(screen.getByText("Intro"));
    expect(screen.queryByText("a.png")).toBeNull();
    unmount();

    render(<MediaBin />);
    expect(screen.queryByText("a.png")).toBeNull();
  });
});
