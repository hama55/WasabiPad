import { describe, expect, it } from "vitest";
import {
  archiveEntryPath,
  archiveRelOf,
  isArchiveEntryPath,
  isArchiveEntryUnder,
  splitArchiveEntryPath,
} from "./archive-path";

describe("Feature: archive path codec", () => {
  // Given: `sub/data.7z::dir/a.txt`
  // When: `splitArchiveEntryPath`と`archiveRelOf`を呼ぶ
  // Then: `{archiveRelPath:"sub/data.7z",entryName:"dir/a.txt"}`と`"sub/data.7z"`
  it("Scenario: splits a folder-relative archive entry", () => {
    expect(splitArchiveEntryPath("sub/data.7z::dir/a.txt")).toEqual({
      archiveRelPath: "sub/data.7z",
      entryName: "dir/a.txt",
    });
    expect(archiveRelOf("sub/data.7z::dir/a.txt")).toBe("sub/data.7z");
  });

  // Given: archive相対パスが空または`data.zip`、entryが`sheet1`
  // When: `archiveEntryPath`と`isArchiveEntryPath`を呼ぶ
  // Then: `"sheet1"`、`"data.zip::sheet1"`、判定false、true
  it("Scenario: keeps direct archive entries as plain entry names", () => {
    expect(archiveEntryPath("", "sheet1")).toBe("sheet1");
    expect(archiveEntryPath("data.zip", "sheet1")).toBe("data.zip::sheet1");
    expect(isArchiveEntryPath("sheet1")).toBe(false);
    expect(isArchiveEntryPath("data.zip::sheet1")).toBe(true);
  });

  // Given: `data.zip::sheet1`、`data.zip.bak::sheet1`、`plain.txt`
  // When: `isArchiveEntryUnder`と`archiveRelOf`を呼ぶ
  // Then: true、false、空文字
  it("Scenario: does not confuse a similar archive path with a child entry", () => {
    expect(isArchiveEntryUnder("data.zip::sheet1", "data.zip")).toBe(true);
    expect(isArchiveEntryUnder("data.zip.bak::sheet1", "data.zip")).toBe(false);
    expect(archiveRelOf("plain.txt")).toBe("");
  });
});
