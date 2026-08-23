// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptFields } from "./prompt";

describe("Feature: promptFields", () => {
  beforeEach(() => document.body.replaceChildren());

  // Given: 表示名PowerShell、command初期値、preview rendererを設定
  // When: command入力を変更してOK
  // Then: previewが追随しreadonly、結果が`PowerShell`と変更後command
  it("Scenario: プレビューを初期表示し、入力変更に追随させる", async () => {
    const result = promptFields(
      "コマンドを編集",
      [
        { label: "表示名", value: "PowerShell" },
        { label: "コマンド", value: "powershell.exe -File {file}" },
      ],
      {
        preview: {
          label: "実行文字列",
          render: (values) => `cmd.exe /D /C ${values[1]}`,
        },
      },
    );

    const preview = document.querySelector<HTMLTextAreaElement>(".pf-preview-value")!;
    expect(preview.value).toBe("cmd.exe /D /C powershell.exe -File {file}");
    expect(preview.readOnly).toBe(true);

    const command = document.querySelectorAll<HTMLInputElement>("input")[1];
    command.value = "pwsh.exe -NoProfile -File {file}";
    command.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preview.value).toBe("cmd.exe /D /C pwsh.exe -NoProfile -File {file}");

    document.querySelector<HTMLButtonElement>(".pf-ok")!.click();
    await expect(result).resolves.toEqual(["PowerShell", "pwsh.exe -NoProfile -File {file}"]);
  });

  // Feature: 入力変更時の連動更新
  // Scenario: 拡張子の変更でファイル名欄を更新する
  // Given: ファイル名と拡張子の2項目、拡張子変更時にsetValueする処理
  // When: 拡張子を`md`へ変更する
  // Then: ファイル名欄が更新され、OK結果にも反映される
  it("Scenario: 項目変更時に別の入力値を更新できる", async () => {
    const result = promptFields("新規メモ", [
      { label: "ファイル名", value: "memo1" },
      {
        label: "拡張子",
        value: "txt",
        options: [{ label: ".txt", value: "txt" }, { label: ".md", value: "md" }],
        onChange: (value, _values, setValue) => {
          if (value === "md") setValue(0, "memo");
        },
      },
    ]);

    const extension = document.querySelector<HTMLSelectElement>("select")!;
    extension.value = "md";
    extension.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("memo");
    document.querySelector<HTMLButtonElement>(".pf-ok")!.click();
    await expect(result).resolves.toEqual(["memo", "md"]);
  });

  // Feature: 非同期入力変更の確定制御
  // Scenario: 候補取得中にOKを押しても、処理完了までダイアログを確定しない
  // Given: 拡張子変更時の処理が未完了のPromiseを返す
  // When: 拡張子を変更してすぐOKを押し、処理を完了する
  // Then: 完了前は結果を返さず、完了後のOKで現在値を返す
  it("Scenario: 非同期の入力変更中は確定を待つ", async () => {
    let release!: () => void;
    const result = promptFields("新規メモ", [{
      label: "拡張子",
      value: "txt",
      options: [{ label: ".txt", value: "txt" }, { label: ".md", value: "md" }],
      onChange: async () => new Promise<void>((resolve) => { release = resolve; }),
    }]);
    const extension = document.querySelector<HTMLSelectElement>("select")!;
    const ok = document.querySelector<HTMLButtonElement>(".pf-ok")!;

    extension.value = "md";
    extension.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ok.disabled).toBe(true);
    ok.click();
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await vi.waitFor(() => expect(ok.disabled).toBe(false));
    ok.click();
    await expect(result).resolves.toEqual(["md"]);
  });

  // Feature: 非同期入力変更のエラー境界
  // Scenario: 入力変更処理が失敗してもPromise rejectを外へ漏らさない
  // Given: onChangeがErrorを返し、エラー通知ポートがある
  // When: 入力変更イベントを発生させる
  // Then: エラー通知後もダイアログを確定できる
  it("Scenario: 非同期の入力変更失敗を通知して確定できる", async () => {
    const error = new Error("candidate failed");
    const onChangeError = vi.fn();
    const result = promptFields("新規メモ", [{
      label: "拡張子",
      value: "txt",
      options: [{ label: ".txt", value: "txt" }, { label: ".md", value: "md" }],
      onChange: async () => { throw error; },
    }], { onChangeError });
    const extension = document.querySelector<HTMLSelectElement>("select")!;

    extension.value = "md";
    extension.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(onChangeError).toHaveBeenCalledWith(error));

    document.querySelector<HTMLButtonElement>(".pf-ok")!.click();
    await expect(result).resolves.toEqual(["md"]);
  });

  // Feature: コマンド登録用の入力欄
  // Scenario: コマンド本文を改行可能なtextareaで表示する
  // Given: multiline指定のコマンド本文
  // When: モーダルを表示してOKを押す
  // Then: 広いモーダルのtextareaから改行を含む値を返す
  it("Scenario: multiline指定の入力欄をtextareaとして表示する", async () => {
    const result = promptFields("コマンドを登録", [
      { label: "表示名", value: "Filter" },
      { label: "コマンド", value: "filter {copy_string_clipboard}", multiline: true },
    ]);

    const box = document.querySelector<HTMLElement>(".pf-box")!;
    const command = document.querySelector<HTMLTextAreaElement>("textarea.pf-multiline-value")!;
    expect(box.classList.contains("pf-command-box")).toBe(true);
    expect(command.rows).toBe(6);
    expect(command.wrap).toBe("soft");

    command.value = "filter {copy_string_clipboard}\n--verbose";
    command.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".pf-ok")!.click();
    await expect(result).resolves.toEqual(["Filter", "filter {copy_string_clipboard}\n--verbose"]);
  });
});
