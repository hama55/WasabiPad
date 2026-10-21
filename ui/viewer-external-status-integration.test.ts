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

function send(status: { message: string; busy: boolean; kind?: "standard" | "external" } | null) {
  window.dispatchEvent(new MessageEvent("message", {
    source: window.parent, origin: window.location.origin,
    data: { type: messages.PREVIEW_STATUS_MESSAGE, status },
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

  // Feature: 標準プレビューの待機表示
  // Given: 本文の準備が終わっていない標準プレビュー
  // When: 読み込み中の状態を通知する
  // Then: 標準の種別を保って待機を表示し、外部用の更新を表示しない
  it("Scenario: 標準の待機表示を外部プレビューとして扱わない", () => {
    send({ message: "読み込み中…", busy: true, kind: "standard" });
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("標準プレビュー");
    expect(document.querySelector("#viewer-external-status")?.textContent).toBe("読み込み中…");
    expect(document.querySelector<HTMLButtonElement>("#viewer-refresh")!.hidden).toBe(true);
    send(null);
  });

  // Feature: 標準プレビューの読み込み失敗
  // Given: 本文を読み込み中の標準プレビュー
  // When: 読み込みに失敗した状態を受け取る
  // Then: 理由を表示して待機を解除し、外部プレビューの操作は表示しない
  it("Scenario: 標準の読み込み失敗で待機を解除し理由を残す", () => {
    send({ message: "読み込み中…", busy: true, kind: "standard" });
    send({ message: "読み込み失敗: ファイルを読めません", busy: false, kind: "standard" });
    expect(document.querySelector("#viewer-external-status")?.textContent).toBe("読み込み失敗: ファイルを読めません");
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("標準プレビュー");
    const refresh = document.querySelector<HTMLButtonElement>("#viewer-refresh")!;
    expect(refresh.disabled).toBe(false);
    expect(refresh.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#viewer-output-folder")!.hidden).toBe(true);
    send(null);
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

  // Feature: 外部プレビュー生成物のフォルダを開く
  // Given: 初回生成中は結果がなく、成功後の更新中には旧結果が残る
  // When: 表示済み生成物の有無と生成状態を通知する
  // Then: 初回は無効、成功後は更新中・失敗時にも有効で、標準では隠す
  it("Scenario: 表示済みの結果があるときだけ生成フォルダを開ける", () => {
    const folder = document.querySelector<HTMLButtonElement>("#viewer-output-folder")!;
    const post = vi.spyOn(window.parent, "postMessage");
    const availability = (available: boolean) => window.dispatchEvent(new MessageEvent("message", {
      source: window.parent, origin: window.location.origin,
      data: { type: "wasabipad-viewer-output-folder-state", available },
    }));
    send({ message: "変換中…", busy: true });
    expect(folder).not.toBeNull();
    expect(folder.hidden).toBe(false);
    expect(folder.disabled).toBe(true);
    folder.click();
    expect(post).not.toHaveBeenCalledWith({ type: "wasabipad-viewer-reveal-output" }, window.location.origin);
    send({ message: "変換失敗", busy: false });
    expect(folder.disabled).toBe(true);
    availability(true);
    send({ message: "更新中…", busy: true });
    expect(folder.disabled).toBe(false);
    folder.click();
    expect(post).toHaveBeenCalledWith({ type: "wasabipad-viewer-reveal-output" }, window.location.origin);
    send({ message: "更新失敗", busy: false });
    expect(folder.disabled).toBe(false);
    send({ message: "読み込み失敗: 標準への切替失敗", busy: false, kind: "external" });
    expect(document.querySelector("#viewer-preview-kind")?.textContent).toBe("外部プレビュー");
    expect(folder.hidden).toBe(false);
    expect(folder.disabled).toBe(false);
    send({ message: "読み込み中…", busy: true, kind: "standard" });
    expect(folder.hidden).toBe(true);
    availability(false);
    send(null);
  });
});
