import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

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

  // Feature: エディタ右上コントロールの常時利用
  // Scenario: 検索欄とプレビュー開閉ボタンを重ねず表示する
  // Given: エディタのCSSとメイン画面HTML
  // When: 検索欄の右位置とプレビュー開閉ボタンを検査する
  // Then: 検索欄はボタン幅ぶん左にあり、プレビュー開閉ボタンは初期状態から非表示ではない
  it("Scenario: 検索欄を左へずらしプレビュー開閉ボタンを常時表示する", () => {
    expect(style).toMatch(/\.ve-find\s*\{[^}]*right:\s*54px;/s);
    expect(indexHtml).toMatch(/<button\s+id="preview-toggle"(?![^>]*\shidden(?:\s|=|>))[^>]*>/s);
  });

  // Feature: フォルダツリー下端の新規作成操作
  // Scenario: 項目が少なくても作成ボタンをサイドバー最下端へ固定する
  // Given: サイドバー・ツリー・作成欄のCSS
  // When: 残余高と押し下げ規則を検査する
  // Then: ツリーが残余高を占有し、作成欄が自動マージンで下端へ配置される
  it("Scenario: 新規作成ボタンを項目数に関係なくサイドバー最下端へ固定する", () => {
    expect(style).toMatch(/#sidebar\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/\.fv-tree\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(style).toMatch(/\.fv-create-actions\s*\{[^}]*margin-top:\s*auto;/s);
  });
});
