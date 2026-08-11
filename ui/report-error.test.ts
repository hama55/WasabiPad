import { describe, expect, it, vi } from "vitest";
import { reportErrorSafely } from "./report-error";

describe("Feature: safe error reporting", () => {
  // Given: エラー表示処理が利用できる
  // When: エラーを通知する
  // Then: 元のタイトルとエラーを通知処理へ渡す
  it("Scenario: forwards an error to the reporter", async () => {
    const reporter = vi.fn();
    const error = new Error("failed");

    await reportErrorSafely(reporter, "操作に失敗しました", error);

    expect(reporter).toHaveBeenCalledWith("操作に失敗しました", error);
  });

  // Given: エラー表示処理自体が例外を投げる
  // When: エラーを通知する
  // Then: 二次障害を外へ漏らさず、コンソールへ記録する
  it("Scenario: contains reporter failures", async () => {
    const reporter = vi.fn(() => { throw new Error("report failed"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await reportErrorSafely(reporter, "操作に失敗しました", new Error("failed"));

    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
