import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry, globalCommandForEvent } from "./commands";

const noop = vi.fn();
const registry = createCommandRegistry({
  newFile: async () => {},
  openFile: noop,
  openFolder: noop,
  save: async () => true,
  saveAs: async () => true,
  refresh: async () => {},
  quit: noop,
  find: noop,
  reopenClosedTab: async () => true,
});

function key(key: string, shiftKey = false, defaultPrevented = false): KeyboardEvent {
  return { key, ctrlKey: true, shiftKey, defaultPrevented } as KeyboardEvent;
}

describe("Feature: command registry", () => {
  // Given: `save`/`saveAs`が成功するcommand registryとCtrl-S/Ctrl-Shift-Sイベント
  // When: `globalCommandForEvent`を呼ぶ
  // Then: 戻り値がそれぞれ`registry.save`、`registry.saveAs`
  it("Scenario: uses the same command for menu metadata and shortcuts", () => {
    expect(globalCommandForEvent(registry, key("s"))).toBe(registry.save);
    expect(globalCommandForEvent(registry, key("s", true))).toBe(registry.saveAs);
  });

  // Given: Ctrl-Fイベントと、defaultPrevented=trueのCtrl-Sイベント
  // When: `globalCommandForEvent`を呼ぶ
  // Then: どちらも`undefined`
  it("Scenario: does not dispatch events already handled by the editor", () => {
    expect(globalCommandForEvent(registry, key("f"))).toBeUndefined();
    expect(globalCommandForEvent(registry, key("s", false, true))).toBeUndefined();
  });

  // Given: F5をファイル更新へ割り当てたcommand registry
  // When: CtrlなしのF5イベントを`globalCommandForEvent`へ渡す
  // Then: refresh commandを返す
  it("Scenario: F5をファイル更新へ割り当てる", () => {
    const event = { key: "F5", ctrlKey: false, shiftKey: false, defaultPrevented: false } as KeyboardEvent;
    expect(globalCommandForEvent(registry, event)).toBe(registry.refresh);
  });

  // Feature: 閉じたタブの復活ショートカット
  // Scenario: Ctrl+Shift+Tで閉じたタブを復活する
  // Given: 閉じたタブの復活commandを持つregistry
  // When: Ctrl+Shift+Tイベントを判定する
  // Then: reopenClosedTab commandを返す
  it("Scenario: Ctrl+Shift+Tを閉じたタブの復活へ割り当てる", () => {
    expect(globalCommandForEvent(registry, key("t", true))).toBe(registry.reopenClosedTab);
  });

  // Scenario: モーダル表示中は背後のglobal shortcutを実行しない
  // Given: .pf-overlay内の入力欄から発生したCtrl+Shift+Tイベント
  // When: globalCommandForEventでcommandを判定する
  // Then: 閉じたタブの復活commandを返さない
  it("Scenario: モーダル内のキー操作を背後のcommandへ漏らさない", () => {
    const event = {
      ...key("t", true),
      target: { closest: (selector: string) => selector === ".pf-overlay" ? {} : null },
    } as unknown as KeyboardEvent;

    expect(globalCommandForEvent(registry, event)).toBeUndefined();
  });
});
