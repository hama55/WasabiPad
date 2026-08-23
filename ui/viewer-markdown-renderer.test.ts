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
    expect(article.querySelector("a")?.title).toBe("Ctrl+クリックで既定のブラウザで開く");
    expect(highlightTargets).toHaveLength(2);
  });

  // Given: 同一文書fragment、別文書fragment、外部URLのリンクと見出し
  // When: 元パス付きでMarkdownを描画する
  // Then: 見出しIDとリンク種別ごとのツールチップを設定する
  it("Scenario: Markdownリンクの種類ごとに移動方法を表示する", () => {
    const { article } = renderMarkdownDocument(
      "# Install Guide!\n\n[same](#install-guide) [other](manual.md#install) [web](https://example.com)",
      null,
      { sourcePath: "C:\\work\\readme.md" },
    );

    expect(article.querySelector("h1")?.id).toBe("install-guide");
    const links = [...article.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.title)).toEqual([
      "クリックで同じ文書内を移動",
      "Ctrl+クリックで新規タブを開いて該当箇所へ移動",
      "Ctrl+クリックで既定のブラウザで開く",
    ]);
  });

  // Given: Markdownの見出しと明示的な空アンカー
  // When: Markdownを描画する
  // Then: 見出しと明示アンカーの両方をfragmentの移動先として残す
  it("Scenario: Markdownの見出しと明示アンカーをfragment対象にする", () => {
    const { article } = renderMarkdownDocument(
      "<a id=\"legacy\"></a>\n\n## Install",
      null,
      { sourcePath: "C:\\work\\readme.md" },
    );

    expect(article.querySelector("a#legacy")).not.toBeNull();
    expect(article.querySelector("h2")?.id).toBe("install");
  });

  // Given: 単一改行・末尾半角スペース2つ・`<br>`・空行と、未完了/完了のGFMタスクリスト
  // When: Markdown専用rendererで文書を描画する
  // Then: 明示した改行だけが`br`になり、空行は段落を分け、タスク記号は操作不可のチェックボックスへ変換される
  it("Scenario: Markdown標準の改行規則とタスクリストを表示する", () => {
    const { article } = renderMarkdownDocument(
      "first line\nsecond line  \nthird<br>line\n\nfourth paragraph\n\n- [ ] todo\n- [x] done",
      null,
    );

    const paragraphs = article.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelectorAll("br")).toHaveLength(2);
    const checkboxes = [...article.querySelectorAll<HTMLInputElement>("input.viewer-markdown-task")];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].disabled).toBe(true);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);
  });
});
