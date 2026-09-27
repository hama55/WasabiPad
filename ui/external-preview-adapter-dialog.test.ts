import { describe, expect, it, vi } from "vitest";
import { promptExternalPreviewAdapter } from "./external-preview-adapter-dialog";
import type { promptFields as promptFieldsImpl } from "./prompt";

describe("Feature: external preview adapter dialog", () => {
  // Feature: 外部プレビューアダプタの登録
  // Scenario: 入力値を正規化して保存用の設定へ変換する
  // Given: 拡張子・実行プログラム・引数・出力形式・優先順位が入力される
  // When: アダプタ設定ダイアログを確定する
  // Then: 拡張子と実行プログラムが正規化され、他の値が保持される
  it("Scenario: 登録値を保存用の形へ正規化する", async () => {
    const promptFields = vi.fn(async (..._args: Parameters<typeof promptFieldsImpl>) => [
      ".ABC, abc, .mid",
      "  renderer  ",
      '--input "{file}" --output \'{output}\'',
      "html",
      "external",
    ]);

    const result = await promptExternalPreviewAdapter({ promptFields });

    expect(result).toEqual({
      extensions: ["abc", "mid"],
      command: "renderer",
      args: '--input "{file}" --output \'{output}\'',
      outputFormat: "html",
      preferExternal: true,
    });
    expect(promptFields).toHaveBeenCalledOnce();
  });

  // Feature: 外部プレビューアダプタの登録境界
  // Scenario: 必須プレースホルダーがない入力を保存しない
  // Given: `{output}`だけを含む引数が返される
  // When: アダプタ設定ダイアログを確定する
  // Then: 不正な設定は破棄される
  it("Scenario: 入力ファイルを渡さない設定を拒否する", async () => {
    const promptFields = vi.fn(async (..._args: Parameters<typeof promptFieldsImpl>) => [
      "abc",
      "renderer",
      "{output}",
      "svg",
      "standard",
    ]);

    await expect(promptExternalPreviewAdapter({ promptFields })).resolves.toBeNull();
  });

  // Given: ダイアログがキャンセルされる
  // When: アダプタ設定ダイアログを閉じる
  // Then: 設定変更なしでnullを返す
  it("Scenario: キャンセルは設定を変更しない", async () => {
    const promptFields = vi.fn(async (..._args: Parameters<typeof promptFieldsImpl>) => null);

    await expect(promptExternalPreviewAdapter({ promptFields })).resolves.toBeNull();
  });
});
