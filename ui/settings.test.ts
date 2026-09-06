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
  flushSettings,
  getSetting,
  initSettings,
  parseSettings,
  parseSettingsResult,
  resetUserSettings,
  setSetting,
} from "./settings";

describe("Feature: settings", () => {
  beforeEach(async () => {
    loadSettingsMock.mockReset();
    loadSettingsMock.mockResolvedValue("{}");
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
    expect(parseSettingsResult("[]").corrupted).toBe(true);
  });

  // Given: 設定ファイルがJSONとして壊れている
  // When: 起動時の設定初期化を行う
  // Then: 既定値へ戻し、破損を警告する
  it("Scenario: 起動時の設定JSON破損を警告する", async () => {
    loadSettingsMock.mockResolvedValueOnce("{ not json");
    const warning = vi.fn();

    await initSettings(warning);

    expect(getSetting("indentSize")).toBe(8);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      message: "設定JSONが壊れているため、既定値を使用しました",
    }));
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

  // Given: 旧形式の拡張子・空ラベル・不正`valueKind`を含む登録コマンド4件
  // When: `parseSettings`を呼ぶ
  // Then: 有効な2件だけを拡張子なしの共通コマンドとして復元
  it("Scenario: 旧形式の登録コマンドを全拡張子共通へ移行する", () => {
    const settings = parseSettings(JSON.stringify({
      registeredCommands: [
        { extension: ".HTML", label: " Chrome ", command: " C:\\chrome.exe {file} " },
        { extension: ".md", label: "Browser", command: " open {string} ", valueKind: "string" },
        { extension: ".txt", label: "", prefix: "ignored", command: "ignored" },
        { extension: ".js", label: "Invalid", prefix: "", command: "open", valueKind: "other" },
      ],
    }));
    expect(settings.registeredCommands).toEqual([
      { label: "Chrome", prefix: "", command: "C:\\chrome.exe {file}" },
      { label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
    ]);
  });

  // Given: `indentSize`に4または3を指定
  // When: `parseSettings`を呼ぶ
  // Then: 4は復元し、3は8にする
  it("Scenario: インデント幅はUIと同じ候補だけ復元する", () => {
    expect(parseSettings(JSON.stringify({ indentSize: 4 })).indentSize).toBe(4);
    expect(parseSettings(JSON.stringify({ indentSize: 3 })).indentSize).toBe(8);
  });

  // Feature: サイドバー幅の設定
  // Scenario: 保存済みの幅を復元し、不安全な値は画面に収まる範囲へ丸める
  // Given: 正常値・小さすぎる値・大きすぎる値を設定ファイルへ保存する
  // When: `parseSettings`を呼ぶ
  // Then: 正常値は維持し、範囲外は安全な境界値へ戻す
  it("Scenario: サイドバー幅を安全に復元する", () => {
    expect(parseSettings(JSON.stringify({ sidebarWidth: 360 })).sidebarWidth).toBe(360);
    expect(parseSettings(JSON.stringify({ sidebarWidth: 1 })).sidebarWidth).toBe(120);
    expect(parseSettings(JSON.stringify({ sidebarWidth: 9999 })).sidebarWidth).toBe(640);
    expect(parseSettings("{}").sidebarWidth).toBe(220);
  });

  // Given: 有効なフォント設定と空文字/小数サイズの設定
  // When: `parseSettings`を呼ぶ
  // Then: 有効値は復元し、不正値は既定フォントと14に戻す
  it("Scenario: フォント設定を復元し、不正な値は既定値へ戻す", () => {
    const saved = parseSettings(JSON.stringify({ fontFamily: "Meiryo, sans-serif", fontSize: 16 }));
    expect(saved.fontFamily).toBe("Meiryo, sans-serif");
    expect(saved.fontSize).toBe(16);
    expect(saved.previewFontSize).toBe(16);

    const invalid = parseSettings(JSON.stringify({ fontFamily: "", fontSize: 12.5 }));
    expect(invalid.fontFamily).toBe('Consolas, "MS Gothic", monospace');
    expect(invalid.fontSize).toBe(14);
    expect(invalid.previewFontSize).toBe(14);
  });

  // Given: Markdownの通常改行設定が未設定・`false`・不正値として保存されている
  // When: `parseSettings`を呼ぶ
  // Then: 既定値は有効、明示したbooleanだけ復元し、不正値は既定値へ戻す
  it("Scenario: Markdown通常改行設定を安全に復元する", () => {
    expect(parseSettings("{}").markdownSoftBreaks).toBe(true);
    expect(parseSettings(JSON.stringify({ markdownSoftBreaks: false })).markdownSoftBreaks).toBe(false);
    expect(parseSettings(JSON.stringify({ markdownSoftBreaks: "false" })).markdownSoftBreaks).toBe(true);
  });

  // Given: エディタ用サイズ16とプレビュー用サイズ20を保存
  // When: `parseSettings`を呼ぶ
  // Then: それぞれのサイズを独立して復元する
  it("Scenario: エディタとプレビューの文字サイズを別々に復元する", () => {
    const saved = parseSettings(JSON.stringify({ fontSize: 16, previewFontSize: 20 }));
    expect(saved.fontSize).toBe(16);
    expect(saved.previewFontSize).toBe(20);
  });

  // Feature: 連携コマンド設定の保存
  // Scenario: 形式別の連携コマンドを正規化して復元する
  // Given: 大文字キー・前後空白・空値・不正値を含む連携コマンド設定
  // When: parseSettingsを呼ぶ
  // Then: 有効なコマンドだけを小文字キーとtrim済み文字列で復元する
  it("Scenario: 連携コマンド設定を安全に復元する", () => {
    const settings = parseSettings(JSON.stringify({
      externalEditorCommands: { " MD ": '  editor "{file}"  ', empty: " ", invalid: 42 },
      externalPreviewCommands: { Markdown: ' browser "{file}" ' },
    }));

    expect(settings.externalEditorCommands).toEqual({ md: 'editor "{file}"' });
    expect(settings.externalPreviewCommands).toEqual({ markdown: 'browser "{file}"' });
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定
  // Scenario: 未設定はバックエンド既定場所として復元し、保存済みの場所は保持する
  // Given: プレビューキャッシュ保存場所が未設定または `D:\\WasabiPad\\preview-cache` として保存されている
  // When: `parseSettings`を呼ぶ
  // Then: 未設定は`null`、保存済みの場所は同じ文字列になる
  it("Scenario: プレビューキャッシュ保存場所を復元する", () => {
    expect(parseSettings("{}").previewCacheDirectory).toBeNull();
    expect(parseSettings(JSON.stringify({ previewCacheDirectory: "D:\\WasabiPad\\preview-cache" }))
      .previewCacheDirectory).toBe("D:\\WasabiPad\\preview-cache");
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定
  // Scenario: 不正な保存場所は未設定へ戻す
  // Given: 数値・空文字・配列をプレビューキャッシュ保存場所として保存する
  // When: `parseSettings`を呼ぶ
  // Then: どの値も`null`として復元する
  it("Scenario: 不正なプレビューキャッシュ保存場所を無効化する", () => {
    expect(parseSettings(JSON.stringify({ previewCacheDirectory: 42 })).previewCacheDirectory).toBeNull();
    expect(parseSettings(JSON.stringify({ previewCacheDirectory: "" })).previewCacheDirectory).toBeNull();
    expect(parseSettings(JSON.stringify({ previewCacheDirectory: [] })).previewCacheDirectory).toBeNull();
  });

  // Given: フォント・起動パス・登録項目を変更し、再開タブも保存済み
  // When: アプリ設定だけを初期化する
  // Then: ユーザー設定は既定値へ戻り、再開タブは保持する
  it("Scenario: アプリ設定の初期化はセッション状態を保持する", async () => {
    const openTabs = {
      tabs: [{ id: "tab-1", path: "memo.txt", kind: "file" as const, label: "memo" }],
      activeId: "tab-1",
    };
    setSetting("openTabs", openTabs);
    setSetting("fontSize", 20);
    setSetting("markdownSoftBreaks", false);
    setSetting("startupPath", "C:\\work");
    setSetting("registeredStrings", ["snippet"]);
    await flushSettings();
    updateSettingMock.mockClear();

    resetUserSettings();
    await flushSettings();

    expect(getSetting("fontSize")).toBe(14);
    expect(getSetting("markdownSoftBreaks")).toBe(true);
    expect(getSetting("startupPath")).toBeNull();
    expect(getSetting("registeredStrings")).toEqual([]);
    expect(getSetting("openTabs")).toEqual(openTabs);
    expect(updateSettingMock).not.toHaveBeenCalledWith("openTabs", expect.anything());
  });

  // Feature: 外部プレビューキャッシュ保存場所の設定
  // Scenario: アプリ設定の初期化でプレビューキャッシュ保存場所を既定値へ戻す
  // Given: プレビューキャッシュ保存場所を `D:\\WasabiPad\\preview-cache` へ変更している
  // When: アプリ設定だけを初期化する
  // Then: 保存場所は`null`へ戻り、その値を保存する
  it("Scenario: 設定初期化でプレビューキャッシュ保存場所を戻す", async () => {
    setSetting("previewCacheDirectory", "D:\\WasabiPad\\preview-cache");
    await flushSettings();
    updateSettingMock.mockClear();

    resetUserSettings();
    await flushSettings();

    expect(getSetting("previewCacheDirectory")).toBeNull();
    expect(updateSettingMock).toHaveBeenCalledWith("previewCacheDirectory", "null");
  });

  // Given: プレビュー用文字サイズを20へ変更する
  // When: 設定保存をflushする
  // Then: エディタ用`fontSize`とは別のキーへ保存する
  it("Scenario: プレビュー文字サイズは専用キーへ保存する", async () => {
    setSetting("previewFontSize", 20);

    await flushSettings();

    expect(updateSettingMock).toHaveBeenCalledWith("previewFontSize", "20");
  });

  // Given: Markdown通常改行を無効にする
  // When: 設定保存をflushする
  // Then: 専用キーへboolean値を保存する
  it("Scenario: Markdown通常改行設定は専用キーへ保存する", async () => {
    setSetting("markdownSoftBreaks", false);

    await flushSettings();

    expect(updateSettingMock).toHaveBeenCalledWith("markdownSoftBreaks", "false");
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
