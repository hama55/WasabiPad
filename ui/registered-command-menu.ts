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
  commandsForKind,
  COPY_STRING_CLIPBOARD_PLACEHOLDER,
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

export type RegisteredCommandValues = Pick<RegisteredCommand, "label" | "prefix" | "command">;

export async function saveRegisteredCommand(
  kind: CommandValueKind,
  value: RegisteredCommandValues,
  previous?: RegisteredCommand,
): Promise<void> {
  if (previous === undefined) addRegisteredCommand({ valueKind: kind, ...value });
  else updateRegisteredCommand(previous, value);
  await flushSettings();
}

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
  services: RegisteredCommandMenuPorts,
  title: string,
  target: RegisteredCommandTarget,
  value: string | undefined,
  initial?: RegisteredCommandValues,
  defaultLabel = basename(target.path),
): Promise<RegisteredCommandValues | null> {
  const valueTarget = COMMAND_VALUE_TARGETS[commandValueKind(target)];
  const commandHelp = commandValueKind(target) === "string"
    ? `${valueTarget.placeholder}=${valueTarget.label}、${STRING_ONE_LINE_PLACEHOLDER}=改行をスペース化、${COPY_STRING_CLIPBOARD_PLACEHOLDER}=クリップボードへコピー、${STRING_IN_URL_PLACEHOLDER}=URL用エンコード文字列、引用符不要`
    : `${valueTarget.placeholder}=${valueTarget.label}、引用符不要`;
  const options = value === undefined ? undefined : {
    preview: {
      label: "実行文字列（確認用）",
      render: (values: string[]) => commandLineForValue(
        "",
        values[1] ?? "",
        value,
        commandValueKind(target),
      ),
    },
  };
  return services.promptFields(title, [
    {
      label: "表示名",
      value: initial?.label ?? defaultLabel,
      validate: (value) => value.trim() ? null : "表示名を入力してください",
    },
    {
      label: `コマンド（${commandHelp}）`,
      value: initial ? [initial.prefix, initial.command].filter(Boolean).join(" ") : "",
      multiline: true,
      validate: (value) => value.trim() ? null : "コマンドを入力してください",
    },
  ], options).then((values) => values ? { label: values[0], prefix: "", command: values[1] } : null);
}

export function promptRegisteredCommand(
  ports: RegisteredCommandMenuPorts,
  title: string,
  kind: CommandValueKind,
  initial?: RegisteredCommandValues,
): Promise<RegisteredCommandValues | null> {
  return promptCommandWithValue(
    ports,
    title,
    { path: "", valueKind: kind },
    undefined,
    initial,
    kind === "file" ? "ファイル用コマンド" : "文字列用コマンド",
  );
}

async function registerCommand(services: RegisteredCommandMenuServices, target: RegisteredCommandTarget) {
  const result = await promptCommand(services, "コマンドを登録", target);
  if (!result) return;
  await saveRegisteredCommand(commandValueKind(target), result);
}

async function editCommand(
  services: RegisteredCommandMenuServices,
  command: RegisteredCommand,
  target: RegisteredCommandTarget,
) {
  const result = await promptCommand(services, "登録コマンドを編集", target, command);
  if (!result) return;
  await saveRegisteredCommand(commandValueKind(target), result, command);
}

export function createRegisteredCommandMenu(
  input: string | RegisteredCommandTarget,
  services: RegisteredCommandMenuServices,
): MenuItem {
  const target = targetOf(input);
  const commands = commandsForKind(commandValueKind(target));
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
