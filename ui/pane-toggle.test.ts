import { describe, expect, it } from "vitest";
import { paneToggleView, previewToggleLeft, sidebarToggleLeft } from "./pane-toggle";

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
    expect(previewToggleLeft(true, 100, 900, 1200, 28)).toBe(800);
    expect(previewToggleLeft(false, 100, 900, 1200, 28)).toBe(1156);
  });
});
