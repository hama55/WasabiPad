import { describe, expect, it, vi } from "vitest";
import { createWindowLayoutRuntime } from "./window-layout-runtime";

describe("Feature: window layout runtime", () => {
  // Given: resizeイベントと描画フレームを持つ実行環境
  // When: resize通知を受けてフレーム反映し、runtimeを破棄する
  // Then: レイアウトを一度反映し、破棄後は通知と再要求を受け付けない
  it("Scenario: resizeからcoordinatorへの接続と破棄を一括管理する", () => {
    let resizeHandler: (() => void) | undefined;
    let frameCallback: (() => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: "resize", handler: () => void) => { resizeHandler = handler; }),
      removeEventListener: vi.fn(() => { resizeHandler = undefined; }),
    };
    const apply = vi.fn();
    const runtime = createWindowLayoutRuntime(target, {
      measure: () => ({ width: 960, height: 700 }),
      apply,
      requestFrame: (callback) => {
        frameCallback = callback;
        return 1;
      },
      cancelFrame: () => { frameCallback = undefined; },
    });

    resizeHandler!();
    frameCallback!();
    runtime.dispose();
    runtime.dispose();
    resizeHandler?.();

    expect(apply).toHaveBeenCalledOnce();
    expect(target.addEventListener).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });
});
