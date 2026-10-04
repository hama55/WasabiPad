// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoPreview } from "./viewer-video";

describe("Feature: 動画プレビュー", () => {
  afterEach(() => vi.restoreAllMocks());
  // Given: ローカル動画の配信URL
  // When: 動画プレビューを作成する
  // Then: 自動再生せず、標準操作と動画名を持つ
  it("Scenario: 動画を自動再生せず標準操作を表示する", () => {
    const { wrapper, video } = createVideoPreview("旅行.mov", "http://asset.localhost/clip.mov");
    expect(wrapper.contains(video)).toBe(true);
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.preload).toBe("metadata");
    expect(video.getAttribute("aria-label")).toBe("旅行.mov");
    expect(video.src).toBe("http://asset.localhost/clip.mov");
  });
  // Given: 再生位置が進んだ動画
  // When: 一時退避・閉じる・破棄を行う
  // Then: 退避では位置を保持し、閉じるでは先頭へ、破棄では資産参照を解放する
  it("Scenario: 非表示理由に応じて再生位置と資産を扱う", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, value: true });
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const preview = createVideoPreview("clip.mov", "http://asset.localhost/clip.mov");
    preview.video.currentTime = 12;
    Object.defineProperty(preview.video, "paused", { configurable: true, value: false });
    preview.stop();
    expect(preview.video.paused).toBe(true);
    expect(preview.video.currentTime).toBe(12);
    preview.stop(true);
    expect(preview.video.currentTime).toBe(0);
    preview.dispose();
    expect(preview.video.hasAttribute("src")).toBe(false);
  });
  // Given: 読込失敗・形式非対応・原因不明の動画エラー
  // When: 標準のメディアエラー通知を受ける
  // Then: 判別可能な範囲で異なる文言を表示する
  it.each([
    [2, "動画を読み込めません"],
    [4, "動画を再生できません"],
    [3, "動画を再生できません"],
    [null, "動画を再生できません"],
  ])("Scenario: メディアエラー%sの内容を表示する", (code, message) => {
    const { wrapper, video } = createVideoPreview("clip.mov", "http://asset.localhost/clip.mov");
    Object.defineProperty(video, "error", { value: code === null ? null : { code } });
    video.dispatchEvent(new Event("error"));
    expect(wrapper.querySelector<HTMLElement>("[role='alert']")?.hidden).toBe(false);
    expect(wrapper.textContent).toContain(message);
  });
});
