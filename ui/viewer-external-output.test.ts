// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import {
  commitTrustedExternalHtmlPreview,
  createTrustedExternalHtmlPreview,
  resolveExternalOutputSource,
} from "./viewer-external-output";
import { INLINE_PREVIEW_MESSAGES } from "./inline-preview-protocol";

beforeEach(() => mockConvertFileSrc("windows"));

describe("Feature: trusted external preview output", () => {
  // Feature: 外部プレビュー生成物のURL変換
  // Scenario: Windows絶対パスをTauri asset URLへ変換する
  // Given: 空白と`#`を含むHTMLのWindows絶対パスがある
  // When: 外部出力のsource情報を解決する
  // Then: Tauri asset URLへ変換し、相対資産用の階層を保ってHTML形式として返す
  it("Scenario: resolves an HTML output path to a Tauri asset URL", () => {
    expect(resolveExternalOutputSource("C:\\work\\score #1.HTML")).toEqual({
      format: "html",
      mimeType: "text/html",
      url: "http://asset.localhost/C%3A%2Fwork/score%20%231.HTML",
    });
    expect(new URL("assets/theme.css", resolveExternalOutputSource("C:\\work\\index.html").url).href)
      .toBe("http://asset.localhost/C%3A%2Fwork/assets/theme.css");
  });

  // Given: UNC上のSVG出力の絶対パスがある
  // When: 外部出力のsource情報を解決する
  // Then: UNCパスをTauri asset URLへ渡し、画像MIMEを返す
  it("Scenario: resolves an SVG output path for the existing image display", () => {
    expect(resolveExternalOutputSource("\\\\server\\share\\score.svg")).toEqual({
      format: "svg",
      mimeType: "image/svg+xml",
      url: "http://asset.localhost/%2F%2Fserver%2Fshare/score.svg",
    });
  });

  // Feature: 外部プレビュー生成物の形式検証
  // Scenario: HTMLだけをtrusted HTML iframeへ渡す
  // Given: HTML出力の絶対パスがある
  // When: trusted HTMLプレビューを生成する
  // Then: iframeはTauri asset URLを参照し、同一オリジン許可を付けない
  it("Scenario: creates an asset-backed iframe without same-origin permission", () => {
    const { wrapper, frame } = createTrustedExternalHtmlPreview("C:\\work\\score.html");

    expect(wrapper.className).toBe("viewer-html-wrap");
    expect(frame.className).toBe("viewer-html");
    expect(frame.src).toBe("http://asset.localhost/C%3A%2Fwork/score.html");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.allow).toBe("autoplay; midi");
  });

  // Given: SVG出力の絶対パスがある
  // When: trusted HTMLプレビューを生成する
  // Then: HTML専用経路として診断する
  it("Scenario: rejects SVG output in the HTML DOM helper", () => {
    expect(() => createTrustedExternalHtmlPreview("C:\\work\\score.svg"))
      .toThrow("HTML出力ではありません");
  });

  // Feature: 外部プレビューのiframe置換
  // Scenario: iframeのload通知後に表示を確定するがHTMLの意味的成功とはみなさない
  // Given: 旧生成物が表示され、runnerが通常ファイルと確認した新しいHTMLを読み込み中である
  // When: ブラウザーからiframeのload通知を受け取る
  // Then: DOM置換を確定するが、HTMLの意味やアプリ固有の動作は検証しない
  it("Scenario: displays a new trusted iframe only after its load event", async () => {
    const content = document.createElement("section");
    const oldWrapper = document.createElement("div");
    oldWrapper.dataset.output = "old";
    content.appendChild(oldWrapper);
    const wrapper = document.createElement("div");
    const frame = document.createElement("iframe");
    wrapper.appendChild(frame);

    const opening = commitTrustedExternalHtmlPreview(content, wrapper, frame, () => true);
    expect(content.firstElementChild).toBe(oldWrapper);
    expect(wrapper.classList.contains("viewer-pending")).toBe(true);

    frame.dispatchEvent(new Event("load"));

    expect(await opening).toBe(true);
    expect(content.children).toHaveLength(1);
    expect(content.firstElementChild).toBe(wrapper);
    expect(wrapper.classList.contains("viewer-pending")).toBe(false);
  });

  // Feature: 外部HTMLプレビューの完了通知契約
  // Scenario: 表示確定通知をHTMLの意味的成功と混同しない
  // Given: 外部HTMLのiframe load通知は失敗遷移でも発火し得る
  // When: WasabiPadが相関付き表示確定通知を送る
  // Then: 通知名はDOM表示確定を表し、HTML内容の検証を意味しない
  it("Scenario: names the acknowledgement as a display commit, not semantic HTML success", () => {
    expect(INLINE_PREVIEW_MESSAGES.DISPLAY_COMMITTED_MESSAGE)
      .toBe("wasabipad-viewer-display-committed");
  });

  // Feature: 外部プレビューのiframe置換
  // Scenario: 添付資産の遅延読込を固定時間で失敗扱いしない
  // Given: 新しい外部HTMLのiframeが2秒を超えて読み込み中である
  // When: 遅れてload通知を受け取る
  // Then: 途中でタイムアウトせず、新しいiframeへ切り替える
  it("Scenario: keeps waiting for a valid iframe load beyond two seconds", async () => {
    vi.useFakeTimers();
    try {
      const content = document.createElement("section");
      const oldWrapper = document.createElement("div");
      content.appendChild(oldWrapper);
      const wrapper = document.createElement("div");
      const frame = document.createElement("iframe");
      wrapper.appendChild(frame);
      let resolved = false;
      const opening = commitTrustedExternalHtmlPreview(
        content,
        wrapper,
        frame,
        () => true,
        new AbortController().signal,
      ).then((result) => {
        resolved = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(2500);
      expect(resolved).toBe(false);
      expect(content.firstElementChild).toBe(oldWrapper);

      frame.dispatchEvent(new Event("load"));

      expect(await opening).toBe(true);
      expect(content.firstElementChild).toBe(wrapper);
    } finally {
      vi.useRealTimers();
    }
  });

  // Feature: 外部プレビューのiframe置換
  // Scenario: 後続renderまたはviewer破棄で保留中のload待ちを解除する
  // Given: 新しい外部HTMLのiframeがload待ちである
  // When: 対応するrenderがabortされる
  // Then: 保留中iframeを破棄し、旧表示を保持してfalseで終了する
  it("Scenario: cancels the iframe load wait when its render is aborted", async () => {
    const content = document.createElement("section");
    const oldWrapper = document.createElement("div");
    content.appendChild(oldWrapper);
    const wrapper = document.createElement("div");
    const frame = document.createElement("iframe");
    wrapper.appendChild(frame);
    const controller = new AbortController();

    let resolved = false;
    const opening = commitTrustedExternalHtmlPreview(
      content,
      wrapper,
      frame,
      () => true,
      controller.signal,
    ).then((result) => {
      resolved = true;
      return result;
    });
    controller.abort();
    await expect(opening).resolves.toBe(false);
    frame.dispatchEvent(new Event("load"));

    expect(resolved).toBe(true);
    expect(content.firstElementChild).toBe(oldWrapper);
    expect(wrapper.isConnected).toBe(false);
  });

  // Feature: 外部プレビューのiframe置換
  // Scenario: 読込中に要求が失効したら旧出力を維持する
  // Given: 旧生成物が表示され、新しいiframeのload待ちである
  // When: load後に要求世代が古いと判定される
  // Then: 新iframeを破棄し、旧表示を維持する
  it("Scenario: keeps the old output when the iframe request becomes stale", async () => {
    const content = document.createElement("section");
    const oldWrapper = document.createElement("div");
    content.appendChild(oldWrapper);
    const wrapper = document.createElement("div");
    const frame = document.createElement("iframe");
    wrapper.appendChild(frame);
    let current = true;

    const opening = commitTrustedExternalHtmlPreview(content, wrapper, frame, () => current);
    current = false;
    frame.dispatchEvent(new Event("load"));

    expect(await opening).toBe(false);
    expect(content.firstElementChild).toBe(oldWrapper);
    expect(wrapper.isConnected).toBe(false);
  });

  // Feature: 外部プレビュー生成物の悪い入力診断
  // Scenario: 相対パスや未対応拡張子を拒否する
  // Given: 外部出力の候補パスがある
  // When: source情報を解決する
  // Then: 何が不正か分かるエラーを返す
  it.each([
    ["", "絶対パスが空です"],
    ["score.html", "絶対パスではありません"],
    ["C:\\work\\score.txt", "HTMLまたはSVGではありません"],
  ])("Scenario: diagnoses invalid output path %j", (path, message) => {
    expect(() => resolveExternalOutputSource(path)).toThrow(message);
  });
});
