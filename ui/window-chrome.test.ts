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
  const unlistenResized = vi.fn();
  const unlistenMoved = vi.fn();
  const unlistenScaleChanged = vi.fn();
  const unlistenCloseRequested = vi.fn();
  const win = {
    minimize: vi.fn(),
    close: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn(async () => false),
    setTitle: vi.fn(),
    onResized: vi.fn(async (handler: () => void) => {
      handlers.resized = handler;
      return unlistenResized;
    }),
    onMoved: vi.fn(async (handler: () => void) => {
      handlers.moved = handler;
      return unlistenMoved;
    }),
    onScaleChanged: vi.fn(async (handler: () => void) => {
      handlers.scale = handler;
      return unlistenScaleChanged;
    }),
    onCloseRequested: vi.fn(async () => unlistenCloseRequested),
  } as unknown as Window;
  return { host, notice, win, handlers, unlistenResized, unlistenMoved, unlistenScaleChanged, unlistenCloseRequested };
}

describe("Feature: WindowChrome", () => {
  // Given: resize/move/scale変更handlerを登録
  // When: 3 handlerを順に呼ぶ
  // Then: `onGeometryChange`を3回呼ぶ
  it("Scenario: native windowのresize・move・DPI変更を同じgeometry同期へ渡す", () => {
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

  // Given: titlebar外の通知要素とfake timer
  // When: `notify("保存しました")`後に2秒進める
  // Then: 通知文を表示し、2秒後に空文字
  it("Scenario: titlebar外の通知要素へ保存完了を表示する", () => {
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

  // Given: native listenerを登録したwindow chrome
  // When: chromeを破棄する
  // Then: geometryとwindow controlsのlistenerを解除する
  it("Scenario: dispose unregisters all native listeners", async () => {
    const fixture = mountChrome();
    const chrome = new WindowChrome(fixture.host, fixture.win, {
      onCloseRequest: async () => true,
      onGeometryChange: vi.fn(),
      onError: async () => {},
    }, fixture.notice);

    chrome.dispose();
    await vi.waitFor(() => {
      expect(fixture.unlistenResized).toHaveBeenCalledTimes(2);
      expect(fixture.unlistenMoved).toHaveBeenCalledOnce();
      expect(fixture.unlistenScaleChanged).toHaveBeenCalledOnce();
      expect(fixture.unlistenCloseRequested).toHaveBeenCalledOnce();
    });
  });
});
