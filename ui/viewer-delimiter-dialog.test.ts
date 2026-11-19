// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewerDelimiterDialog } from "./viewer-delimiter-dialog";
import { csvDelimiterOptions } from "./viewer-delimiter";
import viewerHtml from "../viewer.html?raw";

describe("Feature: CSV区切り文字ダイアログ", () => {
  afterEach(() => document.body.replaceChildren());

  // Given: CSVプレビューのタイトルバー
  // When: 区切り文字を変更する入口を確認する
  // Then: ダイアログ操作領域だけを残し、直接入力とプリセット選択を重複表示しない
  it("Scenario: タイトルバーの重複した区切り文字入力を削除する", () => {
    const template = document.createElement("template");
    template.innerHTML = viewerHtml;
    expect(template.content.querySelector("#viewer-csv-actions")).not.toBeNull();
    expect(template.content.querySelector("#viewer-delimiter-select")).toBeNull();
    expect(template.content.querySelector("#viewer-delimiter-input")).toBeNull();
  });

  // Given: 現在の区切り文字がカンマ
  // When: タブもチェックして適用する
  // Then: カンマとタブの両方が適用される
  it("Scenario: カンマとタブを併用する", () => {
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });
    const tab = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.value === "\\t")!;
    tab.click();
    document.querySelector<HTMLButtonElement>("button.primary")!.click();

    expect(csvDelimiterOptions(onApply.mock.calls[0][0])).toEqual([",", "\\t"]);
    expect(document.querySelector(".viewer-dialog-overlay")).toBeNull();
  });

  it("Scenario: 区切り文字のチェックをすべて外して適用する", () => {
    // Given: カンマだけがオン
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });
    // When: チェックを外して適用する
    document.querySelector<HTMLInputElement>('input[type="checkbox"]:checked')!.click();
    document.querySelector<HTMLButtonElement>("button.primary")!.click();
    // Then: 区切り文字が空になる
    expect(onApply).toHaveBeenCalledWith("");
  });

  // Feature: CSV区切り文字ダイアログのキャンセル
  // Scenario: Escapeでダイアログを閉じる
  // Given: 区切り文字ダイアログが表示されている
  // When: Escapeキーを押す
  // Then: 適用せずにダイアログを閉じる
  it("Scenario: Escapeで区切り文字ダイアログを閉じる", () => {
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector(".viewer-dialog-overlay")).toBeNull();
  });

  // Given: その他プリセットで区切り文字が空
  // When: 適用する
  // Then: エラー表示を残し、適用コールバックを呼ばない
  it("Scenario: 空のカスタム区切り文字を拒否する", () => {
    const onApply = vi.fn();
    openViewerDelimiterDialog({ value: ",", onApply });
    document.querySelector<HTMLInputElement>('input[value="__custom__"]')!.click();
    document.querySelector<HTMLButtonElement>("button.primary")!.click();

    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector(".viewer-dialog-error")?.textContent)
      .toBe("区切り文字を入力してください");
  });
});
