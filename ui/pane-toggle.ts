import { CHEVRON_LEFT, CHEVRON_RIGHT } from "./icon-button";

const PREVIEW_TOGGLE_RIGHT_INSET = 16;

export const PREVIEW_TOGGLE_DEFAULT_WIDTH = 28;

export type PaneToggleKind = "sidebar" | "preview";

export function paneToggleView(kind: PaneToggleKind, shown: boolean) {
  const closing = kind === "sidebar" ? "フォルダビューを閉じる" : "プレビューを閉じる";
  const opening = kind === "sidebar" ? "フォルダビューを開く" : "プレビューを開く";
  const icon = kind === "sidebar"
    ? (shown ? CHEVRON_LEFT : CHEVRON_RIGHT)
    : (shown ? CHEVRON_RIGHT : CHEVRON_LEFT);
  return { icon, title: shown ? closing : opening };
}

export function sidebarToggleLeft(
  shown: boolean,
  sidebarWidth: number,
  buttonWidth = PREVIEW_TOGGLE_DEFAULT_WIDTH,
): number {
  return shown ? Math.max(4, sidebarWidth - buttonWidth - 4) : 4;
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

export function isPreviewTogglePeekPoint(
  clientX: number,
  boundary: number,
  buttonWidth = PREVIEW_TOGGLE_DEFAULT_WIDTH,
): boolean {
  return clientX >= boundary - buttonWidth - PREVIEW_TOGGLE_RIGHT_INSET
    && clientX <= boundary + PREVIEW_TOGGLE_RIGHT_INSET;
}
