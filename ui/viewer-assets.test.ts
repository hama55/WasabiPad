import { describe, expect, it } from "vitest";
import { resolveArchiveAssetEntry, resolveAssetPath } from "./viewer-assets";

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
