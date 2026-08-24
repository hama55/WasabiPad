export type CommandValueKind = "file" | "string";
export const DEFAULT_COMMAND_VALUE_KIND: CommandValueKind = "file";

export interface RegisteredCommand {
  label: string;
  prefix: string;
  command: string;
  valueKind?: CommandValueKind;
}

export interface RegisteredCommandInput {
  // 旧設定に残った拡張子は読み込めるが、現在の登録単位には使わない。
  extension?: unknown;
  label: string;
  prefix?: unknown;
  command: string;
  valueKind?: unknown;
}

export function commandValueKind(command: Pick<RegisteredCommand, "valueKind">): CommandValueKind {
  return command.valueKind ?? DEFAULT_COMMAND_VALUE_KIND;
}

export function normalizeExtension(extension: string): string {
  const value = extension.trim().toLowerCase();
  if (!value) return "";
  return value.startsWith(".") ? value : `.${value}`;
}

export function normalizeRegisteredCommand(command: RegisteredCommandInput): RegisteredCommand {
  const normalized: RegisteredCommand = {
    label: command.label.trim(),
    prefix: typeof command.prefix === "string" ? command.prefix.trim() : "",
    command: command.command.trim(),
  };
  if (command.valueKind === "string") normalized.valueKind = "string";
  return normalized;
}

export function isRegisteredCommand(value: unknown): value is RegisteredCommandInput {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Partial<RegisteredCommandInput>;
  return typeof command.label === "string"
    && command.label.trim().length > 0
    && typeof command.command === "string"
    && command.command.trim().length > 0
    && (command.valueKind === undefined || command.valueKind === "file" || command.valueKind === "string");
}
