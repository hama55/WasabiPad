import { describe, expect, it } from "vitest";
import {
  effectivePreviewFormat,
  isPreviewFullscreen,
  isPreviewShown,
  isPreviewSplitterShown,
  previewWidthFromPointer,
  PREVIEW_MIN_WIDTH,
  resolvePaneVisibility,
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

  // Given: サイドバーとプレビューを表示したまま、エディタに必要な幅を確保できない
  // When: 現在のメイン領域に実効レイアウトを求める
  // Then: プレビューを先に縮退させ、さらに狭ければサイドバーも縮退させる
  it("Scenario: 狭いwindowでは本文領域を優先してペインを縮退する", () => {
    expect(resolvePaneVisibility({
      mainWidth: 600,
      sidebarAvailable: true,
      sidebarCollapsed: false,
      sidebarWidth: 220,
      previewAvailable: true,
      previewCollapsed: false,
      fullscreen: false,
    })).toEqual({ sidebarShown: true, previewShown: false, fullscreen: false });

    expect(resolvePaneVisibility({
      mainWidth: 250,
      sidebarAvailable: true,
      sidebarCollapsed: false,
      sidebarWidth: 220,
      previewAvailable: true,
      previewCollapsed: false,
      fullscreen: false,
    })).toEqual({ sidebarShown: false, previewShown: false, fullscreen: false });
  });

  // Feature: 利用者が変更したプレビュー幅
  // Scenario: 広いプレビューを保ったままwindowを狭くする
  // Given: プレビュー幅を600pxへ手動変更している
  // When: 本文最小幅を確保できない幅までwindowを縮める
  // Then: プレビューを一時退避して本文の表示領域を守る
  it("Scenario: 手動で広げたプレビューが本文を押し潰さない", () => {
    expect(resolvePaneVisibility({
      mainWidth: 700,
      sidebarAvailable: false,
      sidebarCollapsed: false,
      sidebarWidth: 220,
      previewAvailable: true,
      previewCollapsed: false,
      previewWidth: 600,
      fullscreen: false,
    })).toEqual({ sidebarShown: false, previewShown: false, fullscreen: false });
  });

  // Given: プレビュー全画面中のwindowがサイドバー幅より狭い
  // When: 実効レイアウトを求める
  // Then: サイドバーを退避し、プレビューだけを利用可能な幅で表示する
  it("Scenario: プレビュー全画面では狭いwindowからサイドバーを退避する", () => {
    expect(resolvePaneVisibility({
      mainWidth: 250,
      sidebarAvailable: true,
      sidebarCollapsed: false,
      sidebarWidth: 220,
      previewAvailable: true,
      previewCollapsed: false,
      fullscreen: true,
    })).toEqual({ sidebarShown: false, previewShown: true, fullscreen: true });
  });

  // Given: メイン領域そのものがプレビューの標準最小幅より狭い
  // When: splitterの位置からプレビュー幅を求める
  // Then: 画面外へはみ出さず、利用可能な幅へ収める
  it("Scenario: 標準最小幅より狭いwindowでもプレビュー幅を画面内へ収める", () => {
    expect(previewWidthFromPointer(200, 0)).toBe(200);
    expect(previewWidthFromPointer(200, 180)).toBe(200);
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

  // Scenario: 未知拡張子を手動でMarkdown表示したまま本文を更新する
  // Given: notes.txtに対してMarkdownプレビューが開いている
  // When: 拡張子からは形式を検出できない同じ文書を再同期する
  // Then: 開いているMarkdown形式を実効形式として維持する
  it("Scenario: 未知拡張子の手動Markdownプレビューを同じ文書内で維持する", () => {
    expect(effectivePreviewFormat(
      "C:\\work\\notes.txt",
      null,
      "folder-a",
      { ownerTabId: "folder-a", path: "C:\\work\\notes.txt", format: "markdown" },
    )).toBe("markdown");
    expect(effectivePreviewFormat(
      "C:\\work\\other.txt",
      null,
      "folder-a",
      { ownerTabId: "folder-a", path: "C:\\work\\notes.txt", format: "markdown" },
    )).toBeNull();
  });

  // Scenario: 別のフォルダtabにある同名ファイルへ手動形式を漏らさない
  // Given: folder-aのmemo.txtを手動でMarkdown表示している
  // When: folder-bの同じ相対pathのmemo.txtへ切り替える
  // Then: folder-aの手動形式ではなくfolder-bの検出形式を使う
  it("Scenario: 同じ相対pathでも別tabなら手動プレビュー形式を引き継がない", () => {
    expect(effectivePreviewFormat(
      "memo.txt",
      null,
      "folder-b",
      { ownerTabId: "folder-a", path: "memo.txt", format: "markdown" },
    )).toBeNull();
  });
});
