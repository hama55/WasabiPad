// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
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
});
