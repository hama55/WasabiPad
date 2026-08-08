import { describe, expect, it } from "vitest";
import {
  csvCellBounds,
  csvCellOffsetAt,
  csvColumnAt,
  decodeDelimiter,
  isSingleCsvCellSelection,
  resizedCsvColumnWidth,
} from "./csv-viewer";

describe("Feature: CSV viewer helpers", () => {
  // Given: delimiter入力が`"\\t"`と`","`
  // When: `decodeDelimiter`を呼ぶ
  // Then: タブ文字と`,`へ変換
  it("Scenario: 入力欄の \\t をタブ区切りへ変換する", () => {
    expect(decodeDelimiter("\\t")).toBe("\t");
    expect(decodeDelimiter(",")).toBe(",");
  });

  // Given: textが`"a\tb"\tc`、位置6、delimiter入力が`"\\t"`
  // When: `csvColumnAt`を呼ぶ
  // Then: 列番号1
  it("Scenario: 引用符内の区切り文字は列境界に数えない", () => {
    expect(csvColumnAt('"a\tb"\tc', 6, "\\t")).toBe(1);
  });

  // Given: text=`"a\tb"`で選択範囲が同一セル内の`0:0→0:1`またがる`0:0→0:2`
  // When: `isSingleCsvCellSelection`を呼ぶ
  // Then: true、false
  it("Scenario: 同じセル内だけの選択を判定する", () => {
    expect(isSingleCsvCellSelection("a\tb", {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 1 },
    }, "\\t")).toBe(true);
    expect(isSingleCsvCellSelection("a\tb", {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 2 },
    }, "\\t")).toBe(false);
  });
  // Given: "a,b",cのCSV行とセル内のソース位置
  // When: 対応するセル範囲と表示文字列上のキャレット位置を求める
  // Then: 引用符を除いたセル内位置として返る
  it("Scenario: quoted CSV cell positions ignore syntax quotes", () => {
    expect(csvCellBounds('"a,b",c', 3, ",")).toEqual({ start: 0, end: 5 });
    expect(csvCellOffsetAt('"a,b",c', 3, ",")).toBe(2);
    expect(csvCellOffsetAt('"a,b",c', 1, ",")).toBe(0);
  });

  // Given: 列幅48pxのCSV列
  // When: 列幅を左右へドラッグする
  // Then: 最小幅を下回らず、整数pxで反映する
  it("Scenario: column resize keeps the minimum width", () => {
    expect(resizedCsvColumnWidth(80, 23.4)).toBe(103);
    expect(resizedCsvColumnWidth(80, -50)).toBe(48);
  });
});
