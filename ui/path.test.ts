import { describe, expect, it } from "vitest";
import { basename, dirname, joinWindowsRoot, relativePathFromRoot } from "./path";

describe("path rules", () => {
  it("normalizes slash styles", () => {
    expect(basename("C:\\a/b.txt")).toBe("b.txt");
    expect(dirname("a/b.txt")).toBe("a");
    expect(dirname("b.txt")).toBeNull();
  });

  it("converts workspace paths in one place", () => {
    expect(joinWindowsRoot("C:\\work", "sub/a.txt")).toBe("C:\\work\\sub\\a.txt");
    expect(relativePathFromRoot("C:\\work", "C:\\work\\sub\\a.txt")).toBe("sub/a.txt");
  });
});
