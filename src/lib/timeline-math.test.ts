import { describe, it, expect } from "vitest";
import {
  type Clip,
  clipEnd,
  moveClip,
  trimClip,
  splitClip,
  rippleDeleteClip,
  timelineDuration,
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

  it("resolves overlap by snapping to nearest free edge", () => {
    const clips = [
      makeClip({ id: "a", start: 0, sourceOut: 5 }),
      makeClip({ id: "b", trackId: "t1", start: 20, sourceIn: 0, sourceOut: 5 }),
    ];
    const result = moveClip(clips, "b", 2);
    const a = result.find((c) => c.id === "a")!;
    const b = result.find((c) => c.id === "b")!;
    expect(b.start).toBeGreaterThanOrEqual(clipEnd(a));
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
