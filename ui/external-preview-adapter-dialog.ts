import { parseExternalPreviewArguments, normalizeExternalPreviewAdapter, type ExternalPreviewAdapter } from "./external-preview-adapter-model";
import { promptFields } from "./prompt";

export interface ExternalPreviewAdapterDialogPorts {
  promptFields: typeof promptFields;
}

export async function promptExternalPreviewAdapter(
  ports: ExternalPreviewAdapterDialogPorts,
  initial?: ExternalPreviewAdapter,
): Promise<ExternalPreviewAdapter | null> {
  const result = await ports.promptFields(
    initial ? "外部プレビューアダプタを編集" : "外部プレビューアダプタを追加",
    [
      {
        label: "拡張子（カンマ区切り）",
        value: initial?.extensions.map((extension) => `.${extension}`).join(", ") ?? "",
        validate: (value) => normalizeExtensions(value).length ? null : "拡張子を1つ以上入力してください",
      },
      {
        label: "実行プログラム（絶対パスまたはPATH）",
        value: initial?.command ?? "",
        validate: (value) => value.trim() ? null : "実行プログラムを入力してください",
      },
      {
        label: "引数（{file} と {output} を使用）",
        value: initial?.args ?? "{file} {output}",
        multiline: true,
        validate: validateArguments,
      },
      {
        label: "生成物",
        value: initial?.outputFormat ?? "html",
        options: [
          { label: "HTML（JavaScript可）", value: "html" },
          { label: "SVG", value: "svg" },
        ],
      },
      {
        label: "標準プレビューとの優先順位",
        value: initial?.preferExternal ? "external" : "standard",
        options: [
          { label: "標準プレビューを優先", value: "standard" },
          { label: "外部アダプタを優先", value: "external" },
        ],
      },
    ] satisfies Parameters<ExternalPreviewAdapterDialogPorts["promptFields"]>[1],
  );
  if (!result) return null;
  return normalizeExternalPreviewAdapter({
    extensions: normalizeExtensions(result[0]),
    command: result[1].trim(),
    args: result[2],
    outputFormat: result[3],
    preferExternal: result[4] === "external",
  });
}

function normalizeExtensions(value: string): string[] {
  return [...new Set(value.split(",")
    .map((extension) => extension.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean))];
}

function validateArguments(value: string): string | null {
  try {
    const args = parseExternalPreviewArguments(value);
    if (!args.includes("{file}") || !args.includes("{output}")) {
      return "引数に {file} と {output} を1つずつ含めてください";
    }
  } catch (error) {
    return error instanceof Error ? error.message : "引数を解釈できません";
  }
  return null;
}
