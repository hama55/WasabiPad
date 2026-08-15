import { describe, expect, it, vi } from "vitest";
import { canCloseWindow, type CloseRequestPorts } from "./close-request";

function ports(overrides: Partial<CloseRequestPorts> = {}): CloseRequestPorts {
  return {
    saveForExit: vi.fn(async (onProceed: () => void | Promise<void>) => {
      await onProceed();
      return true;
    }),
    flushSettings: vi.fn(async () => {}),
    onSettingsError: vi.fn(),
    ...overrides,
  };
}

describe("Feature: close request handling", () => {
  // Given: 未保存文書の保存が成功し、設定保存も成功する
  // When: 終了可否を判定する
  // Then: 終了を許可する
  it("Scenario: allows close after saving", async () => {
    const current = ports();

    await expect(canCloseWindow(current)).resolves.toBe(true);

    expect(current.flushSettings).toHaveBeenCalledOnce();
  });

  // Given: 未保存文書の保存確認で終了を拒否する
  // When: 終了可否を判定する
  // Then: 設定保存を行わず、終了を拒否する
  it("Scenario: rejects close when document saving is declined", async () => {
    const flushSettings = vi.fn(async () => {});
    const result = await canCloseWindow(ports({ saveForExit: vi.fn(async () => false), flushSettings }));

    expect(result).toBe(false);
    expect(flushSettings).not.toHaveBeenCalled();
  });

  // Given: 未保存文書の保存後に設定保存が失敗する
  // When: 終了可否を判定する
  // Then: エラーを通知して終了を拒否する
  it("Scenario: reports settings failure and rejects close", async () => {
    const error = new Error("settings failed");
    const onSettingsError = vi.fn();

    const result = await canCloseWindow(ports({
      flushSettings: vi.fn(async () => { throw error; }),
      onSettingsError,
    }));

    expect(result).toBe(false);
    expect(onSettingsError).toHaveBeenCalledWith(error);
  });

  // Given: 文書側の終了確認が失敗する
  // When: 終了可否を判定する
  // Then: 設定保存エラーへ混同せず、呼び出し側へ例外を返す
  it("Scenario: 文書確認の失敗を設定保存エラーとして扱わない", async () => {
    const error = new Error("document confirmation failed");
    const onSettingsError = vi.fn();

    await expect(canCloseWindow(ports({
      saveForExit: vi.fn(async () => { throw error; }),
      onSettingsError,
    }))).rejects.toBe(error);

    expect(onSettingsError).not.toHaveBeenCalled();
  });
});
