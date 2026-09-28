import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSettingsMock, updateSettingMock } = vi.hoisted(() => ({
  loadSettingsMock: vi.fn(async () => "{}"),
  updateSettingMock: vi.fn(async () => {}),
}));
vi.mock("./api", () => ({
  loadSettings: loadSettingsMock,
  updateSetting: updateSettingMock,
}));

import {
  externalPreviewAdapterForPath,
  parseExternalPreviewArguments,
  previewSelectionForAdapter,
} from "./external-preview-adapter-model";
import {
  flushSettings,
  getSetting,
  initSettings,
  parseSettings,
  resetUserSettings,
  setSetting,
} from "./settings";

describe("Feature: external preview adapter settings", () => {
  beforeEach(async () => {
    loadSettingsMock.mockReset();
    loadSettingsMock.mockResolvedValue("{}");
    updateSettingMock.mockReset();
    updateSettingMock.mockResolvedValue(undefined);
    await initSettings();
  });

  // Feature: 外部プレビュー設定の復元
  // Scenario: 拡張子と各フィールドを正規化して不正な設定を捨てる
  // Given: 正規化可能なアダプタと不正なアダプタを含む設定JSONが保存されている
  // When: `parseSettings`を呼ぶ
  // Then: 拡張子はドットなし小文字・重複排除され、不正なアダプタは復元されない
  it("Scenario: 外部プレビューを安全に復元する", () => {
    expect(parseSettings(JSON.stringify({
      externalPreviewAdapters: [
        {
          id: "svg-renderer",
          extensions: [".ABC", "abc", "", 42, ".SVG"],
          command: "renderer",
          args: "--input {file} {output}",
          outputFormat: "svg",
          preferExternal: true,
        },
        {
          id: "bad-format",
          extensions: ["txt"],
          command: "renderer",
          args: "",
          outputFormat: "pdf",
          preferExternal: false,
        },
        {
          id: "bad-args",
          extensions: ["ly"],
          command: "renderer",
          args: "{file}",
          outputFormat: "html",
          preferExternal: false,
        },
        "not an adapter",
      ],
    })).externalPreviewAdapters).toEqual([{
      id: "svg-renderer",
      extensions: ["abc", "svg"],
      command: "renderer",
      args: "--input {file} {output}",
      outputFormat: "svg",
      preferExternal: true,
    }]);
  });

  // Feature: 外部プレビュー設定の後方互換
  // Scenario: 既存設定に新しいキーがない
  // Given: 既存形式の設定JSONが保存されている
  // When: `parseSettings`を呼ぶ
  // Then: 既存設定を保ち、アダプタは空配列になる
  it("Scenario: 既存設定を壊さず未設定を既定値へ戻す", () => {
    const settings = parseSettings(JSON.stringify({ fontSize: 16 }));

    expect(settings.fontSize).toBe(16);
    expect(settings.externalPreviewAdapters).toEqual([]);
  });

  // Feature: 外部プレビューの拡張子一致
  // Scenario: 大文字拡張子の保存済みファイルを一致させる
  // Given: `abc`を対象拡張子に登録したアダプタがある
  // When: `score.ABC`のアダプタを検索する
  // Then: 拡張子別に選択済みの場合だけ登録したアダプタが返る
  it("Scenario: 保存済みファイルの拡張子でアダプタを選ぶ", () => {
    const adapter = {
      id: "abc-renderer",
      extensions: ["abc"],
      command: "renderer",
      args: "",
      outputFormat: "html" as const,
      preferExternal: false,
    };

    expect(externalPreviewAdapterForPath("C:\\work\\score.ABC", [adapter])).toBeNull();
    expect(externalPreviewAdapterForPath("C:\\work\\score.ABC", [adapter], { abc: adapter.id })).toBe(adapter);
    expect(externalPreviewAdapterForPath("C:\\work\\score.txt", [adapter], { abc: adapter.id })).toBeNull();
  });

  // Feature: 標準プレビューと外部プレビューの優先順位
  // Scenario: 外部優先の指定だけで標準形式との競合を切り替える
  // Given: 拡張子に一致するアダプタと標準プレビューの有無がある
  // When: `previewSelectionForAdapter`を呼ぶ
  // Then: 標準形式があれば既定で標準、外部優先なら外部を選ぶ
  it("Scenario: 標準形式優先と外部優先を判定する", () => {
    const standardFirst = {
      id: "abc-renderer",
      extensions: ["abc"],
      command: "renderer",
      args: "",
      outputFormat: "html" as const,
      preferExternal: false,
    };
    const externalFirst = { ...standardFirst, preferExternal: true };

    expect(previewSelectionForAdapter(null, true)).toBe("standard");
    expect(previewSelectionForAdapter(standardFirst, true)).toBe("standard");
    expect(previewSelectionForAdapter(externalFirst, true)).toBe("external");
    expect(previewSelectionForAdapter(standardFirst, false)).toBe("external");
    expect(previewSelectionForAdapter(null, false)).toBeNull();
  });

  // Feature: 外部プレビュー引数の受け渡し
  // Scenario: 引用符を外して空白を含む引数を保つ
  // Given: 外部コマンドの引数欄に引用符付きのパスとプレースホルダーがある
  // When: 引数を分割する
  // Then: 各プレースホルダーが1引数として残る
  it("Scenario: 引用符付き引数を安全に分割する", () => {
    expect(parseExternalPreviewArguments('--mode "{file}" --output \'{output}\'')).toEqual([
      "--mode", "{file}", "--output", "{output}",
    ]);
    expect(parseExternalPreviewArguments('"" plain')).toEqual(["", "plain"]);
  });

  // Given: 閉じていない引用符を含む引数欄がある
  // When: 引数を分割する
  // Then: 保存前に診断する
  it("Scenario: 閉じていない引用符を拒否する", () => {
    expect(() => parseExternalPreviewArguments('"{file}')).toThrow("引用符");
  });

  // Feature: 外部プレビュー設定の初期化
  // Scenario: アプリ設定の初期化でアダプタを既定値へ戻す
  // Given: 外部プレビューを保存している
  // When: `resetUserSettings`を呼ぶ
  // Then: アダプタは空配列になり、保存対象にも含まれる
  it("Scenario: 設定初期化で外部プレビューを戻す", async () => {
    setSetting("externalPreviewAdapters", [{
      id: "abc-renderer",
      extensions: ["abc"],
      command: "renderer",
      args: "",
      outputFormat: "html",
      preferExternal: true,
    }]);
    await flushSettings();
    updateSettingMock.mockClear();

    resetUserSettings();
    await flushSettings();

    expect(getSetting("externalPreviewAdapters")).toEqual([]);
    expect(updateSettingMock).toHaveBeenCalledWith("externalPreviewAdapters", "[]");
  });
});
