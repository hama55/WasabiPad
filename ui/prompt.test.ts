// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { promptFields } from "./prompt";

describe("promptFields", () => {
  beforeEach(() => document.body.replaceChildren());

  it("プレビューを初期表示し、入力変更に追随させる", async () => {
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
});
