export const PREVIEW_MIN_WIDTH = 260;

export interface PreviewLayoutState {
  available: boolean;
  collapsed: boolean;
  fullscreen: boolean;
}

export function isPreviewShown(state: PreviewLayoutState): boolean {
  return state.available && !state.collapsed;
}

export function isPreviewFullscreen(state: PreviewLayoutState): boolean {
  return isPreviewShown(state) && state.fullscreen;
}

export function isPreviewSplitterShown(state: PreviewLayoutState): boolean {
  return isPreviewShown(state) && !state.fullscreen;
}

export function shouldKeepPreviewFullscreen(
  ownerTabId: string | null,
  activeTabId: string | null,
  hasPreviewFormat: boolean,
): boolean {
  return hasPreviewFormat && ownerTabId !== null && ownerTabId === activeTabId;
}

export function previewWidthFromPointer(mainRight: number, clientX: number, mainLeft = 0): number {
  const maxWidth = Math.max(PREVIEW_MIN_WIDTH, mainRight - mainLeft);
  return Math.min(maxWidth, Math.max(PREVIEW_MIN_WIDTH, mainRight - clientX));
}
