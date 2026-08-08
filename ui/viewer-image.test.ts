// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createImagePreview } from "./viewer-image";

describe("Feature: Image viewer", () => {
  // Given: 画像ファイル名`photo.png`
  // When: 画像プレビュー要素を作る
  // Then: 画像要素を表示用ラッパーへ配置し、代替テキストを設定する
  it("Scenario: 画像を表示する要素を用意する", () => {
    const { wrapper, image } = createImagePreview("photo.png");

    expect(wrapper.className).toBe("viewer-image-wrap");
    expect(wrapper.querySelector("img")).toBe(image);
    expect(image.className).toBe("viewer-image");
    expect(image.alt).toBe("photo.png");
  });
});
