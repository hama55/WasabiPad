import { describe, expect, it } from "vitest";
import {
  newlineWithLeadingTabs,
  planLineIndent,
  planLineUnindent,
  selectedLineRange,
  selectedLineRangeForUnindent,
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

  // Given: anchor=`{line:3,col:0}`、caret=`{line:1,col:0}`の逆向き選択
  // When: `selectedLineRange`と`planLineIndent`
  // Then: range=`{first:1,last:2}`、edit開始行=`[1,2]`、nextAnchor=`{3,0}`、nextCaret=`{1,0}`、primaryIndex=0、anchorは不変
  it("Scenario: 終端col=0を除外し、逆向き選択を維持して複数行をindentする", () => {
    const anchor = { line: 3, col: 0 };
    const caret = { line: 1, col: 0 };
    const plan = planLineIndent(anchor, caret)!;

    expect(selectedLineRange(anchor, caret)).toEqual({ first: 1, last: 2 });
    expect(plan.edits.map((edit) => edit.start.line)).toEqual([1, 2]);
    expect(plan.nextAnchor).toEqual({ line: 3, col: 0 });
    expect(plan.nextCaret).toEqual({ line: 1, col: 0 });
    expect(plan.primaryIndex).toBe(0);
    expect(anchor).toEqual({ line: 3, col: 0 });
  });

  // Feature: 行indent後の選択位置補正
  // Scenario: 選択終端が行途中にある
  // Given: anchor=`{line:0,col:0}`、caret=`{line:1,col:1}`の選択
  // When: `planLineIndent`を評価する
  // Then: indent後のcaret列だけを1増やす
  it("Scenario: 行途中の選択終端はindent分だけ列を進める", () => {
    const plan = planLineIndent({ line: 0, col: 0 }, { line: 1, col: 1 })!;

    expect(plan.nextAnchor).toEqual({ line: 0, col: 0 });
    expect(plan.nextCaret).toEqual({ line: 1, col: 2 });
  });

  // Given: 選択範囲が行頭を含まない
  // When: `selectedLineRange`と`planLineIndent`を評価する
  // Then: 行単位indentの対象外になる
  it("Scenario: 行頭を含まない選択ではTab用の行indent計画を作らない", () => {
    const anchor = { line: 0, col: 1 };
    const caret = { line: 1, col: 1 };

    expect(selectedLineRange(anchor, caret)).toBeNull();
    expect(planLineIndent(anchor, caret)).toBeNull();
  });

  // Given: anchorとcaretがともに`{line:1,col:2}`
  // When: `planLineIndent`
  // Then: `null`
  it("Scenario: 範囲選択でなければplanを作らない", () => {
    expect(planLineIndent({ line: 1, col: 2 }, { line: 1, col: 2 })).toBeNull();
  });

  // Given: anchor=`{line:3,col:0}`、caret=`{line:1,col:1}`の逆向き選択と混在行
  // When: `selectedLineRangeForUnindent`と`planLineUnindent`を評価する
  // Then: 終端行頭を除き、タブがある行だけ1つ削除し、両端列を補正する
  it("Scenario: 逆向きの複数行選択を安全にunindentする", () => {
    const anchor = { line: 3, col: 0 };
    const caret = { line: 1, col: 1 };
    const range = selectedLineRangeForUnindent(anchor, caret);
    const plan = planLineUnindent(anchor, caret, ["\tone", "two"], range)!;

    expect(range).toEqual({ first: 1, last: 2 });
    expect(plan.edits.map((edit) => edit.start.line)).toEqual([1]);
    expect(plan.nextAnchor).toEqual({ line: 3, col: 0 });
    expect(plan.nextCaret).toEqual({ line: 1, col: 0 });
  });

  // Given: 選択されていないタブ付き1行と、タブのない1行
  // When: `planLineUnindent`を評価する
  // Then: 1行では先頭タブを削除し、タブがなければ何もしない
  it("Scenario: 単一行の先頭タブだけを削除する", () => {
    const plan = planLineUnindent({ line: 0, col: 2 }, { line: 0, col: 2 }, ["\ttext"]);

    expect(plan?.edits).toEqual([{ start: { line: 0, col: 0 }, end: { line: 0, col: 1 }, text: "" }]);
    expect(plan?.nextCaret).toEqual({ line: 0, col: 1 });
    expect(planLineUnindent({ line: 0, col: 0 }, { line: 0, col: 0 }, ["text"])).toBeNull();
  });
});
