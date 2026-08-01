import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateSettingMock } = vi.hoisted(() => ({ updateSettingMock: vi.fn(async () => {}) }));
vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting: updateSettingMock,
}));

import { flushSettings, initSettings, parseSettings, setSetting } from "./settings";

describe("settings", () => {
  beforeEach(async () => {
    updateSettingMock.mockReset();
    updateSettingMock.mockResolvedValue(undefined);
    await initSettings();
  });

  it("壊れたJSONは既定値として扱う", () => {
    expect(parseSettings("{ not json").indentSize).toBe(8);
    expect(parseSettings("[]").registeredStrings).toEqual([]);
  });

  it("型の合わない項目だけ既定値へ落とす", () => {
    const settings = parseSettings(
      JSON.stringify({ indentSize: "4", startupPath: "C:\\memo.txt", registeredStrings: ["ok", 42, ""] })
    );
    expect(settings.indentSize).toBe(8);
    expect(settings.startupPath).toBe("C:\\memo.txt");
    expect(settings.registeredStrings).toEqual(["ok"]);
  });

  it("インデント幅はUIと同じ候補だけ復元する", () => {
    expect(parseSettings(JSON.stringify({ indentSize: 4 })).indentSize).toBe(4);
    expect(parseSettings(JSON.stringify({ indentSize: 3 })).indentSize).toBe(8);
  });

  it("フォント設定を復元し、不正な値は既定値へ戻す", () => {
    const saved = parseSettings(JSON.stringify({ fontFamily: "Meiryo, sans-serif", fontSize: 16 }));
    expect(saved.fontFamily).toBe("Meiryo, sans-serif");
    expect(saved.fontSize).toBe(16);

    const invalid = parseSettings(JSON.stringify({ fontFamily: "", fontSize: 12.5 }));
    expect(invalid.fontFamily).toBe('Consolas, "MS Gothic", monospace');
    expect(invalid.fontSize).toBe(14);
  });

  it("未設定のフォルダ検索オプションは null のまま返す", () => {
    expect(parseSettings("{}").workspaceSearchOptions).toBeNull();
    expect(parseSettings(JSON.stringify({ workspaceSearchOptions: { max_files: 5 } })).workspaceSearchOptions)
      .toEqual({ max_files: 5 });
  });

  it("不正なStoredTab.gotoを復元しない", () => {
    const settings = parseSettings(JSON.stringify({
      openTabs: {
        tabs: [{ id: "tab-1", path: "memo.txt", kind: "file", label: "memo", goto: { line: 1 } }],
        activeId: "tab-1",
      },
    }));

    expect(settings.openTabs.tabs).toEqual([]);
  });

  it("先行保存の失敗を後続成功で握り潰さない", async () => {
    updateSettingMock
      .mockRejectedValueOnce(new Error("openTabs failed"))
      .mockResolvedValueOnce(undefined);

    setSetting("openTabs", { tabs: [], activeId: null });
    setSetting("indentSize", 4);

    await expect(flushSettings()).rejects.toThrow("openTabs failed");
    expect(updateSettingMock).toHaveBeenCalledTimes(2);
  });

  it("失敗したキーを再保存できればflushを成功扱いに戻す", async () => {
    updateSettingMock
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);

    setSetting("indentSize", 4);
    setSetting("indentSize", 8);

    await expect(flushSettings()).resolves.toBeUndefined();
  });
});
