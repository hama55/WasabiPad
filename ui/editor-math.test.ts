import { describe, expect, it } from "vitest";
import { charLen, charToU16, comparePos, findProgressPercent, positionAfterDeletion, u16ToChar, unescapePattern, wordBounds } from "./editor-math";

describe("editor math", () => {
  it("converts Unicode scalar columns and DOM UTF-16 offsets", () => {
    const text = "A😀あ";
    expect(charLen(text)).toBe(3);
    expect(charToU16(text, 2)).toBe(3);
    expect(u16ToChar(text, 3)).toBe(2);
  });

  it("keeps the documented search escape rules", () => {
    expect(unescapePattern("a\\nb\\tc\\\\d\\x")).toBe("a\nb\tc\\d\\x");
  });

  it("compares positions and bounds progress", () => {
    expect(comparePos({ line: 1, col: 0 }, { line: 0, col: 9 })).toBeGreaterThan(0);
    expect(findProgressPercent({ wrapped: false, line: 50 }, 0, 100)).toBe(50);
    expect(findProgressPercent({ wrapped: true, line: 99 }, 50, 100)).toBe(99);
  });

  it("finds word bounds by Japanese script", () => {
    const text = "漢字カタカナひらがな";
    expect(wordBounds(text, 1)).toEqual({ start: 0, end: 2 });
    expect(wordBounds(text, 4)).toEqual({ start: 2, end: 6 });
    expect(wordBounds(text, 8)).toEqual({ start: 6, end: 10 });
  });

  it("adjusts the drop position after deleting a selected range", () => {
    expect(positionAfterDeletion({ line: 2, col: 3 }, { line: 4, col: 5 }, { line: 4, col: 8 }))
      .toEqual({ line: 2, col: 6 });
    expect(positionAfterDeletion({ line: 2, col: 3 }, { line: 4, col: 5 }, { line: 6, col: 1 }))
      .toEqual({ line: 4, col: 1 });
  });
});
