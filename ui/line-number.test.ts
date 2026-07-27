import { describe, expect, it } from "vitest";
import { lineNumberGroups } from "./line-number";

describe("lineNumberGroups", () => {
  it("splits line numbers into three-digit groups", () => {
    expect(lineNumberGroups(1)).toEqual(["1"]);
    expect(lineNumberGroups(999)).toEqual(["999"]);
    expect(lineNumberGroups(1000)).toEqual(["1", "000"]);
    expect(lineNumberGroups(1234567)).toEqual(["1", "234", "567"]);
  });
});
