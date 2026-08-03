import { describe, expect, it } from "vitest";
import {
  archiveEntryPath,
  archiveRelOf,
  isArchiveEntryPath,
  isArchiveEntryUnder,
  splitArchiveEntryPath,
} from "./archive-path";

describe("archive path codec", () => {
  it("splits a folder-relative archive entry", () => {
    expect(splitArchiveEntryPath("sub/data.7z::dir/a.txt")).toEqual({
      archiveRelPath: "sub/data.7z",
      entryName: "dir/a.txt",
    });
    expect(archiveRelOf("sub/data.7z::dir/a.txt")).toBe("sub/data.7z");
  });

  it("keeps direct archive entries as plain entry names", () => {
    expect(archiveEntryPath("", "sheet1")).toBe("sheet1");
    expect(archiveEntryPath("data.zip", "sheet1")).toBe("data.zip::sheet1");
    expect(isArchiveEntryPath("sheet1")).toBe(false);
    expect(isArchiveEntryPath("data.zip::sheet1")).toBe(true);
  });

  it("does not confuse a similar archive path with a child entry", () => {
    expect(isArchiveEntryUnder("data.zip::sheet1", "data.zip")).toBe(true);
    expect(isArchiveEntryUnder("data.zip.bak::sheet1", "data.zip")).toBe(false);
    expect(archiveRelOf("plain.txt")).toBe("");
  });
});
