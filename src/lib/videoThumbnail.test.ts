import { describe, it, expect } from "vitest";
import { filmstripTimestamps } from "./videoThumbnail";

describe("filmstripTimestamps", () => {
  it("returns empty for zero/negative width or span", () => {
    expect(filmstripTimestamps(0, 0, 10)).toEqual([]);
    expect(filmstripTimestamps(200, 5, 5)).toEqual([]);
    expect(filmstripTimestamps(200, 10, 5)).toEqual([]);
  });

  it("returns a single frame at sourceIn when width fits only one interval", () => {
    expect(filmstripTimestamps(50, 2, 8, 100)).toEqual([2]);
  });

  it("spaces frames evenly across the visible source range", () => {
    // width 300 / interval 100 -> floor(3)+1 = 4 frames across a 30s span
    const result = filmstripTimestamps(300, 0, 30, 100);
    expect(result).toEqual([0, 10, 20, 30]);
  });

  it("always includes the first timestamp at sourceIn", () => {
    const result = filmstripTimestamps(250, 12, 20, 100);
    expect(result[0]).toBe(12);
    expect(result[result.length - 1]).toBe(20);
  });

  it("scales frame count with width", () => {
    const narrow = filmstripTimestamps(150, 0, 10, 100);
    const wide = filmstripTimestamps(500, 0, 10, 100);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
});
