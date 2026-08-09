// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownDocument } from "./viewer-markdown-renderer";

describe("Feature: Markdown viewer drawing boundary", () => {
  // Given: 見出しと外部リンクを含み、見出し行の途中にあるキャレット
  // When: Markdown専用rendererで文書を描画する
  // Then: 対応する要素を選択位置へ表示し、リンクを安全な別タブへ設定する
  it("Scenario: Markdown描画とキャレット配置を専用rendererへ委譲する", () => {
    const { article, highlightTargets } = renderMarkdownDocument(
      "# hello\n\n[link](https://example.com)",
      {
        start: { line: 0, col: 4 },
        end: { line: 0, col: 4 },
      },
    );

    expect(article.querySelector("h1")?.dataset.sourceStart).toBe("0");
    expect(article.querySelector(".viewer-markdown-caret")).not.toBeNull();
    expect(article.querySelector("a")?.target).toBe("_blank");
    expect(article.querySelector("a")?.rel).toBe("noreferrer");
    expect(highlightTargets).toHaveLength(2);
  });
});
