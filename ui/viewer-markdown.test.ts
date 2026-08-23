// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  markdownHeadingSlug,
  markdownBlockSelected,
  markdownHighlightTargets,
  placeMarkdownCaret,
  renderRawHtml,
  scrollMarkdownFragment,
  scrollMarkdownCaret,
} from "./viewer-markdown";

const escape = (text: string) => {
  const element = document.createElement("div");
  element.textContent = text;
  return element.innerHTML;
};

describe("Feature: Markdown viewer specifications", () => {
  // Given: 空行を挟む`first.png`と`second.png`のimgタグ
  // When: `renderRawHtml`をtemplateへ設定
  // Then: img要素2個を生成し、srcは入力順
  it("Scenario: 空行を挟んだ連続imgタグをすべて画像として表示する", () => {
    const html = renderRawHtml(
      `\n<img src="first.png" alt="1">\n\n<img src="second.png" alt="2">\n`,
      escape,
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelectorAll("img")).toHaveLength(2);
    expect([...template.content.querySelectorAll("img")].map((image) => image.getAttribute("src")))
      .toEqual(["first.png", "second.png"]);
  });

  // Given: `<script>alert(1)</script>`を入力
  // When: `renderRawHtml`を呼ぶ
  // Then: `&lt;script&gt;alert(1)&lt;/script&gt;`として文字列化
  it("Scenario: img以外の生HTMLはHTMLとして解釈せず文字列で表示する", () => {
    expect(renderRawHtml("<script>alert(1)</script>", escape))
      .toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  // Feature: Markdownの明示改行
  // Scenario: 生HTMLのbrを使う
  // Given: 改行だけを表す`<br>`がある
  // When: `renderRawHtml`を呼ぶ
  // Then: 安全な改行要素としてそのまま描画する
  it("Scenario: br要素をMarkdownの改行として許可する", () => {
    expect(renderRawHtml("<br>", escape)).toBe("<br>");
  });

  // Given: 空のa要素と、スクリプト要素を含む生HTML
  // When: `renderRawHtml`を呼ぶ
  // Then: id付きの安全なアンカーだけをHTMLとして残し、スクリプトは文字列化する
  it("Scenario: 明示アンカーだけを安全な生HTMLとして許可する", () => {
    expect(renderRawHtml('<a id="install"></a>', escape)).toBe('<a id="install"></a>');
    expect(renderRawHtml('<span name="legacy">インストール</span>', escape))
      .toBe('<span name="legacy">インストール</span>');
    expect(renderRawHtml('<script id="bad">alert(1)</script>', escape))
      .toBe("&lt;script id=\"bad\"&gt;alert(1)&lt;/script&gt;");
  });

  // Given: `Install Guide v2!`というMarkdown見出し
  // When: 見出しのfragment IDを生成する
  // Then: 小文字化し、句読点を除き、空白をハイフンへ変換する
  it("Scenario: Markdown見出しからfragment用スラッグを作る", () => {
    expect(markdownHeadingSlug("Install Guide v2!")).toBe("install-guide-v2");
    expect(markdownHeadingSlug("日本語の 見出し")).toBe("日本語の-見出し");
  });

  // Given: id付きの対象要素、name付きの対象要素、スクロール可能な本文
  // When: fragmentへ移動する
  // Then: 最初に一致した要素を先頭へスクロールし、空fragmentは本文先頭へ戻す
  it("Scenario: Markdown fragmentを対象要素へスクロールする", () => {
    const article = document.createElement("article");
    const byId = document.createElement("h2");
    byId.id = "install";
    const byName = document.createElement("a");
    byName.setAttribute("name", "legacy");
    const articleScroll = vi.fn();
    const idScroll = vi.fn();
    const nameScroll = vi.fn();
    article.scrollIntoView = articleScroll;
    byId.scrollIntoView = idScroll;
    byName.scrollIntoView = nameScroll;
    article.append(byId, byName);

    expect(scrollMarkdownFragment(article, "install")).toBe(true);
    expect(idScroll).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    expect(scrollMarkdownFragment(article, "legacy")).toBe(true);
    expect(nameScroll).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    expect(scrollMarkdownFragment(article, "missing")).toBe(false);
    expect(scrollMarkdownFragment(article, "")).toBe(true);
    expect(articleScroll).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
  });

  // Given: outer範囲`0..3`内にinner範囲`1..2`とnext範囲`3..4`を配置
  // When: `markdownHighlightTargets`を呼ぶ
  // Then: `[inner, next]`だけを返す
  it("Scenario: 連なるMarkdownブロックは最も内側の要素だけを選択対象にする", () => {
    const outer = document.createElement("div");
    outer.dataset.sourceStart = "0";
    outer.dataset.sourceEnd = "3";
    const inner = document.createElement("p");
    inner.dataset.sourceStart = "1";
    inner.dataset.sourceEnd = "2";
    outer.appendChild(inner);
    const next = document.createElement("p");
    next.dataset.sourceStart = "3";
    next.dataset.sourceEnd = "4";

    expect(markdownHighlightTargets([outer, inner, next])).toEqual([inner, next]);
  });

  // Given: キャレットが3行目だけにある選択
  // When: `markdownBlockSelected`を範囲`3..4`/`4..5`で呼ぶ
  // Then: 前者は`true`、後者は`false`
  it("Scenario: キャレットだけの選択は該当するMarkdownブロックを選択状態にする", () => {
    const selection = {
      start: { line: 3, col: 2 },
      end: { line: 3, col: 2 },
    };

    expect(markdownBlockSelected(selection, 3, 4)).toBe(true);
    expect(markdownBlockSelected(selection, 4, 5)).toBe(false);
  });

  // Given: ソース `# hello` に対応する見出しDOMと4列目のキャレット
  // When: `placeMarkdownCaret`を呼ぶ
  // Then: 見出しの先頭ではなく`he`の直後へキャレットを挿入する
  it("Scenario: Markdownキャレットを選択位置へ表示する", () => {
    const heading = document.createElement("h1");
    heading.dataset.sourceStart = "0";
    heading.dataset.sourceEnd = "1";
    heading.dataset.sourceText = "# hello";
    heading.textContent = "hello";

    placeMarkdownCaret([heading], {
      start: { line: 0, col: 4 },
      end: { line: 0, col: 4 },
    });

    expect(heading.innerHTML).toBe("he<span class=\"viewer-markdown-caret\" aria-hidden=\"true\"></span>llo");
  });

  // Given: source範囲`4..6`の要素と4行目のキャレット
  // When: `scrollMarkdownCaret`を呼ぶ
  // Then: 対象要素を`{ block:"center", inline:"nearest" }`でスクロール
  it("Scenario: キャレット行をMarkdownビューの中央へスクロールする", () => {
    const target = document.createElement("p");
    target.dataset.sourceStart = "4";
    target.dataset.sourceEnd = "6";
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    scrollMarkdownCaret([target], {
      start: { line: 4, col: 0 },
      end: { line: 4, col: 3 },
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });

  // Given: 範囲`0..2`と`4..6`の間の空行3
  // When: `scrollMarkdownCaret`を呼ぶ
  // Then: 後続要素だけを中央スクロールし、先行要素は呼ばない
  it("Scenario: 空行では最寄りのMarkdownブロックを中央へスクロールする", () => {
    const before = document.createElement("p");
    before.dataset.sourceStart = "0";
    before.dataset.sourceEnd = "2";
    const after = document.createElement("p");
    after.dataset.sourceStart = "4";
    after.dataset.sourceEnd = "6";
    const beforeScroll = vi.fn();
    const afterScroll = vi.fn();
    before.scrollIntoView = beforeScroll;
    after.scrollIntoView = afterScroll;

    scrollMarkdownCaret([before, after], {
      start: { line: 3, col: 0 },
      end: { line: 3, col: 0 },
    });

    expect(beforeScroll).not.toHaveBeenCalled();
    expect(afterScroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });
});
