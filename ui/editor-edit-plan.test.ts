import { describe, expect, it } from "vitest";
import {
  autoCloseMarkdownFence,
  markdownEmptyListPrefix,
  markdownFenceState,
  newlineWithMarkdownContinuation,
  newlineWithLeadingTabs,
  planLineIndent,
  planLineUnindent,
  selectedLineRange,
  selectedLineRangeForUnindent,
} from "./editor-edit-plan";

describe("Feature: editor edit plans", () => {
  // Given: 行頭の連続tabを含む各行
  // When: `newlineWithLeadingTabs`を各入力へ適用
  // Then: 行頭の連続tabだけが改行後へ引き継がれる
  it.each([
    ["text", "\n"],
    ["\ttext", "\n\t"],
    ["\t\ttext", "\n\t\t"],
    [" \ttext", "\n"],
  ])("Scenario: 先頭の連続tabを改行へ引き継ぐ", (line, expected) => {
    expect(newlineWithLeadingTabs(line)).toBe(expected);
  });

  // Given: Markdownの箇条書き・引用・表・コード行
  // When: Markdown用の改行継続計画を評価する
  // Then: 記法に応じた次行の接頭辞を作る
  it.each([
    ["* text", null, "\n* "],
    ["\t- text", null, "\n\t- "],
    ["+ text", null, "\n+ "],
    ["\t\t1. text", null, "\n\t\t2. "],
    ["- [ ] text", null, "\n- [ ] "],
    ["- [x] done", null, "\n- [ ] "],
    ["> quote", null, "\n> "],
    ["> - item", null, "\n> - "],
    ["| cell |", null, "\n| "],
    ["    code", null, "\n    "],
    ["- code", { char: "`", length: 3 }, "\n"],
  ] as const)("Scenario: Markdown記法を改行後へ継続する", (line, fenceState, expected) => {
    expect(newlineWithMarkdownContinuation(line, fenceState)).toBe(expected);
  });

  // Given: 空のMarkdownリスト項目
  // When: 空リストの終了用接頭辞を評価する
  // Then: リスト記号を外し、親のtabや引用だけを残す
  it.each([
    ["- ", ""],
    ["\t1. ", "\t"],
    ["> - [ ] ", "> "],
  ])("Scenario: 空リストでは記号を外してMarkdownを終了する", (line, expected) => {
    expect(markdownEmptyListPrefix(line)).toBe(expected);
  });

  // Given: Markdown文書のフェンス行列
  // When: フェンス状態を走査する
  // Then: 開始フェンスから終了フェンスまでだけコードブロック中と判定する
  it("Scenario: Markdownコードフェンスの状態を判定する", () => {
    expect(markdownFenceState(["```ts", "- code"])).toEqual({ char: "`", length: 3 });
    expect(markdownFenceState(["```ts", "code", "```"])).toBeNull();
  });

  // Given: 行頭でMarkdownの```を入力し、現在はコードブロック外
  // When: フェンス自動挿入計画を評価する
  // Then: 閉じフェンスを作り、キャレットを空の中間行へ置く
  it("Scenario: Markdownコードフェンスの閉じ側を自動挿入する", () => {
    expect(autoCloseMarkdownFence("", 0, 0, "```", null)).toEqual({
      text: "```\n\n```",
      caretLineOffset: 1,
      caretCol: 0,
    });
    expect(autoCloseMarkdownFence("", 0, 0, "```", { char: "`", length: 3 })).toBeNull();
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
