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
import { commandsForPath } from "./registered-commands";
import { initSettings } from "./settings";

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
  // When: 「コマンドを登録...」で登録した後、選択文字列を変更して登録コマンドを実行する
  // Then: 登録時の入力欄は`{string}`を示し、実行時は最新の選択文字列だけをコマンドへ渡し、対象パスは変えない
  it("Scenario: メモビューとフォルダビューで共有するメニューは対象値だけを差し替える", async () => {
    let selected = "https://first.example";
    const promptFields = vi.fn(async (...args: Parameters<typeof promptFieldsImpl>) => {
      const fields = args[1];
      expect(fields[2].label).toBe("コマンド（{string}=対象文字列、引用符不要）");
      return ["Browser", "", "open {string}"];
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
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "コマンドを登録...")!.click();
    await vi.waitFor(() => expect(commandsForPath(target.path, "string")).toHaveLength(1));

    selected = "https://second.example";
    showMenu(0, 0, [createRegisteredCommandMenu(target, services)]);
    [...dropdown.querySelectorAll<HTMLElement>(".dd-item")]
      .find((item) => item.textContent === "登録コマンド ▸")!.click();
    dropdown.querySelector<HTMLElement>(".dd-submenu .dd-item")!.click();

    await vi.waitFor(() => expect(runExternalCommand).toHaveBeenCalledWith(
      'open "https://second.example"',
      target.path,
    ));
    expect(promptFields).toHaveBeenCalledOnce();
  });
});
