import { describe, expect, it } from "vitest";
import { transformTrackedRange } from "./viewer-range";

describe("live viewer range tracking", () => {
  it("moves the range when lines are inserted before it", () => {
    expect(transformTrackedRange(
      { start: { line: 3, col: 0 }, end: { line: 5, col: 4 } },
      [{ start: { line: 1, col: 0 }, end: { line: 1, col: 0 }, text: "a\nb\n" }],
    )).toEqual({ start: { line: 5, col: 0 }, end: { line: 7, col: 4 } });
  });

  it("expands the range when lines are inserted inside it", () => {
    expect(transformTrackedRange(
      { start: { line: 2, col: 0 }, end: { line: 4, col: 3 } },
      [{ start: { line: 3, col: 1 }, end: { line: 3, col: 1 }, text: "x\ny" }],
    )).toEqual({ start: { line: 2, col: 0 }, end: { line: 5, col: 3 } });
  });

  it("does not change the range for edits after it", () => {
    const range = { start: { line: 2, col: 1 }, end: { line: 4, col: 3 } };
    expect(transformTrackedRange(
      range,
      [{ start: { line: 6, col: 0 }, end: { line: 6, col: 0 }, text: "\n" }],
    )).toEqual(range);
  });
});
