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

  it("未設定のフォルダ検索オプションは null のまま返す", () => {
    expect(parseSettings("{}").workspaceSearchOptions).toBeNull();
    expect(parseSettings(JSON.stringify({ workspaceSearchOptions: { max_files: 5 } })).workspaceSearchOptions)
      .toEqual({ max_files: 5 });
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
