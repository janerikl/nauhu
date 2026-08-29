import { describe, it, expect } from "vitest";
import {
  type Clip,
  type Track,
  clipEnd,
  moveClip,
  trimClip,
  splitClip,
  rippleDeleteClip,
  timelineDuration,
  findActiveClip,
  findActivePair,
  getOverlaps,
  collectSnapPoints,
  snapValue,
  snapMoveStart,
} from "./timeline-math";

const makeClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: "c1",
  trackId: "t1",
  sourceId: "s1",
  sourceName: "video.mp4",
  sourceIn: 0,
  sourceOut: 10,
  start: 0,
  color: "#000",
  ...overrides,
});

describe("splitClip", () => {
  it("splits a clip into two at the given time", () => {
    const clips = [makeClip({ sourceOut: 10, start: 0 })];
    const result = splitClip(clips, "c1", 4);
    expect(result).toHaveLength(2);
    expect(result[0].sourceIn).toBe(0);
    expect(result[0].sourceOut).toBe(4);
    expect(result[1].sourceIn).toBe(4);
    expect(result[1].sourceOut).toBe(10);
    expect(result[1].start).toBe(4);
  });

  it("is a no-op when split point is outside the clip", () => {
    const clips = [makeClip({ sourceOut: 10, start: 0 })];
    expect(splitClip(clips, "c1", 0)).toEqual(clips);
    expect(splitClip(clips, "c1", 10)).toEqual(clips);
    expect(splitClip(clips, "c1", -5)).toEqual(clips);
  });
});

describe("trimClip", () => {
  it("trims the in-point without moving unaffected clips", () => {
    const clips = [makeClip({ sourceIn: 0, sourceOut: 10, start: 0 })];
    const result = trimClip(clips, "c1", "in", 3);
    expect(result[0].sourceIn).toBe(3);
    expect(result[0].start).toBe(3);
    expect(result[0].sourceOut).toBe(10);
  });

  it("trims the out-point", () => {
    const clips = [makeClip({ sourceIn: 0, sourceOut: 10, start: 0 })];
    const result = trimClip(clips, "c1", "out", 6);
    expect(result[0].sourceOut).toBe(6);
    expect(result[0].sourceIn).toBe(0);
  });

  it("never trims past minimum duration", () => {
    const clips = [makeClip({ sourceIn: 0, sourceOut: 10, start: 0 })];
    const result = trimClip(clips, "c1", "in", 15);
    expect(result[0].sourceOut - result[0].sourceIn).toBeGreaterThanOrEqual(0.099);
  });
});

describe("moveClip", () => {
  it("moves a clip to a new start time when no collision", () => {
    const clips = [makeClip({ start: 0, sourceOut: 5 })];
    const result = moveClip(clips, "c1", 10);
    expect(result[0].start).toBe(10);
  });

  it("clamps negative start to 0", () => {
    const clips = [makeClip({ start: 5, sourceOut: 5 })];
    const result = moveClip(clips, "c1", -3);
    expect(result[0].start).toBe(0);
  });

  it("allows a bounded overlap with a neighbor (for a transition)", () => {
    const clips = [
      makeClip({ id: "a", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "t1", start: 20, sourceIn: 0, sourceOut: 5 }),
    ];
    const result = moveClip(clips, "b", 2);
    const a = result.find((c) => c.id === "a")!;
    const b = result.find((c) => c.id === "b")!;
    const overlap = Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.start, b.start);
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThanOrEqual(5 * 0.9 + 1e-9);
  });

  it("clamps overlap so a clip can never fully pass through a neighbor", () => {
    const clips = [
      makeClip({ id: "a", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "t1", start: 20, sourceIn: 0, sourceOut: 5 }),
    ];
    const result = moveClip(clips, "b", 0);
    const a = result.find((c) => c.id === "a")!;
    const b = result.find((c) => c.id === "b")!;
    const overlap = Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.start, b.start);
    expect(overlap).toBeLessThanOrEqual(5 * 0.9 + 1e-9);
    // both clips remain at least partially exposed on their own
    expect(b.start + 5 > clipEnd(a) || a.start < b.start).toBe(true);
  });

  it("moves a clip onto a different track when a target track is given", () => {
    const clips = [makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 })];
    const result = moveClip(clips, "a", 3, "video-2");
    expect(result[0].trackId).toBe("video-2");
    expect(result[0].start).toBe(3);
  });

  it("resolves overlap against siblings on the destination track, not the origin track, bounded to avoid full pass-through", () => {
    const clips = [
      makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "video-2", start: 10, sourceIn: 0, sourceOut: 16 }),
    ];
    const result = moveClip(clips, "a", 10, "video-2");
    const moved = result.find((c) => c.id === "a")!;
    const sibling = result.find((c) => c.id === "b")!;
    expect(moved.trackId).toBe("video-2");
    const overlap = Math.min(clipEnd(moved), clipEnd(sibling)) - Math.max(moved.start, sibling.start);
    const maxOverlap = Math.min(5, 16) * 0.9;
    expect(overlap).toBeLessThanOrEqual(maxOverlap + 1e-9);
  });
});

describe("rippleDeleteClip", () => {
  it("removes clip and shifts later same-track clips left", () => {
    const clips = [
      makeClip({ id: "a", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", start: 5, sourceOut: 5 }),
      makeClip({ id: "c", start: 10, sourceOut: 5 }),
    ];
    const result = rippleDeleteClip(clips, "a");
    expect(result.find((c) => c.id === "b")!.start).toBe(0);
    expect(result.find((c) => c.id === "c")!.start).toBe(5);
  });

  it("does not shift clips on other tracks", () => {
    const clips = [
      makeClip({ id: "a", trackId: "t1", start: 0, sourceOut: 5 }),
      makeClip({ id: "x", trackId: "t2", start: 10, sourceOut: 5 }),
    ];
    const result = rippleDeleteClip(clips, "a");
    expect(result.find((c) => c.id === "x")!.start).toBe(10);
  });
});

describe("timelineDuration", () => {
  it("returns the max clip end across all clips", () => {
    const clips = [
      makeClip({ id: "a", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", start: 10, sourceOut: 20 }),
    ];
    expect(timelineDuration(clips)).toBe(30);
  });

  it("returns 0 for empty timeline", () => {
    expect(timelineDuration([])).toBe(0);
  });
});

describe("findActiveClip", () => {
  const tracks: Track[] = [
    { id: "video-1", name: "Video 1", kind: "video" },
    { id: "video-2", name: "Video 2", kind: "video" },
  ];

  it("picks the first (topmost) video track that has a clip at the given time", () => {
    const clips = [
      makeClip({ id: "bottom", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "top", trackId: "video-2", start: 0, sourceOut: 5 }),
    ];
    expect(findActiveClip(clips, tracks, "video", 2)?.id).toBe("bottom");
  });

  it("falls through to a lower track when the topmost has no clip at that time", () => {
    const clips = [makeClip({ id: "bottom", trackId: "video-1", start: 0, sourceOut: 5 })];
    expect(findActiveClip(clips, tracks, "video", 2)?.id).toBe("bottom");
  });

  it("returns undefined when no track has a clip at the given time", () => {
    const clips = [makeClip({ id: "a", trackId: "video-1", start: 10, sourceOut: 15 })];
    expect(findActiveClip(clips, tracks, "video", 2)).toBeUndefined();
  });
});

describe("getOverlaps", () => {
  const tracks: Track[] = [{ id: "video-1", name: "Video 1", kind: "video" }];

  it("finds no overlaps for sequential, non-overlapping clips", () => {
    const clips = [
      makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "video-1", start: 5, sourceOut: 5 }),
    ];
    expect(getOverlaps(clips, tracks)).toHaveLength(0);
  });

  it("reports the overlap region between two time-adjacent overlapping clips", () => {
    const clips = [
      makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "video-1", start: 3, sourceOut: 5 }),
    ];
    const overlaps = getOverlaps(clips, tracks);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].prevClip.id).toBe("a");
    expect(overlaps[0].nextClip.id).toBe("b");
    expect(overlaps[0].start).toBe(3);
    expect(overlaps[0].end).toBe(5);
    expect(overlaps[0].duration).toBe(2);
  });
});

describe("findActivePair", () => {
  const tracks: Track[] = [{ id: "video-1", name: "Video 1", kind: "video" }];

  it("returns only the primary clip outside an overlap", () => {
    const clips = [
      makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "video-1", start: 3, sourceOut: 5 }),
    ];
    const pair = findActivePair(clips, tracks, "video", 1);
    expect(pair.primary?.id).toBe("a");
    expect(pair.secondary).toBeUndefined();
  });

  it("returns primary (outgoing) and secondary (incoming) clips inside an overlap", () => {
    const clips = [
      makeClip({ id: "a", trackId: "video-1", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "video-1", start: 3, sourceOut: 5 }),
    ];
    const pair = findActivePair(clips, tracks, "video", 4);
    expect(pair.primary?.id).toBe("a");
    expect(pair.secondary?.id).toBe("b");
  });
});

describe("collectSnapPoints", () => {
  it("collects start/end of every other clip plus extra points, excluding the given clip", () => {
    const clips = [
      makeClip({ id: "dragged", start: 0, sourceOut: 5 }),
      makeClip({ id: "other", start: 10, sourceOut: 6 }),
    ];
    const points = collectSnapPoints(clips, "dragged", [0, 3]).sort((a, b) => a - b);
    expect(points).toEqual([0, 3, 10, 16]);
  });
});

describe("snapValue", () => {
  it("snaps to the nearest point within the threshold", () => {
    expect(snapValue(10.1, [10, 20], 0.5)).toBe(10);
  });

  it("leaves the value unchanged when nothing is within the threshold", () => {
    expect(snapValue(15, [10, 20], 0.5)).toBe(15);
  });
});

describe("snapMoveStart", () => {
  it("snaps the clip's start edge to a nearby point", () => {
    const result = snapMoveStart(10.1, 5, [10, 30], 0.5);
    expect(result).toBe(10);
  });

  it("snaps the clip's end edge to a nearby point, adjusting start accordingly", () => {
    // duration 5, raw start 24.9 -> raw end 29.9, close to snap point 30
    const result = snapMoveStart(24.9, 5, [10, 30], 0.5);
    expect(result).toBe(25);
  });

  it("leaves start unchanged when nothing is within the threshold", () => {
    const result = snapMoveStart(15, 5, [10, 30], 0.5);
    expect(result).toBe(15);
  });
});
