import { describe, expect, it } from "vitest";
import { imageExtensionOf, imageMimeType, isImagePath } from "./image-formats";

describe("Feature: 画像形式の判定", () => {
  // Given: UIが扱う全画像拡張子を大文字・URLクエリ・Windowsパスで指定する
  // When: isImagePathを呼ぶ
  // Then: すべて画像として判定する
  it("Scenario: 画像拡張子の判定を1つの定義に集約する", () => {
    for (const extension of ["apng", "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]) {
      expect(isImagePath(`C:\\memo\\IMAGE.${extension.toUpperCase()}?raw=1`)).toBe(true);
    }
  });

  // Given: 画像でない拡張子、拡張子のないパス、画像拡張子に似た文字列
  // When: imageExtensionOfを呼ぶ
  // Then: 画像形式だけ拡張子を返す
  it("Scenario: 画像でないパスを誤って画像扱いしない", () => {
    expect(imageExtensionOf("C:\\memo\\note.txt")).toBeNull();
    expect(imageExtensionOf("C:\\memo\\png")).toBeNull();
    expect(imageExtensionOf("C:\\folder.png\\note")).toBeNull();
  });

  // Given: アーカイブ内画像のパス
  // When: imageMimeTypeを呼ぶ
  // Then: 同じ拡張子定義からMIMEを返す
  it("Scenario: 画像拡張子から表示用MIMEを一貫して求める", () => {
    expect(imageMimeType("photo.apng")).toBe("image/apng");
    expect(imageMimeType("photo.avif")).toBe("image/avif");
    expect(imageMimeType("photo.ico")).toBe("image/x-icon");
    expect(imageMimeType("photo.bin")).toBe("application/octet-stream");
  });
});
