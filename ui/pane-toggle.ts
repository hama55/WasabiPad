const CHEVRON_LEFT = "\uE76B";
const CHEVRON_RIGHT = "\uE76C";
const PREVIEW_TOGGLE_RIGHT_INSET = 16;

export type PaneToggleKind = "sidebar" | "preview";

export function paneToggleView(kind: PaneToggleKind, shown: boolean) {
  const closing = kind === "sidebar" ? "フォルダビューを閉じる" : "プレビューを閉じる";
  const opening = kind === "sidebar" ? "フォルダビューを開く" : "プレビューを開く";
  const icon = kind === "sidebar"
    ? (shown ? CHEVRON_LEFT : CHEVRON_RIGHT)
    : (shown ? CHEVRON_RIGHT : CHEVRON_LEFT);
  return { icon, title: shown ? closing : opening };
}

export function sidebarToggleLeft(shown: boolean, sidebarWidth: number): number {
  return shown ? Math.max(4, sidebarWidth - 32) : 4;
}

export function previewToggleLeft(
  shown: boolean,
  mainLeft: number,
  previewLeft: number,
  mainWidth: number,
  buttonWidth: number,
): number {
  return Math.max(4, shown ? previewLeft - mainLeft : mainWidth - buttonWidth - PREVIEW_TOGGLE_RIGHT_INSET);
}
