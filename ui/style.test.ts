import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("Feature: editor caret style", () => {
  // Given: `style.css`のキャレット描画規則と入力用textarea規則を読み込む
  // When: カスタムキャレットとIME以外の入力欄に適用される表示規則を検査
  // Then: カスタムキャレットに animation/`ve-blink`はなく、通常入力のnative caretは透明で、`.on`が付いたカスタムキャレットだけ表示される
  it("Scenario: キャレットを点滅させず常に位置を追える表示にする", () => {
    expect(style).not.toContain("ve-blink");
    expect(style).toMatch(/\.ve-caret\.on\s*\{\s*display:\s*block;\s*\}/);
    expect(style).not.toMatch(/\.ve-caret(?:\.on)?\s*\{[^}]*\banimation\s*:/s);
    expect(style).toMatch(/\.ve-input\s*\{[^}]*caret-color:\s*transparent;/s);
  });
});

describe("Feature: pane toggle placement", () => {
  // Given: pane toggleのCSSを読み込む
  // When: フォルダビューとプレビューの開閉ボタン位置を検査する
  // Then: 両方とも下端ではなく上端に配置され、プレビュー最小幅はCSS変数を使う
  it("Scenario: anchors pane controls to the titlebar edges", () => {
    expect(style).toMatch(/#sidebar-toggle\s*\{[^}]*top:\s*4px;/s);
    expect(style).toMatch(/#preview-toggle\s*\{[^}]*top:\s*4px;/s);
    expect(style).not.toMatch(/#sidebar-toggle\s*\{[^}]*bottom:/s);
    expect(style).not.toMatch(/#preview-toggle\s*\{[^}]*bottom:/s);
    expect(style).toMatch(/#preview\s*\{[^}]*min-width:\s*var\(--preview-min-width\);/s);
  });
});
