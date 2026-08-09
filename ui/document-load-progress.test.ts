// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyDocumentLoadProgress,
  documentLoadProgressMessage,
} from "./document-load-progress";

describe("Feature: document load progress", () => {
  // Given: 進捗率が表示範囲を超えている
  // When: 読み込み進捗メッセージを作る
  // Then: 0〜100%へ丸めた表示になる
  it("Scenario: 読み込み進捗率を安全な表示範囲へ丸める", () => {
    expect(documentLoadProgressMessage({ percent: 101.4 })).toBe("読み込み中… 100%");
    expect(documentLoadProgressMessage({ percent: -2 })).toBe("読み込み中… 0%");
  });

  // Given: 読み込み表示がすでに終了している
  // When: 遅れて届いた進捗イベントを適用する
  // Then: 表示を再表示せず、メッセージも変更しない
  it("Scenario: 終了後の遅延進捗は読み込み表示を再表示しない", () => {
    const loading = document.createElement("div");
    loading.hidden = true;
    const message = document.createElement("span");
    message.textContent = "完了";

    expect(applyDocumentLoadProgress(loading, message, { percent: 50 })).toBe(false);
    expect(loading.hidden).toBe(true);
    expect(message.textContent).toBe("完了");
  });
});
