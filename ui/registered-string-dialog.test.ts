// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const { updateSetting } = vi.hoisted(() => ({
  updateSetting: vi.fn(async () => {}),
}));
vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting,
}));

import { loadRegisteredStrings } from "./registered-strings";
import { initSettings } from "./settings";
import { promptAndSaveRegisteredString, promptRegisteredString } from "./registered-string-dialog";
import type { promptFields } from "./prompt";

describe("Feature: registered string dialog", () => {
  beforeEach(async () => {
    updateSetting.mockReset();
    updateSetting.mockResolvedValue(undefined);
    await initSettings();
  });

  // Given: 選択範囲を初期値にした登録文字列ダイアログ
  // When: 共通promptFieldsへ表示内容を委譲する
  // Then: 複数行の文字列入力として登録値を返す
  it("Scenario: 選択範囲を初期値にして登録する", async () => {
    const prompt = vi.fn<typeof promptFields>(async (_title, fields) => {
      expect(fields).toHaveLength(1);
      expect(fields[0].label).toBe("文字列");
      expect(fields[0].value).toBe("line 1\nline 2");
      expect(fields[0].multiline).toBe(true);
      expect(fields[0].validate?.("", [""])).toBe("文字列を入力してください");
      expect(fields[0].validate?.("  ", ["  "])).toBe("文字列を入力してください");
      expect(fields[0].validate?.("ok", ["ok"])).toBeNull();
      return ["updated"];
    });

    await expect(promptRegisteredString(prompt, "登録文字列を登録", "line 1\nline 2"))
      .resolves.toBe("updated");
  });

  // Given: 既存の登録文字列を初期値にした編集ダイアログ
  // When: キャンセルする
  // Then: nullを返して保存処理を呼び出し側へ委譲する
  it("Scenario: 登録文字列の編集キャンセルをそのまま返す", async () => {
    const prompt = vi.fn<typeof promptFields>(async () => null);

    await expect(promptRegisteredString(prompt, "登録文字列を編集", "before"))
      .resolves.toBeNull();
  });

  // Given: 登録文字列の追加ダイアログが保存値を返す
  // When: 共通ダイアログの結果を保存する
  // Then: 登録文字列ストアへ追加し、保存完了まで待つ
  it("Scenario: 共通ダイアログの結果を登録文字列へ保存する", async () => {
    const prompt = vi.fn<typeof promptFields>(async () => ["saved"]);

    await promptAndSaveRegisteredString(prompt);

    expect(loadRegisteredStrings()).toEqual(["saved"]);
    expect(updateSetting).toHaveBeenCalledWith("registeredStrings", JSON.stringify(["saved"]));
  });
});
