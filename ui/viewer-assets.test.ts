import { describe, expect, it } from "vitest";
import {
  isExternalMarkdownLink,
  isLocalMarkdownLinkCandidate,
  isSameDocumentMarkdownLink,
  markdownFragmentOf,
  markdownLinkTargetOf,
  resolveArchiveAssetEntry,
  resolveAssetPath,
  resolveMarkdownLinkPath,
} from "./viewer-assets";

const SOURCE = "C:\\work\\docs\\readme.md";

describe("Feature: resolveAssetPath", () => {
  // Given: 元ファイルを`C:\work\docs\readme.md`、相対参照を指定
  // When: `resolveAssetPath`を呼ぶ
  // Then: `assets/shot.png`→`C:\work\docs\assets\shot.png`、`../img/shot.png`→`C:\work\img\shot.png`、`./shot.png`→`C:\work\docs\shot.png`
  it("Scenario: 相対パスは元ファイルの位置から解決する", () => {
    expect(resolveAssetPath(SOURCE, "assets/shot.png")).toBe("C:\\work\\docs\\assets\\shot.png");
    expect(resolveAssetPath(SOURCE, "../img/shot.png")).toBe("C:\\work\\img\\shot.png");
    expect(resolveAssetPath(SOURCE, "./shot.png")).toBe("C:\\work\\docs\\shot.png");
  });

  // Given: `assets/%E5%9B%B3%201.png`を指定
  // When: `resolveAssetPath`を呼ぶ
  // Then: `C:\work\docs\assets\図 1.png`を返す
  it("Scenario: パーセントエンコードを実パスへ戻す", () => {
    expect(resolveAssetPath(SOURCE, "assets/%E5%9B%B3%201.png")).toBe("C:\\work\\docs\\assets\\図 1.png");
  });

  // Given: HTTPS URL、data URL、元ファイル`null`の相対パス/絶対パス
  // When: `resolveAssetPath`を呼ぶ
  // Then: URL・data URL・不明元の相対パスは`null`、`D:/pic/shot.png`は`D:\pic\shot.png`
  it("Scenario: URL・絶対パス・元ファイル不明は触らない", () => {
    expect(resolveAssetPath(SOURCE, "https://example.com/a.png")).toBeNull();
    expect(resolveAssetPath(SOURCE, "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveAssetPath(null, "assets/shot.png")).toBeNull();
    expect(resolveAssetPath(null, "D:/pic/shot.png")).toBe("D:\\pic\\shot.png");
  });
});

describe("Feature: resolveArchiveAssetEntry", () => {
  // Given: `notes/readme.md`からアーカイブ内相対パスを指定
  // When: `resolveArchiveAssetEntry`を呼ぶ
  // Then: `image_markdown/readme/shot.png`は`notes/image_markdown/readme/shot.png`、`../image_markdown/readme/shot.png`は`image_markdown/readme/shot.png`
  it("Scenario: メモエントリの親から画像エントリを解決する", () => {
    expect(resolveArchiveAssetEntry("notes/readme.md", "image_markdown/readme/shot.png"))
      .toBe("notes/image_markdown/readme/shot.png");
    expect(resolveArchiveAssetEntry("notes/readme.md", "../image_markdown/readme/shot.png"))
      .toBe("image_markdown/readme/shot.png");
  });

  // Given: アーカイブ内メモからHTTPS URLまたは`../../a.png`を指定
  // When: `resolveArchiveAssetEntry`を呼ぶ
  // Then: どちらも`null`
  it("Scenario: 外部URLとアーカイブ外への移動は触らない", () => {
    expect(resolveArchiveAssetEntry("readme.md", "https://example.com/a.png")).toBeNull();
    expect(resolveArchiveAssetEntry("readme.md", "../../a.png")).toBeNull();
  });
});

describe("Feature: resolveMarkdownLinkPath", () => {
  // Given: C:\work\notes\readme.md と `../manual.md#install`
  // When: Markdownリンクを実パスへ解決する
  // Then: C:\work\manual.mdを返し、外部URLとfragmentだけのリンクは対象外にする
  it("Scenario: Markdownリンクを新規タブ用のローカルパスへ解決する", () => {
    expect(resolveMarkdownLinkPath("C:\\work\\notes\\readme.md", "../manual.md#install"))
      .toBe("C:\\work\\manual.md");
    expect(resolveMarkdownLinkPath("C:\\work\\notes\\readme.md", "https://example.com"))
      .toBeNull();
    expect(resolveMarkdownLinkPath("C:\\work\\notes\\readme.md", "//example.com/manual.md"))
      .toBeNull();
    expect(resolveMarkdownLinkPath("C:\\work\\notes\\readme.md", "#install"))
      .toBeNull();
  });

  // Given: HTTPS/HTTP、mailto、相対パス、同一文書fragmentを含むリンク
  // When: Markdownリンクの種類とfragmentを判定する
  // Then: HTTP系だけを外部URL、mailtoは対象外、fragmentはURLデコードして返す
  it("Scenario: Markdownリンクの外部URLとfragmentを判定する", () => {
    expect(isExternalMarkdownLink("https://zenn.dev/more_tech_blog/articles/76af481ab3816d?lang=ja#本文"))
      .toBe(true);
    expect(isExternalMarkdownLink("HTTP://example.com/manual#top")).toBe(true);
    expect(isExternalMarkdownLink("mailto:user@example.com")).toBe(false);
    expect(isLocalMarkdownLinkCandidate("../manual.md#install")).toBe(true);
    expect(isLocalMarkdownLinkCandidate("mailto:user@example.com")).toBe(false);
    expect(isLocalMarkdownLinkCandidate("//example.com/manual.md")).toBe(false);
    expect(markdownLinkTargetOf("../manual.md?print=1#%E3%83%88%E3%83%83%E3%83%97")).toEqual({
      path: "../manual.md",
      fragment: "トップ",
    });
    expect(markdownFragmentOf("../manual.md#%E3%83%88%E3%83%83%E3%83%97")).toBe("トップ");
    expect(markdownFragmentOf("#")).toBe("");
    expect(markdownFragmentOf("../manual.md")).toBeNull();
  });

  // Given: 元文書が`C:\\work\\notes\\readme.md`
  // When: 同じ文書を指すfragmentリンクと別文書fragmentリンクを判定する
  // Then: 空パスまたは同じ絶対パスだけを同一文書として扱う
  it("Scenario: 同一文書fragmentだけを現在のMarkdownへ結び付ける", () => {
    expect(isSameDocumentMarkdownLink(SOURCE, "#install")).toBe(true);
    expect(isSameDocumentMarkdownLink(SOURCE, "readme.md#install")).toBe(true);
    expect(isSameDocumentMarkdownLink(SOURCE, "../manual.md#install")).toBe(false);
    expect(isSameDocumentMarkdownLink(SOURCE, "https://example.com/#install")).toBe(false);
    expect(isSameDocumentMarkdownLink(null, "#install")).toBe(true);
  });
});
