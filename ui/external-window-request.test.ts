import { describe, expect, it, vi } from "vitest";
import { processExternalWindowRequests, type ExternalWindowRequestPorts } from "./external-window-request";

function request(path: string | null) {
  return { secondary: true, path, goto: null, selectedRelPath: null, viewState: null };
}

function ports(overrides: Partial<ExternalWindowRequestPorts> = {}): ExternalWindowRequestPorts {
  return {
    open: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("Feature: external window request processing", () => {
  // Given: パスを持つ外部起動要求が2件ある
  // When: 外部起動要求を処理する
  // Then: 各要求を開いてから表示・フォーカスする
  it("Scenario: opens and focuses each external request", async () => {
    const calls: string[] = [];
    const requestPorts = ports({
      open: vi.fn(async (path) => { calls.push(`open:${path}`); }),
      show: vi.fn(async () => { calls.push("show"); }),
      focus: vi.fn(async () => { calls.push("focus"); }),
    });

    await processExternalWindowRequests([request("a.md"), request("b.md")], requestPorts);

    expect(calls).toEqual(["open:a.md", "show", "focus", "open:b.md", "show", "focus"]);
  });

  // Given: パスを持たない外部起動要求がある
  // When: 外部起動要求を処理する
  // Then: 空の要求を無視する
  it("Scenario: ignores an empty external request", async () => {
    const requestPorts = ports();

    await processExternalWindowRequests([request(null)], requestPorts);

    expect(requestPorts.open).not.toHaveBeenCalled();
    expect(requestPorts.onError).not.toHaveBeenCalled();
  });

  // Given: 外部起動要求のopenが失敗する
  // When: 外部起動要求を処理する
  // Then: エラーを通知し、後続要求の処理を続ける
  it("Scenario: reports a failed request and continues", async () => {
    const error = new Error("open failed");
    const requestPorts = ports({
      open: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined),
    });

    await processExternalWindowRequests([request("a.md"), request("b.md")], requestPorts);

    expect(requestPorts.onError).toHaveBeenCalledWith(error);
    expect(requestPorts.open).toHaveBeenCalledTimes(2);
  });
});
