// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createHtmlPreview, staticHtmlDocument } from "./viewer-html";

describe("Feature: static HTML preview", () => {
  // Given: ローカルHTML本文とローカル資産の基準URL
  // When: 静的HTML文書を組み立てる
  // Then: JavaScriptと外部通信を禁止し、資産の基準URLだけを埋め込む
  it("Scenario: applies the static local-only policy", () => {
    const documentText = staticHtmlDocument(
      '<meta http-equiv="refresh" content="0;url=https://example.com"><main><script>window.__executed = true;</script><img src="image.png"></main>',
      "asset://localhost/C:/site/",
    );

    expect(documentText).toContain("script-src 'none'");
    expect(documentText).toContain("connect-src 'none'");
    expect(documentText).toContain('base href="asset://localhost/C:/site/"');
    expect(documentText).toContain("<script>window.__executed = true;</script>");
    expect(documentText).not.toContain("http-equiv=\"refresh\"");
  });

  // Given: HTML本文と右クリック通知関数
  // When: HTMLプレビューを生成する
  // Then: iframeはallow-same-originだけのsandboxで表示する
  it("Scenario: renders HTML inside a scriptless sandbox", () => {
    const { wrapper, frame } = createHtmlPreview({
      name: "index.html",
      html: "<p>hello</p>",
      baseUrl: null,
      onContextMenu: () => undefined,
    });

    expect(wrapper.className).toBe("viewer-html-wrap");
    expect(frame.className).toBe("viewer-html");
    expect(frame.title).toBe("index.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.srcdoc).toContain("script-src 'none'");
  });
});
