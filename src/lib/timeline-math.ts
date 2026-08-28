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
}

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio" | "text";
}

export const clipDuration = (clip: Clip) => clip.sourceOut - clip.sourceIn;
export const clipEnd = (clip: Clip) => clip.start + clipDuration(clip);

export function timelineDuration(clips: Clip[]): number {
  return clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/**
 * Move a clip to a new start time (clamped to >= 0) and, optionally, onto a
 * different track. No overlap with siblings on the destination track.
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
  const clampedStart = Math.max(0, newStart);
  const siblings = clips.filter((c) => c.trackId === trackId && c.id !== clipId);

  let resolvedStart = clampedStart;
  for (const s of siblings) {
    const overlaps = resolvedStart < clipEnd(s) && resolvedStart + duration > s.start;
    if (overlaps) {
      const pushRight = Math.abs(clampedStart - clipEnd(s));
      const pushLeft = Math.abs(clampedStart - (s.start - duration));
      resolvedStart = pushRight <= pushLeft ? clipEnd(s) : Math.max(0, s.start - duration);
    }
  }

  return clips.map((c) => (c.id === clipId ? { ...c, start: resolvedStart, trackId } : c));
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
