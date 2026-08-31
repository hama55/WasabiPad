import { describe, expect, it, vi } from "vitest";
import { bindLayoutResize } from "./window-layout-binding";

describe("Feature: window layout event binding", () => {
  // Given: resizeイベントを登録できるwindow相当のイベント源
  // When: resize通知を受け取り、登録を解除する
  // Then: レイアウト要求を1回実行し、解除後の通知は無視する
  it("Scenario: resize通知をlayout coordinatorへ接続し解除する", () => {
    let handler: (() => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: "resize", next: () => void) => { handler = next; }),
      removeEventListener: vi.fn(() => { handler = undefined; }),
    };
    const request = vi.fn();
    const unbind = bindLayoutResize(target, request);

    handler!();
    unbind();
    handler?.();

    expect(request).toHaveBeenCalledOnce();
    expect(target.addEventListener).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });
});
