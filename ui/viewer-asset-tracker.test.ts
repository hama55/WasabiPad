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

  // Given: 現在表示中の世代と、表示準備中の新しい世代のURL
  // When: 新しい世代の表示を確定する
  // Then: 古いURLだけを破棄し、新しい表示のURLは保持する
  it("Scenario: 新しい世代の確定まで旧URLを保持する", () => {
    const revoke = vi.fn();
    const tracker = new ViewerAssetTracker(revoke);
    tracker.retain("blob:old", 1, 1);
    tracker.retain("blob:new", 2, 2);

    tracker.revokeStale(2);

    expect(revoke).toHaveBeenCalledWith("blob:old");
    expect(revoke).not.toHaveBeenCalledWith("blob:new");
  });

  // Given: 読み込みに失敗した現行世代の一時URL
  // When: 失敗表示へ切り替える
  // Then: 表示に使われないURLを保持しない
  it("Scenario: 読み込み失敗した現行URLを解放する", () => {
    const revoke = vi.fn();
    const tracker = new ViewerAssetTracker(revoke);
    tracker.retain("blob:failed", 3, 3);

    tracker.release("blob:failed");

    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:failed");
  });
});
