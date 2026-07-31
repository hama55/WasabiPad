// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LiveViewers } from "./live-viewers";

describe("LiveViewers", () => {
  it("sends the editor selection relative to a selected viewer range", async () => {
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

    viewers.setSelection({ start: { line: 3, col: 1 }, end: { line: 3, col: 1 } });
    await vi.advanceTimersByTimeAsync(120);
    expect(updateViewer).toHaveBeenCalledWith("viewer-1", "first\nsecond", {
      start: { line: 1, col: 1 }, end: { line: 1, col: 1 },
    });
    vi.useRealTimers();
  });

  it("一時失敗では追随を止めず、閉じたビューだけを外す", async () => {
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

  it("文書切替中に開いた旧ビューを再登録しない", async () => {
    vi.useFakeTimers();
    let resolveOpen!: (label: string) => void;
    const openViewer = vi.fn(() => new Promise<string>((resolve) => { resolveOpen = resolve; }));
    const updateViewer = vi.fn(async () => true);
    const viewers = new LiveViewers({
      openViewer,
      updateViewer,
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
    vi.useRealTimers();
  });
});
