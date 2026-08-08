// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ViewerFormat } from "./api";
import { InlinePreview, INLINE_PREVIEW_MESSAGES } from "./inline-preview";

function mount(
  onFormatChange?: (format: ViewerFormat) => void,
  onFontFamilyChange?: (family: string) => void,
  onError?: (error: unknown) => void | Promise<void>,
  onFullscreenChange?: () => void | Promise<void>,
) {
  const host = document.createElement("div");
  host.appendChild(document.createElement("iframe"));
  document.body.appendChild(host);
  const onAvailabilityChange = vi.fn();
  const preview = new InlinePreview(host, {
    onAvailabilityChange,
    onFormatChange,
    onFontFamilyChange,
    onFullscreenChange,
    onError,
  });
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
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "csv" },
    }));

    expect(onFormatChange).toHaveBeenCalledWith("csv");
  });

  // Given: 右側プレビューが表示形式の選択を持つ
  // When: 未登録の形式を選択した通知を親へ送る
  // Then: 親側の形式切替処理を呼ばない
  it("Scenario: ignores an unregistered preview format", () => {
    const onFormatChange = vi.fn();
    const { host } = mount(onFormatChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "html" },
    }));

    expect(onFormatChange).not.toHaveBeenCalled();
  });

  // Given: 同じiframeのsourceでもoriginが異なる通知
  // When: CSV形式切替を通知する
  // Then: 親の形式切替ポートへ渡さない
  it("Scenario: ignores preview messages from another origin", () => {
    const onFormatChange = vi.fn();
    const { host } = mount(onFormatChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://untrusted.example",
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "csv" },
    }));

    expect(onFormatChange).not.toHaveBeenCalled();
  });

  // Given: エディタがプレビューのフォントファミリーを設定する前にビューを開いている
  // When: iframeの準備完了通知を受け取る
  // Then: 保留していたフォントファミリーをプレビューへ送る
  it("Scenario: sends a queued font family after the iframe is ready", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    await preview.open("markdown", "# memo", null);
    preview.setFontFamily("Meiryo, sans-serif");

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    expect(postMessage).toHaveBeenCalledWith({
      type: INLINE_PREVIEW_MESSAGES.FONT_MESSAGE,
      family: "Meiryo, sans-serif",
    }, window.location.origin);
  });

  // Given: アーカイブ内Markdownの本文と、画像解決に必要なアーカイブ情報を設定している
  // When: プレビューを開いてiframeの準備完了通知を受け取る
  // Then: アーカイブパスとエントリ名をビューへ渡す
  it("Scenario: forwards archive context with the preview payload", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    preview.setSourcePath("C:\\work\\data.zip", "C:\\work\\data.zip", "docs/readme.md");
    await preview.open("markdown", "![shot](image.png)", null);

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE,
      payload: expect.objectContaining({
        archive_path: "C:\\work\\data.zip",
        archive_entry: "docs/readme.md",
      }),
    }), window.location.origin);
  });

  // Given: インラインプレビューがフォント変更を通知する
  // When: フォントファミリー変更メッセージを受け取る
  // Then: 親の共通設定更新ポートへ値を渡す
  it("Scenario: forwards a preview font family change to the parent", () => {
    const onFontFamilyChange = vi.fn();
    const { host } = mount(undefined, onFontFamilyChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FONT_CHANGE_MESSAGE, family: "Meiryo, sans-serif" },
    }));

    expect(onFontFamilyChange).toHaveBeenCalledWith("Meiryo, sans-serif");
  });

  // Given: 右側プレビューのタイトルバーに全画面ボタンがある
  // When: 全画面切替通知を受け取る
  // Then: 親の全画面切替ポートへ渡す
  it("Scenario: forwards a preview fullscreen change", () => {
    const onFullscreenChange = vi.fn();
    const { host } = mount(undefined, undefined, undefined, onFullscreenChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FULLSCREEN_CHANGE_MESSAGE },
    }));

    expect(onFullscreenChange).toHaveBeenCalledOnce();
  });

  // Given: iframeが準備完了している
  // When: 親から全画面状態を設定する
  // Then: タイトルバーへ全画面状態を送る
  it("Scenario: sends the preview fullscreen state to the viewer", () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));
    preview.setFullscreen(true);

    expect(postMessage).toHaveBeenCalledWith({
      type: INLINE_PREVIEW_MESSAGES.FULLSCREEN_STATE_MESSAGE,
      fullscreen: true,
    }, window.location.origin);
  });

  // Given: 親への形式切替ポートが例外を投げる
  // When: iframeから形式切替通知を受け取る
  // Then: messageイベントから例外を漏らさずエラーポートへ通知する
  it("Scenario: reports preview message callback failures", async () => {
    const onError = vi.fn();
    const onFormatChange = vi.fn(() => { throw new Error("format failed"); });
    const { host } = mount(onFormatChange, undefined, onError);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "csv" },
    }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });
});
