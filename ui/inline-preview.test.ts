// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ViewerFormat } from "./api";
import { InlinePreview, INLINE_PREVIEW_MESSAGES } from "./inline-preview";

function mount(
  onFormatChange?: (format: ViewerFormat) => void,
  onFontFamilyChange?: (family: string) => void,
  onError?: (error: unknown) => void | Promise<void>,
  onFullscreenChange?: () => void | Promise<void>,
  onSelectionChange?: (selection: { start: { line: number; col: number }; end: { line: number; col: number } }) =>
    void | Promise<void>,
  onMarkdownLink?: (href: string, newTab: boolean) => void | Promise<void>,
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
    onSelectionChange,
    onMarkdownLink,
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
  // When: 未登録の形式（unknown）を選択した通知を親へ送る
  // Then: 親側の形式切替処理を呼ばない
  it("Scenario: ignores an unregistered preview format", () => {
    const onFormatChange = vi.fn();
    const { host } = mount(onFormatChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "unknown" },
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

  // Feature: 指定形式の画像プレビュー
  // Scenario: 実パスと有効拡張子を別々にビューへ渡す
  // Given: 実ファイル`photo.bin`をsvgとして表示している
  // When: インラインプレビューを開いて準備完了通知を受け取る
  // Then: 読込用の実パスを変えず、有効拡張子svgもペイロードへ含める
  it("Scenario: forwards the effective extension without changing the real path", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    preview.setSourcePath("C:\\work\\photo.bin", null, null, "svg");
    await preview.open("image", "<svg></svg>", null);

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE,
      payload: expect.objectContaining({
        source_path: "C:\\work\\photo.bin",
        effective_extension: "svg",
      }),
    }), window.location.origin);
  });

  // Feature: プレビュー本文の初回描画
  // Scenario: ビューア準備後に付随設定を本文より先に同期する
  // Given: ビューアiframeが準備完了している
  // When: 各形式の文書をプレビューへ開く
  // Then: 区切り設定の同期が本文payloadより先に送られ、本文描画を中断しない
  it.each(["markdown", "html", "csv", "image", "pdf"] as ViewerFormat[])(
    "Scenario: %s本文の初回描画を付随設定が中断しない",
    async (format) => {
      const { host, preview } = mount();
      const frame = host.querySelector("iframe")!;
      const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
      }));
      await preview.open(format, "preview body", null);

      const types = postMessage.mock.calls.map(([message]) => (message as { type: string }).type);
      const delimiterIndex = types.indexOf(INLINE_PREVIEW_MESSAGES.DELIMITER_MESSAGE);
      const payloadIndex = types.indexOf(INLINE_PREVIEW_MESSAGES.PAYLOAD_MESSAGE);
      expect(delimiterIndex).toBeGreaterThanOrEqual(0);
      expect(payloadIndex).toBeGreaterThanOrEqual(0);
      expect(delimiterIndex).toBeLessThan(payloadIndex);
    },
  );

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

  // Given: プレビュー内でテキスト選択位置が通知される
  // When: 正しい形式の選択位置を受け取る
  // Then: エディタ同期用ポートへそのまま渡す
  it("Scenario: forwards a preview selection change", () => {
    const onSelectionChange = vi.fn();
    const { host } = mount(undefined, undefined, undefined, undefined, onSelectionChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: {
        type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
        selection: { start: { line: 2, col: 3 }, end: { line: 2, col: 5 } },
      },
    }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      start: { line: 2, col: 3 },
      end: { line: 2, col: 5 },
    });
  });

  // Feature: Markdownリンクの新規タブ通知
  // Scenario: MarkdownビューからCtrl+クリックされたローカルリンクを親へ渡す
  // Given: インラインプレビューのMarkdownリンク通知ポート
  // When: iframeからMarkdownリンクメッセージを受け取る
  // Then: hrefと新規タブ指定を親ポートへ渡す
  it("Scenario: forwards a Markdown link new-tab request", () => {
    const onMarkdownLink = vi.fn();
    const { host } = mount(undefined, undefined, undefined, undefined, undefined, onMarkdownLink);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: {
        type: INLINE_PREVIEW_MESSAGES.MARKDOWN_LINK_MESSAGE,
        href: "../manual.md#install",
        newTab: true,
      },
    }));

    expect(onMarkdownLink).toHaveBeenCalledWith("../manual.md#install", true);
  });

  // Given: Markdownプレビューが開いている
  // When: 親がfragment移動を要求する
  // Then: iframeへfragment移動メッセージを送る
  it("Scenario: Markdown fragment移動をプレビューへ送る", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    await preview.open("markdown", "# install", null);
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    preview.setMarkdownFragment("install");

    expect(postMessage).toHaveBeenCalledWith({
      type: INLINE_PREVIEW_MESSAGES.MARKDOWN_FRAGMENT_MESSAGE,
      fragment: "install",
    }, window.location.origin);
  });

  // Given: 次に開くMarkdownビューへfragment移動を予約する
  // When: 新しいプレビューを開く
  // Then: 新しいpayloadに対してfragment移動を通知する
  it("Scenario: 新しいMarkdownプレビューへfragment移動を予約する", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    preview.setMarkdownFragment("install");
    await preview.open("markdown", "# install", null);
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    expect(postMessage).toHaveBeenCalledWith({
      type: INLINE_PREVIEW_MESSAGES.MARKDOWN_FRAGMENT_MESSAGE,
      fragment: "install",
    }, window.location.origin);
  });

  // Given: インラインプレビューの文字サイズを変更する
  // When: iframeの準備完了通知を受け取る
  // Then: 保留していた文字サイズをプレビューへ送る
  it("Scenario: sends a queued preview font size after the iframe is ready", async () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    await preview.open("markdown", "# memo", null);
    preview.setFontSize(20);

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));

    expect(postMessage).toHaveBeenCalledWith({
      type: INLINE_PREVIEW_MESSAGES.FONT_SIZE_MESSAGE,
      size: 20,
    }, window.location.origin);
  });

  // Given: iframeから負の行番号を含む選択通知が届く
  // When: selection-changeメッセージを処理する
  // Then: 不正な座標はエディタ同期ポートへ渡さない
  it("Scenario: ignores invalid preview selections", () => {
    const onSelectionChange = vi.fn();
    const { host } = mount(undefined, undefined, undefined, undefined, onSelectionChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: {
        type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
        selection: { start: { line: -1, col: 0 }, end: { line: 0, col: 1 } },
      },
    }));

    expect(onSelectionChange).not.toHaveBeenCalled();
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

  // Given: iframeが準備完了していて、全画面状態がすでに同期済み
  // When: 同じ全画面状態をもう一度設定する
  // Then: 内容の再送信を発生させない
  it("Scenario: ignores an unchanged preview fullscreen state", () => {
    const { host, preview } = mount();
    const frame = host.querySelector("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: INLINE_PREVIEW_MESSAGES.READY_MESSAGE },
    }));
    postMessage.mockClear();
    preview.setFullscreen(false);

    expect(postMessage).not.toHaveBeenCalled();
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

  // Given: 親の選択位置同期ポートが例外を投げる
  // When: iframeから正しい選択通知を受け取る
  // Then: messageイベントから例外を漏らさずエラーポートへ通知する
  it("Scenario: reports preview selection callback failures", async () => {
    const onError = vi.fn();
    const onSelectionChange = vi.fn(() => { throw new Error("selection failed"); });
    const { host } = mount(undefined, undefined, onError, undefined, onSelectionChange);
    const frame = host.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: {
        type: INLINE_PREVIEW_MESSAGES.SELECTION_CHANGE_MESSAGE,
        selection: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      },
    }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  // Feature: プレビューエラー通知の境界
  // Scenario: エラー通知ポート自身がrejectする
  // Given: 形式変更ポートとエラー通知ポートがともに失敗する
  // When: iframeから形式切替通知を受け取る
  // Then: 二次エラーをconsoleへ出し、未処理rejectを発生させない
  it("Scenario: エラー通知ポートの失敗も吸収する", async () => {
    const onError = vi.fn(async () => { throw new Error("report failed"); });
    const onFormatChange = vi.fn(() => { throw new Error("format failed"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { host } = mount(onFormatChange, undefined, onError);
      const frame = host.querySelector("iframe")!;

      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: { type: INLINE_PREVIEW_MESSAGES.FORMAT_CHANGE_MESSAGE, format: "csv" },
      }));

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
        "プレビュー通知のエラー表示に失敗しました",
        expect.any(Error),
      ));
    } finally {
      consoleError.mockRestore();
    }
  });
});
