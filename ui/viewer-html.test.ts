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

  // Feature: 設計外検索の標準動作抑止
  // Scenario: HTMLプレビュー内のCtrl-Fで標準検索を起動しない
  // Given: HTMLプレビューのiframeが読み込み済み
  // When: iframe内でCtrl-Fを押す
  // Then: iframe内の既定検索動作を抑止する
  it("Scenario: HTMLプレビュー内のCtrl-Fを標準検索へ漏らさない", () => {
    const { frame } = createHtmlPreview({
      name: "index.html",
      html: "<p>hello</p>",
      baseUrl: null,
      onContextMenu: () => undefined,
    });
    const child = document.implementation.createHTMLDocument("preview");
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: child });
    frame.dispatchEvent(new Event("load"));
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });

    child.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
