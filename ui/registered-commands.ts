// 外部コマンドの永続化、拡張子判定、対象値の置換。
import { getSetting, setSetting } from "./settings";
import {
  DEFAULT_COMMAND_VALUE_KIND,
  commandValueKind,
  normalizeExtension,
  normalizeRegisteredCommand,
  type CommandValueKind,
  type RegisteredCommand,
} from "./registered-command-model";

export { DEFAULT_COMMAND_VALUE_KIND, type CommandValueKind, type RegisteredCommand };

export const COMMAND_VALUE_TARGETS = {
  file: { placeholder: "{file}", label: "対象ファイル" },
  string: { placeholder: "{string}", label: "対象文字列" },
} as const;
export const STRING_IN_URL_PLACEHOLDER = "{string_in_url}";
export const STRING_ONE_LINE_PLACEHOLDER = "{string_one_line}";
export const COPY_STRING_CLIPBOARD_PLACEHOLDER = "{copy_string_clipboard}";

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function commandLineForValue(
  prefix: string,
  command: string,
  value: string,
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
): string {
  let commandWithValue = command.trim();
  if (kind === "string") {
    commandWithValue = commandWithValue.replaceAll(
      STRING_IN_URL_PLACEHOLDER,
      () => encodeURIComponent(value),
    );
    commandWithValue = commandWithValue.replaceAll(
      STRING_ONE_LINE_PLACEHOLDER,
      () => value.replace(/\r\n|\r|\n/g, " "),
    );
    commandWithValue = commandWithValue.replaceAll(COPY_STRING_CLIPBOARD_PLACEHOLDER, "");
  }
  commandWithValue = commandWithValue.replaceAll(
    COMMAND_VALUE_TARGETS[kind].placeholder,
    () => value,
  );
  return [prefix.trim(), commandWithValue].filter(Boolean).join(" ");
}

export async function commandLineForValueWithClipboard(
  prefix: string,
  command: string,
  value: string,
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
  writeClipboardText?: (text: string) => Promise<void>,
): Promise<string> {
  if (kind === "string" && command.includes(COPY_STRING_CLIPBOARD_PLACEHOLDER)) {
    if (!writeClipboardText) throw new Error("クリップボードへコピーできません");
    await writeClipboardText(value);
  }
  return commandLineForValue(prefix, command, value, kind);
}

export function commandLineForFile(prefix: string, command: string, path: string): string {
  return commandLineForValue(prefix, command, path, "file");
}

export function commandsForPath(
  path: string,
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
): RegisteredCommand[] {
  const extension = extensionOf(path);
  return getSetting("registeredCommands").filter((command) =>
    normalizeExtension(command.extension) === extension && commandValueKind(command) === kind
  );
}

export function addRegisteredCommand(command: RegisteredCommand): void {
  const normalized = normalizeRegisteredCommand(command);
  if (!normalized.label || !normalized.command) return;
  const commands = getSetting("registeredCommands");
  if (commands.some((item) => item.extension === normalized.extension
    && item.label === normalized.label
    && item.prefix === normalized.prefix
    && item.command === normalized.command
    && commandValueKind(item) === commandValueKind(normalized))) return;
  setSetting("registeredCommands", [...commands, normalized]);
}

export function updateRegisteredCommand(
  previous: RegisteredCommand,
  changes: Pick<RegisteredCommand, "label" | "prefix" | "command">,
): void {
  const updated = normalizeRegisteredCommand({ ...previous, ...changes });
  if (!updated.label || !updated.command) return;
  const commands = getSetting("registeredCommands");
  const index = commands.indexOf(previous);
  if (index < 0) return;
  if (commands.some((item, itemIndex) => itemIndex !== index
    && item.extension === updated.extension
    && item.label === updated.label
    && item.prefix === updated.prefix
    && item.command === updated.command
    && commandValueKind(item) === commandValueKind(updated))) return;
  const next = [...commands];
  next[index] = updated;
  setSetting("registeredCommands", next);
}

export function removeRegisteredCommand(command: RegisteredCommand): void {
  setSetting("registeredCommands", getSetting("registeredCommands").filter((item) =>
    item.extension !== command.extension
    || item.label !== command.label
    || item.prefix !== command.prefix
    || item.command !== command.command
    || commandValueKind(item) !== commandValueKind(command)));
}
