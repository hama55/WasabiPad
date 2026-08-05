import { describe, expect, it } from "vitest";
import {
  charLen,
  charToU16,
  clampImeAnchor,
  comparePos,
  findProgressPercent,
  positionAfterDeletion,
  u16ToChar,
  unescapePattern,
  WrapHeightMap,
  wordBounds,
} from "./editor-math";

describe("Feature: editor math", () => {
  // Given: text=`A😀あ`
  // When: `charLen`、`charToU16(text,2)`、`u16ToChar(text,3)`
  // Then: 3、3、2
  it("Scenario: converts Unicode scalar columns and DOM UTF-16 offsets", () => {
    const text = "A😀あ";
    expect(charLen(text)).toBe(3);
    expect(charToU16(text, 2)).toBe(3);
    expect(u16ToChar(text, 3)).toBe(2);
  });

  // Given: pattern=`a\\nb\\tc\\\\d\\x`
  // When: `unescapePattern`
  // Then: `a`+改行+`b`+タブ+`c\d\x`
  it("Scenario: keeps the documented search escape rules", () => {
    expect(unescapePattern("a\\nb\\tc\\\\d\\x")).toBe("a\nb\tc\\d\\x");
  });

  // Given: positions `{1,0}`と`{0,9}`、progress入力がwrapped=false/line=50とwrapped=true/line=99
  // When: `comparePos`と`findProgressPercent`
  // Then: compareは0超、progressは50、99
  it("Scenario: compares positions and bounds progress", () => {
    expect(comparePos({ line: 1, col: 0 }, { line: 0, col: 9 })).toBeGreaterThan(0);
    expect(findProgressPercent({ wrapped: false, line: 50 }, 0, 100)).toBe(50);
    expect(findProgressPercent({ wrapped: true, line: 99 }, 50, 100)).toBe(99);
  });

  // Given: text=`漢字カタカナひらがな`、位置1/4/8
  // When: `wordBounds`
  // Then: `{0,2}`、`{2,6}`、`{6,10}`
  it("Scenario: finds word bounds by Japanese script", () => {
    const text = "漢字カタカナひらがな";
    expect(wordBounds(text, 1)).toEqual({ start: 0, end: 2 });
    expect(wordBounds(text, 4)).toEqual({ start: 2, end: 6 });
    expect(wordBounds(text, 8)).toEqual({ start: 6, end: 10 });
  });

  // Given: deletion範囲が`{2,3}`→`{4,5}`、移動位置が`{4,8}`と`{6,1}`
  // When: `positionAfterDeletion`
  // Then: `{2,6}`、`{4,1}`
  it("Scenario: adjusts the drop position after deleting a selected range", () => {
    expect(positionAfterDeletion({ line: 2, col: 3 }, { line: 4, col: 5 }, { line: 4, col: 8 }))
      .toEqual({ line: 2, col: 6 });
    expect(positionAfterDeletion({ line: 2, col: 3 }, { line: 4, col: 5 }, { line: 6, col: 1 }))
      .toEqual({ line: 4, col: 1 });
  });

  // Given: anchorが(-20,-10)、(500,200)、(NaN,+Infinity)、領域が200×100または0×0、paddingが8×20
  // When: `clampImeAnchor`
  // Then: `{x:8,y:0}`、`{x:196,y:80}`、`{x:8,y:0}`
  it("Scenario: IME anchor stays inside the visible editor area", () => {
    expect(clampImeAnchor(-20, -10, 200, 100, 8, 20)).toEqual({ x: 8, y: 0 });
    expect(clampImeAnchor(500, 200, 200, 100, 8, 20)).toEqual({ x: 196, y: 80 });
    expect(clampImeAnchor(Number.NaN, Number.POSITIVE_INFINITY, 0, 0, 8, 20))
      .toEqual({ x: 8, y: 0 });
  });

  // Given: `WrapHeightMap(7,20)`でline6のheightを2000に設定
  // When: `totalHeight`、`offsetOf(6,950)`、`anchorAt(1070)`
  // Then: 2120、1070、`{line:6,intraLinePx:950}`
  it("Scenario: maps a long wrapped logical line to visual scroll offsets", () => {
    const heights = new WrapHeightMap(7, 20);
    heights.set(6, 2000);

    expect(heights.totalHeight()).toBe(2120);
    expect(heights.offsetOf(6, 950)).toBe(1070);
    expect(heights.anchorAt(1070)).toEqual({ line: 6, intraLinePx: 950 });
  });
});
