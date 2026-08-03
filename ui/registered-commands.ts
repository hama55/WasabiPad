// 外部コマンドの永続化、拡張子判定、対象値の置換。
import { getSetting, setSetting } from "./settings";
import {
  normalizeExtension,
  normalizeRegisteredCommand,
  type RegisteredCommand,
} from "./registered-command-model";

export type { RegisteredCommand };

export const DEFAULT_COMMAND_PREFIX = "";
export const COMMAND_PREFIX_FIELD_LABEL = "プレフィックス（任意。必要時の例: cmd.exe /D /C）";

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function commandLineForValue(prefix: string, command: string, value: string): string {
  const commandWithValue = command.trim().replaceAll("{file}", `"${value}"`);
  return [prefix.trim(), commandWithValue].filter(Boolean).join(" ");
}

// 既存の呼び出し元との互換性を保ちながら、対象がファイルに限らないことを明示する。
export const commandLineForFile = commandLineForValue;

export function commandsForPath(path: string): RegisteredCommand[] {
  const extension = extensionOf(path);
  return getSetting("registeredCommands").filter((command) => normalizeExtension(command.extension) === extension);
}

export function addRegisteredCommand(command: RegisteredCommand): void {
  const normalized = normalizeRegisteredCommand(command);
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
  const updated = normalizeRegisteredCommand({ ...previous, ...changes });
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
