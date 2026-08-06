import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateSettingMock } = vi.hoisted(() => ({ updateSettingMock: vi.fn(async () => {}) }));
vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting: updateSettingMock,
}));

import { flushSettings, initSettings, parseSettings, setSetting } from "./settings";

describe("Feature: settings", () => {
  beforeEach(async () => {
    updateSettingMock.mockReset();
    updateSettingMock.mockResolvedValue(undefined);
    await initSettings();
  });

  // Given: `"{ not json"` と `"[]"` を入力する
  // When: `parseSettings`を呼ぶ
  // Then: `indentSize`は8、`registeredStrings`は空配列
  it("Scenario: 壊れたJSONは既定値として扱う", () => {
    expect(parseSettings("{ not json").indentSize).toBe(8);
    expect(parseSettings("[]").registeredStrings).toEqual([]);
  });

  // Given: `indentSize:"4"`、`startupPath`、不正要素を含む`registeredStrings`を保存
  // When: `parseSettings`を呼ぶ
  // Then: `indentSize`は8、`startupPath`は維持、`registeredStrings`は`["ok"]`
  it("Scenario: 型の合わない項目だけ既定値へ落とす", () => {
    const settings = parseSettings(
      JSON.stringify({ indentSize: "4", startupPath: "C:\\memo.txt", registeredStrings: ["ok", 42, ""] })
    );
    expect(settings.indentSize).toBe(8);
    expect(settings.startupPath).toBe("C:\\memo.txt");
    expect(settings.registeredStrings).toEqual(["ok"]);
  });

  // Given: 大文字拡張子・空ラベル・不正`valueKind`を含む登録コマンド4件
  // When: `parseSettings`を呼ぶ
  // Then: 有効な`.html`と`.md`だけをtrim・小文字化して復元
  it("Scenario: 登録コマンドは有効な文字列項目だけ復元する", () => {
    const settings = parseSettings(JSON.stringify({
      registeredCommands: [
        { extension: ".HTML", label: " Chrome ", command: " C:\\chrome.exe {file} " },
        { extension: ".md", label: "Browser", command: " open {string} ", valueKind: "string" },
        { extension: ".txt", label: "", prefix: "ignored", command: "ignored" },
        { extension: ".js", label: "Invalid", prefix: "", command: "open", valueKind: "other" },
      ],
    }));
    expect(settings.registeredCommands).toEqual([
      { extension: ".html", label: "Chrome", prefix: "", command: "C:\\chrome.exe {file}" },
      { extension: ".md", label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
    ]);
  });

  // Given: `indentSize`に4または3を指定
  // When: `parseSettings`を呼ぶ
  // Then: 4は復元し、3は8にする
  it("Scenario: インデント幅はUIと同じ候補だけ復元する", () => {
    expect(parseSettings(JSON.stringify({ indentSize: 4 })).indentSize).toBe(4);
    expect(parseSettings(JSON.stringify({ indentSize: 3 })).indentSize).toBe(8);
  });

  // Given: 有効なフォント設定と空文字/小数サイズの設定
  // When: `parseSettings`を呼ぶ
  // Then: 有効値は復元し、不正値は既定フォントと14に戻す
  it("Scenario: フォント設定を復元し、不正な値は既定値へ戻す", () => {
    const saved = parseSettings(JSON.stringify({ fontFamily: "Meiryo, sans-serif", fontSize: 16 }));
    expect(saved.fontFamily).toBe("Meiryo, sans-serif");
    expect(saved.fontSize).toBe(16);

    const invalid = parseSettings(JSON.stringify({ fontFamily: "", fontSize: 12.5 }));
    expect(invalid.fontFamily).toBe('Consolas, "MS Gothic", monospace');
    expect(invalid.fontSize).toBe(14);
  });

  // Given: `workspaceSearchOptions`未設定または`{ max_files: 5 }`
  // When: `parseSettings`を呼ぶ
  // Then: 未設定は`null`、設定済みは同じオブジェクトを返す
  it("Scenario: 未設定のフォルダ検索オプションは null のまま返す", () => {
    expect(parseSettings("{}").workspaceSearchOptions).toBeNull();
    expect(parseSettings(JSON.stringify({ workspaceSearchOptions: { max_files: 5 } })).workspaceSearchOptions)
      .toEqual({ max_files: 5 });
  });

  // Given: `goto:{ line: 1 }`を持つStoredTab
  // When: `parseSettings`を呼ぶ
  // Then: `openTabs.tabs`は空配列
  it("Scenario: 不正なStoredTab.gotoを復元しない", () => {
    const settings = parseSettings(JSON.stringify({
      openTabs: {
        tabs: [{ id: "tab-1", path: "memo.txt", kind: "file", label: "memo", goto: { line: 1 } }],
        activeId: "tab-1",
      },
    }));

    expect(settings.openTabs.tabs).toEqual([]);
  });

  // Given: `openTabs`保存は`"openTabs failed"`で失敗し、次の保存は成功
  // When: 2キーを設定して`flushSettings`を呼ぶ
  // Then: 失敗理由をrejectし、保存mockは2回呼ぶ
  it("Scenario: 先行保存の失敗を後続成功で握り潰さない", async () => {
    updateSettingMock
      .mockRejectedValueOnce(new Error("openTabs failed"))
      .mockResolvedValueOnce(undefined);

    setSetting("openTabs", { tabs: [], activeId: null });
    setSetting("indentSize", 4);

    await expect(flushSettings()).rejects.toThrow("openTabs failed");
    expect(updateSettingMock).toHaveBeenCalledTimes(2);
  });

  // Given: `indentSize`を4へ保存後8へ上書きし、初回保存だけ失敗
  // When: `flushSettings`を呼ぶ
  // Then: `undefined`でresolveする
  it("Scenario: 失敗したキーを再保存できればflushを成功扱いに戻す", async () => {
    updateSettingMock
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);

    setSetting("indentSize", 4);
    setSetting("indentSize", 8);

    await expect(flushSettings()).resolves.toBeUndefined();
  });

  // Given: 保存mockが`undefined`をreject
  // When: `indentSize`を4にして`flushSettings`を呼ぶ
  // Then: `undefined`のままrejectする
  it("Scenario: undefinedの保存失敗もflushSettingsで通知する", async () => {
    updateSettingMock.mockRejectedValueOnce(undefined);
    setSetting("indentSize", 4);

    await expect(flushSettings()).rejects.toBeUndefined();
  });

  // Feature: 設定保存のflush
  // Scenario: flush中に新しい設定保存が追加される
  // Given: 最初の保存が未解決
  // When: flushSettingsを開始してから別の設定を変更する
  // Then: 後から追加された保存も完了してからflushする
  it("Scenario: flush中に追加された設定保存も待つ", async () => {
    let releaseFirst!: () => void;
    updateSettingMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));

    setSetting("indentSize", 4);
    const flushing = flushSettings();
    await vi.waitFor(() => expect(updateSettingMock).toHaveBeenCalledOnce());
    setSetting("fontSize", 16);
    releaseFirst();

    await flushing;
    expect(updateSettingMock).toHaveBeenCalledTimes(2);
  });
});
