import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./viewer.css", import.meta.url), "utf8");

describe("Feature: viewer viewport layout", () => {
  // Given: standalone/inline viewerのflexレイアウト規則を読み込む
  // When: 横幅の大きな表やiframeを含む狭いwindowの規則を検査する
  // Then: rootが内容に引っ張られず、viewer contentが自分のviewport内でスクロールする
  it("Scenario: 狭いviewer windowでも本文viewportを横へ押し広げない", () => {
    expect(style).toMatch(/#titlebar\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/main\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/#viewer-content\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(style).toMatch(/#viewer-content:empty::before\s*\{[^}]*content:\s*"読み込み中…";/s);
    expect(style).toMatch(/#viewer-content\.viewer-loading\s*>\s*\*,\s*main\.viewer-loading\s*>\s*\*\s*\{\s*pointer-events:\s*none;/s);
    expect(style).toMatch(/#viewer-content\s*>\s*\.viewer-pending\s*\{[^}]*position:\s*absolute;[^}]*visibility:\s*hidden;/s);
    expect(style).toMatch(/#viewer-content\s*>\s*\.viewer-pending:only-child\s*\{[^}]*visibility:\s*visible;/s);
  });

  // Given: PDF・HTML・画像viewerのwrapperとiframeがviewportの子である
  // When: restore後の寸法変化を受けるCSS規則を検査する
  // Then: 子要素が親の有効領域からはみ出さず、空の右上領域を作らない
  it("Scenario: viewerのコンテンツを親viewportへ追随させる", () => {
    expect(style).toMatch(/\.viewer-pdf-wrap\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(style).toMatch(/\.viewer-html-wrap\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(style).toMatch(/\.viewer-image-wrap\s*\{[^}]*min-width:\s*0;/s);
    expect(style).toMatch(/\.viewer-pdf,\s*\.viewer-html\s*\{[^}]*max-width:\s*100%;/s);
  });

  // Feature: Markdown本文の可読性
  // Scenario: 見出し・本文・列挙のCSSを表示する
  // Given: Markdown viewerのCSS
  // When: 本文のレイアウト規則を検査する
  // Then: 既定の共通規則に見出しの下線はなく、設定クラスで切り替え可能な行間と間隔を使う
  it("Scenario: Markdown本文の行間とブロック間隔を読みやすくする", () => {
    expect(style).not.toMatch(/article\s+h[1-6][^{]*\{[^}]*border-bottom/s);
    expect(style).toContain("line-height: var(--markdown-line-height);");
    expect(style).not.toContain("var(--markdown-line-height, 1.65)");
    expect(style).toMatch(/article\s+:where\(h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\)\s*\{[^}]*margin-block:/s);
    expect(style).toMatch(/article\s+:where\(p,\s*blockquote,\s*pre,\s*table\)\s*\{[^}]*margin-block:/s);
    expect(style).toMatch(/article\s+:where\(ul,\s*ol\)\s*\{[^}]*margin-block:/s);
    expect(style).toMatch(/article\s+li\s*\+\s*li\s*\{[^}]*margin-block-start:/s);
    expect(style).toMatch(/:root\.markdown-heading-underlines\s+article\s+:where\(h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\)\s*\{[^}]*border-bottom:/s);
  });

  // Feature: Markdownプレビューのカーソル表示
  // Scenario: 対象ブロックの本文位置を保ったまま左端を色付けする
  // Given: viewer.cssにカーソル対象ブロックのスタイルがある
  // When: カーソル対象ブロックの表示規則を確認する
  // Then: アクセント色の帯を左側へ描画し、境界線や余白で本文を押し下げない
  it("Scenario: カーソル対象ブロックの本文をずらさず左端を色付けする", () => {
    expect(style).toMatch(
      /\.viewer-caret-line\s*\{[^}]*box-shadow:\s*inset 3px 0 0 color-mix\(in srgb,\s*var\(--accent\)\s+30%,\s*transparent\);[^}]*\}/s,
    );
    expect(style).not.toMatch(/\.viewer-caret-line\s*\{[^}]*border-left:/s);
    expect(style).not.toMatch(/\.viewer-caret-line\s*\{[^}]*padding-left:/s);
  });

});
