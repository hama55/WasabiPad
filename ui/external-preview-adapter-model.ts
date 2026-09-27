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

function parseAdapter(value: unknown): ExternalPreviewAdapter | null {
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
  return extensions.length > 0 ? {
    extensions,
    command: value.command,
    args: value.args,
    outputFormat: value.outputFormat,
    preferExternal: value.preferExternal,
  } : null;
}

export function parseExternalPreviewAdapters(value: unknown): ExternalPreviewAdapter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const adapter = parseAdapter(item);
    return adapter ? [adapter] : [];
  });
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
