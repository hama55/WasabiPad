export const THEME_STORAGE_KEY = "theme";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export function normalizeTheme(value: string | null): Theme {
  return value === "light" ? "light" : "dark";
}
