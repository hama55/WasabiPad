import { describe, expect, it } from "vitest";
import { lineNumberGroups } from "./line-number";

describe("Feature: lineNumberGroups", () => {
  // Given: 数値`1`,`999`,`1000`,`1234567`
  // When: `lineNumberGroups`を呼ぶ
  // Then: [`"1"`],[`"999"`],[`"1"`,`"000"`],[`"1"`,`"234"`,`"567"`]
  it("Scenario: splits line numbers into three-digit groups", () => {
    expect(lineNumberGroups(1)).toEqual(["1"]);
    expect(lineNumberGroups(999)).toEqual(["999"]);
    expect(lineNumberGroups(1000)).toEqual(["1", "000"]);
    expect(lineNumberGroups(1234567)).toEqual(["1", "234", "567"]);
  });
});
