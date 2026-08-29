import { create } from "zustand";
import {
  type Clip,
  type Track,
  type TransitionType,
  type TimelineTransition,
  moveClip as moveClipMath,
  trimClip as trimClipMath,
  splitClip as splitClipMath,
  rippleDeleteClip as rippleDeleteClipMath,
  findClipAt,
  clipEnd,
  timelineDuration,
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
  transitions?: TimelineTransition[];
}

export type HydrateInput = HydrateData & { id: string; name: string };

const CLIP_COLORS = ["#6366f1", "#22c55e", "#f97316", "#ec4899", "#06b6d4", "#eab308"];
let colorIdx = 0;
const nextColor = () => CLIP_COLORS[colorIdx++ % CLIP_COLORS.length];

const MAX_HISTORY = 50;

/** The slice of state undo/redo restores - structural timeline/media edits, not playback or view state. */
interface HistorySnapshot {
  tracks: Track[];
  clips: Clip[];
  transitions: TimelineTransition[];
  sources: MediaSource[];
}

interface EditorState {
  sources: MediaSource[];
  tracks: Track[];
  clips: Clip[];
  playhead: number;
  isPlaying: boolean;
  selectedClipId: string | null;
  selectedTransitionId: string | null;
  copiedClip: Clip | null;
  zoom: number; // pixels per second
  /** User-placed transitions - independent timeline objects, not derived from clip geometry. */
  transitions: TimelineTransition[];

  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  /** Snapshots current undoable state onto the undo stack and clears redo. Call once per gesture (e.g. drag-start), not per intermediate update. */
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  addSource: (source: MediaSource) => void;
  addTrack: (kind: "video" | "audio") => void;
  removeTrack: (trackId: string) => void;
  addClipToTimeline: (sourceId: string, trackId: string, atStart?: number) => void;
  moveClip: (clipId: string, newStart: number, targetTrackId?: string) => void;
  trimClip: (clipId: string, edge: "in" | "out", time: number) => void;
  splitClipAtPlayhead: (clipId: string) => void;
  removeClip: (clipId: string) => void;
  copySelectedClip: () => void;
  pasteClip: () => void;
  addTransition: (input: {
    trackId: string;
    prevClipId: string;
    nextClipId: string;
    start: number;
    duration: number;
    type: TransitionType;
  }) => void;
  updateTransition: (id: string, patch: Partial<Pick<TimelineTransition, "start" | "duration" | "type">>) => void;
  removeTransition: (id: string) => void;
  selectClip: (clipId: string | null) => void;
  selectTransition: (transitionId: string | null) => void;
  setPlayhead: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setZoom: (zoom: number) => void;
  duration: () => number;

  saveStatus: "idle" | "saving" | "saved";
  setSaveStatus: (status: "idle" | "saving" | "saved") => void;

  projectId: string | null;
  projectName: string;
  setProjectName: (name: string) => void;

  hydrate: (data: HydrateInput) => void;
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
  selectedTransitionId: null,
  copiedClip: null,
  zoom: 60,
  transitions: [],

  undoStack: [],
  redoStack: [],

  pushHistory: () =>
    set((s) => ({
      undoStack: [
        ...s.undoStack,
        { tracks: s.tracks, clips: s.clips, transitions: s.transitions, sources: s.sources },
      ].slice(-MAX_HISTORY),
      redoStack: [],
    })),

  undo: () =>
    set((s) => {
      const snapshot = s.undoStack[s.undoStack.length - 1];
      if (!snapshot) return s;
      return {
        ...snapshot,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [
          ...s.redoStack,
          { tracks: s.tracks, clips: s.clips, transitions: s.transitions, sources: s.sources },
        ],
        selectedClipId: null,
        selectedTransitionId: null,
      };
    }),

  redo: () =>
    set((s) => {
      const snapshot = s.redoStack[s.redoStack.length - 1];
      if (!snapshot) return s;
      return {
        ...snapshot,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [
          ...s.undoStack,
          { tracks: s.tracks, clips: s.clips, transitions: s.transitions, sources: s.sources },
        ],
        selectedClipId: null,
        selectedTransitionId: null,
      };
    }),

  addSource: (source) => {
    get().pushHistory();
    set((s) => ({ sources: [...s.sources, source] }));
  },

  addTrack: (kind) => {
    get().pushHistory();
    set((s) => {
      const countOfKind = s.tracks.filter((t) => t.kind === kind).length;
      const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
      const label = kind === "video" ? "Video" : "Audio";
      return {
        tracks: [...s.tracks, { id, name: `${label} ${countOfKind + 1}`, kind }],
      };
    });
  },

  removeTrack: (trackId) => {
    get().pushHistory();
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
      clips: s.clips.filter((c) => c.trackId !== trackId),
    }));
  },

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
    get().pushHistory();
    set((s) => ({ clips: [...s.clips, clip] }));
  },

  // Not history-snapshotting: called on every mousemove while dragging a
  // clip. Callers snapshot once at drag-start instead.
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

  splitClipAtPlayhead: (clipId) => {
    get().pushHistory();
    set((s) => {
      const clip = s.clips.find((c) => c.id === clipId);
      const clips = clip ? splitClipMath(s.clips, clipId, s.playhead) : s.clips;
      const selectedClipId = clip
        ? (findClipAt(clips, clip.trackId, s.playhead)?.id ?? s.selectedClipId)
        : s.selectedClipId;
      return { clips, selectedClipId };
    });
  },

  removeClip: (clipId) => {
    get().pushHistory();
    set((s) => ({
      clips: rippleDeleteClipMath(s.clips, clipId),
      selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
      transitions: s.transitions.filter(
        (t) => t.prevClipId !== clipId && t.nextClipId !== clipId
      ),
    }));
  },

  copySelectedClip: () =>
    set((s) => {
      const clip = s.clips.find((c) => c.id === s.selectedClipId);
      return clip ? { copiedClip: clip } : s;
    }),

  pasteClip: () => {
    const { copiedClip, playhead } = get();
    if (!copiedClip) return;
    const id = `clip-${Math.random().toString(36).slice(2, 9)}`;
    const newClip: Clip = { ...copiedClip, id, start: playhead };
    get().pushHistory();
    set((s) => ({
      clips: moveClipMath([...s.clips, newClip], id, playhead, copiedClip.trackId),
      selectedClipId: id,
    }));
  },

  addTransition: (input) => {
    get().pushHistory();
    set((s) => ({
      transitions: [
        ...s.transitions,
        { id: `transition-${Math.random().toString(36).slice(2, 9)}`, ...input },
      ],
    }));
  },

  // Not history-snapshotting: called on every mousemove while dragging a
  // transition's body/handles. Callers snapshot once at drag-start instead.
  updateTransition: (id, patch) =>
    set((s) => ({
      transitions: s.transitions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  removeTransition: (id) => {
    get().pushHistory();
    set((s) => ({
      transitions: s.transitions.filter((t) => t.id !== id),
      selectedTransitionId: s.selectedTransitionId === id ? null : s.selectedTransitionId,
    }));
  },

  selectClip: (clipId) => set({ selectedClipId: clipId, selectedTransitionId: null }),
  selectTransition: (transitionId) => set({ selectedTransitionId: transitionId, selectedClipId: null }),
  setPlayhead: (time) => set({ playhead: Math.max(0, time) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setZoom: (zoom) => set({ zoom: Math.min(300, Math.max(10, zoom)) }),
  duration: () => timelineDuration(get().clips),

  saveStatus: "idle",
  setSaveStatus: (status) => set({ saveStatus: status }),

  projectId: null,
  projectName: "Untitled Project",
  setProjectName: (name) => set({ projectName: name }),

  hydrate: (data) =>
    set({
      projectId: data.id,
      projectName: data.name,
      tracks: data.tracks,
      clips: data.clips,
      sources: data.sources,
      zoom: data.zoom,
      playhead: 0,
      isPlaying: false,
      selectedClipId: null,
      selectedTransitionId: null,
      transitions: data.transitions ?? [],
      undoStack: [],
      redoStack: [],
    }),
}));
