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

export const DEFAULT_COMMAND_PREFIX = "";
export const COMMAND_PREFIX_FIELD_LABEL = "プレフィックス（任意。必要時の例: cmd.exe /D /C）";
export const COMMAND_VALUE_TARGETS = {
  file: { placeholder: "{file}", label: "対象ファイル" },
  string: { placeholder: "{string}", label: "対象文字列" },
} as const;

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
  const commandWithValue = command.trim().replaceAll(
    COMMAND_VALUE_TARGETS[kind].placeholder,
    () => quoteCommandValue(value),
  );
  return [prefix.trim(), commandWithValue].filter(Boolean).join(" ");
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

// CreateProcessWには生のコマンドラインを渡すため、Windowsの引数解析で
// 引用符と末尾バックスラッシュが値の一部として残るようエスケープする。
function quoteCommandValue(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
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
