import { describe, expect, it } from "vitest";
import {
  chartColumnLabel,
  chartPointRadius,
  CHART_TYPES,
  isChartTypeId,
  numericColumnIndexes,
  parseChartNumber,
} from "./chart-data";

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

describe("chart types", () => {
  it("rejects unknown type ids", () => {
    expect(isChartTypeId("bar-stacked")).toBe(true);
    expect(isChartTypeId("pie")).toBe(false);
  });

  it("thins points on dense line charts but keeps them when only points are drawn", () => {
    expect(chartPointRadius(CHART_TYPES["line-point"], 100)).toBe(2);
    expect(chartPointRadius(CHART_TYPES["line-point"], 1000)).toBe(0);
    expect(chartPointRadius(CHART_TYPES.scatter, 1000)).toBe(3);
  });
});
