import { describe, expect, it } from "vitest";
import { markdownLinkActionOf } from "./markdown-link-navigation";

describe("Feature: Markdownリンクの操作分類", () => {
  // Given: 完全なHTTPS URLにクエリとfragmentが付いている
  // When: Markdownリンクの操作を分類する
  // Then: URL全体を外部リンクとして保持する
  it("Scenario: 外部URLは完全なURLのまま既定ブラウザ操作へ分類する", () => {
    expect(markdownLinkActionOf(
      "C:\\work\\manual.md",
      "https://example.com/translate?sl=en&tl=ja#top",
      true,
    )).toEqual({
      kind: "external",
      href: "https://example.com/translate?sl=en&tl=ja#top",
    });
  });

  // Given: C:\work\docs\readme.mdから相対Markdownリンクを指定する
  // When: 新規タブ用の操作を分類する
  // Then: 絶対パスとfragmentを保持したローカル操作になる
  it("Scenario: フォルダ内文書の相対リンクを絶対パスへ分類する", () => {
    expect(markdownLinkActionOf(
      "C:\\work\\docs\\readme.md",
      "../manual.md#install",
      true,
    )).toEqual({
      kind: "local",
      path: "C:\\work\\manual.md",
      fragment: "install",
      newTab: true,
    });
  });

  // Given: C:\work\docs\readme.mdから相対Markdownリンクを指定する
  // When: 同じタブ用の操作を分類する
  // Then: 新規タブではないローカル操作になる
  it("Scenario: 通常のローカルリンクを同じタブ操作として分類する", () => {
    expect(markdownLinkActionOf("C:\\work\\docs\\readme.md", "../manual.md", false)).toEqual({
      kind: "local",
      path: "C:\\work\\manual.md",
      fragment: null,
      newTab: false,
    });
  });

  // Given: scheme-relative URLを指定する
  // When: Markdownリンクの操作を分類する
  // Then: アプリ内リンクとして奪わず、従来のブラウザ動作へ委ねる
  it("Scenario: scheme-relative URLは操作を変更しない", () => {
    expect(markdownLinkActionOf("C:\\work\\readme.md", "//example.com/manual", true))
      .toEqual({ kind: "unchanged" });
  });

  // Given: 保存先がない文書からローカルリンクを指定する
  // When: Markdownリンクの操作を分類する
  // Then: タブを増やさず解決エラーへ分類する
  it("Scenario: 元文書のパスがないローカルリンクは解決エラーになる", () => {
    expect(markdownLinkActionOf(null, "manual.md", true)).toEqual({
      kind: "unresolved",
      message: "ローカルMarkdownリンクを解決できません",
    });
  });
});
