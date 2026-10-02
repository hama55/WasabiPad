// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import viewerHtml from "../viewer.html?raw";
import { INLINE_PREVIEW_MESSAGES as messages } from "./inline-preview-protocol";
import type { ViewerPayload } from "./api";
import { installDomStubs } from "./test-doubles";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "{}"),
  convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
}));
installDomStubs();

function send(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", {
    source: window.parent, origin: window.location.origin, data,
  }));
}

const payload: ViewerPayload = {
  format: "video", text: "", selection: null,
  source_path: "C:\\work\\clip.mov", effective_extension: null,
  archive_path: null, archive_entry: null, external_output_path: null,
};

async function open(overrides: Partial<ViewerPayload> = {}) {
  send({ type: messages.PAYLOAD_MESSAGE, payload: { ...payload, ...overrides } });
  await Promise.resolve();
  await Promise.resolve();
}

describe("Feature: 動画プレビューの通知経路", () => {
  beforeAll(async () => {
    document.documentElement.innerHTML = viewerHtml.replace(/<!doctype html>/i, "");
    window.history.replaceState(null, "", "/viewer.html?inline=1");
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, value: true });
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    await import("./viewer");
  });
  afterAll(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.restoreAllMocks();
  });

  // Given: 通常MOVが表示されている
  // When: 全画面通知・一時退避・再表示・閉じるを順に行う
  // Then: 同じ動画を保持し、退避では位置を維持、閉じるでは先頭へ戻る
  it("Scenario: 実際のviewerで配置変更と非表示を扱う", async () => {
    await open();
    const video = document.querySelector<HTMLVideoElement>("video")!;
    expect(video).not.toBeNull();
    expect(video.autoplay).toBe(false);
    video.currentTime = 15;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    send({ type: messages.FULLSCREEN_STATE_MESSAGE, fullscreen: true });
    expect(video.paused).toBe(false);
    expect(document.querySelector("video")).toBe(video);
    send({ type: messages.VISIBILITY_MESSAGE, visible: false, reset: false });
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(15);
    send({ type: messages.VISIBILITY_MESSAGE, visible: true, reset: false });
    expect(document.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(15);
    expect(video.paused).toBe(true);
    send({ type: messages.VISIBILITY_MESSAGE, visible: false, reset: true });
    expect(video.currentTime).toBe(0);
  });

  // Given: 再生位置の進んだ動画と更新操作
  // When: 更新通知を受けた親からpayloadを再送し、さらに別ファイルへ切り替える
  // Then: 古い動画の再生と参照を止め、更新後は先頭の停止状態になる
  it("Scenario: 更新・別ファイル切替で古い動画を停止する", async () => {
    await open();
    const previous = document.querySelector<HTMLVideoElement>("video")!;
    previous.currentTime = 15;
    const post = vi.spyOn(window.parent, "postMessage");
    const refresh = document.querySelector<HTMLButtonElement>("#viewer-refresh")!;
    expect(refresh.hidden).toBe(false);
    expect(refresh.getAttribute("aria-label")).toBe("動画プレビューを更新");
    refresh.click();
    expect(post).toHaveBeenCalledWith({ type: messages.REFRESH_MESSAGE }, window.location.origin);
    await open();
    expect(previous.paused).toBe(true);
    expect(previous.hasAttribute("src")).toBe(false);
    const refreshed = document.querySelector<HTMLVideoElement>("video")!;
    expect(refreshed.currentTime).toBe(0);
    expect(refreshed.paused).toBe(true);
    await open({ source_path: "C:\\work\\next.mp4" });
    expect(refreshed.hasAttribute("src")).toBe(false);
  });

  // Given: アーカイブ内MOV、または動画の消去通知
  // When: viewerへ表示・消去を要求する
  // Then: アーカイブ内を再生せず、消去時は古い動画資産を解放する
  it("Scenario: アーカイブを除外し消去時に再生を止める", async () => {
    await open({ archive_path: "C:\\work\\clips.zip", archive_entry: "clip.mov" });
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("#viewer-content")?.textContent).toContain("通常ファイル");
    await open();
    const previous = document.querySelector<HTMLVideoElement>("video")!;
    send({ type: messages.CLEAR_MESSAGE, render_id: "clear-video" });
    expect(document.querySelector("video")).toBeNull();
    expect(previous.hasAttribute("src")).toBe(false);
  });
});
