// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { groupResults, highlightedPreview, searchResultGoto, sortResults } from "./search-results";
import type { WorkspaceSearchResult } from "./api";

const hit = (
  rel_path: string,
  line: number,
  is_filename = false,
  score = 0
): WorkspaceSearchResult => ({
  rel_path,
  line,
  col: 0,
  preview: rel_path,
  highlights: [],
  is_filename,
  score,
});

const render = (preview: string, highlights: [number, number][]) => {
  const host = document.createElement("div");
  host.appendChild(highlightedPreview(preview, highlights));
  return host;
};

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

describe("searchResultGoto", () => {
  it("本文一致だけを本文位置へ変換し、ファイル名一致は飛ばさない", () => {
    expect(searchResultGoto(hit("memo.md", 4))).toEqual({ line: 4, col: 0 });
    expect(searchResultGoto(hit("memo.md", 0, true))).toBeUndefined();
  });
});

describe("sortResults", () => {
  // 走査順で届く結果 (途中経過も確定結果も) を、見せる順に直せること
  it("パス順・同じファイル内はファイル名一致を先に、以降は行順", () => {
    const sorted = sortResults(
      [hit("b.txt", 0), hit("a/z.txt", 5), hit("a/z.txt", 1), hit("a/z.txt", 0, true)],
      { search_file_names: true, search_contents: true }
    );
    expect(sorted.map((result) => [result.rel_path, result.line, result.is_filename])).toEqual([
      ["a/z.txt", 0, true],
      ["a/z.txt", 1, false],
      ["a/z.txt", 5, false],
      ["b.txt", 0, false],
    ]);
  });

  it("ファイル名だけを探しているときはスコア順 (同点はパス順)", () => {
    const sorted = sortResults(
      [hit("b.txt", 0, true, 10), hit("z.txt", 0, true, 90), hit("a.txt", 0, true, 10)],
      { search_file_names: true, search_contents: false }
    );
    expect(sorted.map((result) => result.rel_path)).toEqual(["z.txt", "a.txt", "b.txt"]);
  });
});

describe("highlightedPreview", () => {
  it("backend が返した範囲だけを mark で囲む", () => {
    const host = render("needle and needle", [[0, 6], [11, 6]]);
    expect([...host.querySelectorAll("mark")].map((el) => el.textContent)).toEqual(["needle", "needle"]);
    expect(host.textContent).toBe("needle and needle");
  });

  it("飛び飛びの一致 (ファジー) もそのまま強調できる", () => {
    const host = render("sidebar.ts", [[0, 1], [4, 1], [7, 1]]);
    expect([...host.querySelectorAll("mark")].map((el) => el.textContent)).toEqual(["s", "b", "."]);
  });

  it("サロゲートペアを跨いでも位置がずれない", () => {
    // 𠮷 は UTF-16 では2要素。素の slice(3,6) だと "家のか" になってしまう
    const host = render("𠮷野家のかんじ", [[3, 3]]);
    expect(host.querySelector("mark")?.textContent).toBe("のかん");
    expect(host.textContent).toBe("𠮷野家のかんじ");
  });

  it("範囲が空でも preview はそのまま出す", () => {
    expect(render("plain text", []).textContent).toBe("plain text");
  });

  it("範囲外を指す壊れた指定は無視する", () => {
    const host = render("abc", [[99, 3]]);
    expect(host.querySelectorAll("mark")).toHaveLength(0);
    expect(host.textContent).toBe("abc");
  });
});
