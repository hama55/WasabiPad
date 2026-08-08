import { describe, expect, it, vi } from "vitest";
import { canCloseWindow, type CloseRequestPorts } from "./close-request";

function ports(overrides: Partial<CloseRequestPorts> = {}): CloseRequestPorts {
  return {
    saveForExit: vi.fn(async () => true),
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
    await expect(canCloseWindow(ports())).resolves.toBe(true);
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
});
