export interface EditorConfig {
  fontFamily: string;
  fontSize: number;
  lineHeightExtra: number;
  paddingLeft: number;
  gutterWidth: number;
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  fontFamily: "Consolas, \"MS Gothic\", monospace",
  fontSize: 14,
  lineHeightExtra: 6,
  paddingLeft: 8,
  gutterWidth: 60,
};
