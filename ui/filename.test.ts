import { describe, expect, it } from "vitest";
import { windowsFileNameError } from "./filename";

describe("Windows file name rules", () => {
  it("accepts ordinary file names", () => {
    expect(windowsFileNameError("メモ 1.md")).toBeNull();
    expect(windowsFileNameError("report.final.csv")).toBeNull();
  });

  it("rejects invalid characters and trailing characters", () => {
    expect(windowsFileNameError("a?.txt")).not.toBeNull();
    expect(windowsFileNameError("a/b.txt")).not.toBeNull();
    expect(windowsFileNameError("memo.")).not.toBeNull();
    expect(windowsFileNameError("memo ")).not.toBeNull();
  });

  it("rejects reserved device names even with extensions", () => {
    expect(windowsFileNameError("CON")).not.toBeNull();
    expect(windowsFileNameError("con.txt")).not.toBeNull();
    expect(windowsFileNameError("LPT9.log")).not.toBeNull();
    expect(windowsFileNameError("COM10.txt")).toBeNull();
  });
});
