export const CUSTOM_DELIMITER_VALUE = "__custom__";
export const DEFAULT_CSV_DELIMITER = ",";

// Keep single delimiters compatible with existing preview payloads.
export function encodeCsvDelimiters(values: string[]): string {
  return values.length > 1 ? "\n" + JSON.stringify(values) : values[0] ?? "";
}

export function csvDelimiterOptions(value: string): string[] {
  if (!value) return [];
  if (!value.startsWith("\n")) return [value];
  try {
    const values: unknown = JSON.parse(value.slice(1));
    return Array.isArray(values) ? values.filter((item): item is string =>
      typeof item === "string" && item.length > 0 && !/[\r\n"]/.test(item)) : [];
  } catch {
    return [];
  }
}

export const CSV_DELIMITER_OPTIONS = [
  { value: ",", label: ",（カンマ）" },
  { value: "\\t", label: "\\t=タブ" },
  { value: ";", label: ";（セミコロン）" },
  { value: "|", label: "|（パイプ）" },
] as const;

export function delimiterPresetFor(value: string): string {
  const normalized = value === "\t" ? "\\t" : value;
  return CSV_DELIMITER_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : CUSTOM_DELIMITER_VALUE;
}
