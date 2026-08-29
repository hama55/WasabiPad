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
});
