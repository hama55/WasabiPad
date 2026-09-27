// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createTrustedExternalHtmlPreview,
  resolveExternalOutputSource,
} from "./viewer-external-output";

describe("Feature: trusted external preview output", () => {
  // Feature: 外部プレビュー生成物のURL変換
  // Scenario: Windows絶対パスをfile URLへ変換する
  // Given: 空白と`#`を含むHTMLのWindows絶対パスがある
  // When: 外部出力のsource情報を解決する
  // Then: file URLへ変換し、HTML形式として返す
  it("Scenario: resolves an HTML output path to a file URL", () => {
    expect(resolveExternalOutputSource("C:\\work\\score #1.HTML")).toEqual({
      format: "html",
      mimeType: "text/html",
      url: "file:///C:/work/score%20%231.HTML",
    });
  });

  // Given: UNC上のSVG出力の絶対パスがある
  // When: 外部出力のsource情報を解決する
  // Then: UNC authorityを保持したfile URLと画像MIMEを返す
  it("Scenario: resolves an SVG output path for the existing image display", () => {
    expect(resolveExternalOutputSource("\\\\server\\share\\score.svg")).toEqual({
      format: "svg",
      mimeType: "image/svg+xml",
      url: "file://server/share/score.svg",
    });
  });

  // Feature: 外部プレビュー生成物の形式検証
  // Scenario: HTMLだけをtrusted HTML iframeへ渡す
  // Given: HTML出力の絶対パスがある
  // When: trusted HTMLプレビューを生成する
  // Then: iframeはfile URLを直接参照し、srcdocを使わない
  it("Scenario: creates a file-backed trusted HTML iframe", () => {
    const { wrapper, frame } = createTrustedExternalHtmlPreview("C:\\work\\score.html");

    expect(wrapper.className).toBe("viewer-html-wrap");
    expect(frame.className).toBe("viewer-html");
    expect(frame.src).toBe("file:///C:/work/score.html");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
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
