import { describe, expect, it } from "vitest";
import { csvColumnAt, decodeDelimiter, isSingleCsvCellSelection } from "./csv-viewer";

describe("CSV viewer helpers", () => {
  it("入力欄の \\t をタブ区切りへ変換する", () => {
    expect(decodeDelimiter("\\t")).toBe("\t");
    expect(decodeDelimiter(",")).toBe(",");
  });

  it("引用符内の区切り文字は列境界に数えない", () => {
    expect(csvColumnAt('"a\tb"\tc', 6, "\\t")).toBe(1);
  });

  it("同じセル内だけの選択を判定する", () => {
    expect(isSingleCsvCellSelection("a\tb", {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 1 },
    }, "\\t")).toBe(true);
    expect(isSingleCsvCellSelection("a\tb", {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 2 },
    }, "\\t")).toBe(false);
  });
});
