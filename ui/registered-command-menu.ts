// 登録コマンドのメニュー操作を、メモビュー・フォルダビュー・タブバーで共有する。
import type * as api from "./api";
import { basename } from "./path";
import type { MenuItem } from "./menu";
import { MENU_ICON } from "./menu-icons";
import type { promptFields } from "./prompt";
import {
  addRegisteredCommand,
  COMMAND_VALUE_TARGETS,
  commandLineForValueWithClipboard,
  commandLineForValue,
  commandsForPath,
  COPY_STRING_CLIPBOARD_PLACEHOLDER,
  extensionOf,
  removeRegisteredCommand,
  STRING_ONE_LINE_PLACEHOLDER,
  STRING_IN_URL_PLACEHOLDER,
  updateRegisteredCommand,
  type CommandValueKind,
  type RegisteredCommand,
} from "./registered-commands";
import { commandValueKind } from "./registered-command-model";
import { flushSettings } from "./settings";

export interface RegisteredCommandMenuPorts {
  promptFields: typeof promptFields;
  runExternalCommand: typeof api.runExternalCommand;
  writeClipboardText?: (text: string) => Promise<void>;
}

export interface RegisteredCommandMenuServices extends RegisteredCommandMenuPorts {
  run: (title: string, operation: () => void | Promise<unknown>) => void;
}

export interface RegisteredCommandTarget {
  path: string;
  value?: string | (() => string | Promise<string>);
  valueKind?: CommandValueKind;
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
  const valueTarget = COMMAND_VALUE_TARGETS[commandValueKind(target)];
  const commandHelp = commandValueKind(target) === "string"
    ? `${valueTarget.placeholder}=${valueTarget.label}、${STRING_ONE_LINE_PLACEHOLDER}=改行をスペース化、${COPY_STRING_CLIPBOARD_PLACEHOLDER}=クリップボードへコピー、${STRING_IN_URL_PLACEHOLDER}=URL用エンコード文字列、引用符不要`
    : `${valueTarget.placeholder}=${valueTarget.label}、引用符不要`;
  return services.promptFields(title, [
    {
      label: `表示名（${extensionLabel}用）`,
      value: initial?.label ?? basename(path),
      validate: (value) => value.trim() ? null : "表示名を入力してください",
    },
    {
      label: `コマンド（${commandHelp}）`,
      value: initial ? [initial.prefix, initial.command].filter(Boolean).join(" ") : "",
      multiline: true,
      validate: (value) => value.trim() ? null : "コマンドを入力してください",
    },
  ], {
    preview: {
      label: "実行文字列（確認用）",
      render: (values) => commandLineForValue(
        "",
        values[1] ?? "",
        value,
        commandValueKind(target),
      ),
    },
  }).then((values) => values ? { label: values[0], prefix: "", command: values[1] } : null);
}

async function registerCommand(services: RegisteredCommandMenuServices, target: RegisteredCommandTarget) {
  const result = await promptCommand(services, "コマンドを登録", target);
  if (!result) return;
  addRegisteredCommand({ extension: extensionOf(target.path), valueKind: commandValueKind(target), ...result });
  await flushSettings();
}

async function editCommand(
  services: RegisteredCommandMenuServices,
  command: RegisteredCommand,
  target: RegisteredCommandTarget,
) {
  const result = await promptCommand(services, "登録コマンドを編集", target, command);
  if (!result) return;
  updateRegisteredCommand(command, result);
  await flushSettings();
}

export function createRegisteredCommandMenu(
  input: string | RegisteredCommandTarget,
  services: RegisteredCommandMenuServices,
): MenuItem {
  const target = targetOf(input);
  const commands = commandsForPath(target.path, commandValueKind(target));
  const register: MenuItem = {
    label: "コマンドを登録...",
    iconClass: MENU_ICON.command,
    action: () => services.run(
      "コマンドを登録できませんでした",
      () => registerCommand(services, target),
    ),
  };
  if (commands.length === 0) return register;
  return {
    label: "登録コマンド",
    iconClass: MENU_ICON.command,
    sub: [
      ...commands.map((command) => ({
        label: command.label,
        iconClass: MENU_ICON.command,
        action: () => services.run(
          "登録コマンドを実行できませんでした",
          async () => services.runExternalCommand(
            await commandLineForValueWithClipboard(
              command.prefix,
              command.command,
              await valueOf(target),
              commandValueKind(target),
              services.writeClipboardText,
            ),
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
              async () => {
                removeRegisteredCommand(command);
                await flushSettings();
              },
            ),
          },
        ],
      })),
      { ...register, sep: true },
    ],
  };
}
