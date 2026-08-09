import { describe, expect, it } from "vitest";
import {
  csvCellBounds,
  csvCellBoundsForColumns,
  csvCellSourceOffsetAtDisplayOffset,
  csvCellOffsetAt,
  csvColumnAt,
  CSV_LINE_NUMBER_WIDTH,
  decodeDelimiter,
  isSingleCsvCellSelection,
  parseCsvSource,
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

  // Given: 引用符内にエスケープ引用符を含む`"a""b",c`
  // When: 表示文字列の2文字目までをCSVソース位置へ逆変換する
  // Then: `a"`の後ろにあるraw列4へ到達する
  it("Scenario: escaped quote display offsets map back to raw CSV offsets", () => {
    expect(csvCellSourceOffsetAtDisplayOffset('"a""b",c', 0, 2, ",")).toBe(4);
    expect(csvCellSourceOffsetAtDisplayOffset('"a""b",c', 0, 3, ",")).toBe(5);
  });

  // Given: 空セル・末尾セルを含む`a,,c`
  // When: 1行分のセル境界を1回の走査で求める
  // Then: 区切り位置を含めず、空セルも独立した範囲になる
  it("Scenario: one canonical scan preserves empty and trailing cells", () => {
    expect(csvCellBoundsForColumns("a,,c", ",")).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  // Given: 引用符内改行を含むCSV
  // When: Papa Parseの論理レコードと原文範囲を同時に求める
  // Then: 2行目は物理3行目ではなく、論理レコード開始行2として追跡される
  it("Scenario: multiline quoted records keep their physical source line", () => {
    const parsed = parseCsvSource('a,b\n"multi\nline",c\nd,e', ",");
    expect(parsed.rows.map(({ values, line, text }) => ({ values, line, text }))).toEqual([
      { values: ["a", "b"], line: 0, text: "a,b" },
      { values: ["multi\nline", "c"], line: 1, text: '"multi\nline",c' },
      { values: ["d", "e"], line: 3, text: "d,e" },
    ]);
  });

  // Given: 列幅48pxのCSV列
  // When: 列幅を左右へドラッグする
  // Then: 最小幅を下回らず、整数pxで反映する
  it("Scenario: column resize keeps the minimum width", () => {
    expect(resizedCsvColumnWidth(80, 23.4)).toBe(103);
    expect(resizedCsvColumnWidth(80, -50)).toBe(48);
  });

  // Given: CSV/TSV表示の行番号列
  // When: 共通の列幅定数を参照する
  // Then: delimiterに関係なく同じ幅を使う
  it("Scenario: 行番号列の幅をCSVとTSVで共通化する", () => {
    expect(CSV_LINE_NUMBER_WIDTH).toBe(64);
  });
});
