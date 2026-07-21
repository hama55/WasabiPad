import { describe, expect, it } from "vitest";
import { charLen, charToU16, comparePos, findProgressPercent, u16ToChar, unescapePattern } from "./editor-math";

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
});
