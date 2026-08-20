import { describe, expect, it } from "vitest";
import {
  isPreviewFullscreen,
  isPreviewShown,
  isPreviewSplitterShown,
  previewWidthFromPointer,
  PREVIEW_MIN_WIDTH,
  shouldKeepPreviewFullscreen,
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

  // Given: メイン領域の左端が100px、右端が1200px、ポインターが画面外の0px
  // When: プレビュー境界をドラッグした幅を求める
  // Then: メイン領域全体を超えず1100pxになる
  it("Scenario: プレビュー幅にメイン領域の最大値を設ける", () => {
    expect(previewWidthFromPointer(1200, 0, 100)).toBe(1100);
    expect(previewWidthFromPointer(1200, 0, 220)).toBe(980);
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

    expect(isPreviewShown({ available: false, collapsed: false, fullscreen: true })).toBe(false);
    expect(isPreviewShown({ available: true, collapsed: true, fullscreen: false })).toBe(false);
    expect(isPreviewSplitterShown({ available: true, collapsed: true, fullscreen: true })).toBe(false);
    expect(isPreviewFullscreen({ available: true, collapsed: true, fullscreen: true })).toBe(false);
  });

  // Feature: プレビュー最大化状態の所有権
  // Scenario: 同じフォルダタブ内のMarkdown切替では最大化を維持する
  // Given: folderタブがプレビュー最大化状態の所有者
  // When: 同じfolderタブで別のMarkdown表示へ切り替える
  // Then: 最大化状態を維持し、別タブまたは非対応形式では解除する
  it("Scenario: 同一タブ内のMarkdown切替ではプレビュー最大化を維持する", () => {
    expect(shouldKeepPreviewFullscreen("folder", "folder", true)).toBe(true);
    expect(shouldKeepPreviewFullscreen("folder", "other", true)).toBe(false);
    expect(shouldKeepPreviewFullscreen("folder", "folder", false)).toBe(false);
  });
});
