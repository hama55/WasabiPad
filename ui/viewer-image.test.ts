// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  bindImagePan,
  createImagePreview,
  DEFAULT_IMAGE_ZOOM,
  markImageLoadFailure,
  zoomImageByWheel,
} from "./viewer-image";

function pointerEvent(type: string, buttons: number, clientX = 0, clientY = 0, pointerId = 1, button = 0): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, button, buttons, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as unknown as PointerEvent;
}

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
    expect(image.title).toBe("Ctrl+ホイールでズーム");
  });

  // Feature: 画像プレビューのホイールズーム
  // Scenario: Ctrl+ホイールで画像倍率を変更する
  // Given: 100%で表示中の画像がある
  // When: ホイールを上または下へ回す
  // Then: 画像倍率を増減し、0.25〜4倍の範囲に収める
  it("Scenario: zooms an image within its allowed range", () => {
    const { wrapper, image } = createImagePreview("photo.png");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, right: 200, bottom: 100, left: 0,
      width: 200, height: 100, toJSON: () => ({}),
    } as DOMRect);

    const enlarged = zoomImageByWheel(image, DEFAULT_IMAGE_ZOOM, -1);
    expect(enlarged).toBe(1.1);
    expect(image.style.width).toBe("220px");
    expect(image.style.height).toBe("110px");
    expect(wrapper.classList.contains("viewer-image-zoomed")).toBe(true);
    expect(wrapper.style.width).toBe("268px");
    expect(wrapper.style.height).toBe("158px");
    expect(zoomImageByWheel(image, enlarged, 1)).toBe(DEFAULT_IMAGE_ZOOM);
    expect(image.style.width).toBe("");
    expect(wrapper.style.width).toBe("");
    expect(wrapper.classList.contains("viewer-image-zoomed")).toBe(false);
    expect(zoomImageByWheel(image, 4, -1)).toBe(4);
    expect(zoomImageByWheel(image, 0.25, 1)).toBe(0.25);
  });

  // Feature: 拡大画像のドラッグ移動
  // Scenario: 画像を左ボタンでドラッグする
  // Given: 縦横にスクロールできる拡大画像がある
  // When: 画像を右下へドラッグしてからボタンを離す
  // Then: スクロール位置は逆方向へ移動し、終了後の移動は反映しない
  it("Scenario: drags an enlarged image to pan the preview", () => {
    const { image } = createImagePreview("photo.png");
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, {
      scrollWidth: { configurable: true, value: 1000 },
      scrollHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroll.scrollLeft = 300;
    scroll.scrollTop = 200;
    bindImagePan(image, scroll);

    image.dispatchEvent(pointerEvent("pointerdown", 1, 100, 100));
    window.dispatchEvent(pointerEvent("pointermove", 1, 140, 130));
    window.dispatchEvent(pointerEvent("pointerup", 0, 140, 130));
    window.dispatchEvent(pointerEvent("pointermove", 1, 180, 160));

    expect(scroll.scrollLeft).toBe(260);
    expect(scroll.scrollTop).toBe(170);
    expect(image.classList.contains("viewer-image-panning")).toBe(false);
  });

  // Feature: 画像ドラッグの入力境界
  // Scenario: 右クリックまたは非スクロール画像を操作する
  // Given: ドラッグ移動できない入力がある
  // When: ポインター操作を行う
  // Then: スクロール位置を変更しない
  it("Scenario: ignores image pan input that cannot start a drag", () => {
    const { image } = createImagePreview("photo.png");
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, {
      scrollWidth: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroll.scrollLeft = 10;
    scroll.scrollTop = 20;
    bindImagePan(image, scroll);

    image.dispatchEvent(pointerEvent("pointerdown", 1, 100, 100, 1, 2));
    window.dispatchEvent(pointerEvent("pointermove", 1, 140, 130));

    expect(scroll.scrollLeft).toBe(10);
    expect(scroll.scrollTop).toBe(20);
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
