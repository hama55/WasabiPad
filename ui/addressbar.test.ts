import { describe, expect, it } from "vitest";
import { pathSegments } from "./addressbar";

describe("pathSegments", () => {
  it("makes every crumb an openable absolute path", () => {
    expect(pathSegments("C:\\work\\notes\\memo.txt")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "work", path: "C:\\work" },
      { label: "notes", path: "C:\\work\\notes" },
      { label: "memo.txt", path: "C:\\work\\notes\\memo.txt" },
    ]);
  });

  it("accepts forward slashes as separators", () => {
    expect(pathSegments("C:/work/memo.txt").map((s) => s.path)).toEqual([
      "C:\\", "C:\\work", "C:\\work\\memo.txt",
    ]);
  });

  it("leaves non-drive paths as a single crumb", () => {
    expect(pathSegments("")).toEqual([{ label: "", path: "" }]);
    expect(pathSegments("memo.txt")).toEqual([{ label: "memo.txt", path: "memo.txt" }]);
  });
});
