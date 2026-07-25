import { describe, expect, it } from "vitest";
import { chartColumnLabel, numericColumnIndexes, parseChartNumber } from "./chart-data";

describe("CSV chart data", () => {
  it("parses grouped and signed numbers", () => {
    expect(parseChartNumber("66,421.01")).toBe(66421.01);
    expect(parseChartNumber("+0.46%")).toBe(0.46);
    expect(parseChartNumber("日付")).toBeNull();
  });

  it("detects numeric columns from data rows", () => {
    expect(numericColumnIndexes([
      ["日付", "終値", "メモ"],
      ["26/07/23", "66,422.60", "上昇"],
      ["26/07/22", "66,115.60", "下落"],
    ])).toEqual([1]);
  });

  it("supplies a label for an empty header", () => {
    expect(chartColumnLabel(["日付", ""], 1)).toBe("列 2");
  });
});
