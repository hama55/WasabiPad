import { describe, expect, it } from "vitest";

import { groupResults, highlightRanges } from "./search-results";
import type { WorkspaceSearchResult } from "./api";

const hit = (rel_path: string, line: number, is_filename = false): WorkspaceSearchResult => ({
  rel_path,
  line,
  col: 0,
  preview: rel_path,
  is_filename,
});

describe("groupResults", () => {
  it("同じファイルの一致を1つの見出しへまとめる", () => {
    const groups = groupResults([
      hit("core/src/a.rs", 0, true),
      hit("core/src/a.rs", 3),
      hit("b.txt", 7),
    ]);

    expect(groups.map((group) => [group.fileName, group.dirPath, group.matches.length])).toEqual([
      ["a.rs", "core/src", 2],
      ["b.txt", "", 1],
    ]);
  });

  it("パスが飛び飛びなら別の見出しにする (backend の並び順を信用しない)", () => {
    const groups = groupResults([hit("a.txt", 0), hit("b.txt", 0), hit("a.txt", 5)]);
    expect(groups.map((group) => group.relPath)).toEqual(["a.txt", "b.txt", "a.txt"]);
  });
});

describe("highlightRanges", () => {
  it("行内のすべての一致を返す", () => {
    expect(highlightRanges("needle and needle", "needle", true)).toEqual([[0, 6], [11, 17]]);
  });

  it("大小文字を区別しない場合は backend と同じ ASCII 規則で畳む", () => {
    expect(highlightRanges("NeEdLe", "needle", false)).toEqual([[0, 6]]);
    expect(highlightRanges("NeEdLe", "needle", true)).toEqual([]);
  });

  it("空パターンでは無限ループしない", () => {
    expect(highlightRanges("abc", "", false)).toEqual([]);
  });
});
