import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  loadSettings: async () => "{}",
  updateSetting: vi.fn(async () => {}),
}));

import { initSettings } from "./settings";
import {
  addRegisteredCommand,
  commandLineForValue,
  commandsForPath,
  extensionOf,
  removeRegisteredCommand,
  updateRegisteredCommand,
} from "./registered-commands";

describe("registered commands", () => {
  beforeEach(() => initSettings());

  it("ファイル名から拡張子を大文字小文字に関係なく取り出す", () => {
    expect(extensionOf("sub/page.HTML")).toBe(".html");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("sub/.config")).toBe("");
  });

  it("プレフィックスを連結し、対象ファイルを指定した場所だけ置換する", () => {
    expect(commandLineForValue("cmd.exe /D /C", "powershell.exe -File {file}", "C:\\work\\page.ps1"))
      .toBe('cmd.exe /D /C powershell.exe -File "C:\\work\\page.ps1"');
    expect(commandLineForValue("", "powershell.exe", "C:\\work\\page.ps1"))
      .toBe("powershell.exe");
  });

  it("同じ拡張子のコマンドだけを返し、重複登録しない", () => {
    addRegisteredCommand({ extension: ".HTML", label: "Chrome", prefix: "", command: "chrome {file}" });
    addRegisteredCommand({ extension: "html", label: "Chrome", prefix: "", command: "chrome {file}" });
    addRegisteredCommand({ extension: ".txt", label: "メモ帳", prefix: "", command: "notepad {file}" });

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" },
    ]);
    expect(commandsForPath("page.txt")).toEqual([
      { extension: ".txt", label: "メモ帳", prefix: "", command: "notepad {file}" },
    ]);
  });

  it("登録解除は対象の1件だけを削除する", () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    addRegisteredCommand({ extension: ".html", label: "別アプリ", prefix: "", command: "other {file}" });

    removeRegisteredCommand(commandsForPath("page.html")[0]);

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "別アプリ", prefix: "", command: "other {file}" },
    ]);
  });

  it("登録コマンドの表示名と本文を更新する", () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    const command = commandsForPath("page.html")[0];

    updateRegisteredCommand(command, { label: "Chrome Dev", prefix: "cmd.exe /D /C", command: "chrome --incognito {file}" });

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "Chrome Dev", prefix: "cmd.exe /D /C", command: "chrome --incognito {file}" },
    ]);
  });
});
