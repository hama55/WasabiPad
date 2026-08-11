import { describe, expect, it } from "vitest";
import { transformTrackedRange } from "./viewer-range";

describe("Feature: live viewer range tracking", () => {
  // Given: 範囲`3..5`と、その前の行1への`"a\nb\n"`挿入
  // When: `transformTrackedRange`を呼ぶ
  // Then: 範囲を`5..7`へ移動
  it("Scenario: moves the range when lines are inserted before it", () => {
    expect(transformTrackedRange(
      { start: { line: 3, col: 0 }, end: { line: 5, col: 4 } },
      [{ start: { line: 1, col: 0 }, end: { line: 1, col: 0 }, text: "a\nb\n" }],
    )).toEqual({ start: { line: 5, col: 0 }, end: { line: 7, col: 4 } });
  });

  // Given: 範囲`2..4`内の行3へ`"x\ny"`を挿入
  // When: `transformTrackedRange`を呼ぶ
  // Then: 始点は維持し、終点を5行目へ拡張
  it("Scenario: expands the range when lines are inserted inside it", () => {
    expect(transformTrackedRange(
      { start: { line: 2, col: 0 }, end: { line: 4, col: 3 } },
      [{ start: { line: 3, col: 1 }, end: { line: 3, col: 1 }, text: "x\ny" }],
    )).toEqual({ start: { line: 2, col: 0 }, end: { line: 5, col: 3 } });
  });

  // Given: 範囲`2..4`の後ろの行6へ改行を挿入
  // When: `transformTrackedRange`を呼ぶ
  // Then: 元の範囲オブジェクトを維持
  it("Scenario: does not change the range for edits after it", () => {
    const range = { start: { line: 2, col: 1 }, end: { line: 4, col: 3 } };
    expect(transformTrackedRange(
      range,
      [{ start: { line: 6, col: 0 }, end: { line: 6, col: 0 }, text: "\n" }],
    )).toEqual(range);
  });
});
