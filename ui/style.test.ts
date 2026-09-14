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
    expect(style).toMatch(/#preview\s*\{[^}]*min-width:\s*min\(var\(--preview-min-width\),\s*100%\);/s);
  });

  // Feature: 狭いwindowの横方向レイアウト
  // Scenario: 復元状態のwindowを手動で縮めてもペインが横へはみ出さない
  // Given: mainとpreviewのflexレイアウト規則を読み込む
  // When: 横幅が標準最小幅を下回るケースを検査する
  // Then: mainが横溢れを隠し、previewは利用可能な幅まで縮小できる
  it("Scenario: 狭いwindowでも右端の横溢れを画面外へ残さない", () => {
    expect(style).toMatch(/#titlebar\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/#main\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/#editorhost\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/#preview\s*\{[^}]*min-width:\s*min\(var\(--preview-min-width\),\s*100%\);[^}]*min-height:\s*0;/s);
  });

  // Feature: ペイン分割幅の単一管理
  // Scenario: サイドバーとプレビューの分割バーを同じ幅で描画する
  // Given: 分割バーのCSS規則と実行時に設定する共有変数を読み込む
  // When: 両方の分割バーの幅指定を検査する
  // Then: 片方だけ固定値へ依存せず、共通のCSS変数を参照する
  it("Scenario: 両方の分割バーを共通の幅定義へ揃える", () => {
    expect(style).toMatch(/#splitter\s*\{[^}]*width:\s*var\(--pane-splitter-width\);/s);
    expect(style).toMatch(/#preview-splitter\s*\{[^}]*width:\s*var\(--pane-splitter-width\);/s);
  });

  // Feature: エディタ右上コントロールの近接表示
  // Scenario: 検索欄とプレビュー開閉ボタンを重ねず表示する
  // Given: エディタのCSSとメイン画面HTML
  // When: 検索欄の右位置とプレビュー開閉ボタンを検査する
  // Then: 検索欄はエディタ上端を占有し、プレビュー開閉ボタンは境界へ近づいた時だけ見える
  it("Scenario: 検索欄を占有表示しプレビュー開閉ボタンを必要時だけ見せる", () => {
    expect(style).toMatch(/\.ve-find\s*\{[^}]*top:\s*0;[^}]*left:\s*0;[^}]*right:\s*0;/s);
    expect(style).toMatch(/\.ve-find-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(110px,\s*1fr\)[^;]*minmax\(110px,\s*1fr\)/s);
    expect(style).toMatch(/\.ve-rep-in\s*\{[^}]*grid-column:\s*6;/s);
    expect(style).toMatch(/\.ve-rep-actions\s*\{[^}]*grid-column:\s*7\s*\/\s*9;/s);
    expect(style).toMatch(/\.ve-find-close\s*\{[^}]*grid-column:\s*9;/s);
    expect(style).not.toContain(".ve-find-toggle");
    expect(style).not.toContain(".ve-find.with-rep");
    expect(style).toMatch(/\.ve-search-open\s+\.ve-gutter,[\s\S]*\.ve-search-open\s+\.ve-scroll\s*\{[^}]*top:\s*40px;/s);
    expect(style).toMatch(/#main\.preview-toggle-peek\s+#preview-toggle,[\s\S]*#preview-toggle:focus-visible/);
    expect(style).toMatch(/#preview-toggle\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(indexHtml).toMatch(/<button\s+id="preview-toggle"(?![^>]*\shidden(?:\s|=|>))[^>]*>/s);
  });

  // Feature: プレビュー開閉ボタン幅のCSS同期
  // Scenario: TypeScriptで管理するボタン幅をCSSでも共有する
  // Given: プレビュー開閉ボタンのCSSと起動時レイアウト設定がある
  // When: ボタンの最小幅指定とCSS変数の設定を検査する
  // Then: CSSは固定値を持たず、共有CSS変数を参照する
  it("Scenario: プレビュー開閉ボタン幅を共有CSS変数から取得する", () => {
    expect(style).toMatch(/#preview-toggle\s*\{[^}]*min-width:\s*var\(--preview-toggle-width\);/s);
    expect(style).not.toMatch(/#preview-toggle\s*\{[^}]*min-width:\s*28px;/s);
  });

  // Feature: 検索バー表示中のプレビュー開閉操作
  // Scenario: 検索バーを表示してもプレビュー開閉ボタンを操作できる位置へ移す
  // Given: エディタ上端を40px占有する検索バーと、通常時は上端にあるプレビュー開閉ボタン
  // When: エディタの検索バーが表示される
  // Then: プレビュー開閉ボタンは検索バーの下の44px位置へ移り、検索バーと重ならない
  it("Scenario: 検索バー表示中はプレビュー開閉ボタンを検索バーの下へ移す", () => {
    expect(style).toMatch(/#editorhost\.ve-search-open\s*~\s*#preview-toggle\s*\{[^}]*top:\s*44px;/s);
  });

  // Feature: ファイルツリー下端の新規作成操作
  // Scenario: 項目が少なくても作成ボタンをサイドバー最下端へ固定する
  // Given: サイドバー・ツリー・作成欄のCSS
  // When: 残余高と押し下げ規則を検査する
  // Then: ツリーが残余高を占有し、作成欄がツリーの外側で下端へ配置される
  it("Scenario: 新規作成ボタンを項目数に関係なくサイドバー最下端へ固定する", () => {
    expect(style).toMatch(/#sidebar\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(style).toMatch(/\.fv-tree\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(style).toMatch(/\.fv-create-actions\s*\{[^}]*flex:\s*none;/s);
  });

  // Feature: フォルダ検索の検索欄と置換欄の整列
  // Scenario: 置換欄の左端を検索欄の左端へ揃える
  // Given: 検索欄の左に置換開閉ボタンがある
  // When: 検索バーのCSSを検査する
  // Then: 開閉ボタン幅と置換行の左余白が同じCSS変数を参照する
  it("Scenario: 置換欄を検索欄と同じ左端へ配置する", () => {
    expect(style).toMatch(/\.ws-search\s*\{[^}]*--ws-input-indent:\s*\d+px;/s);
    expect(style).toMatch(/\.ws-replace-toggle\s*\{[^}]*width:\s*var\(--ws-input-indent\);/s);
    expect(style).toMatch(/\.ws-replace-row\s*\{[^}]*padding-left:\s*var\(--ws-input-indent\);/s);
  });
});

describe("Feature: file tree trailing padding", () => {
  // Given: ファイルツリーの行高を22pxとして表示規則を読み込む
  // When: ファイルツリー末尾の空白領域の高さを検査する
  // Then: 3行分の66pxをスクロール対象として確保する
  it("Scenario: ファイルツリー末尾に3行分の高さを確保する", () => {
    expect(style).toMatch(/\.fv-tree\s*\{[^}]*--fv-row-height:\s*22px;/s);
    expect(style).toMatch(/\.fv-row\s*\{[^}]*height:\s*var\(--fv-row-height\);/s);
    expect(style).toMatch(/\.fv-tree-bottom-padding\s*\{[^}]*height:\s*calc\(var\(--fv-row-height\)\s*\*\s*3\);/s);
    expect(style).toMatch(/\.fv-tree-bottom-padding\s*\{[^}]*flex:\s*none;/s);
  });
});
