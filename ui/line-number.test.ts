import { describe, expect, it } from "vitest";
import { lineNumberGroups, lineNumberWidth } from "./line-number";

describe("Feature: lineNumberGroups", () => {
  // Given: 比例幅の数字を使うフォントで、最大の数字幅は10px
  // When: 同じ桁数の総行数から番号領域の幅を求める
  // Then: 数字の組み合わせに依存せず、桁増加時だけ幅を増やす
  it("Scenario: 同じ桁数なら行番号の幅を固定する", () => {
    const measure = (digit: string) => digit === "1" ? 4 : 10;
    expect(lineNumberWidth(1111, measure)).toBe(42);
    expect(lineNumberWidth(8888, measure)).toBe(42);
    expect(lineNumberWidth(10000, measure)).toBe(52);
  });
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
