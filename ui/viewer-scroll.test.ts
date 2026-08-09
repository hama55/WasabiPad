// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { scrollViewerCaret, scrollViewerCell } from "./viewer-scroll";

describe("Feature: viewer caret scrolling", () => {
  // Given: 3行のうち終端行2が選択範囲`2:0..2:4`
  // When: `scrollViewerCaret`を呼ぶ
  // Then: 3行目を中央・nearest指定でスクロール
  it("Scenario: 選択終端行に対応する要素を中央へスクロールする", () => {
    const rows = Array.from({ length: 3 }, () => document.createElement("tr"));
    const scrollIntoView = vi.fn();
    rows[2].scrollIntoView = scrollIntoView;

    scrollViewerCaret(rows, {
      start: { line: 2, col: 0 },
      end: { line: 2, col: 4 },
    }, (_row, index) => ({ start: index, end: index + 1 }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });

  // Given: 表示範囲`0..2`と`4..6`の間の行3を選択
  // When: `scrollViewerCaret`を呼ぶ
  // Then: 後続要素だけを中央スクロールし、先行要素は呼ばない
  it("Scenario: 対象行が表示範囲外なら最寄りの要素へスクロールする", () => {
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

  // Given: 選択位置に対応する行のセル
  // When: `scrollViewerCell`を呼ぶ
  // Then: セルを縦横とも中央へスクロールする
  it("Scenario: 選択セルをCSVビューの中央へスクロールする", () => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    const scrollIntoView = vi.fn();
    cell.scrollIntoView = scrollIntoView;
    row.appendChild(cell);

    scrollViewerCell([row], {
      start: { line: 4, col: 12 },
      end: { line: 4, col: 15 },
    }, () => cell);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
  });
});
