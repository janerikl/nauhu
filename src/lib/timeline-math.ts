export interface TextClipStyle {
  content: string;
  fontSize: number;
  color: string;
  fontFamily: string;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  /** fade in/out duration, seconds (0 disables) */
  fadeIn: number;
  fadeOut: number;
}

export interface Clip {
  id: string;
  trackId: string;
  sourceId: string;
  sourceName: string;
  /** offset into the source media where this clip's content starts, seconds */
  sourceIn: number;
  /** offset into the source media where this clip's content ends, seconds */
  sourceOut: number;
  /** position on the timeline, seconds */
  start: number;
  color: string;
  /** present only for clips on a "text" track - styling for the on-screen text overlay */
  text?: TextClipStyle;
}

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio" | "text";
}

export type TransitionType = "crossfade" | "fadeToBlack" | "wipe" | "slide" | "zoom";

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  crossfade: "Crossfade",
  fadeToBlack: "Fade to black",
  wipe: "Wipe",
  slide: "Slide",
  zoom: "Zoom",
};

/** Custom drag-and-drop MIME type used to drag a transition chip onto the timeline. */
export const TRANSITION_DND_TYPE = "application/x-transition-type";

/** A transition formed by two adjacent clips on the same track overlapping in time. */
export interface Overlap {
  trackId: string;
  prevClip: Clip;
  nextClip: Clip;
  /** timeline seconds where the overlap begins (== nextClip.start) */
  start: number;
  /** timeline seconds where the overlap ends (== clipEnd(prevClip)) */
  end: number;
  duration: number;
}

/**
 * A user-placed transition: an independent timeline object with its own
 * position/duration, not derived from the two clips' current geometry. It
 * stays put (and renders "inactive") if the clips are moved apart, and only
 * actually blends video during playback while its two clips genuinely
 * overlap in time - see `findActivePair`/`findCrossTrackActivePair`.
 */
export interface TimelineTransition {
  id: string;
  trackId: string;
  prevClipId: string;
  nextClipId: string;
  /** timeline seconds where the block starts */
  start: number;
  duration: number;
  type: TransitionType;
}

export const clipDuration = (clip: Clip) => clip.sourceOut - clip.sourceIn;
export const clipEnd = (clip: Clip) => clip.start + clipDuration(clip);

export function timelineDuration(clips: Clip[]): number {
  return clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/**
 * A clip may overlap a neighbor by at most this fraction of the shorter of
 * the two clips' durations - enough room for a transition, while always
 * leaving both clips at least partially exposed on their own.
 */
const MAX_OVERLAP_FRACTION = 0.9;

/**
 * Move a clip to a new start time (clamped to >= 0) and, optionally, onto a
 * different track. Clips may overlap a neighbor (the overlapped region
 * becomes a transition, see `getOverlaps`) up to MAX_OVERLAP_FRACTION of the
 * shorter clip's duration; beyond that the move is clamped so it can't pass
 * through a neighbor entirely.
 */
export function moveClip(
  clips: Clip[],
  clipId: string,
  newStart: number,
  targetTrackId?: string
): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const trackId = targetTrackId ?? clip.trackId;
  const duration = clipDuration(clip);
  const siblings = clips.filter((c) => c.trackId === trackId && c.id !== clipId);

  let resolvedStart = Math.max(0, newStart);
  for (const s of siblings) {
    const maxOverlap = Math.min(duration, clipDuration(s)) * MAX_OVERLAP_FRACTION;
    const proposedEnd = resolvedStart + duration;
    const overlap = Math.min(proposedEnd, clipEnd(s)) - Math.max(resolvedStart, s.start);
    if (overlap <= maxOverlap) continue;

    resolvedStart =
      resolvedStart >= s.start
        ? clipEnd(s) - maxOverlap
        : s.start + maxOverlap - duration;
  }
  resolvedStart = Math.max(0, resolvedStart);

  return clips.map((c) => (c.id === clipId ? { ...c, start: resolvedStart, trackId } : c));
}

/**
 * Finds every pair of time-adjacent clips on the same track whose ranges
 * overlap - each such pair forms a transition region.
 */
export function getOverlaps(clips: Clip[], tracks: Track[]): Overlap[] {
  const overlaps: Overlap[] = [];
  for (const track of tracks) {
    const onTrack = clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
    for (let i = 0; i < onTrack.length - 1; i++) {
      const prevClip = onTrack[i];
      const nextClip = onTrack[i + 1];
      const start = nextClip.start;
      const end = clipEnd(prevClip);
      if (end > start) {
        overlaps.push({ trackId: track.id, prevClip, nextClip, start, end, duration: end - start });
      }
    }
  }
  return overlaps;
}

export const transitionKey = (prevClipId: string, nextClipId: string) => `${prevClipId}->${nextClipId}`;

/**
 * Cross-track transitions are opt-in: unlike same-track overlaps (which are
 * unambiguous - two clips can't both play from one lane, so any overlap
 * there must be a transition), two clips on different tracks that overlap in
 * time are normally just layered content (PIP, overlays, B-roll). Only a
 * pair the user has explicitly given a transitionTypes entry (via the
 * add-transition button or dragging a transition chip) is treated as a
 * transition; every other cross-track overlap keeps rendering as ordinary
 * layered tracks.
 */
export function getDeclaredCrossTrackOverlaps(
  clips: Clip[],
  tracks: Track[],
  transitions: TimelineTransition[]
): Overlap[] {
  const videoTrackIds = new Set(tracks.filter((t) => t.kind === "video").map((t) => t.id));
  const overlaps: Overlap[] = [];
  for (const transition of transitions) {
    const prevClip = clips.find((c) => c.id === transition.prevClipId);
    const nextClip = clips.find((c) => c.id === transition.nextClipId);
    if (!prevClip || !nextClip) continue;
    if (prevClip.trackId === nextClip.trackId) continue; // same-track case is handled by getOverlaps
    if (!videoTrackIds.has(prevClip.trackId) || !videoTrackIds.has(nextClip.trackId)) continue;
    const start = nextClip.start;
    const end = clipEnd(prevClip);
    if (end > start) {
      overlaps.push({ trackId: nextClip.trackId, prevClip, nextClip, start, end, duration: end - start });
    }
  }
  return overlaps;
}

/** Finds the declared cross-track transition (if any) active at `time`, for preview compositing. */
export function findCrossTrackActivePair(
  clips: Clip[],
  tracks: Track[],
  transitions: TimelineTransition[],
  time: number
): { primary: Clip; secondary: Clip } | undefined {
  const hit = getDeclaredCrossTrackOverlaps(clips, tracks, transitions).find(
    (o) => time >= o.start && time < o.end
  );
  return hit ? { primary: hit.prevClip, secondary: hit.nextClip } : undefined;
}

/** Looks up the declared type for a clip-pair transition, defaulting to crossfade if undeclared. */
export function getTransitionType(
  transitions: TimelineTransition[],
  prevClipId: string,
  nextClipId: string
): TransitionType {
  return (
    transitions.find((t) => t.prevClipId === prevClipId && t.nextClipId === nextClipId)?.type ??
    "crossfade"
  );
}

/** Trim the left (in) or right (out) edge of a clip by dragging to `time` (timeline seconds). */
export function trimClip(
  clips: Clip[],
  clipId: string,
  edge: "in" | "out",
  time: number
): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const MIN_DURATION = 0.1;

  if (edge === "in") {
    const maxIn = clip.sourceOut - MIN_DURATION;
    const delta = time - clip.start;
    const newSourceIn = Math.min(maxIn, Math.max(0, clip.sourceIn + delta));
    const actualDelta = newSourceIn - clip.sourceIn;
    return clips.map((c) =>
      c.id === clipId
        ? { ...c, sourceIn: newSourceIn, start: Math.max(0, c.start + actualDelta) }
        : c
    );
  } else {
    const minOut = clip.sourceIn + MIN_DURATION;
    const newSourceOut = Math.max(minOut, clip.sourceIn + (time - clip.start));
    return clips.map((c) => (c.id === clipId ? { ...c, sourceOut: newSourceOut } : c));
  }
}

/** Split a clip at an absolute timeline position into two clips. */
export function splitClip(clips: Clip[], clipId: string, atTime: number): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  if (atTime <= clip.start || atTime >= clipEnd(clip)) return clips;

  const splitOffset = atTime - clip.start;
  const firstOut = clip.sourceIn + splitOffset;

  const first: Clip = { ...clip, sourceOut: firstOut };
  const second: Clip = {
    ...clip,
    id: `${clip.id}-split-${Math.random().toString(36).slice(2, 8)}`,
    sourceIn: firstOut,
    start: atTime,
  };

  return clips.flatMap((c) => (c.id === clipId ? [first, second] : [c]));
}

export function removeClip(clips: Clip[], clipId: string): Clip[] {
  return clips.filter((c) => c.id !== clipId);
}

/** Ripple-delete: remove clip and shift later clips on the same track left to close the gap. */
export function rippleDeleteClip(clips: Clip[], clipId: string): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const duration = clipDuration(clip);
  return clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.trackId === clip.trackId && c.start >= clipEnd(clip)
        ? { ...c, start: c.start - duration }
        : c
    );
}

export function findClipAt(clips: Clip[], trackId: string, time: number): Clip | undefined {
  return clips.find((c) => c.trackId === trackId && time >= c.start && time < clipEnd(c));
}

/**
 * Finds the clip(s) that should be visible at `time` on a single track. When
 * `time` falls inside an overlap between two clips, both are returned:
 * `primary` (the outgoing clip, earlier start) and `secondary` (the incoming
 * clip being transitioned to).
 */
export function findClipPairAt(
  clips: Clip[],
  trackId: string,
  time: number
): { primary: Clip | undefined; secondary: Clip | undefined } {
  const matches = clips
    .filter((c) => c.trackId === trackId && time >= c.start && time < clipEnd(c))
    .sort((a, b) => a.start - b.start);
  return { primary: matches[0], secondary: matches[1] };
}

/**
 * Finds the clip that should be visible at `time` across all tracks of the
 * given kind, in track order — the first (topmost) track with a clip
 * covering `time` wins, matching standard layer-compositing behavior.
 */
export function findActiveClip(
  clips: Clip[],
  tracks: Track[],
  kind: Track["kind"],
  time: number
): Clip | undefined {
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const clip = findClipAt(clips, track.id, time);
    if (clip) return clip;
  }
  return undefined;
}

/**
 * Like `findActiveClip`, but also returns the incoming clip when `time`
 * falls inside a transition overlap on the winning track.
 */
export function findActivePair(
  clips: Clip[],
  tracks: Track[],
  kind: Track["kind"],
  time: number
): { primary: Clip | undefined; secondary: Clip | undefined } {
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const pair = findClipPairAt(clips, track.id, time);
    if (pair.primary) return pair;
  }
  return { primary: undefined, secondary: undefined };
}

/** Collects candidate snap times: every other clip's start/end, plus any extra points (e.g. playhead, 0). */
export function collectSnapPoints(
  clips: Clip[],
  excludeClipId: string,
  extra: number[] = []
): number[] {
  const points = new Set<number>(extra);
  for (const c of clips) {
    if (c.id === excludeClipId) continue;
    points.add(c.start);
    points.add(clipEnd(c));
  }
  return Array.from(points);
}

/** Snaps a single time value to the nearest snap point within `threshold`, otherwise returns it unchanged. */
export function snapValue(value: number, snapPoints: number[], threshold: number): number {
  let best = value;
  let bestDist = threshold;
  for (const p of snapPoints) {
    const dist = Math.abs(value - p);
    if (dist <= bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * Snaps a clip's proposed start time so that either its start OR its end
 * edge lands on a snap point, whichever is closer, within `threshold`.
 */
export function snapMoveStart(
  rawStart: number,
  duration: number,
  snapPoints: number[],
  threshold: number
): number {
  let bestStart = rawStart;
  let bestDist = threshold;
  for (const p of snapPoints) {
    const startDist = Math.abs(rawStart - p);
    if (startDist <= bestDist) {
      bestDist = startDist;
      bestStart = p;
    }
    const endDist = Math.abs(rawStart + duration - p);
    if (endDist <= bestDist) {
      bestDist = endDist;
      bestStart = p - duration;
    }
  }
  return bestStart;
}
