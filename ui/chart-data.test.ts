import { describe, expect, it } from "vitest";
import {
  chartColumnLabel,
  chartPointRadius,
  CHART_TYPES,
  histogramData,
  isChartTypeId,
  numericColumnIndexes,
  parseChartNumber,
} from "./chart-data";

describe("Feature: CSV chart data", () => {
  // Given: `"66,421.01"`、`"+0.46%"`、`"日付"`
  // When: `parseChartNumber`を各入力へ適用
  // Then: `66421.01`、`0.46`、`null`
  it("Scenario: parses grouped and signed numbers", () => {
    expect(parseChartNumber("66,421.01")).toBe(66421.01);
    expect(parseChartNumber("+0.46%")).toBe(0.46);
    expect(parseChartNumber("日付")).toBeNull();
  });

  // Given: 日付・終値・メモのheaderと、終値だけ数値の2 data rows
  // When: `numericColumnIndexes`を呼ぶ
  // Then: `[1]`
  it("Scenario: detects numeric columns from data rows", () => {
    expect(numericColumnIndexes([
      ["日付", "終値", "メモ"],
      ["26/07/23", "66,422.60", "上昇"],
      ["26/07/22", "66,115.60", "下落"],
    ])).toEqual([1]);
  });

  // Given: headersが`["日付",""]`
  // When: index=1の`chartColumnLabel`を呼ぶ
  // Then: `"列 2"`
  it("Scenario: supplies a label for an empty header", () => {
    expect(chartColumnLabel(["日付", ""], 1)).toBe("列 2");
  });
});

describe("Feature: chart types", () => {
  // Given: chart type idが`"bar-stacked"`と、未知の`"pie"`およびprototype由来の`"toString"`
  // When: `isChartTypeId`を呼ぶ
  // Then: 登録済みだけtrue、未知値とprototype由来の値はfalse
  it("Scenario: rejects unknown type ids", () => {
    expect(isChartTypeId("bar-stacked")).toBe(true);
    expect(isChartTypeId("pie")).toBe(false);
    expect(isChartTypeId("toString")).toBe(false);
  });

  // Given: `line-point`を100/1000点、`scatter`を1000点で描画
  // When: `chartPointRadius`を呼ぶ
  // Then: 2、0、3
  it("Scenario: thins points on dense line charts but keeps them when only points are drawn", () => {
    expect(chartPointRadius(CHART_TYPES["line-point"], 100)).toBe(2);
    expect(chartPointRadius(CHART_TYPES["line-point"], 1000)).toBe(0);
    expect(chartPointRadius(CHART_TYPES.scatter, 1000)).toBe(3);
  });

  // Given: 数値4件と、数値でない値1件
  // When: ヒストグラム用データへ変換する
  // Then: 数値だけを複数の区間へ集計し、各区間の件数を返す
  it("Scenario: histogram counts numeric values into bins", () => {
    const result = histogramData(["1", "2", "3", "4", "memo"]);

    expect(result.labels).toHaveLength(2);
    expect(result.values).toEqual([2, 2]);
    expect(result.values.reduce((sum, count) => sum + count, 0)).toBe(4);
  });

  // Given: 空入力、数値でない入力、同じ値だけの入力
  // When: ヒストグラム用データへ変換する
  // Then: 空入力は空、定数値は1区間へ集計する
  it("Scenario: histogram handles empty and constant input", () => {
    expect(histogramData([])).toEqual({ labels: [], values: [] });
    expect(histogramData(["memo", "-"])).toEqual({ labels: [], values: [] });
    expect(histogramData(["-2.5", "-2.5", "-2.5"])).toEqual({
      labels: ["-2.5"],
      values: [3],
    });
  });

  // Given: 50区間を超える件数の異なる数値
  // When: ヒストグラム用データへ変換する
  // Then: 区間数は最大50で、全数値を失わず集計する
  it("Scenario: histogram caps bins without dropping values", () => {
    const result = histogramData(Array.from({ length: 2_601 }, (_, index) => String(index)));

    expect(result.labels).toHaveLength(50);
    expect(result.values.reduce((sum, count) => sum + count, 0)).toBe(2_601);
  });
});
