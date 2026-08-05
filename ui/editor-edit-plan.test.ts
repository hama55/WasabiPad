import { describe, expect, it } from "vitest";
import {
  newlineWithLeadingTabs,
  planLineIndent,
  selectedLineRange,
} from "./editor-edit-plan";

describe("Feature: editor edit plans", () => {
  // Given: 行頭の連続tabが `text`、`\ttext`、`\t\ttext`、` \ttext`
  // When: `newlineWithLeadingTabs`を各入力へ適用
  // Then: それぞれ改行後が`\n`、`\n\t`、`\n\t\t`、`\n`
  it.each([
    ["text", "\n"],
    ["\ttext", "\n\t"],
    ["\t\ttext", "\n\t\t"],
    [" \ttext", "\n"],
  ])("Scenario: 先頭の連続tabだけを改行へ引き継ぐ", (line, expected) => {
    expect(newlineWithLeadingTabs(line)).toBe(expected);
  });

  // Given: anchor=`{line:3,col:0}`、caret=`{line:1,col:2}`の逆向き選択
  // When: `selectedLineRange`と`planLineIndent`
  // Then: range=`{first:1,last:2}`、edit開始行=`[1,2]`、nextAnchor=`{3,0}`、nextCaret=`{1,3}`、primaryIndex=0、anchorは不変
  it("Scenario: 終端col=0を除外し、逆向き選択を維持して複数行をindentする", () => {
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

  // Given: anchorとcaretがともに`{line:1,col:2}`
  // When: `planLineIndent`
  // Then: `null`
  it("Scenario: 範囲選択でなければplanを作らない", () => {
    expect(planLineIndent({ line: 1, col: 2 }, { line: 1, col: 2 })).toBeNull();
  });
});
