import { formatFontFamily } from "./format";
import { promptFields } from "./prompt";

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 72;

export const FONT_FAMILIES = [
  "Consolas, \"MS Gothic\", monospace",
  "Cascadia Mono, \"MS Gothic\", monospace",
  "\"MS Gothic\", monospace",
  "\"Yu Gothic UI\", sans-serif",
  "Meiryo, sans-serif",
  "\"BIZ UDPGothic\", sans-serif",
];

export async function promptFontFamily(current: string): Promise<string | null> {
  const options = FONT_FAMILIES.map((value) => ({ label: formatFontFamily(value), value }));
  if (!options.some((option) => option.value === current)) {
    options.unshift({ label: formatFontFamily(current), value: current });
  }
  const result = await promptFields("フォント", [{ label: "フォント", value: current, options }]);
  return result?.[0].trim() || null;
}

export async function promptFontSize(current: number): Promise<number | null> {
  const result = await promptFields("フォントサイズ", [
    { label: `サイズ (${MIN_FONT_SIZE}〜${MAX_FONT_SIZE}px)`, value: String(current) },
  ]);
  const size = Number(result?.[0]);
  return Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE ? size : null;
}

export function clampFontSize(size: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
}
