// 外部コマンドの永続化、対象値の置換。
import { getSetting, setSetting } from "./settings";
import {
  DEFAULT_COMMAND_VALUE_KIND,
  commandValueKind,
  normalizeRegisteredCommand,
  type CommandValueKind,
  type RegisteredCommand,
  type RegisteredCommandInput,
} from "./registered-command-model";

export { DEFAULT_COMMAND_VALUE_KIND, type CommandValueKind, type RegisteredCommand };

export const COMMAND_VALUE_TARGETS = {
  file: { placeholder: "{file}", label: "対象ファイル" },
  string: { placeholder: "{string}", label: "対象文字列" },
} as const;
export const STRING_IN_URL_PLACEHOLDER = "{string_in_url}";
export const STRING_ONE_LINE_PLACEHOLDER = "{string_one_line}";
export const COPY_STRING_CLIPBOARD_PLACEHOLDER = "{copy_string_clipboard}";

const STRING_PLACEHOLDER_PATTERN = /\{(?:string_in_url|string_one_line|copy_string_clipboard|string)\}/g;
const SHELL_METACHAR_PATTERN = /[&|<>^%"\r\n]/;

export function isShellCommandTemplate(prefix: string, command: string): boolean {
  const combined = [prefix.trim(), command.trim()].filter(Boolean).join(" ");
  if (!combined) return false;
  let token = "";
  if (combined.startsWith('"')) {
    const close = combined.indexOf('"', 1);
    token = close > 0 ? combined.slice(1, close) : combined.slice(1);
  } else {
    token = combined.split(/\s+/, 1)[0] ?? "";
  }
  const base = token.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  return base === "cmd"
    || base === "cmd.exe"
    || base === "powershell"
    || base === "powershell.exe"
    || base === "pwsh"
    || base === "pwsh.exe"
    || base.endsWith(".bat")
    || base.endsWith(".cmd");
}

export function commandRequiresShellConfirmation(
  prefix: string,
  command: string,
  value: string,
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
): boolean {
  if (!isShellCommandTemplate(prefix, command)) return false;
  const trimmed = command.trim();
  if (kind === "file") {
    return trimmed.includes(COMMAND_VALUE_TARGETS.file.placeholder) && SHELL_METACHAR_PATTERN.test(value);
  }
  const usesRawString = trimmed.includes(COMMAND_VALUE_TARGETS.string.placeholder);
  const usesOneLine = trimmed.includes(STRING_ONE_LINE_PLACEHOLDER);
  if (usesRawString && SHELL_METACHAR_PATTERN.test(value)) return true;
  if (usesOneLine && SHELL_METACHAR_PATTERN.test(value.replace(/\r\n|\r|\n/g, " "))) return true;
  return false;
}

export function commandLineForValue(
  prefix: string,
  command: string,
  value: string,
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
): string {
  const trimmed = command.trim();
  const commandWithValue = kind === "string"
    ? trimmed.replace(STRING_PLACEHOLDER_PATTERN, (token) => {
      if (token === STRING_IN_URL_PLACEHOLDER) return encodeURIComponent(value);
      if (token === STRING_ONE_LINE_PLACEHOLDER) return value.replace(/\r\n|\r|\n/g, " ");
      if (token === COPY_STRING_CLIPBOARD_PLACEHOLDER) return "";
      return value;
    })
    : trimmed.replaceAll(COMMAND_VALUE_TARGETS.file.placeholder, () => value);
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

export function commandsForKind(
  kind: CommandValueKind = DEFAULT_COMMAND_VALUE_KIND,
): RegisteredCommand[] {
  return getSetting("registeredCommands").filter((command) =>
    commandValueKind(command) === kind
  );
}

export function addRegisteredCommand(command: RegisteredCommandInput): void {
  const normalized = normalizeRegisteredCommand(command);
  if (!normalized.label || !normalized.command) return;
  const commands = getSetting("registeredCommands");
  if (commands.some((item) => sameRegisteredCommand(item, normalized))) return;
  setSetting("registeredCommands", [...commands, normalized]);
}

function sameRegisteredCommand(a: RegisteredCommand, b: RegisteredCommand): boolean {
  return a.label === b.label
    && a.prefix === b.prefix
    && a.command === b.command
    && commandValueKind(a) === commandValueKind(b);
}

export function updateRegisteredCommands(
  commands: readonly RegisteredCommand[],
  previous: RegisteredCommand,
  changes: Pick<RegisteredCommand, "label" | "prefix" | "command">,
): RegisteredCommand[] | null {
  const updated = normalizeRegisteredCommand({ ...previous, ...changes });
  if (!updated.label || !updated.command) return null;
  const index = commands.indexOf(previous);
  if (index < 0) return null;
  if (commands.some((item, itemIndex) => itemIndex !== index && sameRegisteredCommand(item, updated))) return null;
  const next = [...commands];
  next[index] = updated;
  return next;
}

export function updateRegisteredCommand(
  previous: RegisteredCommand,
  changes: Pick<RegisteredCommand, "label" | "prefix" | "command">,
): void {
  const commands = getSetting("registeredCommands");
  const next = updateRegisteredCommands(commands, previous, changes);
  if (next) setSetting("registeredCommands", next);
}

export function removeRegisteredCommand(command: RegisteredCommand): void {
  setSetting("registeredCommands", getSetting("registeredCommands").filter((item) =>
    item.label !== command.label
    || item.prefix !== command.prefix
    || item.command !== command.command
    || commandValueKind(item) !== commandValueKind(command)));
}
