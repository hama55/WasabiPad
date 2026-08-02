// 登録コマンドのメニュー操作を、フォルダビューとタブバーで共有する。
import type * as api from "./api";
import { basename } from "./path";
import type { MenuItem } from "./menu";
import type { promptFields } from "./prompt";
import {
  addRegisteredCommand,
  commandLineForFile,
  commandsForPath,
  COMMAND_PREFIX_FIELD_LABEL,
  DEFAULT_COMMAND_PREFIX,
  extensionOf,
  removeRegisteredCommand,
  updateRegisteredCommand,
  type RegisteredCommand,
} from "./registered-commands";

export interface RegisteredCommandMenuPorts {
  promptFields: typeof promptFields;
  runExternalCommand: typeof api.runExternalCommand;
}

export interface RegisteredCommandMenuServices extends RegisteredCommandMenuPorts {
  run: (title: string, operation: () => void | Promise<unknown>) => void;
}

type RegisteredCommandValues = Pick<RegisteredCommand, "label" | "prefix" | "command">;

function promptCommand(
  services: RegisteredCommandMenuServices,
  title: string,
  path: string,
  initial?: RegisteredCommandValues,
): Promise<RegisteredCommandValues | null> {
  const extension = extensionOf(path);
  const extensionLabel = extension || "拡張子なし";
  return services.promptFields(title, [
    {
      label: `表示名（${extensionLabel}用）`,
      value: initial?.label ?? basename(path),
      validate: (value) => value.trim() ? null : "表示名を入力してください",
    },
    {
      label: COMMAND_PREFIX_FIELD_LABEL,
      value: initial?.prefix ?? DEFAULT_COMMAND_PREFIX,
      validate: () => null,
    },
    {
      label: "コマンド（{file}=対象ファイル、引用符不要）",
      value: initial?.command ?? "",
      validate: (value) => value.trim() ? null : "コマンドを入力してください",
    },
  ], {
    preview: {
      label: "実行文字列（確認用）",
      render: (values) => commandLineForFile(values[1] ?? "", values[2] ?? "", path),
    },
  }).then((values) => values ? { label: values[0], prefix: values[1], command: values[2] } : null);
}

async function registerCommand(services: RegisteredCommandMenuServices, path: string) {
  const result = await promptCommand(services, "コマンドを登録", path);
  if (!result) return;
  addRegisteredCommand({ extension: extensionOf(path), ...result });
}

async function editCommand(
  services: RegisteredCommandMenuServices,
  command: RegisteredCommand,
  path: string,
) {
  const result = await promptCommand(services, "登録コマンドを編集", path, command);
  if (!result) return;
  updateRegisteredCommand(command, result);
}

export function createRegisteredCommandMenu(
  path: string,
  services: RegisteredCommandMenuServices,
): MenuItem {
  const commands = commandsForPath(path);
  const register: MenuItem = {
    label: "コマンドを登録...",
    action: () => services.run("コマンドを登録できませんでした", () => registerCommand(services, path)),
  };
  if (commands.length === 0) return register;
  return {
    label: "登録コマンド",
    sub: [
      ...commands.map((command) => ({
        label: command.label,
        action: () => services.run(
          "登録コマンドを実行できませんでした",
          () => services.runExternalCommand(commandLineForFile(command.prefix, command.command, path), path),
        ),
        trailing: [
          {
            label: "⚙",
            title: "このコマンドを編集",
            action: () => services.run(
              "登録コマンドを編集できませんでした",
              () => editCommand(services, command, path),
            ),
          },
          {
            label: "×",
            title: "このコマンドの登録を解除",
            action: () => services.run(
              "登録コマンドを解除できませんでした",
              () => removeRegisteredCommand(command),
            ),
          },
        ],
      })),
      { ...register, sep: true },
    ],
  };
}
