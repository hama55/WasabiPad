// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewerDelimiterDialog } from "./viewer-delimiter-dialog";

describe("Feature: CSV区切り文字ダイアログ", () => {
  afterEach(() => document.body.replaceChildren());

  // Given: 現在の区切り文字がカンマ
  // When: プリセットでTSVを選択して適用する
  // Then: タブ表現をコールバックへ渡す
  it("Scenario: TSVプリセットを適用する", () => {
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });
    const preset = document.querySelector<HTMLSelectElement>("select")!;
    preset.value = "\\t";
    preset.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>("button.primary")!.click();

    expect(onApply).toHaveBeenCalledWith("\\t");
    expect(document.querySelector(".viewer-dialog-overlay")).toBeNull();
  });

  // Given: その他プリセットで区切り文字が空
  // When: 適用する
  // Then: エラー表示を残し、適用コールバックを呼ばない
  it("Scenario: 空のカスタム区切り文字を拒否する", () => {
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });
    const preset = document.querySelector<HTMLSelectElement>("select")!;
    preset.value = "__custom__";
    preset.dispatchEvent(new Event("change"));
    document.querySelector<HTMLInputElement>("input")!.value = "";
    document.querySelector<HTMLButtonElement>("button.primary")!.click();

    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector(".viewer-dialog-error")?.textContent)
      .toBe("区切り文字を入力してください");
  });
});
