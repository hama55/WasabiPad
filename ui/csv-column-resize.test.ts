// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { startCsvColumnResize } from "./csv-column-resize";

function pointerEvent(type: string, clientX = 0, button = 0): PointerEvent {
  return new MouseEvent(type, { button, clientX }) as unknown as PointerEvent;
}

describe("Feature: CSV column resize lifecycle", () => {
  // Given: 列幅80pxのリサイズ操作を開始する
  // When: pointermoveで23px広げてpointerupする
  // Then: 更新値が103pxになり、終了後に後始末される
  it("Scenario: pointer drag updates width and releases listeners", () => {
    const update = vi.fn();
    const setResizing = vi.fn();
    const event = pointerEvent("pointerdown", 100);

    expect(startCsvColumnResize(event, { startWidth: 80, startX: 100, update, setResizing })).toBe(true);
    expect(setResizing).toHaveBeenCalledWith(true);
    window.dispatchEvent(pointerEvent("pointermove", 123));
    expect(update).toHaveBeenCalledWith(103);
    window.dispatchEvent(pointerEvent("pointerup"));
    expect(setResizing).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(pointerEvent("pointermove", 140));
    expect(update).toHaveBeenCalledTimes(1);
  });

  // Given: ドラッグ中の幅更新が例外を投げる
  // When: pointermoveが発生する
  // Then: エラー通知後にリサイズ状態を解除する
  it("Scenario: failed width update still cleans up on the error path", () => {
    const onError = vi.fn();
    const setResizing = vi.fn();
    const event = pointerEvent("pointerdown");
    startCsvColumnResize(event, {
      startWidth: 80,
      startX: 0,
      update: () => { throw new Error("layout failed"); },
      setResizing,
      onError,
    });

    window.dispatchEvent(pointerEvent("pointermove", 1));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(setResizing).toHaveBeenLastCalledWith(false);
    window.dispatchEvent(pointerEvent("pointermove", 2));
    expect(onError).toHaveBeenCalledOnce();
  });

  // Given: 列幅ドラッグ中で、リサイズ状態が有効になっている
  // When: ウィンドウのフォーカスを失う
  // Then: pointerupがなくても状態とイベント監視を解除する
  it("Scenario: blur finishes an active column drag", () => {
    const update = vi.fn();
    const setResizing = vi.fn();
    startCsvColumnResize(pointerEvent("pointerdown"), {
      startWidth: 80,
      startX: 0,
      update,
      setResizing,
    });

    window.dispatchEvent(new Event("blur"));
    expect(setResizing).toHaveBeenLastCalledWith(false);
    window.dispatchEvent(pointerEvent("pointermove", 10));
    expect(update).not.toHaveBeenCalled();
  });

  // Given: 列幅ドラッグ中
  // When: pointercancelが発生する
  // Then: 幅を更新せず、リサイズ状態を解除する
  it("Scenario: pointercancel finishes an active column drag", () => {
    const update = vi.fn();
    const setResizing = vi.fn();
    startCsvColumnResize(pointerEvent("pointerdown"), {
      startWidth: 80,
      startX: 0,
      update,
      setResizing,
    });

    window.dispatchEvent(pointerEvent("pointercancel"));
    window.dispatchEvent(pointerEvent("pointermove", 10));

    expect(update).not.toHaveBeenCalled();
    expect(setResizing).toHaveBeenLastCalledWith(false);
  });
});
