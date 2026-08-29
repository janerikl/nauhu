import { create } from "zustand";
import {
  type Clip,
  type Track,
  type TransitionType,
  moveClip as moveClipMath,
  trimClip as trimClipMath,
  splitClip as splitClipMath,
  rippleDeleteClip as rippleDeleteClipMath,
  findClipAt,
  clipEnd,
  timelineDuration,
  transitionKey,
} from "../lib/timeline-math";

export interface MediaSource {
  id: string;
  name: string;
  url: string;
  duration: number;
  kind: "video" | "audio" | "image";
  thumbnail?: string;
  /** The raw file data, kept in memory so it can be persisted (e.g. to IndexedDB). */
  blob: Blob;
}

export interface HydrateData {
  tracks: Track[];
  clips: Clip[];
  sources: MediaSource[];
  zoom: number;
}

const CLIP_COLORS = ["#6366f1", "#22c55e", "#f97316", "#ec4899", "#06b6d4", "#eab308"];
let colorIdx = 0;
const nextColor = () => CLIP_COLORS[colorIdx++ % CLIP_COLORS.length];

interface EditorState {
  sources: MediaSource[];
  tracks: Track[];
  clips: Clip[];
  playhead: number;
  isPlaying: boolean;
  selectedClipId: string | null;
  zoom: number; // pixels per second
  /** transition type for an overlap, keyed by transitionKey(prevClipId, nextClipId). Defaults to "crossfade" when absent. */
  transitionTypes: Record<string, TransitionType>;

  addSource: (source: MediaSource) => void;
  addTrack: (kind: "video" | "audio") => void;
  removeTrack: (trackId: string) => void;
  addClipToTimeline: (sourceId: string, trackId: string, atStart?: number) => void;
  moveClip: (clipId: string, newStart: number, targetTrackId?: string) => void;
  trimClip: (clipId: string, edge: "in" | "out", time: number) => void;
  splitClipAtPlayhead: (clipId: string) => void;
  removeClip: (clipId: string) => void;
  setTransitionType: (prevClipId: string, nextClipId: string, type: TransitionType) => void;
  selectClip: (clipId: string | null) => void;
  setPlayhead: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setZoom: (zoom: number) => void;
  duration: () => number;

  saveStatus: "idle" | "saving" | "saved";
  setSaveStatus: (status: "idle" | "saving" | "saved") => void;
  hydrate: (data: HydrateData) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  sources: [],
  tracks: [
    { id: "video-1", name: "Video", kind: "video" },
    { id: "audio-1", name: "Audio", kind: "audio" },
  ],
  clips: [],
  playhead: 0,
  isPlaying: false,
  selectedClipId: null,
  zoom: 60,
  transitionTypes: {},

  addSource: (source) => set((s) => ({ sources: [...s.sources, source] })),

  addTrack: (kind) =>
    set((s) => {
      const countOfKind = s.tracks.filter((t) => t.kind === kind).length;
      const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
      const label = kind === "video" ? "Video" : "Audio";
      return {
        tracks: [...s.tracks, { id, name: `${label} ${countOfKind + 1}`, kind }],
      };
    }),

  removeTrack: (trackId) =>
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
      clips: s.clips.filter((c) => c.trackId !== trackId),
    })),

  addClipToTimeline: (sourceId, trackId, atStart) => {
    const source = get().sources.find((s) => s.id === sourceId);
    if (!source) return;
    const existing = get().clips.filter((c) => c.trackId === trackId);
    const start =
      atStart ?? existing.reduce((max, c) => Math.max(max, c.start + (c.sourceOut - c.sourceIn)), 0);
    const clip: Clip = {
      id: `clip-${Math.random().toString(36).slice(2, 9)}`,
      trackId,
      sourceId: source.id,
      sourceName: source.name,
      sourceIn: 0,
      sourceOut: source.duration,
      start,
      color: nextColor(),
    };
    set((s) => ({ clips: [...s.clips, clip] }));
  },

  moveClip: (clipId, newStart, targetTrackId) =>
    set((s) => ({ clips: moveClipMath(s.clips, clipId, newStart, targetTrackId) })),

  trimClip: (clipId, edge, time) =>
    set((s) => {
      const clips = trimClipMath(s.clips, clipId, edge, time);
      const clip = clips.find((c) => c.id === clipId);
      let playhead = s.playhead;
      if (clip) {
        const end = clipEnd(clip);
        if (playhead >= end) playhead = Math.max(clip.start, end - 0.001);
        else if (playhead < clip.start) playhead = clip.start;
      }
      return { clips, playhead };
    }),

  splitClipAtPlayhead: (clipId) =>
    set((s) => {
      const clip = s.clips.find((c) => c.id === clipId);
      const clips = clip ? splitClipMath(s.clips, clipId, s.playhead) : s.clips;
      const selectedClipId = clip
        ? (findClipAt(clips, clip.trackId, s.playhead)?.id ?? s.selectedClipId)
        : s.selectedClipId;
      return { clips, selectedClipId };
    }),

  removeClip: (clipId) =>
    set((s) => ({
      clips: rippleDeleteClipMath(s.clips, clipId),
      selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
      transitionTypes: Object.fromEntries(
        Object.entries(s.transitionTypes).filter(([k]) => !k.includes(clipId))
      ),
    })),

  setTransitionType: (prevClipId, nextClipId, type) =>
    set((s) => ({
      transitionTypes: { ...s.transitionTypes, [transitionKey(prevClipId, nextClipId)]: type },
    })),

  selectClip: (clipId) => set({ selectedClipId: clipId }),
  setPlayhead: (time) => set({ playhead: Math.max(0, time) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setZoom: (zoom) => set({ zoom: Math.min(300, Math.max(10, zoom)) }),
  duration: () => timelineDuration(get().clips),

  saveStatus: "idle",
  setSaveStatus: (status) => set({ saveStatus: status }),
  hydrate: (data) =>
    set({
      tracks: data.tracks,
      clips: data.clips,
      sources: data.sources,
      zoom: data.zoom,
      playhead: 0,
      isPlaying: false,
      selectedClipId: null,
    }),
}));
