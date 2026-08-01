// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Window } from "@tauri-apps/api/window";
import { WindowChrome } from "./window-chrome";

function mountChrome() {
  const host = document.createElement("div");
  host.innerHTML = `
    <button id="win-min"></button>
    <button id="win-max"></button>
    <button id="win-close"></button>
    <span id="titletext"></span>
  `;
  const notice = document.createElement("span");
  notice.id = "save-notice";
  const handlers: Record<string, () => void> = {};
  const win = {
    minimize: vi.fn(),
    close: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn(async () => false),
    setTitle: vi.fn(),
    onResized: vi.fn(async (handler: () => void) => {
      handlers.resized = handler;
      return () => {};
    }),
    onMoved: vi.fn(async (handler: () => void) => {
      handlers.moved = handler;
      return () => {};
    }),
    onScaleChanged: vi.fn(async (handler: () => void) => {
      handlers.scale = handler;
      return () => {};
    }),
    onCloseRequested: vi.fn(async () => () => {}),
  } as unknown as Window;
  return { host, notice, win, handlers };
}

describe("WindowChrome", () => {
  it("native windowのresize・move・DPI変更を同じgeometry同期へ渡す", () => {
    const { host, notice, win, handlers } = mountChrome();
    const onGeometryChange = vi.fn();
    new WindowChrome(host, win, {
      onCloseRequest: async () => true,
      onGeometryChange,
      onError: async () => {},
    }, notice);

    handlers.resized();
    handlers.moved();
    handlers.scale();

    expect(onGeometryChange).toHaveBeenCalledTimes(3);
  });

  it("titlebar外の通知要素へ保存完了を表示する", () => {
    vi.useFakeTimers();
    try {
      const { host, notice, win } = mountChrome();
      const chrome = new WindowChrome(host, win, {
        onCloseRequest: async () => true,
        onGeometryChange: vi.fn(),
        onError: async () => {},
      }, notice);

      chrome.notify("保存しました");

      expect(notice.textContent).toBe("保存しました");
      vi.advanceTimersByTime(2000);
      expect(notice.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
