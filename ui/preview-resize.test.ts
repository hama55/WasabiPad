// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bindPreviewResize } from "./preview-resize";

function pointerEvent(type: string, buttons: number, clientX = 0): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event as unknown as PointerEvent;
}

describe("Feature: preview resize interaction", () => {
  // Given: プレビュー境界の幅変更が開始されている
  // When: pointerup後にpointermoveが届く
  // Then: 幅変更を継続せず、ドラッグ状態を解除する
  it("Scenario: pointerup後はプレビュー幅を変更しない", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStop = vi.fn();
    bindPreviewResize(splitter, { mainRight: () => 1200, setWidth, onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    window.dispatchEvent(pointerEvent("pointermove", 1, 900));
    window.dispatchEvent(pointerEvent("pointerup", 0));
    window.dispatchEvent(pointerEvent("pointermove", 1, 800));

    expect(setWidth).toHaveBeenCalledTimes(1);
    expect(setWidth).toHaveBeenCalledWith(300);
    expect(onStop).toHaveBeenCalledOnce();
  });

  // Given: プレビュー境界の幅変更が開始されている
  // When: ウィンドウがblurする
  // Then: ドラッグ状態を解除し、その後の移動を無視する
  it("Scenario: window blur時はプレビュー幅変更を終了する", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStop = vi.fn();
    bindPreviewResize(splitter, { mainRight: () => 1200, setWidth, onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(pointerEvent("pointermove", 1, 900));

    expect(setWidth).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
  });
});
