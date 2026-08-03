// 登録コマンドのメニュー操作を、メモビュー・フォルダビュー・タブバーで共有する。
import type * as api from "./api";
import { basename } from "./path";
import type { MenuItem } from "./menu";
import type { promptFields } from "./prompt";
import {
  addRegisteredCommand,
  commandLineForValue,
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

export interface RegisteredCommandTarget {
  path: string;
  value?: string | (() => string | Promise<string>);
  variableLabel?: string;
}

type RegisteredCommandValues = Pick<RegisteredCommand, "label" | "prefix" | "command">;

function targetOf(target: string | RegisteredCommandTarget): RegisteredCommandTarget {
  return typeof target === "string" ? { path: target } : target;
}

function valueOf(target: RegisteredCommandTarget): string | Promise<string> {
  if (typeof target.value === "function") return target.value();
  return target.value ?? target.path;
}

function promptCommand(
  services: RegisteredCommandMenuServices,
  title: string,
  target: RegisteredCommandTarget,
  initial?: RegisteredCommandValues,
): Promise<RegisteredCommandValues | null> {
  const value = valueOf(target);
  if (typeof value === "string") return promptCommandWithValue(services, title, target, value, initial);
  return value.then((resolved) => promptCommandWithValue(services, title, target, resolved, initial));
}

function promptCommandWithValue(
  services: RegisteredCommandMenuServices,
  title: string,
  target: RegisteredCommandTarget,
  value: string,
  initial?: RegisteredCommandValues,
): Promise<RegisteredCommandValues | null> {
  const path = target.path;
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
      label: `コマンド（{file}=${target.variableLabel ?? "対象ファイル"}、引用符不要）`,
      value: initial?.command ?? "",
      validate: (value) => value.trim() ? null : "コマンドを入力してください",
    },
  ], {
    preview: {
      label: "実行文字列（確認用）",
      render: (values) => commandLineForValue(values[1] ?? "", values[2] ?? "", value),
    },
  }).then((values) => values ? { label: values[0], prefix: values[1], command: values[2] } : null);
}

async function registerCommand(services: RegisteredCommandMenuServices, target: RegisteredCommandTarget) {
  const result = await promptCommand(services, "コマンドを登録", target);
  if (!result) return;
  addRegisteredCommand({ extension: extensionOf(target.path), ...result });
}

async function editCommand(
  services: RegisteredCommandMenuServices,
  command: RegisteredCommand,
  target: RegisteredCommandTarget,
) {
  const result = await promptCommand(services, "登録コマンドを編集", target, command);
  if (!result) return;
  updateRegisteredCommand(command, result);
}

export function createRegisteredCommandMenu(
  input: string | RegisteredCommandTarget,
  services: RegisteredCommandMenuServices,
): MenuItem {
  const target = targetOf(input);
  const commands = commandsForPath(target.path);
  const register: MenuItem = {
    label: "コマンドを登録...",
    action: () => services.run(
      "コマンドを登録できませんでした",
      () => registerCommand(services, target),
    ),
  };
  if (commands.length === 0) return register;
  return {
    label: "登録コマンド",
    sub: [
      ...commands.map((command) => ({
        label: command.label,
        action: () => services.run(
          "登録コマンドを実行できませんでした",
          async () => services.runExternalCommand(
            commandLineForValue(command.prefix, command.command, await valueOf(target)),
            target.path,
          ),
        ),
        trailing: [
          {
            label: "⚙",
            title: "このコマンドを編集",
            action: () => services.run(
              "登録コマンドを編集できませんでした",
              () => editCommand(services, command, target),
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
