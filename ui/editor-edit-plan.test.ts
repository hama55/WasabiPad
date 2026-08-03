import { describe, expect, it } from "vitest";
import {
  newlineWithLeadingTabs,
  planLineIndent,
  selectedLineRange,
} from "./editor-edit-plan";

describe("editor edit plans", () => {
  it.each([
    ["text", "\n"],
    ["\ttext", "\n\t"],
    ["\t\ttext", "\n\t\t"],
    [" \ttext", "\n"],
  ])("先頭の連続tabだけを改行へ引き継ぐ", (line, expected) => {
    expect(newlineWithLeadingTabs(line)).toBe(expected);
  });

  it("終端col=0を除外し、逆向き選択を維持して複数行をindentする", () => {
    const anchor = { line: 3, col: 0 };
    const caret = { line: 1, col: 2 };
    const plan = planLineIndent(anchor, caret)!;

    expect(selectedLineRange(anchor, caret)).toEqual({ first: 1, last: 2 });
    expect(plan.edits.map((edit) => edit.start.line)).toEqual([1, 2]);
    expect(plan.nextAnchor).toEqual({ line: 3, col: 0 });
    expect(plan.nextCaret).toEqual({ line: 1, col: 3 });
    expect(plan.primaryIndex).toBe(0);
    expect(anchor).toEqual({ line: 3, col: 0 });
  });

  it("範囲選択でなければplanを作らない", () => {
    expect(planLineIndent({ line: 1, col: 2 }, { line: 1, col: 2 })).toBeNull();
  });
});
