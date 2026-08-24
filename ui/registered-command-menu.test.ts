// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateSetting } = vi.hoisted(() => ({
  updateSetting: vi.fn(async () => {}),
}));
vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting,
}));

import { hideMenu, showMenu } from "./menu";
import { promptFields as promptFieldsImpl } from "./prompt";
import {
  createRegisteredCommandMenu,
  type RegisteredCommandMenuServices,
} from "./registered-command-menu";
import { commandsForKind } from "./registered-commands";
import { initSettings } from "./settings";
import { MENU_ICON } from "./menu-icons";

describe("Feature: shared registered-command context menu", () => {
  beforeEach(async () => {
    const dropdown = document.createElement("div");
    dropdown.id = "dropdown";
    document.body.replaceChildren(dropdown);
    hideMenu();
    updateSetting.mockReset();
    updateSetting.mockResolvedValue(undefined);
    await initSettings();
  });

  // Given: memo.mdを対象にし、選択文字列を現在値として返す共通メニューと入力値
  // When: 「コマンドを登録...」で登録した後、複数行の選択文字列を変更して登録コマンドを実行する
  // Then: 登録時の入力欄は1つの広いコマンド欄で通常文字列とURL用文字列を示し、実行時は最新の選択文字列をURL用に変換し、対象パスは変えない
  it("Scenario: メモビューとフォルダビューで共有するメニューはURL用対象値を差し替える", async () => {
    let selected = "https://first.example";
    const promptFields = vi.fn(async (...args: Parameters<typeof promptFieldsImpl>) => {
      const fields = args[1];
      expect(fields).toHaveLength(2);
      expect(fields[0].label).toBe("表示名");
      expect(fields[1].label).toBe(
        "コマンド（{string}=対象文字列、{string_one_line}=改行をスペース化、{copy_string_clipboard}=クリップボードへコピー、{string_in_url}=URL用エンコード文字列、引用符不要）",
      );
      expect(fields[1].multiline).toBe(true);
      return ["Browser", "open {string_in_url}"];
    });
    const runExternalCommand = vi.fn(async () => {});
    const run = vi.fn<RegisteredCommandMenuServices["run"]>((_title, operation) => {
      void operation();
    });
    const services = { promptFields, runExternalCommand, run } satisfies RegisteredCommandMenuServices;
    const target = {
      path: "C:\\work\\memo.md",
      value: () => selected,
      valueKind: "string" as const,
    };
    const dropdown = document.getElementById("dropdown")!;

    showMenu(0, 0, [createRegisteredCommandMenu(target, services)]);
    expect(dropdown.querySelector(`.dd-item .${MENU_ICON.command}`)).not.toBeNull();
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();
    await vi.waitFor(() => expect(commandsForKind("string")).toHaveLength(1));
    expect(commandsForKind("string")[0]).toMatchObject({ prefix: "", command: "open {string_in_url}" });

    selected = "line 1 & line 2\nnext";
    showMenu(0, 0, [createRegisteredCommandMenu(target, services)]);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    expect([...dropdown.querySelectorAll<HTMLElement>(".dd-submenu .dd-item")]
      .every((item) => item.querySelector(".menu-icon, .fav-icon"))).toBe(true);
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(runExternalCommand).toHaveBeenCalledWith(
      "open line%201%20%26%20line%202%0Anext",
      target.path,
    ));
    expect(promptFields).toHaveBeenCalledOnce();
  });

  // Given: 複数行の選択文字列と`{copy_string_clipboard}`を含む登録コマンド
  // When: 登録コマンドを実行する
  // Then: 実行前に元の文字列をOSクリップボードへコピーし、placeholderを空文字にしたcommandを渡す
  it("Scenario: 登録コマンドが選択文字列をクリップボード経由で渡す", async () => {
    const selected = "line 1\nline 2";
    const promptFields = vi.fn(async () => ["Filter", "filter {copy_string_clipboard}"]);
    const writeClipboardText = vi.fn(async () => {});
    const runExternalCommand = vi.fn(async () => {});
    const run = vi.fn<RegisteredCommandMenuServices["run"]>((_title, operation) => {
      void operation();
    });
    const services = { promptFields, runExternalCommand, run, writeClipboardText } satisfies RegisteredCommandMenuServices;
    const target = {
      path: "C:\\work\\memo.md",
      value: () => selected,
      valueKind: "string" as const,
    };
    const dropdown = document.getElementById("dropdown")!;

    showMenu(0, 0, [createRegisteredCommandMenu(target, services)]);
    dropdown.querySelector<HTMLElement>(".dd-item")!.click();
    await vi.waitFor(() => expect(commandsForKind("string")).toHaveLength(1));

    showMenu(0, 0, [createRegisteredCommandMenu(target, services)]);
    dropdown.querySelector<HTMLElement>(".dd-item")!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(selected));
    await vi.waitFor(() => expect(runExternalCommand).toHaveBeenCalledWith("filter ", target.path));
  });
});
