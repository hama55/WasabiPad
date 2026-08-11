// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LiveViewers } from "./live-viewers";

describe("Feature: LiveViewers", () => {
  // Given: viewer範囲が2行目3列〜3行目6列、選択が2行目5列
  // When: csv viewerを開き、選択を3行目1列へ変更して120ms待つ
  // Then: 初回・更新ともviewer範囲基準の相対位置を渡す
  it("Scenario: sends the editor selection relative to a selected viewer range", async () => {
    vi.useFakeTimers();
    const openViewer = vi.fn(async () => "viewer-1");
    const updateViewer = vi.fn(async () => true);
    const viewers = new LiveViewers({
      openViewer,
      updateViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 9, col: 0 } }),
      textInRange: async () => "first\nsecond",
    });

    await viewers.open(
      "csv",
      { start: { line: 2, col: 3 }, end: { line: 3, col: 6 } },
      { start: { line: 2, col: 5 }, end: { line: 2, col: 5 } },
    );
    expect(openViewer).toHaveBeenCalledWith("csv", "first\nsecond", {
      start: { line: 0, col: 2 }, end: { line: 0, col: 2 },
    });
    expect(viewers.previewRange()).toEqual({
      start: { line: 2, col: 3 }, end: { line: 3, col: 6 },
    });
    expect(viewers.positionInDocument({ line: 0, col: 2 })).toEqual({ line: 2, col: 5 });
    expect(viewers.positionInDocument({ line: 9, col: 99 })).toEqual({ line: 3, col: 6 });

    viewers.setSelection({ start: { line: 3, col: 1 }, end: { line: 3, col: 1 } });
    await vi.advanceTimersByTimeAsync(120);
    expect(updateViewer).toHaveBeenCalledWith("viewer-1", "first\nsecond", {
      start: { line: 1, col: 1 }, end: { line: 1, col: 1 },
    });
    vi.useRealTimers();
  });

  // Given: 異なる原文範囲を持つ2つのviewerが登録されている
  // When: previewRangeと逆同期位置を問い合わせる
  // Then: 送信元を特定できないため、曖昧な範囲を採用しない
  // Given: 選択範囲の終端とは別に、実際に操作しているキャレット位置がある
  // When: 選択範囲を指定してCSVビューアを開く
  // Then: ビューアへ選択範囲とキャレット位置を相対座標で渡す
  it("Scenario: 複数行選択のキャレット位置をビューアへ渡す", async () => {
    const openViewer = vi.fn(async () => "viewer-1");
    const viewers = new LiveViewers({
      openViewer,
      updateViewer: async () => true,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 9, col: 0 } }),
      textInRange: async () => "first\nsecond",
    });

    await viewers.open(
      "csv",
      { start: { line: 2, col: 3 }, end: { line: 4, col: 6 } },
      { start: { line: 2, col: 5 }, end: { line: 4, col: 2 } },
      { line: 2, col: 5 },
    );

    expect(openViewer).toHaveBeenCalledWith("csv", "first\nsecond", {
      start: { line: 0, col: 2 },
      end: { line: 2, col: 2 },
      caret: { line: 0, col: 2 },
    });
  });

  it("Scenario: avoids ambiguous reverse mapping across different viewer ranges", async () => {
    const openViewer = vi.fn()
      .mockResolvedValueOnce("viewer-1")
      .mockResolvedValueOnce("viewer-2");
    const viewers = new LiveViewers({
      openViewer,
      updateViewer: async () => true,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 9, col: 0 } }),
      textInRange: async () => "text",
    });

    await viewers.open("csv", { start: { line: 1, col: 0 }, end: { line: 2, col: 0 } }, {
      start: { line: 1, col: 0 }, end: { line: 1, col: 0 },
    });
    await viewers.open("markdown", { start: { line: 4, col: 0 }, end: { line: 5, col: 0 } }, {
      start: { line: 4, col: 0 }, end: { line: 4, col: 0 },
    });

    expect(viewers.previewRange()).toBeNull();
    expect(viewers.positionInDocument({ line: 0, col: 2 })).toEqual({ line: 0, col: 2 });
  });

  // Given: updateがreject、true、falseの順に返る
  // When: refreshを120ms間隔で3回実行
  // Then: reject後も停止せず`updateViewer`が3回呼ばれる
  it("Scenario: 一時失敗では追随を止めず、閉じたビューだけを外す", async () => {
    vi.useFakeTimers();
    const updateViewer = vi.fn()
      .mockRejectedValueOnce(new Error("IPC disconnected"))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const viewers = new LiveViewers({
      openViewer: async () => "viewer-1",
      updateViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
    });

    await viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);

    expect(updateViewer).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  // Given: viewer起動Promiseが保留中
  // When: 起動中に`clear()`し、旧viewer ID解決後refresh
  // Then: 旧viewerへのupdateは呼ばれない
  it("Scenario: 文書切替中に開いた旧ビューを再登録しない", async () => {
    vi.useFakeTimers();
    let resolveOpen!: (label: string) => void;
    const openViewer = vi.fn(() => new Promise<string>((resolve) => { resolveOpen = resolve; }));
    const updateViewer = vi.fn(async () => true);
    const closeViewer = vi.fn(async () => {});
    const viewers = new LiveViewers({
      openViewer,
      updateViewer,
      closeViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
    });

    const opening = viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    await vi.waitFor(() => expect(openViewer).toHaveBeenCalledOnce());
    viewers.clear();
    resolveOpen("old-viewer");
    await opening;
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);

    expect(updateViewer).not.toHaveBeenCalled();
    expect(closeViewer).toHaveBeenCalledWith("old-viewer");
    vi.useRealTimers();
  });

  // Given: 全文取得中のviewer起動Promiseが保留されている
  // When: 本文取得中に`clear()`してから旧本文を解決する
  // Then: 古い本文で`openViewer`を呼ばない
  it("Scenario: 文書切替後の保留本文からビューを開かない", async () => {
    let resolveText!: (text: string) => void;
    const openViewer = vi.fn(async () => "old-viewer");
    const textInRange = vi.fn(() => new Promise<string>((resolve) => { resolveText = resolve; }));
    const viewers = new LiveViewers({
      openViewer,
      updateViewer: async () => true,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange,
    });

    const opening = viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    await vi.waitFor(() => expect(textInRange).toHaveBeenCalledOnce());
    viewers.clear();
    resolveText("old text");
    await opening;

    expect(openViewer).not.toHaveBeenCalled();
  });

  // Given: viewer-1 が登録済みで closeViewer が注入されている
  // When: 文書切替のために clear() する
  // Then: 登録済みの外部ビューも閉じる依頼を出す
  it("Scenario: clear時に登録済みの外部ビューを閉じる", async () => {
    const closeViewer = vi.fn(async () => {});
    const viewers = new LiveViewers({
      openViewer: async () => "viewer-1",
      updateViewer: async () => true,
      closeViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
    });

    await viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    viewers.clear();
    await vi.waitFor(() => expect(closeViewer).toHaveBeenCalledWith("viewer-1"));
  });

  // Given: update Promiseが保留中
  // When: refresh開始後に`clear()`してPromiseを解決
  // Then: 旧viewerのupdate呼び出しは1回だけ
  it("Scenario: 文書切替後に保留中の旧ビュー更新を続けない", async () => {
    vi.useFakeTimers();
    let resolveUpdate!: (exists: boolean) => void;
    const updateViewer = vi.fn(() => new Promise<boolean>((resolve) => { resolveUpdate = resolve; }));
    const viewers = new LiveViewers({
      openViewer: async () => "viewer-1",
      updateViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
    });

    await viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);
    viewers.clear();
    resolveUpdate(true);
    await Promise.resolve();

    expect(updateViewer).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  // Given: refreshが予期せず`unexpected`でreject
  // When: refreshをスケジュール
  // Then: 未処理Promiseにせず`onError(Error)`を呼ぶ
  it("Scenario: 予期しない更新失敗も未処理Promiseにせずエラー通知へ渡す", async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async () => {});
    const viewers = new LiveViewers({
      openViewer: async () => "viewer-1",
      updateViewer: async () => true,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
      onError,
    });
    await viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    vi.spyOn(viewers as unknown as { refresh: () => Promise<void> }, "refresh")
      .mockRejectedValueOnce(new Error("unexpected"));

    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    vi.useRealTimers();
  });

  // Feature: Live Viewer更新の直列化
  // Scenario: 古い更新が未完了の間に新しい選択位置で更新する
  // Given: 最初のupdateViewerが未解決
  // When: 選択位置を変更して最初の更新を完了する
  // Then: 最新の選択位置を使う更新を後から1回だけ実行する
  it("Scenario: 古いプレビュー更新の完了順で新しい選択位置を失わない", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (exists: boolean) => void;
    const updateViewer = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(true);
    const viewers = new LiveViewers({
      openViewer: async () => "viewer-1",
      updateViewer,
      wholeRange: async () => ({ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }),
      textInRange: async () => "text",
    });

    await viewers.open("csv", null, { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } });
    viewers.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(120);
    expect(updateViewer).toHaveBeenCalledOnce();

    viewers.setSelection({ start: { line: 0, col: 4 }, end: { line: 0, col: 4 } });
    resolveFirst(true);
    await vi.advanceTimersByTimeAsync(120);

    expect(updateViewer).toHaveBeenCalledTimes(2);
    expect(updateViewer.mock.calls[1][2]).toEqual({
      start: { line: 0, col: 4 },
      end: { line: 0, col: 4 },
    });
    vi.useRealTimers();
  });
});
