// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createHtmlPreview, staticHtmlDocument } from "./viewer-html";

describe("Feature: static HTML preview", () => {
  // Given: 利用者が動的表示を選択した
  // When: 専用 URL で HTML を表示する
  // Then: スクリプトだけを許可し、親画面とは別オリジンにする
  it("Scenario: 動的HTMLを隔離されたiframeで表示する", () => {
    const dynamicUrl = "http://wasabi-html.localhost/id/__wasabipad_document__.html";
    const { frame } = createHtmlPreview({
      name: "index.html", html: "", baseUrl: null, dynamicUrl, onContextMenu: () => undefined,
    });
    expect(frame.src).toBe(dynamicUrl);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });
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

  // Feature: 静的HTMLプレビューのDOMベース無害化
  // Scenario: HTMLコメント内の偽headタグ・文字参照refresh・既存baseタグによるCSP回避を無効化する
  // Given: 偽の<head>コメント・文字参照のmeta refresh・外部baseタグを含むHTML
  // When: 静的HTML文書を組み立てる
  // Then: 本物のhead先頭へCSPと安全なbaseを挿入し、refreshと外部baseを除去する
  it("Scenario: defeats comment-head, entity-encoded refresh, and injected base bypasses", () => {
    const documentText = staticHtmlDocument(
      '<!-- <head> --><html><head><base href="https://evil.example/" target="_top"><meta http-equiv="&#114;efresh" content="0;url=https://evil.example/"></head><body><p>safe</p></body></html>',
      "http://asset.localhost/C%3A%2Fsite/",
    );
    const parsed = new DOMParser().parseFromString(documentText, "text/html");
    const metas = [...parsed.head.querySelectorAll("meta[http-equiv]")];
    expect(metas).toHaveLength(1);
    expect(metas[0].getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(metas[0].getAttribute("content")).toContain("script-src 'none'");
    expect(parsed.head.firstElementChild).toBe(metas[0]);

    const bases = [...parsed.querySelectorAll("base")];
    expect(bases).toHaveLength(1);
    expect(bases[0].getAttribute("href")).toBe("http://asset.localhost/C%3A%2Fsite/");
    expect(bases[0].getAttribute("target")).toBeNull();
  });

  // Feature: 静的HTMLプレビューのナビゲーション制限
  // Scenario: 文書内フラグメント以外のリンク遷移を遮断する
  // Given: 静的HTMLプレビュー内にasset URLリンクと文書内#リンクがある
  // When: それぞれのリンクをクリックする
  // Then: asset URLリンクの遷移は遮断し、文書内#リンクだけ許可する
  it("Scenario: blocks asset.localhost navigation while allowing in-document fragment links", () => {
    const { frame } = createHtmlPreview({
      name: "index.html",
      html: "<p>hello</p>",
      baseUrl: null,
      onContextMenu: () => undefined,
    });
    const child = document.implementation.createHTMLDocument("preview");
    const assetLink = child.createElement("a");
    assetLink.setAttribute("href", "http://asset.localhost/C%3A%2Fother.html");
    const fragmentLink = child.createElement("a");
    fragmentLink.setAttribute("href", "#section-1");
    child.body.append(assetLink, fragmentLink);
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: child });
    frame.dispatchEvent(new Event("load"));

    const assetClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    assetLink.dispatchEvent(assetClick);
    expect(assetClick.defaultPrevented).toBe(true);

    const fragmentClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    fragmentLink.dispatchEvent(fragmentClick);
    expect(fragmentClick.defaultPrevented).toBe(false);
  });
});
