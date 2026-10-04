// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import { installDomStubs } from "./test-doubles";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "{}"),
  convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
}));
installDomStubs();

function send(status: { message: string; busy: boolean } | null) {
  window.dispatchEvent(new MessageEvent("message", {
    source: window.parent, origin: window.location.origin,
    data: { type: messages.EXTERNAL_STATUS_MESSAGE, status },
  }));
}

describe("Feature: 外部プレビューの待機と失敗表示", () => {
  beforeAll(async () => {
    document.documentElement.innerHTML = viewerHtml.replace(/<!doctype html>/i, "");
    window.history.replaceState(null, "", "/viewer.html?inline=1");
    await import("./viewer");
  });
  afterAll(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.restoreAllMocks();
  });

  // Given: 生成物がまだない外部プレビュー
  // When: 変換中から失敗へ移り、利用者が更新する
  // Then: 待機中は更新を禁止し、失敗の理由と再試行操作を画面に残す
  it("Scenario: 初回失敗でも既存の更新から再試行できる", () => {
    const refresh = document.querySelector<HTMLButtonElement>("#viewer-refresh")!;
    const post = vi.spyOn(window.parent, "postMessage");
    send({ message: "変換中…", busy: true });
    expect(document.querySelector("#viewer-external-status")?.textContent).toBe("変換中…");
    expect(refresh.hidden).toBe(false);
    expect(refresh.disabled).toBe(true);
    refresh.click();
    expect(post).not.toHaveBeenCalledWith({ type: messages.REFRESH_MESSAGE }, window.location.origin);
    send({ message: "変換失敗: 入力を確認して", busy: false });
    expect(refresh.disabled).toBe(false);
    expect(document.querySelector("#viewer-external-status")?.textContent).toContain("入力を確認して");
    refresh.click();
    expect(post).toHaveBeenCalledWith({ type: messages.REFRESH_MESSAGE }, window.location.origin);
    send(null);
    expect(document.querySelector<HTMLElement>("#viewer-external-status")?.hidden).toBe(true);
  });
});
