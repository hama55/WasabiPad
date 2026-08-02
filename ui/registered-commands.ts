// フォルダビューから起動する外部コマンドの永続化と拡張子判定。
import { getSetting, setSetting, type RegisteredCommand } from "./settings";

export type { RegisteredCommand };

export const DEFAULT_COMMAND_PREFIX = "cmd.exe /D /C";
export const COMMAND_PREFIX_FIELD_LABEL = `プレフィックス（空欄可。例: ${DEFAULT_COMMAND_PREFIX}）`;

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function commandLineForFile(prefix: string, command: string, path: string): string {
  const commandWithFile = command.trim().replaceAll("{file}", `"${path}"`);
  return [prefix.trim(), commandWithFile].filter(Boolean).join(" ");
}

function normalizeExtension(extension: string): string {
  const value = extension.trim().toLowerCase();
  if (!value) return "";
  return value.startsWith(".") ? value : `.${value}`;
}

function normalizeCommand(command: RegisteredCommand): RegisteredCommand {
  return {
    extension: normalizeExtension(command.extension),
    label: command.label.trim(),
    prefix: command.prefix.trim(),
    command: command.command.trim(),
  };
}

export function commandsForPath(path: string): RegisteredCommand[] {
  const extension = extensionOf(path);
  return getSetting("registeredCommands").filter((command) => normalizeExtension(command.extension) === extension);
}

export function addRegisteredCommand(command: RegisteredCommand): void {
  const normalized = normalizeCommand(command);
  if (!normalized.label || !normalized.command) return;
  const commands = getSetting("registeredCommands");
  if (commands.some((item) => item.extension === normalized.extension
    && item.label === normalized.label
    && item.prefix === normalized.prefix
    && item.command === normalized.command)) return;
  setSetting("registeredCommands", [...commands, normalized]);
}

export function updateRegisteredCommand(
  previous: RegisteredCommand,
  changes: Pick<RegisteredCommand, "label" | "prefix" | "command">,
): void {
  const updated = normalizeCommand({ ...previous, ...changes });
  if (!updated.label || !updated.command) return;
  const commands = getSetting("registeredCommands");
  const index = commands.indexOf(previous);
  if (index < 0) return;
  if (commands.some((item, itemIndex) => itemIndex !== index
    && item.extension === updated.extension
    && item.label === updated.label
    && item.prefix === updated.prefix
    && item.command === updated.command)) return;
  const next = [...commands];
  next[index] = updated;
  setSetting("registeredCommands", next);
}

export function removeRegisteredCommand(command: RegisteredCommand): void {
  setSetting("registeredCommands", getSetting("registeredCommands").filter((item) =>
    item.extension !== command.extension
    || item.label !== command.label
    || item.prefix !== command.prefix
    || item.command !== command.command));
}
