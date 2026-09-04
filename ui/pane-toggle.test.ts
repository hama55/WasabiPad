import { describe, expect, it } from "vitest";
import {
  PREVIEW_TOGGLE_DEFAULT_WIDTH,
  isPreviewTogglePeekPoint,
  paneToggleView,
  previewToggleLeft,
  sidebarToggleLeft,
} from "./pane-toggle";

describe("Feature: pane toggle controls", () => {
  // Given: フォルダビューが表示されている
  // When: 開閉ボタンの表示を求める
  // Then: 閉じる向きのChevronとラベルを返す
  it("Scenario: shows the sidebar close control", () => {
    expect(paneToggleView("sidebar", true)).toEqual({ icon: "\uE76B", title: "フォルダビューを閉じる" });
  });

  // Given: プレビューが閉じている
  // When: 開閉ボタンの表示を求める
  // Then: 開く向きのChevronとラベルを返す
  it("Scenario: shows the preview open control", () => {
    expect(paneToggleView("preview", false)).toEqual({ icon: "\uE76B", title: "プレビューを開く" });
  });

  // Given: フォルダビュー幅が220px
  // When: フォルダビューが表示/非表示のボタン位置を求める
  // Then: 表示時は右端、非表示時は左端になる
  it("Scenario: anchors the sidebar toggle to the correct edge", () => {
    expect(sidebarToggleLeft(true, 220)).toBe(188);
    expect(sidebarToggleLeft(false, 220)).toBe(4);
  });

  // Given: メイン領域左端が100px、プレビュー左端が900px、幅が1200px
  // When: プレビュー開閉ボタンの位置を求める
  // Then: 表示時はプレビュー左端、非表示時は右端になる
  it("Scenario: anchors the preview toggle to the preview edge", () => {
    expect(previewToggleLeft(true, 100, 900, 1200, PREVIEW_TOGGLE_DEFAULT_WIDTH)).toBe(800);
    expect(previewToggleLeft(false, 100, 900, 1200, PREVIEW_TOGGLE_DEFAULT_WIDTH)).toBe(1156);
  });

  // Feature: プレビュー開閉ボタンの近接表示
  // Scenario: 縦スクロールバー付近の操作可能領域へポインターを近づける
  // Given: プレビュー境界が画面上の900pxにある
  // When: 境界の左右から近接領域の内外へポインターを移動する
  // Then: ボタンの操作に必要な範囲だけが表示対象になる
  it("Scenario: keeps the preview toggle reachable across the preview boundary", () => {
    expect(isPreviewTogglePeekPoint(856, 900)).toBe(true);
    expect(isPreviewTogglePeekPoint(916, 900)).toBe(true);
    expect(isPreviewTogglePeekPoint(855, 900)).toBe(false);
    expect(isPreviewTogglePeekPoint(917, 900)).toBe(false);
  });
});
