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

describe("Feature: registered commands", () => {
  beforeEach(() => initSettings());

  // Given: `sub/page.HTML`、README、`.config`を入力
  // When: `extensionOf`を呼ぶ
  // Then: `.html`、空文字、空文字
  it("Scenario: ファイル名から拡張子を大文字小文字に関係なく取り出す", () => {
    expect(extensionOf("sub/page.HTML")).toBe(".html");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("sub/.config")).toBe("");
  });

  // Given: prefixと`{file}`付きcommandを用意
  // When: `commandLineForValue`を呼ぶ
  // Then: prefix連結、対象pathだけ引用符付き置換
  it("Scenario: プレフィックスを連結し、対象ファイルを指定した場所だけ置換する", () => {
    expect(commandLineForValue("cmd.exe /D /C", "powershell.exe -File {file}", "C:\\work\\page.ps1"))
      .toBe('cmd.exe /D /C powershell.exe -File "C:\\work\\page.ps1"');
    expect(commandLineForValue("", "powershell.exe", "C:\\work\\page.ps1"))
      .toBe("powershell.exe");
  });

  // Given: 実行ファイルpathに空白があり、prefixなし
  // When: `{file}`を置換
  // Then: 実行ファイルと対象pathをそれぞれ引用符付きで出力
  it("Scenario: 実行ファイルはプレフィックスなしで対象ファイルを渡す", () => {
    expect(commandLineForValue(
      "",
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" {file}',
      "C:\\work\\index.html",
    )).toBe('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "C:\\work\\index.html"');
  });

  // Given: valueKind=`string`、`{string}`または`{file}`を含むcommand
  // When: 文字列値で置換
  // Then: `{string}`だけ置換し、`{file}`は残す
  it("Scenario: メモビューは対象文字列用プレースホルダだけを置換する", () => {
    expect(commandLineForValue("", "open {string}", "https://example.com", "string"))
      .toBe('open "https://example.com"');
    expect(commandLineForValue("", "open {file}", "https://example.com", "string"))
      .toBe("open {file}");
  });

  // Given: 値に引用符・末尾`\`・改行・`$&`がある
  // When: 文字列placeholderを置換
  // Then: 各文字を保持した引用符付きcommandを生成
  it("Scenario: 対象値の引用符・改行・末尾バックスラッシュを保持する", () => {
    expect(commandLineForValue("", "open {string}", "a\"b\\", "string"))
      .toBe(String.raw`open "a\"b\\"`);
    expect(commandLineForValue("", "open {string}", "line1\nline2", "string"))
      .toBe('open "line1\nline2"');
    expect(commandLineForValue("", "open {string}", "a$&b", "string"))
      .toBe('open "a$&b"');
  });

  // Given: 改行とURL上で予約される`&`を含む選択文字列
  // When: `{string_in_url}`を置換する
  // Then: 選択文字列全体をURLクエリ値としてパーセントエンコードする
  it("Scenario: URL用プレースホルダーは複数行の選択文字列をエンコードする", () => {
    expect(commandLineForValue(
      'cmd.exe /D /C start ""',
      "https://translate.google.com/?op=translate^&sl=en^&tl=ja^&text={string_in_url}",
      "line 1 & line 2\nnext",
      "string",
    )).toBe(
      'cmd.exe /D /C start "" https://translate.google.com/?op=translate^&sl=en^&tl=ja^&text="line%201%20%26%20line%202%0Anext"',
    );
  });

  // Given: `.HTML`/`html`の同一Chromeと`.txt`メモ帳を登録
  // When: html/txtのcommand一覧を取得
  // Then: 重複なしで各拡張子のcommandだけ返す
  it("Scenario: 同じ拡張子のコマンドだけを返し、重複登録しない", () => {
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

  // Given: 同じ`.html`にfile用とstring用を登録
  // When: kindなし/kind=`string`で取得
  // Then: それぞれ対応する1件だけ返す
  it("Scenario: ファイル用と文字列用の登録コマンドを混同しない", () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    addRegisteredCommand({
      extension: ".html",
      label: "Browser",
      prefix: "",
      command: "open {string}",
      valueKind: "string",
    });

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" },
    ]);
    expect(commandsForPath("page.html", "string")).toEqual([
      { extension: ".html", label: "Browser", prefix: "", command: "open {string}", valueKind: "string" },
    ]);
  });

  // Given: `.html`にChromeと別アプリを登録
  // When: Chromeをremove
  // Then: 別アプリだけ残る
  it("Scenario: 登録解除は対象の1件だけを削除する", () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    addRegisteredCommand({ extension: ".html", label: "別アプリ", prefix: "", command: "other {file}" });

    removeRegisteredCommand(commandsForPath("page.html")[0]);

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "別アプリ", prefix: "", command: "other {file}" },
    ]);
  });

  // Given: Chrome commandを登録済み
  // When: label/prefix/commandを更新
  // Then: 更新後のChrome Dev定義を返す
  it("Scenario: 登録コマンドの表示名と本文を更新する", () => {
    addRegisteredCommand({ extension: ".html", label: "Chrome", prefix: "", command: "chrome {file}" });
    const command = commandsForPath("page.html")[0];

    updateRegisteredCommand(command, { label: "Chrome Dev", prefix: "cmd.exe /D /C", command: "chrome --incognito {file}" });

    expect(commandsForPath("page.html")).toEqual([
      { extension: ".html", label: "Chrome Dev", prefix: "cmd.exe /D /C", command: "chrome --incognito {file}" },
    ]);
  });
});
