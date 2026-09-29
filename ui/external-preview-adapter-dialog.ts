import {
  externalPreviewAdapterName,
  normalizeExternalPreviewAdapter,
  parseExternalPreviewArguments,
  splitExternalPreviewCommandLine,
  type ExternalPreviewAdapter,
} from "./external-preview-adapter-model";
import { promptFields } from "./prompt";

export interface ExternalPreviewAdapterDialogPorts {
  promptFields: typeof promptFields;
}

export async function promptExternalPreviewAdapter(
  ports: ExternalPreviewAdapterDialogPorts,
  initial?: ExternalPreviewAdapter,
): Promise<ExternalPreviewAdapter | null> {
  const result = await ports.promptFields(
    initial ? "外部プレビューを編集" : "外部プレビューを追加",
    [
      {
        label: "プレビュー名",
        value: initial ? externalPreviewAdapterName(initial) : "",
        validate: (value) => value.trim() ? null : "プレビュー名を入力してください",
      },
      {
        label: "拡張子（カンマ区切り）",
        value: initial?.extensions.map((extension) => `.${extension}`).join(", ") ?? "",
        validate: (value) => normalizeExtensions(value).length ? null : "拡張子を1つ以上入力してください",
      },
      {
        label: "実行コマンド（実行ファイルと引数。{file} と {output} を使用）",
        value: initial ? commandLineForEditing(initial.command, initial.args) : "renderer {file} {output}",
        multiline: true,
        validate: validateCommandLine,
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
          { label: "外部プレビューを優先", value: "external" },
        ],
      },
    ] satisfies Parameters<ExternalPreviewAdapterDialogPorts["promptFields"]>[1],
    {
      preview: {
        label: "実行文字列（確認用）",
        render: (values) => previewCommandLine(values[2] ?? "", values[3] ?? "html"),
      },
    },
  );
  if (!result) return null;
  const name = result[0]?.trim();
  if (!name) return null;
  const commandLine = splitExternalPreviewCommandLine(result[2]);
  return normalizeExternalPreviewAdapter({
    id: initial?.id ?? crypto.randomUUID(),
    name,
    extensions: normalizeExtensions(result[1]),
    command: commandLine.command,
    args: commandLine.args,
    outputFormat: result[3],
    preferExternal: result[4] === "external",
  });
}

function commandLineForEditing(command: string, args: string): string {
  const executable = /\s/.test(command) ? `"${command}"` : command;
  return `${executable} ${args}`.trim();
}

function validateCommandLine(value: string): string | null {
  let commandLine: ReturnType<typeof splitExternalPreviewCommandLine>;
  try {
    commandLine = splitExternalPreviewCommandLine(value);
  } catch (error) {
    return error instanceof Error ? error.message : "実行コマンドを解釈できません";
  }
  return validateArguments(commandLine.args);
}

function previewCommandLine(value: string, outputFormat: string): string {
  try {
    const { command, args } = splitExternalPreviewCommandLine(value);
    const outputPath = "C:\\preview files\\preview." + (outputFormat === "svg" ? "svg" : "html");
    const previewArgs = parseExternalPreviewArguments(args).map((argument) => argument
      .replaceAll("{file}", "C:\\preview files\\sample.abc")
      .replaceAll("{output}", outputPath));
    return [formatArgument(command), ...previewArgs.map(formatArgument)].join(" ");
  } catch {
    return value;
  }
}

function formatArgument(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
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

function normalizeExtensions(value: string): string[] {
  return [...new Set(value.split(",")
    .map((extension) => extension.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean))];
}
