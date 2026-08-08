// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isCollapsedViewerSelection,
  sourcePositionFromPoint,
  viewerSelectionFromDom,
} from "./viewer-selection";

describe("Feature: viewer source selection mapping", () => {
  // Given: 表示値`a"b`と原文`"a""b",c`を持つCSVセル
  // When: 表示値のエスケープ引用符の直後を選択位置へ変換する
  // Then: 原文側はraw列4になる
  it("Scenario: escaped quotes do not shift reverse selection", () => {
    const row = document.createElement("tr");
    row.dataset.sourceLine = "2";
    row.dataset.sourceCsv = '"a""b",c';
    row.dataset.delimiter = ",";
    const cell = document.createElement("td");
    cell.dataset.sourceColumn = "0";
    cell.textContent = 'a"b';
    row.appendChild(cell);
    document.body.appendChild(row);

    expect(sourcePositionFromPoint(cell.firstChild!, 2)).toEqual({ line: 2, col: 4 });
  });

  // Given: 2セルのCSV表示と、その中のDOM範囲
  // When: DOM選択を親へ返すviewer selectionへ変換する
  // Then: 逆向きでもstart/endが正規化される
  it("Scenario: DOM selection is normalized to source order", () => {
    const content = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.sourceLine = "0";
    row.dataset.sourceCsv = "abc,def";
    row.dataset.delimiter = ",";
    const first = document.createElement("td");
    first.dataset.sourceColumn = "0";
    first.textContent = "abc";
    const second = document.createElement("td");
    second.dataset.sourceColumn = "1";
    second.textContent = "def";
    row.append(first, second);
    content.append(row);
    document.body.appendChild(content);

    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(second.firstChild!, 1, first.firstChild!, 1);

    expect(viewerSelectionFromDom(content)).toEqual({
      start: { line: 0, col: 1 },
      end: { line: 0, col: 5 },
    });
  });

  // Given: Markdownの原文`# title`と表示文字列`title`を持つブロック
  // When: 表示文字列の先頭と末尾を原文位置へ変換する
  // Then: Markdown記号を飛ばした原文列2〜7へ対応する
  it("Scenario: markdown syntax is excluded from source caret columns", () => {
    const block = document.createElement("h1");
    block.dataset.sourceStart = "0";
    block.dataset.sourceEnd = "1";
    block.dataset.sourceText = "# title";
    block.textContent = "title";
    document.body.appendChild(block);

    expect(sourcePositionFromPoint(block.firstChild!, 0)).toEqual({ line: 0, col: 2 });
    expect(sourcePositionFromPoint(block.firstChild!, 5)).toEqual({ line: 0, col: 7 });
  });

  // Given: 選択範囲がないviewer selection
  // When: collapsed判定を呼ぶ
  // Then: nullはcaretとして扱わずfalseを返す
  it("Scenario: empty selection is not treated as a preview range", () => {
    expect(isCollapsedViewerSelection(null)).toBe(false);
    expect(isCollapsedViewerSelection({ start: { line: 1, col: 2 }, end: { line: 1, col: 2 } })).toBe(true);
  });
});
