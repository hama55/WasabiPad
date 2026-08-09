export const CUSTOM_DELIMITER_VALUE = "__custom__";

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
