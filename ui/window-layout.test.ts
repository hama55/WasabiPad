import { describe, expect, it, vi } from "vitest";
import { WindowLayoutCoordinator } from "./window-layout";

function scheduler() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    requestFrame: (callback: () => void) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id: number) => callbacks.delete(id),
    runNext: () => {
      const next = callbacks.entries().next().value as [number, (() => void)] | undefined;
      if (!next) return false;
      callbacks.delete(next[0]);
      next[1]();
      return true;
    },
    pending: () => callbacks.size,
  };
}

describe("Feature: window layout coordination", () => {
  // Given: ウィンドウ寸法の変更通知が短時間に複数届く
  // When: レイアウト反映を連続して要求して次の描画フレームを実行する
  // Then: 最新の有効な寸法だけを1回反映する
  it("Scenario: coalesces geometry changes to the latest viewport", () => {
    const frames = scheduler();
    const apply = vi.fn();
    let viewport = { width: 800, height: 600 };
    const coordinator = new WindowLayoutCoordinator({
      measure: () => viewport,
      apply,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    coordinator.request();
    viewport = { width: 640, height: 480 };
    coordinator.request();
    expect(frames.pending()).toBe(1);

    frames.runNext();

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ width: 640, height: 480 });
  });

  // Given: 初回測定が0寸法で、次のフレームで有効な寸法になる
  // When: レイアウト反映を要求する
  // Then: 0寸法は反映せず、有効になった次のフレームで反映する
  it("Scenario: retries an incomplete viewport without committing zero dimensions", () => {
    const frames = scheduler();
    const apply = vi.fn();
    const viewports = [
      { width: 0, height: 0 },
      { width: 900, height: 700 },
    ];
    const coordinator = new WindowLayoutCoordinator({
      measure: () => viewports.shift() ?? { width: 0, height: 0 },
      apply,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    coordinator.request();
    frames.runNext();

    expect(apply).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);

    frames.runNext();

    expect(apply).toHaveBeenCalledWith({ width: 900, height: 700 });
  });

  // Given: 有効な寸法を一度反映した後、最小化などで測定が一時的に不正になる
  // When: その状態でレイアウト反映を要求する
  // Then: 直前の表示を壊さず、不正な寸法を反映しない
  it("Scenario: preserves the last valid layout while the viewport is unavailable", () => {
    const frames = scheduler();
    const apply = vi.fn();
    let viewport = { width: 1024, height: 768 };
    const coordinator = new WindowLayoutCoordinator({
      measure: () => viewport,
      apply,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    coordinator.request();
    frames.runNext();
    viewport = { width: 0, height: 0 };
    coordinator.request();
    frames.runNext();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(coordinator.lastValidViewport).toEqual({ width: 1024, height: 768 });
  });

  // Given: 無効な寸法がフレーム上限を超えて続き、復元後に正寸法になる
  // When: 低頻度の再測定タイマーから再びフレーム反映を要求する
  // Then: 上限到達後も正寸法まで待ち続け、最後に有効な表示だけを反映する
  it("Scenario: invalid viewportを上限後も低頻度で再測定する", () => {
    const frames = scheduler();
    const apply = vi.fn();
    let retryCallback: (() => void) | undefined;
    let attempts = 0;
    const coordinator = new WindowLayoutCoordinator({
      measure: () => {
        attempts += 1;
        return attempts < 5 ? { width: 0, height: 0 } : { width: 900, height: 700 };
      },
      apply,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      requestRetry: (callback) => {
        retryCallback = callback;
        return 1;
      },
      cancelRetry: () => { retryCallback = undefined; },
    });

    coordinator.request();
    frames.runNext();
    frames.runNext();
    frames.runNext();
    frames.runNext();

    expect(apply).not.toHaveBeenCalled();
    expect(retryCallback).toBeDefined();

    retryCallback!();
    frames.runNext();

    expect(apply).toHaveBeenCalledWith({ width: 900, height: 700 });
  });
});
