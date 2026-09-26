// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MARKDOWN_IMAGE_SOURCE_ATTRIBUTE, renderMarkdownDocument } from "./viewer-markdown-renderer";
import { viewerSelectionFromDom } from "./viewer-selection";

describe("Feature: Markdown viewer drawing boundary", () => {
  // Given: 箇条書き本文に同じ`Git`が2回あり、エディタ位置は1つ目の直前
  // When: Markdown rendererで本文を描画する
  // Then: プレビューのキャレットも1つ目の`Git`直前に置く
  it("Scenario: repeated text keeps the editor caret on the matching source occurrence", () => {
    const source = '- 通常のビルドはGitの作業ツリー状態に依存させない。`npm run build` では生成ファイルのGit差分を検査しない。';
    const firstGit = source.indexOf("Git");
    const { article } = renderMarkdownDocument(source, {
      start: { line: 0, col: [...source.slice(0, firstGit)].length },
      end: { line: 0, col: [...source.slice(0, firstGit)].length },
    });
    const caret = article.querySelector(".viewer-markdown-caret");
    const range = document.createRange();
    range.selectNodeContents(article.querySelector("li")!);
    range.setEndBefore(caret!);

    expect(range.toString()).toBe("通常のビルドは");
  });

  // Given: プレビュー本文に同じ`Git`が2回ある
  // When: 1つ目の`Git`の前を選択し、ソース位置へ変換する
  // Then: エディタ側も1つ目の`Git`直前を返す
  it("Scenario: repeated preview text maps back to its own source occurrence", () => {
    const source = '- 通常のビルドはGitの作業ツリー状態に依存させない。`npm run build` では生成ファイルのGit差分を検査しない。';
    const { article } = renderMarkdownDocument(source, null);
    document.body.append(article);
    const mappedText = [...article.querySelectorAll<HTMLElement>("[data-source-offset-start]")]
      .find((span) => span.textContent?.includes("Git"));
    const text = mappedText?.firstChild;
    expect(text).toBeInstanceOf(Text);
    const offset = (text?.textContent ?? "").indexOf("Git");
    window.getSelection()?.setBaseAndExtent(text!, offset, text!, offset);

    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 0, col: [...source.slice(0, source.indexOf("Git"))].length },
      end: { line: 0, col: [...source.slice(0, source.indexOf("Git"))].length },
    });
  });

  // Given: プレビュー上で通常改行がbr要素に変換されている
  // When: 改行の直前と直後をそれぞれ選択位置としてエディタへ戻す
  // Then: 原文の改行前後の境界を返す
  it.each([
    { lineEnding: "LF", value: "\n" },
    { lineEnding: "CRLF", value: "\r\n" },
    { lineEnding: "CR", value: "\r" },
  ])("Scenario: preview $lineEnding line breaks map back to both source boundaries", ({ value }) => {
    const source = `first line${value}second line`;
    const { article } = renderMarkdownDocument(source, null);
    document.body.append(article);
    const lineBreak = article.querySelector("br")!;
    const paragraph = lineBreak.parentElement!;
    const childIndex = [...paragraph.childNodes].indexOf(lineBreak);
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(paragraph, childIndex, paragraph, childIndex);
    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 0, col: 10 },
      end: { line: 0, col: 10 },
    });

    selection.setBaseAndExtent(paragraph, childIndex + 1, paragraph, childIndex + 1);
    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 1, col: 0 },
      end: { line: 1, col: 0 },
    });
  });

  // Given: 改行文字を表す文字参照を含むMarkdown本文
  // When: 段落内の改行表示を有効にして描画する
  // Then: 文字参照を実際のソース改行と誤認してbr要素へ変換しない
  it.each(["&NewLine;", "&#10;", "&#13;"])("Scenario: $0 remains inline text instead of a source line break", (entity) => {
    const { article } = renderMarkdownDocument(`before${entity}after`, null);

    expect(article.querySelector("br")).toBeNull();
  });

  // Given: CR文字参照の後に実際のソース改行を含むMarkdown本文
  // When: 段落内の改行表示を有効にして描画する
  // Then: 文字参照は文字のまま、実際の改行だけをbr要素へ変換する
  it("Scenario: a CR character reference does not hide a following source line break", () => {
    const { article } = renderMarkdownDocument("before&#13;\nafter", null);

    expect(article.querySelectorAll("br")).toHaveLength(1);
  });

  // Given: バックスラッシュでエスケープした記号と、その後の本文
  // When: エディタ位置をエスケープ後の最初の単語の直前に置く
  // Then: プレビュー上も表示された記号の直後に対応する
  it("Scenario: escaped Markdown punctuation preserves the following caret position", () => {
    const source = String.raw`\*Git* and Git`;
    const firstGit = source.indexOf("Git");
    const { article } = renderMarkdownDocument(source, {
      start: { line: 0, col: [...source.slice(0, firstGit)].length },
      end: { line: 0, col: [...source.slice(0, firstGit)].length },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("*");
  });

  // Given: UTF-16では2単位になる絵文字の後ろにMarkdown本文がある
  // When: エディタ位置を本文中の単語の直前へ置く
  // Then: 絵文字を1文字として数え、プレビューの同じ位置へ対応する
  it("Scenario: supplementary Unicode characters preserve caret columns", () => {
    const source = "🌱 Git";
    const column = [...source.slice(0, source.indexOf("Git"))].length;
    const { article } = renderMarkdownDocument(source, {
      start: { line: 0, col: column },
      end: { line: 0, col: column },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("🌱 ");
  });

  // Given: 閉じフェンスのない有効なコードブロック
  // When: エディタ位置を2行目の先頭に置く
  // Then: コード表示の同じ行頭へキャレットを置く
  it("Scenario: unclosed fenced code blocks keep source positions", () => {
    const source = "```\nalpha\nbeta";
    const { article } = renderMarkdownDocument(source, {
      start: { line: 2, col: 0 },
      end: { line: 2, col: 0 },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("alpha\n");
    document.body.append(article);
    const mappedText = article.querySelector<HTMLElement>("[data-source-offset-start]")?.firstChild;
    window.getSelection()?.setBaseAndExtent(mappedText!, "alpha\n".length, mappedText!, "alpha\n".length);
    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 2, col: 0 },
      end: { line: 2, col: 0 },
    });
  });

  // Given: 4スペース字下げのコードブロック
  // When: エディタ位置を2行目のコード本文先頭に置く
  // Then: 字下げを除いたコード表示の同じ位置へキャレットを置く
  it("Scenario: indented code blocks keep source positions", () => {
    const source = "    alpha\n    beta";
    const { article } = renderMarkdownDocument(source, {
      start: { line: 1, col: 4 },
      end: { line: 1, col: 4 },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("alpha\n");
    document.body.append(article);
    const codeText = [...article.querySelectorAll<HTMLElement>("[data-source-offset-start]")]
      .find((span) => span.textContent === "beta")?.firstChild;
    window.getSelection()?.setBaseAndExtent(codeText!, 0, codeText!, 0);
    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 1, col: 4 },
      end: { line: 1, col: 4 },
    });
  });

  // Given: CR単独の改行で区切られたMarkdownリスト
  // When: 2行目の本文でエディタとプレビューの選択位置を相互変換する
  // Then: どちらの方向も2行目の同じ文字位置を返す
  it("Scenario: lone carriage-return line breaks preserve source positions", () => {
    const source = "- alpha\r- beta";
    const { article } = renderMarkdownDocument(source, {
      start: { line: 1, col: 4 },
      end: { line: 1, col: 4 },
    });
    const secondItem = article.querySelectorAll("li")[1]!;
    const caret = secondItem.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(secondItem);
    range.setEndBefore(caret);
    expect(range.toString()).toBe("be");

    document.body.append(article);
    const text = [...secondItem.querySelectorAll<HTMLElement>("[data-source-offset-start]")]
      .find((span) => span.textContent === "beta")?.firstChild;
    window.getSelection()?.setBaseAndExtent(text!, 2, text!, 2);
    expect(viewerSelectionFromDom(article)).toEqual({
      start: { line: 1, col: 4 },
      end: { line: 1, col: 4 },
    });
  });

  // Given: タブと空白を混ぜて字下げしたコードブロック
  // When: エディタ位置を2行目のコード本文先頭に置く
  // Then: 字下げの幅に関係なくソース位置を保つ
  it("Scenario: tab-indented code blocks keep source positions", () => {
    const source = "\talpha\n \tbeta";
    const { article } = renderMarkdownDocument(source, {
      start: { line: 1, col: 2 },
      end: { line: 1, col: 2 },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("alpha\n");
  });

  // Given: リスト内と引用内にフェンス付きコードブロックがある
  // When: 引用内コードの2行目本文先頭にエディタ位置を置く
  // Then: コンテナ記号を飛ばして引用内コードの同じ位置へ対応する
  it("Scenario: nested code blocks keep source positions", () => {
    const source = "- ```\n  alpha\n  ```\n> ```\n> beta\n> ```";
    const list = renderMarkdownDocument(source, {
      start: { line: 1, col: 2 },
      end: { line: 1, col: 2 },
    }).article;
    const listCaret = list.querySelectorAll("pre")[0]?.querySelector(".viewer-markdown-caret");
    const listRange = document.createRange();
    listRange.selectNodeContents(list.querySelectorAll("pre")[0]!);
    listRange.setEndBefore(listCaret!);
    expect(listRange.toString()).toBe("");

    const { article } = renderMarkdownDocument(source, {
      start: { line: 4, col: 2 },
      end: { line: 4, col: 2 },
    });
    const caret = article.querySelectorAll("pre")[1]?.querySelector(".viewer-markdown-caret");
    const range = document.createRange();
    range.selectNodeContents(article.querySelectorAll("pre")[1]!);
    range.setEndBefore(caret!);

    expect(range.toString()).toBe("");
  });

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

  // Feature: Markdown画像の遅延読み込み
  // Scenario: rendererが画像URLをローダーへ引き渡す
  // Given: 通常の相対パス画像を含むMarkdown
  // When: Markdown専用rendererで文書を描画する
  // Then: DOM挿入時の自動読込を防ぎ、元URLを専用data属性へ保持する
  it("Scenario: Markdown画像のURLを上限付きローダーへ委譲する", () => {
    const { article } = renderMarkdownDocument("![diagram](images/diagram.png)", null);
    const image = article.querySelector<HTMLImageElement>("img");

    expect(image?.getAttribute("src")).toBeNull();
    expect(image?.getAttribute(MARKDOWN_IMAGE_SOURCE_ATTRIBUTE)).toBe("images/diagram.png");
    expect(image?.alt).toBe("diagram");
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

  // Feature: GFM形式の互換性
  // Scenario: 表・取り消し線・URL自動リンクを描画する
  // Given: GFMの表、取り消し線、URLを含むMarkdown
  // When: Markdown専用rendererで描画する
  // Then: GFM要素として表示する
  it("Scenario: GFMの表、取り消し線、自動リンクを描画する", () => {
    const { article } = renderMarkdownDocument(
      "| item |\n| --- |\n| ~~old~~ |\n\n~~old~~ ~single~\n\nhttps://example.com",
      null,
    );

    expect(article.querySelector("table td del")?.textContent).toBe("old");
    expect(article.querySelector("p del")?.textContent).toBe("old");
    expect(article.querySelector("p")?.textContent).toContain("~single~");
    expect(article.querySelector('a[href="https://example.com"]')?.textContent)
      .toBe("https://example.com");
  });

  // Feature: Markdown生HTMLの安全性
  // Scenario: 実行要素と許可画像を同じ文書に含める
  // Given: scriptタグとイベント属性付き画像を含むMarkdown
  // When: Markdown専用rendererで描画する
  // Then: scriptを要素化せず、画像のイベント属性を除去する
  it("Scenario: Markdown生HTMLを既存の安全境界内で描画する", () => {
    const { article } = renderMarkdownDocument(
      '<script>alert(1)</script>\n\n<img src="diagram.png" onerror="alert(1)">',
      null,
    );

    expect(article.querySelector("script")).toBeNull();
    expect(article.textContent).toContain("<script>alert(1)</script>");
    expect(article.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(article.querySelector("img")?.getAttribute(MARKDOWN_IMAGE_SOURCE_ATTRIBUTE))
      .toBe("diagram.png");
  });

  // Given: 引用符が正規化される空アンカーと、その後の本文
  // When: エディタ位置を本文の先頭に置く
  // Then: HTML変換後も後続本文を原文位置へ正しく対応する
  it("Scenario: raw HTML normalization does not shift following source positions", () => {
    const source = "<a id='legacy'></a> Git";
    const firstGit = source.indexOf("Git");
    const { article } = renderMarkdownDocument(source, {
      start: { line: 0, col: [...source.slice(0, firstGit)].length },
      end: { line: 0, col: [...source.slice(0, firstGit)].length },
    });
    const caret = article.querySelector(".viewer-markdown-caret")!;
    const range = document.createRange();
    range.selectNodeContents(article);
    range.setEndBefore(caret);

    expect(range.toString()).toBe("</a> ");
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
