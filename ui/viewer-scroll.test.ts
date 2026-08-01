// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { scrollViewerCaret } from "./viewer-scroll";

describe("viewer caret scrolling", () => {
  it("選択終端行に対応する要素を中央へスクロールする", () => {
    const rows = Array.from({ length: 3 }, () => document.createElement("tr"));
    const scrollIntoView = vi.fn();
    rows[2].scrollIntoView = scrollIntoView;

    scrollViewerCaret(rows, {
      start: { line: 2, col: 0 },
      end: { line: 2, col: 4 },
    }, (_row, index) => ({ start: index, end: index + 1 }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });

  it("対象行が表示範囲外なら最寄りの要素へスクロールする", () => {
    const before = document.createElement("div");
    const after = document.createElement("div");
    const beforeScroll = vi.fn();
    const afterScroll = vi.fn();
    before.scrollIntoView = beforeScroll;
    after.scrollIntoView = afterScroll;

    scrollViewerCaret([before, after], {
      start: { line: 3, col: 0 },
      end: { line: 3, col: 0 },
    }, (_element, index) => index === 0 ? { start: 0, end: 2 } : { start: 4, end: 6 });

    expect(beforeScroll).not.toHaveBeenCalled();
    expect(afterScroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });
});
