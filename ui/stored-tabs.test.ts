import { describe, expect, it } from "vitest";
import { isStoredTab, isStoredTabs } from "./stored-tabs";

const tab = (overrides: Record<string, unknown> = {}) => ({
  id: "tab-1",
  path: "memo.txt",
  kind: "file",
  label: "memo",
  ...overrides,
});

describe("Feature: 保存タブの検証", () => {
  // Given: 必須項目と任意の位置情報を持つStoredTab
  // When: isStoredTabを呼ぶ
  // Then: 正しいタブだけを受理する
  it("Scenario: 正しいStoredTabを受理する", () => {
    expect(isStoredTab(tab({
      draftDirectory: "C:\\Users\\sample\\Desktop",
      goto: { line: 2, col: 3 },
      selectedRelPath: "memo.txt",
      selectedLine: 2,
    }))).toBe(true);
  });

  // Given: goto、selectedLine、kindが不正なStoredTab
  // When: isStoredTabを呼ぶ
  // Then: 不正なタブを拒否する
  it("Scenario: 整数でない位置や未知のkindを拒否する", () => {
    expect(isStoredTab(tab({ goto: { line: -1, col: 0 } }))).toBe(false);
    expect(isStoredTab(tab({ draftDirectory: 1 }))).toBe(false);
    expect(isStoredTab(tab({ selectedLine: Number.NaN }))).toBe(false);
    expect(isStoredTab(tab({ kind: "unknown" }))).toBe(false);
  });

  // Given: 有効なタブ配列と無効なactiveId
  // When: isStoredTabsを呼ぶ
  // Then: activeIdの型も含めて全体を検証する
  it("Scenario: StoredTabs全体の構造を検証する", () => {
    expect(isStoredTabs({ tabs: [tab()], activeId: "tab-1" })).toBe(true);
    expect(isStoredTabs({ tabs: [tab({ id: 1 })], activeId: "tab-1" })).toBe(false);
    expect(isStoredTabs({ tabs: [tab()], activeId: 1 })).toBe(false);
  });
});
