export type ExternalPreviewOutputFormat = "html" | "svg";

export interface ExternalPreviewAdapter {
  extensions: string[];
  command: string;
  args: string;
  outputFormat: ExternalPreviewOutputFormat;
  preferExternal: boolean;
}

export type PreviewSelection = "standard" | "external";

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\.+/, "").toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeExternalPreviewAdapter(value: unknown): ExternalPreviewAdapter | null {
  if (!isObject(value)
    || !Array.isArray(value.extensions)
    || typeof value.command !== "string"
    || typeof value.args !== "string"
    || (value.outputFormat !== "html" && value.outputFormat !== "svg")
    || typeof value.preferExternal !== "boolean") {
    return null;
  }

  const extensions = [...new Set(value.extensions
    .filter((extension): extension is string => typeof extension === "string")
    .map(normalizeExtension)
    .filter((extension) => extension.length > 0))];
  const command = value.command.trim();
  if (!command || extensions.length === 0) return null;
  let args: string[];
  try {
    args = parseExternalPreviewArguments(value.args);
  } catch {
    return null;
  }
  if (!args.includes("{file}") || !args.includes("{output}")) return null;
  return {
    extensions,
    command,
    args: value.args,
    outputFormat: value.outputFormat,
    preferExternal: value.preferExternal,
  };
}

export function parseExternalPreviewAdapters(value: unknown): ExternalPreviewAdapter[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.flatMap((item) => {
    const adapter = normalizeExternalPreviewAdapter(item);
    if (!adapter) return [];
    const extensions = adapter.extensions.filter((extension) => !used.has(extension));
    extensions.forEach((extension) => used.add(extension));
    return extensions.length ? [{ ...adapter, extensions }] : [];
  });
}

export function parseExternalPreviewArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === "\\" && value[index + 1] === '"') {
      current += '"';
      started = true;
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote !== null) throw new Error("外部プレビュー引数の引用符が閉じていません");
  if (started) args.push(current);
  return args;
}

function extensionOfPath(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > separator ? normalizeExtension(path.slice(dot + 1)) : "";
}

export function externalPreviewAdapterForPath(
  path: string,
  adapters: readonly ExternalPreviewAdapter[],
): ExternalPreviewAdapter | null {
  const extension = extensionOfPath(path);
  return adapters.find((adapter) => adapter.extensions.includes(extension)) ?? null;
}

export function previewSelectionForAdapter(
  adapter: ExternalPreviewAdapter | null,
  hasStandardPreview: boolean,
): PreviewSelection | null {
  if (!adapter) return hasStandardPreview ? "standard" : null;
  return hasStandardPreview && !adapter.preferExternal ? "standard" : "external";
}
