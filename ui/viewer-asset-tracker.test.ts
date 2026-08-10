import { describe, expect, it, vi } from "vitest";
import { ViewerAssetTracker } from "./viewer-asset-tracker";

describe("Feature: プレビューアセット所有権", () => {
  // Given: 現在世代で保持したアーカイブ画像URL
  // When: 全アセットを解放する
  // Then: URLを一度だけ破棄し、保持状態を空にする
  it("Scenario: 全アセットを一括解放する", () => {
    const revoke = vi.fn();
    const tracker = new ViewerAssetTracker(revoke);
    tracker.retain("blob:a", 1, 1);
    tracker.retain("blob:b", 1, 1);

    tracker.revokeAll();
    tracker.revokeAll();

    expect(revoke.mock.calls).toEqual([["blob:a"], ["blob:b"]]);
  });

  // Given: 古い描画世代から遅れて画像URLが返る
  // When: 現在世代が進んだ状態で保持を試みる
  // Then: そのURLを即座に破棄し、所有対象へ加えない
  it("Scenario: 古い世代のURLを保持しない", () => {
    const revoke = vi.fn();
    const tracker = new ViewerAssetTracker(revoke);

    expect(tracker.retain("blob:old", 1, 2)).toBe(false);
    tracker.release("blob:old");

    expect(revoke).toHaveBeenCalledOnce();
  });

  // Given: 先頭URLの解放が例外を投げる複数URL
  // When: すべてのURLを解放する
  // Then: 後続URLも解放を試行し、追跡状態を空にする
  it("Scenario: URL解放の失敗が後続の後始末を止めない", () => {
    const revoke = vi.fn((url: string) => {
      if (url === "blob:a") throw new Error("revoke failed");
    });
    const tracker = new ViewerAssetTracker(revoke);
    tracker.retain("blob:a", 1, 1);
    tracker.retain("blob:b", 1, 1);

    tracker.revokeAll();
    tracker.retain("blob:c", 1, 1);
    tracker.revokeAll();

    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:a", "blob:b", "blob:c"]);
  });
});
