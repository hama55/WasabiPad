import { describe, expect, it, vi } from "vitest";
import { reportUnhandledRejection, runAsyncBoundary } from "./async-boundary";

describe("Feature: async boundary", () => {
  // Given: 同期的にErrorを投げる操作
  // When: runAsyncBoundaryで実行する
  // Then: 例外を投げ返さずonErrorへ渡す
  it("Scenario: 同期例外をエラー通知へ渡す", async () => {
    const error = new Error("sync failure");
    const onError = vi.fn();

    runAsyncBoundary(() => { throw error; }, onError);
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });

  // Given: rejectする非同期操作
  // When: runAsyncBoundaryで実行する
  // Then: 未処理PromiseにせずonErrorへ渡す
  it("Scenario: 非同期例外をエラー通知へ渡す", async () => {
    const error = new Error("async failure");
    const onError = vi.fn();

    runAsyncBoundary(() => Promise.reject(error), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });

  // Given: cancel可能な未処理Promise拒否イベント
  // When: reportUnhandledRejectionでエラー通知する
  // Then: reasonを通知し、ブラウザの既定イベントを抑止しない
  it("Scenario: 未処理Promiseの既定通知を抑止せずエラーを渡す", async () => {
    const error = new Error("unhandled failure");
    const event = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: error });
    const onError = vi.fn();

    reportUnhandledRejection(event, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));

    expect(event.defaultPrevented).toBe(false);
  });
});
