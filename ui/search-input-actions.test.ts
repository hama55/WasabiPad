// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { addSearchInputActions } from "./search-input-actions";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));

beforeEach(() => {
  document.body.innerHTML = '<div id="dropdown" hidden></div><input aria-label="検索" />';
  vi.resetAllMocks();
});

describe("Feature: 検索・置換欄の入力操作", () => {
  // Given: 文字を入力した検索欄
  // When: 欄内の消去ボタンを押す
  // Then: 入力イベントが通知され、同じ欄を空にして入力フォーカスを戻す
  it("Scenario: 消去後も同じ欄へ入力できる", () => {
    const input = document.querySelector("input")!;
    input.value = "猫";
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    addSearchInputActions(input, vi.fn());
    document.querySelector<HTMLButtonElement>(".search-input-clear")!.click();
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(onInput).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>(".search-input-clear")!.hidden).toBe(true);
  });

  // Given: 検索欄の途中が選択されている
  // When: 右クリックからクリップボードを貼り付ける
  // Then: 選択範囲だけ置き換え、入力イベントで検索を更新する
  it("Scenario: 右クリック貼り付けは入力欄の選択範囲を置き換える", async () => {
    const input = document.querySelector("input")!;
    input.value = "abc def ghi";
    input.setSelectionRange(4, 7);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    addSearchInputActions(input, vi.fn());
    vi.mocked(readText).mockResolvedValue("猫");
    input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const paste = [...document.querySelectorAll<HTMLElement>(".dd-item")].find(row => row.textContent!.includes("貼り付け"))!;
    paste.click();
    await vi.waitFor(() => expect(input.value).toBe("abc 猫 ghi"));
    expect(onInput).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });
});
