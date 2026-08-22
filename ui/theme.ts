export const THEME_STORAGE_KEY = "theme";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = { dark: "ダーク", light: "ライト" };

export function normalizeTheme(value: string | null): Theme {
  return value === "light" ? "light" : "dark";
}
