// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  markdownBlockSelected,
  markdownHighlightTargets,
  renderRawHtml,
  scrollMarkdownCaret,
} from "./viewer-markdown";

const escape = (text: string) => {
  const element = document.createElement("div");
  element.textContent = text;
  return element.innerHTML;
};

describe("Markdown viewer specifications", () => {
  it("空行を挟んだ連続imgタグをすべて画像として表示する", () => {
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

  it("img以外の生HTMLはHTMLとして解釈せず文字列で表示する", () => {
    expect(renderRawHtml("<script>alert(1)</script>", escape))
      .toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("連なるMarkdownブロックは最も内側の要素だけを選択対象にする", () => {
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

  it("キャレットだけの選択は該当するMarkdownブロックを選択状態にする", () => {
    const selection = {
      start: { line: 3, col: 2 },
      end: { line: 3, col: 2 },
    };

    expect(markdownBlockSelected(selection, 3, 4)).toBe(true);
    expect(markdownBlockSelected(selection, 4, 5)).toBe(false);
  });

  it("キャレット行をMarkdownビューの中央へスクロールする", () => {
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
});
