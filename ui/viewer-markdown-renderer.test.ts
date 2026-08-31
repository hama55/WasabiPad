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
  // Then: 通常改行も`br`になり、空行は段落を分け、タスク記号は操作不可のチェックボックスへ変換される
  it("Scenario: Markdown設定に応じた改行規則とタスクリストを表示する", () => {
    const { article } = renderMarkdownDocument(
      "first line\nsecond line  \nthird<br>line\n\nfourth paragraph\n\n- [ ] todo\n- [x] done",
      null,
    );

    const paragraphs = article.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelectorAll("br")).toHaveLength(3);
    const checkboxes = [...article.querySelectorAll<HTMLInputElement>("input.viewer-markdown-task")];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].disabled).toBe(true);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);
  });

  // Feature: Markdownプレビューの通常改行
  // Scenario: 設定ONで段落内の通常改行を表示する
  // Given: 段落内に半角スペース2つを付けない改行がある
  // When: `breaks: true`でMarkdownを描画する
  // Then: 通常改行も`br`として表示する
  it("Scenario: 設定ONで段落内の通常改行を表示する", () => {
    const { article } = renderMarkdownDocument("first line\nsecond line", null, { breaks: true });

    expect(article.querySelectorAll("p")).toHaveLength(1);
    expect(article.querySelectorAll("p br")).toHaveLength(1);
  });

  // Feature: Markdownプレビューの通常改行
  // Scenario: 設定OFFで段落内の通常改行を表示しない
  // Given: 段落内に半角スペース2つを付けない改行がある
  // When: `breaks: false`でMarkdownを描画する
  // Then: 通常改行を`br`へ変換しない
  it("Scenario: 設定OFFで段落内の通常改行を表示しない", () => {
    const { article } = renderMarkdownDocument("first line\nsecond line", null, { breaks: false });

    expect(article.querySelectorAll("p")).toHaveLength(1);
    expect(article.querySelectorAll("p br")).toHaveLength(0);
  });

  // Feature: Markdownプレビューの標準段落
  // Scenario: 連続空行を段落区切りとして扱う
  // Given: 2つの本文の間に複数の空行がある
  // When: Markdownを描画する
  // Then: 段落は2つに分かれ、独自の空白要素は追加しない
  it("Scenario: 連続空行は標準の段落区切りとして扱う", () => {
    const { article } = renderMarkdownDocument("first\n\n\nsecond", null, { breaks: true });

    expect(article.querySelectorAll("p")).toHaveLength(2);
    expect(article.querySelectorAll(".viewer-markdown-blank-line")).toHaveLength(0);
    expect([...article.children].map((element) => element.tagName)).toEqual(["P", "P"]);
  });

  // Feature: Markdownプレビューの空白行保持
  // Scenario: リスト内部の空行はMarkdownの構造を優先する
  // Given: 2つのリスト項目の間に空行がある
  // When: Markdown専用rendererで文書を描画する
  // Then: リストを壊す専用空白要素を追加しない
  it("Scenario: リスト内部の空行はMarkdown構造を維持する", () => {
    const { article } = renderMarkdownDocument("- first\n\n- second", null);

    expect(article.querySelectorAll(".viewer-markdown-blank-line")).toHaveLength(0);
    expect(article.querySelectorAll("li")).toHaveLength(2);
  });
});
