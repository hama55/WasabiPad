// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createImagePreview, markImageLoadFailure } from "./viewer-image";

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

  // Given: 画像読込に失敗した画像要素がある
  // When: 読込失敗状態を表示する
  // Then: srcを外し、代替テキストへ失敗状態を反映する
  it("Scenario: marks an image load failure", () => {
    const { image } = createImagePreview("photo.png");
    image.src = "asset://photo.png";

    markImageLoadFailure(image);

    expect(image.getAttribute("src")).toBeNull();
    expect(image.alt).toBe("photo.png（読み込めません）");
  });
});
