import { describe, expect, it } from "vitest";
import {
  isPreviewFullscreen,
  isPreviewShown,
  isPreviewSplitterShown,
  previewWidthFromPointer,
  PREVIEW_MIN_WIDTH,
} from "./preview-layout";

describe("Feature: preview layout", () => {
  // Given: メイン領域の右端が1200px、ポインターが900px
  // When: プレビュー境界をドラッグした幅を求める
  // Then: プレビュー幅は300pxになる
  it("Scenario: ドラッグ位置からプレビュー幅を決める", () => {
    expect(previewWidthFromPointer(1200, 900)).toBe(300);
  });

  // Given: メイン領域の右端が1200px、ポインターが1000px
  // When: プレビュー境界をドラッグした幅を求める
  // Then: 最小幅を下回らず260pxになる
  it("Scenario: プレビュー幅に最小値を設ける", () => {
    expect(previewWidthFromPointer(1200, 1000)).toBe(PREVIEW_MIN_WIDTH);
  });

  // Given: プレビューの可用/開閉/全画面状態を指定
  // When: レイアウト表示判定を求める
  // Then: 通常表示だけがプレビューとスプリッターを表示し、全画面はプレビューだけを表示する
  it("Scenario: 全画面時はスプリッターを隠す", () => {
    expect(isPreviewShown({ available: true, collapsed: false, fullscreen: false })).toBe(true);
    expect(isPreviewSplitterShown({ available: true, collapsed: false, fullscreen: false })).toBe(true);
    expect(isPreviewFullscreen({ available: true, collapsed: false, fullscreen: false })).toBe(false);

    expect(isPreviewShown({ available: true, collapsed: false, fullscreen: true })).toBe(true);
    expect(isPreviewSplitterShown({ available: true, collapsed: false, fullscreen: true })).toBe(false);
    expect(isPreviewFullscreen({ available: true, collapsed: false, fullscreen: true })).toBe(true);
  });
});
