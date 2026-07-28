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
    <span id="save-notice"></span>
  `;
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
  return { host, win, handlers };
}

describe("WindowChrome", () => {
  it("native windowのresize・move・DPI変更を同じgeometry同期へ渡す", () => {
    const { host, win, handlers } = mountChrome();
    const onGeometryChange = vi.fn();
    new WindowChrome(host, win, {
      onCloseRequest: async () => true,
      onGeometryChange,
    });

    handlers.resized();
    handlers.moved();
    handlers.scale();

    expect(onGeometryChange).toHaveBeenCalledTimes(3);
  });
});
