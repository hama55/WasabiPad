import { describe, expect, it } from "vitest";
import { basename, dirname, joinWindowsRoot, rebaseWindowsPath, relativePathFromRoot, relativePathWithinRoot } from "./path";

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

  it("accepts only paths inside the workspace boundary", () => {
    expect(relativePathWithinRoot("C:\\Work", "c:\\work\\sub\\a.txt")).toBe("sub/a.txt");
    expect(relativePathWithinRoot("C:\\work", "C:\\work2\\a.txt")).toBeNull();
  });

  it("rebases defaults after file or directory renames", () => {
    expect(rebaseWindowsPath("C:\\work\\old\\a.txt", "C:\\work\\old", "C:\\work\\new")).toBe("C:\\work\\new\\a.txt");
    expect(rebaseWindowsPath("C:\\work2\\a.txt", "C:\\work", "C:\\new")).toBeNull();
  });
});
