// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bindPreviewResize } from "./preview-resize";

function pointerEvent(type: string, buttons: number, clientX = 0, pointerId = 1, button = 0): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, button, buttons, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as unknown as PointerEvent;
}

const rightResize = {
  placement: () => "right" as const,
  bounds: () => ({ left: 0, right: 1200, top: 0, bottom: 800 }),
};

describe("Feature: preview resize interaction", () => {
  // Given: 上下配置のプレビュー境界がある
  // When: ポインターを縦にドラッグする
  // Then: 上配置は上端から、下配置は下端から高さを求める
  it.each(["top", "bottom"] as const)("Scenario: %s配置で縦ドラッグする", (placement) => {
    const splitter = document.createElement("div");
    const setSize = vi.fn();
    const dispose = bindPreviewResize(splitter, {
      placement: () => placement,
      bounds: () => ({ left: 0, right: 1000, top: 100, bottom: 1100 }),
      setSize,
    });
    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    const move = pointerEvent("pointermove", 1);
    Object.defineProperty(move, "clientY", { value: 400 });
    window.dispatchEvent(move);
    expect(setSize).toHaveBeenCalledWith(placement === "top" ? 300 : 700);
    dispose();
  });
  // Given: プレビュー境界の幅変更が開始されている
  // When: pointerup後にpointermoveが届く
  // Then: 幅変更を継続せず、ドラッグ状態を解除する
  it("Scenario: pointerup後はプレビュー幅を変更しない", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStop = vi.fn();
    bindPreviewResize(splitter, { ...rightResize, setSize: setWidth, onStop });

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
    bindPreviewResize(splitter, { ...rightResize, setSize: setWidth, onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(pointerEvent("pointermove", 1, 900));

    expect(setWidth).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
  });

  // Given: プレビュー境界の幅変更が開始されている
  // When: 異なるポインターIDの移動、右クリック、ボタン解放の移動が届く
  // Then: いずれも現在のドラッグを壊さず、幅変更は正しい入力だけを反映する
  it("Scenario: ignores unrelated pointer input", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStart = vi.fn();
    const onStop = vi.fn();
    bindPreviewResize(splitter, { ...rightResize, setSize: setWidth, onStart, onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1, 0, 2, 2));
    expect(onStart).not.toHaveBeenCalled();
    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    window.dispatchEvent(pointerEvent("pointermove", 1, 900, 2));
    window.dispatchEvent(pointerEvent("pointermove", 0, 900));

    expect(setWidth).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  // Given: プレビュー境界の幅変更が開始されている
  // When: 異なるポインターIDの解放が届く
  // Then: 現在のドラッグを終了しない
  it("Scenario: ignores unrelated pointer release", () => {
    const splitter = document.createElement("div");
    const onStop = vi.fn();
    bindPreviewResize(splitter, { ...rightResize, setSize: vi.fn(), onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1, 0, 1));
    window.dispatchEvent(pointerEvent("pointerup", 0, 0, 2));

    expect(onStop).not.toHaveBeenCalled();
  });

  // Given: プレビュー境界の幅変更が開始されている
  // When: pointercancelが届く
  // Then: ドラッグ状態を解除し、その後の移動を無視する
  it("Scenario: pointercancel ends preview resizing", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStop = vi.fn();
    bindPreviewResize(splitter, { ...rightResize, setSize: setWidth, onStop });

    splitter.dispatchEvent(pointerEvent("pointerdown", 1));
    window.dispatchEvent(pointerEvent("pointercancel", 0));
    window.dispatchEvent(pointerEvent("pointermove", 1, 900));

    expect(setWidth).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
  });

  // Given: プレビュー境界のイベント購読が解除されている
  // When: 解除後にポインターイベントが届く
  // Then: ドラッグを開始しない
  it("Scenario: dispose removes preview resize handlers", () => {
    const splitter = document.createElement("div");
    const setWidth = vi.fn();
    const onStart = vi.fn();
    const dispose = bindPreviewResize(splitter, { ...rightResize, setSize: setWidth, onStart });

    dispose();
    splitter.dispatchEvent(pointerEvent("pointerdown", 1));

    expect(setWidth).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});
