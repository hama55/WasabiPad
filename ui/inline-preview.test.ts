// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { InlinePreview, INLINE_PREVIEW_MESSAGES } from "./inline-preview";

function mount(onFormatChange?: (format: "markdown" | "csv") => void) {
  const host = document.createElement("div");
  host.appendChild(document.createElement("iframe"));
  document.body.appendChild(host);
  const onAvailabilityChange = vi.fn();
  const preview = new InlinePreview(host, { onAvailabilityChange, onFormatChange });
  return { host, preview, onAvailabilityChange };
}

describe("Feature: inline preview", () => {
  // Given: 右側プレビューが空のホスト
  // When: Markdownビューを開いてからCSVビューへ切り替え、古いビューを閉じる
  // Then: 新しいビューは表示されたままで、古い終了通知が新しいビューを隠さない
  it("Scenario: keeps only the latest preview active", async () => {
    const { host, preview, onAvailabilityChange } = mount();

    const first = await preview.open("markdown", "# first", null);
    const second = await preview.open("csv", "a,b", null);
    await preview.close(first);

    expect(host.hidden).toBe(false);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);

    await preview.close(second);
    expect(host.hidden).toBe(true);
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);
  });

  // Given: 現在のプレビューが開いている
  // When: 古いラベルで更新してから現在のラベルで更新する
  // Then: 古い更新は拒否し、現在の更新だけを受け付ける
  it("Scenario: rejects updates for a closed preview", async () => {
    const { preview } = mount();
    const label = await preview.open("markdown", "# memo", null);

    expect(await preview.update("old-preview", "old", null)).toBe(false);
    expect(await preview.update(label, "new", null)).toBe(true);
  });

  // Given: 右側プレビューが表示形式の選択を持つ
  // When: CSVを選択した通知を親へ送る
  // Then: 親側の形式切替処理へCSVが渡る
  it("Scenario: forwards the selected preview format", () => {
    const onFormatChange = vi.fn();
    const { host } = mount(onFormatChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "csv" },
    }));

    expect(onFormatChange).toHaveBeenCalledWith("csv");
  });
});
